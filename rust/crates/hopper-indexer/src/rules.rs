//! The FROGGER v6 consensus rules — the whole rule set.
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
//! a crossing is a state inscription on the frog's own sat.

use crate::consensus::ConsensusState;
use crate::state_machine::BlockSink;
use crate::types::{
    EventAction, FroggerRecord, FroggerState, InFlight, MoveDest, RejectionReason, SatLocation,
    SettleOutcome, Tx, TxFlow,
};
use hopper_core::params::{ProtocolParams, NUMS_XONLY};
use hopper_core::settle::dies_v3;

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

/// v6 state leaf shape: NUMS internal key, two leaves, a 65-byte control
/// block, and exactly one envelope (V6 §2, §8).
fn state_shape_ok(ins: &crate::types::InscriptionReveal) -> bool {
    let (Some(control), Some(script)) = (&ins.control_block, &ins.tapscript) else {
        return false;
    };
    if control.len() != 65 || control[0] & 0xfe != 0xc0 {
        return false;
    }
    if control[1..33] != NUMS_XONLY {
        return false;
    }
    if script.len() < 36 || script[0] != 0x20 || script[33] != 0xad || script[34] != 0x00 {
        return false;
    }
    if script[35] != 0x63 || !script.ends_with(&[0x68, 0x51]) {
        return false;
    }
    hopper_core::parse_inscriptions(script).len() == 1
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

    // 2. Canonical v6 body, bound to this frog.
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

    // 3. The parent is NOT optional in v6: it is the mint link the fold
    //    walks. Missing or wrong is a rejection, never a drop.
    let parent = ins
        .parents
        .first()
        .ok_or(RejectionReason::CrossParentMismatch)?;
    if hopper_core::decode_parent_tag(parent) != Ok((body.mint_txid, body.mint_index)) {
        return Err(RejectionReason::CrossParentMismatch);
    }

    // 4. Input 0 is the frog and its leaf is the standard state template.
    if !state_shape_ok(ins) {
        return Err(RejectionReason::CrossTicketShape);
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
    debug_assert!(params.hops.required(height) <= params.hops.ceiling);
    Ok(body.sat)
}

/// `Idle → Crossing` (§4.3): the movement already updated `location`.
pub(crate) fn begin_crossing<S: ConsensusState + ?Sized>(
    state: &mut S,
    tx: &Tx,
    frog: &FroggerRecord,
    height: u32,
    params: &ProtocolParams,
) {
    let target_hops = params.hops.required(height);
    state.journal_frog(frog.sat);
    state.with_frog(frog.sat, &mut |slot| {
        if let Some(record) = slot {
            record.state = FroggerState::Crossing;
            record.crossings_entered += 1;
            record.in_flight = Some(InFlight {
                txid: tx.txid,
                height,
                target_hops,
            });
            record.last_target_hops = Some(target_hops);
            // A new crossing clears the previous outcome: it belongs to
            // the previous settlement and must not be reused.
            record.outcome_block_hash = None;
            record.provisional_dead = None;
        }
    });
}

/// `B = T+1` connects: freeze the outcome (§5.2). Runs before the block's
/// transactions because `H(B)` is known before execution.
pub(crate) fn capture_outcome<S: ConsensusState + ?Sized>(
    state: &mut S,
    height: u32,
    block_hash: [u8; 32],
) -> Result<(), crate::store::StoreError> {
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
                    record.provisional_dead =
                        Some(dies_v3(sat, &block_hash, in_flight.target_hops));
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
        sink.event(
            None,
            EventAction::Settle {
                frogger_sat: sat,
                outcome,
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
    use hopper_core::params::{params_hash, ProtocolParams, PROTOCOL};
    use hopper_core::satmath::SatRange;
    use hopper_core::settle::dies_v3;

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

    fn config() -> IndexerConfig {
        IndexerConfig {
            params: ProtocolParams::fixture_fast(),
            ..Default::default()
        }
    }

    fn seeded(config: IndexerConfig) -> Indexer {
        let mut idx = Indexer::new(config);
        // Funding for the mint, the ticket, and the ticket's change.
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + CARD)]);
        idx
    }

    /// A v6 mint: the mint envelope at `0x06`, output 0 carrying `[SAT, SAT+CARD)`.
    fn mint_v6(txid: u8) -> Tx {
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

    /// The v6 state leaf and its 65-byte (two-leaf) control block.
    fn state_reveal(body: &hopper_core::StateBody) -> crate::types::InscriptionReveal {
        let script = hopper_core::state_leaf_script(&[0x11; 32], body);
        let mut control = vec![0xc1];
        control.extend_from_slice(&NUMS_XONLY);
        control.extend_from_slice(&[0x22; 32]); // sibling leaf hash
        crate::types::InscriptionReveal {
            content_type: "application/octet-stream".into(),
            body_hash: [0u8; 32],
            inscription_id: format!("{}i0", "00".repeat(32)),
            body: Some(hopper_core::encode_state_body(body).to_vec()),
            parents: vec![encode_parent_tag(&body.mint_txid, body.mint_index)],
            tapscript: Some(script),
            control_block: Some(control),
        }
    }

    fn cross_v6_tx(idx: &Indexer, txid: u8) -> Tx {
        let frog = idx.frogger(SAT).expect("frog");
        let frog_outpoint = match frog.location {
            SatLocation::Tracked(outpoint) => outpoint,
            SatLocation::Burned => panic!("frog burned"),
        };
        let body = hopper_core::StateBody {
            sat: SAT,
            mint_txid: b32(MINT_TXID),
            mint_index: MINT_INDEX,
        };
        let mut frog_input = input(1, 0, CARD);
        frog_input.prevout = frog_outpoint;
        frog_input.inscription = Some(state_reveal(&body));
        tx_of(txid, vec![frog_input], vec![out(CARD - 1_000)])
    }

    fn minted_v6() -> Indexer {
        let mut idx = seeded(config());
        idx.apply_block(block_of(100, 1, vec![mint_v6(MINT_TXID)]))
            .unwrap();
        idx
    }

    #[test]
    fn a_v6_mint_crosses_in_one_tx_with_the_sat_in_output_zero() {
        let mut idx = minted_v6();
        assert_eq!(
            idx.frogger(SAT).unwrap().wire_version,
            hopper_core::params::VERSION_V6
        );
        let report = idx
            .apply_block(block_of(101, 2, vec![cross_v6_tx(&idx, 3)]))
            .unwrap();
        assert!(report.rejections.is_empty(), "{:?}", report.rejections);
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.state, FroggerState::Crossing);
        assert_eq!(frog.location, SatLocation::Tracked(op(3, 0)));
        // A ticket-shaped (33-byte control block) envelope is refused.
        assert_eq!(frog.crossings_entered, 1);
    }

    #[test]
    fn a_v6_cross_without_the_mint_parent_is_rejected() {
        let mut idx = minted_v6();
        let frog_outpoint = match idx.frogger(SAT).unwrap().location {
            SatLocation::Tracked(o) => o,
            _ => panic!("frog"),
        };
        let body = hopper_core::StateBody {
            sat: SAT,
            mint_txid: b32(MINT_TXID),
            mint_index: MINT_INDEX,
        };
        let mut reveal = state_reveal(&body);
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
    fn a_death_is_final_and_recorded() {
        let mut idx = minted_v6();
        idx.apply_block(block_of(101, 2, vec![cross_v6_tx(&idx, 3)]))
            .unwrap();
        // Pick B = 102 with a hash that kills (fixture target 3, 2.69 %).
        let lethal = (1u8..=255)
            .map(b32)
            .find(|hash| dies_v3(SAT, hash, 3))
            .expect("some hash kills at ~3 %");
        idx.apply_block(block_of(102, 0, vec![])).unwrap(); // placeholder hash
                                                            // Reorg the outcome block: undo 102 and re-apply with the lethal hash.
        idx.rollback(1).unwrap();
        let block = Block {
            hash: lethal,
            height: 102,
            txs: vec![],
        };
        idx.apply_block(block).unwrap();
        assert_eq!(idx.frogger(SAT).unwrap().provisional_dead, Some(true));
        for height in 103..107 {
            idx.apply_block(block_of(height, height as u8, vec![]))
                .unwrap();
        }
        idx.apply_block(block_of(107, 200, vec![])).unwrap();
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.state, FroggerState::Dead);
        assert_eq!(frog.deaths, 1);
        assert_eq!(frog.death_height, Some(101));
        assert_eq!(frog.dist, 0, "death never advances");
        assert_eq!(frog.crossings_settled, 1);
    }

    #[test]
    fn a_second_cross_while_crossing_is_rejected() {
        let mut idx = minted_v6();
        idx.apply_block(block_of(101, 2, vec![cross_v6_tx(&idx, 3)]))
            .unwrap();
        let tx = cross_v6_tx(&idx, 4);
        let report = idx.apply_block(block_of(102, 3, vec![tx])).unwrap();
        assert!(report
            .rejections
            .iter()
            .any(|r| r.reason == RejectionReason::CrossWhileCrossing));
    }

    #[test]
    fn three_survived_crossings_make_the_frog_immortal() {
        let mut idx = minted_v6();
        let mut height = 101u32;
        let mut txid = 3u8;
        for hop in 1..=3u32 {
            // Force a surviving outcome: roll back the outcome block until
            // its hash is not lethal (deterministic, small search).
            idx.apply_block(block_of(height, txid, vec![cross_v6_tx(&idx, txid)]))
                .unwrap();
            let target = idx.frogger(SAT).unwrap().in_flight.unwrap().target_hops;
            let mut hash = 10u8;
            while dies_v3(SAT, &b32(hash), target) {
                hash = hash.wrapping_add(1);
            }
            idx.apply_block(block_of(height + 1, hash, vec![])).unwrap();
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
            .apply_block(block_of(height, 7, vec![cross_v6_tx(&idx, 9)]))
            .unwrap();
        assert!(report
            .rejections
            .iter()
            .any(|r| r.reason == RejectionReason::CrossOnHomeFrog));
    }

    #[test]
    fn the_target_is_frozen_at_the_cross_height() {
        // The fixture schedule reaches its cap at height 2; a crossing at
        // height 1 freezes target 2 even though later heights require 3.
        let mut idx = seeded(config());
        idx.apply_block(block_of(0, 1, vec![mint_v6(MINT_TXID)]))
            .unwrap();
        idx.apply_block(block_of(1, 2, vec![cross_v6_tx(&idx, 3)]))
            .unwrap();
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.in_flight.unwrap().target_hops, 2);
        assert_eq!(idx.config().params.hops.required(100), 3);
    }

    #[test]
    fn params_hash_changes_the_state_identity() {
        // Two identical chains under different schedules must not be able
        // to share a state root (V3 §8.6).
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

    #[cfg(feature = "redb")]
    fn mem_state_root_after_mint() -> [u8; 32] {
        minted_v6().state_root()
    }

    #[cfg(feature = "redb")]
    #[test]
    fn the_store_backed_engine_runs_the_same_chain() {
        use crate::state_machine::Indexer;
        use crate::store::redb_store::RedbStore;
        use crate::store_state::StoreState;
        use std::sync::Arc;

        let dir = std::env::temp_dir().join(format!("frogger-v3-store-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // One chain, built on the memory oracle first so the expected
        // roots come from the reference implementation.
        let mut mem = minted_v6();
        let mut blocks = vec![
            block_of(101, 2, vec![cross_v6_tx(&mem, 3)]),
            block_of(102, 9, vec![]),
        ];
        // Settle at T+6 = 107, with empty blocks in between.
        for height in 103..=107u32 {
            blocks.push(block_of(height, height as u8, vec![]));
        }
        let mut roots = Vec::new();
        for block in &blocks {
            mem.apply_block(block.clone()).unwrap();
            roots.push(mem.state_root());
        }

        let mut st: Indexer<StoreState> = Indexer::from_loaded_state(
            StoreState::new(
                config(),
                Arc::new(RedbStore::create(&dir.join("v3.redb")).expect("store opens")),
            )
            .expect("state"),
            Vec::new(),
        );
        st.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + CARD)]);
        let mint = block_of(100, 1, vec![mint_v6(MINT_TXID)]);
        let (_, effects, write) = st.apply_block_recorded(mint).unwrap();
        st.state_mut().commit(&write, &effects).unwrap();
        assert_eq!(st.state_root(), mem_state_root_after_mint(), "mint root");
        for (index, block) in blocks.iter().enumerate() {
            let (_, effects, write) = st.apply_block_recorded(block.clone()).unwrap();
            st.state_mut().commit(&write, &effects).unwrap();
            assert_eq!(
                st.state_root(),
                roots[index],
                "v3 root diverged at height {}",
                block.height
            );
        }
        // Timers and the crossing record survive in the store.
        let frog = st.state().frog(SAT).expect("frog in store");
        assert_eq!(mem.frogger(SAT), Some(&frog));
        assert_eq!(frog.crossings_settled, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A schedule whose requirement still moves at heights 101/102
    /// (`genesis = 100`, one hop per two blocks).
    fn slow_config() -> IndexerConfig {
        IndexerConfig {
            params: ProtocolParams {
                hops: hopper_core::params::HopParams {
                    genesis: 100,
                    base: 1,
                    step1: 2,
                    until1: 50,
                    step2: 2,
                    until2: 50,
                    step3: 2,
                    ceiling: 50,
                },
                death: hopper_core::params::DeathModel::Flat25,
                success_floor_bps: 500,
                cross_finality: 6,
                card_value: CARD,
            },
            ..Default::default()
        }
    }

    #[test]
    fn a_reorg_reopens_the_crossing_and_freezes_a_new_target() {
        let mut idx = Indexer::new(slow_config());
        idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + CARD)]);
        idx.apply_block(block_of(100, 1, vec![mint_v6(MINT_TXID)]))
            .unwrap();

        // T = 101, target 1; T+1 = 102 captures the outcome.
        idx.apply_block(block_of(101, 2, vec![cross_v6_tx(&idx, 3)]))
            .unwrap();
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.in_flight.expect("in flight").target_hops, 1);
        idx.apply_block(block_of(102, 9, vec![])).unwrap();
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.outcome_block_hash, Some(b32(9)));

        // Undo T+1: the provisional outcome goes away, the crossing stays.
        idx.rollback(1).unwrap();
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.state, FroggerState::Crossing);
        assert!(frog.outcome_block_hash.is_none());
        assert!(frog.provisional_dead.is_none());
        assert_eq!(frog.in_flight.expect("still in flight").height, 101);

        // Undo T as well: the frog is Idle again and its card is restored.
        idx.rollback(1).unwrap();
        let frog = idx.frogger(SAT).unwrap();
        assert_eq!(frog.state, FroggerState::Idle);
        assert!(frog.in_flight.is_none());
        assert_eq!(frog.crossings_entered, 0);
        assert_eq!(frog.dist, 0);
        assert_eq!(idx.utxo_count(), 1, "the frog's card is back");

        // Replace 101 with an empty block, then cross at 102: the target is
        // evaluated at the *new* T (§3.4), so it is 2, not the old 1.
        idx.apply_block(block_of(101, 7, vec![])).unwrap();
        idx.apply_block(block_of(102, 8, vec![cross_v6_tx(&idx, 4)]))
            .unwrap();
        let frog = idx.frogger(SAT).unwrap();
        let in_flight = frog.in_flight.expect("new crossing");
        assert_eq!(in_flight.height, 102);
        assert_eq!(in_flight.target_hops, 2);
        assert_eq!(frog.last_target_hops, Some(2));

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
        assert_eq!(frog.state, FroggerState::Idle);
        assert_eq!(frog.crossings_settled, 1);
    }

    /// A block hash unique over a few thousand synthetic blocks.
    #[test]
    fn a_cross_on_a_burned_frog_is_rejected_as_burned() {
        // Once the card is in fees there is nothing left to cross, and
        // the reason must say so (`CrossOnBurnedFrog`), not "not idle".
        let mut idx = minted_v6();
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
        card_input.inscription = Some(state_reveal(&hopper_core::StateBody {
            sat: SAT,
            mint_txid: b32(MINT_TXID),
            mint_index: MINT_INDEX,
        }));
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
        // The restart legs kill the process inside the settlement
        // window. The restored state must carry the in-flight
        // crossing AND the captured outcome; losing either turns the
        // settle into a guess (or drops it entirely).
        let mut idx = minted_v6();
        idx.apply_block(block_of(101, 2, vec![cross_v6_tx(&idx, 3)]))
            .unwrap();
        idx.apply_block(block_of(102, 3, vec![])).unwrap();
        // A snapshot a few blocks later (the e2e kill lands here) must
        // carry the same state as one at the capture.
        for height in 103..=105u32 {
            idx.apply_block(block_of(height, (height - 99) as u8, vec![]))
                .unwrap();
        }
        let captured = idx.frogger(SAT).unwrap();
        assert_eq!(captured.in_flight.map(|f| f.height), Some(101));
        assert!(captured.outcome_block_hash.is_some(), "capture stored");
        assert!(captured.provisional_dead.is_some(), "outcome frozen");

        let mut restored = Indexer::restore(idx.snapshot()).unwrap();
        let rec = restored.frogger(SAT).unwrap();
        assert_eq!(rec.in_flight.map(|f| f.height), Some(101));
        assert_eq!(rec.outcome_block_hash, captured.outcome_block_hash);
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
        let mut idx = minted_v6();
        idx.apply_block(block_of(101, 2, vec![cross_v6_tx(&idx, 3)]))
            .unwrap();
        let frog = idx.frogger(SAT).unwrap();
        let frog_outpoint = match frog.location {
            SatLocation::Tracked(outpoint) => outpoint,
            SatLocation::Burned => panic!("not burned yet"),
        };
        // T+1: the sat is spent to fees, so the crossing has nowhere to land.
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
        assert_eq!(
            burned.location,
            SatLocation::Burned,
            "the tracker burns an unassignable sat"
        );
        // The burn is known at the spend, not at settlement.
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
