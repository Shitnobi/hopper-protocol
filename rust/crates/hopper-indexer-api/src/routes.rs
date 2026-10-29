//! HTTP handlers for the v1 API.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::dto::{
    event_dto, fees_dto, frogger_dto, in_flight_dto_with, rejection_dto, FeesDto, FroggerDto,
    FroggersPageDto, IngestReportDto, LeaderboardEntryDto, RoadDto, StatusDto, UtxoDto,
};
use crate::{ApiError, SharedState};

use std::sync::atomic::Ordering;

const DEFAULT_LIMIT: usize = 50;
const MAX_LIMIT: usize = 500;

fn parse_limit(limit: Option<String>) -> Result<usize, ApiError> {
    match limit {
        None => Ok(DEFAULT_LIMIT),
        Some(s) => s
            .parse::<usize>()
            .map(|n| n.min(MAX_LIMIT))
            .map_err(|_| ApiError::BadRequest("limit must be a non-negative integer".into())),
    }
}

fn parse_offset(offset: Option<String>) -> Result<usize, ApiError> {
    match offset {
        None => Ok(0),
        Some(s) => s
            .parse::<usize>()
            .map_err(|_| ApiError::BadRequest("offset must be a non-negative integer".into())),
    }
}

fn parse_sat(sat: &str) -> Result<u64, ApiError> {
    sat.parse::<u64>()
        .map_err(|_| ApiError::BadRequest("sat must be a decimal integer".into()))
}

/// GET /v1/status
pub async fn status(State(state): State<SharedState>) -> Json<StatusDto> {
    let idx = state.read();
    Json(StatusDto {
        tip_height: idx.tip_height(),
        tip_hash: idx.tip_hash().map(|h| crate::dto::hex_display(&h)),
        finality_depth: hopper_indexer::state_machine::FINALITY_DEPTH,
        froggers: idx.frog_count(),
        active_crossings: idx.in_flight().len(),
        wire_version: hopper_core::VERSION,
    })
}

#[derive(Deserialize)]
pub struct PageParams {
    limit: Option<String>,
    offset: Option<String>,
    /// Keyset cursor: return frogs with `sat > after_sat`.
    after_sat: Option<String>,
    /// Inclusive upper bound: return frogs with `sat <= to_sat`. Added
    /// for receive discovery: a wallet asks which frogs sit in the sat
    /// ranges of its own coins instead of enumerating the whole table.
    to_sat: Option<String>,
}

/// One page of frogs, plus the cursor for the next page.
#[cfg(feature = "redb")]
fn store_error(e: hopper_indexer::store::StoreError) -> ApiError {
    ApiError::Internal(format!("durable mirror: {e}"))
}

/// Serve a frogger page straight from the durable mirror (P2.5a): keyset
/// scans over the redb table instead of the in-memory BTreeMap. The mirror
/// is committed before any route observes the new tip, so the page is the
/// same as the engine's.
#[cfg(feature = "redb")]
fn froggers_page_from_store(
    store: &hopper_indexer::store::redb_store::RedbStore,
    after_sat: Option<u64>,
    to_sat: Option<u64>,
    offset: usize,
    limit: usize,
) -> Result<FroggersPageDto, ApiError> {
    use hopper_indexer::store::StateView;
    let total = store.frog_count().map_err(store_error)?;
    let rows: Vec<(u64, hopper_indexer::types::FroggerRecord)> = match after_sat {
        Some(after) => store
            .frogs_after(Some(after), limit.saturating_add(1))
            .map_err(store_error)?,
        None => store
            .frogs_after(None, offset.saturating_add(limit).saturating_add(1))
            .map_err(store_error)?
            .into_iter()
            .skip(offset)
            .collect(),
    };
    let mut items = Vec::with_capacity(limit.min(rows.len()));
    let mut next_after_sat = None;
    for (sat, record) in rows {
        if to_sat.is_some_and(|to| sat > to) {
            // Past the requested window — there is no next page.
            break;
        }
        if items.len() == limit {
            next_after_sat = Some(sat);
            break;
        }
        items.push(frogger_dto(&record, record.location.outpoint()));
    }
    Ok(FroggersPageDto {
        total,
        offset,
        limit,
        next_after_sat,
        items,
    })
}

/// GET /v1/froggers?limit=&offset=&after_sat=&to_sat=
///
/// `after_sat` is the scalable path (BTreeMap range, O(limit)):
/// `?after_sat=<last sat from the previous page>`. `offset` is kept for
/// compatibility and is O(offset). `to_sat` bounds the window (inclusive)
/// so a wallet can ask "which frogs live in these sat ranges?" — the
/// receive-discovery path.
pub async fn list_froggers(
    State(state): State<SharedState>,
    Query(params): Query<PageParams>,
) -> Result<Json<FroggersPageDto>, ApiError> {
    let limit = parse_limit(params.limit)?;
    let offset = parse_offset(params.offset)?;
    let after_sat = params.after_sat.as_deref().map(parse_sat).transpose()?;
    let to_sat = params.to_sat.as_deref().map(parse_sat).transpose()?;
    #[cfg(feature = "redb")]
    if let Some(store) = state.durable_store_read() {
        return Ok(Json(froggers_page_from_store(
            &store, after_sat, to_sat, offset, limit,
        )?));
    }
    let idx = state.read();
    let total = idx.frog_count();
    // One extra row tells us whether a next page exists; its sat is the
    // exclusive cursor (same contract as the store path).
    let rows = idx.froggers_page(after_sat, offset, limit.saturating_add(1));
    let rows: Vec<_> = rows
        .into_iter()
        .take_while(|(sat, _)| to_sat.is_none_or(|to| *sat <= to))
        .collect();
    let next_after_sat = (rows.len() > limit)
        .then(|| rows.get(limit).map(|(sat, _)| *sat))
        .flatten();
    let items = rows
        .iter()
        .take(limit)
        .map(|(sat, record)| frogger_dto(record, idx.location(*sat)))
        .collect();
    Ok(Json(FroggersPageDto {
        total,
        offset,
        limit,
        next_after_sat,
        items,
    }))
}

/// GET /v1/frogger/{sat}
pub async fn get_frogger(
    State(state): State<SharedState>,
    Path(sat): Path<String>,
) -> Result<Json<FroggerDto>, ApiError> {
    let sat = parse_sat(&sat)?;
    #[cfg(feature = "redb")]
    if let Some(store) = state.durable_store_read() {
        use hopper_indexer::store::StateView;
        let record = store
            .frog(sat)
            .map_err(store_error)?
            .ok_or_else(|| ApiError::NotFound(format!("no frogger at sat {sat}")))?;
        return Ok(Json(frogger_dto(&record, record.location.outpoint())));
    }
    let idx = state.read();
    let record = idx
        .frogger(sat)
        .ok_or_else(|| ApiError::NotFound(format!("no frogger at sat {sat}")))?;
    Ok(Json(frogger_dto(&record, idx.location(sat))))
}

/// GET /v1/road — v3 crossings in flight, with the frozen target.
///
/// V3 crossings live in `FroggerRecord::in_flight`; the v2 `crossings`
/// table (and its phase/deadline model) no longer exists.
pub async fn road(State(state): State<SharedState>) -> Json<RoadDto> {
    let idx = state.read();
    let params = idx.config().params;
    let active = idx
        .in_flight()
        .iter()
        .map(|entry| {
            let (provisional_dead, outcome_block_hash) = idx
                .frogger(entry.sat)
                .map(|f| (f.provisional_dead, f.outcome_block_hash))
                .unwrap_or((None, None));
            in_flight_dto_with(entry, &params, provisional_dead, outcome_block_hash)
        })
        .collect();
    Json(RoadDto { active })
}

fn leaderboard_entry(rank: usize, r: &hopper_indexer::types::FroggerRecord) -> LeaderboardEntryDto {
    LeaderboardEntryDto {
        rank,
        sat: r.sat,
        name: r.name.clone(),
        seed: r.seed,
        dist: r.dist,
        state: match r.state {
            hopper_indexer::types::FroggerState::Idle => "idle",
            hopper_indexer::types::FroggerState::Crossing => "crossing",
            hopper_indexer::types::FroggerState::Home => "home",
            hopper_indexer::types::FroggerState::Dead => "dead",
            hopper_indexer::types::FroggerState::Burned => "burned",
            hopper_indexer::types::FroggerState::Retired => "retired",
        },
    }
}

/// Response for `/v1/state/root`.
#[derive(serde::Serialize)]
pub struct StateRootDto {
    height: Option<u32>,
    hash: Option<String>,
    root: String,
}

/// GET /v1/state/root — canonical state digest for cross-indexer checks.
///
/// O(state): a full ordered scan per request. Diagnostic, not hot-path.
/// Two indexers that agree on consensus must return the same `root` at the
/// same tip; a mismatch means the states differ (bug, corruption, or a
/// different config/version schedule).
pub async fn state_root(State(state): State<SharedState>) -> Result<Json<StateRootDto>, ApiError> {
    #[cfg(feature = "redb")]
    if let Some(store) = state.durable_store_read() {
        use hopper_indexer::store::StateView;
        let (height, hash) = store.tip().map_err(store_error)?;
        let root = hopper_indexer::store::state_root(&*store).map_err(store_error)?;
        return Ok(Json(StateRootDto {
            height,
            hash: hash.map(|h| crate::dto::hex_display(&h)),
            root: crate::dto::hex_bytes(&root),
        }));
    }
    let idx = state.read();
    Ok(Json(StateRootDto {
        height: idx.tip_height(),
        hash: idx.tip_hash().map(|h| crate::dto::hex_display(&h)),
        root: crate::dto::hex_bytes(&idx.state_root()),
    }))
}

/// GET /v1/leaderboard?limit= — top frogs by completed crossings.
pub async fn leaderboard(
    State(state): State<SharedState>,
    Query(params): Query<PageParams>,
) -> Result<Json<Vec<LeaderboardEntryDto>>, ApiError> {
    let limit = parse_limit(params.limit)?;
    // Order is materialised once per tip (P1.5); per-request work is
    // O(limit) instead of sorting every frog.
    #[cfg(feature = "redb")]
    if let Some(store) = state.durable_store_read() {
        if let Some(order) = state.leaderboard_order_from_store(&store) {
            use hopper_indexer::store::StateView;
            let mut items = Vec::with_capacity(limit.min(order.len()));
            for (i, sat) in order.iter().take(limit).enumerate() {
                match store.frog(*sat).map_err(store_error)? {
                    Some(record) => items.push(leaderboard_entry(i + 1, &record)),
                    None => continue,
                }
            }
            return Ok(Json(items));
        }
    }
    let idx = state.read();
    let order = state.leaderboard_order(&idx);
    let items = order
        .iter()
        .take(limit)
        .enumerate()
        .filter_map(|(i, sat)| Some(leaderboard_entry(i + 1, &idx.frogger(*sat)?)))
        .collect();
    Ok(Json(items))
}

/// GET /v1/events?limit= — tail of the re-derivable event log.
pub async fn events(
    State(state): State<SharedState>,
    Query(params): Query<PageParams>,
) -> Result<Json<Vec<crate::dto::EventDto>>, ApiError> {
    let limit = parse_limit(params.limit)?;
    // Durable segments first (they hold full history); the in-memory
    // tail is the fallback in tests / operator-only runs.
    if let Some(tail) = state.event_tail(limit) {
        return Ok(Json(tail.iter().map(event_dto).collect()));
    }
    let idx = state.read();
    let log = idx.event_log();
    let start = log.len().saturating_sub(limit);
    let items: Vec<_> = log[start..].iter().map(event_dto).collect();
    Ok(Json(items))
}

/// POST /v1/admin/block — ingest one confirmed block (hex-friendly wire
/// DTO; see `wire.rs`). Returns the report. Stopgap ingest until ZMQ (B4).
pub async fn ingest_block(
    State(state): State<SharedState>,
    Json(dto): Json<crate::wire::IngestBlock>,
) -> Result<Json<IngestReportDto>, ApiError> {
    let block = crate::wire::to_block(dto)?;
    let height = block.height;
    let report = {
        let mut idx = state.write();
        let before = idx.event_log().len();
        let report = state.commit_block(&mut idx, block)?;
        // Metrics + SSE push (B4 leftovers) — inside the write lock;
        // broadcast `send` is non-blocking so ingest never stalls.
        // (`publish_new_events` bumps the events counter.)
        state.metrics.blocks_applied.fetch_add(1, Ordering::Relaxed);
        state
            .metrics
            .rejections
            .fetch_add(report.rejections.len() as u64, Ordering::Relaxed);
        let mut published = before;
        crate::sse::publish_new_events(&state, &idx, &mut published);
        crate::sse::publish_tip(&state, &idx);
        // Persist this block's events, then bound the in-memory tail.
        state.append_events(&report.events);
        idx.trim_events(crate::EVENT_TAIL);
        if let Err(e) = state.snapshots().snapshot_if_due(&idx) {
            eprintln!("[snapshot] {e}");
        }
        report
    };
    let dto = IngestReportDto {
        applied: true,
        height,
        events: report.events.len(),
        rejections: report.rejections.iter().map(rejection_dto).collect(),
    };
    Ok(Json(dto))
}

#[derive(Deserialize)]
pub struct SeedParams {
    txid: String,
    vout: u32,
    /// Sat ranges as `[start, end)` pairs.
    ranges: Vec<(u64, u64)>,
}

/// POST /v1/admin/seed — bootstrap a UTXO with known sat ranges
/// (pre-activation history, or operator bootstrap for game week).
/// Survives rollbacks (delegated to the core's seed list).
pub async fn seed(
    State(state): State<SharedState>,
    Json(params): Json<SeedParams>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let txid = crate::wire::parse_hash(&params.txid)?;
    let outpoint = hopper_indexer::types::OutPoint {
        txid,
        vout: params.vout,
    };
    let ranges: Vec<hopper_core::satmath::SatRange> = params
        .ranges
        .into_iter()
        .map(|(start, end)| hopper_core::satmath::SatRange::new(start, end))
        .collect();
    let n = ranges.len();
    let mut idx = state.write();
    idx.seed_utxo(outpoint, ranges);
    // Seeds must survive a restart — force a snapshot.
    if let Err(e) = state.snapshots().force(&idx) {
        eprintln!("[snapshot] {e}");
    }
    Ok(Json(serde_json::json!({
        "seeded": outpoint_to_json(&outpoint),
        "ranges": n,
    })))
}

fn outpoint_to_json(op: &hopper_indexer::types::OutPoint) -> serde_json::Value {
    serde_json::json!({
        "txid": crate::dto::hex_display(&op.txid),
        "vout": op.vout,
    })
}

#[derive(Deserialize)]
pub struct RollbackParams {
    n: usize,
}

/// GET /v1/utxo/{txid}/{vout} — a tracked UTXO's value and ordinal sat
/// ranges. Wallet discovery data (SPEC §9.3): the wallet verifies the
/// UTXO's existence and spend-status itself via Electrum.
///
/// Sources, in order:
///
/// 1. the durable mirror, **only when it knows the coin** (a mirror that
///    lags the memory indexer must not answer "not tracked");
/// 2. the confirmed state machine;
/// 3. a read-only mempool overlay, so a frog received (or a change coin
///    created) between broadcast and confirmation is still attributable;
/// 4. the configured ord server, for a coin the indexer has never seen
///    (notably one descended from the unmodelled coinbase).
///
/// `exact` is false whenever any range is a shadow: a synthetic range
/// proves nothing about ownership, and the wallet must treat it as
/// unknown rather than "not ours". A shadow answer is kept as a fallback
/// while ord is consulted.
pub async fn get_utxo(
    State(state): State<SharedState>,
    Path((txid_hex, vout)): Path<(String, u32)>,
) -> Result<Json<UtxoDto>, ApiError> {
    let txid = crate::wire::parse_hash(&txid_hex)?;
    // A shadow coin is worth answering while ord is consulted: the wallet
    // gets the same value, but `exact: false` keeps it unspendable until
    // the real ranges arrive. Keep it as the fallback if ord is absent or
    // fails, rather than pretending the coin does not exist.
    let mut fallback: Option<UtxoDto> = None;

    #[cfg(feature = "redb")]
    if let Some(store) = state.durable_store_read() {
        use hopper_indexer::store::StateView;
        let outpoint = hopper_indexer::types::OutPoint { txid, vout };
        if let Some(entry) = store.coin(&outpoint).map_err(store_error)? {
            let exact = ranges_are_exact(&entry.ranges);
            let dto = UtxoDto {
                value: entry.value,
                ranges: entry.ranges.into_iter().map(|r| (r.start, r.end)).collect(),
                exact,
                frogs: entry.frogs.to_vec(),
            };
            if exact {
                return Ok(Json(dto));
            }
            fallback = Some(dto);
        }
        // Fall through: the mirror may simply be behind the memory
        // indexer (it is committed at checkpoints, not per route call).
    }
    {
        let idx = state.read();
        if let Some((value, ranges)) = idx.utxo_ranges(txid, vout) {
            let exact = ranges_are_exact(&ranges);
            let dto = UtxoDto {
                value,
                ranges: ranges.into_iter().map(|r| (r.start, r.end)).collect(),
                exact,
                frogs: idx.utxo_frogs(txid, vout),
            };
            if exact {
                return Ok(Json(dto));
            }
            if fallback.is_none() {
                fallback = Some(dto);
            }
        }
    }
    // Mempool overlay: the indexer is confirm-first, but a wallet must
    // not lose sight of a frog for the one block between broadcast and
    // confirmation. Read-only; nothing is applied to the state.
    if let Some(rpc) = state.rpc() {
        let idx = state.read();
        if let Some((value, ranges, exact)) = mempool_utxo_ranges(&idx, &rpc, txid, vout) {
            let dto = UtxoDto {
                value,
                ranges: ranges.into_iter().map(|r| (r.start, r.end)).collect(),
                exact,
                frogs: Vec::new(),
            };
            if exact {
                return Ok(Json(dto));
            }
            if fallback.is_none() {
                fallback = Some(dto);
            }
        }
    }
    // Lazy ord bootstrap. The wallet already asks about every UTXO it
    // owns; the first such question names the coin's sats, so the next
    // MINT's input ranges are in the tracker when the block arrives.
    if let Some(dto) = seed_from_ord(&state, txid, vout).await {
        return Ok(Json(dto));
    }
    if let Some(dto) = fallback {
        return Ok(Json(dto));
    }
    Err(ApiError::NotFound(
        "utxo not tracked by this indexer (not confirmed, not in the mempool, or unknown)".into(),
    ))
}

/// Ask the configured ord server about an outpoint and seed the indexer.
/// Returns the exact DTO on success; `None` leaves the caller's shadow
/// fallback (or its 404) intact.
async fn seed_from_ord(state: &SharedState, txid: [u8; 32], vout: u32) -> Option<UtxoDto> {
    let ord = state.ord()?.clone();
    let shown = format!("{}:{vout}", crate::dto::hex_display(&txid));
    // A newly mined output reaches bitcoind before ord's indexer sees it.
    // Retry briefly so the wallet's first question can return exact ranges
    // instead of caching a shadow answer until the next block.
    let mut found = None;
    for attempt in 0..3 {
        let client = ord.clone();
        let answer = tokio::task::spawn_blocking(move || client.output(txid, vout))
            .await
            .map_err(|e| format!("ord task: {e}"));
        match answer {
            Ok(Ok(Some(value))) => {
                found = Some(value);
                break;
            }
            Ok(Ok(None)) if attempt < 2 => {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            }
            Ok(Ok(None)) => {
                eprintln!("[ord] {shown}: not indexed (no sat ranges)");
                return None;
            }
            Ok(Err(e)) => {
                eprintln!("[ord] {shown}: {e}");
                return None;
            }
            Err(e) => {
                eprintln!("[ord] {shown}: {e}");
                return None;
            }
        }
    }
    let (value, ranges) = found?;
    if ranges.is_empty() {
        return None;
    }
    // Never replace a coin that already carries frog locations: the seed
    // path has no reverse index, and overwriting would drop them.
    if !state.read().utxo_frogs(txid, vout).is_empty() {
        eprintln!("[ord] {shown}: coin carries frogs; not overwriting its ranges");
        return None;
    }
    let dto = UtxoDto {
        value,
        ranges: ranges.iter().map(|r| (r.start, r.end)).collect(),
        exact: true,
        frogs: Vec::new(),
    };
    state.seed_utxo(hopper_indexer::types::OutPoint { txid, vout }, ranges);
    eprintln!("[ord] {shown}: seeded {} sat range(s)", dto.ranges.len());
    Some(dto)
}

/// True if every span is a real ordinal range (no shadow placeholder).
fn ranges_are_exact(ranges: &[hopper_core::satmath::SatRange]) -> bool {
    // Empty ranges are not "exactly no sats": a coin the tracker
    // created from an untracked input has no assignment yet. Treat it
    // like a shadow so ord gets a chance to name it.
    !ranges.is_empty() && !ranges.iter().any(|r| hopper_indexer::is_shadow(r.start))
}

/// Resolve an unconfirmed output from bitcoind's mempool.
///
/// The assignment needs every input's ranges: a confirmed coin comes
/// from the indexer, an unconfirmed ancestor is resolved recursively
/// (bounded depth) from the raw tx. **Any** unresolved or shadowed
/// ancestor makes the whole answer `None`/inexact — a guessed range is
/// worse than an honest "unknown", because the wallet would hide an
/// owned frog (FIX_CONSENSUS G4/B9).
fn mempool_utxo_ranges(
    idx: &crate::engine::Engine,
    rpc: &crate::rpc::BitcoinRpc,
    txid: [u8; 32],
    vout: u32,
) -> Option<(u64, Vec<hopper_core::satmath::SatRange>, bool)> {
    use bitcoin::consensus::Decodable;
    use bitcoin::hashes::Hash;
    use hopper_core::satmath::{assign, SatRange};

    fn resolve(
        idx: &crate::engine::Engine,
        rpc: &crate::rpc::BitcoinRpc,
        txid: [u8; 32],
        vout: u32,
        depth: u32,
        stack: &mut Vec<[u8; 32]>,
    ) -> Option<(u64, Vec<SatRange>, bool)> {
        // Mempool chains are shallow; a deep or cyclic graph is a
        // hostile input, not a coin we can name.
        if depth > 8 || stack.contains(&txid) {
            return None;
        }
        stack.push(txid);
        let mut display = txid;
        display.reverse();
        let hex: String = display.iter().map(|b| format!("{b:02x}")).collect();
        let raw = rpc.raw_tx_hex(&hex).ok()?;
        let bytes = crate::wire::hex_decode(&raw)?;
        let tx = bitcoin::Transaction::consensus_decode(&mut &bytes[..]).ok()?;
        let value = tx.output.get(vout as usize)?.value.to_sat();
        let mut input_ranges: Vec<SatRange> = Vec::new();
        let mut exact = true;
        for input in &tx.input {
            let prev = input.previous_output;
            let prev_txid = prev.txid.to_byte_array();
            let (ranges, input_exact) = if let Some((_v, ranges)) =
                idx.utxo_ranges(prev_txid, prev.vout)
            {
                let ex = ranges_are_exact(&ranges);
                (ranges, ex)
            } else {
                let (_, ranges, ex) = resolve(idx, rpc, prev_txid, prev.vout, depth + 1, stack)?;
                (ranges, ex)
            };
            if ranges.is_empty() {
                return None;
            }
            exact &= input_exact;
            input_ranges.extend_from_slice(&ranges);
        }
        let outputs: Vec<u64> = tx.output.iter().map(|o| o.value.to_sat()).collect();
        let assigned = assign(&input_ranges, &outputs);
        let ranges = assigned.get(vout as usize)?.clone();
        stack.pop();
        Some((value, ranges, exact))
    }

    resolve(idx, rpc, txid, vout, 0, &mut Vec::new())
}

/// GET /v1/params — the compiled protocol parameters (V3-FINAL-SPEC §3.7).
///
/// A client (including the browser wallet) computes [`params_hash`] from
/// its own copy and compares: a mismatch is fatal, never a negotiation.
/// Every number here is a constant in `hopper-core`; this endpoint just
/// publishes them.
pub async fn params(State(state): State<SharedState>) -> Json<serde_json::Value> {
    use hopper_core::params::{self, PROTOCOL};
    let p = &PROTOCOL;
    let h = &p.hops;
    let chain = state.chain_identity();
    let tip = {
        let idx = state.read();
        (idx.tip_height(), idx.tip_hash())
    };
    Json(serde_json::json!({
        // A wallet compares these before trusting a "not yours" answer:
        // the wrong chain makes every frog look sent away (A6).
        "network": chain.network,
        "genesis_hash": chain.genesis,
        // Coverage: this deployment always ingests from genesis (A2),
        // and the tip tells a wallet when its coin is past the frontier.
        "ingest_start_height": 0,
        "tip_height": tip.0,
        "tip_hash": tip.1.map(|h| {
            let mut b = h;
            b.reverse();
            b.iter().map(|x| format!("{x:02x}")).collect::<String>()
        }),
        "wire_version": hopper_core::VERSION,
        "cross_finality": p.cross_finality,
        "death_model": p.death.name(),
        "success_floor_bps": p.success_floor_bps,
        "hop_schedule": {
            "genesis": h.genesis,
            "base": h.base,
            "step1": h.step1,
            "until1": h.until1,
            "step2": h.step2,
            "until2": h.until2,
            "step3": h.step3,
            "ceiling": h.ceiling,
        },
        "anchors": [h.anchor1(), h.anchor2(), h.anchor3()],
        "card_value": p.card_value,
        "params_hash": crate::dto::hex_bytes(&params::params_hash(p)),
    }))
}

/// POST /v1/admin/rollback — truncate the chain by `n` blocks and replay.
pub async fn rollback(
    State(state): State<SharedState>,
    Json(params): Json<RollbackParams>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let mut idx = state.write();
    state.rollback_blocks(&mut idx, params.n)?;
    // Truncate the durable log to the new tip, then force a snapshot.
    state.truncate_events(idx.tip_height().unwrap_or(0));
    idx.trim_events(crate::EVENT_TAIL);
    if let Err(e) = state.snapshots().force(&idx) {
        eprintln!("[snapshot] {e}");
    }
    // Push subscribers only learn the new tip here: events below the
    // cut were re-derived, so tail consumers must re-fetch via REST
    // (`/v1/events`) rather than trust anything streamed before.
    crate::sse::publish_tip(&state, &idx);
    Ok(Json(serde_json::json!({
        "rolled_back": params.n,
        "tip_height": idx.tip_height(),
    })))
}

/// GET /healthz — liveness. Touches no state and takes no lock: if the
/// process can answer HTTP, it is alive (crashed ingest is a restart, not
/// a hung liveness probe).
pub async fn healthz() -> &'static str {
    "ok"
}

#[derive(Serialize)]
pub struct ReadyDto {
    pub ready: bool,
    pub tip_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// GET /readyz — readiness. Ready once the index has a tip and, when a
/// durable mirror is attached, the mirror agrees with the engine (a lagging
/// or rebuilt mirror would serve stale reads).
pub async fn readyz(State(state): State<SharedState>) -> axum::response::Response {
    let idx = state.read();
    let Some(tip) = idx.tip_height() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ReadyDto {
                ready: false,
                tip_height: None,
                reason: Some("no tip yet: waiting for the first block".into()),
            }),
        )
            .into_response();
    };
    #[cfg(feature = "redb")]
    if let Some(store) = state.durable_store_read() {
        use hopper_indexer::store::StateView;
        let reason = match store.tip() {
            Ok((Some(store_tip), _)) if store_tip == tip => None,
            Ok((store_tip, _)) => Some(format!(
                "durable mirror at {store_tip:?} lags the engine at {tip}"
            )),
            Err(e) => Some(format!("durable mirror unreadable: {e}")),
        };
        if let Some(reason) = reason {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(ReadyDto {
                    ready: false,
                    tip_height: Some(tip),
                    reason: Some(reason),
                }),
            )
                .into_response();
        }
    }
    (
        StatusCode::OK,
        Json(ReadyDto {
            ready: true,
            tip_height: Some(tip),
            reason: None,
        }),
    )
        .into_response()
}

/// GET /metrics — Prometheus text exposition format (B4 leftovers).
/// Counters are bumped by both ingest paths (admin block, ZMQ sync);
/// gauges snapshot the indexer under the read lock.
pub async fn metrics(State(state): State<SharedState>) -> impl axum::response::IntoResponse {
    let idx = state.read();
    #[cfg(feature = "redb")]
    let store_tip = state.durable_store_read().and_then(|store| {
        use hopper_indexer::store::StateView;
        store.tip().ok().map(|(height, _)| height)
    });
    #[cfg(not(feature = "redb"))]
    let store_tip: Option<Option<u32>> = None;
    let text = state.metrics.render(crate::metrics::Gauges {
        tip_height: idx.tip_height(),
        froggers: idx.frog_count(),
        active_crossings: idx.in_flight().len(),
        // Finished crossings no longer exist as a table; the settled
        // count lives per frog (`crossings_settled`).
        finished_crossings: 0,
        utxos: idx.utxo_count(),
        retained_blocks: idx.chain().len(),
        retained_from: idx.retained_from(),
        event_tail: idx.event_log().len(),
        snapshot_bytes: state.snapshots().bytes(),
        store_tip_height: store_tip.flatten(),
        store_tip_matches: store_tip.map(|height| height == idx.tip_height()),
    });
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )],
        text,
    )
}

/// GET /v1/mempool — preview of bitcoind's mempool: FRG envelopes and
/// tracked-UTXO spends per pending tx (B4 leftovers). A hint, not a
/// verdict: envelope validity is judged at confirm time against the
/// then-current chain.
pub async fn mempool(
    State(state): State<SharedState>,
) -> Result<Json<crate::mempool::MempoolPreviewDto>, ApiError> {
    let Some(rpc) = state.rpc() else {
        return Err(ApiError::Conflict(
            "mempool preview requires the bitcoind RPC (set HOPPER_RPC_COOKIE or \
             HOPPER_RPC_USER/HOPPER_RPC_PASS)"
                .into(),
        ));
    };
    // Blocking RPC + hex decode off the async executor, THEN take the
    // read lock — never hold the std lock across await.
    let raws = tokio::task::spawn_blocking(move || -> Result<Vec<(String, Vec<u8>)>, ApiError> {
        let txids = rpc
            .mempool_txids()
            .map_err(|e| ApiError::Conflict(format!("bitcoind: {e}")))?;
        let mut out = Vec::with_capacity(txids.len());
        for txid in txids {
            let hex = rpc
                .raw_tx_hex(&txid)
                .map_err(|e| ApiError::Conflict(format!("bitcoind: {e}")))?;
            let bytes = crate::wire::hex_decode(&hex)
                .filter(|b| !b.is_empty())
                .ok_or_else(|| ApiError::Conflict(format!("bitcoind: bad tx hex for {txid}")))?;
            out.push((txid, bytes));
        }
        Ok(out)
    })
    .await
    .map_err(|e| ApiError::Conflict(format!("mempool task: {e}")))??;
    state
        .metrics
        .mempool_previews
        .fetch_add(1, Ordering::Relaxed);
    let idx = state.read();
    let tip = idx.tip_height().unwrap_or(0);
    let confirm = tip.saturating_add(1);
    let config = idx.config().clone();
    let mut entries: Vec<crate::mempool::MempoolEntryDto> = raws
        .into_iter()
        .map(|(txid, raw)| {
            crate::mempool::preview_raw_tx(&txid, &raw, |t, v| idx.utxo_ranges(t, v).is_some())
        })
        .collect();
    // V3 §8.8: read a pending CROSS at `tip + 1` — a hint, never a
    // verdict, and never a mutation.
    for entry in &mut entries {
        let Some(body) = entry.inscriptions.iter().find_map(|i| i.cross.as_ref()) else {
            continue;
        };
        let frog = idx.frogger(body.sat);
        let rejection = if frog.is_none() {
            Some("unknown frog".to_string())
        } else {
            match frog.as_ref().map(|f| f.state) {
                Some(hopper_indexer::types::FroggerState::Idle) => None,
                Some(state) => Some(format!("frog is {}", crate::dto::state_str(state))),
                None => None,
            }
        };
        entry.cross = Some(crate::mempool::CrossPreviewDto {
            sat: body.sat,
            mint_txid: body.mint_txid.clone(),
            mint_index: body.mint_index,
            state: frog.as_ref().map(|f| crate::dto::state_str(f.state)),
            target_hops: config.params.hops.required(confirm),
            settle_height: confirm.saturating_add(config.params.cross_finality),
            provisional: true,
            rejection,
        });
    }
    Ok(Json(crate::mempool::MempoolPreviewDto { entries }))
}

/// Confirmation targets for `/v1/fees` (WALLET-UX-PLAN W2): a
/// conservative target for the suggested rate, and a slower economy
/// target as a best-effort second data point.
const FEE_TARGET_BLOCKS: u32 = 3;
const FEE_ECONOMY_TARGET_BLOCKS: u32 = 6;

/// GET /v1/fees — suggested feerates for wallet tx construction,
/// from bitcoind `estimatesmartfee` clamped to sane bounds
/// (WALLET-UX-PLAN W2). See [`crate::dto::FeesDto`] for the exact
/// cross-crate JSON contract. Never invents a feerate: without the
/// RPC, or on a bitcoind error, the endpoint answers 409
/// `{"error": ...}` — the `/v1/mempool` convention.
pub async fn fees(State(state): State<SharedState>) -> Result<Json<FeesDto>, ApiError> {
    let Some(rpc) = state.rpc() else {
        return Err(ApiError::Conflict(
            "fee suggestions require the bitcoind RPC (set HOPPER_RPC_COOKIE or \
             HOPPER_RPC_USER/HOPPER_RPC_PASS)"
                .into(),
        ));
    };
    // Blocking RPC off the async executor (the mempool pattern).
    let dto = tokio::task::spawn_blocking(move || -> Result<FeesDto, ApiError> {
        // The conservative estimate is mandatory: no data is an error,
        // never a made-up rate.
        let suggested_btc_kb = rpc
            .estimate_smart_fee(FEE_TARGET_BLOCKS)
            .map_err(|e| ApiError::Conflict(format!("bitcoind: {e}")))?
            .ok_or_else(|| {
                ApiError::Conflict(format!(
                    "bitcoind: no feerate estimate for {FEE_TARGET_BLOCKS} blocks yet"
                ))
            })?;
        // The economy estimate is best-effort: `null` in the response
        // when bitcoind has no slower data (or the call fails).
        let economy_btc_kb = rpc
            .estimate_smart_fee(FEE_ECONOMY_TARGET_BLOCKS)
            .ok()
            .flatten();
        Ok(fees_dto(
            suggested_btc_kb,
            economy_btc_kb,
            FEE_TARGET_BLOCKS,
        ))
    })
    .await
    .map_err(|e| ApiError::Conflict(format!("fees task: {e}")))??;
    state
        .metrics
        .fee_suggestions
        .fetch_add(1, Ordering::Relaxed);
    Ok(Json(dto))
}

#[cfg(test)]
mod tests {
    use super::*;
    use hopper_core::satmath::{SatRange, MAX_SAT};

    #[test]
    fn exact_rejects_shadow_ranges() {
        assert!(!ranges_are_exact(&[]));
        assert!(ranges_are_exact(&[SatRange::new(0, 100)]));
        assert!(ranges_are_exact(&[SatRange::new(MAX_SAT, MAX_SAT + 1)]));
        assert!(!ranges_are_exact(&[SatRange::new(
            SHADOW_START,
            SHADOW_START + 1
        )]));
        assert!(!ranges_are_exact(&[
            SatRange::new(0, 100),
            SatRange::new(SHADOW_START, SHADOW_START + 1)
        ]));
    }

    /// `hopper_indexer::SHADOW_BASE` — the synthetic ordinal base. A
    /// coin that touches it is not attributable, whatever else it has.
    const SHADOW_START: u64 = 1 << 60;
}
