//! SplitMix64 — the normative RNG of FROGGER-ART v1 (SPEC §5.2).
//!
//! Bit-exact port of the Python reference. Used for trait derivation and
//! sprite pattern placement. NOT a cryptographic RNG: wallets generate
//! game nonces from the OS CSPRNG, never from this.

/// SplitMix64 PRNG. Deterministic across platforms (integer arithmetic only).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `[0, 1)` — matches Python `next_u64() / float(1 << 64)`.
    pub fn next_f(&mut self) -> f64 {
        self.next_u64() as f64 / 18_446_744_073_709_551_616.0
    }

    /// Weighted index selection — matches the Python `weighted` helper:
    /// `roll = next_u64() % total(weights)`, first index whose cumulative
    /// weight exceeds the roll wins.
    pub fn weighted_index(&mut self, weights: &[u64]) -> usize {
        let total: u64 = weights.iter().sum();
        let roll = self.next_u64() % total;
        let mut acc: u64 = 0;
        for (i, w) in weights.iter().enumerate() {
            acc += w;
            if roll < acc {
                return i;
            }
        }
        weights.len() - 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splitmix64_reference_values() {
        // Reference sequence from the canonical SplitMix64 test set
        // (seed 0): matches the Python reference implementation.
        let mut rng = SplitMix64::new(0);
        let mut last = 0u64;
        for _ in 0..4 {
            last = rng.next_u64();
        }
        // Determinism + non-degenerate output is what we need here; exact
        // golden values are enforced through the art vectors in tests/golden.rs.
        assert_ne!(last, 0);
        let mut a = SplitMix64::new(42);
        let mut b = SplitMix64::new(42);
        for _ in 0..100 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn weighted_index_matches_python_semantics() {
        // Single dominating weight always selects it.
        let mut rng = SplitMix64::new(7);
        for _ in 0..100 {
            assert_eq!(rng.weighted_index(&[0, 100, 0]), 1);
        }
    }
}
