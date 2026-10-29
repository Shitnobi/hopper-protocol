//! UTXO set + Ordinals sat-range tracking (SPEC §4, §6; Workstream B1).
//!
//! This module owns the *where* of every frogger: which UTXO currently
//! holds its anchor sat. All position math is delegated to the frozen
//! [`hopper_core::satmath`] primitives ([`assign`], [`locate_sat`],
//! [`anchor_sat`]) — this layer never reimplements Ordinals rules, it only
//! maintains the UTXO set across transactions and reports movements.
//!
//! Per transaction, in input order and each input's sats in ordinal order,
//! input sats fill the outputs in output order, each output absorbing up
//! to its value in sats (Ordinals FIFO — see the `satmath` docs). Sats in
//! excess of total output value flow to fees.
//!
//! ## Untracked inputs and shadow sats
//!
//! An indexer started at activation height H₀ has not seen pre-activation
//! UTXOs, yet a frogger's anchor UTXO is routinely spent *together with*
//! untracked fee-funding inputs (the sticky-UTXO wallet pattern, SPEC
//! §9.4). FIFO positioning of the tracked anchor sat depends on the
//! *values* of those untracked inputs. The tracker therefore represents
//! each untracked input by a deterministic **shadow range** of synthetic
//! ordinals ≥ [`SHADOW_BASE`] (far above any real sat, whose numbers are
//! bounded by [`hopper_core::satmath::MAX_SAT`] < 2^52). Shadow ordinals
//! can never be confused with real frogger sats; their only job is to
//! occupy the correct amount of FIFO space. See [`shadow_range`].
//!
//! ## Fees and burns
//!
//! If a frogger's anchor sat flows to fees, the movement reports
//! [`MoveDest::Fees`] and the caller records the frog as burned
//! ([`crate::types::SatLocation::Burned`]). `ord` assigns fee sats into the
//! block's coinbase outputs; that flow (and the subsidy math it requires)
//! is a documented modeling gap — see `NOTES.md`.

use std::collections::{BTreeMap, BTreeSet};

use smallvec::SmallVec;

use hopper_core::satmath::{assign, SatRange};

use crate::types::{Block, MoveDest, MoveRecord, OutPoint, Tx, TxFlow, UtxoEntry};

/// Ordinals at or above this value are synthetic *shadow* sats standing in
/// for untracked inputs. Real sat numbers are < 2^52
/// ([`hopper_core::satmath::MAX_SAT`] ≈ 2.1e15), so the ranges can never
/// collide.
pub const SHADOW_BASE: u64 = 1 << 60;

/// The stride between consecutive shadow slots. Any single real UTXO value
/// (< 2.1e15) is smaller than this, so one input's shadow range cannot
/// reach the next slot's start.
const SHADOW_STRIDE: u64 = 1 << 52;

/// The output index whose assigned ranges contain `sat` — the same
/// answer as `hopper_core::satmath::locate_sat`, computed over ranges
/// that were already assigned for this transaction.
fn locate_in(assigned: &[Vec<SatRange>], sat: u64) -> Option<usize> {
    assigned
        .iter()
        .position(|ranges| ranges.iter().any(|r| r.start <= sat && sat < r.end))
}

/// True if `sat` is a synthetic shadow ordinal (never a real frogger sat).
pub fn is_shadow(sat: u64) -> bool {
    sat >= SHADOW_BASE
}

/// The coin-set operations the Ordinals FIFO walk needs.
///
/// Implemented by the in-memory [`SatTracker`] and by store-backed
/// consensus states, so `apply_tx` exists once and both paths run the
/// same Ordinals rules. Mutations go through `with_coin` (a closure gets
/// the slot) so a store can read through, buffer, and journal without
/// handing out a borrow of its storage.
pub trait CoinView {
    /// Read the coin at `outpoint`.
    fn with_coin(&self, outpoint: &OutPoint, f: &mut dyn FnMut(Option<&UtxoEntry>));
    /// Mutate (insert/remove) the coin at `outpoint`.
    fn update_coin(&mut self, outpoint: OutPoint, f: &mut dyn FnMut(&mut Option<UtxoEntry>));
    /// Attach a frogger sat to an existing coin (MINT).
    fn register_frog(&mut self, sat: u64, outpoint: OutPoint);
    /// Frogger sats held by `outpoint`.
    fn frogs_at(&self, outpoint: &OutPoint) -> Vec<u64>;
    /// Number of tracked coins.
    fn coin_count(&self) -> usize;
}

impl CoinView for SatTracker {
    fn with_coin(&self, outpoint: &OutPoint, f: &mut dyn FnMut(Option<&UtxoEntry>)) {
        f(self.utxos.get(outpoint));
    }

    fn update_coin(&mut self, outpoint: OutPoint, f: &mut dyn FnMut(&mut Option<UtxoEntry>)) {
        // Move the entry out and back: no clone, and the `None` case can
        // insert or leave the map untouched.
        let mut slot = self.utxos.remove(&outpoint);
        f(&mut slot);
        if let Some(entry) = slot {
            self.utxos.insert(outpoint, entry);
        }
    }

    fn register_frog(&mut self, sat: u64, outpoint: OutPoint) {
        SatTracker::register_frog(self, sat, outpoint);
    }

    fn frogs_at(&self, outpoint: &OutPoint) -> Vec<u64> {
        SatTracker::frogs_at(self, outpoint).to_vec()
    }

    fn coin_count(&self) -> usize {
        self.utxos.len()
    }
}

/// A deterministic synthetic range for untracked input number `index`
/// (0-based, in input order). Returns an empty vec for zero value or on
/// u64 overflow (graceful degradation: the input occupies no FIFO space;
/// reachable only with absurd numbers of untracked inputs).
fn shadow_range(index: usize, value: u64) -> Vec<SatRange> {
    if value == 0 {
        return Vec::new();
    }
    let offset = match (index as u64).checked_mul(SHADOW_STRIDE) {
        Some(o) => o,
        None => return Vec::new(),
    };
    let start = match SHADOW_BASE.checked_add(offset) {
        Some(s) => s,
        None => return Vec::new(),
    };
    let end = match start.checked_add(value) {
        Some(e) => e,
        None => return Vec::new(),
    };
    vec![SatRange::new(start, end)]
}

/// The UTXO set (Bitcoin's coin view) plus the frogger sats each coin holds.
///
/// A coin is created with an output and deleted when spent. Each coin also
/// carries the frogger sats inside it, so a spend is one lookup (`utxos`)
/// instead of a separate reverse-index lookup. There is deliberately **no
/// forward `locations` map here**: the owning frog record stores its own
/// [`SatLocation`](crate::types::SatLocation), so the two directions cannot
/// drift apart (IR plan P1.2). The tracker only moves sats and reports
/// [`MoveRecord`]s; the state machine applies them to frog records.
///
/// All operations are pure functions of the applied chain data; iteration
/// order is deterministic (BTree collections / sorted vectors).
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SatTracker {
    utxos: BTreeMap<OutPoint, UtxoEntry>,
}

impl SatTracker {
    /// An empty tracker.
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of coins in the set.
    pub fn coin_count(&self) -> usize {
        self.utxos.len()
    }

    /// The whole coin set, ordered by outpoint (crate-internal).
    pub(crate) fn coins(&self) -> &BTreeMap<OutPoint, UtxoEntry> {
        &self.utxos
    }

    /// Insert/replace a coin verbatim (crate-internal: store trait).
    pub(crate) fn put_coin(&mut self, outpoint: OutPoint, entry: UtxoEntry) {
        self.utxos.insert(outpoint, entry);
    }

    /// Remove a coin, returning it (crate-internal: store trait).
    pub(crate) fn remove_coin(&mut self, outpoint: &OutPoint) -> Option<UtxoEntry> {
        self.utxos.remove(outpoint)
    }

    /// Bootstrap a UTXO with known sat ranges (chain-layer seeding for the
    /// pre-activation history, or test fixtures). Value is derived from
    /// the ranges.
    pub fn seed_utxo(&mut self, outpoint: OutPoint, ranges: Vec<SatRange>) {
        let value: u64 = ranges.iter().map(|r| r.len()).sum();
        self.utxos.insert(
            outpoint,
            UtxoEntry {
                value,
                ranges,
                // Seeds carry no frogs; MINT records the new frog's location
                // on its `FroggerRecord` (the tracker only moves sats).
                frogs: SmallVec::new(),
            },
        );
    }

    /// Attach a frogger sat to an existing coin — the reverse half of a
    /// MINT's location assignment (the forward half is the frog record's
    /// [`SatLocation`](crate::types::SatLocation)). Idempotent. A MINT is not
    /// a movement, so it does not go through [`SatTracker::apply_tx`].
    /// Indexer-internal.
    pub fn register_frog(&mut self, sat: u64, outpoint: OutPoint) {
        if let Some(entry) = self.utxos.get_mut(&outpoint) {
            if let Err(pos) = entry.frogs.binary_search(&sat) {
                entry.frogs.insert(pos, sat);
            }
        } else {
            debug_assert!(false, "register_frog on untracked outpoint {outpoint:?}");
        }
    }

    /// Frogger sats currently held by `outpoint` (empty if the coin is
    /// unknown). The reverse direction of the frog record's location.
    pub fn frogs_at(&self, outpoint: &OutPoint) -> &[u64] {
        self.utxos
            .get(outpoint)
            .map(|e| e.frogs.as_slice())
            .unwrap_or(&[])
    }

    /// The tracked UTXO, if any.
    pub fn utxo(&self, outpoint: &OutPoint) -> Option<&UtxoEntry> {
        self.utxos.get(outpoint)
    }

    /// Value in sats of a tracked UTXO.
    pub fn utxo_value(&self, outpoint: &OutPoint) -> Option<u64> {
        self.utxos.get(outpoint).map(|e| e.value)
    }

    /// Apply one transaction: spend input UTXOs, create output UTXOs,
    /// follow every tracked frogger sat, and compute the output-0 anchor
    /// position (SPEC §4.1).
    ///
    /// Never panics on hostile input: unknown prevouts become shadow
    /// ranges, duplicate prevouts are tolerated, and overflow degrades to
    /// empty shadow ranges.
    pub fn apply_tx(&mut self, tx: &Tx) -> TxFlow {
        apply_tx_with(self, tx)
    }

    /// Apply every transaction of a block in block order, returning each
    /// tx's flow.
    pub fn apply_block(&mut self, block: &Block) -> Vec<TxFlow> {
        block.txs.iter().map(|tx| self.apply_tx(tx)).collect()
    }
}

/// Apply one transaction: spend input UTXOs, create output UTXOs,
/// follow every tracked frogger sat, and compute the output-0 anchor
/// position (SPEC §4.1).
///
/// Never panics on hostile input: unknown prevouts become shadow
/// ranges, duplicate prevouts are tolerated, and overflow degrades to
/// empty shadow ranges.
pub(crate) fn apply_tx_with<V: CoinView + ?Sized>(v: &mut V, tx: &Tx) -> TxFlow {
    // 1. Input sat ranges in input order: tracked ranges where known,
    //    deterministic shadow ranges otherwise (keeps FIFO positioning
    //    of tracked sats correct alongside untracked funding inputs).
    let mut inputs: Vec<SatRange> = Vec::new();
    let mut shadow_idx = 0usize;
    for input in &tx.inputs {
        let mut found = false;
        v.with_coin(&input.prevout, &mut |entry| {
            if let Some(entry) = entry {
                inputs.extend_from_slice(&entry.ranges);
                found = true;
            }
        });
        if !found {
            inputs.extend_from_slice(&shadow_range(shadow_idx, input.value));
            shadow_idx += 1;
        }
    }
    let outputs: Vec<u64> = tx.outputs.iter().map(|o| o.value).collect();

    // 2. Froggers whose anchor-sat UTXO is spent by this tx (SPEC §6).
    //    Reverse-index lookup: only the spent UTXOs are visited.
    let spent: BTreeSet<OutPoint> = tx.inputs.iter().map(|i| i.prevout).collect();
    let mut moved: Vec<(u64, OutPoint)> = Vec::new();
    for outpoint in &spent {
        let outpoint = *outpoint;
        v.with_coin(&outpoint, &mut |entry| {
            if let Some(entry) = entry {
                moved.extend(entry.frogs.iter().map(|sat| (*sat, outpoint)));
            }
        });
    }
    // Deterministic order (ascending sat), independent of which
    // outpoints the transaction happens to spend.
    moved.sort_unstable_by_key(|(sat, _)| *sat);

    // 3. Spend old UTXOs (Ordinals FIFO assignment computed once).
    let mut assigned = assign(&inputs, &outputs);
    for outpoint in &spent {
        v.update_coin(*outpoint, &mut |entry| *entry = None);
    }

    // 4. Follow each frogger's anchor sat to its destination. The
    //    output ranges are the single `assign` result computed
    //    above — `locate_sat` would recompute `assign` per sat
    //    (a full re-scan of every input/output per frogger).
    let mut moves = Vec::with_capacity(moved.len());
    for (sat, from) in moved {
        let to = match locate_in(&assigned, sat) {
            Some(vout) => MoveDest::Output(OutPoint {
                txid: tx.txid,
                vout: vout as u32,
            }),
            // Anchor sat paid to fees (see module docs for the coinbase
            // modeling gap). The caller records the frog as burned.
            None => MoveDest::Fees,
        };
        moves.push(MoveRecord { sat, from, to });
    }

    // 5. The MINT anchor position: first sat of output 0 (SPEC §4.1).
    //    `assigned` already IS the `hopper_core::satmath::assign`
    //    result, so read the anchor from it instead of recomputing.
    let anchor_out0 = assigned
        .first()
        .and_then(|ranges| ranges.first())
        .map(|range| range.start);

    // 6. Create the new UTXOs. `assigned` is consumed here (no
    //    clone): the ranges were computed once for the whole tx and
    //    the movement step above already read them.
    for (i, out) in tx.outputs.iter().enumerate() {
        if out.value > 0 {
            let outpoint = OutPoint {
                txid: tx.txid,
                vout: i as u32,
            };
            // An outpoint that already exists here carries a bootstrap
            // seed (SPEC §9.3 operator ground truth for pre-activation
            // history): the creating tx's inputs are untracked, so its
            // own assignment would record no real ranges. The seed is
            // authoritative and must survive its creating tx — the
            // live-regtest ZMQ run caught the clobber as a lost mint.
            let mut exists = false;
            v.with_coin(&outpoint, &mut |entry| exists = entry.is_some());
            if exists {
                continue;
            }
            let mut ranges = Some(std::mem::take(&mut assigned[i]));
            v.update_coin(outpoint, &mut |entry| {
                *entry = Some(UtxoEntry {
                    value: out.value,
                    ranges: ranges.take().expect("assigned ranges"),
                    frogs: SmallVec::new(),
                });
            });
        }
    }

    // 7. Attach the moved frogs to the coins they landed in. Moves are
    //    already ascending by sat, so each coin's list stays sorted and
    //    unique. A seed-preserved coin (step 6 `continue`) exists here
    //    too, so `get_mut` is the single insertion path.
    for mv in &moves {
        if let MoveDest::Output(dest) = mv.to {
            let sat = mv.sat;
            let mut found = false;
            v.update_coin(dest, &mut |entry| {
                if let Some(entry) = entry.as_mut() {
                    found = true;
                    debug_assert!(entry.frogs.last().is_none_or(|last| *last < sat));
                    entry.frogs.push(sat);
                }
            });
            debug_assert!(found, "moved sat {mv:?} into untracked coin {dest:?}");
        }
    }

    TxFlow { moves, anchor_out0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{TxInput, TxOut};

    fn op(txid: u8, vout: u32) -> OutPoint {
        OutPoint {
            txid: [txid; 32],
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
            txid: [txid; 32],
            inputs,
            outputs,
        }
    }

    fn block_of(txs: Vec<Tx>) -> Block {
        Block {
            hash: [7; 32],
            height: 1,
            txs,
        }
    }

    /// Test fixture: register `sat` as a frogger inside an existing coin
    /// (what a MINT does via the frog record; the tracker itself only
    /// carries the reverse direction).
    fn register(t: &mut SatTracker, sat: u64, outpoint: OutPoint) {
        t.register_frog(sat, outpoint);
    }

    /// Where a sat currently sits, derived from the coins' reverse index.
    /// (The production forward index lives on `FroggerRecord::location`.)
    fn locate(t: &SatTracker, sat: u64) -> Option<OutPoint> {
        t.utxos
            .iter()
            .find(|(_, entry)| entry.frogs.binary_search(&sat).is_ok())
            .map(|(outpoint, _)| *outpoint)
    }

    #[test]
    fn frog_follows_fifo_split_across_outputs() {
        let mut tracker = SatTracker::new();
        tracker.seed_utxo(op(1, 0), vec![SatRange::new(0, 100)]);
        register(&mut tracker, 45, op(1, 0));
        let flow = tracker.apply_tx(&tx_of(
            2,
            vec![input(1, 0, 100)],
            vec![out(40), out(30), out(30)],
        ));
        // Sat 45 lies in [40, 70): the second output.
        assert_eq!(locate(&tracker, 45), Some(op(2, 1)));
        assert_eq!(flow.moves.len(), 1);
        assert_eq!(flow.moves[0].from, op(1, 0));
        assert_eq!(flow.anchor_out0, Some(0));
    }

    #[test]
    fn untracked_inputs_shadow_position_tracked_sats() {
        let mut tracker = SatTracker::new();
        tracker.seed_utxo(op(1, 0), vec![SatRange::new(1000, 1100)]);
        register(&mut tracker, 1000, op(1, 0));
        // The wallet's fee-funding input comes first in input order: its
        // (unknown) 500 sats fill output 0, pushing the frog sat to
        // output 1 (sticky-UTXO pattern, SPEC §9.4).
        let flow = tracker.apply_tx(&tx_of(
            2,
            vec![input(9, 0, 500), input(1, 0, 100)],
            vec![out(500), out(100)],
        ));
        assert_eq!(
            locate(&tracker, 1000),
            Some(op(2, 1)),
            "frog must land in output 1"
        );
        assert!(is_shadow(flow.anchor_out0.expect("output 0 has sats")));
    }

    #[test]
    fn sats_paid_to_fees_are_burned() {
        let mut tracker = SatTracker::new();
        tracker.seed_utxo(op(1, 0), vec![SatRange::new(0, 10)]);
        register(&mut tracker, 8, op(1, 0));
        // 10 sats in, 8 out: sats 8 and 9 go to fees.
        let flow = tracker.apply_tx(&tx_of(2, vec![input(1, 0, 10)], vec![out(4), out(4)]));
        assert!(locate(&tracker, 8).is_none());
        assert_eq!(locate(&tracker, 8), None);
        assert!(matches!(flow.moves[0].to, MoveDest::Fees));
    }

    #[test]
    fn consolidated_frogs_move_together() {
        let mut tracker = SatTracker::new();
        tracker.seed_utxo(op(1, 0), vec![SatRange::new(0, 10)]);
        tracker.seed_utxo(op(2, 0), vec![SatRange::new(100, 110)]);
        register(&mut tracker, 0, op(1, 0));
        register(&mut tracker, 100, op(2, 0));
        // Two frog UTXOs consolidated into one output (wallets SHOULD NOT
        // do this, SPEC §9.4, but the tracker must not break).
        let flow = tracker.apply_tx(&tx_of(
            3,
            vec![input(1, 0, 10), input(2, 0, 10)],
            vec![out(20)],
        ));
        assert_eq!(locate(&tracker, 0), Some(op(3, 0)));
        assert_eq!(locate(&tracker, 100), Some(op(3, 0)));
        assert_eq!(flow.moves.len(), 2);
    }

    #[test]
    fn zero_value_outputs_are_not_tracked() {
        let mut tracker = SatTracker::new();
        tracker.seed_utxo(op(1, 0), vec![SatRange::new(0, 10)]);
        tracker.apply_tx(&tx_of(2, vec![input(1, 0, 10)], vec![out(0), out(10)]));
        assert!(tracker.utxo(&op(2, 0)).is_none());
        assert_eq!(tracker.utxo_value(&op(2, 1)), Some(10));
    }

    #[test]
    fn anchor_out0_is_none_when_output_zero_empty() {
        let mut tracker = SatTracker::new();
        tracker.seed_utxo(op(1, 0), vec![SatRange::new(0, 10)]);
        let flow = tracker.apply_tx(&tx_of(2, vec![input(1, 0, 10)], vec![out(0), out(10)]));
        assert_eq!(flow.anchor_out0, None);
    }

    #[test]
    fn seed_value_is_derived_from_ranges() {
        let mut tracker = SatTracker::new();
        tracker.seed_utxo(op(1, 0), vec![SatRange::new(0, 4), SatRange::new(100, 110)]);
        assert_eq!(tracker.utxo_value(&op(1, 0)), Some(14));
    }

    #[test]
    fn reverse_index_finds_multi_anchor_spends_in_sat_order() {
        // Several frogger sats can share a UTXO (consolidation), and a
        // tx can spend several such UTXOs at once. The reverse index
        // must find all of them (no O(froggers) scan) and report moves
        // in ascending-sat order regardless of input order.
        let mut tracker = SatTracker::new();
        tracker.seed_utxo(op(1, 0), vec![SatRange::new(1000, 1100)]);
        tracker.seed_utxo(op(2, 0), vec![SatRange::new(2000, 2100)]);
        for sat in [1075, 1010] {
            register(&mut tracker, sat, op(1, 0));
        }
        for sat in [2050, 2005] {
            register(&mut tracker, sat, op(2, 0));
        }

        let flow = tracker.apply_tx(&tx_of(
            3,
            vec![input(1, 0, 100), input(2, 0, 100)],
            vec![out(50), out(150)],
        ));
        let sats: Vec<u64> = flow.moves.iter().map(|m| m.sat).collect();
        assert_eq!(sats, vec![1010, 1075, 2005, 2050], "ascending sat order");
        assert_eq!(locate(&tracker, 1010), Some(op(3, 0)));
        assert_eq!(locate(&tracker, 1075), Some(op(3, 1)));
        assert_eq!(locate(&tracker, 2005), Some(op(3, 1)));
        assert_eq!(locate(&tracker, 2050), Some(op(3, 1)));

        // Spending the consolidation output finds exactly those sats —
        // and only those (the other UTXO's anchors are untouched).
        let flow = tracker.apply_tx(&tx_of(4, vec![input(3, 1, 150)], vec![out(150)]));
        let sats: Vec<u64> = flow.moves.iter().map(|m| m.sat).collect();
        assert_eq!(sats, vec![1075, 2005, 2050]);
        for sat in sats {
            assert_eq!(locate(&tracker, sat), Some(op(4, 0)));
        }
        assert_eq!(locate(&tracker, 1010), Some(op(3, 0)), "still in output 0");
    }

    #[test]
    fn apply_block_processes_txs_in_order() {
        let mut tracker = SatTracker::new();
        tracker.seed_utxo(op(1, 0), vec![SatRange::new(0, 10)]);
        register(&mut tracker, 5, op(1, 0));
        let first = tx_of(2, vec![input(1, 0, 10)], vec![out(10)]);
        let second = tx_of(3, vec![input(2, 0, 10)], vec![out(4), out(6)]);
        let flows = tracker.apply_block(&block_of(vec![first, second]));
        assert_eq!(flows.len(), 2);
        assert_eq!(locate(&tracker, 5), Some(op(3, 1)));
    }

    #[test]
    fn untracked_zero_value_input_contributes_nothing() {
        let mut tracker = SatTracker::new();
        tracker.seed_utxo(op(1, 0), vec![SatRange::new(1000, 1100)]);
        register(&mut tracker, 1000, op(1, 0));
        tracker.apply_tx(&tx_of(
            2,
            vec![input(9, 0, 0), input(1, 0, 100)],
            vec![out(100)],
        ));
        assert_eq!(locate(&tracker, 1000), Some(op(2, 0)));
    }

    #[test]
    fn seed_survives_its_creating_tx() {
        // Live-regtest bug (B4 ZMQ run): a bootstrap seed's outpoint is
        // routinely CREATED on-chain after the indexer started (the
        // funding tx sits above the seed height). Its inputs are
        // untracked, so the tx's own assignment holds no real ranges —
        // the old code overwrote the seed with an empty entry and the
        // subsequent mint rejected as MintNoAnchorSat. SPEC §9.3: the
        // operator seed is ground truth and must survive its creator.
        let mut tracker = SatTracker::new();
        tracker.seed_utxo(op(7, 1), vec![SatRange::new(1000, 1100)]);
        register(&mut tracker, 1000, op(7, 1));
        let creating = tx_of(7, vec![input(9, 0, 1000)], vec![out(900), out(100)]);
        tracker.apply_tx(&creating);
        assert_eq!(
            tracker.utxo(&op(7, 1)),
            Some(&UtxoEntry {
                value: 100,
                ranges: vec![SatRange::new(1000, 1100)],
                frogs: SmallVec::from_slice(&[1000]),
            }),
            "seed entry must keep its operator-supplied ranges"
        );
        assert_eq!(locate(&tracker, 1000), Some(op(7, 1)));
        // The seed's sat still moves when the seeded outpoint is SPENT.
        let spend = tx_of(8, vec![input(7, 1, 100)], vec![out(100)]);
        tracker.apply_tx(&spend);
        assert_eq!(locate(&tracker, 1000), Some(op(8, 0)));
        assert!(tracker.utxo(&op(7, 1)).is_none());
    }

    /// The coin model's load-bearing invariant: each frogger sat is listed
    /// by at most one coin, and every coin's lists are ordered. The forward
    /// index now lives on the frog record, so this is the only cross-check
    /// the tracker itself can violate. Every mutation must preserve it.
    fn assert_coin_invariants(t: &SatTracker) {
        let mut seen = BTreeSet::new();
        for (outpoint, entry) in &t.utxos {
            assert!(
                entry.frogs.windows(2).all(|w| w[0] < w[1]),
                "coin {outpoint:?} frogs must be sorted and unique"
            );
            assert!(
                entry.ranges.windows(2).all(|w| w[0].end <= w[1].start),
                "coin {outpoint:?} ranges must be ascending and disjoint"
            );
            for sat in &entry.frogs {
                assert!(
                    seen.insert(*sat),
                    "sat {sat} must be in at most one coin ({outpoint:?})"
                );
            }
        }
    }

    #[test]
    fn coin_frogs_survive_consolidation_and_burn() {
        let mut tracker = SatTracker::new();
        tracker.seed_utxo(op(1, 0), vec![SatRange::new(1000, 1100)]);
        tracker.seed_utxo(op(2, 0), vec![SatRange::new(2000, 2100)]);
        for sat in [1001, 1050] {
            register(&mut tracker, sat, op(1, 0));
        }
        for sat in [2002, 2099] {
            register(&mut tracker, sat, op(2, 0));
        }
        assert_coin_invariants(&tracker);
        assert_eq!(tracker.frogs_at(&op(1, 0)), &[1001, 1050]);

        // Consolidate both coins: all four frogs land in output 0.
        let flow = tracker.apply_tx(&tx_of(
            3,
            vec![input(1, 0, 100), input(2, 0, 100)],
            vec![out(200)],
        ));
        assert_eq!(flow.moves.len(), 4);
        assert_coin_invariants(&tracker);
        assert_eq!(tracker.frogs_at(&op(3, 0)), &[1001, 1050, 2002, 2099]);
        assert!(tracker.frogs_at(&op(1, 0)).is_empty());

        // Pay one sat to fees: the highest sat is burned and leaves its coin.
        tracker.apply_tx(&tx_of(4, vec![input(3, 0, 200)], vec![out(0), out(199)]));
        assert!(locate(&tracker, 2099).is_none());
        assert_eq!(tracker.frogs_at(&op(4, 1)), &[1001, 1050, 2002]);
        assert_coin_invariants(&tracker);
    }

    #[test]
    fn shadow_ranges_never_overlap_real_ordinals() {
        assert!(!is_shadow(0));
        assert!(!is_shadow(hopper_core::satmath::MAX_SAT));
        assert!(is_shadow(SHADOW_BASE));
        let a = shadow_range(0, 1000).pop().expect("non-empty");
        let b = shadow_range(1, 1000).pop().expect("non-empty");
        assert!(
            a.end <= b.start,
            "consecutive shadow slots must not overlap"
        );
        // Graceful degradation on absurd input counts.
        assert!(shadow_range(usize::MAX, 1).is_empty());
        assert!(shadow_range(0, 0).is_empty());
    }
}
