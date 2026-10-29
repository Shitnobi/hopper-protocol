//! Best-chain synchronization: walk the source's chain backwards to the
//! fork point, roll the indexer back to it, apply the new blocks forward
//! (Workstream B4).
//!
//! The unit of correctness is [`sync_to_tip`], written against the
//! [`BlockSource`] trait so it is testable offline against fake chains
//! (the live ZMQ wire plugs a `BitcoinRpc` into the same trait). Reorg
//! handling reuses the core's rollback-by-replay (SPEC §11): the
//! indexer's state is a pure function of its chain, so following any
//! best chain is always "truncate to the fork, re-apply above it".

use hopper_indexer::state_machine::{Indexer, IndexerError};
use hopper_indexer::types::Block;

use crate::rpc::ChainHeader;

/// Where confirmed chain data comes from. Hashes are internal byte
/// order. Implementations: `BitcoinRpc` (live), `FakeSource` (tests).
pub trait BlockSource {
    /// The source's current best tip hash.
    fn best_hash(&mut self) -> Result<[u8; 32], SyncError>;
    /// One header, by hash.
    fn header(&mut self, hash: [u8; 32]) -> Result<ChainHeader, SyncError>;
    /// One full block, by hash.
    fn block(&mut self, hash: [u8; 32]) -> Result<Block, SyncError>;
}

#[derive(Debug)]
pub enum SyncError {
    /// The chain source failed (transport, malformed data).
    Source(String),
    /// The pure core refused a block (non-contiguous heights etc.).
    Indexer(IndexerError),
    /// The best chain forked deeper than the indexer's retained history
    /// (or is an entirely different chain). Requires a fresh re-sync.
    DeepFork { walked: usize },
    /// The fork point found during the walk is no longer in the
    /// indexer's chain by mutation time — the chain changed underneath
    /// the sync; retry.
    ForkVanished { fork: [u8; 32] },
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::Source(m) => write!(f, "chain source: {m}"),
            SyncError::Indexer(e) => write!(f, "indexer: {e}"),
            SyncError::DeepFork { walked } => write!(
                f,
                "reorg deeper than the retained window ({walked} blocks walked): \
                 restore an older snapshot/checkpoint and re-sync, or reindex from scratch"
            ),
            SyncError::ForkVanished { fork } => write!(
                f,
                "fork point {} left the chain mid-sync; retrying",
                crate::dto::hex_display(fork)
            ),
        }
    }
}

impl std::error::Error for SyncError {}

impl From<IndexerError> for SyncError {
    fn from(e: IndexerError) -> Self {
        SyncError::Indexer(e)
    }
}

/// The mutation surface `sync_to_tip` needs. `Indexer` implements the
/// in-memory path; the API's durable target adds a store commit to each
/// apply and a journal undo to each rollback.
pub trait BlockTarget {
    /// Current tip hash.
    fn tip_hash(&self) -> Option<[u8; 32]>;
    /// Current tip height.
    fn tip_height(&self) -> Option<u32>;
    /// Retained-block height by hash (fork detection).
    fn block_height(&self, hash: &[u8; 32]) -> Option<u32>;
    /// Apply one block.
    fn apply(&mut self, block: Block) -> Result<(), SyncError>;
    /// Roll back `n` blocks.
    fn rollback(&mut self, n: usize) -> Result<(), SyncError>;
}

impl BlockTarget for Indexer {
    fn tip_hash(&self) -> Option<[u8; 32]> {
        Indexer::tip_hash(self)
    }

    fn tip_height(&self) -> Option<u32> {
        Indexer::tip_height(self)
    }

    fn block_height(&self, hash: &[u8; 32]) -> Option<u32> {
        Indexer::block_height(self, hash)
    }

    fn apply(&mut self, block: Block) -> Result<(), SyncError> {
        Indexer::apply_block(self, block)
            .map(|_| ())
            .map_err(Into::into)
    }

    fn rollback(&mut self, n: usize) -> Result<(), SyncError> {
        Indexer::rollback(self, n).map_err(Into::into)
    }
}

/// One pass result: how many blocks were applied / rolled back, and the
/// resulting tip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SyncReport {
    pub applied: usize,
    pub rolled_back: usize,
    pub tip_height: Option<u32>,
}

/// Reorgs deeper than this (on a non-fresh indexer) are treated as
/// unrecoverable without a fresh start. Two difficulty periods — far
/// beyond anything bitcoind produces in practice.
const MAX_REORG_WALK: usize = 2016;

/// Bring the indexer up to the source's current best tip, following
/// reorgs. `start_height` only matters for a **fresh** (empty) indexer:
/// it is the first height to ingest, letting operators skip
/// pre-activation history (with seeds covering the bootstrap).
///
/// The caller holds whatever lock guards the indexer; block fetches
/// happen under it (correctness first — see the B4 notes in
/// `CHECKPOINT.md`).
pub fn sync_to_tip(
    source: &mut impl BlockSource,
    indexer: &mut impl BlockTarget,
    start_height: u32,
) -> Result<SyncReport, SyncError> {
    let best = source.best_hash()?;
    if indexer.tip_hash() == Some(best) {
        return Ok(SyncReport {
            applied: 0,
            rolled_back: 0,
            tip_height: indexer.tip_height(),
        });
    }

    // Fresh means "no state yet". A restored state snapshot has an empty
    // retained chain but a tip (and its hash is registered in
    // `block_heights`), so it must follow the normal fork-detection path.
    let fresh = indexer.tip_height().is_none();

    // Walk the best chain backwards, collecting headers above the fork
    // (newest first). Terminates at:
    // * a block we already have → reorg (or plain extension);
    // * `start_height` on a fresh indexer → initial catch-up;
    // * a fresh tip below `start_height` → nothing to do;
    // * genesis without a common ancestor → DeepFork;
    // * MAX_REORG_WALK on a non-fresh indexer → DeepFork.
    let mut walk: Vec<ChainHeader> = Vec::new();
    let mut fork: Option<ChainHeader> = None;
    let mut cur = best;
    loop {
        let header = source.header(cur)?;
        // O(1) retained-hash lookup (the indexer maintains the map).
        if indexer.block_height(&header.hash).is_some() {
            fork = Some(header);
            break;
        }
        if fresh {
            if header.height == start_height {
                walk.push(header);
                break;
            }
            if header.height < start_height {
                // The source's tip is below our start height (e.g.
                // activation beyond the current chain): nothing to apply.
                break;
            }
        } else if walk.len() >= MAX_REORG_WALK {
            return Err(SyncError::DeepFork { walked: walk.len() });
        }
        if header.height == 0 {
            // Genesis not in our retained chain: either a foreign chain
            // or a fork below our history — both need a fresh sync.
            return Err(SyncError::DeepFork { walked: walk.len() });
        }
        walk.push(header);
        let Some(prev) = header.prev else {
            return Err(SyncError::DeepFork { walked: walk.len() });
        };
        cur = prev;
    }

    // Fetch full blocks for the walk (validate each against its header).
    let mut blocks: Vec<Block> = Vec::with_capacity(walk.len());
    for header in &walk {
        let block = source.block(header.hash)?;
        if block.hash != header.hash || block.height != header.height {
            return Err(SyncError::Source(format!(
                "source returned block {} for header {}",
                crate::dto::hex_display(&block.hash),
                crate::dto::hex_display(&header.hash)
            )));
        }
        blocks.push(block);
    }
    blocks.reverse(); // oldest first

    // Mutate: roll back to the fork, then apply forward. The fork's
    // height is re-derived from the *current* chain — the chain may
    // have grown during the walk (e.g. the admin ingest endpoint), and
    // truncation absorbs whatever was applied above the fork.
    let mut rolled_back = 0;
    if let Some(fork) = fork {
        let tip = indexer
            .tip_height()
            .expect("fork implies a non-empty chain");
        let fork_height = indexer
            .block_height(&fork.hash)
            .ok_or(SyncError::ForkVanished { fork: fork.hash })?;
        let n = (tip - fork_height) as usize;
        if n > 0 {
            indexer.rollback(n)?;
            rolled_back = n;
        }
    }
    let applied = blocks.len();
    for block in blocks {
        indexer.apply(block)?;
    }

    Ok(SyncReport {
        applied,
        rolled_back,
        tip_height: indexer.tip_height(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use hopper_core::satmath::SatRange;
    use hopper_core::{encode_mint, envelope, Action};
    use hopper_indexer::state_machine::{Indexer, IndexerConfig};
    use hopper_indexer::types::{OutPoint, Tx, TxInput, TxOut};

    fn b32(n: u8) -> [u8; 32] {
        [n; 32]
    }

    /// A chain where block `i` has hash `b32(tag + i)` and height
    /// `start + i`, linked by prev hashes.
    fn chain(tag: u8, start: u32, len: u32) -> Vec<Block> {
        (0..len)
            .map(|i| Block {
                hash: b32(tag + i as u8),
                height: start + i,
                txs: vec![],
            })
            .collect()
    }

    /// An in-memory source over one switchable chain.
    struct FakeSource {
        chain: Vec<Block>,
    }

    impl FakeSource {
        fn find(&self, hash: [u8; 32]) -> &Block {
            self.chain.iter().find(|b| b.hash == hash).unwrap()
        }
    }

    impl BlockSource for FakeSource {
        fn best_hash(&mut self) -> Result<[u8; 32], SyncError> {
            Ok(self.chain.last().unwrap().hash)
        }
        fn header(&mut self, hash: [u8; 32]) -> Result<ChainHeader, SyncError> {
            let block = self.find(hash);
            let pos = self.chain.iter().position(|b| b.hash == hash).unwrap();
            Ok(ChainHeader {
                hash: block.hash,
                height: block.height,
                prev: if pos == 0 {
                    None
                } else {
                    Some(self.chain[pos - 1].hash)
                },
            })
        }
        fn block(&mut self, hash: [u8; 32]) -> Result<Block, SyncError> {
            Ok(self.find(hash).clone())
        }
    }

    fn sync(source: &mut FakeSource, indexer: &mut Indexer) -> SyncReport {
        sync_to_tip(source, indexer, 0).unwrap()
    }

    #[test]
    fn fresh_catch_up_applies_the_whole_chain() {
        let mut source = FakeSource {
            chain: chain(1, 0, 6),
        };
        let mut indexer = Indexer::new(IndexerConfig::default());
        let report = sync(&mut source, &mut indexer);
        assert_eq!(report.applied, 6);
        assert_eq!(report.rolled_back, 0);
        assert_eq!(indexer.tip_height(), Some(5));
        assert_eq!(indexer.tip_hash(), Some(b32(6)));
    }

    #[test]
    fn fresh_catch_up_respects_start_height() {
        let mut source = FakeSource {
            chain: chain(1, 0, 6),
        };
        let mut indexer = Indexer::new(IndexerConfig::default());
        let report = sync_to_tip(&mut source, &mut indexer, 3).unwrap();
        assert_eq!(report.applied, 3); // heights 3, 4, 5 only
        assert_eq!(indexer.tip_height(), Some(5));
        assert_eq!(indexer.chain().len(), 3);
    }

    #[test]
    fn fresh_tip_below_start_height_is_a_noop() {
        let mut source = FakeSource {
            chain: chain(1, 0, 6),
        };
        let mut indexer = Indexer::new(IndexerConfig::default());
        let report = sync_to_tip(&mut source, &mut indexer, 100).unwrap();
        assert_eq!(report.applied, 0);
        assert_eq!(indexer.tip_height(), None);
    }

    #[test]
    fn at_tip_is_a_noop() {
        let mut source = FakeSource {
            chain: chain(1, 0, 6),
        };
        let mut indexer = Indexer::new(IndexerConfig::default());
        sync(&mut source, &mut indexer);
        let report = sync(&mut source, &mut indexer);
        assert_eq!(report.applied, 0);
        assert_eq!(report.rolled_back, 0);
    }

    #[test]
    fn extends_when_new_blocks_arrive() {
        let mut source = FakeSource {
            chain: chain(1, 0, 6),
        };
        let mut indexer = Indexer::new(IndexerConfig::default());
        sync(&mut source, &mut indexer);
        source.chain.extend(chain(7, 6, 2)); // heights 6, 7
        let report = sync(&mut source, &mut indexer);
        assert_eq!(report.applied, 2);
        assert_eq!(report.rolled_back, 0);
        assert_eq!(indexer.tip_height(), Some(7));
    }

    #[test]
    fn reorg_rolls_back_and_replays() {
        // Chain A: heights 0..=5. Chain B: forks after height 3.
        let mut source = FakeSource {
            chain: chain(1, 0, 6),
        };
        let mut indexer = Indexer::new(IndexerConfig::default());
        sync(&mut source, &mut indexer);

        // A frog minted on A's block 5 — it must vanish on the reorg.
        indexer.seed_utxo(
            OutPoint {
                txid: b32(1),
                vout: 0,
            },
            vec![SatRange::new(SAT, SAT + 100)],
        );
        let mut mint_block = chain(6, 5, 1).pop().unwrap();
        mint_block.txs = vec![mint_tx()];
        indexer.rollback(1).unwrap();
        indexer.apply_block(mint_block).unwrap();
        assert_eq!(indexer.froggers().len(), 1);
        // The source still serves the plain A chain; tip 5.
        source.chain = chain(1, 0, 6);

        // Reorg: B shares 0..=3, diverges at 4'..6'.
        let mut b = chain(1, 0, 4);
        b.extend(chain(50, 4, 3));
        source.chain = b;

        let report = sync(&mut source, &mut indexer);
        assert_eq!(report.rolled_back, 2, "tip 5 → fork 3");
        assert_eq!(report.applied, 3, "blocks 4', 5', 6'");
        assert_eq!(indexer.tip_height(), Some(6));
        assert_eq!(indexer.tip_hash(), Some(b32(52)));
        assert_eq!(
            indexer.froggers().len(),
            0,
            "the mint on the losing branch is reorged away"
        );
    }

    #[test]
    fn foreign_genesis_is_a_deep_fork() {
        let mut source = FakeSource {
            chain: chain(1, 0, 6),
        };
        let mut indexer = Indexer::new(IndexerConfig::default());
        sync(&mut source, &mut indexer);
        // A chain with a different genesis shares nothing above height 0.
        source.chain = chain(90, 0, 4);
        let err = sync_to_tip(&mut source, &mut indexer, 0).unwrap_err();
        assert!(matches!(err, SyncError::DeepFork { .. }));
        assert_eq!(indexer.tip_height(), Some(5), "indexer untouched");
    }

    #[test]
    fn following_a_shorter_best_chain_rolls_back() {
        // bitcoind itself reorged to a shorter chain (best tip went
        // backward) — we follow the source's best chain.
        let mut source = FakeSource {
            chain: chain(1, 0, 6),
        };
        let mut indexer = Indexer::new(IndexerConfig::default());
        sync(&mut source, &mut indexer);
        source.chain = chain(1, 0, 4); // best tip now height 3
        let report = sync(&mut source, &mut indexer);
        assert_eq!(report.rolled_back, 2);
        assert_eq!(report.applied, 0);
        assert_eq!(indexer.tip_height(), Some(3));
    }

    #[test]
    fn restored_state_recognises_its_tip_and_extends() {
        let mut source = FakeSource {
            chain: chain(1, 0, 6),
        };
        let mut indexer = Indexer::new(IndexerConfig::default());
        sync(&mut source, &mut indexer);

        // Restart from a state capture: no blocks retained, tip known.
        let mut restored = Indexer::from_state(indexer.to_state());
        assert!(restored.chain().is_empty());
        assert_eq!(restored.tip_height(), Some(5));

        source.chain.extend(chain(7, 6, 2)); // heights 6, 7
        let report = sync(&mut source, &mut restored);
        assert_eq!(report.applied, 2);
        assert_eq!(report.rolled_back, 0, "the snapshot tip is the fork");
        assert_eq!(restored.tip_height(), Some(7));
        assert_eq!(restored.tip_hash(), Some(b32(8)));
    }

    #[test]
    fn restored_state_cannot_follow_a_deeper_reorg_alone() {
        // The retained window is empty after a state restore, so a source
        // that no longer contains the snapshot tip is a deep fork: the
        // persistence layer must restore an older checkpoint and refetch.
        let mut source = FakeSource {
            chain: chain(1, 0, 6),
        };
        let mut indexer = Indexer::new(IndexerConfig::default());
        sync(&mut source, &mut indexer);
        let mut restored = Indexer::from_state(indexer.to_state());

        source.chain = chain(90, 0, 4);
        let err = sync_to_tip(&mut source, &mut restored, 0).unwrap_err();
        assert!(matches!(err, SyncError::DeepFork { .. }));
        assert_eq!(restored.tip_height(), Some(5), "untouched");
    }

    // --- mint helper (mirrors state_machine tests) ---

    const SAT: u64 = 1_000;

    fn mint_tx() -> Tx {
        let payload = envelope(Action::Mint, &encode_mint(0xBEEF, "Syncfrog"));
        Tx {
            txid: b32(2),
            inputs: vec![TxInput {
                prevout: OutPoint {
                    txid: b32(1),
                    vout: 0,
                },
                value: 100,
                inscription: None,
            }],
            outputs: vec![
                TxOut {
                    value: 100,
                    op_return: None,
                },
                TxOut {
                    value: 0,
                    op_return: Some(payload),
                },
            ],
        }
    }

    /// Seeding survives reorg rollback: the funding UTXO is re-applied
    /// on every replay (verified through the reorg test above needing
    /// no re-seed — kept here as an explicit check).
    #[test]
    fn seeds_survive_rollback_replay() {
        let mut source = FakeSource {
            chain: chain(1, 0, 4),
        };
        let mut indexer = Indexer::new(IndexerConfig::default());
        indexer.seed_utxo(
            OutPoint {
                txid: b32(1),
                vout: 0,
            },
            vec![SatRange::new(SAT, SAT + 100)],
        );
        sync(&mut source, &mut indexer);
        indexer.rollback(2).unwrap();
        assert_eq!(
            indexer.utxo_ranges(b32(1), 0).map(|(v, r)| (v, r.len())),
            Some((100, 1)),
            "seed re-applied after rollback"
        );
    }
}
