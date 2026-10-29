//! The consensus engine behind the API, in either of its two shapes.
//!
//! * **Memory** — the classic [`Indexer`] whose state lives in RAM. Tests,
//!   operator-only runs, and the default durable mode (engine + mirror)
//!   use it.
//! * **Store** — [`Indexer<StoreState>`]: the consensus state *is* the
//!   store, with only the block being applied buffered in memory. Ingest
//!   commits each block's batch and undo row in one transaction, so the
//!   process never holds a second full copy of the state.
//!
//! Both shapes answer the same questions; owned values are returned where
//! the store cannot hand out a borrow.

use hopper_indexer::state_machine::{BlockHeader, Indexer, IndexerConfig, IndexerError};
#[cfg(feature = "redb")]
use hopper_indexer::store::StateView;
use hopper_indexer::store::{BlockEffects, BlockWrite, StoreError};
use hopper_indexer::types::{Block, BlockReport, ChainEvent, FroggerRecord, OutPoint};

use hopper_core::satmath::SatRange;

use crate::ApiError;

/// A crossing in flight under v3 (`FroggerRecord::in_flight`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InFlightEntry {
    pub sat: u64,
    pub txid: [u8; 32],
    pub height: u32,
    pub target_hops: u32,
    pub seed: u32,
    pub name: String,
    pub dist: u32,
}

/// One engine, in whichever shape the deployment chose.
pub enum Engine {
    /// In-memory consensus state (the oracle shape).
    Memory(Box<Indexer>),
    /// Store-backed consensus state with a block-sized overlay.
    #[cfg(feature = "redb")]
    Store(Box<Indexer<hopper_indexer::store_state::StoreState>>),
}

impl Engine {
    /// Wrap an in-memory indexer.
    pub fn memory(indexer: Indexer) -> Self {
        Engine::Memory(Box::new(indexer))
    }

    /// Open the store-backed engine over `store` (fresh or existing).
    #[cfg(feature = "redb")]
    pub fn store(
        store: std::sync::Arc<hopper_indexer::store::redb_store::RedbStore>,
        config: IndexerConfig,
        seeds: Vec<(OutPoint, Vec<SatRange>)>,
    ) -> Result<Self, StoreError> {
        let state = hopper_indexer::store_state::StoreState::new(config, store)?;
        let fresh = hopper_indexer::consensus::ConsensusState::tip(&state)
            .0
            .is_none();
        let mut indexer = Indexer::from_loaded_state(state, Vec::new());
        if fresh {
            // Bootstrap seeds are operator ground truth and are applied
            // once, when the store has no tip (a reopen already has them).
            for (outpoint, ranges) in seeds {
                indexer.seed_utxo(outpoint, ranges);
            }
            indexer
                .state_mut()
                .flush_seeds()
                .map_err(|e| StoreError::Backend(e.to_string()))?;
        }
        Ok(Engine::Store(Box::new(indexer)))
    }

    /// True for the store-backed shape.
    pub fn is_store(&self) -> bool {
        #[cfg(feature = "redb")]
        if matches!(self, Engine::Store(_)) {
            return true;
        }
        false
    }

    /// The store handle, when store-backed.
    #[cfg(feature = "redb")]
    pub fn store_handle(
        &self,
    ) -> Option<std::sync::Arc<hopper_indexer::store::redb_store::RedbStore>> {
        match self {
            Engine::Memory(_) => None,
            Engine::Store(engine) => Some(engine.state().store_handle()),
        }
    }

    /// The in-memory state image (memory shape only): snapshots and the
    /// mirror bootstrap need it.
    pub fn state(&self) -> Option<&hopper_indexer::state_machine::IndexState> {
        match self {
            Engine::Memory(indexer) => Some(indexer.state()),
            #[cfg(feature = "redb")]
            Engine::Store(_) => None,
        }
    }

    /// The canonical state digest.
    pub fn state_root(&self) -> [u8; 32] {
        match self {
            Engine::Memory(indexer) => indexer.state_root(),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.state_root(),
        }
    }

    /// Tip height.
    pub fn tip_height(&self) -> Option<u32> {
        match self {
            Engine::Memory(indexer) => indexer.tip_height(),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.tip_height(),
        }
    }

    /// Tip hash.
    pub fn tip_hash(&self) -> Option<[u8; 32]> {
        match self {
            Engine::Memory(indexer) => indexer.tip_hash(),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.tip_hash(),
        }
    }

    /// No blocks applied yet.
    pub fn is_empty(&self) -> bool {
        match self {
            Engine::Memory(indexer) => indexer.is_empty(),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.is_empty(),
        }
    }

    /// The retained block window.
    pub fn chain(&self) -> &[BlockHeader] {
        match self {
            Engine::Memory(indexer) => indexer.chain(),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.chain(),
        }
    }

    /// Oldest retained height.
    pub fn retained_from(&self) -> Option<u32> {
        match self {
            Engine::Memory(indexer) => indexer.retained_from(),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.retained_from(),
        }
    }

    /// Retained `(height, hash)` pairs, oldest first.
    pub fn retained_heights(&self) -> Vec<(u32, [u8; 32])> {
        match self {
            Engine::Memory(indexer) => indexer.retained_heights(),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.retained_heights(),
        }
    }

    /// Re-register the retained window after a restart.
    pub fn register_heights(&mut self, heights: impl IntoIterator<Item = (u32, [u8; 32])>) {
        match self {
            Engine::Memory(indexer) => indexer.register_heights(heights),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.register_heights(heights),
        }
    }

    /// Height of a retained block by hash.
    pub fn block_height(&self, hash: &[u8; 32]) -> Option<u32> {
        match self {
            Engine::Memory(indexer) => indexer.block_height(hash),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.block_height(hash),
        }
    }

    /// The event tail.
    pub fn event_log(&self) -> &[ChainEvent] {
        match self {
            Engine::Memory(indexer) => indexer.event_log(),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.event_log(),
        }
    }

    /// Bound the in-memory event tail.
    pub fn trim_events(&mut self, max: usize) {
        match self {
            Engine::Memory(indexer) => indexer.trim_events(max),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.trim_events(max),
        }
    }

    /// The version schedule.
    pub fn config(&self) -> &IndexerConfig {
        match self {
            Engine::Memory(indexer) => indexer.config(),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.config(),
        }
    }

    /// Bootstrap seeds (snapshot persistence).
    pub fn seeds(&self) -> &[(OutPoint, Vec<SatRange>)] {
        match self {
            Engine::Memory(indexer) => indexer.seeds(),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.seeds(),
        }
    }

    /// Number of tracked frogs.
    pub fn frog_count(&self) -> usize {
        match self {
            Engine::Memory(indexer) => indexer.frogger_count(),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.frogger_count(),
        }
    }

    /// Number of tracked coins.
    pub fn utxo_count(&self) -> usize {
        match self {
            Engine::Memory(indexer) => indexer.utxo_count(),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.utxo_count(),
        }
    }

    /// A frog record (owned: the store cannot lend one).
    pub fn frogger(&self, sat: u64) -> Option<FroggerRecord> {
        match self {
            Engine::Memory(indexer) => indexer.frogger(sat).cloned(),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => {
                hopper_indexer::consensus::ConsensusState::frog(indexer.state(), sat)
            }
        }
    }

    /// The UTXO holding `sat`'s anchor sat.
    pub fn location(&self, sat: u64) -> Option<OutPoint> {
        match self {
            Engine::Memory(indexer) => indexer.location(sat),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => {
                hopper_indexer::consensus::ConsensusState::frog(indexer.state(), sat)
                    .and_then(|f| f.location.outpoint())
            }
        }
    }

    /// A coin's value and ordinal ranges.
    pub fn utxo_ranges(&self, txid: [u8; 32], vout: u32) -> Option<(u64, Vec<SatRange>)> {
        match self {
            Engine::Memory(indexer) => indexer.utxo_ranges(txid, vout),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => hopper_indexer::consensus::ConsensusState::coin(
                indexer.state(),
                &OutPoint { txid, vout },
            )
            .map(|entry| (entry.value, entry.ranges)),
        }
    }

    /// Frog sats inside a coin (v3 adoption hint, `/v1/utxo`).
    pub fn utxo_frogs(&self, txid: [u8; 32], vout: u32) -> Vec<u64> {
        match self {
            Engine::Memory(indexer) => indexer.utxo_frogs(txid, vout).unwrap_or_default(),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => hopper_indexer::consensus::ConsensusState::coin(
                indexer.state(),
                &OutPoint { txid, vout },
            )
            .map(|entry| entry.frogs.to_vec())
            .unwrap_or_default(),
        }
    }

    /// One page of frogs, ascending sat, skipping `offset` rows.
    pub fn froggers_page(
        &self,
        after: Option<u64>,
        offset: usize,
        limit: usize,
    ) -> Vec<(u64, FroggerRecord)> {
        match self {
            Engine::Memory(indexer) => {
                let map = indexer.froggers();
                let iter: Box<dyn Iterator<Item = (&u64, &FroggerRecord)>> = match after {
                    Some(after) => Box::new(
                        map.range((std::ops::Bound::Excluded(after), std::ops::Bound::Unbounded)),
                    ),
                    None => Box::new(map.iter()),
                };
                iter.skip(offset)
                    .take(limit)
                    .map(|(sat, record)| (*sat, record.clone()))
                    .collect()
            }
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => {
                let mut out = Vec::new();
                let mut cursor = after;
                let mut skip = offset;
                while out.len() < limit {
                    let page = StateView::frogs_after(
                        indexer.state(),
                        cursor,
                        limit.saturating_sub(out.len()) + skip + 1,
                    )
                    .unwrap_or_default();
                    if page.is_empty() {
                        break;
                    }
                    cursor = Some(page[page.len() - 1].0);
                    for (sat, record) in page {
                        if skip > 0 {
                            skip -= 1;
                            continue;
                        }
                        out.push((sat, record));
                        if out.len() == limit {
                            break;
                        }
                    }
                }
                out
            }
        }
    }

    /// Active crossings, ascending by frogger sat (road display).
    ///
    /// Under v3 a crossing is `FroggerRecord::in_flight`, not a v2
    /// `Crossing`: this walks the frogs instead.
    pub fn in_flight(&self) -> Vec<InFlightEntry> {
        let mut out = Vec::new();
        let mut push = |record: &FroggerRecord| {
            if let Some(in_flight) = record.in_flight {
                out.push(InFlightEntry {
                    sat: record.sat,
                    txid: in_flight.txid,
                    height: in_flight.height,
                    target_hops: in_flight.target_hops,
                    seed: record.seed,
                    name: record.name.clone(),
                    dist: record.dist,
                });
            }
        };
        match self {
            Engine::Memory(indexer) => {
                for record in indexer.froggers().values() {
                    push(record);
                }
            }
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => {
                let _ = hopper_indexer::consensus::ConsensusState::for_each_frog(
                    indexer.state(),
                    &mut |record| push(record),
                );
            }
        }
        out
    }

    /// Every frog, ascending sat, in pages (leaderboard rebuilds).
    pub fn all_froggers(&self) -> Vec<(u64, FroggerRecord)> {
        match self {
            Engine::Memory(indexer) => indexer
                .froggers()
                .iter()
                .map(|(sat, record)| (*sat, record.clone()))
                .collect(),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => {
                let mut out = Vec::new();
                let mut cursor = None;
                loop {
                    let page =
                        StateView::frogs_after(indexer.state(), cursor, 8192).unwrap_or_default();
                    if page.is_empty() {
                        break;
                    }
                    cursor = Some(page[page.len() - 1].0);
                    out.extend(page);
                }
                out
            }
        }
    }

    /// Apply a block with its undo journal retained in memory.
    pub fn apply_block(&mut self, block: Block) -> Result<BlockReport, IndexerError> {
        match self {
            Engine::Memory(indexer) => indexer.apply_block(block),
            #[cfg(feature = "redb")]
            Engine::Store(_) => {
                let (report, effects, write) = self.apply_block_recorded(block)?;
                self.commit(effects, write)?;
                Ok(report)
            }
        }
    }

    /// Apply a block and return its journal and forward batch. For the
    /// store shape the block is **not** yet visible to readers: call
    /// [`Engine::commit`] to publish it atomically.
    pub fn apply_block_recorded(
        &mut self,
        block: Block,
    ) -> Result<(BlockReport, BlockEffects, BlockWrite), IndexerError> {
        match self {
            Engine::Memory(indexer) => indexer.apply_block_recorded(block),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.apply_block_recorded(block),
        }
    }

    /// Commit a recorded block (store shape: one transaction; memory
    /// shape: already applied).
    pub fn commit(&mut self, effects: BlockEffects, write: BlockWrite) -> Result<(), IndexerError> {
        match self {
            Engine::Memory(_) => {
                let _ = (effects, write);
                Ok(())
            }
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer
                .state_mut()
                .commit(&write, &effects)
                .map_err(|e| IndexerError::Storage(e.to_string())),
        }
    }

    /// Roll back `n` blocks (memory shape needs in-memory journals; the
    /// store shape undoes through the store's journals).
    pub fn rollback(&mut self, n: usize) -> Result<(), IndexerError> {
        match self {
            Engine::Memory(indexer) => indexer.rollback(n),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => {
                let tip = indexer.tip_height().ok_or(IndexerError::RollbackTooDeep {
                    requested: n,
                    available: 0,
                })?;
                let n32 = u32::try_from(n).map_err(|_| IndexerError::HeightOverflow)?;
                if n == 0 {
                    return Ok(());
                }
                let from = tip
                    .checked_sub(n32 - 1)
                    .ok_or(IndexerError::RollbackTooDeep {
                        requested: n,
                        available: usize::try_from(tip).unwrap_or(0) + 1,
                    })?;
                let mut journals = Vec::with_capacity(n);
                for height in from..=tip {
                    let effects = indexer
                        .state()
                        .store()
                        .undo(height)
                        .map_err(|e| IndexerError::Storage(e.to_string()))?
                        .ok_or(IndexerError::RollbackWithoutJournal { height })?;
                    journals.push(effects);
                }
                for effects in journals.iter().rev() {
                    indexer
                        .undo_top(effects)
                        .map_err(|e| IndexerError::Storage(e.to_string()))?;
                }
                Ok(())
            }
        }
    }

    /// Undo the top block from a persisted journal.
    pub fn undo_top(&mut self, effects: &BlockEffects) -> Result<(), StoreError> {
        match self {
            Engine::Memory(indexer) => indexer.undo_top(effects),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.undo_top(effects),
        }
    }

    /// Drop the oldest retained blocks.
    pub fn trim_chain(&mut self, max: usize) -> Result<usize, IndexerError> {
        match self {
            Engine::Memory(indexer) => indexer.trim_chain(max),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => indexer.trim_chain(max),
        }
    }

    /// Bootstrap a UTXO.
    pub fn seed_utxo(&mut self, outpoint: OutPoint, ranges: Vec<SatRange>) {
        match self {
            Engine::Memory(indexer) => indexer.seed_utxo(outpoint, ranges),
            #[cfg(feature = "redb")]
            Engine::Store(indexer) => {
                indexer.seed_utxo(outpoint, ranges);
                // Persist immediately: seeds are operator ground truth and
                // must survive a restart even before the next block.
                if let Err(e) = indexer.state_mut().flush_seeds() {
                    eprintln!("[seed] flush failed: {e}");
                }
            }
        }
    }

    /// The store's undo range, when store-backed.
    #[cfg(feature = "redb")]
    pub fn undo_range(&self) -> Option<Result<Option<(u32, u32)>, StoreError>> {
        match self {
            Engine::Memory(_) => None,
            Engine::Store(indexer) => Some(indexer.state().store().undo_range()),
        }
    }

    /// Prune undo journals below `height` (store shape only).
    #[cfg(feature = "redb")]
    pub fn trim_undo_below(&mut self, height: u32) -> Result<usize, StoreError> {
        match self {
            Engine::Memory(_) => Ok(0),
            Engine::Store(indexer) => indexer.state().store().trim_undo_below(height),
        }
    }

    /// A degenerate conversion used by handlers that still expect the
    /// borrowing shape. Store-backed engines have no such image.
    pub fn as_memory(&self) -> Option<&Indexer> {
        match self {
            Engine::Memory(indexer) => Some(indexer),
            #[cfg(feature = "redb")]
            Engine::Store(_) => None,
        }
    }
}

/// Map an engine error to the API's error type (500).
pub fn engine_error(e: impl std::fmt::Display) -> ApiError {
    ApiError::Internal(e.to_string())
}
