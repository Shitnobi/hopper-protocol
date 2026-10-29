//! Server-Sent Events push (B4 leftovers).
//!
//! `GET /v1/events/stream` — a persistent SSE connection that pushes
//! new protocol events and tip changes as they happen, so wallets no
//! longer need to poll `/v1/events` / `/v1/status`.
//!
//! Design:
//! * One `tokio::sync::broadcast` bus in [`crate::ApiState`]; every
//!   ingest path (admin block, ZMQ sync) publishes while holding the
//!   indexer write lock — `send` is non-blocking, so this never
//!   stalls ingest.
//! * History is NOT replayed on connect: the event log is re-derivable
//!   and served by the REST tail (`/v1/events`). Subscribers see only
//!   what happens after they connect — plus a `tip` snapshot event
//!   sent immediately on connect, so a fresh client learns the current
//!   tip without a separate REST call.
//! * Slow consumers: a 1024-slot broadcast buffer; if a client lags
//!   past it, it receives a `lagged` event (dropped-message count) and
//!   is expected to re-sync via REST.
//!
//! Message kinds on the wire (SSE `event:` type):
//! * `event` — data is the same JSON as `/v1/events` items;
//! * `tip`   — data is `{"height": u32|null, "hash": display-hex|null}`;
//! * `lagged`— data is `{"dropped": n}` — the client missed messages.

use std::convert::Infallible;
use std::sync::atomic::Ordering;

use axum::response::sse::{Event, KeepAlive, Sse};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::{ApiState, SharedState};

/// One push message on the bus (pre-serialized data; SSE framing is
/// added per-subscriber since the `event:` type rides the SSE layer).
#[derive(Debug, Clone)]
pub struct PushMessage {
    /// SSE event type: `event` | `tip` | `lagged`.
    pub kind: &'static str,
    /// JSON payload, serialized with `serde_json::to_string`.
    pub data: String,
}

/// Publish new events appended to the indexer's event log since
/// `*published`, then advance `*published`. Call while holding a lock
/// on the indexer so the slice is consistent.
pub fn publish_new_events(state: &ApiState, idx: &crate::engine::Engine, published: &mut usize) {
    let log = idx.event_log();
    // A rollback can shrink the log below the cursor, and trimming
    // shifts indices; clamp instead of panicking.
    *published = (*published).min(log.len());
    if log.len() > *published {
        state
            .metrics
            .events
            .fetch_add((log.len() - *published) as u64, Ordering::Relaxed);
    }
    for e in &log[*published..] {
        let dto = crate::dto::event_dto(e);
        let Ok(data) = serde_json::to_string(&dto) else {
            continue;
        };
        state.push(PushMessage {
            kind: "event",
            data,
        });
    }
    *published = log.len();
}

/// Publish the current tip (after an apply or rollback).
pub fn publish_tip(state: &ApiState, idx: &crate::engine::Engine) {
    let data = serde_json::json!({
        "height": idx.tip_height(),
        "hash": idx.tip_hash().map(|h| crate::dto::hex_display(&h)),
    })
    .to_string();
    state.push(PushMessage { kind: "tip", data });
}

/// `GET /v1/events/stream` — the SSE endpoint.
pub async fn events_stream(
    axum::extract::State(state): axum::extract::State<SharedState>,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, Infallible>>> {
    let rx = state.subscribe_events();

    // Client gauge: counts up now, down when the stream is dropped
    // (the guard moves into the stream's closure chain).
    state.metrics.sse_clients.fetch_add(1, Ordering::Relaxed);
    let guard = ClientGuard {
        state: state.clone(),
    };

    // Tip snapshot so a fresh subscriber knows where the chain is.
    let tip = {
        let idx = state.read();
        serde_json::json!({
            "height": idx.tip_height(),
            "hash": idx.tip_hash().map(|h| crate::dto::hex_display(&h)),
        })
        .to_string()
    };
    let first = Ok(Event::default().event("tip").data(tip));

    let stream =
        tokio_stream::iter(vec![first]).chain(BroadcastStream::new(rx).filter_map(move |msg| {
            // Keep `guard` alive for the lifetime of the stream.
            let _g = &guard;
            let ev = match msg {
                Ok(m) => Event::default().event(m.kind).data(m.data),
                Err(tokio_stream::wrappers::errors::BroadcastStreamRecvError::Lagged(n)) => {
                    Event::default()
                        .event("lagged")
                        .data(format!("{{\"dropped\":{n}}}"))
                }
            };
            Some(Ok(ev))
        }));

    Sse::new(stream).keep_alive(KeepAlive::default())
}

/// Decrements the SSE client gauge when the stream is dropped.
struct ClientGuard {
    state: SharedState,
}

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.state
            .metrics
            .sse_clients
            .fetch_sub(1, Ordering::Relaxed);
    }
}
