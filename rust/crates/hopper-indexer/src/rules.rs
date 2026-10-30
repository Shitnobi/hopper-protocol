//! The HOPPER v7 consensus rules — the whole rule set.
//!
//! This module is generic over [`ConsensusState`] like the rest of the
//! apply path:
//!
//! * [`validate_cross`] — the pure check list (no mutation);
//! * [`begin_crossing`] — the `Idle → Crossing` transition;
//! * [`capture_outcome`] / [`settle_due`] — the once-per-block timers,
//!   which run *before* the block's transactions.
//!
//! There is exactly one version. v2's CAR/REVEAL machine, v3's armed
//! tickets and v5's origin-bound live art are not part of this build:
//! a hop is a state inscription on the Hopper's own sat.

use crate::consensus::ConsensusState;
use crate::state_machine::BlockSink;
use crate::types::{
    EventAction, FroggerRecord, FroggerState, InFlight, MoveDest, RejectionReason, SatLocation,
    SettleOutcome, Tx, TxFlow,
};
use hopper_core::params::{ProtocolParams, NUMS_XONLY};
use hopper_core::wrap::wrap;

/// The one state inscription in a tx: exactly one input reveals it, and
/// it must be input 0. Returns the (index, reveal) pair so the caller can
/// distinguish "not a CROSS at all" from "misplaced envelope".
fn inscriptions(tx: &Tx) -> impl Iterator<Item = (usize, &crate::types::InscriptionReveal)> {
    tx.inputs
        .iter()
        .enumerate()
        .filter_map(|(index, input)| input.inscription.as_ref().map(|ins| (index, ins)))
}

/// Is `tx` a CROSS candidate? The body is the authority: a tx whose
/// inscription starts with the state magic is one, whatever its position;
/// a misplaced one is still a CROSS (and is rejected as such).
pub(crate) fn is_cross_tx(tx: &Tx) -> bool {
    inscriptions(tx).any(|(_, ins)| {
        ins.body.as_deref().is_some_and(|body| {
            body.len() >= hopper_core::STATE_MAGIC.len() && &body[..9] == hopper_core::STATE_MAGIC
        })
    })
}

/// True if the revealed leaf is the canonical leaf for some direction
/// other than the one the body carries (a replay with a swapped body).
fn leaf_is_for_another_dir(
    ins: &crate::types::InscriptionReveal,
    body: &hopper_core::StateBody,
) -> bool {
    let (Some(control), Some(script)) = (&ins.control_block, &ins.tapscript) else {
        return false;
    };
    if control.len() != 97 || control[0] & 0xfe != 0xc0 {
        return false;
    }
    if control[1..33] != NUMS_XONLY || script.len() < 35 || script[0] != 0x20 {
        return false;
    }
    let mut owner = [0u8; 32];
    owner.copy_from_slice(&script[1..33]);
    for dir in 0..3u8 {
        if dir == body.dir {
            continue;
        }
        let mut other = *body;
        other.dir = dir;
        if script == &hopper_core::state_leaf_script(&owner, &other) {
            let hashes = hopper_core::state_leaf_hashes(&owner, &other);
            let path = hopper_core::control_path(&hashes, dir);
            if control[33..65] == path[0][..] && control[65..97] == path[1][..] {
                return true;
            }
        }
    }
    false
}

/// v7 state leaf shape: NUMS internal key, four leaves, a 97-byte control
/// block whose path is the one for the body's direction, and exactly one
/// envelope (SPEC §3.1–§3.4).
///
/// The script is rebuilt from its own owner and the body and compared
/// byte-for-byte, so a non-canonical push encoding cannot pass. The
/// control-block path is rebuilt from the four leaf hashes; the output key
/// itself needs curve arithmetic and is the wallet's check.
fn state_shape_ok(ins: &crate::types::InscriptionReveal, body: &hopper_core::StateBody) -> bool {
    let (Some(control), Some(script)) = (&ins.control_block, &ins.tapscript) else {
        return false;
    };
    if control.len() != 97 || control[0] & 0xfe != 0xc0 {
        return false;
    }
    if control[1..33] != NUMS_XONLY {
        return false;
    }
    if script.len() < 35 || script[0] != 0x20 || script[33] != 0xad {
        return false;
    }
    let mut owner = [0u8; 32];
    owner.copy_from_slice(&script[1..33]);
    let expected = hopper_core::state_leaf_script(&owner, body);
    if script != &expected {
        return false;
    }
    if hopper_core::parse_inscriptions(script).len() != 1 {
        return false;
    }
    let hashes = hopper_core::state_leaf_hashes(&owner, body);
    let path = hopper_core::control_path(&hashes, body.dir);
    control[33..65] == path[0][..] && control[65..97] == path[1][..]
}

pub(crate) fn validate_cross(
    tx: &Tx,
    flow: &TxFlow,
    frog: &FroggerRecord,
    params: &ProtocolParams,
    funding_carries_frog: bool,
    height: u32,
) -> Result<u64, RejectionReason> {
    // 1. Exactly one inscription, in input 0.
    let mut seen = inscriptions(tx);
    let first = seen.next().ok_or(RejectionReason::CrossBodyMalformed)?;
    if seen.next().is_some() {
        return Err(RejectionReason::CrossMultipleInscriptions);
    }
    if first.0 != 0 {
        return Err(RejectionReason::CrossNotInFirstInput);
    }
    let ins = first.1;

    // 2. Canonical v7 body, bound to this frog.
    let body = ins
        .body
        .as_deref()
        .ok_or(RejectionReason::CrossBodyMalformed)
        .and_then(|b| {
            hopper_core::decode_state_body(b).map_err(|_| RejectionReason::CrossBodyMalformed)
        })?;
    if body.sat != frog.sat
        || body.mint_txid != frog.mint_txid
        || body.mint_index != frog.mint_index
    {
        return Err(RejectionReason::CrossBodyMalformed);
    }

    // 3. The parent is NOT optional in v7: it is the mint link the fold
    //    walks. Missing or wrong is a rejection, never a drop.
    let parent = ins
        .parents
        .first()
        .ok_or(RejectionReason::CrossParentMismatch)?;
    if hopper_core::decode_parent_tag(parent) != Ok((body.mint_txid, body.mint_index)) {
        return Err(RejectionReason::CrossParentMismatch);
    }

    // 4. Input 0 is the frog and its leaf is the canonical template for
    //    the direction in the body (SPEC §4.3 item 4 / §6.7). A leaf that
    //    is canonical for a DIFFERENT direction is the direction-rejection
    //    case, not a generic malformed script.
    if !state_shape_ok(ins, &body) {
        return Err(if leaf_is_for_another_dir(ins, &body) {
            RejectionReason::CrossDirectionMismatch
        } else {
            RejectionReason::CrossTicketShape
        });
    }
    let frog_outpoint = match frog.location {
        SatLocation::Tracked(outpoint) => outpoint,
        SatLocation::Burned => return Err(RejectionReason::CrossOnBurnedFrog),
    };
    if tx.inputs.first().map(|i| i.prevout) != Some(frog_outpoint) {
        return Err(RejectionReason::CrossFrogOutpointNotSpent);
    }

    // 5. The anchor sat lands in output 0.
    let destination = flow
        .moves
        .iter()
        .find(|mv| mv.sat == frog.sat)
        .ok_or(RejectionReason::CrossFrogOutpointNotSpent)?;
    match destination.to {
        MoveDest::Output(outpoint) if outpoint.txid == tx.txid && outpoint.vout == 0 => {}
        _ => return Err(RejectionReason::CrossFrogNotInFirstOutput),
    }

    // 6. Funding carries no frog; no v2 envelope may be mixed in.
    if funding_carries_frog {
        return Err(RejectionReason::CrossFundingCarriesFrog);
    }
    if tx.outputs.iter().any(|o| {
        o.op_return
            .as_deref()
            .is_some_and(|p| p.starts_with(&hopper_core::envelope::MAGIC))
    }) {
        return Err(RejectionReason::CrossMixedWithEnvelope);
    }

    // 7. State gate.
    match frog.state {
        FroggerState::Idle => {}
        FroggerState::Crossing => return Err(RejectionReason::CrossWhileCrossing),
        FroggerState::Home => return Err(RejectionReason::CrossOnHomeFrog),
        FroggerState::Dead => return Err(RejectionReason::CrossOnDeadFrog),
        FroggerState::Burned => return Err(RejectionReason::CrossOnBurnedFrog),
        FroggerState::Retired => return Err(RejectionReason::CrossOnRetiredFrog),
    }
    debug_assert!(params.generations.required(height) <= params.generations.ceiling);
    Ok(body.sat)
}

/// `Idle → Crossing` (§4.3): the movement already updated `location`.
pub(crate) fn begin_crossing<S: ConsensusState + ?Sized>(
    state: &mut S,
    tx: &Tx,
    frog: &FroggerRecord,
    height: u32,
    params: &ProtocolParams,
    dir: u8,
) {
    let target_hops = params.generations.required(height);
    state.journal_frog(frog.sat);
    state.with_frog(frog.sat, &mut |slot| {
        if let Some(record) = slot {
            record.state = FroggerState::Crossing;
            record.crossings_entered += 1;
            record.in_flight = Some(InFlight {
                txid: tx.txid,
                height,
                target_hops,
                dir,
            });
            record.last_target_hops = Some(target_hops);
            // A new crossing clears the previous outcome: it belongs to
            // the previous settlement and must not be reused.
            record.outcome_block_hash = None;
            record.outcome_wrap = None;
            record.provisional_dead = None;
        }
    });
}

/// `B = T+1` connects: freeze the outcome (SPEC §4.4). Runs before the
/// block's transactions because `H(B)` is known before execution.
///
/// The wrap is computed once per block and applied to every frog in it:
/// the road picks one direction for the block, not one per Hopper.
pub(crate) fn capture_outcome<S: ConsensusState + ?Sized>(
    state: &mut S,
    height: u32,
    block_hash: [u8; 32],
) -> Result<(), crate::store::StoreError> {
    let w = wrap(&block_hash);
    let due: Vec<(u64, InFlight)> = {
        let mut due = Vec::new();
        state.for_each_frog(&mut |record| {
            if let Some(in_flight) = record.in_flight {
                if in_flight.height.saturating_add(1) == height {
                    due.push((record.sat, in_flight));
                }
            }
        })?;
        due
    };
    for (sat, in_flight) in due {
        state.journal_frog(sat);
        state.with_frog(sat, &mut |slot| {
            if let Some(record) = slot {
                // A crossing undone and re-opened in the same block keeps
                // the newest one; never overwrite another crossing's hash.
                if record.in_flight.map(|f| f.height) == Some(in_flight.height) {
                    record.outcome_block_hash = Some(block_hash);
                    record.outcome_wrap = Some(w);
                    record.provisional_dead = Some(in_flight.dir == w);
                }
            }
        });
    }
    Ok(())
}

/// Settlement at `T + cross_finality` (§8.4).
pub(crate) fn settle_due<S: ConsensusState + ?Sized>(
    state: &mut S,
    height: u32,
    sink: &mut BlockSink,
    params: &ProtocolParams,
) -> Result<(), crate::store::StoreError> {
    let finality = params.cross_finality;
    let due: Vec<(u64, InFlight, Option<bool>)> = {
        let mut due = Vec::new();
        state.for_each_frog(&mut |record| {
            if let Some(in_flight) = record.in_flight {
                if in_flight.height.saturating_add(finality) == height {
                    due.push((record.sat, in_flight, record.provisional_dead));
                }
            }
        })?;
        due
    };
    for (sat, in_flight, provisional_dead) in due {
        let burned = state
            .frog(sat)
            .is_some_and(|f| f.location == SatLocation::Burned);
        let outcome = if burned || provisional_dead == Some(true) {
            SettleOutcome::Dead
        } else {
            SettleOutcome::Crossed
        };
        state.journal_frog(sat);
        state.with_frog(sat, &mut |slot| {
            let Some(record) = slot.as_mut() else {
                return;
            };
            // Another crossing may have replaced this one in the same
            // block (impossible by height, but cheap to guarantee).
            if record.in_flight.map(|f| f.height) != Some(in_flight.height) {
                return;
            }
            match outcome {
                SettleOutcome::Dead if record.location == SatLocation::Burned => {
                    record.state = FroggerState::Burned;
                }
                SettleOutcome::Dead => {
                    record.state = FroggerState::Dead;
                    record.deaths = record.deaths.saturating_add(1);
                    record.death_height = Some(in_flight.height);
                }
                _ => {
                    record.dist = record.dist.saturating_add(1);
                    if record.dist >= in_flight.target_hops {
                        record.state = FroggerState::Home;
                        record.immortal_height = Some(in_flight.height);
                    } else {
                        record.state = FroggerState::Idle;
                    }
                }
            }
            record.crossings_settled = record.crossings_settled.saturating_add(1);
            record.in_flight = None;
            record.provisional_dead = None;
        });
        let dir = in_flight.dir;
        let w = state.frog(sat).and_then(|f| f.outcome_wrap);
        sink.event(
            None,
            EventAction::Settle {
                frogger_sat: sat,
                outcome,
                dir,
                wrap: w,
            },
        );
    }
    Ok(())
}

/// Does any funding input (beyond the frog itself) carry a tracked frog?
/// A crossing may only be funded by clean coins.
pub(crate) fn funding_carries_frog<S: ConsensusState + ?Sized>(
    state: &S,
    tx: &Tx,
    first_funding: usize,
) -> bool {
    tx.inputs.iter().skip(first_funding).any(|input| {
        state
            .coin(&input.prevout)
            .is_some_and(|entry| !entry.frogs.is_empty())
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::state_machine::{Indexer, IndexerConfig};
    use crate::types::{Block, OutPoint, RejectionReason, Tx, TxInput, TxOut};
    use hopper_core::encode_parent_tag;
    use hopper_core::envelope::{encode_mint, envelope, Action};
    use hopper_core::params::{params_hash, GenerationParams, ProtocolParams, PROTOCOL};
    use hopper_core::satmath::SatRange;
    use hopper_core::wrap::wrap;

    const SAT: u64 = 1_000;
    const CARD: u64 = 25_000;
    const MINT_TXID: u8 = 2;
    const MINT_INDEX: u32 = 0;
    const OWNER: [u8; 32] = [0x11; 32];

    fn b32(n: u8) -> [u8; 32] {
        [n; 32]
    }

    fn op(txid: u8, vout: u32) -> OutPoint {
        OutPoint {
            txid: b32(txid),
            vout,
        }
    }

    fn input(txid: u8, vout: u32, value: u64) -> TxInput {
        TxInput {
            prevout: op(txid, vout),
            value,
            inscription: None,
        }
    }

    fn out(value: u64) -> TxOut {
        TxOut {
            value,
            op_return: None,
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

    fn block_with_hash(height: u32, hash: [u8; 32], txs: Vec<Tx>) -> Block {
        Block { hash, height, txs }
    }

    /// A hash whose wrap is `w`.
    fn hash_with_wrap(w: u8) -> [u8; 32] {
        let mut h = [0x33u8; 32];
        h[0] = w;
        h[1] = 0;
        h[2] = 0;
        h[3] = 0;
        debug_assert_eq!(wrap(&h), w);
        h
    }

    fn hash_that_is_not(w: u8) -> [u8; 32] {
        hash_with_wrap((w + 1) % 3)
    }

    fn config() -> IndexerConfig {
        IndexerConfig {
            params: ProtocolParams::fixture_fast(),
            ..Default::default()
        }
    }

    /// A schedule where the target is always 3: three survived hops make a
    /// Hopper immortal without touching the production constants.
    fn home3_config() -> IndexerConfig {
        IndexerConfig {
            params: ProtocolParams {
                generations: GenerationParams {
                    genesis: 0,
                    base: 3,
                    growth_interval: 1_000,
                    ceiling: 3,
                    hold: 10,
                    generation_len: 10,
                },
                cross_finality: 6,
                card_value: CARD,
            },
            ..Default::default()
        }
    }

    fn seeded(config: IndexerConfig) -> Indexer {
        let mut idx = Indexer::new(config);
        // Funding for the mint, the hop, and the hop's change.
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + CARD)]);
        idx
    }

    /// A v7 mint: the mint envelope at `0x07`, output 0 carrying
    /// `[SAT, SAT+CARD)`. Inscription enforcement is off in these tests, so
    /// the mint is lenient but still stamped with its generation.
    fn mint_v7(txid: u8) -> Tx {
        let payload = envelope(Action::Mint, &encode_mint(0xABCD, "Frog"));
        tx_of(
            txid,
            vec![input(1, 0, CARD)],
            vec![
                out(CARD),
                TxOut {
                    value: 0,
                    op_return: Some(payload),
                },
            ],
        )
    }

    fn body(dir: u8) -> hopper_core::StateBody {
        hopper_core::StateBody {
            sat: SAT,
            mint_txid: b32(MINT_TXID),
            mint_index: MINT_INDEX,
            dir,
        }
    }

    /// The canonical v7 crossing leaf and its 97-byte control block (the
    /// control path is rebuilt from the four leaf hashes, exactly as the
    /// indexer checks it).
    fn state_reveal(dir: u8) -> crate::types::InscriptionReveal {
        let b = body(dir);
        let script = hopper_core::state_leaf_script(&OWNER, &b);
        let hashes = hopper_core::state_leaf_hashes(&OWNER, &b);
        let path = hopper_core::control_path(&hashes, dir);
        let control = hopper_core::control_block(&NUMS_XONLY, &path, 1);
        crate::types::InscriptionReveal {
            content_type: "application/octet-stream".into(),
            body_hash: [0u8; 32],
            inscription_id: format!("{}i0", "00".repeat(32)),
            body: Some(hopper_core::encode_state_body(&b).to_vec()),
            parents: vec![encode_parent_tag(&b.mint_txid, b.mint_index)],
            tapscript: Some(script),
            control_block: Some(control),
        }
    }

    fn cross_v7_tx(idx: &Indexer, txid: u8, dir: u8) -> Tx {
        let frog = idx.frogger(SAT).expect("frog");
        let frog_outpoint = match frog.location {
            SatLocation::Tracked(outpoint) => outpoint,
            SatLocation::Burned => panic!("frog burned"),
        };
        let mut frog_input = input(1, 0, CARD);
        frog_input.prevout = frog_outpoint;
        frog_input.inscription = Some(state_reveal(dir));
        tx_of(txid, vec![frog_input], vec![out(CARD - 1_000)])
    }

    fn minted_v7() -> Indexer {
        let mut idx = seeded(config());
        idx.apply_block(block_of(100, 1, vec![mint_v7(MINT_TXID)]))
            .unwrap();
        idx
    }

    #[test]
    fn a_v7_mint_carries_its_generation_and_hops_in_one_tx() {
        let mut idx = minted_v7();
        let minted = idx.frogger(SAT).unwrap();
        assert_eq!(minted.wire_version, hopper_core::params::VERSION_V7);
        assert_eq!(minted.gen, 26, "generation(100) under the fixture");
        let report = idx
            .apply_block(block_of(101, 2, vec![cross_v7_tx(&idx, 3, 0)]))
            .unwrap();
        assert!(report.rejections.is_empty(), "{:?}", report.rejections);
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.state, FroggerState::Crossing);
        assert_eq!(frog.location, SatLocation::Tracked(op(3, 0)));
        assert_eq!(frog.crossings_entered, 1);
        assert_eq!(frog.in_flight.unwrap().dir, 0);
        assert_eq!(frog.gen, 26, "the label never changes");
    }

    #[test]
    fn a_cross_without_the_mint_parent_is_rejected() {
        let mut idx = minted_v7();
        let frog_outpoint = match idx.frogger(SAT).unwrap().location {
            SatLocation::Tracked(o) => o,
            _ => panic!("frog"),
        };
        let mut reveal = state_reveal(1);
        reveal.parents.clear();
        let mut frog_input = input(1, 0, CARD);
        frog_input.prevout = frog_outpoint;
        frog_input.inscription = Some(reveal);
        let tx = tx_of(3, vec![frog_input], vec![out(CARD - 1_000)]);
        let report = idx.apply_block(block_of(101, 2, vec![tx])).unwrap();
        assert!(
            report
                .rejections
                .iter()
                .any(|r| r.reason == RejectionReason::CrossParentMismatch),
            "{:?}",
            report.rejections
        );
        assert_eq!(idx.frogger(SAT).unwrap().state, FroggerState::Idle);
    }

    #[test]
    fn a_body_with_dir_above_two_is_rejected() {
        let mut idx = minted_v7();
        let frog_outpoint = match idx.frogger(SAT).unwrap().location {
            SatLocation::Tracked(o) => o,
            _ => panic!("frog"),
        };
        let mut reveal = state_reveal(0);
        let mut raw = hopper_core::encode_state_body(&body(0)).to_vec();
        raw[54] = 9;
        reveal.body = Some(raw);
        let mut frog_input = input(1, 0, CARD);
        frog_input.prevout = frog_outpoint;
        frog_input.inscription = Some(reveal);
        let tx = tx_of(3, vec![frog_input], vec![out(CARD - 1_000)]);
        let report = idx.apply_block(block_of(101, 2, vec![tx])).unwrap();
        assert!(
            report
                .rejections
                .iter()
                .any(|r| r.reason == RejectionReason::CrossBadDirection),
            "{:?}",
            report.rejections
        );
    }

    #[test]
    fn the_spent_leaf_must_be_the_leaf_for_the_bodys_direction() {
        // The body says left (0) but the script is the right leaf: the
        // witness cannot be replayed with a different direction.
        let mut idx = minted_v7();
        let frog_outpoint = match idx.frogger(SAT).unwrap().location {
            SatLocation::Tracked(o) => o,
            _ => panic!("frog"),
        };
        let mut reveal = state_reveal(0);
        let b = body(0);
        let hs = hopper_core::state_leaf_hashes(&OWNER, &b);
        reveal.tapscript = Some(hopper_core::cross_leaf_script(&OWNER, &b, 2));
        reveal.control_block = Some(hopper_core::control_block(
            &NUMS_XONLY,
            &hopper_core::control_path(&hs, 2),
            1,
        ));
        let mut frog_input = input(1, 0, CARD);
        frog_input.prevout = frog_outpoint;
        frog_input.inscription = Some(reveal);
        let tx = tx_of(3, vec![frog_input], vec![out(CARD - 1_000)]);
        let report = idx.apply_block(block_of(101, 2, vec![tx])).unwrap();
        assert!(
            report
                .rejections
                .iter()
                .any(|r| r.reason == RejectionReason::CrossDirectionMismatch),
            "{:?}",
            report.rejections
        );
    }

    #[test]
    fn a_death_is_final_and_recorded_with_dir_and_wrap() {
        let mut idx = minted_v7();
        // Commit to dir 2 and make the next block wrap right.
        idx.apply_block(block_of(101, 2, vec![cross_v7_tx(&idx, 3, 2)]))
            .unwrap();
        let lethal = hash_with_wrap(2);
        let report = idx
            .apply_block(block_with_hash(102, lethal, vec![]))
            .unwrap();
        assert_eq!(idx.frogger(SAT).unwrap().provisional_dead, Some(true));
        assert_eq!(idx.frogger(SAT).unwrap().outcome_wrap, Some(2));
        for height in 103..107 {
            idx.apply_block(block_of(height, height as u8, vec![]))
                .unwrap();
        }
        let report2 = idx.apply_block(block_of(107, 200, vec![])).unwrap();
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.state, FroggerState::Dead);
        assert_eq!(frog.deaths, 1);
        assert_eq!(frog.death_height, Some(101));
        assert_eq!(frog.dist, 0, "death never advances");
        assert_eq!(frog.crossings_settled, 1);
        let settle = report2
            .events
            .iter()
            .find_map(|e| match &e.action {
                EventAction::Settle {
                    frogger_sat,
                    outcome,
                    dir,
                    wrap,
                } => Some((*frogger_sat, *outcome, *dir, *wrap)),
                _ => None,
            })
            .expect("settle event");
        assert_eq!(settle, (SAT, SettleOutcome::Dead, 2, Some(2)));
        let _ = report;
    }

    #[test]
    fn the_wrap_is_global_and_shared_by_every_frog_in_the_block() {
        // Two frogs hop in one block, both picking straight. They are two
        // transactions (one inscription each) but one wrap judges them.
        let mut idx = seeded(config());
        idx.seed_utxo(
            op(5, 0),
            vec![SatRange::new(SAT + CARD + 1, SAT + 2 * CARD + 1)],
        );
        idx.apply_block(block_of(100, 1, vec![mint_v7(MINT_TXID)]))
            .unwrap();
        let payload = envelope(Action::Mint, &encode_mint(7, "Toad"));
        let second = tx_of(
            4,
            vec![input(5, 0, CARD)],
            vec![
                out(CARD),
                TxOut {
                    value: 0,
                    op_return: Some(payload),
                },
            ],
        );
        idx.apply_block(block_of(101, 2, vec![second])).unwrap();
        let second_sat = SAT + CARD + 1;

        let a = cross_v7_tx(&idx, 3, 1);
        let frog_b = idx.frogger(second_sat).unwrap();
        let mut b_input = input(1, 0, CARD);
        b_input.prevout = match frog_b.location {
            SatLocation::Tracked(o) => o,
            _ => panic!("b"),
        };
        let mut b_body = body(1);
        b_body.sat = second_sat;
        b_body.mint_txid = b32(4);
        let script = hopper_core::state_leaf_script(&OWNER, &b_body);
        let hs = hopper_core::state_leaf_hashes(&OWNER, &b_body);
        b_input.inscription = Some(crate::types::InscriptionReveal {
            content_type: "application/octet-stream".into(),
            body_hash: [0u8; 32],
            inscription_id: format!("{}i0", "00".repeat(32)),
            body: Some(hopper_core::encode_state_body(&b_body).to_vec()),
            parents: vec![encode_parent_tag(&b_body.mint_txid, b_body.mint_index)],
            tapscript: Some(script),
            control_block: Some(hopper_core::control_block(
                &NUMS_XONLY,
                &hopper_core::control_path(&hs, 1),
                1,
            )),
        });
        let b = tx_of(5, vec![b_input], vec![out(CARD - 1_000)]);
        let report = idx.apply_block(block_of(102, 3, vec![a, b])).unwrap();
        assert!(report.rejections.is_empty(), "{:?}", report.rejections);
        idx.apply_block(block_with_hash(103, hash_with_wrap(1), vec![]))
            .unwrap();
        for (i, sat) in [SAT, second_sat].iter().enumerate() {
            let frog = idx.frogger(*sat).unwrap();
            assert_eq!(frog.in_flight.map(|f| f.dir), Some(1), "frog {i}");
            assert_eq!(frog.provisional_dead, Some(true), "frog {i}");
            assert_eq!(frog.outcome_wrap, Some(1), "frog {i}");
        }
    }

    #[test]
    fn a_second_cross_while_crossing_is_rejected() {
        let mut idx = minted_v7();
        idx.apply_block(block_of(101, 2, vec![cross_v7_tx(&idx, 3, 0)]))
            .unwrap();
        let tx = cross_v7_tx(&idx, 4, 0);
        let report = idx.apply_block(block_of(102, 3, vec![tx])).unwrap();
        assert!(report
            .rejections
            .iter()
            .any(|r| r.reason == RejectionReason::CrossWhileCrossing));
    }

    #[test]
    fn three_survived_crossings_make_the_hopper_immortal() {
        let mut idx = Indexer::new(home3_config());
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + CARD)]);
        idx.apply_block(block_of(100, 1, vec![mint_v7(MINT_TXID)]))
            .unwrap();
        let mut height = 101u32;
        let mut txid = 3u8;
        for hop in 1..=3u32 {
            let dir = 0u8;
            idx.apply_block(block_of(height, txid, vec![cross_v7_tx(&idx, txid, dir)]))
                .unwrap();
            let target = idx.frogger(SAT).unwrap().in_flight.unwrap().target_hops;
            assert_eq!(target, 3);
            idx.apply_block(block_with_hash(
                height + 1,
                hash_that_is_not(dir),
                vec![],
            ))
            .unwrap();
            for h in height + 2..height + 6 {
                idx.apply_block(block_of(h, h as u8, vec![])).unwrap();
            }
            idx.apply_block(block_of(height + 6, 200 + hop as u8, vec![]))
                .unwrap();
            height += 7;
            txid = txid.wrapping_add(1);
            let frog = idx.frogger(SAT).unwrap();
            assert_eq!(frog.dist, hop);
            if hop < 3 {
                assert_eq!(frog.state, FroggerState::Idle);
            }
        }
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.state, FroggerState::Home);
        assert_eq!(frog.dist, 3);
        assert_eq!(frog.immortal_height, Some(height - 7));
        // Immortal is absorbing.
        let report = idx
            .apply_block(block_of(height, 7, vec![cross_v7_tx(&idx, 9, 0)]))
            .unwrap();
        assert!(report
            .rejections
            .iter()
            .any(|r| r.reason == RejectionReason::CrossOnHomeFrog));
    }

    #[test]
    fn the_target_is_frozen_at_the_hop_height_across_a_generation_reset() {
        // Fixture: required(1) = 2, required(2) = 3, required(4) = 1.
        let mut idx = seeded(config());
        idx.apply_block(block_of(0, 1, vec![mint_v7(MINT_TXID)]))
            .unwrap();
        idx.apply_block(block_of(1, 2, vec![cross_v7_tx(&idx, 3, 0)]))
            .unwrap();
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.in_flight.unwrap().target_hops, 2);
        assert_eq!(idx.config().params.generations.required(4), 1);
    }

    #[test]
    fn params_hash_changes_the_state_identity() {
        let fixture = seeded(config());
        let mut other = config();
        other.params = PROTOCOL;
        let production = seeded(other);
        assert_ne!(
            params_hash(&PROTOCOL),
            params_hash(&ProtocolParams::fixture_fast())
        );
        assert_ne!(fixture.state_root(), production.state_root());
    }

    #[test]
    fn a_reorg_reopens_the_crossing_and_freezes_a_new_target() {
        // Fixture: required(101) = 2, required(102) = 3.
        let mut idx = Indexer::new(config());
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + CARD)]);
        idx.apply_block(block_of(100, 1, vec![mint_v7(MINT_TXID)]))
            .unwrap();

        idx.apply_block(block_of(101, 2, vec![cross_v7_tx(&idx, 3, 1)]))
            .unwrap();
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.in_flight.expect("in flight").target_hops, 2);
        idx.apply_block(block_of(102, 9, vec![])).unwrap();
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.outcome_block_hash, Some(b32(9)));
        assert_eq!(frog.outcome_wrap, Some(wrap(&b32(9))));

        // Undo T+1: the provisional outcome goes away, the hop stays.
        idx.rollback(1).unwrap();
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.state, FroggerState::Crossing);
        assert!(frog.outcome_block_hash.is_none());
        assert!(frog.outcome_wrap.is_none());
        assert!(frog.provisional_dead.is_none());
        assert_eq!(frog.in_flight.expect("still in flight").height, 101);

        // Undo T as well: the Hopper is Idle again and its card is restored.
        idx.rollback(1).unwrap();
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.state, FroggerState::Idle);
        assert!(frog.in_flight.is_none());
        assert_eq!(frog.crossings_entered, 0);
        assert_eq!(frog.dist, 0);
        assert_eq!(idx.utxo_count(), 1, "the Hopper's card is back");

        // Replace 101 with an empty block, then hop at 102: the target is
        // evaluated at the *new* T, so it is 3, not the old 2.
        idx.apply_block(block_of(101, 7, vec![])).unwrap();
        idx.apply_block(block_of(102, 8, vec![cross_v7_tx(&idx, 4, 1)]))
            .unwrap();
        let frog = idx.frogger(SAT).unwrap();
        let in_flight = frog.in_flight.expect("new crossing");
        assert_eq!(in_flight.height, 102);
        assert_eq!(in_flight.target_hops, 3);
        assert_eq!(frog.last_target_hops, Some(3));

        // The new outcome hash is the new T+1 block's, and settlement is
        // still T + cross_finality = 108, not 107.
        idx.apply_block(block_of(103, 11, vec![])).unwrap();
        assert_eq!(idx.frogger(SAT).unwrap().outcome_block_hash, Some(b32(11)));
        for height in 104..=107u32 {
            idx.apply_block(block_of(height, (height - 92) as u8, vec![]))
                .unwrap();
        }
        assert_eq!(idx.frogger(SAT).unwrap().state, FroggerState::Crossing);
        idx.apply_block(block_of(108, 13, vec![])).unwrap();
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.crossings_settled, 1);
        // Settlement either crossed or died; both are deterministic.
        assert!(matches!(frog.state, FroggerState::Idle | FroggerState::Dead));
    }

    #[test]
    fn a_cross_on_a_burned_frog_is_rejected_as_burned() {
        let mut idx = minted_v7();
        idx.apply_block(block_of(
            101,
            2,
            vec![tx_of(9, vec![input(MINT_TXID, 0, CARD)], vec![out(0)])],
        ))
        .unwrap();
        let burned = idx.frogger(SAT).unwrap();
        assert_eq!(burned.state, FroggerState::Burned);
        assert_eq!(burned.burn_txid, Some(b32(9)));

        let mut card_input = input(MINT_TXID, 0, CARD);
        card_input.inscription = Some(state_reveal(0));
        let tx = tx_of(10, vec![card_input], vec![out(CARD - 1_000)]);
        let report = idx.apply_block(block_of(102, 3, vec![tx])).unwrap();
        assert!(
            report
                .rejections
                .iter()
                .any(|r| r.reason == crate::types::RejectionReason::CrossOnBurnedFrog),
            "rejections: {:?}",
            report.rejections
        );
    }

    #[test]
    fn a_crossing_survives_a_snapshot_restore_at_the_capture_block() {
        let mut idx = minted_v7();
        idx.apply_block(block_of(101, 2, vec![cross_v7_tx(&idx, 3, 1)]))
            .unwrap();
        idx.apply_block(block_of(102, 3, vec![])).unwrap();
        for height in 103..=105u32 {
            idx.apply_block(block_of(height, (height - 99) as u8, vec![]))
                .unwrap();
        }
        let captured = idx.frogger(SAT).unwrap();
        assert_eq!(captured.in_flight.map(|f| f.height), Some(101));
        assert!(captured.outcome_block_hash.is_some(), "capture stored");
        assert!(captured.outcome_wrap.is_some(), "wrap stored");
        assert!(captured.provisional_dead.is_some(), "outcome frozen");

        let mut restored = Indexer::restore(idx.snapshot()).unwrap();
        let rec = restored.frogger(SAT).unwrap();
        assert_eq!(rec.in_flight.map(|f| f.height), Some(101));
        assert_eq!(rec.in_flight.map(|f| f.dir), Some(1));
        assert_eq!(rec.outcome_block_hash, captured.outcome_block_hash);
        assert_eq!(rec.outcome_wrap, captured.outcome_wrap);
        assert_eq!(rec.provisional_dead, captured.provisional_dead);

        let finality = idx.config().params.cross_finality;
        for height in 106..=(101 + finality) {
            restored
                .apply_block(block_of(height, (height - 99) as u8, vec![]))
                .unwrap();
        }
        let settled = restored.frogger(SAT).unwrap();
        assert!(
            settled.in_flight.is_none(),
            "settled exactly once: {settled:?}"
        );
        assert_eq!(settled.crossings_settled, 1);
        assert_eq!(
            settled.state,
            if captured.provisional_dead == Some(true) {
                FroggerState::Dead
            } else {
                FroggerState::Idle
            }
        );
    }

    #[test]
    fn a_frog_burned_mid_crossing_settles_burned_without_advancing() {
        let mut idx = minted_v7();
        idx.apply_block(block_of(101, 2, vec![cross_v7_tx(&idx, 3, 0)]))
            .unwrap();
        let frog = idx.frogger(SAT).unwrap();
        let frog_outpoint = match frog.location {
            SatLocation::Tracked(outpoint) => outpoint,
            SatLocation::Burned => panic!("not burned yet"),
        };
        idx.apply_block(block_of(
            102,
            3,
            vec![tx_of(
                7,
                vec![TxInput {
                    prevout: frog_outpoint,
                    value: CARD - 1_000,
                    inscription: None,
                }],
                vec![out(0)],
            )],
        ))
        .unwrap();
        let burned = idx.frogger(SAT).unwrap();
        assert_eq!(burned.location, SatLocation::Burned);
        assert_eq!(burned.burn_height, Some(102));
        assert_eq!(burned.burn_txid, Some([7u8; 32]));
        for height in 103..=107u32 {
            idx.apply_block(block_of(height, (height - 99) as u8, vec![]))
                .unwrap();
        }
        let record = idx.frogger(SAT).unwrap();
        assert_eq!(record.state, FroggerState::Burned);
        assert_eq!(record.dist, 0, "a burn never advances the road");
        assert_eq!(record.crossings_settled, 1);
        assert!(record.death_height.is_none(), "burned is not dead");
    }
}
