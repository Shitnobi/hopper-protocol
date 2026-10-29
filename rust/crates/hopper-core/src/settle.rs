//! Settlement core (V3-FINAL-SPEC §5).
//!
//! `SHA256("FRG3-CROSS" ‖ sat ‖ H(B))`, death iff
//! `x·10000 < death_bps(target)·2^32` with the target frozen at the CROSS
//! block. An exact integer test with no modulo bias. The v2.2
//! commit/reveal/substitution game was removed by the v3 cutover (§15).

use sha2::{Digest, Sha256};

/// v3 digest domain, 10 bytes, exact spelling (V3-FINAL-SPEC §5.1).
pub const CROSS_DOMAIN: &[u8] = b"FRG3-CROSS";

/// v3 settlement digest: `SHA256("FRG3-CROSS" ‖ sat ‖ H(B))`.
///
/// `outcome_block_hash` is the 32-byte block hash of `B = T + 1` in
/// **internal** byte order (reverse only for display).
pub fn cross_digest(frogger_sat: u64, outcome_block_hash: &[u8; 32]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(CROSS_DOMAIN);
    h.update(frogger_sat.to_le_bytes());
    h.update(outcome_block_hash);
    h.finalize().into()
}

/// True = ROADKILL at the frozen `target` (V3-FINAL-SPEC §5.1).
///
/// `P(dead) = death_bps(target)/10000` to within `2^-32`; at the genesis
/// target this is exactly the historical `x < 2^30` test.
pub fn dies_v3(frogger_sat: u64, outcome_block_hash: &[u8; 32], target: u32) -> bool {
    let d = cross_digest(frogger_sat, outcome_block_hash);
    let x = u32::from_le_bytes([d[0], d[1], d[2], d[3]]) as u64;
    x * 10_000 < (u64::from(crate::hops::death_bps(target))) << 32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v3_golden_vectors_12_2() {
        // (sat, H(B), target, digest, verdict). The sat-42 row is the
        // boundary case: the same digest is DEAD at targets 5 and 25 and
        // ALIVE at 50 and 100, because the threshold falls.
        let zero = [0u8; 32];
        let h42: [u8; 32] = [
            0x7d, 0xc9, 0x6f, 0x77, 0x6c, 0x84, 0x23, 0xe5, 0x7a, 0x27, 0x85, 0x48, 0x9a, 0x3f,
            0x9c, 0x43, 0xfb, 0x6e, 0x75, 0x68, 0x76, 0xd6, 0xad, 0x9a, 0x9c, 0xac, 0x4a, 0xa4,
            0xe7, 0x2e, 0xc1, 0x93,
        ];
        let cases: &[(u64, &[u8; 32], u32, &str, bool)] = &[
            (
                0,
                &zero,
                5,
                "a4d65b512022b78331a1cabcb3bed66d902d0e5106b4e9453549b01b06a08042",
                false,
            ),
            (
                42,
                &h42,
                5,
                "8566f20ea7c0a42969905ce37f97e2a82667e0ce2129ac319adca0b233abcd1c",
                true,
            ),
            (
                42,
                &h42,
                25,
                "8566f20ea7c0a42969905ce37f97e2a82667e0ce2129ac319adca0b233abcd1c",
                true,
            ),
            (
                42,
                &h42,
                50,
                "8566f20ea7c0a42969905ce37f97e2a82667e0ce2129ac319adca0b233abcd1c",
                false,
            ),
            (
                0,
                &zero,
                100,
                "a4d65b512022b78331a1cabcb3bed66d902d0e5106b4e9453549b01b06a08042",
                false,
            ),
            (
                29,
                &zero,
                100,
                "b2fa5806e022bab032236f26d312726dad509587ead4a9cc4373708f8f7af5b7",
                true,
            ),
            (
                35,
                &zero,
                100,
                "89983700098a41b74919d532b630763763e10db5c998e5c4de65b8377e1e5c48",
                true,
            ),
        ];
        for &(sat, hash, target, want_digest, want_dead) in cases {
            let d = cross_digest(sat, hash);
            assert_eq!(hex(&d), want_digest, "sat {sat} target {target}");
            assert_eq!(
                dies_v3(sat, hash, target),
                want_dead,
                "sat {sat} target {target} (bps {})",
                crate::hops::death_bps(target)
            );
        }
    }

    #[test]
    fn flat_target_matches_the_exact_quarter_test() {
        // 2500 bps must be bit-identical to `x < 2^30` for every digest.
        for sat in 0..2_000u64 {
            let mut hash = [0u8; 32];
            hash[..8].copy_from_slice(&sat.to_le_bytes());
            assert_eq!(dies_v3(sat, &hash, 5), dies_v3(sat, &hash, 0));
            let d = cross_digest(sat, &hash);
            let x = u32::from_le_bytes([d[0], d[1], d[2], d[3]]);
            assert_eq!(dies_v3(sat, &hash, 5), x < (1 << 30));
        }
    }

    #[test]
    fn v3_death_distribution_matches_the_table() {
        // 200k deterministic samples per target; tolerance is several
        // sigma for this N. No float in the runtime path.
        for target in [5u32, 25, 50, 100] {
            let bps = crate::hops::death_bps(target);
            let n = 200_000u32;
            let dead = (0..n)
                .filter(|i| {
                    let mut hash = [0u8; 32];
                    hash[..4].copy_from_slice(&i.to_le_bytes());
                    hash[8..16].copy_from_slice(&u64::from(target).to_le_bytes());
                    dies_v3(u64::from(*i), &hash, target)
                })
                .count();
            let want = f64::from(bps) / 10_000.0;
            let got = dead as f64 / n as f64;
            assert!(
                (got - want).abs() < 0.004,
                "target {target}: {got} vs {want}"
            );
        }
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}
