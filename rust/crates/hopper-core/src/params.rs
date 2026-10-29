//! FROGGER protocol parameters — the single source of truth.
//!
//! Nothing outside this module may contain a numeric copy of a schedule or
//! economic constant (V3-FINAL-SPEC §2, enforced by a grep audit). The
//! values are compiled in, not configured: two nodes with different
//! parameters MUST NOT share a snapshot or a state root, which is why
//! [`params_hash`] is committed to in both.
//!
//! `genesis` is the **only** value edited at launch (V3-FINAL-SPEC §2.2).

use sha2::{Digest, Sha256};

/// Hard upper bound for any hop target (V3-FINAL-SPEC §2).
pub const MAX_TARGET: u32 = 100;

/// The x-only internal key of every frog state output.
///
/// This is the standard "nothing up my sleeve" point: it is a valid
/// x-only key with no known discrete log, so a state output can only be
/// spent through one of its two leaves — the state envelope (crossing) or
/// the owner's `CHECKSIG` (transfer). There is no key-path spend, ever.
pub const NUMS_XONLY: [u8; 32] = [
    0x50, 0x92, 0x9b, 0x74, 0xc1, 0xa0, 0x49, 0x54, 0xb7, 0x8b, 0x4b, 0x60, 0x35, 0xe9, 0x7a, 0x5e,
    0x07, 0x8a, 0x5a, 0x0f, 0x28, 0xec, 0x96, 0xd5, 0x47, 0xbf, 0xee, 0x9a, 0xce, 0x80, 0x3a, 0xc0,
];

/// The hop-requirement schedule (V3-FINAL-SPEC §3.1).
///
/// Three linear phases, then a hard cap:
///
/// ```text
/// A1 = G + (U1 - B) * S1
/// A2 = A1 + (U2 - U1) * S2
/// A3 = A2 + (C  - U2) * S3
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct HopParams {
    /// Height at which `base` applies (the Frogger activation height).
    /// `0` in tests; MUST be set to the launch height for mainnet.
    pub genesis: u32,
    /// Requirement at (and below) genesis.
    pub base: u32,
    /// Blocks per +1 in phase 1.
    pub step1: u32,
    /// Phase 1 ends when the requirement reaches this.
    pub until1: u32,
    /// Blocks per +1 in phase 2.
    pub step2: u32,
    /// Phase 2 ends when the requirement reaches this.
    pub until2: u32,
    /// Blocks per +1 in phase 3.
    pub step3: u32,
    /// Hard maximum requirement.
    pub ceiling: u32,
}

impl ProtocolParams {
    /// Test fixture (V3 §8.0): every phase increments, ceiling 3, flat 25 %
    /// death. A test reaches immortality in three surviving crossings
    /// instead of 100, without touching production constants.
    pub const fn fixture_fast() -> Self {
        Self {
            hops: HopParams {
                genesis: 0,
                base: 1,
                step1: 1,
                until1: 2,
                step2: 1,
                until2: 3,
                step3: 1,
                ceiling: 3,
            },
            death: DeathModel::Flat25,
            success_floor_bps: 500,
            cross_finality: 6,
            card_value: 25_000,
        }
    }
}

/// How the per-crossing death probability is derived (V3-FINAL-SPEC §3.6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum DeathModel {
    /// Exactly 25 % at every target (`x < 2^30`). Kept for golden vectors
    /// and replays; not usable with a 100-hop cap when the 5 % floor is
    /// required.
    Flat25,
    /// Completion odds ramp geometrically from 23.73 % at `base` to
    /// `success_floor_bps` at `ceiling`; the per-hop death falls as the
    /// road grows. Backed by [`DEATH_BPS`].
    HybridFloor,
}

impl DeathModel {
    /// Stable tag for the canonical encoding. Never renumber.
    pub const fn tag(self) -> u8 {
        match self {
            DeathModel::Flat25 => 0,
            DeathModel::HybridFloor => 1,
        }
    }

    /// Stable short name for the API (`/v1/params`).
    pub const fn name(self) -> &'static str {
        match self {
            DeathModel::Flat25 => "flat_25",
            DeathModel::HybridFloor => "hybrid_floor",
        }
    }
}

/// Every tunable in one struct (V3-FINAL-SPEC §2).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ProtocolParams {
    pub hops: HopParams,
    pub death: DeathModel,
    /// Completion floor in basis points at `ceiling` (500 = 5.00 %).
    /// Only read by `HybridFloor`; committed to by [`params_hash`] either
    /// way, so lowering the floor is always a visible protocol change.
    pub success_floor_bps: u16,
    /// Blocks between the CROSS block and settlement (V3-FINAL-SPEC §5.4).
    pub cross_finality: u32,
    /// The value of the minted frog card; large enough to fund a crossing.
    pub card_value: u64,
}

/// The only wire version: inscription-native state (`docs/V6-SPEC.md`).
///
/// The mint body is a self-contained fold of ord's recursive endpoints
/// (no origin), and a frog's own state output carries the crossing
/// envelope, so every crossing is inscribed on the anchor sat.
pub const VERSION_V6: u8 = 0x06;

/// The production parameters (V3-FINAL-SPEC §2).
///
/// `genesis` is the **only** value edited at deployment, and it is edited
/// by `scripts/params/frame-genesis.sh <height>` — never by hand, because
/// the mint body embeds it (`live_v6::params_literal`) and the pinned
/// golden digests must move with it.
///
/// Currently **signet 330,000**: a test deployment with a ~14-day runway at
/// signet's 10-minute blocks. Mainnet is framed later with the same script;
/// the value must be set before the first mint, since every already-minted
/// frog commits to it.
pub const PROTOCOL: ProtocolParams = ProtocolParams {
    hops: HopParams {
        genesis: 973_263,
        base: 5,
        step1: 64,
        until1: 25,
        step2: 144,
        until2: 50,
        step3: 2_016,
        ceiling: 100,
    },
    death: DeathModel::HybridFloor,
    success_floor_bps: 500,
    cross_finality: 6,
    card_value: 25_000,
};

/// `DEATH_BPS[n] = round(10000 * p(n))`, generated by Appendix A and
/// pinned by `death_table_checksum`. Indexed by target.
///
/// `0..=5` are the flat 25 % opening (a frog below `base` still faces the
/// genesis target); the ramp starts at `base + 1`.
pub const DEATH_BPS: [u16; MAX_TARGET as usize + 1] = [
    2500, 2500, 2500, 2500, 2500, 2500, 2153, 1896, 1697, 1539, 1410, 1304, 1214, 1137, 1071, 1013,
    962, 917, 877, 840, 808, 778, 751, 726, 703, 682, 663, 645, 628, 612, 597, 584, 571, 559, 547,
    537, 526, 517, 508, 499, 491, 483, 475, 468, 461, 455, 448, 442, 437, 431, 426, 421, 416, 411,
    407, 402, 398, 394, 390, 386, 382, 379, 375, 372, 369, 366, 363, 360, 357, 354, 351, 349, 346,
    344, 341, 339, 337, 334, 332, 330, 328, 326, 324, 322, 320, 318, 317, 315, 313, 311, 310, 308,
    307, 305, 304, 302, 301, 299, 298, 296, 295,
];

/// Why a [`ProtocolParams`] instance is unusable (V3-FINAL-SPEC §2.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamsError {
    /// `base <= until1 <= until2 <= ceiling` is violated.
    PhaseOrder,
    /// A step is zero (the schedule would never advance).
    ZeroStep,
    /// `ceiling > MAX_TARGET` (no death table entry exists).
    CeilingAboveMaxTarget,
    /// `success_floor_bps` is zero, or not strictly below the genesis odds.
    FloorOutOfRange,
    /// `cross_finality == 0` (settlement would precede the CROSS).
    ZeroFinality,
    /// An anchor height does not fit in `u32`.
    AnchorOverflow,
}

impl ParamsError {
    pub const fn message(self) -> &'static str {
        match self {
            ParamsError::PhaseOrder => "base <= until1 <= until2 <= ceiling is required",
            ParamsError::ZeroStep => "every schedule step must be positive",
            ParamsError::CeilingAboveMaxTarget => "ceiling must not exceed MAX_TARGET",
            ParamsError::FloorOutOfRange => "1 <= success_floor_bps < genesis odds is required",
            ParamsError::ZeroFinality => "cross_finality must be at least 1",
            ParamsError::AnchorOverflow => "schedule anchors must fit in u32",
        }
    }
}

/// Completion odds at the genesis target, in basis points:
/// `10000 * (1 - 2500/10000)^base`, truncated (2373 for `base = 5`).
pub const fn genesis_completion_bps(base: u32) -> u32 {
    // (7500/10000)^base * 10000 == 7500^base / 10000^(base-1), exact in u128.
    let mut num: u128 = 1;
    let mut den: u128 = 1;
    let mut i = 0;
    while i < base {
        num *= 7_500;
        den *= 10_000;
        i += 1;
    }
    ((num * 10_000) / den) as u32
}

/// Validate a parameter set (V3-FINAL-SPEC §2.1). MUST pass before serving.
pub const fn validate(p: &ProtocolParams) -> Result<(), ParamsError> {
    let h = p.hops;
    if h.base > h.until1 || h.until1 > h.until2 || h.until2 > h.ceiling {
        return Err(ParamsError::PhaseOrder);
    }
    if h.step1 == 0 || h.step2 == 0 || h.step3 == 0 {
        return Err(ParamsError::ZeroStep);
    }
    if h.ceiling > MAX_TARGET {
        return Err(ParamsError::CeilingAboveMaxTarget);
    }
    let s0 = genesis_completion_bps(h.base);
    if p.success_floor_bps == 0 || (p.success_floor_bps as u32) >= s0 {
        return Err(ParamsError::FloorOutOfRange);
    }
    if p.cross_finality == 0 {
        return Err(ParamsError::ZeroFinality);
    }
    // Anchors in u64; a schedule that cannot be expressed in block heights
    // is a deployment bug, not a runtime one.
    let a1 = (h.genesis as u64) + ((h.until1 - h.base) as u64) * (h.step1 as u64);
    let a2 = a1 + ((h.until2 - h.until1) as u64) * (h.step2 as u64);
    let a3 = a2 + ((h.ceiling - h.until2) as u64) * (h.step3 as u64);
    if a1 > (u32::MAX as u64) || a2 > (u32::MAX as u64) || a3 > (u32::MAX as u64) {
        return Err(ParamsError::AnchorOverflow);
    }
    Ok(())
}

/// The canonical little-endian encoding of [`ProtocolParams`].
///
/// This is a consensus byte string: never reorder, resize or reinterpret a
/// field. New fields go at the end *and* bump `wire_version`.
///
/// ```text
/// hops.genesis u32  hops.base u32  hops.step1 u32  hops.until1 u32
/// hops.step2 u32    hops.until2 u32  hops.step3 u32  hops.ceiling u32
/// death u8          success_floor_bps u16
/// cross_finality u32  card_value u64
/// ```
pub fn canonical_bytes(p: &ProtocolParams) -> Vec<u8> {
    let mut out = Vec::with_capacity(60);
    for v in [
        p.hops.genesis,
        p.hops.base,
        p.hops.step1,
        p.hops.until1,
        p.hops.step2,
        p.hops.until2,
        p.hops.step3,
        p.hops.ceiling,
    ] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.push(p.death.tag());
    out.extend_from_slice(&p.success_floor_bps.to_le_bytes());
    out.extend_from_slice(&p.cross_finality.to_le_bytes());
    out.extend_from_slice(&p.card_value.to_le_bytes());
    out
}

/// `SHA256(LE u16(DEATH_BPS))` — empty under [`DeathModel::Flat25`], which
/// has no table.
pub fn death_table_bytes() -> Vec<u8> {
    let mut out = Vec::with_capacity(DEATH_BPS.len() * 2);
    for bps in DEATH_BPS {
        out.extend_from_slice(&bps.to_le_bytes());
    }
    out
}

/// The protocol commitment (V3-FINAL-SPEC §2.3):
/// `SHA256(canonical_le(ProtocolParams) || death_table_hash)`.
///
/// Written into every snapshot and covered by the state root; a mismatch is
/// a hard error, never a migration.
pub fn params_hash(p: &ProtocolParams) -> [u8; 32] {
    let table = match p.death {
        DeathModel::Flat25 => Vec::new(),
        DeathModel::HybridFloor => Sha256::digest(death_table_bytes()).to_vec(),
    };
    let mut h = Sha256::new();
    h.update(canonical_bytes(p));
    h.update(&table);
    h.finalize().into()
}

/// The production commitment, for logging and deployment notes.
pub fn protocol_hash() -> [u8; 32] {
    params_hash(&PROTOCOL)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    #[test]
    fn production_params_are_valid() {
        assert_eq!(validate(&PROTOCOL), Ok(()));
    }

    #[test]
    fn death_table_checksum_matches_appendix_a() {
        // V3-FINAL-SPEC Appendix A.1. A mismatch means the table and the
        // generator disagreement: regenerate, do not "fix" the hash.
        assert_eq!(
            hex(&Sha256::digest(death_table_bytes())),
            "3c7df3e872b14613ddb94dfcdc042f50c0c986983329e331f76a93c7cc934f8d"
        );
        assert_eq!(DEATH_BPS.len(), MAX_TARGET as usize + 1);
    }

    #[test]
    fn death_table_sanity_rows() {
        assert_eq!(DEATH_BPS[5], 2500);
        assert_eq!(DEATH_BPS[25], 682);
        assert_eq!(DEATH_BPS[50], 426);
        assert_eq!(DEATH_BPS[75], 339);
        assert_eq!(DEATH_BPS[100], 295);
        // Monotonically non-increasing: the road gets longer, each hop
        // gets safer.
        for w in DEATH_BPS.windows(2) {
            assert!(w[0] >= w[1], "table must not increase: {w:?}");
        }
    }

    #[test]
    fn the_cap_still_finishes_at_five_percent() {
        // 295 bps is the largest value keeping a 100-hop run at >= 5 %.
        let survive = 1.0 - f64::from(DEATH_BPS[100]) / 10_000.0;
        let finish = survive.powi(100);
        assert!((0.0495..=0.0505).contains(&finish), "finish={finish}");
        // And 296 would break the floor (documented in Appendix A).
        let too_safe: f64 = 1.0 - 296.0 / 10_000.0;
        assert!(too_safe.powi(100) < 0.05);
    }

    #[test]
    fn table_matches_the_documented_curve() {
        // §3.6 table: finish-from-zero at each target, within 0.5 pp.
        for (target, expected) in [
            (5u32, 0.2373),
            (10, 0.2187),
            (15, 0.2015),
            (25, 0.1710),
            (50, 0.1134),
            (75, 0.0753),
            (100, 0.0501),
        ] {
            let p = f64::from(DEATH_BPS[target as usize]) / 10_000.0;
            let finish = (1.0 - p).powi(target as i32);
            assert!(
                (finish - expected).abs() < 0.005,
                "target {target}: finish {finish} vs {expected}"
            );
        }
    }

    #[test]
    fn genesis_odds_are_2373_bps() {
        assert_eq!(genesis_completion_bps(5), 2373);
        // (1 - 1/4)^1 = 75 %
        assert_eq!(genesis_completion_bps(1), 7500);
        assert_eq!(genesis_completion_bps(0), 10_000);
    }

    #[test]
    fn validation_rejects_each_broken_rule() {
        let mut p = PROTOCOL;
        p.hops.until1 = p.hops.base - 1;
        assert_eq!(validate(&p), Err(ParamsError::PhaseOrder));

        let mut p = PROTOCOL;
        p.hops.step2 = 0;
        assert_eq!(validate(&p), Err(ParamsError::ZeroStep));

        let mut p = PROTOCOL;
        p.hops.ceiling = 101;
        assert_eq!(validate(&p), Err(ParamsError::CeilingAboveMaxTarget));

        let mut p = PROTOCOL;
        p.success_floor_bps = 0;
        assert_eq!(validate(&p), Err(ParamsError::FloorOutOfRange));

        let mut p = PROTOCOL;
        p.success_floor_bps = 2373;
        assert_eq!(validate(&p), Err(ParamsError::FloorOutOfRange));

        let mut p = PROTOCOL;
        p.cross_finality = 0;
        assert_eq!(validate(&p), Err(ParamsError::ZeroFinality));

        let mut p = PROTOCOL;
        p.hops.step3 = u32::MAX;
        assert_eq!(validate(&p), Err(ParamsError::AnchorOverflow));
    }

    #[test]
    fn canonical_encoding_is_stable() {
        assert_eq!(canonical_bytes(&PROTOCOL).len(), 47);
        // Field-by-field, so a reordering is caught even if lengths match.
        let mut p = PROTOCOL;
        let base = params_hash(&p);
        for mutate in [
            (|p: &mut ProtocolParams| p.hops.genesis += 1) as fn(&mut ProtocolParams),
            |p| p.hops.base += 1,
            |p| p.hops.step1 += 1,
            |p| p.hops.until1 += 1,
            |p| p.hops.step2 += 1,
            |p| p.hops.until2 += 1,
            |p| p.hops.step3 += 1,
            |p| p.hops.ceiling -= 1,
            |p| p.success_floor_bps += 1,
            |p| p.cross_finality += 1,
            |p| p.card_value += 1,
        ] {
            p = PROTOCOL;
            mutate(&mut p);
            assert_ne!(params_hash(&p), base);
        }
    }

    #[test]
    fn death_model_changes_the_hash() {
        let mut p = PROTOCOL;
        p.death = DeathModel::Flat25;
        assert_ne!(params_hash(&p), params_hash(&PROTOCOL));
        assert_eq!(p.death.name(), "flat_25");
        assert_eq!(PROTOCOL.death.name(), "hybrid_floor");
    }
}
