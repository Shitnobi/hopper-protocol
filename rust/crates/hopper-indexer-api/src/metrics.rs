//! Prometheus-style metrics (B4 leftovers).
//!
//! A tiny hand-rolled registry — no dependency, no macro magic. The
//! [`Metrics`] struct lives in [`crate::ApiState`] behind the same Arc,
//! so every ingest path (admin block, ZMQ sync) can bump counters via
//! atomic fetch-adds, and `GET /metrics` renders counters plus gauges
//! derived from the indexer at scrape time.
//!
//! Rendered format is the Prometheus text exposition format
//! (text/plain; version=0.0.4), so a stock Prometheus/`promtail` can
//! scrape the indexer directly.
//!
//! Naming: `frogger_` prefix, `_total` suffix on counters. Gauges that
//! mirror indexer state (tip height, froggers, active crossings) are
//! computed under the caller's read lock and passed in, keeping this
//! module pure and trivially testable.

use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::Instant;

/// Gauges read from the indexer at scrape time. Plain values so the
/// registry stays independent of the indexer crate.
#[derive(Debug, Clone, Copy)]
pub struct Gauges {
    pub tip_height: Option<u32>,
    pub froggers: usize,
    pub active_crossings: usize,
    pub finished_crossings: usize,
    pub utxos: usize,
    pub retained_blocks: usize,
    pub retained_from: Option<u32>,
    pub event_tail: usize,
    pub snapshot_bytes: u64,
    /// Mirror tip and whether it matches the engine (`None` = no mirror).
    pub store_tip_height: Option<u32>,
    pub store_tip_matches: Option<bool>,
}

/// Ingest/protocol metrics. All counters are monotonic; `sse_clients`
/// is a gauge (up on subscribe, down on disconnect).
#[derive(Debug, Default)]
pub struct Metrics {
    /// Blocks applied to the chain (both ingest paths).
    pub blocks_applied: AtomicU64,
    /// Blocks rolled back by reorgs.
    pub blocks_rolled_back: AtomicU64,
    /// Number of reorg events (a pass with rolled_back > 0).
    pub reorgs: AtomicU64,
    /// Protocol events emitted (envelope applications + lifecycle).
    pub events: AtomicU64,
    /// Envelope rejections (malformed / invalid envelopes, by reason).
    pub rejections: AtomicU64,
    /// Sync pass failures (RPC/transport errors).
    pub sync_errors: AtomicU64,
    /// ZMQ `hashblock` notifications received.
    pub zmq_notifications: AtomicU64,
    /// Mempool preview fetches served.
    pub mempool_previews: AtomicU64,
    /// Fee-suggestion responses served (`/v1/fees`).
    pub fee_suggestions: AtomicU64,
    /// Currently connected SSE clients (gauge).
    pub sse_clients: AtomicI64,
    /// Process start (for uptime).
    started: Option<std::time::Instant>,
}

impl Metrics {
    /// A metrics registry with the process start recorded.
    pub fn new() -> Self {
        Self {
            started: Some(Instant::now()),
            ..Self::default()
        }
    }

    fn uptime_secs(&self) -> f64 {
        self.started
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(0.0)
    }

    /// Render the text exposition format. The [`Gauges`] are read from
    /// the indexer under the caller's lock.
    pub fn render(&self, g: Gauges) -> String {
        let mut out = String::with_capacity(2048);
        let counter = |out: &mut String, name: &str, help: &str, v: u64| {
            out.push_str(&format!("# HELP {name} {help}\n"));
            out.push_str(&format!("# TYPE {name} counter\n"));
            out.push_str(&format!("{name} {v}\n"));
        };
        let gauge = |out: &mut String, name: &str, help: &str, v: &str| {
            out.push_str(&format!("# HELP {name} {help}\n"));
            out.push_str(&format!("# TYPE {name} gauge\n"));
            out.push_str(&format!("{name} {v}\n"));
        };

        counter(
            &mut out,
            "frogger_blocks_applied_total",
            "Blocks applied to the indexer chain.",
            self.blocks_applied.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "frogger_blocks_rolled_back_total",
            "Blocks rolled back by reorgs.",
            self.blocks_rolled_back.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "frogger_reorgs_total",
            "Reorg passes (rolled back at least one block).",
            self.reorgs.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "frogger_events_total",
            "Protocol events emitted.",
            self.events.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "frogger_rejections_total",
            "Envelope rejections.",
            self.rejections.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "frogger_sync_errors_total",
            "Failed sync passes.",
            self.sync_errors.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "frogger_zmq_notifications_total",
            "ZMQ hashblock notifications received.",
            self.zmq_notifications.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "frogger_mempool_previews_total",
            "Mempool previews served.",
            self.mempool_previews.load(Ordering::Relaxed),
        );
        counter(
            &mut out,
            "frogger_fee_suggestions_total",
            "Fee suggestions served.",
            self.fee_suggestions.load(Ordering::Relaxed),
        );

        gauge(
            &mut out,
            "frogger_sse_clients",
            "Connected SSE clients.",
            &self.sse_clients.load(Ordering::Relaxed).to_string(),
        );
        gauge(
            &mut out,
            "frogger_tip_height",
            "Indexer tip height (-1 = no blocks yet).",
            &g.tip_height
                .map(|h| h.to_string())
                .unwrap_or_else(|| "-1".into()),
        );
        gauge(
            &mut out,
            "frogger_froggers",
            "Tracked froggers.",
            &g.froggers.to_string(),
        );
        gauge(
            &mut out,
            "frogger_active_crossings",
            "Active crossings.",
            &g.active_crossings.to_string(),
        );
        // State size / retention gauges (P1.6). These are O(1) counts, so a
        // scrape never serializes the state; the checkpoint size is a
        // metadata call on the snapshot path.
        gauge(
            &mut out,
            "frogger_finished_crossings",
            "Finished crossings retained in state.",
            &g.finished_crossings.to_string(),
        );
        gauge(
            &mut out,
            "frogger_utxos",
            "Coins in the tracked UTXO set.",
            &g.utxos.to_string(),
        );
        gauge(
            &mut out,
            "frogger_retained_blocks",
            "Blocks retained for rollback (undo depth).",
            &g.retained_blocks.to_string(),
        );
        gauge(
            &mut out,
            "frogger_retained_from_height",
            "Oldest retained rollback height (-1 = none).",
            &g.retained_from
                .map(|h| h.to_string())
                .unwrap_or_else(|| "-1".into()),
        );
        gauge(
            &mut out,
            "frogger_event_tail",
            "Events in the in-memory tail.",
            &g.event_tail.to_string(),
        );
        gauge(
            &mut out,
            "frogger_store_attached",
            "1 when a durable state mirror is attached.",
            if g.store_tip_height.is_some() || g.store_tip_matches.is_some() {
                "1"
            } else {
                "0"
            },
        );
        gauge(
            &mut out,
            "frogger_store_tip_height",
            "Durable mirror tip height (-1 = no mirror).",
            &g.store_tip_height
                .map(|h| h.to_string())
                .unwrap_or_else(|| "-1".into()),
        );
        gauge(
            &mut out,
            "frogger_store_tip_matches",
            "1 when the mirror tip equals the engine tip (meaningful with store_attached=1).",
            match g.store_tip_matches {
                Some(true) => "1",
                Some(false) => "0",
                None => "-1",
            },
        );
        gauge(
            &mut out,
            "frogger_snapshot_bytes",
            "Size of the persisted checkpoint in bytes (0 = none).",
            &g.snapshot_bytes.to_string(),
        );
        gauge(
            &mut out,
            "frogger_uptime_seconds",
            "Process uptime in seconds.",
            &format!("{:.3}", self.uptime_secs()),
        );

        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_counters_and_gauges() {
        let m = Metrics::new();
        m.blocks_applied.fetch_add(3, Ordering::Relaxed);
        m.events.fetch_add(7, Ordering::Relaxed);
        let text = m.render(Gauges {
            tip_height: Some(42),
            froggers: 5,
            active_crossings: 2,
            finished_crossings: 9,
            utxos: 7,
            retained_blocks: 3,
            retained_from: Some(40),
            event_tail: 11,
            snapshot_bytes: 1234,
            store_tip_height: Some(41),
            store_tip_matches: Some(false),
        });
        assert!(text.contains("# TYPE frogger_blocks_applied_total counter"));
        assert!(text.contains("frogger_blocks_applied_total 3"));
        assert!(text.contains("frogger_events_total 7"));
        assert!(text.contains("frogger_store_attached 1"));
        assert!(text.contains("frogger_store_tip_height 41"));
        assert!(text.contains("frogger_store_tip_matches 0"));
        assert!(text.contains("frogger_tip_height 42"));
        assert!(text.contains("frogger_froggers 5"));
        assert!(text.contains("frogger_active_crossings 2"));
        assert!(text.contains("frogger_finished_crossings 9"));
        assert!(text.contains("frogger_utxos 7"));
        assert!(text.contains("frogger_retained_blocks 3"));
        assert!(text.contains("frogger_retained_from_height 40"));
        assert!(text.contains("frogger_event_tail 11"));
        assert!(text.contains("frogger_snapshot_bytes 1234"));
        assert!(text.contains("frogger_uptime_seconds"));
        // Every metric line is metric-name + value.
        for line in text
            .lines()
            .filter(|l| !l.starts_with('#') && !l.is_empty())
        {
            assert_eq!(line.split_whitespace().count(), 2, "bad line: {line}");
        }
    }

    #[test]
    fn no_tip_is_negative_one() {
        let empty = Gauges {
            tip_height: None,
            froggers: 0,
            active_crossings: 0,
            finished_crossings: 0,
            utxos: 0,
            retained_blocks: 0,
            retained_from: None,
            event_tail: 0,
            snapshot_bytes: 0,
            store_tip_height: None,
            store_tip_matches: None,
        };
        let text = Metrics::default().render(empty);
        assert!(text.contains("frogger_tip_height -1"));
        assert!(text.contains("frogger_store_attached 0"));
        assert!(text.contains("frogger_store_tip_matches -1"));
    }
}
