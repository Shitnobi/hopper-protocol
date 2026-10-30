//! Integration tests for the v1 REST API, using `tower::ServiceExt::oneshot`
//! (no sockets). Fixtures mirror the indexer v3 suite: a real chain of
//! mint → arm → CROSS driven through the state machine, so every DTO is
//! checked against true v3 output.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use hopper_core::envelope::{encode_mint, envelope, Action};
use hopper_core::params::{ProtocolParams, NUMS_XONLY};
use hopper_core::satmath::SatRange;
use hopper_core::wrap::dies;
use hopper_core::{encode_parent_tag, StateBody};
use hopper_indexer::state_machine::{Indexer, IndexerConfig};
use hopper_indexer::types::{Block, InscriptionReveal, OutPoint, Tx, TxInput, TxOut};
use hopper_indexer_api::{app, ApiState};
use http_body_util::BodyExt;
use std::sync::Arc;
use tokio_stream::StreamExt as _;
use tower::ServiceExt;

// ----------------------------------------------------------------------
// Fixtures (same style as the indexer red-team suite)
// ----------------------------------------------------------------------

const SAT: u64 = 1_000;
const CARD: u64 = 25_000;
const MINT_TXID: u8 = 2;
const MINT_INDEX: u32 = 0;

fn b32(n: u8) -> [u8; 32] {
    [n; 32]
}

fn op(txid: u8, vout: u32) -> OutPoint {
    OutPoint {
        txid: b32(txid),
        vout,
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

fn input(txid: u8, vout: u32, value: u64) -> TxInput {
    TxInput {
        prevout: op(txid, vout),
        value,
        inscription: None,
    }
}

fn mint_tx(txid: u8) -> Tx {
    let payload = envelope(Action::Mint, &encode_mint(0xABCD, "Victim"));
    tx_of(
        txid,
        vec![input(1, 0, CARD)],
        vec![out(CARD), out_env(payload)],
    )
}

/// The v7 state leaf (four-leaf tree, 97-byte control block), as ingest
/// delivers it.
fn state_reveal(body: &StateBody) -> InscriptionReveal {
    let script = hopper_core::state_leaf_script(&[0x11; 32], body);
    let hashes = hopper_core::state_leaf_hashes(&[0x11; 32], body);
    let control = hopper_core::control_block(
        &NUMS_XONLY,
        &hopper_core::control_path(&hashes, body.dir),
        1,
    );
    InscriptionReveal {
        content_type: "application/octet-stream".into(),
        body_hash: [0u8; 32],
        inscription_id: format!("{}i0", "00".repeat(32)),
        body: Some(hopper_core::encode_state_body(body).to_vec()),
        parents: vec![encode_parent_tag(&body.mint_txid, body.mint_index)],
        tapscript: Some(script),
        control_block: Some(control),
    }
}

/// A v7 HOP: the frog spends itself (input 0) in direction `dir` and the
/// sat stays in output 0.
fn cross_tx(idx: &Indexer, txid: u8, dir: u8) -> Tx {
    let frog = idx.frogger(SAT).expect("frog");
    let frog_outpoint = match frog.location {
        hopper_indexer::types::SatLocation::Tracked(outpoint) => outpoint,
        hopper_indexer::types::SatLocation::Burned => panic!("frog burned"),
    };
    let body = StateBody {
        sat: SAT,
        mint_txid: b32(MINT_TXID),
        mint_index: MINT_INDEX,
        dir,
    };
    let mut frog_input = input(1, 0, CARD);
    frog_input.prevout = frog_outpoint;
    frog_input.inscription = Some(state_reveal(&body));
    tx_of(txid, vec![frog_input], vec![out(CARD - 1_000)])
}

fn seeded_config() -> IndexerConfig {
    IndexerConfig {
        params: ProtocolParams::fixture_fast(),
        ..Default::default()
    }
}

fn seeded_indexer() -> Indexer {
    let mut idx = Indexer::new(seeded_config());
    // Funding for the mint.
    idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + CARD)]);
    idx
}

// ----------------------------------------------------------------------
// Test harness
// ----------------------------------------------------------------------

fn router(idx: Indexer) -> Router {
    app(Arc::new(ApiState::new(idx)))
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    body: Option<serde_json::Value>,
) -> (StatusCode, Vec<u8>) {
    let request = match body {
        Some(json) => Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(json.to_string()))
            .unwrap(),
        None => Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::empty())
            .unwrap(),
    };
    let response = app.clone().oneshot(request).await.expect("oneshot");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("collect")
        .to_bytes()
        .to_vec();
    (status, bytes)
}

async fn get_json<T: serde::de::DeserializeOwned>(app: &Router, uri: &str) -> (StatusCode, T) {
    let (status, body) = call(app, "GET", uri, None).await;
    let value = serde_json::from_slice(&body).expect("valid json body");
    (status, value)
}

async fn post_json<T: serde::de::DeserializeOwned>(
    app: &Router,
    uri: &str,
    body: serde_json::Value,
) -> (StatusCode, T) {
    let (status, bytes) = call(app, "POST", uri, Some(body)).await;
    let value = serde_json::from_slice(&bytes).expect("valid json body");
    (status, value)
}

fn hex_display(bytes: &[u8; 32]) -> String {
    let mut rev = *bytes;
    rev.reverse();
    rev.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Indexer with one minted frog at height 100.
fn minted_router() -> Router {
    let mut idx = seeded_indexer();
    idx.apply_block(block_of(100, 1, vec![mint_tx(2)])).unwrap();
    router(idx)
}

/// Indexer with a v3 crossing in flight (CROSS at 101, settles at 107).
fn crossing_router() -> Router {
    let mut idx = seeded_indexer();
    idx.apply_block(block_of(100, 1, vec![mint_tx(2)])).unwrap();
    idx.apply_block(block_of(101, 10, vec![cross_tx(&idx, 3, 0)]))
        .unwrap();
    router(idx)
}

/// A byte constant whose block hash does not wrap the direction the
/// fixture hopped (the anchor block `B = T+1` decides the outcome).
fn alive_hash_byte(dir: u8) -> u8 {
    (0u8..=255)
        .find(|b| !dies(dir, &b32(*b)))
        .expect("some hash survives")
}

/// Indexer with one SURVIVED v3 crossing: CROSS at 101, alive anchor at
/// 102, settlement at 107 ⇒ `dist == 1`, state idle.
fn settled_router() -> Router {
    router(settled_router_idx())
}

fn settled_router_idx() -> Indexer {
    let mut idx = seeded_indexer();
    idx.apply_block(block_of(100, 1, vec![mint_tx(2)])).unwrap();
    idx.apply_block(block_of(101, 10, vec![cross_tx(&idx, 3, 0)]))
        .unwrap();
    let anchor = alive_hash_byte(0);
    idx.apply_block(block_of(102, anchor, vec![])).unwrap();
    for height in 103..=107 {
        idx.apply_block(block_of(height, 20 + height as u8, vec![]))
            .unwrap();
    }
    assert_eq!(idx.frogger(SAT).unwrap().dist, 1, "fixture must survive");
    idx
}

// ----------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------

#[tokio::test]
async fn status_reports_genesis_state() {
    let app = router(seeded_indexer());
    let (status, body): (_, serde_json::Value) = get_json(&app, "/v1/status").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["froggers"], 0);
    assert_eq!(body["active_crossings"], 0);
    assert_eq!(body["tip_height"], serde_json::Value::Null);
}

#[tokio::test]
async fn status_tip_hash_is_display_order() {
    let app = minted_router();
    let (_, body): (_, serde_json::Value) = get_json(&app, "/v1/status").await;
    assert_eq!(body["tip_height"], 100);
    assert_eq!(body["tip_hash"], serde_json::json!(hex_display(&b32(1))));
}

#[tokio::test]
async fn frogger_detail_round_trips_record() {
    let app = minted_router();
    let (status, body): (_, serde_json::Value) = get_json(&app, "/v1/frogger/1000").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["sat"], SAT);
    assert_eq!(body["seed"], 0xABCD);
    assert_eq!(body["name"], "Victim");
    assert_eq!(body["state"], "idle");
    assert_eq!(body["dist"], 0);
    assert_eq!(body["mint_txid"], hex_display(&b32(2)));
    // The mint's anchor-sat UTXO is (tx 2, vout 0).
    assert_eq!(body["location"]["txid"], hex_display(&b32(2)));
    assert_eq!(body["location"]["vout"], 0);
    // No crossing yet.
    assert!(body.get("in_flight").is_none());
    assert_eq!(body["crossings_settled"], 0);
}

#[tokio::test]
async fn frogger_detail_inscription_id_round_trips() {
    // Change B: an inscription-backed mint surfaces its ord id; a
    // legacy mint omits the field entirely (skip_serializing_if).
    let mut idx = seeded_indexer();
    let mut inp = input(1, 0, 100);
    inp.inscription = Some(InscriptionReveal {
        content_type: "image/png".to_string(),
        body_hash: [0x42; 32],
        inscription_id: format!("{}i0", hex_display(&b32(2))),
        body: None,
        parents: Vec::new(),
        tapscript: None,
        control_block: None,
    });
    let payload = envelope(Action::Mint, &encode_mint(0xABCD, "Artfrog"));
    let tx = tx_of(2, vec![inp], vec![out(CARD), out_env(payload)]);
    idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
    let app = router(idx);

    let (status, body): (_, serde_json::Value) = get_json(&app, "/v1/frogger/1000").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["inscription_id"],
        format!("{}i0", hex_display(&b32(2)))
    );

    // Legacy mint: the key is absent, not null.
    let app = minted_router();
    let (status, body): (_, serde_json::Value) = get_json(&app, "/v1/frogger/1000").await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.get("inscription_id").is_none());
}

#[tokio::test]
async fn unknown_frogger_is_404() {
    let app = minted_router();
    let (status, _) = call(&app, "GET", "/v1/frogger/999999", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn malformed_sat_is_400() {
    let app = minted_router();
    let (status, _) = call(&app, "GET", "/v1/frogger/notanumber", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn froggers_pagination_slices_by_sat() {
    let app = minted_router();
    let (status, body): (_, serde_json::Value) =
        get_json(&app, "/v1/froggers?limit=1&offset=0").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["total"], 1);
    assert_eq!(body["items"].as_array().unwrap().len(), 1);
    assert_eq!(body["items"][0]["sat"], SAT);

    // Offset past the end: empty page, not an error.
    let (status, body): (_, serde_json::Value) =
        get_json(&app, "/v1/froggers?limit=5&offset=10").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn froggers_keyset_pagination_uses_after_sat() {
    let app = minted_router();
    let (status, body): (_, serde_json::Value) =
        get_json(&app, "/v1/froggers?limit=1&after_sat=0").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"][0]["sat"], SAT);
    assert_eq!(body["next_after_sat"], serde_json::Value::Null);

    // The cursor is exclusive: starting at the last returned sat is empty.
    let (status, body): (_, serde_json::Value) =
        get_json(&app, &format!("/v1/froggers?limit=1&after_sat={SAT}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"].as_array().unwrap().len(), 0);
    assert_eq!(body["next_after_sat"], serde_json::Value::Null);
}

#[tokio::test]
async fn bad_pagination_is_400() {
    let app = minted_router();
    let (status, _) = call(&app, "GET", "/v1/froggers?limit=-1", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(&app, "GET", "/v1/froggers?after_sat=notanumber", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn road_shows_the_crossing_in_flight() {
    let app = crossing_router();
    let (status, body): (_, serde_json::Value) = get_json(&app, "/v1/road").await;
    assert_eq!(status, StatusCode::OK);
    let active = body["active"].as_array().unwrap();
    assert_eq!(active.len(), 1);
    let entry = &active[0];
    assert_eq!(entry["frogger_sat"], SAT);
    assert_eq!(entry["seed"], 0xABCD); // record enrichment works
    assert_eq!(entry["phase"]["name"], "crossing");
    // The anchor block B = T+1 decides the outcome...
    assert_eq!(entry["phase"]["deadline_height"], 102);
    // ...and settlement lands at T + cross_finality (6).
    assert_eq!(entry["phase"]["settle_height"], 107);
    assert_eq!(entry["target_hops"], 2);
}

#[tokio::test]
async fn road_is_empty_after_settlement() {
    let app = settled_router();
    let (_, body): (_, serde_json::Value) = get_json(&app, "/v1/road").await;
    assert!(body["active"].as_array().unwrap().is_empty());
    // ...and the settled hop shows up on the frog.
    let (_, frog): (_, serde_json::Value) = get_json(&app, "/v1/frogger/1000").await;
    assert_eq!(frog["dist"], 1);
    assert_eq!(frog["crossings_settled"], 1);
    assert_eq!(frog["state"], "idle");
}

#[tokio::test]
async fn ingest_endpoint_applies_blocks_and_reports_rejections() {
    let app = minted_router();
    // A hostile tx (two FRG envelopes) is rejected with a reason, never
    // fatal (SPEC §8.2.5 / §3).
    let p1 = envelope(Action::Mint, &encode_mint(1, "A"));
    let p2 = envelope(Action::Mint, &encode_mint(2, "B"));
    let junk_block = serde_json::json!({
        "hash": "09".repeat(32), "height": 101,
        "txs": [{
            "txid": "09".repeat(32),
            "inputs": [{"txid": "32".repeat(32), "vout": 0, "value": 700}],
            "outputs": [
                {"value": 700, "op_return": null},
                {"value": 0, "op_return": hex_encode(&p1)},
                {"value": 0, "op_return": hex_encode(&p2)}
            ]
        }]
    });
    let (status, body): (_, serde_json::Value) =
        post_json(&app, "/v1/admin/block", junk_block).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["applied"], true);
    assert_eq!(body["height"], 101);
    assert_eq!(body["rejections"].as_array().unwrap().len(), 1);

    // Status advanced.
    let (_, status_body): (_, serde_json::Value) = get_json(&app, "/v1/status").await;
    assert_eq!(status_body["tip_height"], 101);
}

#[tokio::test]
async fn non_contiguous_ingest_is_conflict() {
    let app = minted_router(); // tip 100
    let block = serde_json::json!({ "hash": "09".repeat(32), "height": 105, "txs": [] });
    let (status, _) = call(&app, "POST", "/v1/admin/block", Some(block)).await;
    assert_eq!(status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn ingest_rejects_malformed_hex() {
    let app = minted_router();
    let block = serde_json::json!({ "hash": "nothex", "height": 101, "txs": [] });
    let (status, _) = call(&app, "POST", "/v1/admin/block", Some(block)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let block = serde_json::json!({ "hash": "ab", "height": 101, "txs": [] });
    let (status, _) = call(&app, "POST", "/v1/admin/block", Some(block)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn events_tail_lists_newest_last() {
    let mut idx = settled_router_idx();
    idx.apply_block(block_of(108, 128, vec![])).unwrap();
    let app = router(idx);
    let (_, body): (_, serde_json::Value) = get_json(&app, "/v1/events?limit=10").await;
    let events = body.as_array().unwrap();
    let kinds: Vec<&str> = events
        .iter()
        .map(|e| e["action"]["kind"].as_str().unwrap())
        .collect();
    assert!(kinds.contains(&"mint"), "{kinds:?}");
    assert!(kinds.contains(&"settle"), "{kinds:?}");
    // Heights are non-decreasing (log order).
    let heights: Vec<u64> = events
        .iter()
        .map(|e| e["height"].as_u64().unwrap())
        .collect();
    let mut sorted = heights.clone();
    sorted.sort();
    assert_eq!(heights, sorted);
}

#[tokio::test]
async fn leaderboard_orders_by_dist_desc() {
    let app = settled_router();
    let (_, body): (_, serde_json::Value) = get_json(&app, "/v1/leaderboard").await;
    let board = body.as_array().unwrap();
    assert_eq!(board.len(), 1);
    assert_eq!(board[0]["rank"], 1);
    assert_eq!(board[0]["sat"], SAT);
    assert_eq!(board[0]["dist"], 1);
}

#[tokio::test]
async fn seed_endpoint_bootstraps_tracking() {
    // Fresh server, seeded via the API, then a mint arrives over the
    // hex wire: the whole curl-driven operator flow (B5 game week).
    let app = router(seeded_indexer());
    // (the fixture indexer is already seeded; verify the endpoint shape)
    let (status, body): (_, serde_json::Value) = post_json(
        &app,
        "/v1/admin/seed",
        serde_json::json!({
            "txid": "ee".repeat(32), "vout": 7,
            "ranges": [[5000, 5100]]
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ranges"], 1);
    assert_eq!(body["seeded"]["vout"], 7);

    // Bad hash → 400.
    let (status, _) = call(
        &app,
        "POST",
        "/v1/admin/seed",
        Some(serde_json::json!({ "txid": "xyz", "vout": 0, "ranges": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn rollback_endpoint_truncates_and_replays() {
    let app = crossing_router(); // tip 101, one crossing in flight
    let (status, body): (_, serde_json::Value) =
        post_json(&app, "/v1/admin/rollback", serde_json::json!({ "n": 1 })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["tip_height"], 100);

    // The CROSS is gone; the minted frog is idle again.
    let (_, road): (_, serde_json::Value) = get_json(&app, "/v1/road").await;
    assert!(road["active"].as_array().unwrap().is_empty());
    let (_, frog): (_, serde_json::Value) = get_json(&app, "/v1/frogger/1000").await;
    assert_eq!(frog["state"], "idle");
}

#[tokio::test]
async fn full_lifecycle_settles_and_is_reflected_everywhere() {
    let mut idx = seeded_indexer();
    idx.apply_block(block_of(100, 1, vec![mint_tx(2)])).unwrap();
    idx.apply_block(block_of(101, 10, vec![cross_tx(&idx, 3, 0)]))
        .unwrap();
    let anchor = alive_hash_byte(0);
    idx.apply_block(block_of(102, anchor, vec![])).unwrap();
    for height in 103..=107 {
        idx.apply_block(block_of(height, 20 + height as u8, vec![]))
            .unwrap();
    }
    let app = router(idx);

    // Road is empty again.
    let (_, road): (_, serde_json::Value) = get_json(&app, "/v1/road").await;
    assert_eq!(road["active"].as_array().unwrap().len(), 0);

    // The frog carries the settled hop.
    let (_, frog): (_, serde_json::Value) = get_json(&app, "/v1/frogger/1000").await;
    assert_eq!(frog["dist"], 1);
    assert_eq!(frog["crossings_settled"], 1);
    assert_eq!(frog["crossings_entered"], 1);
    assert_eq!(frog["state"], "idle");

    // The settle event is in the public log.
    let (_, events): (_, serde_json::Value) = get_json(&app, "/v1/events").await;
    let kinds: Vec<&str> = events
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["action"]["kind"].as_str().unwrap_or(""))
        .collect();
    assert!(kinds.contains(&"settle"), "events: {kinds:?}");
}

#[tokio::test]
async fn params_publish_coverage_and_chain_identity() {
    let app = minted_router();
    let (_, params): (_, serde_json::Value) = get_json(&app, "/v1/params").await;
    // Genesis-only ingest is a promise, not a config (A2).
    assert_eq!(params["ingest_start_height"], 0);
    assert!(params["tip_height"].is_number());
    // Absent when the deployment did not say: honest, never a guess.
    assert!(params.get("network").is_some());
}

#[tokio::test]
async fn utxo_endpoint_serves_ranges_and_car_commitment() {
    let app = minted_router();

    // The mint output 0 carries the seeded ranges.
    let txid_hex = hex_display(&b32(2));
    let (status, utxo): (_, serde_json::Value) =
        get_json(&app, &format!("/v1/utxo/{txid_hex}/0")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(utxo["value"], CARD);
    assert_eq!(utxo["ranges"].as_array().unwrap().len(), 1);
    assert_eq!(utxo["ranges"][0][0], SAT);
    assert_eq!(utxo["ranges"][0][1], SAT + CARD);
    // Ranges from a fully tracked coin are real assignments. A wallet
    // may only treat `exact: true` as ownership (FIX_CONSENSUS B9).
    assert_eq!(utxo["exact"], true);
    // v3 adoption hint: the coin carries the frog it was minted for.
    assert_eq!(utxo["frogs"], serde_json::json!([SAT]));

    // Unknown utxo → 404.
    let unknown = hex_display(&b32(0xEE));
    let (status, _) = call(&app, "GET", &format!("/v1/utxo/{unknown}/0"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Bad hex → 400.
    let (status, _) = call(&app, "GET", "/v1/utxo/zz/0", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // The road DTO gives the wallet the CROSS txid to fetch and verify
    // itself (SPEC §9.3).
    let app = crossing_router();
    let (_, road): (_, serde_json::Value) = get_json(&app, "/v1/road").await;
    let entry = &road["active"][0];
    assert_eq!(entry["cross_txid"], serde_json::json!(hex_display(&b32(3))));
    assert_eq!(entry["cross_height"], 101);
}

// ----------------------------------------------------------------------
// B4 leftovers: /metrics, /v1/events/stream (SSE), /v1/mempool
// ----------------------------------------------------------------------

/// Convert a core-`Block` fixture into the ingest DTO JSON (display
/// hex everywhere, like the Python feeder / live-regtest scripts).
fn block_json(height: u32, hash: u8, txs: Vec<Tx>) -> serde_json::Value {
    serde_json::json!({
        "hash": hex_display(&b32(hash)),
        "height": height,
        "txs": txs.iter().map(|tx| serde_json::json!({
            "txid": hex_display(&tx.txid),
            "inputs": tx.inputs.iter().map(|i| serde_json::json!({
                "txid": hex_display(&i.prevout.txid),
                "vout": i.prevout.vout,
                "value": i.value,
            })).collect::<Vec<_>>(),
            "outputs": tx.outputs.iter().map(|o| match &o.op_return {
                None => serde_json::json!({"value": o.value, "op_return": null}),
                Some(p) => serde_json::json!({"value": o.value, "op_return": hex_encode(p)}),
            }).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

#[tokio::test]
async fn metrics_endpoint_reports_counters_and_gauges() {
    let app = router(seeded_indexer());

    // Baseline: counters at zero, gauges derived from a tip-less indexer.
    let (status, body) = call(&app, "GET", "/metrics", None).await;
    assert_eq!(status, StatusCode::OK);
    let text = String::from_utf8(body).unwrap();
    assert!(text.contains("frogger_blocks_applied_total 0"));
    assert!(text.contains("frogger_tip_height -1"));
    assert!(text.contains("frogger_froggers 0"));

    // One minted frog at height 100.
    let (status, _) = call(
        &app,
        "POST",
        "/v1/admin/block",
        Some(block_json(100, 1, vec![mint_tx(2)])),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = call(&app, "GET", "/metrics", None).await;
    assert_eq!(status, StatusCode::OK);
    let text = String::from_utf8(body).unwrap();
    assert!(text.contains("frogger_blocks_applied_total 1"));
    assert!(text.contains("frogger_events_total 1"));
    assert!(text.contains("frogger_tip_height 100"));
    assert!(text.contains("frogger_froggers 1"));
}

#[tokio::test]
async fn metrics_endpoint_is_prometheus_text() {
    let app = router(seeded_indexer());
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/metrics")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let ct = resp
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(ct.starts_with("text/plain"), "content-type: {ct}");
    // Every metric line is `name value` — the exposition contract.
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    for line in std::str::from_utf8(&body).unwrap().lines() {
        if !line.is_empty() && !line.starts_with('#') {
            assert_eq!(line.split_whitespace().count(), 2, "bad line: {line}");
        }
    }
}

/// Read one SSE frame (up to the blank-line terminator) from a body
/// data stream.
async fn collect_frame<S, I, E>(stream: &mut S) -> String
where
    S: tokio_stream::Stream<Item = Result<I, E>> + Unpin,
    I: AsRef<[u8]>,
    E: std::fmt::Debug,
{
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        buf.push_str(&String::from_utf8_lossy(chunk.unwrap().as_ref()));
        if buf.contains("\n\n") {
            break;
        }
    }
    buf
}

#[tokio::test]
async fn sse_stream_pushes_tip_snapshot_then_live_events() {
    let app = router(seeded_indexer());

    // Open the stream.
    let resp = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/v1/events/stream")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let ct = resp
        .headers()
        .get("content-type")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(ct.starts_with("text/event-stream"), "content-type: {ct}");

    let mut stream = resp.into_body().into_data_stream();

    // First frame: the tip snapshot (no blocks yet).
    let first = collect_frame(&mut stream).await;
    assert!(first.contains("event: tip"), "frame: {first}");
    assert!(first.contains("\"height\":null"), "frame: {first}");

    // Ingest a mint block through the REST endpoint (same state).
    let (status, _) = call(
        &app,
        "POST",
        "/v1/admin/block",
        Some(block_json(100, 1, vec![mint_tx(2)])),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Live frames: the mint event, then the new tip.
    let mut seen_event = false;
    let mut seen_tip = false;
    for _ in 0..4 {
        let frame = collect_frame(&mut stream).await;
        if frame.contains("event: event") && frame.contains("\"kind\":\"mint\"") {
            seen_event = true;
        }
        if frame.contains("event: tip") && frame.contains("\"height\":100") {
            seen_tip = true;
        }
        if seen_event && seen_tip {
            break;
        }
    }
    assert!(seen_event, "no mint event frame was pushed");
    assert!(seen_tip, "no tip frame with height 100 was pushed");
}

#[tokio::test]
async fn mempool_requires_rpc_configuration() {
    // No RPC on the state (the operator/test setup) → clear error.
    let app = router(seeded_indexer());
    let (status, body) = call(&app, "GET", "/v1/mempool", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v["error"].as_str().unwrap().contains("RPC"));
}

// ----------------------------------------------------------------------
// WALLET-UX-PLAN W2: /v1/fees (bitcoind estimatesmartfee)
// ----------------------------------------------------------------------

use hopper_indexer_api::rpc::{BitcoinRpc, RpcAuth};

/// The `estimatesmartfee` confirmation target of a JSON-RPC request.
fn target_of(request: &serde_json::Value) -> u64 {
    request["params"][0].as_u64().unwrap_or(0)
}

/// A minimal fake bitcoind JSON-RPC server on a random localhost
/// port, one request per connection (how `BitcoinRpc`'s ureq client
/// behaves). `respond` maps each request to a `result` value or a
/// JSON-RPC error. The listener thread runs until the test process
/// exits.
fn spawn_fake_bitcoind(
    respond: impl Fn(&serde_json::Value) -> Result<serde_json::Value, (i64, String)>
        + Send
        + Sync
        + 'static,
) -> BitcoinRpc {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind fake bitcoind");
    let addr = listener.local_addr().expect("fake bitcoind addr");
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            // Read the request head byte-wise up to the blank line.
            let mut head = Vec::new();
            let mut byte = [0u8; 1];
            while !head.ends_with(b"\r\n\r\n") {
                if stream.read_exact(&mut byte).is_err() {
                    break;
                }
                head.push(byte[0]);
            }
            let head = String::from_utf8_lossy(&head);
            let len: usize = head
                .lines()
                .find(|l| l.to_ascii_lowercase().starts_with("content-length:"))
                .and_then(|l| l.rsplit(':').next())
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(0);
            let mut body = vec![0u8; len];
            if stream.read_exact(&mut body).is_err() {
                continue;
            }
            let request: serde_json::Value =
                serde_json::from_slice(&body).expect("json-rpc request body");
            let reply = match respond(&request) {
                Ok(result) => serde_json::json!({
                    "result": result, "error": null, "id": "hopper-indexer"
                }),
                Err((code, message)) => serde_json::json!({
                    "result": null, "error": {"code": code, "message": message},
                    "id": "hopper-indexer"
                }),
            };
            let payload = serde_json::to_vec(&reply).expect("serialize reply");
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            let _ = stream.write_all(&payload);
        }
    });
    BitcoinRpc::new(
        format!("http://{addr}"),
        RpcAuth::UserPass {
            user: "test".into(),
            pass: "test".into(),
        },
    )
}

/// A router whose state's bitcoind is the fake server.
fn fees_router(
    respond: impl Fn(&serde_json::Value) -> Result<serde_json::Value, (i64, String)>
        + Send
        + Sync
        + 'static,
) -> Router {
    let state = Arc::new(ApiState::new(seeded_indexer()));
    state.set_rpc(Arc::new(spawn_fake_bitcoind(respond)));
    app(state)
}

#[tokio::test]
async fn fees_requires_rpc_configuration() {
    // No RPC on the state → clear error, never a made-up feerate.
    let app = router(seeded_indexer());
    let (status, body) = call(&app, "GET", "/v1/fees", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v["error"].as_str().unwrap().contains("RPC"));
}

#[tokio::test]
async fn fees_suggests_converted_feerates() {
    // 0.00021 BTC/kB = 21 sat/vB (conservative, target 3);
    // 0.00002 BTC/kB = 2 sat/vB (economy, target 6).
    let app = fees_router(|req| match target_of(req) {
        3 => Ok(serde_json::json!({"feerate": 0.00021, "blocks": 3})),
        _ => Ok(serde_json::json!({"feerate": 0.00002, "blocks": 6})),
    });
    let (status, v): (_, serde_json::Value) = get_json(&app, "/v1/fees").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["suggested_sat_vb"], serde_json::json!(21));
    assert_eq!(v["economy_sat_vb"], serde_json::json!(2));
    assert_eq!(v["target_blocks"], serde_json::json!(3));
    assert_eq!(
        v["source"],
        serde_json::json!("bitcoind-estimatesmartfee:3")
    );
    assert_eq!(v["clamped"], serde_json::json!(false));
}

#[tokio::test]
async fn fees_clamps_absurd_node_answers() {
    // A broken node suggesting 0.05 BTC/kB (5000 sat/vB) and a
    // near-zero economy rate: both clamped into [1, 1000] sat/vB.
    let app = fees_router(|req| match target_of(req) {
        3 => Ok(serde_json::json!({"feerate": 0.05, "blocks": 3})),
        _ => Ok(serde_json::json!({"feerate": 0.00000001, "blocks": 6})),
    });
    let (status, v): (_, serde_json::Value) = get_json(&app, "/v1/fees").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["suggested_sat_vb"], serde_json::json!(1000));
    assert_eq!(v["economy_sat_vb"], serde_json::json!(1));
    assert_eq!(v["clamped"], serde_json::json!(true));
}

#[tokio::test]
async fn fees_economy_null_when_no_slower_estimate() {
    // Target 3 has data; target 6 errors ("Insufficient data", the
    // classic bitcoind answer) → economy_sat_vb is null, the
    // suggestion is still served.
    let app = fees_router(|req| match target_of(req) {
        3 => Ok(serde_json::json!({"feerate": 0.00002, "blocks": 3})),
        _ => Err((-1, "Insufficient data or no feerate found".into())),
    });
    let (status, v): (_, serde_json::Value) = get_json(&app, "/v1/fees").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["suggested_sat_vb"], serde_json::json!(2));
    assert_eq!(v["economy_sat_vb"], serde_json::json!(null));
    assert_eq!(v["clamped"], serde_json::json!(false));
}

#[tokio::test]
async fn fees_never_invents_a_feerate_on_bitcoind_error() {
    // JSON-RPC error for the conservative target → 409 with an error
    // field, no feerate in the body.
    let app = fees_router(|_req| Err((-32603, "Internal error".into())));
    let (status, body) = call(&app, "GET", "/v1/fees", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v["error"].as_str().unwrap().contains("bitcoind"));
    assert!(v.get("suggested_sat_vb").is_none());
}

#[tokio::test]
async fn fees_never_invents_a_feerate_without_estimate_data() {
    // bitcoind's "no data" shape: a result with no feerate field →
    // 409 with an explicit error, not a defaulted rate.
    let app = fees_router(|_req| Ok(serde_json::json!({"blocks": 3})));
    let (status, body) = call(&app, "GET", "/v1/fees", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(v["error"].as_str().unwrap().contains("no feerate estimate"));
}

// ----------------------------------------------------------------------
// Durable mirror read-through (P2.5a)
// ----------------------------------------------------------------------

/// The mirror and the engine must answer reads identically: same status,
/// same bytes, for point lookups, both pagination modes, the road, finished
/// crossings and UTXO discovery — while a crossing is active and after it
/// settles.
#[cfg(feature = "redb")]
#[tokio::test]
async fn healthz_is_always_live_and_readyz_waits_for_a_tip() {
    let state = Arc::new(ApiState::new(seeded_indexer()));
    let app = app(state.clone());

    let (code, body) = call(&app, "GET", "/healthz", None).await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(String::from_utf8_lossy(&body), "ok");

    // No tip yet: live but not ready.
    let (code, body) = call(&app, "GET", "/readyz", None).await;
    assert_eq!(code, StatusCode::SERVICE_UNAVAILABLE);
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["ready"], false);
    assert_eq!(json["tip_height"], serde_json::Value::Null);

    state
        .write()
        .apply_block(block_of(100, 1, vec![mint_tx(2)]))
        .unwrap();
    let (code, body) = call(&app, "GET", "/readyz", None).await;
    assert_eq!(code, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["ready"], true);
    assert_eq!(json["tip_height"], 100);
}

#[cfg(feature = "redb")]
#[tokio::test]
async fn readyz_checks_the_durable_mirror_and_metrics_expose_it() {
    let dir = std::env::temp_dir().join(format!("frogger-ready-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let mut state = ApiState::new(seeded_indexer());
    state
        .attach_durable(
            hopper_indexer::store::redb_store::RedbStore::create(&dir.join("ready.redb")).unwrap(),
        )
        .unwrap();
    let state = Arc::new(state);
    let app = app(state.clone());

    // Ingest through the API path so the engine and the mirror advance
    // together; the mirror must not lag the engine when we are ready.
    {
        let mut idx = state.write();
        state
            .commit_block(&mut idx, block_of(100, 1, vec![mint_tx(2)]))
            .unwrap();
    }

    let (code, body) = call(&app, "GET", "/readyz", None).await;
    assert_eq!(code, StatusCode::OK, "{}", String::from_utf8_lossy(&body));

    let (code, body) = call(&app, "GET", "/metrics", None).await;
    assert_eq!(code, StatusCode::OK);
    let text = String::from_utf8_lossy(&body).to_string();
    assert!(text.contains("frogger_store_attached 1"), "{text}");
    assert!(text.contains("frogger_store_tip_height 100"), "{text}");
    assert!(text.contains("frogger_store_tip_matches 1"), "{text}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(feature = "redb")]
#[tokio::test]
async fn store_engine_serves_identical_reads_and_survives_a_restart() {
    use hopper_indexer::store::redb_store::RedbStore;

    let dir = std::env::temp_dir().join(format!("frogger-api-store-engine-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("engine.redb");

    // Memory oracle, same seeds.
    let mem = Arc::new(ApiState::new(seeded_indexer()));

    // Store-backed engine over the same seed set.
    let store = Arc::new(RedbStore::create(&path).unwrap());
    let mut api = ApiState::new(seeded_indexer());
    {
        let seeds: Vec<_> = api
            .read()
            .seeds()
            .iter()
            .map(|(outpoint, ranges)| (*outpoint, ranges.clone()))
            .collect();
        api.attach_store_engine(Arc::clone(&store), seeded_config(), seeds)
            .unwrap();
    }
    assert!(api.read().is_store());
    let store_state = Arc::new(api);

    let mem_app = app(mem.clone());
    let store_app = app(store_state.clone());

    let uris = [
        "/v1/froggers",
        "/v1/froggers?limit=1",
        "/v1/froggers?limit=1&offset=1",
        "/v1/froggers?limit=1&after_sat=0",
        "/v1/froggers?limit=1&after_sat=1000",
        "/v1/frogger/1000",
        "/v1/frogger/1234",
        "/v1/leaderboard",
        "/v1/leaderboard?limit=1",
        "/v1/state/root",
        "/v1/road",
        "/v1/utxo/0303030303030303030303030303030303030303030303030303030303030303/0",
        "/v1/utxo/0202020202020202020202020202020202020202020202020202020202020202/0",
        "/v1/status",
        "/v1/events",
    ];

    let blocks = {
        let mint = block_of(100, 1, vec![mint_tx(2)]);
        let cross = {
            let mut probe = seeded_indexer();
            probe.apply_block(mint.clone()).unwrap();
            cross_tx(&probe, 3, 0)
        };
        let cross_block = block_of(101, 10, vec![cross]);
        // The capture block (T+1) and the rest of the finality window.
        let mut blocks = vec![mint, cross_block];
        for height in 102..=107u32 {
            blocks.push(block_of(height, 11 + height as u8, vec![]));
        }
        blocks
    };
    for block in blocks {
        let height = block.height;
        mem.write().apply_block(block.clone()).unwrap();
        {
            let mut idx = store_state.write();
            store_state.commit_block(&mut idx, block).unwrap();
        }
        for uri in uris {
            let (want_status, want) = call(&mem_app, "GET", uri, None).await;
            let (got_status, got) = call(&store_app, "GET", uri, None).await;
            assert_eq!(got_status, want_status, "height {height}: {uri}");
            assert_eq!(got, want, "height {height}: {uri} differs");
        }
    }
    let root = {
        let (_, body): (_, serde_json::Value) = get_json(&store_app, "/v1/state/root").await;
        body["root"].as_str().unwrap().to_string()
    };
    let memory_root = {
        let (_, body): (_, serde_json::Value) = get_json(&mem_app, "/v1/state/root").await;
        body["root"].as_str().unwrap().to_string()
    };
    assert_eq!(root, memory_root);
    drop(store_app);
    drop(store_state);

    // Restart: the file *is* the state. Copy it (the backup path) and open
    // the copy as a fresh store-backed engine — no replay, no snapshot —
    // then serve the same root. (redb holds an exclusive lock per file, so
    // a same-process reopen of the original is not possible; the copy is
    // byte-identical and exercises exactly the restart reader.)
    let backup = dir.join("restart.redb");
    store.copy_to(&backup).unwrap();
    let reopened = Arc::new(RedbStore::create(&backup).unwrap());
    let mut restarted = ApiState::new(seeded_indexer());
    restarted
        .attach_store_engine(reopened, seeded_config(), Vec::new())
        .unwrap();
    {
        let idx = restarted.read();
        assert_eq!(idx.tip_height(), Some(107));
        assert_eq!(idx.frog_count(), 1);
    }
    let restarted_app = app(Arc::new(restarted));
    let (code, body): (_, serde_json::Value) = get_json(&restarted_app, "/v1/state/root").await;
    assert_eq!(code, StatusCode::OK);
    assert_eq!(body["root"].as_str().unwrap(), root);

    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(feature = "redb")]
#[tokio::test]
async fn durable_mirror_serves_identical_reads() {
    use hopper_indexer::store::redb_store::RedbStore;

    let dir = std::env::temp_dir().join(format!("frogger-api-reads-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    let mut durable = ApiState::new(seeded_indexer());
    durable
        .attach_durable(RedbStore::create(&dir.join("reads.redb")).unwrap())
        .unwrap();
    let mem = Arc::new(ApiState::new(seeded_indexer()));
    let dur = Arc::new(durable);
    let mem_app = app(mem.clone());
    let dur_app = app(dur.clone());

    let uris = [
        "/v1/froggers",
        "/v1/froggers?limit=1",
        "/v1/froggers?limit=1&offset=1",
        "/v1/froggers?limit=1&after_sat=0",
        "/v1/froggers?limit=1&after_sat=1000",
        "/v1/frogger/1000",
        "/v1/frogger/1234",
        "/v1/frogger/1000/crossings",
        "/v1/leaderboard",
        "/v1/leaderboard?limit=1",
        "/v1/state/root",
        "/v1/road",
        "/v1/utxo/0303030303030303030303030303030303030303030303030303030303030303/0",
        // Spent by the CROSS: the mirror must drop it exactly like the engine.
        "/v1/utxo/0202020202020202020202020202020202020202020202020202020202020202/0",
    ];

    // Mint, then CROSS: the road has one active crossing.
    let mint = block_of(100, 1, vec![mint_tx(2)]);
    mem.write().apply_block(mint.clone()).unwrap();
    {
        let mut idx = dur.write();
        dur.commit_block(&mut idx, mint).unwrap();
    }
    let cross = {
        let idx = mem.read();
        cross_tx(idx.as_memory().expect("memory engine"), 3, 0)
    };
    let cross_block = block_of(101, 10, vec![cross]);
    mem.write().apply_block(cross_block.clone()).unwrap();
    {
        let mut idx = dur.write();
        dur.commit_block(&mut idx, cross_block).unwrap();
    }
    for uri in uris {
        let (want_status, want) = call(&mem_app, "GET", uri, None).await;
        let (got_status, got) = call(&dur_app, "GET", uri, None).await;
        assert_eq!(got_status, want_status, "mid-crossing {uri}");
        assert_eq!(got, want, "durable read differs for {uri}");
    }

    // Finish the crossing: the capture block plus the finality window.
    for height in 102..=107u32 {
        let block = block_of(height, 11 + height as u8, vec![]);
        mem.write().apply_block(block.clone()).unwrap();
        let mut idx = dur.write();
        dur.commit_block(&mut idx, block).unwrap();
    }
    for uri in uris {
        let (want_status, want) = call(&mem_app, "GET", uri, None).await;
        let (got_status, got) = call(&dur_app, "GET", uri, None).await;
        assert_eq!(got_status, want_status, "settled {uri}");
        assert_eq!(got, want, "durable read differs for {uri}");
    }
    let (_, road): (_, serde_json::Value) = get_json(&dur_app, "/v1/road").await;
    assert_eq!(road["active"].as_array().unwrap().len(), 0);
    let (_, frog): (_, serde_json::Value) = get_json(&dur_app, "/v1/frogger/1000").await;
    assert_eq!(frog["crossings_entered"], 1);
    assert_ne!(frog["state"], "crossing");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn params_endpoint_publishes_the_schedule_and_hash() {
    let app = router(seeded_indexer());
    let (status, body): (_, serde_json::Value) = get_json(&app, "/v1/params").await;
    assert_eq!(status, StatusCode::OK);
    let p = &hopper_core::params::PROTOCOL;
    assert_eq!(body["wire_version"], 7);
    assert_eq!(body["cross_finality"], p.cross_finality);
    assert_eq!(body["generations"]["base"], 5);
    assert_eq!(body["generations"]["ceiling"], 100);
    assert_eq!(body["generations"]["growth_interval"], 144);
    assert_eq!(body["generations"]["hold"], 14_400);
    assert_eq!(body["generations"]["generation_len"], 28_080);
    let want: String = hopper_core::params::params_hash(p)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(body["params_hash"], want);
}

#[tokio::test]
async fn generation_endpoint_publishes_the_sawtooth() {
    let app = router(seeded_indexer());
    let p = &hopper_core::params::PROTOCOL;
    let g = &p.generations;
    let h = g.genesis + 95 * 144 + 7;
    let (status, body): (_, serde_json::Value) =
        get_json(&app, &format!("/v1/generation/{h}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["generation"], 1);
    assert_eq!(body["start"], g.genesis);
    assert_eq!(body["required"], 100, "held at the ceiling");
    assert_eq!(body["next_change"]["height"], g.genesis + g.generation_len);
    assert_eq!(body["next_change"]["required"], 5, "the reset is a change");

    // The generation that starts after the reset is numbered 2.
    let h2 = g.genesis + g.generation_len;
    let (_, body2): (_, serde_json::Value) =
        get_json(&app, &format!("/v1/generation/{h2}")).await;
    assert_eq!(body2["generation"], 2);
    assert_eq!(body2["required"], 5);
}

#[tokio::test]
async fn wrap_endpoint_is_404_until_the_height_is_ingested() {
    let mut idx = seeded_indexer();
    idx.apply_block(block_of(100, 1, vec![mint_tx(2)])).unwrap();
    let app = router(idx);
    let (missing, _): (_, serde_json::Value) = get_json(&app, "/v1/wrap/999").await;
    assert_eq!(missing, StatusCode::NOT_FOUND);

    let (status, body): (_, serde_json::Value) = get_json(&app, "/v1/wrap/100").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["height"], 100);
    assert_eq!(body["wrap"], hopper_core::wrap::wrap(&b32(1)));
    let mut display = b32(1);
    display.reverse();
    assert_eq!(body["hash"], serde_json::json!(hex_display(&b32(1))));
}

#[tokio::test]
async fn frogger_and_road_expose_generation_direction_and_wrap() {
    let app = crossing_router();
    let (_, frog): (_, serde_json::Value) = get_json(&app, "/v1/frogger/1000").await;
    assert_eq!(frog["gen"], 26, "fixture generation at height 100");
    assert_eq!(frog["in_flight"]["dir"], 0);
    assert_eq!(frog["in_flight"]["target_hops"], 2);

    let (_, road): (_, serde_json::Value) = get_json(&app, "/v1/road").await;
    assert_eq!(road["active"][0]["dir"], 0);
    assert_eq!(road["active"][0]["target_hops"], 2);

    // Once T+1 lands, both the frog and the road publish the block's wrap.
    let mut idx = seeded_indexer();
    idx.apply_block(block_of(100, 1, vec![mint_tx(2)])).unwrap();
    idx.apply_block(block_of(101, 10, vec![cross_tx(&idx, 3, 0)]))
        .unwrap();
    idx.apply_block(block_of(102, 3, vec![])).unwrap();
    let app = router(idx);
    let (_, frog): (_, serde_json::Value) = get_json(&app, "/v1/frogger/1000").await;
    let (_, road): (_, serde_json::Value) = get_json(&app, "/v1/road").await;
    let want = hopper_core::wrap::wrap(&b32(3));
    assert_eq!(frog["outcome_wrap"], want);
    assert_eq!(frog["provisional_dead"], want == 0);
    assert_eq!(road["active"][0]["outcome_wrap"], want);
}

#[tokio::test]
async fn admin_routes_require_the_bearer_token_when_configured() {
    let state = Arc::new(ApiState::new(seeded_indexer()).with_admin_token("s3cret"));
    let app = app(state);

    // No token → 401 on every admin route.
    for uri in ["/v1/admin/block", "/v1/admin/seed", "/v1/admin/rollback"] {
        let (status, _) = call(&app, "POST", uri, Some(serde_json::json!({}))).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
    }
    // A wrong token → 401, not 403 (do not confirm the value).
    let request = Request::builder()
        .method("POST")
        .uri("/v1/admin/rollback")
        .header("content-type", "application/json")
        .header("authorization", "Bearer wrong")
        .body(Body::from(r#"{"n":0}"#))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // The right token reaches the handler (404-style body errors aside).
    let request = Request::builder()
        .method("POST")
        .uri("/v1/admin/rollback")
        .header("content-type", "application/json")
        .header("authorization", "Bearer s3cret")
        .body(Body::from(r#"{"n":0}"#))
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_ne!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn serve_refuses_a_public_bind_without_an_admin_token() {
    let state = Arc::new(ApiState::new(seeded_indexer()));
    let addr: std::net::SocketAddr = "0.0.0.0:0".parse().unwrap();
    let err = hopper_indexer_api::serve(state, addr)
        .await
        .expect_err("public bind without a token must be refused");
    assert!(err.to_string().contains("HOPPER_ADMIN_TOKEN"), "{err}");
}
