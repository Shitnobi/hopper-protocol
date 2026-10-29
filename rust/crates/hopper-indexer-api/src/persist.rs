//! Atomic on-disk snapshot persistence for the running API indexer
//! (Workstream B4, v4). Wraps [`hopper_indexer::snapshot`] with:
//!
//! * **every-N gating** — snapshot after every `every` newly-applied
//!   blocks (heights only move forward between snapshots; rollbacks and
//!   seed changes force a write so the file can never lose history);
//! * **atomic writes with one previous generation** — serialize to
//!   `path.tmp`, move the current file to `path.prev`, then rename the
//!   temp over the target (same-directory renames are atomic on POSIX).
//!   A crash at any point leaves either the current or the previous
//!   snapshot loadable;
//! * **binary, versioned payload** — a `FRG4` magic plus bincode. v4
//!   stores derived state + the event log, **not** the chain: restoring
//!   is replay-free and the file no longer grows with the chain;
//! * **startup loading** — `load` returns the restored indexer, or
//!   `None` when no snapshot exists yet. Pre-v4 (JSON) files are refused
//!   with a clear reindex message.
//!
//! The seeds file loader (`HOPPER_SEEDS_FILE`) also lives here: it is
//! the fresh-start counterpart of a snapshot — bootstrap seeds applied
//! before the first catch-up sync, mirroring what the block feeder did
//! with `seeds.json` during the live-regtest runs.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use hopper_core::satmath::SatRange;
use hopper_indexer::snapshot::{IndexerSnapshot, SnapshotError};
use hopper_indexer::state_machine::Indexer;
use hopper_indexer::types::OutPoint;

/// Magic prefix of the current (binary) snapshot file. v2 files were JSON and
/// start with `{`, so they fail this check and get a clear reindex error.
const SNAPSHOT_MAGIC: &[u8; 4] = b"FRG4";

/// Errors from loading a snapshot.
#[derive(Debug)]
pub enum PersistError {
    Io(std::io::Error),
    /// The file is not a known snapshot format, or its payload is corrupt.
    Format(String),
    Snapshot(SnapshotError),
}

impl std::fmt::Display for PersistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PersistError::Io(e) => write!(f, "snapshot io error: {e}"),
            PersistError::Format(m) => write!(f, "snapshot format error: {m}"),
            PersistError::Snapshot(e) => write!(f, "snapshot restore error: {e}"),
        }
    }
}

impl std::error::Error for PersistError {}

impl From<std::io::Error> for PersistError {
    fn from(e: std::io::Error) -> Self {
        PersistError::Io(e)
    }
}

impl From<SnapshotError> for PersistError {
    fn from(e: SnapshotError) -> Self {
        PersistError::Snapshot(e)
    }
}

/// Where and how often to snapshot. Thread-safe (the last-snapshot
/// height lives behind a mutex); safe to share in the API state.
pub struct SnapshotStore {
    path: PathBuf,
    /// Snapshot after this many new blocks; 0 = disabled (tests,
    /// ephemeral runs).
    every: u32,
    last: Mutex<Option<u32>>,
}

impl SnapshotStore {
    /// Size of the current checkpoint file in bytes (0 if absent).
    pub fn bytes(&self) -> u64 {
        std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0)
    }

    /// A store that never writes (existing behavior / tests).
    pub fn disabled() -> Self {
        Self {
            path: PathBuf::new(),
            every: 0,
            last: Mutex::new(None),
        }
    }

    /// An active store. `restored_tip` seeds the gating so a freshly
    /// restored indexer doesn't immediately rewrite its own snapshot.
    pub fn new(path: PathBuf, every: u32, restored_tip: Option<u32>) -> Self {
        Self {
            path,
            every: every.max(1),
            last: Mutex::new(restored_tip),
        }
    }

    pub fn enabled(&self) -> bool {
        self.every > 0
    }

    /// Snapshot if `every` new blocks have been applied since the last
    /// write. Returns whether a snapshot was written. Errors are
    /// returned (callers log-and-continue: ingest must never fail
    /// because persistence hiccuped).
    pub fn snapshot_if_due(&self, indexer: &crate::engine::Engine) -> std::io::Result<bool> {
        if !self.enabled() {
            return Ok(false);
        }
        let Some(tip) = indexer.tip_height() else {
            return Ok(false);
        };
        let mut last = self.last.lock().expect("snapshot lock poisoned");
        let due = match *last {
            Some(l) => tip >= l.saturating_add(self.every),
            None => true,
        };
        if !due {
            return Ok(false);
        }
        self.write(indexer)?;
        *last = Some(tip);
        Ok(true)
    }

    /// Snapshot unconditionally (after rollbacks and seed changes —
    /// events that must survive a restart even before the next
    /// every-N boundary).
    pub fn force(&self, indexer: &crate::engine::Engine) -> std::io::Result<()> {
        if !self.enabled() {
            return Ok(());
        }
        self.write(indexer)?;
        *self.last.lock().expect("snapshot lock poisoned") = indexer.tip_height();
        Ok(())
    }

    fn write(&self, indexer: &crate::engine::Engine) -> std::io::Result<()> {
        // A store-backed engine needs no state snapshot: the store is the
        // checkpoint (copy the file to back it up).
        let Some(memory) = indexer.as_memory() else {
            return Ok(());
        };
        let snapshot = memory.snapshot();
        let body = bincode::serialize(&snapshot)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        let mut bytes = Vec::with_capacity(SNAPSHOT_MAGIC.len() + body.len());
        bytes.extend_from_slice(SNAPSHOT_MAGIC);
        bytes.extend_from_slice(&body);

        let tmp = self.path.with_extension("tmp");
        fs::write(&tmp, bytes)?;
        // Keep one previous generation: a crash between the two renames
        // leaves `.prev` (or the old main) loadable.
        let prev = self.path.with_extension("prev");
        if self.path.exists() {
            fs::rename(&self.path, &prev)?;
        }
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// Load the snapshot at `path`, if one exists. `Ok(None)` = no file
    /// yet (fresh start). If the main file is missing but a previous
    /// generation exists (crash mid-write), the previous one is loaded.
    ///
    /// Restoring is replay-free — see `hopper_indexer::snapshot`.
    pub fn load(path: &Path) -> Result<Option<Indexer>, PersistError> {
        Self::load_with_params(path, &hopper_core::params::PROTOCOL)
    }

    /// Load a snapshot, refusing one produced by different parameters
    /// (V3 §8.6): adopting it would silently fork the node.
    pub fn load_with_params(
        path: &Path,
        params: &hopper_core::params::ProtocolParams,
    ) -> Result<Option<Indexer>, PersistError> {
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let prev = path.with_extension("prev");
                match fs::read(&prev) {
                    Ok(bytes) => bytes,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                    Err(e) => return Err(e.into()),
                }
            }
            Err(e) => return Err(e.into()),
        };
        if !bytes.starts_with(SNAPSHOT_MAGIC) {
            return Err(PersistError::Format(
                "not a current snapshot (expected FRG4 header); older snapshots must be \
                 reindexed from chain"
                    .into(),
            ));
        }
        let snapshot: IndexerSnapshot = bincode::deserialize(&bytes[SNAPSHOT_MAGIC.len()..])
            .map_err(|e| PersistError::Format(format!("corrupt snapshot payload: {e}")))?;
        Ok(Some(Indexer::restore_with_params(
            snapshot,
            hopper_core::params::params_hash(params),
        )?))
    }
}

/// A `HOPPER_SEEDS_FILE` entry (same shape the live-regtest feeder
/// consumed from `seeds.json`).
#[derive(serde::Deserialize)]
pub struct SeedFileEntry {
    /// Seed txid in display order (as printed by bitcoin-cli).
    pub txid: String,
    pub vout: u32,
    /// Sat ranges as `[start, end)` pairs.
    pub ranges: Vec<(u64, u64)>,
}

/// Load bootstrap seeds from a JSON file (fresh starts only — a restored
/// snapshot already embeds its seeds). Txids are display order, exactly
/// like `POST /v1/admin/seed`.
pub fn load_seeds_file(path: &Path) -> Result<Vec<(OutPoint, Vec<SatRange>)>, String> {
    let bytes = fs::read(path).map_err(|e| format!("seeds file {path:?}: {e}"))?;
    let entries: Vec<SeedFileEntry> = serde_json::from_slice(&bytes)
        .map_err(|e| format!("seeds file {path:?}: bad json: {e}"))?;
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let txid = crate::wire::parse_hash(&entry.txid)
            .map_err(|e| format!("seeds file {path:?}: {}: {:?}", e.message(), entry.txid))?;
        let ranges: Vec<SatRange> = entry
            .ranges
            .into_iter()
            .map(|(start, end)| SatRange::new(start, end))
            .collect();
        out.push((
            OutPoint {
                txid,
                vout: entry.vout,
            },
            ranges,
        ));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hopper_indexer::snapshot::SNAPSHOT_VERSION;
    use hopper_indexer::state_machine::{Indexer, IndexerConfig};
    use hopper_indexer::types::Block;

    fn test_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("frogger-persist-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn engine_of(indexer: Indexer) -> crate::engine::Engine {
        crate::engine::Engine::memory(indexer)
    }

    fn small_indexer(blocks: u32) -> Indexer {
        let mut idx = Indexer::new(IndexerConfig::default());
        for i in 0..blocks {
            idx.apply_block(Block {
                hash: [(i + 1) as u8; 32],
                height: i,
                txs: vec![],
            })
            .unwrap();
        }
        idx
    }

    #[test]
    fn disabled_store_never_writes() {
        let store = SnapshotStore::disabled();
        assert!(!store.snapshot_if_due(&engine_of(small_indexer(5))).unwrap());
        assert!(!store.enabled());
    }

    #[test]
    fn every_n_gating_and_atomic_round_trip() {
        let dir = test_dir("gating");
        let path = dir.join("snapshot.bin");
        let store = SnapshotStore::new(path.clone(), 3, None);

        // First write is always due (bootstraps the file).
        // (small_indexer(n) has tip height n-1.)
        assert!(store.snapshot_if_due(&engine_of(small_indexer(2))).unwrap());
        assert!(path.exists());
        // No .tmp left behind.
        assert!(!dir.join("snapshot.tmp").exists());

        // Tip heights 2, 3 are not yet due (last=1, every=3); 4 is.
        assert!(!store.snapshot_if_due(&engine_of(small_indexer(3))).unwrap());
        assert!(!store.snapshot_if_due(&engine_of(small_indexer(4))).unwrap());
        assert!(store.snapshot_if_due(&engine_of(small_indexer(5))).unwrap());

        // Load restores the latest snapshot (tip height 4), replay-free.
        let restored = SnapshotStore::load(&path)
            .unwrap()
            .expect("snapshot exists");
        assert_eq!(restored.tip_height(), Some(4));
        assert_eq!(restored.tip_hash(), Some([5u8; 32]));
        assert!(restored.chain().is_empty(), "no blocks persisted");
        assert_eq!(restored.snapshot().version, SNAPSHOT_VERSION);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn previous_generation_survives_a_crash_mid_write() {
        let dir = test_dir("previous");
        let path = dir.join("snapshot.bin");
        let store = SnapshotStore::new(path.clone(), 1, None);
        assert!(store.snapshot_if_due(&engine_of(small_indexer(2))).unwrap());
        assert!(store.snapshot_if_due(&engine_of(small_indexer(5))).unwrap());

        // The second write rotated the first into `.prev`.
        assert!(path.with_extension("prev").exists());
        assert_eq!(
            SnapshotStore::load(&path).unwrap().unwrap().tip_height(),
            Some(4)
        );

        // Simulate a crash after the rotation but before the new file
        // landed: the previous generation is still loadable.
        fs::remove_file(&path).unwrap();
        assert_eq!(
            SnapshotStore::load(&path).unwrap().unwrap().tip_height(),
            Some(1)
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn pre_v4_json_snapshot_is_refused_with_a_reindex_hint() {
        let dir = test_dir("v2");
        let path = dir.join("snapshot.json");
        fs::write(&path, br#"{"version":2,"config":{},"seeds":[],"chain":[]}"#).unwrap();
        let err = match SnapshotStore::load(&path) {
            Ok(_) => panic!("a v2 snapshot must be refused"),
            Err(e) => e,
        };
        let msg = err.to_string();
        assert!(matches!(err, PersistError::Format(_)), "{msg}");
        assert!(msg.contains("reindexed"), "actionable message: {msg}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// P1.4 contract: the checkpoint holds only a bounded event tail; the
    /// segments hold the rest, survive a restart, and truncate on reorg.
    #[test]
    fn event_segments_outlive_a_trimmed_checkpoint() {
        use crate::eventlog::EventStore;
        use hopper_core::{encode_mint, envelope, Action};
        use hopper_indexer::types::{Block, Tx, TxInput, TxOut};

        let dir = test_dir("events-restart");
        let event_dir = dir.join("snap.bin.events");
        let mut idx = Indexer::new(IndexerConfig::default());
        idx.seed_utxo(
            OutPoint {
                txid: [3u8; 32],
                vout: 0,
            },
            vec![SatRange::new(1_000, 1_100)],
        );
        idx.apply_block(Block {
            hash: [1u8; 32],
            height: 0,
            txs: vec![Tx {
                txid: [2u8; 32],
                inputs: vec![TxInput {
                    prevout: OutPoint {
                        txid: [3u8; 32],
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
                        op_return: Some(envelope(Action::Mint, &encode_mint(7, "Segfrog"))),
                    },
                ],
            }],
        })
        .unwrap();
        for h in 1..=3 {
            idx.apply_block(Block {
                hash: [h as u8 + 10; 32],
                height: h,
                txs: vec![],
            })
            .unwrap();
        }
        let all = idx.event_log().to_vec();
        assert!(!all.is_empty());

        let mut store = EventStore::open(event_dir.clone(), 1).unwrap();
        store.append(&all).unwrap();

        // Checkpoint with a bounded tail (production keeps 4096).
        idx.trim_events(1);
        let snap = idx.snapshot();
        assert_eq!(snap.indexer.events.len(), 1);
        let restored = Indexer::restore(snap).unwrap();
        assert_eq!(restored.tip_height(), Some(3));

        // Restart: reopen the segments and reconcile to the snapshot tip.
        let mut store = EventStore::open(event_dir.clone(), 1).unwrap();
        store
            .truncate_above(restored.tip_height().unwrap())
            .unwrap();
        assert_eq!(store.all().unwrap(), all);
        assert_eq!(store.tail(2).unwrap(), all[all.len().saturating_sub(2)..]);

        // Reorg: the checkpoint and the log both drop the suffix. (Use
        // the original indexer: a restored one has no retained blocks.)
        idx.rollback(1).unwrap();
        store.truncate_above(idx.tip_height().unwrap()).unwrap();
        let expected: Vec<_> = all.iter().filter(|e| e.height <= 2).cloned().collect();
        assert_eq!(store.all().unwrap(), expected);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_missing_file_is_none() {
        let dir = test_dir("missing");
        assert!(SnapshotStore::load(&dir.join("nope.bin"))
            .unwrap()
            .is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restored_tip_suppresses_immediate_rewrite() {
        let dir = test_dir("restored");
        let path = dir.join("snapshot.bin");
        let store = SnapshotStore::new(path.clone(), 10, None);
        let idx = small_indexer(20);
        assert!(store.snapshot_if_due(&engine_of(idx)).unwrap());

        let restored = SnapshotStore::load(&path).unwrap().unwrap();
        let store2 = SnapshotStore::new(path.clone(), 10, restored.tip_height());
        // Tip hasn't advanced past last+every → not due.
        assert!(!store2.snapshot_if_due(&engine_of(restored)).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }
}
