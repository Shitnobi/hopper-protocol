//! The consensus apply path, generic over the state backend.
//!
//! [`ConsensusState`] is the whole surface the protocol rules need: owned
//! reads plus closure-based mutation, never a borrow that outlives a call.
//! That is what lets the same code drive the in-memory image
//! ([`crate::state_machine::IndexState`], the wallet and every test) and a
//! store-backed one that keeps a block-sized overlay over redb, so a
//! durable process need not hold a second full copy of the state.
//!
//! Nothing here does I/O: the backend decides what a read costs.

use crate::sat_track::{apply_tx_with, is_shadow, CoinView};
use crate::state_machine::{BlockSink, IndexerConfig, IndexerError};
use crate::store::{BlockEffects, StoreError};
use crate::types::{
    Block, ChainEvent, EventAction, FroggerRecord, FroggerState, InscriptionReveal, MoveDest,
    MoveRecord, OutPoint, Rejection, RejectionReason, SatLocation, Tx, TxFlow, UtxoEntry,
};
use hopper_core::Message;

/// Block application result plus its optional undo journal.
pub(crate) type JournaledBlock = (Vec<ChainEvent>, Vec<Rejection>, Option<BlockEffects>);

/// The state the consensus rules need.
///
/// Reads return owned values and every mutation goes through a
/// `with_*` closure, so a backend may materialise a record, hand it to the
/// rule, and write it back without ever exposing a borrow of its storage.
pub trait ConsensusState: CoinView {
    /// The enforced version schedule (part of the state image).
    fn config(&self) -> &IndexerConfig;
    /// Current tip `(height, hash)`.
    fn tip(&self) -> (Option<u32>, Option<[u8; 32]>);
    /// Set the tip.
    fn set_tip(&mut self, height: Option<u32>, hash: Option<[u8; 32]>);

    /// The frog record at `sat`.
    fn frog(&self, sat: u64) -> Option<FroggerRecord>;
    /// True if a frog is tracked at `sat`.
    fn has_frog(&self, sat: u64) -> bool {
        self.frog(sat).is_some()
    }
    /// Visit every frog record in ascending sat order.
    ///
    /// The v3 timers need the crossings opened one and six blocks ago;
    /// a backend MAY maintain an index later, but the contract is "visit
    /// all", so correctness never depends on that index.
    fn for_each_frog(&self, f: &mut dyn FnMut(&FroggerRecord)) -> Result<(), StoreError>;
    /// Mutate (or create/remove) the frog at `sat`.
    fn with_frog(&mut self, sat: u64, f: &mut dyn FnMut(&mut Option<FroggerRecord>));
    /// Insert or replace a frog record.
    fn put_frog(&mut self, record: FroggerRecord) {
        let sat = record.sat;
        let mut record = Some(record);
        self.with_frog(sat, &mut |slot| *slot = record.take());
    }

    /// The coin at `outpoint` (owned copy; the forward batch needs one).
    fn coin(&self, outpoint: &OutPoint) -> Option<UtxoEntry> {
        let mut out = None;
        self.with_coin(outpoint, &mut |entry| out = entry.cloned());
        out
    }

    /// Tracked count (serving/metrics; not a consensus input).
    fn frog_count(&self) -> usize;

    /// Spend/create coins for `tx` and follow every moved frog sat.
    fn apply_tx(&mut self, tx: &Tx) -> TxFlow {
        apply_tx_with(self, tx)
    }

    /// Bootstrap a UTXO with known sat ranges (chain seeding / fixtures).
    fn seed_utxo(&mut self, outpoint: OutPoint, ranges: Vec<hopper_core::satmath::SatRange>);

    /// Start recording an undo journal for `height`.
    fn journal_begin(&mut self, height: u32);
    /// Take the journal recorded since [`ConsensusState::journal_begin`].
    fn journal_take(&mut self) -> Option<BlockEffects>;
    /// Record a frog's first touch this block.
    fn journal_frog(&mut self, sat: u64);
    /// Record a crossing's first touch this block.
    /// Record a coin's first touch this block.
    fn journal_coin(&mut self, outpoint: OutPoint);
    /// Record every coin a tx can touch: its inputs (spent) and outputs.
    fn journal_tx_coins(&mut self, tx: &Tx) {
        for input in &tx.inputs {
            self.journal_coin(input.prevout);
        }
        for vout in 0..tx.outputs.len() as u32 {
            self.journal_coin(OutPoint {
                txid: tx.txid,
                vout,
            });
        }
    }

    /// the journal names every touched key, the state supplies its final
    /// value. Keys whose value did not change are omitted.
    /// Restore the pre-block state from a journal.
    fn undo(&mut self, effects: &BlockEffects) -> Result<(), StoreError>;
}

pub(crate) fn block_write<S: ConsensusState + ?Sized>(
    state: &S,
    effects: &crate::store::BlockEffects,
) -> crate::store::BlockWrite {
    let mut write = crate::store::BlockWrite::new(effects.height);
    for (sat, before) in effects.frogs() {
        let after = state.frog(*sat);
        if after.as_ref() != before.as_ref() {
            write.put_frog(*sat, after);
        }
    }
    for (outpoint, before) in effects.coins() {
        let after = state.coin(outpoint);
        if after.as_ref() != before.as_ref() {
            write.put_coin(*outpoint, after);
        }
    }
    let (tip_height, tip_hash) = state.tip();
    write.set_tip(tip_height, tip_hash);
    write
}

pub(crate) fn apply_block_body<S: ConsensusState + ?Sized>(
    state: &mut S,
    block: &Block,
    journal: bool,
) -> Result<JournaledBlock, IndexerError> {
    if journal {
        state.journal_begin(block.height);
    }
    let result = apply_block_inner(state, block);
    // Take on both success and error: a failed block leaves no journal
    // behind (partial in-memory mutations are the caller's reorg).
    let effects = state.journal_take();
    let (events, rejections) = result?;
    Ok((events, rejections, effects))
}

fn apply_block_inner<S: ConsensusState + ?Sized>(
    state: &mut S,
    block: &Block,
) -> Result<(Vec<ChainEvent>, Vec<Rejection>), IndexerError> {
    let (tip_height, _) = state.tip();
    let expected = match tip_height {
        None => block.height,
        Some(t) => t.checked_add(1).ok_or(IndexerError::HeightOverflow)?,
    };
    if block.height != expected {
        return Err(IndexerError::NonContiguousHeight {
            expected,
            got: block.height,
        });
    }
    state.set_tip(Some(block.height), Some(block.hash));

    let mut sink = BlockSink {
        height: block.height,
        hash: block.hash,
        events: Vec::new(),
        rejections: Vec::new(),
    };

    // The timers run once per block, BEFORE its transactions, so a
    // crossing that ends at this height frees the frog for a new CROSS in
    // the same block (V3 §8.4). Both use data fixed by earlier blocks.
    let params = state.config().params;
    crate::rules::capture_outcome(state, block.height, block.hash)
        .map_err(|e| IndexerError::Storage(e.to_string()))?;
    crate::rules::settle_due(state, block.height, &mut sink, &params)
        .map_err(|e| IndexerError::Storage(e.to_string()))?;

    for tx in &block.txs {
        process_tx(state, tx, &mut sink);
    }

    let BlockSink {
        events, rejections, ..
    } = sink;
    Ok((events, rejections))
}

/// Scan a tx for its FRG envelope and version-gate it (SPEC §3.1,
/// §8.2.7). An undefined version is inert; a known one below activation
/// never existed; only an active version's payload is decoded.
fn scan_envelope<S: ConsensusState + ?Sized>(
    _state: &S,
    tx: &Tx,
    sink: &mut BlockSink,
) -> Option<Message> {
    // Allocation-free: at most one envelope per tx is meaningful, and a
    // second one voids the tx's envelope in full.
    let mut first_push: Option<&[u8]> = None;
    let mut push_count = 0usize;
    for o in &tx.outputs {
        let Some(p) = o.op_return.as_deref() else {
            continue;
        };
        if p.len() >= 3 && p[..3] == hopper_core::envelope::MAGIC {
            push_count += 1;
            if first_push.is_none() {
                first_push = Some(p);
            }
        }
    }
    if push_count > 1 {
        sink.reject(tx.txid, RejectionReason::MultipleEnvelopes);
        return None;
    }
    let push = first_push?;
    match hopper_core::decode(push) {
        Ok(message) => Some(message),
        Err(err) => {
            sink.reject(tx.txid, RejectionReason::MalformedEnvelope(err));
            None
        }
    }
}

/// The v3 transaction path (V3 §7, §8.2–§8.4).
///
/// The sat flow ALWAYS runs; a CROSS is an extra transition layered on
/// it, never a precondition for tracking. A rejected CROSS is therefore
/// just a transfer (V3 §8.3).
fn process_tx<S: ConsensusState + ?Sized>(state: &mut S, tx: &Tx, sink: &mut BlockSink) {
    let envelope = scan_envelope(state, tx, sink);
    let params = state.config().params;
    // Capture what validation needs BEFORE the tracker advances: input 1
    // must spend the frog's pre-block outpoint, and funding inputs must
    // not carry frogs, both of which the spend itself destroys.
    let mut candidate = None;
    if crate::rules::is_cross_tx(tx) {
        // The body is the authority, wherever the inscription sits: a
        // misplaced CROSS must be rejected as such by `validate_cross`,
        // not reported as malformed.
        let mut bad_dir = false;
        let decoded = tx
            .inputs
            .iter()
            .filter_map(|input| input.inscription.as_ref())
            .filter_map(|ins| ins.body.as_deref())
            .find_map(|body| match hopper_core::decode_state_body(body) {
                Ok(b) => Some((b.sat, b.dir)),
                Err(hopper_core::StateBodyError::BadDirection) => {
                    bad_dir = true;
                    None
                }
                Err(_) => None,
            });
        match decoded {
            None => sink.reject(
                tx.txid,
                if bad_dir {
                    RejectionReason::CrossBadDirection
                } else {
                    RejectionReason::CrossBodyMalformed
                },
            ),
            Some((sat, dir)) => match state.frog(sat) {
                None => sink.reject_for(tx.txid, sat, RejectionReason::CrossUnknownFrog),
                Some(frog) => {
                    // v7: the frog is input 0; funding starts at input 1.
                    let funding = crate::rules::funding_carries_frog(state, tx, 1);
                    candidate = Some((frog, funding, dir));
                }
            },
        }
    }

    state.journal_tx_coins(tx);
    let flow = state.apply_tx(tx);
    let mut begun = None;
    if let Some((frog, funding, dir)) = candidate {
        match crate::rules::validate_cross(tx, &flow, &frog, &params, funding, sink.height) {
            Ok(sat) => begun = Some((sat, frog.sat, dir)),
            Err(reason) => sink.reject_for(tx.txid, frog.sat, reason),
        }
    }
    let begun_sat = begun.as_ref().map(|(_, sat, _)| *sat);
    for mv in &flow.moves {
        let sat = mv.sat;
        note_move(state, sat, mv, tx.txid, sink.height, sink);
        if Some(sat) == begun_sat {
            // The spend IS the crossing: no Transfer event.
            continue;
        }
        burn_swept_frog(state, sat, mv, sink);
        // A fee sweep is a burn, not a transfer: there is no output to
        // name and the sat is gone.
        if state.has_frog(sat) && !matches!(mv.to, MoveDest::Fees) {
            sink.event(Some(tx.txid), EventAction::Transfer { frogger_sat: sat });
        }
    }
    if let Some((_, sat, dir)) = begun {
        if let Some(frog) = state.frog(sat) {
            crate::rules::begin_crossing(state, tx, &frog, sink.height, &params, dir);
        }
    }

    if let Some(Message::Mint { seed, name, version }) = envelope {
        process_mint(state, tx, &flow, seed, name, version, sink);
    }
}

/// Apply §6 movement semantics for one frogger whose anchor-sat UTXO
/// was just spent: where the anchor sat went, and what that does to the
/// frog.
///
/// The forward index (frog -> location) moves with the sat; the tracker
/// carries only the coin side (IR plan P1.2). A fee move is the terminal
/// burned state, and it is the frog's state too: if an idle frog's card is
/// swept into fees, nothing else will ever observe it (no crossing, no
/// timer, no location), so leaving it `Idle` would put a frog in the live
/// set that can never cross, move or leave. An in-flight crossing keeps
/// its timer and `settle_due` closes it as burned after finality.
fn note_move<S: ConsensusState + ?Sized>(
    state: &mut S,
    sat: u64,
    mv: &MoveRecord,
    txid: [u8; 32],
    height: u32,
    sink: &mut BlockSink,
) {
    state.journal_frog(sat);
    state.with_frog(sat, &mut |slot| {
        let Some(frog) = slot else { return };
        frog.location = match mv.to {
            MoveDest::Output(outpoint) => SatLocation::Tracked(outpoint),
            MoveDest::Fees => SatLocation::Burned,
        };
        // A burn is recorded even when the frog is already terminal: a
        // dead frog's card can still be swept, and the API should name
        // the transaction that did it. `get_or_insert` keeps the first
        // burn (a sat can only be burned once).
        if matches!(mv.to, MoveDest::Fees) {
            frog.burn_height.get_or_insert(height);
            frog.burn_txid.get_or_insert(txid);
        }
    });
    if matches!(mv.to, MoveDest::Fees) {
        sink.event(Some(txid), EventAction::Burn { frogger_sat: sat });
    }
}

/// The state half of a burn, applied only once the transaction's protocol
/// meaning is known: a CROSS whose anchor would be swept must reject as
/// `CrossAnchorBurned`, not as `CrossNotIdle`, so the state may not move
/// until that decision has been made.
fn burn_swept_frog<S: ConsensusState + ?Sized>(
    state: &mut S,
    sat: u64,
    mv: &MoveRecord,
    sink: &mut BlockSink,
) {
    if !matches!(mv.to, MoveDest::Fees) {
        return;
    }
    state.with_frog(sat, &mut |slot| {
        if let Some(frog) = slot {
            if frog.state == FroggerState::Idle {
                frog.state = FroggerState::Burned;
            }
        }
    });
    let _ = sink;
}

/// MINT validation (SPEC §4.1, §8.1.2): sat unused by any frogger
/// (live or dead), envelope well-formed, and output 0's first sat
/// exists and is trackable.
fn process_mint<S: ConsensusState + ?Sized>(
    state: &mut S,
    tx: &Tx,
    flow: &TxFlow,
    seed: u32,
    name: String,
    envelope_version: u8,
    sink: &mut BlockSink,
) {
    let Some(sat) = flow.anchor_out0 else {
        sink.reject(tx.txid, RejectionReason::MintNoAnchorSat);
        return;
    };
    if is_shadow(sat) {
        // Output 0 is funded by inputs the tracker never saw: the
        // frogger's ID (an ordinal number) would be unknowable.
        sink.reject(tx.txid, RejectionReason::MintAnchorUntracked);
        return;
    }
    if state.has_frog(sat) {
        // Sats are never re-mintable, live or dead (SPEC §4.1).
        sink.reject(tx.txid, RejectionReason::MintSatInUse);
        return;
    }
    // Change B: inscription-backed mint validation (B.3.2).
    // Enforcement is height-gated; below the activation height
    // (and when enforcement is off) legacy single-tx mints are
    // accepted. An inscription present on a legacy mint is still
    // recorded (inscription id surfaced, never relied upon).
    let inscription_id = match validate_mint_inscription(
        state, tx, seed, sat, &name, envelope_version, sink,
    ) {
        Ok(id) => id,
        Err(()) => return,
    };
    let anchor = OutPoint {
        txid: tx.txid,
        vout: 0,
    };
    let mint_index = inscription_id
        .as_deref()
        .and_then(|id| id.rsplit_once('i'))
        .and_then(|(_, index)| index.parse().ok())
        .unwrap_or(0);
    // Reverse half: the coin at output 0 now lists this frog sat.
    let gen = state.config().params.generations.generation(sink.height);
    state.register_frog(sat, anchor);
    state.journal_frog(sat);
    state.put_frog(FroggerRecord {
        sat,
        seed,
        name: name.clone(),
        gen,
        state: FroggerState::Idle,
        dist: 0,
        crossings_entered: 0,
        mint_height: sink.height,
        mint_txid: tx.txid,
        inscription_id,
        // MINT anchors the frog sat at output 0 (SPEC §4.1); the
        // coin's `frogs` list carries the reverse direction.
        location: SatLocation::Tracked(anchor),
        wire_version: if hopper_core::is_grandfathered_sat(sat)
            && envelope_version == hopper_core::VERSION_V7
        {
            hopper_core::VERSION_V7
        } else {
            hopper_core::VERSION_V8
        },
        mint_index,
        crossings_settled: 0,
        deaths: 0,
        in_flight: None,
        outcome_block_hash: None,
        outcome_wrap: None,
        provisional_dead: None,
        immortal_height: None,
        death_height: None,
        burn_height: None,
        burn_txid: None,
        last_target_hops: None,
    });
    sink.event(
        Some(tx.txid),
        EventAction::Mint {
            frogger_sat: sat,
            seed,
            name,
            gen,
        },
    );
}

/// Change B (B.3.2): inscription reveal validation for MINT.
///
/// Returns the inscription id to record on the `FroggerRecord`
/// (`None` when the mint carries no inscription), or `Err(())`
/// after rejecting the mint. Enforced only from
/// `config.inscription_activation_height`:
///
/// - exactly one inscription in the tx, on input 0
///   (`MintWithoutInscription` / `MultipleInscriptions`),
/// - content-type `text/html;charset=utf-8` and a body equal to
///   `live_v7_html(seed, sat, name, gen_hint)` (`InscriptionContentType`
///   / `InscriptionArtMismatch`). The body embeds the anchor sat and the
///   hint, which the caller resolves from the document itself.
///
/// Below the activation height (or with enforcement off, the
/// default) any inscription present is recorded leniently —
/// strictness is a birth-era rule, and the inscription id is
/// surfaced, never relied upon (B.1.5).
fn validate_mint_inscription<S: ConsensusState + ?Sized>(
    state: &S,
    tx: &Tx,
    seed: u32,
    sat: u64,
    name: &str,
    envelope_version: u8,
    sink: &mut BlockSink,
) -> Result<Option<String>, ()> {
    let reveals: Vec<(usize, &InscriptionReveal)> = tx
        .inputs
        .iter()
        .enumerate()
        .filter_map(|(i, input)| input.inscription.as_ref().map(|r| (i, r)))
        .collect();
    if reveals.is_empty() {
        // No inscription anywhere: legacy single-tx mint. Reject
        // only when inscription enforcement is active here.
        if state
            .config()
            .inscription_activation_height
            .is_some_and(|h| sink.height >= h)
        {
            sink.reject(tx.txid, RejectionReason::MintWithoutInscription);
            return Err(());
        }
        return Ok(None);
    }
    let enforce = state
        .config()
        .inscription_activation_height
        .is_some_and(|h| sink.height >= h);
    if enforce {
        if reveals.len() > 1 {
            sink.reject(tx.txid, RejectionReason::MultipleInscriptions);
            return Err(());
        }
        let (input_index, reveal) = reveals[0];
        if input_index != 0 {
            // The reveal must sit on input 0 — its first sat is the
            // anchor sat the inscription is engraved on.
            sink.reject(tx.txid, RejectionReason::MintWithoutInscription);
            return Err(());
        }
        // F-09: preserve ord's pointer/multiplicity/validity fields.
        if reveal.inscription_count != 1 || reveal.pointer.is_some() || !reveal.valid {
            sink.reject(tx.txid, RejectionReason::InscriptionArtMismatch);
            return Err(());
        }
        let content_type = hopper_core::V8_CONTENT_TYPE;
        if reveal.content_type != content_type {
            sink.reject(tx.txid, RejectionReason::InscriptionContentType);
            return Err(());
        }
        // The one released Hopper may carry its frozen v7 document and
        // envelope. Every other mint must be v8.
        let legacy = envelope_version == hopper_core::VERSION_V7;
        if legacy != hopper_core::is_grandfathered_sat(sat) {
            sink.reject(tx.txid, RejectionReason::InscriptionArtMismatch);
            return Err(());
        }
        let (gen_hint, expected) = if legacy {
            (
                reveal.body.as_deref().and_then(hopper_core::parse_v7_gen_hint),
                "v7",
            )
        } else {
            (
                reveal.body.as_deref().and_then(hopper_core::parse_v8_gen_hint),
                "v8",
            )
        };
        let Some(gen_hint) = gen_hint else {
            sink.reject(tx.txid, RejectionReason::InscriptionArtMismatch);
            return Err(());
        };
        // The body hash is recomputed from the canonical render below, so
        // the ingest-supplied digest is never trusted on its own.
        let body_ok = reveal.body.as_deref().is_some_and(|body| {
            if expected == "v7" {
                body == hopper_core::live_v7_html(seed, sat, &name, gen_hint).as_bytes()
            } else {
                body == hopper_core::live_v8_html(seed, sat, &name, gen_hint).as_bytes()
            }
        });
        if !body_ok {
            sink.reject(tx.txid, RejectionReason::InscriptionArtMismatch);
            return Err(());
        }
    }
    // Record the input-0 reveal's id when present; a non-input-0
    // reveal on a legacy mint is surfaced only if input 0 is silent.
    let id = reveals
        .iter()
        .find(|(i, _)| *i == 0)
        .or_else(|| reveals.first())
        .map(|(_, r)| r.inscription_id.clone());
    Ok(id)
}
