//! JSON DTOs — the public API contract, decoupled from internal types.
//!
//! Conventions:
//! - txids/hashes: hex in **display order** (internal byte order
//!   reversed), matching every Bitcoin explorer.
//! - `sat`: the frogger ID as a decimal integer (ordinal number).
//! - Phase deadlines are absolute heights (inclusive last valid block).

use hopper_indexer::types::{ChainEvent, EventAction, FroggerRecord, FroggerState, SettleOutcome};

/// Hex-encode a 32-byte hash in display order (reversed).
pub fn hex_display(bytes: &[u8; 32]) -> String {
    let mut rev = *bytes;
    rev.reverse();
    rev.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hex-encode a digest in its natural (big-endian) order.
///
/// Block hashes and txids use [`hex_display`] (Bitcoin's reversed
/// convention); a state root is a plain SHA-256 digest, and printing it
/// reversed would disagree with `state_root()`, `store_backup` and every
/// byte-level log line.
pub fn hex_bytes(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Hex-encode a 16-byte nonce.
pub fn hex16(bytes: &[u8; 16]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn state_str(state: FroggerState) -> &'static str {
    match state {
        FroggerState::Idle => "idle",
        FroggerState::Crossing => "crossing",
        FroggerState::Home => "home",
        FroggerState::Dead => "dead",
        FroggerState::Burned => "burned",
        FroggerState::Retired => "retired",
    }
}

fn outcome_str(outcome: SettleOutcome) -> &'static str {
    match outcome {
        SettleOutcome::Dead => "dead",
        SettleOutcome::Crossed => "crossed",
    }
}

/// `GET /v1/status`.
#[derive(Debug, serde::Serialize)]
pub struct StatusDto {
    pub tip_height: Option<u32>,
    pub tip_hash: Option<String>,
    pub finality_depth: u32,
    pub froggers: usize,
    pub active_crossings: usize,
    /// The only wire version this deployment speaks.
    pub wire_version: u8,
}

/// `GET /v1/froggers` item and `GET /v1/frogger/{sat}` base.
#[derive(Debug, serde::Serialize)]
pub struct FroggerDto {
    pub sat: u64,
    pub seed: u32,
    pub name: String,
    pub state: &'static str,
    /// Completed crossings — the "×N" number (plan §5).
    pub dist: u32,
    pub crossings_entered: u32,
    pub mint_height: u32,
    pub mint_txid: String,
    /// Output index of the mint transaction that carried the sat. A
    /// wallet that did not mint this frog needs it to anchor its local
    /// history walk at the mint outpoint (receive discovery).
    pub mint_index: u32,
    /// Ord inscription id of the mint reveal (Change B); `None` for
    /// legacy single-tx mints.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inscription_id: Option<String>,
    /// Where the anchor sat currently lives (None = burned/untracked).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<LocationDto>,
    /// Mint wire version: 3 = legacy (transfer-only, `retired`), 4 = v3.
    pub wire_version: u8,
    /// Resolved crossings (`dist` counts survived hops only) — v3.
    pub crossings_settled: u32,
    /// Deaths (0 or 1).
    pub deaths: u32,
    /// The crossing in flight, with the hop requirement frozen at `T`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_flight: Option<InFlightDto>,
    /// Hop requirement frozen at the last crossing's `T` (V3 §3.4).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_hops: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub immortal_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub death_height: Option<u32>,
    /// Block whose sat flow burned the anchor sat (state `burned`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub burn_height: Option<u32>,
    /// Transaction that burned the anchor sat.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub burn_txid: Option<String>,
    /// `H(T+1)` for the crossing in flight, in display order. Sealed at
    /// T+1; the wallet can show the decree before finality.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome_block_hash: Option<String>,
    /// The sealed verdict while the crossing is still provisional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provisional_dead: Option<bool>,
}

/// A crossing in flight (V3 §8.1): settles at `height + 6`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct InFlightDto {
    pub txid: String,
    /// `T`, the CROSS's block height.
    pub height: u32,
    /// `required_hops(T)`, frozen.
    pub target_hops: u32,
    /// `T + 6`.
    pub settle_height: u32,
}

#[derive(Debug, serde::Serialize)]
pub struct LocationDto {
    pub txid: String,
    pub vout: u32,
}

/// `GET /v1/froggers` page.
#[derive(Debug, serde::Serialize)]
pub struct FroggersPageDto {
    pub total: usize,
    pub offset: usize,
    pub limit: usize,
    /// Keyset cursor for the next page: the first sat NOT included here.
    /// `None` on the last page. New clients should pass `after_sat`;
    /// `offset` is retained for compatibility.
    pub next_after_sat: Option<u64>,
    pub items: Vec<FroggerDto>,
}

/// One crossing — used by `/road` and the frogger detail.
#[derive(Debug, serde::Serialize)]
pub struct CrossingDto {
    pub frogger_sat: u64,
    pub h_f: String,
    pub cross_height: u32,
    pub cross_txid: String,
    /// The winning CAR's txid and commitment, once confirmed — wallet
    /// discovery data (the wallet then fetches + merkle-verifies the tx
    /// itself, SPEC §9.3).
    pub car_txid: Option<String>,
    pub h_c: Option<String>,
    pub phase: PhaseDto,
    pub frog_revealed: bool,
    pub car_revealed: bool,
    /// The frog's seed/name for direct rendering (road screen).
    pub seed: u32,
    pub name: String,
    pub dist: u32,
    /// V3 only: the target frozen at the crossing height (§3.4).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_hops: Option<u32>,
    /// `H(T+1)`, sealed one block after the crossing, in display order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome_block_hash: Option<String>,
    /// The sealed verdict while the crossing is still provisional, so the
    /// road can show it before finality.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provisional_dead: Option<bool>,
}

/// Phase snapshot with the actionable deadline (absolute height).
#[derive(Debug, serde::Serialize)]
pub struct PhaseDto {
    /// `car_window` | `anchor` | `reveal_window` | `settled`.
    pub name: &'static str,
    /// Winning CAR's confirmation height `U`, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub car_height: Option<u32>,
    /// Anchor block `B = U+1` height, if mined.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_height: Option<u32>,
    /// Inclusive last height of the current window (None once settled).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline_height: Option<u32>,
    /// Settlement outcome, once settled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<&'static str>,
    pub settle_height: Option<u32>,
}

/// `GET /v1/road` — active crossings only.
#[derive(Debug, serde::Serialize)]
pub struct RoadDto {
    pub active: Vec<CrossingDto>,
}

/// `GET /v1/leaderboard` item.
#[derive(Debug, serde::Serialize)]
pub struct LeaderboardEntryDto {
    pub rank: usize,
    pub sat: u64,
    pub name: String,
    pub seed: u32,
    pub dist: u32,
    pub state: &'static str,
}

/// `GET /v1/events` item.
#[derive(Debug, serde::Serialize)]
pub struct EventDto {
    pub height: u32,
    pub block_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub txid: Option<String>,
    /// Compact action name + payload fields (mirrors EventAction).
    pub action: serde_json::Value,
}

/// `POST /v1/admin/block` response.
#[derive(Debug, serde::Serialize)]
pub struct IngestReportDto {
    pub applied: bool,
    pub height: u32,
    pub events: usize,
    pub rejections: Vec<RejectionDto>,
}

#[derive(Debug, serde::Serialize)]
pub struct RejectionDto {
    pub txid: String,
    /// Anchor sat, when the rejection names a frog.
    pub sat: Option<u64>,
    pub reason: String,
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

pub fn frogger_dto(
    record: &FroggerRecord,
    location: Option<hopper_indexer::types::OutPoint>,
) -> FroggerDto {
    FroggerDto {
        sat: record.sat,
        seed: record.seed,
        name: record.name.clone(),
        state: state_str(record.state),
        dist: record.dist,
        crossings_entered: record.crossings_entered,
        mint_height: record.mint_height,
        mint_txid: hex_display(&record.mint_txid),
        mint_index: record.mint_index,
        inscription_id: record.inscription_id.clone(),
        location: location.map(|op| LocationDto {
            txid: hex_display(&op.txid),
            vout: op.vout,
        }),
        wire_version: record.wire_version,
        crossings_settled: record.crossings_settled,
        deaths: record.deaths,
        in_flight: record.in_flight.map(|f| InFlightDto {
            txid: hex_display(&f.txid),
            height: f.height,
            target_hops: f.target_hops,
            settle_height: f.height + hopper_core::params::PROTOCOL.cross_finality,
        }),
        target_hops: record.last_target_hops,
        immortal_height: record.immortal_height,
        death_height: record.death_height,
        burn_height: record.burn_height,
        burn_txid: record.burn_txid.map(|txid| hex_display(&txid)),
        outcome_block_hash: record.outcome_block_hash.map(|h| hex_display(&h)),
        provisional_dead: record.provisional_dead,
    }
}

/// A v3 crossing, straight from the frog's `in_flight` record.
pub fn in_flight_dto(
    entry: &crate::engine::InFlightEntry,
    params: &hopper_core::params::ProtocolParams,
) -> CrossingDto {
    in_flight_dto_with(entry, params, None, None)
}

/// The same DTO with the frog record's sealed-outcome fields attached.
pub fn in_flight_dto_with(
    entry: &crate::engine::InFlightEntry,
    params: &hopper_core::params::ProtocolParams,
    provisional_dead: Option<bool>,
    outcome_block_hash: Option<[u8; 32]>,
) -> CrossingDto {
    CrossingDto {
        frogger_sat: entry.sat,
        h_f: String::new(),
        cross_height: entry.height,
        cross_txid: hex_display(&entry.txid),
        car_txid: None,
        h_c: None,
        phase: PhaseDto {
            name: "crossing",
            car_height: None,
            anchor_height: None,
            // B = T+1 decides the outcome; settlement is T+cross_finality.
            deadline_height: Some(entry.height + 1),
            outcome: None,
            settle_height: Some(entry.height + params.cross_finality),
        },
        frog_revealed: false,
        car_revealed: false,
        seed: entry.seed,
        name: entry.name.clone(),
        dist: entry.dist,
        target_hops: Some(entry.target_hops),
        outcome_block_hash: outcome_block_hash.map(|h| hex_display(&h)),
        provisional_dead,
    }
}

pub fn event_dto(e: &ChainEvent) -> EventDto {
    let action = match &e.action {
        EventAction::Mint {
            frogger_sat,
            seed,
            name,
        } => serde_json::json!({
            "kind": "mint", "frogger_sat": frogger_sat, "seed": seed, "name": name
        }),
        EventAction::Transfer { frogger_sat } => serde_json::json!({
            "kind": "transfer", "frogger_sat": frogger_sat
        }),
        EventAction::Settle {
            frogger_sat,
            outcome,
        } => serde_json::json!({
            "kind": "settle", "frogger_sat": frogger_sat,
            "outcome": outcome_str(*outcome)
        }),
        EventAction::Burn { frogger_sat } => {
            serde_json::json!({ "kind": "burn", "frogger_sat": frogger_sat })
        }
    };
    EventDto {
        height: e.height,
        block_hash: hex_display(&e.block_hash),
        txid: e.txid.as_ref().map(hex_display),
        action,
    }
}

pub fn rejection_dto(r: &hopper_indexer::types::Rejection) -> RejectionDto {
    RejectionDto {
        txid: hex_display(&r.txid),
        sat: r.sat,
        reason: format!("{:?}", r.reason),
    }
}

/// A tracked UTXO's value and ordinal sat ranges — wallet discovery
/// data (SPEC §9.3: untrusted input the wallet verifies itself).
#[derive(Debug, serde::Serialize)]
pub struct UtxoDto {
    pub value: u64,
    /// Half-open `[start, end)` ordinal spans, in ordinal order.
    ///
    /// **`exact: false` means these are not real ordinal assignments.**
    /// An input the indexer never saw (pre-genesis backfill gap, a store
    /// rebuilt from a snapshot, a reorg beyond the undo window) gets a
    /// deterministic *shadow* range at `SHADOW_BASE` so FIFO placement
    /// stays right — but a wallet must never treat it as ownership.
    pub ranges: Vec<(u64, u64)>,
    /// All ranges are real sat assignments. False for shadow ranges and
    /// for a mempool answer whose ancestor coins were not all known.
    pub exact: bool,
    /// Frog sats inside this output (ascending, unique). v3 adoption hint
    /// (V3-FINAL-SPEC §8.8): a wallet that sees one of its watched coins
    /// here learns it carries a playable frog without scanning the chain.
    #[serde(default)]
    pub frogs: Vec<u64>,
}

/// `GET /v1/fees` — suggested feerates for wallet tx construction
/// (WALLET-UX-PLAN W2).
///
/// **Cross-crate contract** — the wallet side (frogger-wallet-gui /
/// frogger-wallet-core) consumes this EXACT shape in a later wave; do
/// not rename or reshape fields without coordinating:
///
/// ```json
/// {
///   "suggested_sat_vb": 21,
///   "economy_sat_vb": 5,
///   "target_blocks": 3,
///   "source": "bitcoind-estimatesmartfee:3",
///   "clamped": false
/// }
/// ```
///
/// - `suggested_sat_vb`: conservative-target feerate, whole sats/vB,
///   always within [`FEE_SAT_VB_MIN`]..=[`FEE_SAT_VB_MAX`].
/// - `economy_sat_vb`: slower-target feerate, or `null` when bitcoind
///   has no data for the economy target.
/// - `source`: provenance of the suggestion (`method:target`).
/// - `clamped`: true when a raw node answer fell outside the sane
///   bounds and was clamped — a broken node can never push the wallet
///   into absurd-fee territory, but callers may want to surface it.
///
/// On bitcoind errors the endpoint answers 409 `{"error": ...}` (the
/// `/v1/mempool` convention) — it never invents a feerate.
#[derive(Debug, serde::Serialize)]
pub struct FeesDto {
    pub suggested_sat_vb: u64,
    pub economy_sat_vb: Option<u64>,
    pub target_blocks: u32,
    pub source: String,
    pub clamped: bool,
}

/// Sane feerate bounds (sat/vB) for suggestions: a broken or
/// misconfigured bitcoind answer can never suggest absurd fees.
pub const FEE_SAT_VB_MIN: u64 = 1;
pub const FEE_SAT_VB_MAX: u64 = 1000;

/// bitcoind BTC/kB → whole sat/vB (1 BTC/kB = 100_000 sat/vB),
/// rounded and clamped into [`FEE_SAT_VB_MIN`]..=[`FEE_SAT_VB_MAX`].
/// Returns the rate and whether the raw converted value fell outside
/// those bounds (the `clamped` flag).
pub fn sat_vb_clamped(btc_kb: f64) -> (u64, bool) {
    let raw = btc_kb * 100_000.0;
    let clamped = !(FEE_SAT_VB_MIN as f64..=FEE_SAT_VB_MAX as f64).contains(&raw);
    (
        raw.round()
            .clamp(FEE_SAT_VB_MIN as f64, FEE_SAT_VB_MAX as f64) as u64,
        clamped,
    )
}

/// Build the [`FeesDto`] from bitcoind `estimatesmartfee` BTC/kB
/// values. `economy_btc_kb` is `None` when bitcoind had no slower
/// estimate (→ `economy_sat_vb: null`).
pub fn fees_dto(suggested_btc_kb: f64, economy_btc_kb: Option<f64>, target_blocks: u32) -> FeesDto {
    let (suggested_sat_vb, mut clamped) = sat_vb_clamped(suggested_btc_kb);
    let economy_sat_vb = economy_btc_kb.map(|btc_kb| {
        let (rate, hit) = sat_vb_clamped(btc_kb);
        clamped |= hit;
        rate
    });
    FeesDto {
        suggested_sat_vb,
        economy_sat_vb,
        target_blocks,
        source: format!("bitcoind-estimatesmartfee:{target_blocks}"),
        clamped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_bytes_keeps_digest_order() {
        let mut bytes = [0u8; 32];
        bytes[0] = 0xCD;
        bytes[31] = 0xAB;
        assert!(hex_bytes(&bytes).starts_with("cd"));
        assert!(hex_bytes(&bytes).ends_with("ab"));
    }

    #[test]
    fn hex_display_reverses_bytes() {
        let mut bytes = [0u8; 32];
        bytes[31] = 0xAB; // display order puts 0xAB first
        bytes[0] = 0xCD;
        assert!(hex_display(&bytes).starts_with("ab"));
        assert!(hex_display(&bytes).ends_with("cd"));
    }

    #[test]
    fn sat_vb_conversion_and_clamp() {
        // 0.00021 BTC/kB = 21 sat/vB, untouched.
        assert_eq!(sat_vb_clamped(0.00021), (21, false));
        // 0.05 BTC/kB = 5000 sat/vB → clamped to the ceiling.
        assert_eq!(sat_vb_clamped(0.05), (FEE_SAT_VB_MAX, true));
        // A near-zero answer → clamped to the floor.
        assert_eq!(sat_vb_clamped(1e-9), (FEE_SAT_VB_MIN, true));
        // 0.00001 BTC/kB = 1 sat/vB — the floor itself, not clamped.
        assert_eq!(sat_vb_clamped(0.00001), (1, false));
        // Rounding to whole sats: 0.00002155 BTC/kB ≈ 2.155 sat/vB → 2.
        assert_eq!(sat_vb_clamped(0.00002155), (2, false));
    }

    #[test]
    fn fees_dto_shape_and_economy_null() {
        let dto = fees_dto(0.00021, Some(0.00002), 3);
        assert_eq!(dto.suggested_sat_vb, 21);
        assert_eq!(dto.economy_sat_vb, Some(2));
        assert_eq!(dto.target_blocks, 3);
        assert_eq!(dto.source, "bitcoind-estimatesmartfee:3");
        assert!(!dto.clamped);

        // No slower estimate → null economy, clamped latches from
        // whichever value hit the bounds.
        let dto = fees_dto(0.00002, None, 3);
        assert_eq!(dto.economy_sat_vb, None);
        assert!(!dto.clamped);
        let dto = fees_dto(0.00002, Some(0.05), 3);
        assert_eq!(dto.economy_sat_vb, Some(FEE_SAT_VB_MAX));
        assert!(dto.clamped);
    }

    use crate::engine::InFlightEntry;

    #[test]
    fn a_v3_crossing_on_the_road_shows_target_and_both_heights() {
        let entry = InFlightEntry {
            sat: 1_000,
            txid: [7u8; 32],
            height: 101,
            target_hops: 12,
            seed: 0xABCD,
            name: "Roadfrog".into(),
            dist: 3,
        };
        let dto = in_flight_dto(&entry, &hopper_core::params::PROTOCOL);
        assert_eq!(dto.cross_height, 101);
        assert_eq!(dto.target_hops, Some(12));
        assert_eq!(dto.dist, 3);
        assert_eq!(dto.phase.name, "crossing");
        // The outcome is fixed at B = T+1; settlement at T+cross_finality.
        assert_eq!(dto.phase.deadline_height, Some(102));
        assert_eq!(
            dto.phase.settle_height,
            Some(101 + hopper_core::params::PROTOCOL.cross_finality)
        );
        assert_eq!(dto.phase.outcome, None, "no outcome before B");
    }
}
