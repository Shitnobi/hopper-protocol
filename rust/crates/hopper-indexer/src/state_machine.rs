//! The FROGGER v2.0 crossing-lifecycle state machine (SPEC §5, §6, §7, §8).
//!
//! The indexer's entire protocol state is a **pure function of the event
//! history**: `Indexer = (config, seeds, chain)` → derived [`IndexState`]
//! plus a flattened [`ChainEvent`] log (SPEC §1 principle 5, §8.1.4). No
//! I/O, no wall clock, no randomness — the same chain always yields the
//! same state, which is what makes reorg rollback-by-replay correct
//! (SPEC §11).
//!
//! ## Per-block processing (SPEC §8.1)
//!
//! 1. For each tx **in block order**: apply sat flow and movement
//!    semantics (§6), then parse/validate the (single) FRG envelope
//!    against the §8.1.2 validity table.
//! 2. After the block: flip phase 0→1, record anchor blocks, expire car
//!    windows (unopposed crossings) and reveal windows (settlement /
//!    substitution / VOID).
//!
//! ## The §8.2 MUST list — where each item is enforced
//!
//! | # | MUST | Enforced in |
//! |---|-----|-------------|
//! | 1 | Reveal window strictly `> height(B)` | [`IndexState::process_reveal`] (`RevealNotAnchored` / `RevealOutsideWindow`) |
//! | 2 | Substitution uses `(tag, h_commit, sat)` only, never `H(B)` | delegated to `hopper_core::settle_crossing` (golden-tested) |
//! | 3 | Death threshold is strict `LE32(digest[0..4]) < 2^30` | delegated to `hopper_core` |
//! | 4 | Both-stall ⇒ VOID; single stall settles | [`IndexState::settle`] via `hopper_core::settle_crossing` |
//! | 5 | >1 FRG envelope ⇒ tx ignored in full; malformed ignored | [`IndexState::process_tx`] envelope scan |
//! | 6 | DEAD/HOME absorbing; `dist ≤ HOME_DIST` | [`IndexState::settle`] / [`IndexState::finish_unopposed`] clamp; CROSS requires IDLE |
//! | 7 | Envelopes below H₀ ignored | [`IndexState::process_tx`] activation gate |
//!
//! ## Movement semantics (SPEC §6)
//!
//! * Movement **before any CAR confirms** ⇒ RETREAT: crossing voids, frog
//!   IDLE, `retreat_count += 1`, no progress, no death.
//! * Movement **after the winning CAR confirms** ⇒ the gamble is sealed;
//!   ownership transfers with the sat *including the pending outcome*.
//! * Same-block edge: txs are processed in block order — a CAR preceding
//!   the movement seals the crossing; a movement preceding the CAR is a
//!   retreat and the CAR then targets nothing.

use std::collections::BTreeMap;
use std::fmt;

use hopper_core::satmath::SatRange;

use crate::sat_track::SatTracker;
use crate::types::{
    Block, BlockReport, ChainEvent, EventAction, FroggerRecord, OutPoint, Rejection,
    RejectionReason, UtxoEntry,
};

/// Settlements (and every other crossing end) are provisional until this
/// many confirmations (SPEC §2, §8.1.4). Lives here rather than in
/// `hopper-core`, which does not define it.
pub const FINALITY_DEPTH: u32 = 6;

/// Indexer configuration.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IndexerConfig {
    /// Height from which the mint's inscription is enforced (content type
    /// and body digest). `None` disables the check — a development
    /// convenience, never a deployment.
    #[serde(default)]
    pub inscription_activation_height: Option<u32>,
    /// The economic/consensus parameters (committed to by `params_hash`).
    #[serde(default = "default_params")]
    pub params: hopper_core::params::ProtocolParams,
}

fn default_params() -> hopper_core::params::ProtocolParams {
    hopper_core::params::PROTOCOL
}

impl Default for IndexerConfig {
    fn default() -> Self {
        Self {
            inscription_activation_height: None,
            params: hopper_core::params::PROTOCOL,
        }
    }
}

/// Errors returned by the indexer. None of them are caused by hostile
/// chain data (malformed envelopes are rejections, not errors); they
/// signal misuse of the indexer API or a violated internal invariant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IndexerError {
    /// Blocks must be applied in contiguous height order.
    NonContiguousHeight { expected: u32, got: u32 },
    /// The tip height cannot be incremented further.
    HeightOverflow,
    /// Rollback requested more blocks than the retained chain holds.
    RollbackTooDeep { requested: usize, available: usize },
    /// violation (should be unreachable).
    ReplayInconsistent,
    /// applied through a durable path that keeps journals in the store.
    RollbackWithoutJournal { height: u32 },
    /// The backing store failed (store-backed engine only).
    Storage(String),
}

impl fmt::Display for IndexerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IndexerError::NonContiguousHeight { expected, got } => {
                write!(
                    f,
                    "non-contiguous block: expected height {expected}, got {got}"
                )
            }
            IndexerError::HeightOverflow => write!(f, "block height overflow"),
            IndexerError::RollbackTooDeep {
                requested,
                available,
            } => {
                write!(
                    f,
                    "rollback of {requested} blocks exceeds retained chain depth {available}"
                )
            }
            IndexerError::ReplayInconsistent => {
                write!(f, "internal error: retained chain failed replay")
            }
            IndexerError::Storage(message) => write!(f, "store: {message}"),
            IndexerError::RollbackWithoutJournal { height } => write!(
                f,
                "cannot roll back block {height}: no in-memory undo journal \
                 (durable ingest keeps journals in the store)"
            ),
        }
    }
}

impl std::error::Error for IndexerError {}

/// CAR valid at heights `T+1 … T+6` (SPEC §5 phase 1, §8.1.2).
/// REVEAL valid at heights `B+1 … B+6` — strictly after the anchor block
/// (SPEC §5 phase 3, §8.2.1).
/// Per-block event/rejection accumulator, threaded through tx processing.
pub(crate) struct BlockSink {
    pub(crate) height: u32,
    pub(crate) hash: [u8; 32],
    pub(crate) events: Vec<ChainEvent>,
    pub(crate) rejections: Vec<Rejection>,
}

impl BlockSink {
    pub(crate) fn event(&mut self, txid: Option<[u8; 32]>, action: EventAction) {
        self.events.push(ChainEvent {
            block_hash: self.hash,
            height: self.height,
            txid,
            action,
        });
    }

    pub(crate) fn reject(&mut self, txid: [u8; 32], reason: RejectionReason) {
        self.rejections.push(Rejection {
            txid,
            sat: None,
            reason,
        });
    }

    /// A rejection that names the frog it concerns (V3 §8.7).
    pub(crate) fn reject_for(&mut self, txid: [u8; 32], sat: u64, reason: RejectionReason) {
        self.rejections.push(Rejection {
            txid,
            sat: Some(sat),
            reason,
        });
    }
}

/// Events, rejections, undo journal, and forward batch for one block.
type RecordedBlock = (
    Vec<ChainEvent>,
    Vec<Rejection>,
    crate::store::BlockEffects,
    crate::store::BlockWrite,
);

/// The derived protocol state: froggers and the sat tracker. Constructed
/// only by replaying blocks (see [`Indexer`]).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IndexState {
    config: IndexerConfig,
    frogs: BTreeMap<u64, FroggerRecord>,
    tracker: SatTracker,
    tip_height: Option<u32>,
    /// still answer `tip_hash` and recognise its own tip from a source.
    tip_hash: Option<[u8; 32]>,
    #[serde(skip)]
    journal: Option<crate::store::BlockEffects>,
}

impl IndexState {
    /// An empty state with the given configuration.
    pub fn new(config: IndexerConfig) -> Self {
        Self {
            config,
            ..Default::default()
        }
    }

    /// Bootstrap a UTXO (chain-layer seeding / test fixtures).
    pub fn seed_utxo(&mut self, outpoint: OutPoint, ranges: Vec<SatRange>) {
        self.tracker.seed_utxo(outpoint, ranges);
    }

    /// Current tip height, or `None` before the first block.
    pub fn tip_height(&self) -> Option<u32> {
        self.tip_height
    }

    /// Hash of the tip block, or `None` before the first block.
    pub fn tip_hash(&self) -> Option<[u8; 32]> {
        self.tip_hash
    }

    /// Canonical state digest (cross-indexer verification).
    pub fn state_root(&self) -> [u8; 32] {
        crate::store::state_root(self).expect("in-memory state view cannot fail")
    }

    /// The frog record at `sat`, if tracked.
    pub fn frog(&self, sat: u64) -> Option<&FroggerRecord> {
        self.frogs.get(&sat)
    }

    /// The coin set (read-only).
    pub fn tracker(&self) -> &SatTracker {
        &self.tracker
    }

    /// Mutable frog map (crate-internal: store implementations).
    pub(crate) fn frogs_mut(&mut self) -> &mut BTreeMap<u64, FroggerRecord> {
        &mut self.frogs
    }

    /// Mutable coin set (crate-internal: store implementations).
    pub(crate) fn tracker_mut(&mut self) -> &mut SatTracker {
        &mut self.tracker
    }

    /// Set the tip fields (crate-internal).
    pub(crate) fn set_tip(&mut self, height: Option<u32>, hash: Option<[u8; 32]>) {
        self.tip_height = height;
        self.tip_hash = hash;
    }

    pub fn frogs(&self) -> &BTreeMap<u64, FroggerRecord> {
        &self.frogs
    }

    /// One frogger record.
    pub fn frogger(&self, sat: u64) -> Option<&FroggerRecord> {
        self.frogs.get(&sat)
    }

    fn journal_frog(&mut self, sat: u64) {
        if self.journal.is_none() {
            return;
        }
        let before = self.frogs.get(&sat).cloned();
        if let Some(journal) = &mut self.journal {
            journal.record_frog(sat, before.as_ref());
        }
    }

    fn record_coin_before(&mut self, outpoint: OutPoint) {
        if self.journal.is_none() {
            return;
        }
        let before = self.tracker.utxo(&outpoint).cloned();
        if let Some(journal) = &mut self.journal {
            journal.record_coin(outpoint, before.as_ref());
        }
    }

    /// The UTXO currently holding `sat`'s anchor sat (None if burned).
    pub fn location(&self, sat: u64) -> Option<OutPoint> {
        self.frogs
            .get(&sat)
            .and_then(|frog| frog.location.outpoint())
    }

    /// Frogger sats held by a tracked UTXO (the reverse coin index).
    pub fn frogs_at(&self, outpoint: &OutPoint) -> &[u64] {
        self.tracker.frogs_at(outpoint)
    }

    /// A tracked UTXO's value and ordinal sat ranges (wallet discovery).
    pub fn utxo_ranges(&self, txid: [u8; 32], vout: u32) -> Option<(u64, Vec<SatRange>)> {
        let entry = self.tracker.utxo(&OutPoint { txid, vout })?;
        Some((entry.value, entry.ranges.clone()))
    }

    /// Frog sats sitting in one coin (v3 adoption hint).
    pub fn utxo_frogs(&self, txid: [u8; 32], vout: u32) -> Option<Vec<u64>> {
        let entry = self.tracker.utxo(&OutPoint { txid, vout })?;
        Some(entry.frogs.to_vec())
    }

    /// contiguous height order (the first block may be at any height).
    pub fn apply_block(
        &mut self,
        block: &Block,
    ) -> Result<(Vec<ChainEvent>, Vec<Rejection>), IndexerError> {
        crate::consensus::apply_block_body(self, block, false)
            .map(|(events, rejections, _)| (events, rejections))
    }

    ///
    /// by the block is captured as a first-touch before-image.
    pub fn apply_block_journaled(
        &mut self,
        block: &Block,
    ) -> Result<(Vec<ChainEvent>, Vec<Rejection>, crate::store::BlockEffects), IndexerError> {
        let (events, rejections, effects) = crate::consensus::apply_block_body(self, block, true)?;
        Ok((
            events,
            rejections,
            effects.expect("journaled application always yields effects"),
        ))
    }

    /// Apply a block and return both its undo journal and its forward batch.
    pub fn apply_block_recorded(&mut self, block: &Block) -> Result<RecordedBlock, IndexerError> {
        let (events, rejections, effects) = self.apply_block_journaled(block)?;
        let write = self.block_write(&effects);
        Ok((events, rejections, effects, write))
    }

    fn block_write(&self, effects: &crate::store::BlockEffects) -> crate::store::BlockWrite {
        crate::consensus::block_write(self, effects)
    }

    /// The enforced version schedule (part of the state image).
    pub fn config(&self) -> &IndexerConfig {
        &self.config
    }

    #[cfg(feature = "redb")]
    pub(crate) fn with_config(config: IndexerConfig) -> Self {
        Self {
            config,
            ..Self::default()
        }
    }

    pub fn undo_block(
        &mut self,
        effects: &crate::store::BlockEffects,
    ) -> Result<(), crate::store::StoreError> {
        crate::store::undo_block(self, effects)
    }
}

impl crate::sat_track::CoinView for IndexState {
    fn with_coin(&self, outpoint: &OutPoint, f: &mut dyn FnMut(Option<&UtxoEntry>)) {
        crate::sat_track::CoinView::with_coin(&self.tracker, outpoint, f)
    }

    fn update_coin(&mut self, outpoint: OutPoint, f: &mut dyn FnMut(&mut Option<UtxoEntry>)) {
        crate::sat_track::CoinView::update_coin(&mut self.tracker, outpoint, f)
    }

    fn register_frog(&mut self, sat: u64, outpoint: OutPoint) {
        self.tracker.register_frog(sat, outpoint);
    }

    fn frogs_at(&self, outpoint: &OutPoint) -> Vec<u64> {
        self.tracker.frogs_at(outpoint).to_vec()
    }

    fn coin_count(&self) -> usize {
        self.tracker.coin_count()
    }
}

impl crate::consensus::ConsensusState for IndexState {
    fn config(&self) -> &IndexerConfig {
        &self.config
    }

    fn tip(&self) -> (Option<u32>, Option<[u8; 32]>) {
        (self.tip_height, self.tip_hash)
    }

    fn set_tip(&mut self, height: Option<u32>, hash: Option<[u8; 32]>) {
        self.tip_height = height;
        self.tip_hash = hash;
    }

    fn frog(&self, sat: u64) -> Option<FroggerRecord> {
        self.frogs.get(&sat).cloned()
    }

    fn for_each_frog(
        &self,
        f: &mut dyn FnMut(&FroggerRecord),
    ) -> Result<(), crate::store::StoreError> {
        for record in self.frogs.values() {
            f(record);
        }
        Ok(())
    }

    fn with_frog(&mut self, sat: u64, f: &mut dyn FnMut(&mut Option<FroggerRecord>)) {
        // Move the record out and back: the closure sees a slot, and a
        // removal needs no clone (`audit: no allocation per touch`).
        let mut slot = self.frogs.remove(&sat);
        f(&mut slot);
        if let Some(record) = slot {
            self.frogs.insert(sat, record);
        }
    }

    fn seed_utxo(&mut self, outpoint: OutPoint, ranges: Vec<SatRange>) {
        self.tracker.seed_utxo(outpoint, ranges);
    }

    fn frog_count(&self) -> usize {
        self.frogs.len()
    }

    fn journal_begin(&mut self, height: u32) {
        let mut effects = crate::store::BlockEffects::new(height);
        effects.before_tip = (self.tip_height, self.tip_hash);
        self.journal = Some(effects);
    }

    fn journal_take(&mut self) -> Option<crate::store::BlockEffects> {
        self.journal.take()
    }

    fn journal_frog(&mut self, sat: u64) {
        IndexState::journal_frog(self, sat);
    }

    fn journal_coin(&mut self, outpoint: OutPoint) {
        self.record_coin_before(outpoint);
    }

    fn undo(
        &mut self,
        effects: &crate::store::BlockEffects,
    ) -> Result<(), crate::store::StoreError> {
        self.undo_block(effects)
    }
}

/// A complete, replay-free capture of an indexer's tip: configuration,
/// bootstrap seeds, derived state and the event log emitted so far.
///
/// This is the payload of snapshot v3 and the shape the Phase 2 store
/// must be able to reproduce. It deliberately contains **no blocks**:
/// restoring is O(1) in chain length, and retention is supplied
/// separately by the block source.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IndexerState {
    pub config: IndexerConfig,
    pub seeds: Vec<(OutPoint, Vec<SatRange>)>,
    pub state: IndexState,
    pub events: Vec<ChainEvent>,
}

/// The chain-driven indexer: derived state + a bounded block history +
/// the flattened event log. This is the public entry point of the pure
/// core.
///
/// State is a pure function of `(config, seeds, chain)` (SPEC §8.1.4).
/// A rollback re-derives by replaying from the base state (the state
/// just before the first retained block) — exact for reorgs within the
/// retained window. Deeper reorgs require restoring an older state
/// checkpoint from the persistence layer (SPEC §11).
/// Identity of a retained block.
///
/// The body is deliberately **not** retained: rollback is journal-driven,
/// so only the height and hash are needed (the retained window, fork
/// detection, and the reorg walk). Holding full blocks here used to cost
/// `retained_blocks x txs x tx_size` — hundreds of MiB at full density.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BlockHeader {
    pub height: u32,
    pub hash: [u8; 32],
}

pub struct Indexer<S = IndexState> {
    config: IndexerConfig,
    seeds: Vec<(OutPoint, Vec<SatRange>)>,
    state: S,
    /// [`Indexer::trim_chain`]; may be empty after a state restore.
    chain: Vec<BlockHeader>,
    /// [`Indexer::rollback`] refuses those blocks.
    journals: Vec<Option<crate::store::BlockEffects>>,
    /// scans the chain backwards to resolve a fork height.
    block_heights: BTreeMap<[u8; 32], u32>,
    event_log: Vec<ChainEvent>,
}

impl Indexer<IndexState> {
    /// A new indexer with the given configuration.
    pub fn new(config: IndexerConfig) -> Self {
        let state = IndexState::new(config.clone());
        Self {
            config,
            seeds: Vec::new(),
            state,
            chain: Vec::new(),
            journals: Vec::new(),
            block_heights: BTreeMap::new(),
            event_log: Vec::new(),
        }
    }

    /// Capture the tip state and event log without blocks (snapshot v3).
    pub fn to_state(&self) -> IndexerState {
        IndexerState {
            config: self.config.clone(),
            seeds: self.seeds.clone(),
            state: self.state.clone(),
            events: self.event_log.clone(),
        }
    }

    /// Consume the indexer into its replay-free state.
    pub fn into_state(self) -> IndexerState {
        IndexerState {
            config: self.config,
            seeds: self.seeds,
            state: self.state,
            events: self.event_log,
        }
    }

    ///
    /// older checkpoint (the retained window is empty here by design).
    pub fn from_state(state: IndexerState) -> Self {
        let mut block_heights = BTreeMap::new();
        if let (Some(height), Some(hash)) = (state.state.tip_height(), state.state.tip_hash()) {
            block_heights.insert(hash, height);
        }
        Self {
            config: state.config,
            seeds: state.seeds,
            state: state.state,
            chain: Vec::new(),
            journals: Vec::new(),
            block_heights,
            event_log: state.events,
        }
    }

    /// All frogger records, keyed by anchor sat.
    pub fn froggers(&self) -> &BTreeMap<u64, FroggerRecord> {
        self.state.frogs()
    }

    /// One frogger record.
    pub fn frogger(&self, sat: u64) -> Option<&FroggerRecord> {
        self.state.frogger(sat)
    }

    /// The UTXO currently holding `sat`'s anchor sat (None if burned).
    pub fn location(&self, sat: u64) -> Option<OutPoint> {
        self.state.location(sat)
    }

    /// Frogger sats held by a tracked UTXO (the reverse coin index).
    pub fn frogs_at(&self, outpoint: &OutPoint) -> &[u64] {
        self.state.frogs_at(outpoint)
    }

    /// data (SPEC §9.3: the wallet verifies everything else itself).
    pub fn utxo_ranges(&self, txid: [u8; 32], vout: u32) -> Option<(u64, Vec<SatRange>)> {
        self.state.utxo_ranges(txid, vout)
    }

    /// Frog sats held by a tracked UTXO (v3 adoption hint).
    pub fn utxo_frogs(&self, txid: [u8; 32], vout: u32) -> Option<Vec<u64>> {
        self.state.utxo_frogs(txid, vout)
    }
}

impl<S: crate::consensus::ConsensusState> Indexer<S> {
    ///
    /// which undo through persisted `BlockEffects` instead of replay.
    pub fn from_loaded_state(state: S, seeds: Vec<(OutPoint, Vec<SatRange>)>) -> Self {
        let config = state.config().clone();
        let (height, hash) = state.tip();
        let mut block_heights = BTreeMap::new();
        if let (Some(height), Some(hash)) = (height, hash) {
            block_heights.insert(hash, height);
        }
        Self {
            config,
            seeds,
            state,
            chain: Vec::new(),
            journals: Vec::new(),
            block_heights,
            event_log: Vec::new(),
        }
    }

    /// The derived state (read-only).
    pub fn state(&self) -> &S {
        &self.state
    }

    /// The derived state (mutable; a store-backed engine commits through it).
    pub fn state_mut(&mut self) -> &mut S {
        &mut self.state
    }

    /// Number of coins in the tracked set (metrics).
    pub fn utxo_count(&self) -> usize {
        self.state.coin_count()
    }

    /// Number of tracked frogs (metrics).
    pub fn frogger_count(&self) -> usize {
        self.state.frog_count()
    }

    /// The indexer configuration (the enforced version schedule).
    pub fn config(&self) -> &IndexerConfig {
        &self.config
    }

    /// trimmed and cannot be rolled back without a older checkpoint.
    pub fn chain(&self) -> &[BlockHeader] {
        &self.chain
    }

    /// retained (fresh, or restored from a state snapshot).
    pub fn retained_from(&self) -> Option<u32> {
        self.chain.first().map(|h| h.height)
    }

    /// Whether the indexer has never applied a block (seeds may exist).
    pub fn is_empty(&self) -> bool {
        self.state.tip().0.is_none()
    }

    /// Height of the tip block, if any.
    pub fn tip_height(&self) -> Option<u32> {
        self.state.tip().0
    }

    /// Hash of the tip block, if any.
    pub fn tip_hash(&self) -> Option<[u8; 32]> {
        self.state.tip().1
    }

    /// linger.
    pub fn retained_heights(&self) -> Vec<(u32, [u8; 32])> {
        self.chain.iter().map(|h| (h.height, h.hash)).collect()
    }

    /// registered: durable rollbacks undo through the store's journals.
    pub fn register_heights(&mut self, heights: impl IntoIterator<Item = (u32, [u8; 32])>) {
        let mut heights: Vec<(u32, [u8; 32])> = heights.into_iter().collect();
        heights.sort_unstable_by_key(|(height, _)| *height);
        for (height, hash) in heights {
            self.block_heights.insert(hash, height);
            if self.chain.last().is_none_or(|last| last.height < height) {
                self.chain.push(BlockHeader { height, hash });
                self.journals.push(None);
            }
        }
    }

    /// linear scan of the retained chain).
    pub fn block_height(&self, hash: &[u8; 32]) -> Option<u32> {
        self.block_heights.get(hash).copied()
    }

    /// pre-activation history, or test fixtures). Survives rollbacks.
    pub fn seed_utxo(&mut self, outpoint: OutPoint, ranges: Vec<SatRange>) {
        self.state.seed_utxo(outpoint, ranges.clone());
        self.seeds.push((outpoint, ranges));
    }

    /// The bootstrap seeds, in application order (snapshot persistence).
    pub fn seeds(&self) -> &[(OutPoint, Vec<SatRange>)] {
        &self.seeds
    }

    /// return the events and rejections it produced.
    pub fn apply_block(&mut self, block: Block) -> Result<BlockReport, IndexerError> {
        let (events, rejections, effects) =
            crate::consensus::apply_block_body(&mut self.state, &block, true)?;
        self.event_log.extend(events.iter().cloned());
        self.block_heights.insert(block.hash, block.height);
        self.chain.push(BlockHeader {
            height: block.height,
            hash: block.hash,
        });
        self.journals.push(effects);
        Ok(BlockReport { events, rejections })
    }

    /// cross it. For projection benchmarks and tests that never reorg.
    pub fn apply_block_unrecorded(&mut self, block: Block) -> Result<BlockReport, IndexerError> {
        let (events, rejections, _) =
            crate::consensus::apply_block_body(&mut self.state, &block, false)?;
        self.event_log.extend(events.iter().cloned());
        self.block_heights.insert(block.hash, block.height);
        self.chain.push(BlockHeader {
            height: block.height,
            hash: block.hash,
        });
        self.journals.push(None);
        Ok(BlockReport { events, rejections })
    }

    /// journal and forward batch so a durable backend can commit them.
    pub fn apply_block_recorded(
        &mut self,
        block: Block,
    ) -> Result<
        (
            BlockReport,
            crate::store::BlockEffects,
            crate::store::BlockWrite,
        ),
        IndexerError,
    > {
        let (events, rejections, effects) =
            crate::consensus::apply_block_body(&mut self.state, &block, true)?;
        let effects = effects.expect("journaled application always yields effects");
        let write = crate::consensus::block_write(&self.state, &effects);
        self.event_log.extend(events.iter().cloned());
        self.block_heights.insert(block.hash, block.height);
        self.chain.push(BlockHeader {
            height: block.height,
            hash: block.hash,
        });
        // The caller owns this journal (it commits it to the store), so the
        // engine does not retain a second copy of a full-density block.
        self.journals.push(None);
        Ok((BlockReport { events, rejections }, effects, write))
    }

    ///
    /// chain is empty. The journal is the store's copy of [`BlockEffects`].
    pub fn undo_top(
        &mut self,
        effects: &crate::store::BlockEffects,
    ) -> Result<(), crate::store::StoreError> {
        let removed = self.state.tip().1;
        self.state.undo(effects)?;
        if let Some(hash) = removed {
            self.block_heights.remove(&hash);
            if self.chain.last().map(|h| h.hash) == Some(hash) {
                self.chain.pop();
                self.journals.pop();
            }
        }
        match self.state.tip().0 {
            Some(tip) => {
                let keep = self.event_log.partition_point(|e| e.height <= tip);
                self.event_log.truncate(keep);
            }
            None => self.event_log.clear(),
        }
        Ok(())
    }

    ///
    /// state checkpoint.
    pub fn rollback(&mut self, n: usize) -> Result<(), IndexerError> {
        if n > self.chain.len() {
            return Err(IndexerError::RollbackTooDeep {
                requested: n,
                available: self.chain.len(),
            });
        }
        let start = self.chain.len() - n;
        if let Some(header) = self.chain[start..]
            .iter()
            .zip(self.journals[start..].iter())
            .find_map(|(header, journal)| journal.is_none().then_some(header))
        {
            return Err(IndexerError::RollbackWithoutJournal {
                height: header.height,
            });
        }
        for _ in 0..n {
            let effects = self.journals.pop().flatten().expect("journals checked");
            self.state
                .undo(&effects)
                .map_err(|_| IndexerError::ReplayInconsistent)?;
            let header = self.chain.pop().expect("chain length checked");
            self.block_heights.remove(&header.hash);
        }
        // The event log is append-only in height order, so the surviving
        // prefix is exactly the events at or below the new tip.
        match self.state.tip().0 {
            Some(tip) => {
                let keep_events = self.event_log.partition_point(|e| e.height <= tip);
                self.event_log.truncate(keep_events);
            }
            None => self.event_log.clear(),
        }
        Ok(())
    }

    /// and no replay — the surviving window keeps its own journals.
    pub fn trim_chain(&mut self, max_blocks: usize) -> Result<usize, IndexerError> {
        if self.chain.len() <= max_blocks {
            return Ok(0);
        }
        let drop_n = self.chain.len() - max_blocks;
        for header in self.chain.drain(..drop_n) {
            self.block_heights.remove(&header.hash);
        }
        let dropped = drop_n.min(self.journals.len());
        self.journals.drain(..dropped);
        Ok(drop_n)
    }

    /// The flattened, re-derivable event log (SPEC §8.1.4).
    pub fn event_log(&self) -> &[ChainEvent] {
        &self.event_log
    }

    ///
    /// is still height-ordered, so rollback truncation works.
    pub fn trim_events(&mut self, max: usize) {
        if self.event_log.len() > max {
            let drop = self.event_log.len() - max;
            self.event_log.drain(..drop);
        }
    }
}

impl<S: crate::consensus::ConsensusState + crate::store::StateView> Indexer<S> {
    /// Canonical state digest (cross-indexer verification).
    pub fn state_root(&self) -> [u8; 32] {
        crate::store::state_root(&self.state).expect("in-memory state view cannot fail")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{FroggerState, InscriptionReveal, SatLocation, Tx, TxInput, TxOut};
    use hopper_core::satmath::SatRange;
    use hopper_core::{encode_mint, envelope, Action};

    /// The test frogger's anchor sat.
    const SAT: u64 = 1_000;

    fn b32(n: u8) -> [u8; 32] {
        [n; 32]
    }

    fn op(txid: u8, vout: u32) -> OutPoint {
        OutPoint {
            txid: b32(txid),
            vout,
        }
    }

    fn input(txid: u8, vout: u32, value: u64) -> TxInput {
        TxInput {
            prevout: op(txid, vout),
            value,
            inscription: None,
        }
    }

    fn out(value: u64) -> TxOut {
        TxOut {
            value,
            op_return: None,
        }
    }

    fn out_env(payload: Vec<u8>) -> TxOut {
        TxOut {
            value: 0,
            op_return: Some(payload),
        }
    }

    fn tx_of(txid: u8, inputs: Vec<TxInput>, outputs: Vec<TxOut>) -> Tx {
        Tx {
            txid: b32(txid),
            inputs,
            outputs,
        }
    }

    fn block_of(height: u32, hash: u8, txs: Vec<Tx>) -> Block {
        Block {
            hash: b32(hash),
            height,
            txs,
        }
    }

    fn empty_block(height: u32, hash: u8) -> Block {
        block_of(height, hash, vec![])
    }

    fn mint_tx(txid: u8) -> Tx {
        let payload = envelope(Action::Mint, &encode_mint(0xABCD, "Testfrog"));
        tx_of(
            txid,
            vec![input(1, 0, 100)],
            vec![out(100), out_env(payload)],
        )
    }

    fn minted() -> Indexer {
        let mut idx = Indexer::new(IndexerConfig::default());
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
        idx.apply_block(block_of(100, 1, vec![mint_tx(2)])).unwrap();
        idx
    }

    /// A plain movement tx (no envelope) spending the anchor UTXO.
    fn move_sat(loc: OutPoint, txid: u8) -> Tx {
        tx_of(
            txid,
            vec![TxInput {
                prevout: loc,
                value: 100,
                inscription: None,
            }],
            vec![out(100)],
        )
    }

    fn move_tx(idx: &Indexer, txid: u8) -> Tx {
        move_sat(idx.location(SAT).expect("frog located"), txid)
    }

    #[test]
    fn index_state_round_trips_through_serde() {
        // The derived state must be fully serializable: state snapshots
        // (P1.3) and the store-backed core (P2) both depend on it. This
        // pins every nested type (coin ranges, frog records) against
        // silent data loss.
        let mut state = IndexState::new(IndexerConfig::default());
        state.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
        state
            .apply_block(&block_of(100, 1, vec![mint_tx(2)]))
            .unwrap();
        let moved = move_sat(state.location(SAT).expect("frog located"), 3);
        state.apply_block(&block_of(101, 10, vec![moved])).unwrap();
        // bincode, not JSON: the state is full of non-string map keys
        // (sat u64s, outpoints, block hashes).
        let bytes = bincode::serialize(&state).unwrap();
        let back: IndexState = bincode::deserialize(&bytes).unwrap();

        assert_eq!(back.tip_height(), state.tip_height());
        assert_eq!(back.frogs(), state.frogs());
        assert_eq!(back.location(SAT), state.location(SAT));
        assert_eq!(back.frogs_at(&op(3, 0)), state.frogs_at(&op(3, 0)));
        assert_eq!(
            back.utxo_ranges(b32(3), 0),
            state.utxo_ranges(b32(3), 0),
            "coin ranges survive"
        );
        // Serializing the deserialized state is byte-identical.
        assert_eq!(bincode::serialize(&back).unwrap(), bytes);
    }

    // ---- MINT -------------------------------------------------------------

    #[test]
    fn mint_creates_idle_frog_at_output_zero() {
        let idx = minted();
        let frog = idx.frogger(SAT).expect("frog exists");
        assert_eq!(frog.state, FroggerState::Idle);
        assert_eq!(frog.dist, 0);
        assert_eq!(frog.crossings_entered, 0);
        assert_eq!(frog.mint_height, 100);
        assert_eq!(frog.mint_txid, b32(2));
        assert_eq!(idx.location(SAT), Some(op(2, 0)));
        assert!(
            matches!(idx.event_log()[0].action, EventAction::Mint { frogger_sat, .. } if frogger_sat == SAT)
        );
    }
    #[test]
    fn mint_rejected_when_sat_already_has_frogger() {
        let mut idx = minted();
        // Re-mint attempt spending the frog's own UTXO into output 0.
        let payload = envelope(Action::Mint, &encode_mint(7, "Squatter"));
        let tx = tx_of(3, vec![input(2, 0, 100)], vec![out(100), out_env(payload)]);
        let report = idx.apply_block(block_of(101, 10, vec![tx])).unwrap();
        assert_eq!(report.rejections[0].reason, RejectionReason::MintSatInUse);
        assert_eq!(idx.froggers().len(), 1);
        // The spend itself is a valid ordinary transfer (SPEC §4.2).
        assert!(matches!(
            report.events[0].action,
            EventAction::Transfer { .. }
        ));
    }
    #[test]
    fn mint_rejected_when_output_zero_has_no_sats() {
        let mut idx = Indexer::new(IndexerConfig::default());
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
        // Output 0 is the OP_RETURN: no anchor sat exists (SPEC §4.1).
        let payload = envelope(Action::Mint, &encode_mint(7, "NoPad"));
        let tx = tx_of(2, vec![input(1, 0, 100)], vec![out_env(payload), out(100)]);
        let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
        assert_eq!(
            report.rejections[0].reason,
            RejectionReason::MintNoAnchorSat
        );
        assert!(idx.froggers().is_empty());
    }
    #[test]
    fn mint_rejected_when_anchor_sat_untracked() {
        let mut idx = Indexer::new(IndexerConfig::default());
        // Fully untracked funding: output 0's first sat is unknowable.
        let payload = envelope(Action::Mint, &encode_mint(7, "Ghost"));
        let tx = tx_of(2, vec![input(9, 0, 100)], vec![out(100), out_env(payload)]);
        let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
        assert_eq!(
            report.rejections[0].reason,
            RejectionReason::MintAnchorUntracked
        );
        assert!(idx.froggers().is_empty());
    }

    // ---- Change B: inscription-backed mint validation ----

    fn ins_reveal(seed: u32, reveal_index: u32) -> InscriptionReveal {
        // The v6 mint body embeds the anchor sat; these fixtures all mint
        // at SAT, so that is what the digest is computed for.
        InscriptionReveal {
            content_type: hopper_core::V6_CONTENT_TYPE.to_string(),
            body_hash: hopper_core::live_v6_html_digest(seed, SAT),
            inscription_id: format!("{}i{reveal_index}", hex_string(&b32(2))),
            body: None,
            parents: Vec::new(),
            tapscript: None,
            control_block: None,
        }
    }

    fn hex_string(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn mint_tx_inscribed(txid: u8, seed: u32, overlays: Vec<Option<InscriptionReveal>>) -> Tx {
        let payload = envelope(Action::Mint, &encode_mint(seed, "Testfrog"));
        let mut inputs = Vec::new();
        for (i, overlay) in overlays.iter().enumerate() {
            let mut inp = input(if i == 0 { 1 } else { (i + 8) as u8 }, i as u32, 100);
            inp.inscription = overlay.clone();
            inputs.push(inp);
        }
        tx_of(txid, inputs, vec![out(100), out_env(payload)])
    }

    fn enforcing_idx(activation: u32) -> Indexer {
        let mut idx = Indexer::new(IndexerConfig {
            inscription_activation_height: Some(activation),
            ..Default::default()
        });
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
        idx.seed_utxo(op(9, 1), vec![SatRange::new(SAT + 1_000, SAT + 1_100)]);
        idx
    }
    #[test]
    fn legacy_mint_accepted_with_enforcement_off() {
        // Default config: no inscription required, no id recorded.
        let mut idx = Indexer::new(IndexerConfig::default());
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
        let report = idx.apply_block(block_of(100, 1, vec![mint_tx(2)])).unwrap();
        assert!(report.rejections.is_empty());
        let record = idx.froggers().get(&SAT).unwrap();
        assert_eq!(record.inscription_id, None);
    }
    #[test]
    fn inscription_backed_mint_recorded_when_enforced() {
        let mut idx = enforcing_idx(100);
        let reveal = ins_reveal(0xABCD, 0);
        let id = reveal.inscription_id.clone();
        let tx = mint_tx_inscribed(2, 0xABCD, vec![Some(reveal)]);
        let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
        assert!(report.rejections.is_empty(), "{:?}", report.rejections);
        let record = idx.froggers().get(&SAT).unwrap();
        assert_eq!(record.inscription_id.as_deref(), Some(id.as_str()));
    }

    #[test]
    fn mint_without_inscription_rejected_after_activation() {
        let mut idx = enforcing_idx(100);
        let report = idx.apply_block(block_of(100, 1, vec![mint_tx(2)])).unwrap();
        assert_eq!(
            report.rejections[0].reason,
            RejectionReason::MintWithoutInscription
        );
        assert!(idx.froggers().is_empty());
    }
    #[test]
    fn mint_without_inscription_lenient_before_activation() {
        // Below the activation height the legacy mint still flies and
        // the absence of an inscription is not punished.
        let mut idx = enforcing_idx(200);
        let report = idx.apply_block(block_of(100, 1, vec![mint_tx(2)])).unwrap();
        assert!(report.rejections.is_empty());
        assert_eq!(idx.froggers().get(&SAT).unwrap().inscription_id, None);
    }
    #[test]
    fn inscription_present_but_lenient_still_records_id() {
        // Pre-activation with an inscription present: recorded
        // leniently (id surfaced, art NOT checked).
        let mut idx = enforcing_idx(200);
        let mut bogus = ins_reveal(0xABCD, 0);
        bogus.content_type = "text/plain".to_string();
        bogus.body_hash = [0xEE; 32];
        let id = bogus.inscription_id.clone();
        let tx = mint_tx_inscribed(2, 0xABCD, vec![Some(bogus)]);
        let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
        assert!(report.rejections.is_empty());
        let record = idx.froggers().get(&SAT).unwrap();
        assert_eq!(record.inscription_id.as_deref(), Some(id.as_str()));
    }
    #[test]
    fn multiple_inscriptions_rejected() {
        let mut idx = enforcing_idx(100);
        let tx = mint_tx_inscribed(
            2,
            0xABCD,
            vec![Some(ins_reveal(0xABCD, 0)), Some(ins_reveal(0xABCD, 1))],
        );
        let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
        assert_eq!(
            report.rejections[0].reason,
            RejectionReason::MultipleInscriptions
        );
        assert!(idx.froggers().is_empty());
    }
    #[test]
    fn inscription_on_second_input_rejected() {
        // The reveal MUST ride input 0 (the commit UTXO); an
        // inscription on input 1 does not satisfy the rule.
        let mut idx = enforcing_idx(100);
        let tx = mint_tx_inscribed(2, 0xABCD, vec![None, Some(ins_reveal(0xABCD, 0))]);
        let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
        assert_eq!(
            report.rejections[0].reason,
            RejectionReason::MintWithoutInscription
        );
        assert!(idx.froggers().is_empty());
    }
    #[test]
    fn wrong_content_type_rejected() {
        let mut idx = enforcing_idx(100);
        let mut reveal = ins_reveal(0xABCD, 0);
        reveal.content_type = "image/png".to_string();
        let tx = mint_tx_inscribed(2, 0xABCD, vec![Some(reveal)]);
        let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
        assert_eq!(
            report.rejections[0].reason,
            RejectionReason::InscriptionContentType
        );
        assert!(idx.froggers().is_empty());
    }
    #[test]
    fn art_mismatch_rejected() {
        // Seed says A, PNG is B.
        let mut idx = enforcing_idx(100);
        let tx = mint_tx_inscribed(2, 0xABCD, vec![Some(ins_reveal(0x1234, 0))]);
        let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
        assert_eq!(
            report.rejections[0].reason,
            RejectionReason::InscriptionArtMismatch
        );
        assert!(idx.froggers().is_empty());
    }
    #[test]
    fn frog_location_and_coin_frogs_stay_in_sync() {
        // P1.2: the forward index lives on the frog record and the reverse
        // index on the coin. Every movement must update both; a fee burn
        // clears the location and drops the sat from every coin.
        let mut idx = minted();
        assert_eq!(idx.location(SAT), Some(op(2, 0)), "minted in output 0");
        assert_eq!(idx.frogs_at(&op(2, 0)), &[SAT]);

        let moved = move_tx(&idx, 3);
        idx.apply_block(block_of(101, 2, vec![moved])).unwrap();
        assert_eq!(idx.location(SAT), Some(op(3, 0)));
        assert_eq!(idx.frogs_at(&op(3, 0)), &[SAT]);
        assert!(idx.frogs_at(&op(2, 0)).is_empty(), "spent coin deleted");

        // Zero-value outputs: the whole 100-sat input flows to fees.
        let burn = tx_of(4, vec![input(3, 0, 100)], vec![out(0)]);
        idx.apply_block(block_of(102, 3, vec![burn])).unwrap();
        assert_eq!(idx.location(SAT), None);
        assert_eq!(idx.frogger(SAT).unwrap().location, SatLocation::Burned);
        assert!(idx.frogs_at(&op(3, 0)).is_empty(), "spent coin deleted");
    }
    #[test]
    fn a_fee_swept_card_burns_an_idle_frog() {
        // A frog IS its anchor sat. If that sat is swept into fees while
        // the frog is idle there is no crossing, no timer and no location
        // left to observe it: unless the state follows the sat, the frog
        // stays "idle" forever — a ghost in every live-frog query.
        let mut idx = minted();
        assert_eq!(idx.frogger(SAT).unwrap().state, FroggerState::Idle);
        let before = bincode::serialize(&idx.state).unwrap();

        // 100 sat in, a 0-value output out: the card pays the fee.
        let block = block_of(101, 2, vec![tx_of(4, vec![input(2, 0, 100)], vec![out(0)])]);
        let (_events, _rejections, effects) = idx.state.apply_block_journaled(&block).unwrap();

        let record = idx.frogger(SAT).unwrap();
        assert_eq!(record.location, SatLocation::Burned);
        assert_eq!(record.state, FroggerState::Burned, "the frog is its sat");
        assert_eq!(record.burn_height, Some(101));
        assert_eq!(record.burn_txid, Some(b32(4)));
        assert!(record.state.is_terminal());
        assert!(!record.state.may_cross());
        assert_eq!(idx.location(SAT), None);

        // The burn journals like any other mutation: the reorg puts the
        // frog back on its card, crossable.
        idx.state.undo_block(&effects).unwrap();
        assert_eq!(
            bincode::serialize(&idx.state).unwrap(),
            before,
            "undo is total"
        );
        let record = idx.frogger(SAT).unwrap();
        assert_eq!(record.state, FroggerState::Idle);
        assert_eq!(record.location, SatLocation::Tracked(op(2, 0)));
        assert_eq!(record.burn_height, None);
        assert_eq!(record.burn_txid, None);
    }
    #[test]
    fn a_burn_follows_the_frog_after_a_transfer() {
        // The card moved once (still a frog), then its new holder swept
        // it to fees: the burn must attach to the transfer's outpoint,
        // not to the mint's.
        let mut idx = minted();
        idx.apply_block(block_of(101, 2, vec![move_tx(&idx, 3)]))
            .unwrap();
        assert_eq!(idx.location(SAT), Some(op(3, 0)));

        let burn = tx_of(4, vec![input(3, 0, 100)], vec![out(0)]);
        idx.apply_block(block_of(102, 3, vec![burn])).unwrap();
        let record = idx.frogger(SAT).unwrap();
        assert_eq!(record.state, FroggerState::Burned);
        assert_eq!(record.location, SatLocation::Burned);
        assert_eq!(record.burn_height, Some(102));
        assert_eq!(record.burn_txid, Some(b32(4)));
    }
    #[test]
    fn a_plain_transfer_moves_the_frog_without_burning_it() {
        // The sat survives, so the frog follows it and stays crossable:
        // ownership is the sat, and a send needs no envelope.
        let mut idx = minted();
        let moved = move_tx(&idx, 3);
        idx.apply_block(block_of(101, 2, vec![moved])).unwrap();
        let record = idx.frogger(SAT).unwrap();
        assert_eq!(record.state, FroggerState::Idle, "a transfer is not a burn");
        assert_eq!(record.location, SatLocation::Tracked(op(3, 0)));
        assert_eq!(record.burn_height, None);
        assert_eq!(record.burn_txid, None);
    }
    #[test]
    fn foreign_version_envelopes_create_nothing() {
        // This build speaks 0x06 and nothing else. An envelope wearing
        // another version byte is not "a future rule to ignore": it is a
        // malformed envelope, recorded as such, and no frog exists.
        let mut idx = Indexer::new(IndexerConfig::default());
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
        let mut push = envelope(Action::Mint, &encode_mint(7, "Futurefrog"));
        push[3] = 0x09;
        let tx = tx_of(2, vec![input(1, 0, 100)], vec![out(100), out_env(push)]);
        let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
        assert_eq!(report.rejections.len(), 1, "{:?}", report.rejections);
        assert!(matches!(
            report.rejections[0].reason,
            RejectionReason::MalformedEnvelope(hopper_core::DecodeError::UnknownVersion(0x09))
        ));
        assert!(idx.froggers().is_empty());
    }
    #[test]
    fn multiple_frg_envelopes_ignore_tx_in_full() {
        // SPEC §8.2.5.
        let mut idx = Indexer::new(IndexerConfig::default());
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
        let p1 = envelope(Action::Mint, &encode_mint(1, "A"));
        let p2 = envelope(Action::Mint, &encode_mint(2, "B"));
        let tx = tx_of(
            2,
            vec![input(1, 0, 100)],
            vec![out(100), out_env(p1), out_env(p2)],
        );
        let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
        assert_eq!(
            report.rejections[0].reason,
            RejectionReason::MultipleEnvelopes
        );
        assert!(idx.froggers().is_empty());
    }
    #[test]
    fn mint_with_foreign_op_return_annotation_is_valid() {
        // Consensus pin for wallet parity (SPEC §3): the multiplicity
        // rule counts FRG-magic pushes ONLY — an unrelated OP_RETURN
        // annotation alongside a protocol envelope does not disqualify
        // the tx. The wallet's local scan (`frogger-wallet-core::
        // chain::tx_envelope`) must mirror this predicate exactly
        // (SPEC §9.3), so its behavior is frozen here.
        let mut idx = Indexer::new(IndexerConfig::default());
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
        let payload = envelope(Action::Mint, &encode_mint(1, "A"));
        let tx = tx_of(
            2,
            vec![input(1, 0, 100)],
            vec![
                out(100),
                out_env(payload),
                out_env(b"not an FRG envelope".to_vec()),
            ],
        );
        let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
        assert!(report.rejections.is_empty());
        assert!(
            idx.frogger(SAT).is_some(),
            "decoy annotation must not disqualify"
        );
    }
    #[test]
    fn magic_fragment_counts_as_second_envelope() {
        // Consensus pin (SPEC §3): the scan predicate is
        // `len >= 3 && magic` — a bare 3-byte `FRG` push cannot decode
        // but still counts toward MultipleEnvelopes, ignoring the tx in
        // full (movement semantics still apply).
        let mut idx = Indexer::new(IndexerConfig::default());
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
        let payload = envelope(Action::Mint, &encode_mint(1, "A"));
        let tx = tx_of(
            2,
            vec![input(1, 0, 100)],
            vec![out(100), out_env(payload), out_env(b"FRG".to_vec())],
        );
        let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
        assert_eq!(
            report.rejections[0].reason,
            RejectionReason::MultipleEnvelopes
        );
        assert!(idx.froggers().is_empty());
        // No frogger exists, so no anchor location is tracked — but the
        // tx itself was processed (movement semantics apply; nothing
        // fatal, SPEC §8.2.5): a later mint on the same sat can succeed.
        let payload = envelope(Action::Mint, &encode_mint(9, "Later"));
        let tx = tx_of(3, vec![input(2, 0, 100)], vec![out(100), out_env(payload)]);
        idx.apply_block(block_of(101, 2, vec![tx])).unwrap();
        assert!(idx.frogger(SAT).is_some());
    }
    #[test]
    fn malformed_envelope_is_ignored_never_fatal() {
        // SPEC §8.2.5: malformed payloads are ignored, not
        // chain-invalidating.
        let mut idx = Indexer::new(IndexerConfig::default());
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
        // FRG magic + version + CROSS action, but a truncated payload.
        let payload: Vec<u8> = vec![b'F', b'R', b'G', 0x03, 0x02, 0x00];
        let tx = tx_of(2, vec![input(1, 0, 100)], vec![out(100), out_env(payload)]);
        let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
        assert!(matches!(
            report.rejections[0].reason,
            RejectionReason::MalformedEnvelope(_)
        ));
        assert!(idx.froggers().is_empty());
        // The indexer keeps working: a later well-formed mint succeeds.
        let payload = envelope(Action::Mint, &encode_mint(9, "Later"));
        let tx = tx_of(3, vec![input(2, 0, 100)], vec![out(100), out_env(payload)]);
        idx.apply_block(block_of(101, 2, vec![tx])).unwrap();
        assert!(idx.frogger(SAT).is_some());
    }

    // ---- CROSS ------------------------------------------------------------

    // ---- CAR window -------------------------------------------------------

    // ---- Anchor + REVEAL --------------------------------------------------

    // ---- Settlement (SPEC §5 phase 4, §7, §8.2) ---------------------------

    // ---- Unopposed crossings, HOME, absorbing states ----------------------

    // ---- Movement semantics (SPEC §6) --------------------------------------

    #[test]
    fn idle_frog_transfers_without_state_change() {
        // SPEC §4.2: IDLE frogs transfer by ordinary sat movement, no
        // envelope required.
        let mut idx = minted();
        let report = idx
            .apply_block(block_of(101, 10, vec![move_tx(&idx, 3)]))
            .unwrap();
        assert!(report.rejections.is_empty());
        assert!(matches!(
            report.events[0].action,
            EventAction::Transfer { .. }
        ));
        assert_eq!(idx.location(SAT), Some(op(3, 0)));
        assert_eq!(idx.frogger(SAT).unwrap().state, FroggerState::Idle);
    }
    // ---- Reorgs, finality, determinism (SPEC §8.1.4, §11) ------------------

    // ---- API misuse errors --------------------------------------------------

    #[test]
    fn noncontiguous_height_rejected() {
        let mut idx = minted();
        let err = idx.apply_block(empty_block(105, 1)).unwrap_err();
        assert_eq!(
            err,
            IndexerError::NonContiguousHeight {
                expected: 101,
                got: 105
            }
        );
    }
    #[test]
    fn rollback_too_deep_rejected_and_zero_is_noop() {
        let mut idx = minted();
        assert_eq!(
            idx.rollback(2).unwrap_err(),
            IndexerError::RollbackTooDeep {
                requested: 2,
                available: 1
            }
        );
        idx.rollback(0).unwrap();
        assert_eq!(idx.tip_height(), Some(100));
    }
    #[test]
    fn trim_chain_bounds_retention_and_keeps_rollback_exact() {
        let mut idx = minted(); // height 100
        for h in 101..=109 {
            idx.apply_block(empty_block(h, h as u8)).unwrap();
        }
        assert_eq!(idx.chain().len(), 10);
        assert_eq!(idx.retained_from(), Some(100));

        // Keep the last four (106..=109). The base advances to the state
        // after 105; fork-detection hashes for 100..=105 are dropped.
        assert_eq!(idx.trim_chain(4).unwrap(), 6);
        assert_eq!(idx.chain().len(), 4);
        assert_eq!(idx.retained_from(), Some(106));
        assert!(idx.block_height(&b32(100)).is_none());
        assert!(idx.block_height(&b32(105)).is_none());
        assert_eq!(idx.block_height(&b32(106)), Some(106));

        // State and history are untouched by trimming.
        assert_eq!(idx.tip_height(), Some(109));
        assert_eq!(idx.frogger(SAT).unwrap().mint_height, 100);
        let events = idx.event_log().len();

        // Rollback inside the window replays only the retained suffix.
        idx.rollback(2).unwrap();
        assert_eq!(idx.tip_height(), Some(107));
        assert_eq!(idx.frogger(SAT).unwrap().mint_height, 100);
        assert!(idx.event_log().len() <= events);

        // Rolling back past the base is refused: the persistence layer
        // must restore an older checkpoint instead.
        assert_eq!(
            idx.rollback(3).unwrap_err(),
            IndexerError::RollbackTooDeep {
                requested: 3,
                available: 2
            }
        );
    }
    #[test]
    fn rollback_undoes_journals_without_replaying_state() {
        let mut idx = minted(); // height 100
        idx.apply_block(empty_block(101, 1)).unwrap();
        let root_at_101 = idx.state_root();
        idx.apply_block(empty_block(102, 2)).unwrap();
        idx.apply_block(empty_block(103, 3)).unwrap();

        idx.rollback(2).unwrap();
        assert_eq!(idx.tip_height(), Some(101));
        assert_eq!(idx.state_root(), root_at_101);
        assert_eq!(idx.chain().len(), 2);
        assert_eq!(idx.retained_from(), Some(100));
        assert!(idx.block_height(&b32(102)).is_none());
        assert!(idx.block_height(&b32(103)).is_none());
    }
    #[test]
    fn trim_chain_keeps_the_windows_state_and_journals() {
        let mut idx = minted();
        let mut roots = vec![idx.state_root()]; // after 100
        for h in 101..=106 {
            idx.apply_block(empty_block(h, h as u8)).unwrap();
            roots.push(idx.state_root());
        }
        let before = idx.state_root();
        // Drop 100..=103: O(dropped), no state clone and no replay.
        assert_eq!(idx.trim_chain(3).unwrap(), 4);
        assert_eq!(idx.state_root(), before);
        assert_eq!(idx.retained_from(), Some(104));
        assert_eq!(idx.chain().len(), 3);

        // The surviving window still undoes exactly.
        idx.rollback(3).unwrap();
        assert_eq!(idx.tip_height(), Some(103));
        assert_eq!(idx.state_root(), roots[3]);
    }
    #[test]
    fn rollback_refuses_blocks_whose_journal_the_caller_owns() {
        let mut idx = minted();
        let _ = idx.apply_block_recorded(empty_block(101, 9)).unwrap();
        assert_eq!(
            idx.rollback(1).unwrap_err(),
            IndexerError::RollbackWithoutJournal { height: 101 }
        );
        // Fail before mutating: the block is still applied.
        assert_eq!(idx.tip_height(), Some(101));
        assert_eq!(idx.chain().len(), 2);
    }
    #[test]
    fn registered_heights_rebuild_the_window_in_height_order() {
        let mut idx =
            Indexer::from_loaded_state(IndexState::new(IndexerConfig::default()), Vec::new());
        idx.register_heights([(105, b32(105)), (103, b32(103)), (104, b32(104))]);
        assert_eq!(idx.retained_from(), Some(103));
        assert_eq!(idx.chain().len(), 3);
        assert_eq!(
            idx.retained_heights(),
            vec![(103, b32(103)), (104, b32(104)), (105, b32(105))]
        );
        // Re-registered blocks carry no journals (the store owns them).
        assert_eq!(
            idx.rollback(1).unwrap_err(),
            IndexerError::RollbackWithoutJournal { height: 105 }
        );
        assert_eq!(idx.trim_chain(1).unwrap(), 2);
        assert_eq!(idx.retained_from(), Some(105));
    }
    #[test]
    fn trim_chain_to_zero_keeps_the_tip_state() {
        let mut idx = minted();
        idx.apply_block(empty_block(101, 10)).unwrap();
        idx.apply_block(empty_block(102, 11)).unwrap();
        let tip = idx.tip_height();
        let events = idx.event_log().len();
        assert_eq!(idx.trim_chain(0).unwrap(), 3);
        assert!(idx.chain().is_empty());
        assert_eq!(idx.tip_height(), tip);
        assert_eq!(idx.event_log().len(), events);
        assert!(idx.frogger(SAT).is_some());
        idx.rollback(0).unwrap();
        assert_eq!(idx.tip_height(), tip);
    }
    #[test]
    fn state_capture_restores_without_replay_and_continues() {
        let mut idx = minted();
        for h in 101..=105 {
            idx.apply_block(empty_block(h, h as u8)).unwrap();
        }
        let captured = idx.to_state();
        assert_eq!(captured.state.tip_height(), Some(105));
        assert_eq!(captured.state.tip_hash(), Some(b32(105)));

        let mut restored = Indexer::from_state(captured.clone());
        assert_eq!(restored.tip_height(), Some(105));
        assert_eq!(restored.tip_hash(), Some(b32(105)));
        assert!(restored.chain().is_empty(), "no blocks are persisted");
        assert_eq!(restored.retained_from(), None);
        assert_eq!(
            restored.block_height(&b32(105)),
            Some(105),
            "the tip hash is registered for fork detection"
        );
        assert_eq!(restored.event_log(), idx.event_log());
        assert_eq!(restored.frogger(SAT), idx.frogger(SAT));

        // Continue above the snapshot, then roll back within the new
        // blocks: the base is the captured state, so no replay backwards
        // past 105 is needed.
        restored.apply_block(empty_block(106, 106)).unwrap();
        restored.apply_block(empty_block(107, 107)).unwrap();
        restored.rollback(2).unwrap();
        assert_eq!(restored.tip_height(), Some(105));
        assert_eq!(restored.to_state(), captured);

        // A fresh capture (seeds only, no blocks) round-trips too.
        let fresh = Indexer::from_state(Indexer::new(IndexerConfig::default()).to_state());
        assert!(fresh.is_empty());
        assert_eq!(fresh.tip_hash(), None);
    }

    #[test]
    fn recorded_batches_reproduce_the_engine_state() {
        use crate::store::StateStore;

        fn check(idx: &mut Indexer, block: Block) {
            let before = idx.state().clone();
            let (_report, _effects, write) = idx.apply_block_recorded(block).unwrap();
            let mut replayed = before;
            replayed.commit_block(&write).unwrap();
            assert_eq!(
                bincode::serialize(&replayed).unwrap(),
                bincode::serialize(idx.state()).unwrap(),
                "replaying the forward batch diverged from the engine"
            );
        }

        let mut idx = Indexer::new(IndexerConfig::default());
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);

        check(&mut idx, block_of(100, 1, vec![mint_tx(2)]));
        let mv = move_tx(&idx, 3);
        check(&mut idx, block_of(101, 2, vec![mv]));
        let mv = move_tx(&idx, 4);
        check(&mut idx, block_of(102, 3, vec![mv]));
    }

    #[cfg(feature = "redb")]
    #[test]
    fn journaled_apply_undo_is_byte_identical() {
        let mut state = IndexState::new(IndexerConfig::default());
        state.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
        let before = bincode::serialize(&state).unwrap();

        let block = block_of(100, 1, vec![mint_tx(2)]);
        let (_events, _rejections, effects) = state.apply_block_journaled(&block).unwrap();
        assert!(!effects.is_empty(), "a MINT must journal frogs/coins/tip");
        assert_ne!(bincode::serialize(&state).unwrap(), before);

        state.undo_block(&effects).unwrap();
        assert_eq!(
            bincode::serialize(&state).unwrap(),
            before,
            "undo must restore every field"
        );
    }
    #[test]
    fn record_fields_survive_a_snapshot_round_trip() {
        let mut idx = Indexer::new(IndexerConfig::default());
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
        idx.apply_block(block_of(100, 1, vec![mint_tx(2)])).unwrap();
        {
            let rec = idx.state_mut().frogs.get_mut(&SAT).unwrap();
            rec.state = FroggerState::Crossing;
            rec.wire_version = hopper_core::VERSION;
            rec.in_flight = Some(crate::types::InFlight {
                txid: [7u8; 32],
                height: 101,
                target_hops: 42,
            });
            rec.outcome_block_hash = Some([9u8; 32]);
            rec.provisional_dead = Some(false);
            rec.last_target_hops = Some(42);
            rec.crossings_settled = 3;
            rec.deaths = 1;
            rec.immortal_height = Some(102);
            rec.death_height = Some(103);
        }
        let snapshot = idx.snapshot();
        let restored = Indexer::restore(snapshot).expect("snapshot restores");
        assert_eq!(restored.frogger(SAT), idx.frogger(SAT));
        let rec = restored.frogger(SAT).unwrap();
        assert_eq!(rec.in_flight.unwrap().target_hops, 42);
        assert_eq!(rec.outcome_block_hash, Some([9u8; 32]));
        assert_eq!(rec.immortal_height, Some(102));
    }
}
