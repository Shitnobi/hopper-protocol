//! HOPPER v7 protocol parameters — the single source of truth.
//!
//! Nothing outside this module may contain a numeric copy of the
//! generation schedule or an economic constant. The values are compiled
//! in, not configured: two nodes with different parameters MUST NOT share
//! a snapshot or a state root, which is why [`params_hash`] is committed
//! to in both.
//!
//! `genesis` is the **only** value edited at deployment.

use sha2::{Digest, Sha256};

/// Hard upper bound for the road's ceiling (SPEC §1.1). It equals the
/// production ceiling: the road never gets harder than this.
pub const MAX_TARGET: u32 = 25;

/// The x-only internal key of every frog state output.
///
/// This is the standard "nothing up my sleeve" point: it is a valid
/// x-only key with no known discrete log, so a state output can only be
/// spent through one of its four leaves — the three crossing leaves or
/// the owner's `CHECKSIG` (transfer). There is no key-path spend, ever.
pub const NUMS_XONLY: [u8; 32] = [
    0x50, 0x92, 0x9b, 0x74, 0xc1, 0xa0, 0x49, 0x54, 0xb7, 0x8b, 0x4b, 0x60, 0x35, 0xe9, 0x7a, 0x5e,
    0x07, 0x8a, 0x5a, 0x0f, 0x28, 0xec, 0x96, 0xd5, 0x47, 0xbf, 0xee, 0x9a, 0xce, 0x80, 0x3a, 0xc0,
];

/// The road's difficulty runs in **generations** (SPEC §1.1).
///
/// A generation starts at `base` required crossings, adds one every
/// `growth_interval` blocks, reaches `ceiling`, holds there for `hold`
/// blocks, and resets to `base` at the next generation.
///
/// ```text
/// generation_len = (ceiling - base) * growth_interval + hold
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct GenerationParams {
    /// Height at which the first generation starts. Height at which
    /// `base` applies.
    pub genesis: u32,
    /// Crossings required on the first block of a generation.
    pub base: u32,
    /// Blocks per extra required crossing.
    pub growth_interval: u32,
    /// The hardest the road ever gets.
    pub ceiling: u32,
    /// Blocks spent at the ceiling before the reset.
    pub hold: u32,
    /// `(ceiling - base) * growth_interval + hold`; committed to, checked.
    pub generation_len: u32,
}

impl GenerationParams {
    /// The length the other fields imply (SPEC §1.1). The indexer rejects
    /// a published parameter block where this disagrees with
    /// `generation_len`.
    pub const fn expected_len(&self) -> u32 {
        (self.ceiling - self.base) * self.growth_interval + self.hold
    }

    /// First block of generation `k` (1-based).
    pub const fn generation_start(&self, k: u32) -> u32 {
        self.genesis + (k - 1) * self.generation_len
    }

    /// Generation of `height` (1-based). Heights below genesis are G1.
    pub const fn generation(&self, height: u32) -> u32 {
        if height < self.genesis {
            return 1;
        }
        1 + (height - self.genesis) / self.generation_len
    }

    /// Crossings required on a frog settled at `height` (SPEC §1.1).
    ///
    /// A sawtooth, not monotonic: the reset at a generation boundary is
    /// deliberate and load-bearing.
    pub const fn required(&self, height: u32) -> u32 {
        if height < self.genesis {
            return self.base;
        }
        let start = self.generation_start(self.generation(height));
        let r = self.base + (height - start) / self.growth_interval;
        if r > self.ceiling {
            self.ceiling
        } else {
            r
        }
    }

    /// The next height at which `required` changes, and its new value.
    ///
    /// Used by the API and the GUI countdown. A generation reset is a
    /// change, so this never returns `None` for a sane schedule.
    pub fn next_increment(&self, height: u32) -> Option<(u32, u32)> {
        if height < self.genesis {
            return Some((self.genesis, self.base));
        }
        let k = self.generation(height);
        let start = self.generation_start(k);
        let r = self.required(height);
        if r < self.ceiling {
            let steps = (r - self.base) + 1;
            let next = start + steps * self.growth_interval;
            Some((next, self.required(next)))
        } else {
            let next = self.generation_start(k + 1);
            Some((next, self.base))
        }
    }
}

/// Every tunable in one struct (SPEC §1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct ProtocolParams {
    pub generations: GenerationParams,
    /// Blocks between the HOP block and settlement (SPEC §1.4).
    pub cross_finality: u32,
    /// The value of the minted frog card; large enough to fund a hop.
    pub card_value: u64,
}

/// Released wire version, retained only for the one grandfathered Hopper.
pub const VERSION_V7: u8 = 0x07;
/// Current wire version (SPEC §1).
pub const VERSION_V8: u8 = 0x08;
/// The current wire version.
pub const VERSION: u8 = VERSION_V8;

/// The one released Hopper grandfathered into v8, identified by its
/// ordinal sat number. Set this when the sat is known; 0 means none.
/// This is the only place the number is edited.
pub const GRANDFATHERED_SAT: u64 = 0;

pub fn is_grandfathered_sat(sat: u64) -> bool {
    GRANDFATHERED_SAT != 0 && sat == GRANDFATHERED_SAT
}

/// The production parameters (SPEC §1.1).
///
/// `genesis` is the **only** value edited at deployment, and it is edited
/// by `scripts/params/frame-genesis.sh <height>` — never by hand, because
/// the mint body embeds it (`live_v7::params_literal`) and the pinned
/// golden digests must move with it.
pub const PROTOCOL: ProtocolParams = ProtocolParams {
    generations: GenerationParams {
        genesis: 974_034,
        base: 5,
        growth_interval: 144,
        ceiling: 25,
        hold: 3_600,
        generation_len: 6_480,
    },
    cross_finality: 6,
    card_value: 25_000,
};

impl ProtocolParams {
    /// Test fixture: generations are four blocks long, so a test walks a
    /// full reset without touching production constants.
    ///
    /// `base 1`, `+1` every block, `ceiling 3`, `hold 2` →
    /// `generation_len = 4`: `required(0..4) = 1,2,3,3`, then `1` again.
    pub const fn fixture_fast() -> Self {
        Self {
            generations: GenerationParams {
                genesis: 0,
                base: 1,
                growth_interval: 1,
                ceiling: 3,
                hold: 2,
                generation_len: 4,
            },
            cross_finality: 6,
            card_value: 25_000,
        }
    }
}

/// Why a [`ProtocolParams`] instance is unusable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParamsError {
    /// `base >= 1` and `base <= ceiling` are violated.
    BaseOrder,
    /// A step is zero (the schedule would never advance or would divide by
    /// zero).
    ZeroStep,
    /// `ceiling > MAX_TARGET`.
    CeilingAboveMaxTarget,
    /// `generation_len != (ceiling - base) * growth_interval + hold`.
    GenerationLenMismatch,
    /// `cross_finality == 0` (settlement would precede the HOP).
    ZeroFinality,
}

impl ParamsError {
    pub const fn message(self) -> &'static str {
        match self {
            ParamsError::BaseOrder => "1 <= base <= ceiling is required",
            ParamsError::ZeroStep => "growth_interval and generation_len must be positive",
            ParamsError::CeilingAboveMaxTarget => "ceiling must not exceed MAX_TARGET",
            ParamsError::GenerationLenMismatch => {
                "generation_len must equal (ceiling - base) * growth_interval + hold"
            }
            ParamsError::ZeroFinality => "cross_finality must be at least 1",
        }
    }
}

/// Validate a parameter set (SPEC §1.1). MUST pass before serving.
pub fn validate(p: &ProtocolParams) -> Result<(), ParamsError> {
    let g = &p.generations;
    if g.base < 1 || g.base > g.ceiling {
        return Err(ParamsError::BaseOrder);
    }
    if g.growth_interval == 0 || g.generation_len == 0 {
        return Err(ParamsError::ZeroStep);
    }
    if g.ceiling > MAX_TARGET {
        return Err(ParamsError::CeilingAboveMaxTarget);
    }
    if g.expected_len() != g.generation_len {
        return Err(ParamsError::GenerationLenMismatch);
    }
    if p.cross_finality == 0 {
        return Err(ParamsError::ZeroFinality);
    }
    Ok(())
}

/// The canonical little-endian encoding of [`ProtocolParams`] (SPEC §1.3).
///
/// This is a consensus byte string: never reorder, resize or reinterpret a
/// field. New fields go at the end *and* bump `wire_version`.
///
/// ```text
/// genesis u32  base u32  growth_interval u32  ceiling u32
/// hold u32     generation_len u32
/// cross_finality u32   card_value u64
/// ```
pub fn canonical_bytes(p: &ProtocolParams) -> Vec<u8> {
    let mut out = Vec::with_capacity(40);
    let g = &p.generations;
    for v in [
        g.genesis,
        g.base,
        g.growth_interval,
        g.ceiling,
        g.hold,
        g.generation_len,
    ] {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out.extend_from_slice(&p.cross_finality.to_le_bytes());
    out.extend_from_slice(&p.card_value.to_le_bytes());
    out
}

/// The protocol commitment (SPEC §1.3): `SHA256(canonical_le)`.
///
/// Written into every snapshot and covered by the state root; a mismatch is
/// a hard error, never a migration.
pub fn params_hash(p: &ProtocolParams) -> [u8; 32] {
    Sha256::digest(canonical_bytes(p)).into()
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
        assert_eq!(PROTOCOL.generations.expected_len(), 6_480);
    }

    #[test]
    fn generation_covers_the_documented_boundaries() {
        let g = PROTOCOL.generations;
        assert_eq!(g.required(0), 5);
        assert_eq!(g.required(g.genesis - 1), 5);
        assert_eq!(g.required(g.genesis), 5);
        assert_eq!(g.required(g.genesis + 143), 5);
        assert_eq!(g.required(g.genesis + 144), 6);
        // 20 increments of 144 blocks reach the ceiling.
        assert_eq!(g.required(g.genesis + 20 * 144 - 1), 24);
        assert_eq!(g.required(g.genesis + 20 * 144), 25);
        // The whole hold stays at the ceiling.
        assert_eq!(g.required(g.genesis + 20 * 144 + 3_599), 25);
        // Then the generation resets to base.
        assert_eq!(g.required(g.genesis + 6_480), 5);
        assert_eq!(g.required(g.genesis + 6_480 + 144), 6);
    }

    #[test]
    fn generation_numbers_are_one_based_and_immutable() {
        let g = PROTOCOL.generations;
        assert_eq!(g.generation(0), 1);
        assert_eq!(g.generation(g.genesis), 1);
        assert_eq!(g.generation(g.genesis + 6_479), 1);
        assert_eq!(g.generation(g.genesis + 6_480), 2);
        assert_eq!(g.generation_start(1), g.genesis);
        assert_eq!(g.generation_start(2), g.genesis + 6_480);
    }

    #[test]
    fn next_increment_is_the_next_change_including_the_reset() {
        let g = PROTOCOL.generations;
        assert_eq!(g.next_increment(0), Some((g.genesis, 5)));
        assert_eq!(g.next_increment(g.genesis), Some((g.genesis + 144, 6)));
        let start = g.genesis;
        let last_hold = start + 20 * 144 + 3_600 - 1;
        assert_eq!(g.next_increment(last_hold), Some((start + 6_480, 5)));
        // A generation reset really is a change.
        assert_eq!(g.required(start + 6_479), 25);
        assert_eq!(g.required(start + 6_480), 5);
    }

    #[test]
    fn fixture_walks_a_whole_generation() {
        let g = ProtocolParams::fixture_fast().generations;
        assert_eq!(validate(&ProtocolParams::fixture_fast()), Ok(()));
        assert_eq!(
            [0, 1, 2, 3, 4, 5, 6, 7].map(|h| g.required(h)),
            [1, 2, 3, 3, 1, 2, 3, 3]
        );
        assert_eq!([0, 1, 2, 3, 4].map(|h| g.generation(h)), [1, 1, 1, 1, 2]);
    }

    #[test]
    fn validation_rejects_each_broken_rule() {
        let mut p = PROTOCOL;
        p.generations.base = 0;
        assert_eq!(validate(&p), Err(ParamsError::BaseOrder));

        let mut p = PROTOCOL;
        p.generations.ceiling = 4;
        assert_eq!(validate(&p), Err(ParamsError::BaseOrder));

        let mut p = PROTOCOL;
        p.generations.growth_interval = 0;
        assert_eq!(validate(&p), Err(ParamsError::ZeroStep));

        let mut p = PROTOCOL;
        p.generations.ceiling = MAX_TARGET + 1;
        assert_eq!(validate(&p), Err(ParamsError::CeilingAboveMaxTarget));

        let mut p = PROTOCOL;
        p.generations.hold += 1;
        assert_eq!(validate(&p), Err(ParamsError::GenerationLenMismatch));

        let mut p = PROTOCOL;
        p.cross_finality = 0;
        assert_eq!(validate(&p), Err(ParamsError::ZeroFinality));
    }

    #[test]
    fn canonical_encoding_is_stable() {
        assert_eq!(canonical_bytes(&PROTOCOL).len(), 36);
        let base = params_hash(&PROTOCOL);
        for mutate in [
            (|p: &mut ProtocolParams| p.generations.genesis += 1) as fn(&mut ProtocolParams),
            |p| p.generations.base += 1,
            |p| p.generations.growth_interval += 1,
            |p| p.generations.ceiling -= 1,
            |p| p.generations.hold += 1,
            |p| p.generations.generation_len += 1,
            |p| p.cross_finality += 1,
            |p| p.card_value += 1,
        ] {
            let mut q = PROTOCOL;
            mutate(&mut q);
            assert_ne!(params_hash(&q), base);
        }
    }

    #[test]
    fn production_hash_is_pinned() {
        // A change here is a wire change: every mint body commits to it.
        assert_eq!(
            hex(&params_hash(&PROTOCOL)),
            PROTOCOL_HASH_PIN
        );
    }
}

/// Pinned production `params_hash` (hex). Regenerate deliberately with
/// `cargo run -p hopper-core --example genesis_frame` after a wire change.
pub const PROTOCOL_HASH_PIN: &str = "d466f8db3efa330dc92444274675804e47ec76b62393eeae88063ef764bcf72f";
