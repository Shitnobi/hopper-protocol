//! Domain types for the FROGGER v2.0 indexer (Workstream B, phases B1+B2).
//!
//! These types form the boundary between the (future) chain-ingest layer
//! and the pure indexer core:
//!
//! * [`Block`] / [`Tx`] / [`OutPoint`] — a minimal, Bitcoin-agnostic view
//!   of **confirmed** chain data (SPEC §11: unconfirmed envelopes never
//!   happened). The ingest layer (B3+) is responsible for producing these
//!   from ZMQ/RPC feeds; the core performs no I/O and no script
//!   validation.
//! * [`FroggerRecord`] / [`FroggerState`] / [`Crossing`] /
//!   [`CrossingPhase`] — per-frog protocol state (SPEC §4, §5).
//! * [`ChainEvent`] — entries of the re-derivable public event log keyed
//!   by `(block_hash, txid, action)` (SPEC §8.1.4).
//!
//! `FINALITY_DEPTH` (settlement finality) is indexer-level and lives in
//! [`crate::state_machine`].

use hopper_core::satmath::SatRange;
use hopper_core::DecodeError;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Chain data model
// ---------------------------------------------------------------------------

/// A transaction output reference (opaque txid + output index).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct OutPoint {
    /// Transaction identifier (internal byte order; opaque to this crate).
    pub txid: [u8; 32],
    /// Output index within the transaction.
    pub vout: u32,
}

/// A decoded ord inscription reveal on a tx input (Change B).
///
/// The pure model stays witness-free: the ingest layer parses the
/// taproot script-path witness (tapscript = `witness[n-2]`) with
/// `hopper_core::parse_inscriptions` and hands the core this summary.
/// The state machine validates it during MINT processing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InscriptionReveal {
    /// Content-type string (e.g. `"image/png"`).
    pub content_type: String,
    /// SHA-256 of the inscription body (the canonical art PNG).
    pub body_hash: [u8; 32],
    /// Ord inscription id: `{reveal_txid}i{envelope_index}`.
    pub inscription_id: String,
    /// Raw inscription body (V3 §6.2). The body is the CROSS authority and
    /// `body_hash` is ALWAYS recomputed from it when present (V3 §8.2).
    /// `None` when the ingest layer only supplied a summary (Change B).
    #[serde(default)]
    pub body: Option<Vec<u8>>,
    /// Raw tag-3 parent values, in ord payload order (V3 §6.3). Empty for
    /// every v2 inscription.
    #[serde(default)]
    pub parents: Vec<Vec<u8>>,
    /// The tapscript that revealed the envelope (V3 §6.4 ticket shape).
    #[serde(default)]
    pub tapscript: Option<Vec<u8>>,
    /// The control block of that script-path spend: `[parity|0xc0] || internal`.
    #[serde(default)]
    pub control_block: Option<Vec<u8>>,
}

/// A transaction input.
///
/// `value` is the spent output's value in sats. It is consulted **only**
/// for inputs the sat tracker has never seen (see
/// [`crate::sat_track::SHADOW_BASE`]); for tracked UTXOs the recorded sat
/// ranges are authoritative. The ingest layer must therefore supply
/// prevout values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TxInput {
    /// The output being spent.
    pub prevout: OutPoint,
    /// Value of the spent output in sats.
    pub value: u64,
    /// Ord inscription(s) revealed by this input's witness, decoded by
    /// the ingest layer (Change B). `None` on non-revealing inputs and
    /// for blocks indexed before the inscription era.
    #[serde(default)]
    pub inscription: Option<InscriptionReveal>,
}

/// A transaction output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TxOut {
    /// Output value in sats.
    pub value: u64,
    /// Raw OP_RETURN push payload (the bytes pushed after the `OP_RETURN`
    /// opcode), if this output carries one. Envelope parsing happens in
    /// the state machine (SPEC §3, §8.2.5).
    pub op_return: Option<Vec<u8>>,
}

/// A confirmed transaction.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tx {
    /// Transaction identifier (internal byte order; opaque to this crate).
    pub txid: [u8; 32],
    /// Inputs, in input order (Ordinals sat flow is FIFO over this order).
    pub inputs: Vec<TxInput>,
    /// Outputs, in output order.
    pub outputs: Vec<TxOut>,
}

/// A confirmed block. Transactions are in block order; the coinbase
/// transaction is **not modeled** (see `NOTES.md` — fee-flow of anchor
/// sats is recorded as [`MoveDest::Fees`] instead).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Block {
    /// Block hash `H` (internal byte order; opaque to this crate).
    pub hash: [u8; 32],
    /// Block height.
    pub height: u32,
    /// Transactions in block order.
    pub txs: Vec<Tx>,
}

// ---------------------------------------------------------------------------
// Frogger protocol state (SPEC §4, §5)
// ---------------------------------------------------------------------------

/// The coarse lifecycle state of a frogger (SPEC §5).
///
/// `Dead` and `Home` are **absorbing**: once entered, a frogger never
/// leaves them and its sat is never re-mintable (SPEC §4.1, §8.2.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FroggerState {
    /// On the lily pad; may CROSS (V3 §4.2).
    Idle,
    /// A valid CROSS is in flight (`T .. T+6`); no CROSS allowed.
    Crossing,
    /// Immortal: `dist >= target` after a surviving settlement — absorbing.
    /// (Kept as `Home` for snapshot/API compatibility; the UI says IMMORTAL.)
    Home,
    /// ROADKILL — permanent, absorbing.
    Dead,
    /// The anchor sat flowed to fees before its crossing settled — absorbing.
    Burned,
    /// Legacy v2 frog (mint envelope `0x03`): transfer-only, no CROSS
    /// (V3 §4.4). Terminal by rule, not by sat fate.
    Retired,
}

impl FroggerState {
    /// Terminal states never change again (except by chain undo).
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Home | Self::Dead | Self::Burned | Self::Retired)
    }

    /// A frog in this state may open a crossing.
    pub fn may_cross(self) -> bool {
        self == Self::Idle
    }
}

/// Where a frogger's anchor sat currently sits (SPEC §6).
///
/// The forward half of the coin model: each coin lists the frogger sats it
/// holds (`UtxoEntry::frogs`), and each frog names the coin holding it. No
/// third index exists that could drift out of sync (IR plan P1.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SatLocation {
    /// The sat is inside this output.
    Tracked(OutPoint),
    /// The sat flowed to fees at some point; it is no longer locatable.
    /// Terminal — a burned sat never becomes trackable again.
    Burned,
}

impl SatLocation {
    /// The outpoint holding the sat, if it is still tracked.
    pub fn outpoint(self) -> Option<OutPoint> {
        match self {
            Self::Tracked(outpoint) => Some(outpoint),
            Self::Burned => None,
        }
    }
}

/// The full public record of one frogger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FroggerRecord {
    /// Canonical ID: the ordinal number of the anchor sat (SPEC §4.1).
    pub sat: u64,
    /// 4-byte mint seed driving the deterministic art (SPEC §10).
    pub seed: u32,
    /// Minted name (≤ 38 bytes, per the envelope codec).
    pub name: String,
    /// Current lifecycle state.
    pub state: FroggerState,
    /// Completed crossings; never exceeds `HOME_DIST` (SPEC §8.2.6).
    pub dist: u32,
    /// Number of road entries (CROSS envelopes accepted). The GUI "times
    /// crossed the road" is `dist` (completed crossings), NOT this field. Distinguish carefully: a retreat increments this but not `dist`.
    pub crossings_entered: u32,
    /// Height of the mint block.
    pub mint_height: u32,
    /// Txid of the mint transaction.
    pub mint_txid: [u8; 32],
    /// Ord inscription id of the reveal (`{reveal_txid}i0`) when the
    /// mint was inscription-backed (Change B); `None` for legacy
    /// single-tx mints indexed before `inscription_activation_height`.
    #[serde(default)]
    pub inscription_id: Option<String>,
    /// Where the anchor sat currently sits (the forward coin index).
    pub location: SatLocation,
    /// Wire version of the mint envelope that created this frog (3 = legacy,
    /// 4 = v3). Consensus data: it decides whether CROSS is legal at all.
    #[serde(default = "legacy_wire_version")]
    pub wire_version: u8,
    /// Ord envelope index of the mint inscription (`{txid}i{index}`).
    /// The CROSS body repeats it (`mint_id`), so it is consensus data.
    #[serde(default)]
    pub mint_index: u32,
    /// Resolved crossings (settled or voided) — v3 replacement for
    /// `finished_count`. `dist` counts survived hops only.
    #[serde(default)]
    pub crossings_settled: u32,
    /// Deaths (0 or 1; a dead frog never crosses again).
    #[serde(default)]
    pub deaths: u32,
    /// The crossing currently in flight, if any (V3 §8.1).
    #[serde(default)]
    pub in_flight: Option<InFlight>,
    /// `H(T+1)`, captured once when block `T+1` connects (V3 §5.2).
    #[serde(default)]
    pub outcome_block_hash: Option<[u8; 32]>,
    /// Outcome determined at `T+1`, applied only at `T+6` (V3 §5.4).
    #[serde(default)]
    pub provisional_dead: Option<bool>,
    /// Height of the surviving settlement that made this frog immortal.
    #[serde(default)]
    pub immortal_height: Option<u32>,
    /// Height `T` of the CROSS whose outcome killed this frog.
    #[serde(default)]
    pub death_height: Option<u32>,
    /// Height of the block whose sat flow put the anchor sat into fees.
    /// Set for `Burned` frogs, and (for bookkeeping) for a crossing that
    /// is about to settle as burned.
    #[serde(default)]
    pub burn_height: Option<u32>,
    /// Txid of the transaction that burned the anchor sat.
    #[serde(default)]
    pub burn_txid: Option<[u8; 32]>,
    /// Hop requirement frozen when the last crossing opened.
    #[serde(default)]
    pub last_target_hops: Option<u32>,
}

const fn legacy_wire_version() -> u8 {
    LEGACY_WIRE_VERSION
}

/// Wire version of a v2.2 mint envelope.
pub const LEGACY_WIRE_VERSION: u8 = 0x03;

/// A crossing in flight (V3 §8.1): everything needed to settle it without
/// looking at the opening block again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct InFlight {
    /// The CROSS transaction.
    pub txid: [u8; 32],
    /// Height `T` of the block containing it — settlement is `T+6`.
    pub height: u32,
    /// `required_hops(T)`, frozen at `T` (V3 §3.4).
    pub target_hops: u32,
}

// The v2 crossing ledger (Crossing/CarCommit/AnchorInfo/FinishedCrossing)
// was removed by the v3 cutover (§15): v3 crossings live in
// `FroggerRecord::in_flight`.

// ---------------------------------------------------------------------------
// Event log (SPEC §8.1.4: replayable, keyed by (block_hash, txid, action))
// ---------------------------------------------------------------------------

/// A crossing's settled outcome (v3: no VOID — a scheduled settle is
/// always Dead or Crossed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SettleOutcome {
    /// ROADKILL — permanent.
    Dead,
    /// The frog advanced one lily pad.
    Crossed,
}

/// One entry of the published, re-derivable event log (SPEC §8.1.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChainEvent {
    /// Hash of the block that produced this event.
    pub block_hash: [u8; 32],
    /// Height of that block.
    pub height: u32,
    /// Txid of the triggering transaction; `None` for block-level events
    /// (anchor recording, window expiry, expiry settlements).
    pub txid: Option<[u8; 32]>,
    /// What happened.
    pub action: EventAction,
}

/// The protocol-level meaning of a [`ChainEvent`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EventAction {
    /// A frogger was minted onto `frogger_sat` (SPEC §4.1).
    Mint {
        frogger_sat: u64,
        seed: u32,
        name: String,
    },
    /// The anchor-sat UTXO was spent: a plain transfer. Transfers are
    /// ALWAYS inert to crossing state (SPEC §4.2, §6.2 v2.1): the
    /// crossing is keyed to the frogger's sat number, so a mid-crossing
    /// send hands over a frog whose already-sealed outcome settles on
    /// its own — it can never create, avoid, or delay a gamble.
    Transfer { frogger_sat: u64 },
    /// The crossing settled (SPEC §5 phase 4, §7).
    Settle {
        frogger_sat: u64,
        outcome: SettleOutcome,
    },
    /// The anchor sat was paid to fees; its location is no longer tracked
    /// (modeling gap — see `NOTES.md`).
    Burn { frogger_sat: u64 },
}

// ---------------------------------------------------------------------------
// Sat-tracking results (consumed by the state machine)
// ---------------------------------------------------------------------------

/// Where a frogger's anchor sat landed after a spend.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveDest {
    /// The sat flowed into this output.
    Output(OutPoint),
    /// The sat flowed to fees (output value shortfall). The frogger is
    /// marked burned and its location is no longer tracked.
    Fees,
}

/// One frogger's anchor-sat movement through a transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MoveRecord {
    /// The frogger's canonical sat.
    pub sat: u64,
    /// The UTXO that held the sat before the spend.
    pub from: OutPoint,
    /// Where the sat landed.
    pub to: MoveDest,
}

/// Per-transaction sat-flow results produced by
/// [`crate::sat_track::SatTracker::apply_tx`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TxFlow {
    /// Movements of tracked frogger anchor sats, ordered by sat.
    pub moves: Vec<MoveRecord>,
    /// The first sat of output 0 — the MINT anchor position (SPEC §4.1).
    /// `None` if output 0 receives no sats (invalid MINT). May be a
    /// *shadow* sat (see [`crate::sat_track::is_shadow`]) when the
    /// position is funded by untracked inputs.
    pub anchor_out0: Option<u64>,
}

/// A tracked UTXO and the Ordinals sat ranges it holds (ascending order).
///
/// This is the indexer's coin: like a Bitcoin `Coin`, it is created with an
/// output and deleted when spent. It additionally carries the frogger sats it
/// currently holds (`frogs`), which is the reverse index spends need — one
/// lookup per spent outpoint, with no separate `anchors_at` map to keep in
/// sync (IR plan P1.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UtxoEntry {
    /// Output value in sats.
    pub value: u64,
    /// Sat ranges assigned to this output, in ordinal order.
    pub ranges: Vec<SatRange>,
    /// Frogger anchor sats currently inside this output (ascending, unique).
    ///
    /// A coin normally holds zero or one; consolidations put several here.
    /// The forward direction lives in the frog's `location` (`P1.2`).
    pub frogs: smallvec::SmallVec<[u64; 2]>,
}

// ---------------------------------------------------------------------------
// Per-block reporting (for tests, observability, and the future API layer)
// ---------------------------------------------------------------------------

/// Why an envelope or movement was ignored. Malformed or invalid envelopes
/// are ignored — never chain-invalidating (SPEC §8.2.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RejectionReason {
    /// Envelope confirmed below activation height H₀ (SPEC §8.2.7).
    BelowActivation,
    /// The tx carries more than one FRG envelope: ignored in full (SPEC §8.2.5).
    MultipleEnvelopes,
    /// The FRG push did not decode (SPEC §8.2.5).
    MalformedEnvelope(DecodeError),
    /// Envelope referenced a frogger that does not exist.
    EnvelopeForUnknownFrogger,
    /// MINT: the anchor sat already carries a frogger, live or dead (SPEC §4.1).
    MintSatInUse,
    /// MINT: output 0 receives no sats, so there is no anchor sat (SPEC §4.1).
    MintNoAnchorSat,
    /// MINT: output 0's first sat comes from untracked inputs; the
    /// frogger ID would be unknowable.
    MintAnchorUntracked,
    /// CROSS: the tx spends the anchor-sat UTXO but the anchor sat flows
    /// to fees.
    CrossAnchorBurned,
    /// MINT (Change B): no inscription revealed on input 0 after
    /// `inscription_activation_height`.
    MintWithoutInscription,
    /// MINT (Change B): more than one inscription in the mint tx.
    MultipleInscriptions,
    /// MINT (Change B): inscription content-type is not `image/png`.
    InscriptionContentType,
    /// MINT (Change B): inscription body is not `render_png(seed)` —
    /// the art does not match the claimed seed.
    InscriptionArtMismatch,
    // --- v3 CROSS rejections (V3 §8.7) -------------------------------
    /// CROSS: the inscription body did not decode (magic/length/version).
    CrossBodyMalformed,
    /// CROSS: the tag-3 parent disagrees with the body's mint id.
    CrossParentMismatch,
    /// CROSS: the frog's mint is v2 (`0x03`) — transfer-only, `Retired`.
    CrossLegacyFrog,
    /// CROSS: the envelope is not in input 0's tapscript.
    CrossNotInFirstInput,
    /// CROSS: the tx reveals more than one inscription.
    CrossMultipleInscriptions,
    /// CROSS: the tx also carries an `FRG` OP_RETURN envelope (v2 action).
    CrossMixedWithEnvelope,
    /// CROSS: the body's sat has no frog record.
    CrossUnknownFrog,
    /// CROSS: the tx does not spend the frog's current outpoint.
    CrossFrogOutpointNotSpent,
    /// CROSS: a crossing is already in flight.
    CrossWhileCrossing,
    /// CROSS: the frog is immortal.
    CrossOnHomeFrog,
    /// CROSS: the frog is dead.
    CrossOnDeadFrog,
    /// CROSS: the frog's sat burned.
    CrossOnBurnedFrog,
    /// CROSS: the frog is a legacy v2 frog.
    CrossOnRetiredFrog,
    /// CROSS: the frog sat did not land in output 1.
    CrossFrogNotInOutput1,
    /// CROSS (v6): the frog sat did not land in output 0.
    CrossFrogNotInFirstOutput,
    /// CROSS: a funding input carries a frog or ticket sat.
    CrossFundingCarriesFrog,
    /// CROSS: output shape / value rule failed (V3 §7.3 rules 4 and 6).
    CrossBadOutputShape,
    /// CROSS: input 0 is not a ticket (NUMS internal key, one leaf,
    /// exactly one envelope) — V3 §7.3 rule 2.
    CrossTicketShape,
    /// The indexer's parameters disagree with the chain's commitment
    /// (V3 §8.7): two nodes with different roads must not share a state.
    ParamsMismatch,
}

/// One rejected envelope, with its reason.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejection {
    /// Txid of the tx carrying the rejected envelope.
    pub txid: [u8; 32],
    /// Anchor sat, when the rejection is about a known frog (V3 §8.7).
    pub sat: Option<u64>,
    /// Why it was rejected.
    pub reason: RejectionReason,
}

/// The result of applying one block: emitted events and rejections.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BlockReport {
    /// Events appended to the public event log by this block.
    pub events: Vec<ChainEvent>,
    /// Envelopes ignored by this block, with reasons.
    pub rejections: Vec<Rejection>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_event_serde_roundtrip() {
        let event = ChainEvent {
            block_hash: [7; 32],
            height: 42,
            txid: Some([9; 32]),
            action: EventAction::Mint {
                frogger_sat: 1_234,
                seed: 0xABCD,
                name: "Testfrog".into(),
            },
        };
        let json = serde_json::to_string(&event).expect("serialize");
        let back: ChainEvent = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, event);
    }

    #[test]
    fn block_event_serde_roundtrip() {
        let event = ChainEvent {
            block_hash: [1; 32],
            height: 9,
            txid: None,
            action: EventAction::Settle {
                frogger_sat: 5,
                outcome: SettleOutcome::Dead,
            },
        };
        let json = serde_json::to_string(&event).expect("serialize");
        let back: ChainEvent = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, event);
    }

    #[test]
    fn tx_serde_roundtrip() {
        let tx = Tx {
            txid: [4; 32],
            inputs: vec![TxInput {
                prevout: OutPoint {
                    txid: [1; 32],
                    vout: 3,
                },
                value: 1500,
                inscription: None,
            }],
            outputs: vec![
                TxOut {
                    value: 1400,
                    op_return: None,
                },
                TxOut {
                    value: 0,
                    op_return: Some(b"FRG\x03\x02".to_vec()),
                },
            ],
        };
        let json = serde_json::to_string(&tx).expect("serialize");
        let back: Tx = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, tx);
    }

    #[test]
    fn terminal_states_never_cross() {
        for state in [
            FroggerState::Home,
            FroggerState::Dead,
            FroggerState::Burned,
            FroggerState::Retired,
        ] {
            assert!(state.is_terminal(), "{state:?}");
            assert!(!state.may_cross(), "{state:?}");
        }
        assert!(FroggerState::Idle.may_cross());
        assert!(!FroggerState::Crossing.may_cross());
        assert!(!FroggerState::Crossing.is_terminal());
    }

    #[test]
    fn in_flight_round_trips_through_bincode() {
        let crossing = InFlight {
            txid: [0xAB; 32],
            height: 1_000,
            target_hops: 57,
        };
        let bytes = bincode::serialize(&crossing).unwrap();
        assert_eq!(bincode::deserialize::<InFlight>(&bytes).unwrap(), crossing);
    }
}
