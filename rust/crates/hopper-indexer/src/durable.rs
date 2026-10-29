//! Durable indexer: the consensus engine plus a redb state store.
//!
//! Every accepted block is applied to the in-memory engine and committed to
//! the store in a single batch (state after-images + undo journal). The
//! engine remains the consensus oracle; the store is the durable source of
//! truth. Restarting rehydrates the state image from the store, so no block
//! replay is required.

use std::path::Path;

use hopper_core::satmath::SatRange;

use crate::state_machine::{IndexState, Indexer, IndexerConfig, IndexerError};
use crate::store::redb_store::RedbStore;
use crate::store::{self, BlockWrite, StateStore, StateView, StoreError};
use crate::types::{Block, BlockReport, OutPoint};

/// Failures from the durable wrapper.
#[derive(Debug)]
pub enum DurableError {
    /// The consensus core rejected a block.
    Indexer(IndexerError),
    /// The backing store failed.
    Store(StoreError),
    /// The engine has no tip.
    Empty,
    /// A rollback wanted a journal the store no longer retains.
    MissingUndo(u32),
}

impl std::fmt::Display for DurableError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DurableError::Indexer(e) => write!(f, "indexer: {e}"),
            DurableError::Store(e) => write!(f, "store: {e}"),
            DurableError::Empty => write!(f, "indexer has no tip"),
            DurableError::MissingUndo(height) => {
                write!(f, "undo journal for height {height} is no longer retained")
            }
        }
    }
}

impl std::error::Error for DurableError {}

impl From<IndexerError> for DurableError {
    fn from(e: IndexerError) -> Self {
        DurableError::Indexer(e)
    }
}

impl From<StoreError> for DurableError {
    fn from(e: StoreError) -> Self {
        DurableError::Store(e)
    }
}

/// An [`Indexer`] whose state is mirrored into a durable store.
pub struct DurableIndexer {
    indexer: Indexer,
    store: RedbStore,
}

impl DurableIndexer {
    /// Open (or create) a durable index. `seeds` are applied once, only
    /// when the store is fresh; on reopen the state image already contains
    /// their effects.
    pub fn open(
        path: &Path,
        config: IndexerConfig,
        seeds: Vec<(OutPoint, Vec<SatRange>)>,
    ) -> Result<Self, DurableError> {
        Self::open_with_cache(path, config, seeds, None)
    }

    /// Open with an explicit store page-cache bound (see
    /// [`RedbStore::create_with_cache`]).
    pub fn open_with_cache(
        path: &Path,
        config: IndexerConfig,
        seeds: Vec<(OutPoint, Vec<SatRange>)>,
        cache_bytes: Option<usize>,
    ) -> Result<Self, DurableError> {
        let mut store = RedbStore::create_with_cache(path, cache_bytes)?;
        let fresh = StateView::tip(&store)?.0.is_none();
        let indexer = if fresh {
            let mut indexer = Indexer::new(config);
            let mut seed_write = BlockWrite::new(0);
            for (outpoint, ranges) in &seeds {
                indexer.seed_utxo(*outpoint, ranges.clone());
                let entry =
                    StateView::coin(indexer.state(), outpoint)?.expect("a seed creates its UTXO");
                seed_write.put_coin(*outpoint, Some(entry));
            }
            if !seed_write.is_empty() {
                store.commit_block(&seed_write)?;
            }
            indexer
        } else {
            Indexer::from_loaded_state(store.load_state(config)?, seeds)
        };
        Ok(Self { indexer, store })
    }

    /// Seed bootstrap UTXOs into both the engine and the store in one
    /// transaction. Idempotent for the same outpoint; the caller owns the
    /// ranges.
    pub fn seed_utxos(
        &mut self,
        seeds: impl IntoIterator<Item = (OutPoint, Vec<SatRange>)>,
    ) -> Result<(), DurableError> {
        let mut write = BlockWrite::new(0);
        for (outpoint, ranges) in seeds {
            self.indexer.seed_utxo(outpoint, ranges);
            let entry =
                StateView::coin(self.indexer.state(), &outpoint)?.expect("a seed creates its UTXO");
            write.put_coin(outpoint, Some(entry));
        }
        if !write.is_empty() {
            self.store.commit_block(&write)?;
        }
        Ok(())
    }

    /// Convenience wrapper for a single seed.
    pub fn seed_utxo(
        &mut self,
        outpoint: OutPoint,
        ranges: Vec<SatRange>,
    ) -> Result<(), DurableError> {
        self.seed_utxos([(outpoint, ranges)])
    }

    /// Apply a block to the engine and commit its batch plus undo journal.
    pub fn apply_block(&mut self, block: Block) -> Result<BlockReport, DurableError> {
        let (report, effects, write) = self.indexer.apply_block_recorded(block)?;
        self.store.commit_block_with_undo(&write, &effects)?;
        Ok(report)
    }

    /// Roll back `n` blocks from the persisted journals. This works after
    /// a restart, when the engine has no retained chain to replay, and is
    /// O(n) instead of O(retained chain).
    pub fn rollback(&mut self, n: usize) -> Result<(), DurableError> {
        if n == 0 {
            return Ok(());
        }
        let tip = self.indexer.tip_height().ok_or(DurableError::Empty)?;
        let n32 = u32::try_from(n).map_err(|_| DurableError::Empty)?;
        let from = tip
            .checked_sub(n32.saturating_sub(1))
            .ok_or(DurableError::Empty)?;
        let mut journals = Vec::with_capacity(n);
        for height in from..=tip {
            journals.push(
                self.store
                    .undo(height)?
                    .ok_or(DurableError::MissingUndo(height))?,
            );
        }
        for effects in journals.iter().rev() {
            self.indexer.undo_top(effects)?;
            store::undo_block(&mut self.store, effects)?;
        }
        Ok(())
    }

    /// The retained undo window, if any.
    pub fn undo_range(&self) -> Result<Option<(u32, u32)>, DurableError> {
        Ok(self.store.undo_range()?)
    }

    /// Whether the journals for the last `n` blocks are still retained.
    pub fn can_rollback(&self, n: usize) -> Result<bool, DurableError> {
        if n == 0 {
            return Ok(true);
        }
        let Some(tip) = self.tip_height() else {
            return Ok(false);
        };
        let Ok(n32) = u32::try_from(n) else {
            return Ok(false);
        };
        let Some(from) = tip.checked_sub(n32 - 1) else {
            return Ok(false);
        };
        let Some((low, high)) = self.undo_range()? else {
            return Ok(false);
        };
        Ok(low <= from && high >= tip)
    }

    /// Prune undo journals below `height` (finality).
    pub fn trim_undo(&mut self, below: u32) -> Result<usize, DurableError> {
        Ok(self.store.trim_undo_below(below)?)
    }

    /// Current tip height.
    pub fn tip_height(&self) -> Option<u32> {
        self.indexer.tip_height()
    }

    /// Current tip hash.
    pub fn tip_hash(&self) -> Option<[u8; 32]> {
        self.indexer.tip_hash()
    }

    /// The in-memory state image (the consensus oracle).
    pub fn state(&self) -> &IndexState {
        self.indexer.state()
    }

    /// The backing store.
    pub fn store(&self) -> &RedbStore {
        &self.store
    }

    /// Split into the engine and the store (the API holds them separately).
    pub fn into_parts(self) -> (Indexer, RedbStore) {
        (self.indexer, self.store)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Tx, TxInput, TxOut};
    use hopper_core::{encode_mint, envelope, Action};

    const SAT: u64 = 1000;

    fn op(txid: u8, vout: u32) -> OutPoint {
        OutPoint {
            txid: [txid; 32],
            vout,
        }
    }

    fn block(height: u32, hash: u8) -> Block {
        Block {
            hash: [hash; 32],
            height,
            txs: vec![],
        }
    }

    fn mint_block(height: u32, hash: u8) -> Block {
        let payload = envelope(Action::Mint, &encode_mint(0xABCD, "Testfrog"));
        Block {
            hash: [hash; 32],
            height,
            txs: vec![Tx {
                txid: [2u8; 32],
                inputs: vec![TxInput {
                    prevout: op(1, 0),
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
            }],
        }
    }

    #[test]
    fn restart_rehydrates_without_replay() {
        let dir = std::env::temp_dir().join(format!("frogger-durable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("index.redb");
        let seeds = vec![(op(1, 0), vec![SatRange::new(SAT, SAT + 100)])];

        let mut idx = DurableIndexer::open(&path, IndexerConfig::default(), seeds.clone()).unwrap();
        idx.apply_block(mint_block(100, 1)).unwrap();
        idx.apply_block(block(101, 2)).unwrap();
        let expected = bincode::serialize(idx.state()).unwrap();
        drop(idx);

        let mut idx = DurableIndexer::open(&path, IndexerConfig::default(), seeds.clone()).unwrap();
        assert_eq!(idx.tip_height(), Some(101));
        assert_eq!(
            bincode::serialize(idx.state()).unwrap(),
            expected,
            "rehydrated state differs from the engine image"
        );
        idx.apply_block(block(102, 3)).unwrap();
        assert_eq!(idx.tip_height(), Some(102));
        drop(idx);

        let idx = DurableIndexer::open(&path, IndexerConfig::default(), seeds).unwrap();
        assert_eq!(idx.tip_height(), Some(102));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reorg_after_restart_uses_journals() {
        let dir =
            std::env::temp_dir().join(format!("frogger-durable-reorg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("index.redb");
        let seeds = vec![(op(1, 0), vec![SatRange::new(SAT, SAT + 100)])];

        let mut idx = DurableIndexer::open(&path, IndexerConfig::default(), seeds.clone()).unwrap();
        idx.apply_block(mint_block(100, 1)).unwrap();
        idx.apply_block(block(101, 2)).unwrap();
        let at_101 = bincode::serialize(idx.state()).unwrap();
        idx.apply_block(block(102, 3)).unwrap();
        let at_102 = bincode::serialize(idx.state()).unwrap();
        drop(idx);

        let mut idx = DurableIndexer::open(&path, IndexerConfig::default(), seeds).unwrap();
        assert_eq!(idx.tip_height(), Some(102));
        idx.rollback(1).unwrap();
        assert_eq!(idx.tip_height(), Some(101));
        assert_eq!(
            bincode::serialize(idx.state()).unwrap(),
            at_101,
            "journal undo after restart diverged from the pre-block image"
        );
        idx.apply_block(block(102, 3)).unwrap();
        assert_eq!(
            bincode::serialize(idx.state()).unwrap(),
            at_102,
            "re-applying the block after an undo diverged"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn crash_before_commit_leaves_the_block_unapplied() {
        let dir =
            std::env::temp_dir().join(format!("frogger-durable-crash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("index.redb");
        let seeds = vec![(op(1, 0), vec![SatRange::new(SAT, SAT + 100)])];

        let mut idx = DurableIndexer::open(&path, IndexerConfig::default(), seeds.clone()).unwrap();
        idx.apply_block(mint_block(100, 1)).unwrap();
        let committed = bincode::serialize(idx.state()).unwrap();

        // Simulate a crash after the engine applied the block but before the
        // batch committed: drop both without calling apply_block.
        let (_report, _effects, _write) = idx.indexer.apply_block_recorded(block(101, 2)).unwrap();
        drop(idx);

        // The store is the source of truth: the block is gone and can be
        // re-applied from the source.
        let mut idx = DurableIndexer::open(&path, IndexerConfig::default(), seeds).unwrap();
        assert_eq!(idx.tip_height(), Some(100));
        assert_eq!(bincode::serialize(idx.state()).unwrap(), committed);
        assert!(idx.can_rollback(0).unwrap());
        assert!(idx.can_rollback(1).unwrap(), "height 100 journal exists");
        assert!(
            !idx.can_rollback(2).unwrap(),
            "there is no journal below height 100"
        );

        idx.apply_block(block(101, 2)).unwrap();
        let mut reference = Indexer::new(IndexerConfig::default());
        reference.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
        reference.apply_block(mint_block(100, 1)).unwrap();
        reference.apply_block(block(101, 2)).unwrap();
        assert_eq!(
            bincode::serialize(idx.state()).unwrap(),
            bincode::serialize(reference.state()).unwrap(),
            "re-applied block differs from a straight run"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
