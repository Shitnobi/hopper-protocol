//! Ordinals sat-position math (SPEC §4).
//!
//! Sats move through a transaction **first-in-first-out**: input sats, in
//! input order and each input's sats in ordinal order, fill the outputs in
//! output order, each output absorbing up to its value in sats. Zero-value
//! outputs receive nothing. Sats in excess of total output value go to
//! fees (the miner's coinbase transaction, by the same rule).
//!
//! This module is the single implementation of that rule shared by the
//! indexer (tracking which output carries a frogger's anchor sat) and the
//! wallet (building transfers that preserve the anchor sat's position).
//!
//! Semantics mirror the `ord` reference implementation:
//! - assignment is by sat RANGE (contiguous `[start, end)` spans), not
//!   per-sat iteration — O(inputs + outputs), not O(value);
//! - a range flowing across multiple outputs is split, preserving order;
//! - empty outputs are skipped without consuming sats.

/// A contiguous span of ordinals, half-open `[start, end)`.
///
/// `end` may equal 2^63 * COIN ... practically, sat numbers fit in `u64`
/// with the total supply being 2_099_999_997_690_000.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct SatRange {
    pub start: u64,
    pub end: u64,
}

impl SatRange {
    pub fn new(start: u64, end: u64) -> Self {
        assert!(start <= end, "empty-start range");
        Self { start, end }
    }

    pub fn len(&self) -> u64 {
        self.end - self.start
    }

    pub fn is_empty(&self) -> bool {
        self.start == self.end
    }
}

/// Total bitcoin supply in sats (for sanity checks; not load-bearing).
pub const MAX_SAT: u64 = 2_099_999_997_690_000;

/// Assign input sat ranges to outputs, FIFO.
///
/// `inputs` are the sat ranges of the transaction's inputs **in input
/// order** (each already in ascending ordinal order). `outputs` are the
/// output values in sats, in output order. Returns, for each output, the
/// ordered list of sat ranges it absorbs. Sats beyond total output value
/// are fees and are simply absent from the result.
///
/// # Examples
///
/// ```
/// use hopper_core::satmath::{assign, SatRange};
/// // One 10-sat input split across two 5-sat outputs.
/// let out = assign(&[SatRange::new(0, 10)], &[5, 5]);
/// assert_eq!(out[0], vec![SatRange::new(0, 5)]);
/// assert_eq!(out[1], vec![SatRange::new(5, 10)]);
/// ```
pub fn assign(inputs: &[SatRange], outputs: &[u64]) -> Vec<Vec<SatRange>> {
    let mut result: Vec<Vec<SatRange>> = vec![Vec::new(); outputs.len()];
    if inputs.is_empty() || outputs.is_empty() {
        return result;
    }

    let mut out_idx = 0usize; // current output being filled
    let mut out_used = 0u64; // sats already assigned to it

    'inputs: for range in inputs {
        // Skip empty input ranges (defensive; the ord data model never
        // produces them, but a wallet must not panic on hostile data).
        if range.is_empty() {
            continue;
        }
        let mut remaining = range.len();
        let end = range.end;
        loop {
            // Advance past full/empty outputs.
            while out_idx < outputs.len() && outputs[out_idx] == out_used {
                out_idx += 1;
                out_used = 0;
            }
            if out_idx >= outputs.len() {
                // Remaining sats are fees.
                continue 'inputs;
            }
            let cap = outputs[out_idx] - out_used;
            let take = cap.min(remaining);
            let seg_start = end - remaining;
            result[out_idx].push(SatRange::new(seg_start, seg_start + take));
            remaining -= take;
            out_used += take;
            if remaining == 0 {
                continue 'inputs;
            }
        }
    }
    result
}

/// Where does sat `sat` land after this transaction?
///
/// Returns `(output_index, offset_in_output)` if the sat is consumed by an
/// output, or `None` if it went to fees (or was not among the inputs).
pub fn locate_sat(inputs: &[SatRange], outputs: &[u64], sat: u64) -> Option<(usize, u64)> {
    for (out_idx, out_ranges) in assign(inputs, outputs).iter().enumerate() {
        let mut offset = 0u64;
        for r in out_ranges {
            if r.start <= sat && sat < r.end {
                return Some((out_idx, offset + (sat - r.start)));
            }
            offset += r.len();
        }
    }
    None
}

/// The frogger anchor: the first sat assigned to output 0 (SPEC §4.1).
///
/// Returns `None` if output 0 receives no sats — such a MINT is invalid
/// and carries no frogger. Also rejects an empty output-0 range list.
pub fn anchor_sat(inputs: &[SatRange], outputs: &[u64]) -> Option<u64> {
    let assigned = assign(inputs, outputs);
    let first = assigned.first()?;
    let first_range = first.first()?;
    Some(first_range.start)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(a: u64, b: u64) -> SatRange {
        SatRange::new(a, b)
    }

    // --- vectors modeled on the ord reference test suite (src/sat.rs,
    // assign tests) plus canonical ordinal-theory cases --------------------

    #[test]
    fn single_input_single_output() {
        let out = assign(&[r(0, 100)], &[100]);
        assert_eq!(out, vec![vec![r(0, 100)]]);
    }

    #[test]
    fn one_range_split_across_outputs() {
        // ord: assign(&[range(0,100)], [40, 30, 30])
        let out = assign(&[r(0, 100)], &[40, 30, 30]);
        assert_eq!(out[0], vec![r(0, 40)]);
        assert_eq!(out[1], vec![r(40, 70)]);
        assert_eq!(out[2], vec![r(70, 100)]);
    }

    #[test]
    fn multiple_inputs_fill_in_order() {
        // Inputs are consumed strictly in order: input 0's sats land in the
        // earliest outputs, then input 1's, etc.
        let out = assign(&[r(0, 10), r(50, 60)], &[15, 5]);
        assert_eq!(out[0], vec![r(0, 10), r(50, 55)]);
        assert_eq!(out[1], vec![r(55, 60)]);
    }

    #[test]
    fn fee_sats_are_dropped() {
        // 10 in, 4+4 out -> 2 sats to fees.
        let out = assign(&[r(0, 10)], &[4, 4]);
        assert_eq!(out[0], vec![r(0, 4)]);
        assert_eq!(out[1], vec![r(4, 8)]);
    }

    #[test]
    fn zero_value_outputs_receive_nothing() {
        // ord skips empty outputs entirely.
        let out = assign(&[r(0, 10)], &[0, 10, 0]);
        assert_eq!(out[0], Vec::<SatRange>::new());
        assert_eq!(out[1], vec![r(0, 10)]);
        assert_eq!(out[2], Vec::<SatRange>::new());
    }

    #[test]
    fn large_values_split_without_iteration() {
        // 10 BTC in, 5+5 out. Must not iterate per-sat.
        let a = 1_000_000_000u64;
        let out = assign(&[r(0, a)], &[a / 2, a / 2]);
        assert_eq!(out[0], vec![r(0, a / 2)]);
        assert_eq!(out[1], vec![r(a / 2, a)]);
    }

    #[test]
    fn empty_inputs_or_outputs() {
        assert!(assign(&[], &[5]).iter().all(|o| o.is_empty()));
        assert!(assign(&[r(0, 5)], &[]).is_empty());
    }

    // --- anchor sat (SPEC §4.1) ---------------------------------------------

    #[test]
    fn anchor_is_first_sat_of_output_zero() {
        // A realistic mint: two inputs (a small dust sat and a funding
        // UTXO), anchor output 0 with 1000 sats.
        let a = anchor_sat(
            &[r(1_000_000, 1_001_000), r(1_500_000, 1_700_000)],
            &[1000, 150_000, 48_000],
        );
        assert_eq!(a, Some(1_000_000));
    }

    #[test]
    fn anchor_none_when_output_zero_empty() {
        // Output 0 is dust-free (value 0): invalid mint, no anchor.
        assert_eq!(anchor_sat(&[r(0, 10)], &[0, 10]), None);
    }

    #[test]
    fn anchor_survives_input_reordering_only_by_order() {
        // FIFO means input ORDER decides which sats reach output 0.
        let a1 = anchor_sat(&[r(0, 5), r(100, 105)], &[5, 5]);
        let a2 = anchor_sat(&[r(100, 105), r(0, 5)], &[5, 5]);
        assert_eq!(a1, Some(0));
        assert_eq!(a2, Some(100));
    }

    // --- locate_sat ----------------------------------------------------------

    #[test]
    fn locate_across_split_range() {
        let inputs = [r(0, 100)];
        let outputs = [40, 30, 30];
        assert_eq!(locate_sat(&inputs, &outputs, 0), Some((0, 0)));
        assert_eq!(locate_sat(&inputs, &outputs, 39), Some((0, 39)));
        assert_eq!(locate_sat(&inputs, &outputs, 40), Some((1, 0)));
        assert_eq!(locate_sat(&inputs, &outputs, 69), Some((1, 29)));
        assert_eq!(locate_sat(&inputs, &outputs, 70), Some((2, 0)));
        assert_eq!(locate_sat(&inputs, &outputs, 99), Some((2, 29)));
        // Off the end -> fees.
        assert_eq!(locate_sat(&inputs, &outputs, 100), None);
        // Not in inputs at all.
        assert_eq!(locate_sat(&inputs, &outputs, 500), None);
    }

    #[test]
    fn locate_offset_spans_multiple_input_ranges() {
        // Output 0 = [0,10) + [50,55): sat 52 is at offset 12.
        let inputs = [r(0, 10), r(50, 60)];
        assert_eq!(locate_sat(&inputs, &[15, 5], 52), Some((0, 12)));
        assert_eq!(locate_sat(&inputs, &[15, 5], 57), Some((1, 2)));
    }

    // --- invariants -----------------------------------------------------------

    #[test]
    fn conservation() {
        // Property-style: assigned sats per output == output value, in
        // aggregate, whenever inputs fully cover outputs.
        let inputs = [r(7, 1234), r(2000, 3000), r(99_999, 100_001)];
        let outputs = [500u64, 1, 0, 1000, 723];
        let out = assign(&inputs, &outputs);
        for (i, (&value, ranges)) in outputs.iter().zip(&out).enumerate() {
            let total: u64 = ranges.iter().map(SatRange::len).sum();
            assert_eq!(total, value, "output {i} value mismatch");
        }
        // Total assigned <= total input.
        let total_in: u64 = inputs.iter().map(SatRange::len).sum();
        let total_assigned: u64 = out.iter().flatten().map(SatRange::len).sum();
        assert!(total_assigned <= total_in);
        // Fee amount is exact.
        let total_out: u64 = outputs.iter().sum();
        assert_eq!(total_assigned, total_out.min(total_in));
    }

    #[test]
    fn order_preservation() {
        // Every output's ranges are strictly increasing (FIFO, no overlap).
        let inputs = [r(0, 100), r(500, 600)];
        let outputs = [60, 60, 60];
        for ranges in assign(&inputs, &outputs) {
            for w in ranges.windows(2) {
                assert!(w[0].end <= w[1].start, "ranges not ordered: {w:?}");
            }
        }
    }
}
