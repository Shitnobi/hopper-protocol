//! The hop-requirement schedule (V3-FINAL-SPEC §3).
//!
//! Pure integer math, no allocation, no floats, no chain access. The
//! requirement is a function of block height only; the target used to settle
//! a crossing is frozen when the CROSS confirms (§3.4).

use crate::params::{self, HopParams, DEATH_BPS, MAX_TARGET, PROTOCOL};

/// The anchors `(A1, A2, A3)` of a schedule (V3-FINAL-SPEC §3.1).
///
/// They satisfy `required(A1) == until1`, `required(A2) == until2`,
/// `required(A3) == ceiling`, so the piecewise formulas agree at every
/// boundary and there is no off-by-one.
impl HopParams {
    pub const fn anchor1(&self) -> u32 {
        self.genesis + (self.until1 - self.base) * self.step1
    }

    pub const fn anchor2(&self) -> u32 {
        self.anchor1() + (self.until2 - self.until1) * self.step2
    }

    pub const fn anchor3(&self) -> u32 {
        self.anchor2() + (self.ceiling - self.until2) * self.step3
    }

    /// Hops required for immortality at `height`. Monotonically
    /// non-decreasing, truncating integer division.
    pub const fn required(&self, height: u32) -> u32 {
        if height <= self.genesis {
            return self.base;
        }
        if height < self.anchor1() {
            return self.base + (height - self.genesis) / self.step1;
        }
        if height < self.anchor2() {
            return self.until1 + (height - self.anchor1()) / self.step2;
        }
        if height < self.anchor3() {
            return self.until2 + (height - self.anchor2()) / self.step3;
        }
        self.ceiling
    }
}

/// Hops required at `height` under the production schedule.
#[inline]
pub const fn required_hops(height: u32) -> u32 {
    PROTOCOL.hops.required(height)
}

/// The next height at which the requirement rises, with its new value.
/// `None` once the cap is reached.
///
/// Used by the API (`next_target_height`) and the GUI countdown.
pub fn next_increment(height: u32) -> Option<(u32, u32)> {
    let p = &PROTOCOL.hops;
    let next = if height < p.anchor1() {
        // Below genesis the first increment is at `genesis + step1`.
        let elapsed = height.saturating_sub(p.genesis);
        p.genesis + (elapsed / p.step1 + 1) * p.step1
    } else if height < p.anchor2() {
        p.anchor1() + ((height - p.anchor1()) / p.step2 + 1) * p.step2
    } else if height < p.anchor3() {
        p.anchor2() + ((height - p.anchor2()) / p.step3 + 1) * p.step3
    } else {
        return None;
    };
    Some((next, p.required(next)))
}

/// Death probability in basis points at `target` (V3-FINAL-SPEC §3.6).
///
/// A table lookup: the runtime never evaluates a root. Targets above
/// [`MAX_TARGET`] clamp to the cap, which is also the hardest value.
#[inline]
pub const fn death_bps(target: u32) -> u16 {
    match PROTOCOL.death {
        params::DeathModel::Flat25 => 2_500,
        params::DeathModel::HybridFloor => {
            DEATH_BPS[if target > MAX_TARGET {
                MAX_TARGET as usize
            } else {
                target as usize
            }]
        }
    }
}

/// Death probability in basis points at the production target for `height`.
#[inline]
pub const fn death_bps_at(height: u32) -> u16 {
    death_bps(required_hops(height))
}

/// Chance of finishing `target` consecutive hops, in basis points.
///
/// Display only (the API and the GUI show it); consensus uses
/// [`death_bps`]. `f64` is deliberate: the value must be monotone and
/// readable, not bit-exact across platforms.
pub fn completion_bps(target: u32) -> u32 {
    let p = f64::from(death_bps(target)) / 10_000.0;
    let finish = (1.0 - p).powi(target as i32);
    (finish * 10_000.0).round() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// V3-FINAL-SPEC §12.1 uses `genesis = 1000` so an off-by-one at the
    /// boundary is visible.
    const TEST: HopParams = HopParams {
        genesis: 1_000,
        base: 5,
        step1: 64,
        until1: 25,
        step2: 144,
        until2: 50,
        step3: 2_016,
        ceiling: 100,
    };

    #[test]
    fn anchors_are_genesis_plus_the_schedule_offsets() {
        let p = PROTOCOL.hops;
        // 20 intervals of 64, 25 of 144, 50 of 2016 — independent of where
        // the deployment starts, so re-framing needs no edit here.
        assert_eq!(
            [p.anchor1(), p.anchor2(), p.anchor3()],
            [p.genesis + 1_280, p.genesis + 4_880, p.genesis + 105_680]
        );
    }

    #[test]
    fn anchors_with_genesis_1000() {
        assert_eq!(
            [TEST.anchor1(), TEST.anchor2(), TEST.anchor3()],
            [2_280, 5_880, 106_680]
        );
    }

    #[test]
    fn schedule_vectors_12_1() {
        // (height, requirement, note). One row is corrected:
        // V3-FINAL-SPEC §12.1 says 6896 -> 51, but with genesis = 1000 the
        // phase-3 anchor is 5880, so the first phase-3 increment is
        // 5880 + 2016 = 7896; 6896 is still 50. The spec's §3.3 table (which
        // uses genesis = 0, anchor 4880) is correct. See
        // CONSENSUS-REDESIGN-PLAN.md.
        let cases = [
            (999, 5, "clamped below genesis"),
            (1_000, 5, "base"),
            (1_063, 5, "last of the first interval"),
            (1_064, 6, "first increment"),
            (2_279, 24, "last before phase 2"),
            (2_280, 25, "anchor 1"),
            (2_423, 25, "last of the first 144-interval"),
            (2_424, 26, "first phase-2 increment"),
            (5_879, 49, "last before phase 3"),
            (5_880, 50, "anchor 2"),
            (6_895, 50, "last of the first 2016-interval"),
            (6_896, 50, "one past it (spec errata: not 51)"),
            (7_895, 50, "last before the first phase-3 increment"),
            (7_896, 51, "first phase-3 increment"),
            (106_679, 99, "last before the cap"),
            (106_680, 100, "anchor 3"),
            (106_681, 100, "capped"),
            (u32::MAX, 100, "no overflow"),
        ];
        for (height, want, note) in cases {
            assert_eq!(TEST.required(height), want, "height {height} ({note})");
        }
    }

    #[test]
    fn default_schedule_vectors() {
        let p = PROTOCOL.hops;
        // Appendix B at a glance, expressed as offsets from `genesis`: the
        // schedule is a function of `height - genesis`, so these vectors
        // survive re-framing (signet → mainnet) without a second edit.
        let g = p.genesis;
        assert_eq!(p.required(g), 5);
        assert_eq!(p.required(g + 63), 5);
        assert_eq!(p.required(g + 64), 6);
        assert_eq!(p.required(p.anchor1() - 1), 24);
        assert_eq!(p.required(p.anchor1()), 25);
        assert_eq!(p.required(p.anchor2() - 1), 49);
        assert_eq!(p.required(p.anchor2()), 50);
        assert_eq!(p.required(p.anchor3() - 1), 99);
        assert_eq!(p.required(p.anchor3()), 100);
        assert_eq!(p.required(u32::MAX), 100);
        // Below genesis is the base, never zero and never a wrap.
        assert_eq!(p.required(0), 5);
    }

    #[test]
    fn monotone_and_total_over_the_whole_ramp() {
        for h in 0..200_000u32 {
            let a = TEST.required(h);
            let b = TEST.required(h + 1);
            assert!(b >= a, "not monotone at {h}: {a} -> {b}");
            assert!(b - a <= 1, "jumped at {h}: {a} -> {b}");
            assert!((TEST.base..=TEST.ceiling).contains(&a));
        }
    }

    #[test]
    fn next_increment_examples() {
        assert_eq!(next_increment_for(&TEST, 1_063), Some((1_064, 6)));
        assert_eq!(next_increment_for(&TEST, 2_280), Some((2_424, 26)));
        assert_eq!(next_increment_for(&TEST, 106_679), Some((106_680, 100)));
        assert_eq!(next_increment_for(&TEST, 106_680), None);
        assert_eq!(next_increment_for(&TEST, u32::MAX), None);
    }

    /// `next_increment` reads the production schedule; this mirrors it for a
    /// fixture without introducing a second implementation.
    fn next_increment_for(p: &HopParams, height: u32) -> Option<(u32, u32)> {
        let next = if height < p.anchor1() {
            let elapsed = height.saturating_sub(p.genesis);
            p.genesis + (elapsed / p.step1 + 1) * p.step1
        } else if height < p.anchor2() {
            p.anchor1() + ((height - p.anchor1()) / p.step2 + 1) * p.step2
        } else if height < p.anchor3() {
            p.anchor2() + ((height - p.anchor2()) / p.step3 + 1) * p.step3
        } else {
            return None;
        };
        Some((next, p.required(next)))
    }

    #[test]
    fn production_next_increment() {
        let g = PROTOCOL.hops.genesis;
        let a1 = PROTOCOL.hops.anchor1();
        let a2 = PROTOCOL.hops.anchor2();
        assert_eq!(next_increment(g + 63), Some((g + 64, 6)));
        assert_eq!(next_increment(a1 - 1), Some((a1, 25)));
        assert_eq!(next_increment(a1), Some((a1 + 144, 26)));
        assert_eq!(next_increment(a2), Some((a2 + 2_016, 51)));
        assert_eq!(next_increment(a2 + 2_016 - 1), Some((a2 + 2_016, 51)));
        assert_eq!(next_increment(PROTOCOL.hops.anchor3()), None);
    }

    #[test]
    fn death_bps_is_a_lookup_and_clamps() {
        assert_eq!(death_bps(5), 2_500);
        assert_eq!(death_bps(25), 682);
        assert_eq!(death_bps(100), 295);
        assert_eq!(death_bps(1_000), 295);
        assert_eq!(death_bps_at(0), 2_500);
        assert_eq!(death_bps_at(PROTOCOL.hops.anchor3()), 295);
    }

    #[test]
    fn completion_bps_matches_the_spec_table() {
        for (target, expected) in [
            (5u32, 2_373u32),
            (10, 2_187),
            (25, 1_705),
            (50, 1_134),
            (75, 753),
            (100, 505),
        ] {
            let got = completion_bps(target);
            assert!(
                got.abs_diff(expected) <= 10,
                "target {target}: {got} vs {expected}"
            );
        }
    }
}
