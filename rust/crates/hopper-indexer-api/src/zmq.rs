//! ZMQ `hashblock` subscriber driving best-chain sync (Workstream B4).
//!
//! bitcoind publishes the new tip hash on every block / reorg; we do
//! not trust (or even parse) the payload's currency — every wake-up
//! runs a full [`sync_to_tip`] pass against the source's *current* best
//! chain, so missed, stale, or racing notifications all converge to the
//! same state. A periodic tick re-syncs even if no notification ever
//! arrives (belt and braces against a flapping publisher).
//!
//! The pure core stays network-free: all sockets, RPC, and locking live
//! in this crate. The ZMQ task shares the same `RwLock<Indexer>` as the
//! REST API — ingest is serialized with admin operations by the lock,
//! and snapshots are taken through the same store.

use std::time::Duration;

use tokio::time::{interval, MissedTickBehavior};
use zeromq::{Socket, SocketRecv, SubSocket};

use crate::rpc::BitcoinRpc;
use crate::sync::sync_to_tip;
use crate::SharedState;

/// ZMQ ingest configuration.
#[derive(Clone)]
pub struct IngestConfig {
    /// ZMQ publisher address, e.g. `tcp://127.0.0.1:28332`
    /// (bitcoind `zmqpubhashblock`).
    pub zmq_addr: String,
    /// The bitcoind RPC endpoint used to fetch headers and blocks.
    pub rpc: BitcoinRpc,
    /// First height a fresh indexer ingests from (activation-adjacent
    /// catch-up; snapshots make it irrelevant after the first run).
    pub start_height: u32,
    /// Retained block window for reorg replay; 0 keeps every block.
    /// Trimmed in chunks to amortise the base-state clone.
    pub retain_blocks: usize,
}

/// Trim only once the window has overflowed by this many blocks: each
/// trim clones and advances the base state (O(state)), so doing it every
/// block would dominate ingest.
const TRIM_SLACK: usize = 64;

/// Run the ZMQ ingest loop forever (until the process exits). Connect
/// and subscribe retry until the publisher appears, and sync errors are
/// logged and retried on the next wake-up — the chain keeps moving, so
/// ingest must keep chasing it.
pub async fn run_zmq_ingest(state: SharedState, cfg: IngestConfig) {
    let mut sock = connect_with_retry(&cfg.zmq_addr).await;
    eprintln!("[zmq] subscribed to hashblock at {}", cfg.zmq_addr);

    // Safety-net re-sync cadence. ZMQ is lossy (a fast reorg can drop a
    // hashblock), and a missed notification used to stall ingest until
    // the next block — the reorg e2e legs caught it as a 90 s timeout
    // with the chain already rolled back. One cheap local RPC poll per
    // 15 s bounds that stall; the notification path still does the real
    // work.
    let mut ticks = interval(Duration::from_secs(15));
    ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        // Catch up (blocking work off the async executor).
        let state2 = state.clone();
        let cfg2 = cfg.clone();
        let _ = tokio::task::spawn_blocking(move || sync_pass(&state2, &cfg2)).await;

        // Wait for the next notification (or tick).
        tokio::select! {
            msg = sock.recv() => {
                match msg {
                    Ok(msg) => {
                        state.metrics.zmq_notifications.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        if let Some(hash) = hashblock_hash(&msg) {
                            eprintln!(
                                "[zmq] hashblock {}",
                                crate::dto::hex_display(&hash)
                            );
                        }
                    }
                    // zeromq reconnects the TCP transport itself; the
                    // periodic tick keeps sync alive regardless.
                    Err(e) => eprintln!("[zmq] recv error: {e}"),
                }
            }
            _ = ticks.tick() => {}
        }
    }
}

async fn connect_with_retry(addr: &str) -> SubSocket {
    loop {
        let mut sock = SubSocket::new();
        match sock.connect(addr).await {
            Ok(()) => match sock.subscribe("hashblock").await {
                Ok(()) => return sock,
                Err(e) => eprintln!("[zmq] subscribe failed: {e}; retrying"),
            },
            Err(e) => eprintln!("[zmq] connect to {addr} failed: {e}; retrying"),
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// The 32-byte hash payload of a hashblock notification (internal byte
/// order), if the message is shaped as expected.
fn hashblock_hash(msg: &zeromq::ZmqMessage) -> Option<[u8; 32]> {
    let hash = msg.get(1)?;
    if hash.len() != 32 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(hash);
    Some(out)
}

/// One sync pass: repeat [`sync_to_tip`] while progress is made, so a
/// burst of blocks (or a notification racing the previous pass)
/// converges in one wake-up. Snapshots are taken through the shared
/// store under the same lock.
fn sync_pass(state: &SharedState, cfg: &IngestConfig) {
    let started = std::time::Instant::now();
    let mut rpc = cfg.rpc.clone();
    // SSE cursor: events already pushed to subscribers. Tracked across
    // the pass's iterations so a burst publishes exactly once each.
    let mut published = state.read().event_log().len();
    for _ in 0..100 {
        let report = {
            let mut idx = state.write();
            let report = {
                let mut target = state.sync_target(&mut idx);
                match sync_to_tip(&mut rpc, &mut target, cfg.start_height) {
                    Ok(report) => report,
                    Err(e) => {
                        state
                            .metrics
                            .sync_errors
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        eprintln!("[zmq] sync error: {e}");
                        return;
                    }
                }
            };
            // Bound the retained chain (state is unaffected). Chunked:
            // trimming clones the base state, so do it rarely.
            if cfg.retain_blocks > 0 && idx.chain().len() > cfg.retain_blocks + TRIM_SLACK {
                if let Err(e) = idx.trim_chain(cfg.retain_blocks) {
                    eprintln!("[retention] trim failed: {e}");
                }
            }
            if report.applied > 0 || report.rolled_back > 0 {
                use std::sync::atomic::Ordering;
                state
                    .metrics
                    .blocks_applied
                    .fetch_add(report.applied as u64, Ordering::Relaxed);
                state
                    .metrics
                    .blocks_rolled_back
                    .fetch_add(report.rolled_back as u64, Ordering::Relaxed);
                if report.rolled_back > 0 {
                    state.metrics.reorgs.fetch_add(1, Ordering::Relaxed);
                }
                // Push new events + the new tip to SSE subscribers
                // (non-blocking sends under the write lock).
                crate::sse::publish_new_events(state, &idx, &mut published);
                crate::sse::publish_tip(state, &idx);
            }
            // Persist new events (deduped by height, so a reorg's
            // re-applied blocks are not duplicated), then bound memory.
            if report.rolled_back > 0 {
                state.truncate_events(idx.tip_height().unwrap_or(0));
            }
            state.append_events_after_stored(idx.event_log());
            idx.trim_events(crate::EVENT_TAIL);
            published = published.min(idx.event_log().len());
            match state.snapshots().snapshot_if_due(&idx) {
                Ok(_) => {}
                Err(e) => eprintln!("[snapshot] {e}"),
            }
            report
        };
        if report.applied == 0 && report.rolled_back == 0 {
            if started.elapsed() > Duration::from_secs(1) {
                eprintln!(
                    "[zmq] sync pass finished in {:?} (tip {:?})",
                    started.elapsed(),
                    report.tip_height
                );
            }
            return;
        }
        eprintln!(
            "[zmq] applied {} block(s), rolled back {} → tip {:?}",
            report.applied, report.rolled_back, report.tip_height
        );
    }
    eprintln!("[zmq] sync pass hit the iteration bound; waiting for the next wake-up");
}
