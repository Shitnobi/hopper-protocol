//! # hopper-indexer — pure indexer core (HOPPER v7)
//!
//! This crate implements phases **B1+B2** of the indexer workstream: the
//! UTXO/sat-tracking layer and the crossing-lifecycle state machine, as a
//! **pure, deterministic, no-I/O function of confirmed chain data**
//! (SPEC §1 principle 5, §8.1). There is no tokio, no DB, no network here
//! — the ingest/persistence/API layers (B3+) wrap this core.
//!
//! * [`sat_track`] — UTXO set + Ordinals sat-range tracking built on the
//!   frozen [`hopper_core::satmath`] primitives: inputs' sat ranges flow
//!   to outputs FIFO; the tracker knows which UTXO holds each frogger's
//!   anchor sat and detects anchor-sat movement (SPEC §6).
//! * [`rules`] — the v7 hop rule set, its timers, and settlement.
//!   Reorgs roll the retained chain back and re-derive state by replay.
//! * [`types`] — the chain-data model and the re-derivable event log
//!   keyed by `(block_hash, txid, action)` (SPEC §8.1.4).
//!
//! The public entry point is [`Indexer`]:
//!
//! ```no_run
//! use hopper_indexer::state_machine::{Indexer, IndexerConfig};
//! use hopper_indexer::types::Block;
//!
//! let mut indexer = Indexer::new(IndexerConfig::default());
//! # let block: Block = unimplemented!();
//! let report = indexer.apply_block(block).expect("contiguous block");
//! for rejection in &report.rejections {
//!     // Malformed/invalid envelopes are ignored, never fatal (SPEC §8.2.5).
//!     println!("ignored: {:?}", rejection.reason);
//! }
//! ```
//!
//! Design decisions, invariants, and known gaps are documented in
//! `src/NOTES.md`.
#![forbid(unsafe_code)]

pub mod consensus;
#[cfg(feature = "redb")]
pub mod durable;
/// The v7 rules: hops, timers, settlement.
pub mod rules;
pub mod sat_track;
pub mod snapshot;
pub mod state_machine;
pub mod store;
#[cfg(feature = "redb")]
pub mod store_state;
pub mod types;

pub use sat_track::{is_shadow, SatTracker, SHADOW_BASE};
pub use state_machine::{IndexState, Indexer, IndexerConfig, IndexerError, FINALITY_DEPTH};
pub use types::*;
