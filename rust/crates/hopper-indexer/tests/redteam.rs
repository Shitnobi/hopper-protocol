//! RED-TEAM adversarial test suite for the hopper-indexer pure core.
//!
//! These tests are written to BREAK the crate's stated invariants, not to
//! demonstrate them (the builder's own tests do that). Every test here is
//! an attack: absorbing states, envelope forgery, replay determinism, and
//! the inscription-backed mint surface. If the builder's tests and these
//! disagree, the builder is wrong.
//!
//! (The v2 car/REVEAL game is gone; its attack suite lived here and died
//! with the rules. The v3 crossing attacks live in `hopper-indexer`'s
//! `v3` unit tests and `tests/wire_matrix.rs`.)

use hopper_core::satmath::SatRange;
use hopper_core::{encode_mint, envelope, Action};
use hopper_indexer::state_machine::{Indexer, IndexerConfig};
use hopper_indexer::types::{Block, FroggerState, OutPoint, RejectionReason, Tx, TxInput, TxOut};

const SAT: u64 = 1_000;

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

fn mint_tx(txid: u8) -> Tx {
    let payload = envelope(Action::Mint, &encode_mint(0xABCD, "Victim"));
    tx_of(
        txid,
        vec![input(1, 0, 100)],
        vec![out(100), out_env(payload)],
    )
}

fn minted() -> Indexer {
    let mut idx = Indexer::new(IndexerConfig::default());
    idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
    idx.apply_block(block_of(100, 1, vec![mint_tx(2)])).unwrap();
    idx
}

fn move_tx(idx: &Indexer, txid: u8) -> Tx {
    let loc = idx.location(SAT).expect("frog located");
    tx_of(
        txid,
        vec![TxInput {
            prevout: loc,
            value: 100,
            inscription: None,
        }],
        vec![out(100)],
    )
}

fn empty_block(height: u32, hash: u8) -> Block {
    block_of(height, hash, vec![])
}

// ---------------------------------------------------------------------------
// Attack 1: an occupied sat can never be minted again
// ---------------------------------------------------------------------------

#[test]
fn attack_dead_sat_cannot_be_reminted() {
    let mut idx = minted();

    // A "fresh" mint tx on the same sat: re-spend wherever the frog
    // lives now into a new mint envelope with the same anchor semantics.
    let loc = idx.location(SAT).expect("frog still located");
    let payload = envelope(Action::Mint, &encode_mint(0xFFFF, "Necromancer"));
    let tx = tx_of(
        7,
        vec![TxInput {
            prevout: loc,
            value: 100,
            inscription: None,
        }],
        vec![out(100), out_env(payload)],
    );
    let report = idx.apply_block(block_of(101, 30, vec![tx])).unwrap();
    assert!(
        report
            .rejections
            .iter()
            .any(|r| r.reason == RejectionReason::MintSatInUse),
        "occupied sat re-minted: {report:?}"
    );
    let frog = idx.frogger(SAT).expect("original frog survives");
    assert_eq!(frog.state, FroggerState::Idle);
    assert_eq!(frog.seed, 0xABCD, "the original seed must not change");
}

// ---------------------------------------------------------------------------
// Attack 2: envelope abuse — more than one FRG push voids the whole tx
// ---------------------------------------------------------------------------

#[test]
fn attack_two_envelopes_in_one_tx_rejected() {
    let mut idx = minted();
    let p1 = envelope(Action::Mint, &encode_mint(0x1111, "First"));
    let p2 = envelope(Action::Mint, &encode_mint(0x2222, "Second"));
    let tx = tx_of(
        4,
        vec![input(200, 0, 500)],
        vec![out(500), out_env(p1), out_env(p2)],
    );
    let report = idx.apply_block(block_of(101, 10, vec![tx])).unwrap();
    assert!(
        report
            .rejections
            .iter()
            .any(|r| r.reason == RejectionReason::MultipleEnvelopes),
        "multi-envelope tx partially applied: {report:?}"
    );
    assert_eq!(idx.froggers().len(), 1, "no frog may be minted");
}

// ---------------------------------------------------------------------------
// Attack 3: state purity — same chain, same state, regardless of path
// ---------------------------------------------------------------------------

#[test]
fn attack_rollback_replay_determinism() {
    fn drive(idx: &mut Indexer) {
        let mv = move_tx(idx, 3);
        idx.apply_block(block_of(101, 10, vec![mv])).unwrap();
        let mv = move_tx(idx, 4);
        idx.apply_block(block_of(102, 11, vec![mv])).unwrap();
        idx.apply_block(empty_block(103, 12)).unwrap();
    }

    let mut a = minted();
    drive(&mut a);

    let mut b = minted();
    drive(&mut b);
    // Roll back 2 and replay identical blocks.
    b.rollback(2).unwrap();
    let mv = move_tx(&b, 4);
    b.apply_block(block_of(102, 11, vec![mv])).unwrap();
    b.apply_block(empty_block(103, 12)).unwrap();

    assert_eq!(
        a.frogger(SAT),
        b.frogger(SAT),
        "state diverged across replay paths"
    );
    assert_eq!(
        a.event_log(),
        b.event_log(),
        "event log diverged across replay paths"
    );
    assert_eq!(a.tip_hash(), b.tip_hash());
}

// ---- Change B (B.3.5): adversarial inscription-backed mints ----
//
// Attack surface: the indexer must not let a wallet mint a frog without
// paying for it in canonical art, smuggle foreign content types, park
// the reveal on a non-commit input, or reuse another mint's art.

use hopper_core::live_v6_html_digest;
use hopper_indexer::types::InscriptionReveal;

/// Enforcing indexer (activation height 100) with the usual funding UTXO.
fn enforcing_idx() -> Indexer {
    let mut idx = Indexer::new(IndexerConfig {
        inscription_activation_height: Some(100),
        ..Default::default()
    });
    idx.seed_utxo(op(1, 0), vec![SatRange::new(SAT, SAT + 100)]);
    idx.seed_utxo(op(9, 2), vec![SatRange::new(SAT + 1_000, SAT + 1_100)]);
    idx
}

fn reveal_with_hash(reveal_index: u32, body_hash: [u8; 32]) -> InscriptionReveal {
    InscriptionReveal {
        content_type: hopper_core::V6_CONTENT_TYPE.to_string(),
        body: None,
        parents: Vec::new(),
        tapscript: None,
        control_block: None,
        body_hash,
        inscription_id: format!(
            "{}i{reveal_index}",
            b32(2)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>()
        ),
    }
}

fn inscribed_mint_tx(txid: u8, seed: u32, reveals: Vec<Option<InscriptionReveal>>) -> Tx {
    let payload = envelope(Action::Mint, &encode_mint(seed, "Victim"));
    let mut inputs = Vec::new();
    for (i, reveal) in reveals.into_iter().enumerate() {
        let mut inp = input(if i == 0 { 1 } else { (i + 8) as u8 }, i as u32, 100);
        inp.inscription = reveal;
        inputs.push(inp);
    }
    tx_of(txid, inputs, vec![out(100), out_env(payload)])
}

#[test]
fn attack_mint_without_inscription_after_activation() {
    // The classic freeride: legacy one-tx mint, no reveal at all.
    let mut idx = enforcing_idx();
    let report = idx.apply_block(block_of(100, 1, vec![mint_tx(2)])).unwrap();
    assert!(
        report
            .rejections
            .iter()
            .any(|r| r.reason == RejectionReason::MintWithoutInscription),
        "freeride mint must be rejected: {:?}",
        report.rejections
    );
    assert!(idx.froggers().is_empty());
}

#[test]
fn attack_mint_art_mismatch() {
    // Envelope seed says A, inscribed PNG is B.
    let mut idx = enforcing_idx();
    let wrong_art = reveal_with_hash(0, live_v6_html_digest(0x1234, SAT));
    let tx = inscribed_mint_tx(2, 0xABCD, vec![Some(wrong_art)]);
    let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
    assert!(
        report
            .rejections
            .iter()
            .any(|r| r.reason == RejectionReason::InscriptionArtMismatch),
        "art mismatch must be rejected: {:?}",
        report.rejections
    );
    assert!(idx.froggers().is_empty());
}

#[test]
fn attack_mint_wrong_content_type() {
    // Canonical art bytes wearing a foreign content type.
    let mut idx = enforcing_idx();
    let mut foreign = reveal_with_hash(0, live_v6_html_digest(0xABCD, SAT));
    foreign.content_type = "text/html".to_string();
    let tx = inscribed_mint_tx(2, 0xABCD, vec![Some(foreign)]);
    let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
    assert!(
        report
            .rejections
            .iter()
            .any(|r| r.reason == RejectionReason::InscriptionContentType),
        "foreign content type must be rejected: {:?}",
        report.rejections
    );
    assert!(idx.froggers().is_empty());
}

#[test]
fn attack_inscription_on_non_commit_input() {
    // Reveal parked on input 1 while input 0 is a bare spend: the
    // inscribed sat is not the anchor sat, so the mint must fail.
    let mut idx = enforcing_idx();
    let tx = inscribed_mint_tx(
        2,
        0xABCD,
        vec![
            None,
            Some(reveal_with_hash(0, live_v6_html_digest(0xABCD, SAT))),
        ],
    );
    let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
    assert!(
        report
            .rejections
            .iter()
            .any(|r| r.reason == RejectionReason::MintWithoutInscription),
        "reveal on input 1 must not satisfy the rule: {:?}",
        report.rejections
    );
    assert!(idx.froggers().is_empty());
}

#[test]
fn attack_two_inscriptions_in_mint() {
    // Double inscription: first art valid, second junk — the indexer
    // must not pick the favorable one.
    let mut idx = enforcing_idx();
    let tx = inscribed_mint_tx(
        2,
        0xABCD,
        vec![
            Some(reveal_with_hash(0, live_v6_html_digest(0xABCD, SAT))),
            Some(reveal_with_hash(1, [0x00; 32])),
        ],
    );
    let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
    assert!(
        report
            .rejections
            .iter()
            .any(|r| r.reason == RejectionReason::MultipleInscriptions),
        "double inscription must be rejected: {:?}",
        report.rejections
    );
    assert!(idx.froggers().is_empty());
}

#[test]
fn attack_inscribed_reveal_spends_untracked_utxo() {
    // The reveal input is not the commit that funds output 0: input 0
    // (inscribed) spends an untracked UTXO, the tracked sat rides
    // input 1. Output 0's first sat is therefore unknowable — the
    // mint must die, inscription or no inscription.
    let mut idx = enforcing_idx();
    let payload = envelope(Action::Mint, &encode_mint(0xABCD, "Victim"));
    let mut inscribed_input = input(9, 0, 100);
    inscribed_input.inscription = Some(reveal_with_hash(0, live_v6_html_digest(0xABCD, SAT)));
    let tx = tx_of(
        2,
        vec![inscribed_input, input(1, 0, 100)],
        vec![out(100), out_env(payload)],
    );
    let report = idx.apply_block(block_of(100, 1, vec![tx])).unwrap();
    assert!(
        !report.rejections.is_empty(),
        "reveal on a non-commit untracked UTXO must not mint: {:?}",
        report.rejections
    );
    assert!(idx.froggers().is_empty());
}

#[test]
fn attack_art_reuse_across_seeds() {
    // Mint frog A with its canonical art, then try to mint frog B
    // (different seed) reusing frog A's PNG bytes: the second mint's
    // art no longer matches its own seed.
    let mut idx = enforcing_idx();
    let art = live_v6_html_digest(0xABCD, SAT);
    let mint_a = inscribed_mint_tx(2, 0xABCD, vec![Some(reveal_with_hash(0, art))]);
    idx.apply_block(block_of(100, 1, vec![mint_a])).unwrap();
    assert!(idx.froggers().contains_key(&SAT));

    // Frog B's own funding UTXO (fresh sat range), but frog A's art.
    let payload = envelope(Action::Mint, &encode_mint(0xBEEF, "Thief"));
    let mut inscribed_input = input(9, 2, 100);
    inscribed_input.inscription = Some(reveal_with_hash(0, art));
    let mint_b = tx_of(3, vec![inscribed_input], vec![out(100), out_env(payload)]);
    let report = idx.apply_block(block_of(101, 2, vec![mint_b])).unwrap();
    assert!(
        report
            .rejections
            .iter()
            .any(|r| r.reason == RejectionReason::InscriptionArtMismatch),
        "art reuse across seeds must be rejected: {:?}",
        report.rejections
    );
    assert_eq!(idx.froggers().len(), 1);
}
