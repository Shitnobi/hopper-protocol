//! Replay-free snapshot persistence (v4).
//!
//! v2 persisted `(config, seeds, chain)` and rebuilt state by replaying
//! the whole retained chain on startup — O(chain) time, and the snapshot
//! carried a full copy of every block. v3 persists the **derived state**
//! and the event log instead:
//!
//! * restore is O(state) and needs no blocks at all;
//! * the file no longer grows with the chain (only with live protocol
//!   state and the event log — the latter moves to segmented storage in
//!   P1.4);
//! * the block ring is deliberately not persisted: the block source
//!   refills it on the next sync.
//!
//! Format: [`IndexerSnapshot`] is versioned and serialized with a binary
//! codec (bincode) by the persistence layer — JSON cannot represent the
//! state's non-string map keys (sat u64s, outpoints, block hashes).
//! Pre-v4 files are refused with a clear error; operators reindex.

use std::fmt;

use crate::state_machine::{Indexer, IndexerState};

/// Current snapshot format version; bump on breaking changes.
pub const SNAPSHOT_VERSION: u32 = 7;

/// A replay-free capture of an indexer's tip. Restoring sets the derived
/// state directly (see [`Indexer::from_state`]).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IndexerSnapshot {
    pub version: u32,
    /// Commitment to the parameters that produced this state (V3 §8.6):
    /// a snapshot from a different road must not be adopted.
    pub params_hash: [u8; 32],
    pub indexer: IndexerState,
}

/// Errors from restoring a snapshot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SnapshotError {
    /// The file was written by an incompatible snapshot format.
    UnknownVersion { found: u32, expected: u32 },
    /// The snapshot's state is internally inconsistent (corruption or a
    /// hand-edited file).
    InvalidState(&'static str),
    /// The snapshot was produced by different `ProtocolParams`
    /// (V3 §8.6): adopting it would fork the node silently.
    ParamsMismatch { found: [u8; 32], expected: [u8; 32] },
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SnapshotError::UnknownVersion { found, expected } => {
                write!(
                    f,
                    "snapshot version {found} unsupported (expected {expected})"
                )
            }
            SnapshotError::InvalidState(why) => write!(f, "invalid snapshot state: {why}"),
            SnapshotError::ParamsMismatch { found, expected } => write!(
                f,
                "snapshot parameters mismatch (file {}, node {}); \
                 a snapshot from another road cannot be adopted",
                hex(found),
                hex(expected)
            ),
        }
    }
}

impl std::error::Error for SnapshotError {}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Indexer {
    /// Capture this indexer's tip state and event log (no blocks).
    pub fn snapshot(&self) -> IndexerSnapshot {
        IndexerSnapshot {
            version: SNAPSHOT_VERSION,
            params_hash: hopper_core::params::params_hash(&self.config().params),
            indexer: self.to_state(),
        }
    }

    /// Rebuild an indexer from a snapshot without replaying any block.
    ///
    /// The retained chain starts empty; only the tip hash is registered
    /// for fork detection. A source that still contains the tip extends
    /// normally, while a deeper reorg is reported as a deep fork and
    /// needs an older checkpoint (or a reindex).
    pub fn restore(snapshot: IndexerSnapshot) -> Result<Self, SnapshotError> {
        // Without a node-side expectation, at least prove the file is
        // self-consistent (the state carries the same parameters).
        let embedded = hopper_core::params::params_hash(&snapshot.indexer.config.params);
        Self::restore_with_params(snapshot, embedded)
    }

    /// Restore a snapshot only if it was produced by `expected` parameters
    /// (V3 §8.6). This is the form a node uses.
    pub fn restore_with_params(
        snapshot: IndexerSnapshot,
        expected: [u8; 32],
    ) -> Result<Self, SnapshotError> {
        if snapshot.version != SNAPSHOT_VERSION {
            return Err(SnapshotError::UnknownVersion {
                found: snapshot.version,
                expected: SNAPSHOT_VERSION,
            });
        }
        if snapshot.params_hash != expected {
            return Err(SnapshotError::ParamsMismatch {
                found: snapshot.params_hash,
                expected,
            });
        }
        let embedded = hopper_core::params::params_hash(&snapshot.indexer.config.params);
        if embedded != expected {
            return Err(SnapshotError::ParamsMismatch {
                found: embedded,
                expected,
            });
        }
        let state = &snapshot.indexer.state;
        if state.tip_height().is_some() != state.tip_hash().is_some() {
            return Err(SnapshotError::InvalidState(
                "tip height and tip hash disagree",
            ));
        }
        let events = &snapshot.indexer.events;
        if events
            .windows(2)
            .any(|pair| pair[0].height > pair[1].height)
        {
            return Err(SnapshotError::InvalidState(
                "event log is not in height order",
            ));
        }
        if let (Some(tip), Some(last)) = (state.tip_height(), events.last()) {
            if last.height > tip {
                return Err(SnapshotError::InvalidState(
                    "event log contains a block above the tip",
                ));
            }
        }
        Ok(Indexer::from_state(snapshot.indexer))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state_machine::IndexerConfig;
    use crate::types::{Block, ChainEvent, EventAction, OutPoint, Tx, TxInput, TxOut};
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

    fn empty_block(height: u32, hash: u8) -> Block {
        Block {
            hash: b32(hash),
            height,
            txs: vec![],
        }
    }

    /// Indexer seeded with one funding UTXO and a minted frogger at
    /// height 100 (mint helpers mirror `state_machine` tests).
    fn minted() -> Indexer {
        let mut idx = Indexer::new(IndexerConfig::default());
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
        let payload = envelope(Action::Mint, &encode_mint(0xABCD, "Snapfrog"));
        idx.apply_block(Block {
            hash: b32(7),
            height: 100,
            txs: vec![Tx {
                txid: b32(2),
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
        })
        .unwrap();
        idx
    }

    fn round_trip(snapshot: &IndexerSnapshot) -> IndexerSnapshot {
        let bytes = bincode::serialize(snapshot).unwrap();
        bincode::deserialize(&bytes).unwrap()
    }

    #[test]
    fn snapshot_round_trips_through_bincode_without_blocks() {
        let mut idx = minted();
        for h in 101..=103 {
            idx.apply_block(empty_block(h, (h - 93) as u8)).unwrap();
        }
        let snapshot = idx.snapshot();
        assert_eq!(snapshot.version, SNAPSHOT_VERSION);
        assert_eq!(round_trip(&snapshot), snapshot, "serde round trip");

        let restored = Indexer::restore(snapshot.clone()).unwrap();
        assert_eq!(restored.tip_height(), idx.tip_height());
        assert_eq!(restored.tip_hash(), idx.tip_hash());
        assert!(restored.chain().is_empty(), "blocks are not persisted");
        assert_eq!(restored.event_log(), idx.event_log());
        assert_eq!(restored.froggers(), idx.froggers());
        assert_eq!(restored.location(SAT), idx.location(SAT));
        // Re-snapshotting the restored indexer is identical.
        assert_eq!(restored.snapshot(), snapshot);
    }

    #[test]
    fn restored_indexer_continues_and_rolls_back() {
        let mut idx = minted();
        idx.apply_block(empty_block(101, 8)).unwrap();
        idx.apply_block(empty_block(102, 9)).unwrap();
        let snapshot = idx.snapshot();
        let mut restored = Indexer::restore(snapshot).unwrap();

        // Continue ingesting on the restored indexer.
        restored.apply_block(empty_block(103, 10)).unwrap();
        restored.apply_block(empty_block(104, 11)).unwrap();
        assert_eq!(restored.tip_height(), Some(104));
        // The base is the snapshot state, so rollback is exact and local.
        restored.rollback(2).unwrap();
        assert_eq!(restored.tip_height(), Some(102));
        assert_eq!(restored.tip_hash(), Some(b32(9)));
        assert_eq!(restored.froggers().len(), 1, "frog survives rollback");
    }

    #[test]
    fn restore_refuses_unknown_versions() {
        let mut snapshot = minted().snapshot();
        snapshot.version = 99;
        let err = match Indexer::restore(snapshot) {
            Err(e) => e,
            Ok(_) => panic!("restore must refuse unknown versions"),
        };
        assert_eq!(
            err,
            SnapshotError::UnknownVersion {
                found: 99,
                expected: SNAPSHOT_VERSION
            }
        );
    }

    #[test]
    fn restore_rejects_events_above_the_tip() {
        let mut snapshot = minted().snapshot();
        snapshot.indexer.events.push(ChainEvent {
            block_hash: b32(99),
            height: 999,
            txid: None,
            action: EventAction::Burn { frogger_sat: SAT },
        });
        let err = match Indexer::restore(snapshot) {
            Err(e) => e,
            Ok(_) => panic!("restore must reject an event above the tip"),
        };
        assert_eq!(
            err,
            SnapshotError::InvalidState("event log contains a block above the tip")
        );
    }

    #[test]
    fn a_snapshot_from_another_road_is_refused() {
        use hopper_core::params::{params_hash, ProtocolParams};

        let idx = minted();
        let snapshot = idx.snapshot();
        assert_eq!(snapshot.params_hash, hopper_core::params::protocol_hash());

        let fixture = params_hash(&ProtocolParams::fixture_fast());
        let err = Indexer::restore_with_params(snapshot.clone(), fixture);
        assert!(matches!(
            err,
            Err(SnapshotError::ParamsMismatch { expected, .. }) if expected == fixture
        ));

        // Even with a forged header, the embedded state's parameters are
        // checked: a snapshot cannot smuggle a different road in.
        let mut forged = snapshot;
        forged.params_hash = fixture;
        assert!(matches!(
            Indexer::restore(forged),
            Err(SnapshotError::ParamsMismatch { .. })
        ));

        // The node's own parameters restore the same snapshot.
        let restored =
            Indexer::restore_with_params(idx.snapshot(), hopper_core::params::protocol_hash())
                .expect("same road");
        assert_eq!(restored.tip_height(), idx.tip_height());
    }
}
