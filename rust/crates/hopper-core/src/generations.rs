//! Generations: the road's difficulty as a function of height only.
//!
//! Pure integer math, no allocation, no floats, no chain access. The
//! requirement is a sawtooth over 28,080-block generations (SPEC §1.1);
//! the target used to settle a hop is frozen when the HOP confirms.

use crate::params::{GenerationParams, PROTOCOL};

/// Generation of `height` under the production schedule (1-based).
#[inline]
pub const fn generation(height: u32) -> u32 {
    PROTOCOL.generations.generation(height)
}

/// First block of generation `k` (1-based).
#[inline]
pub const fn generation_start(k: u32) -> u32 {
    PROTOCOL.generations.generation_start(k)
}

/// Crossings required at `height` under the production schedule.
#[inline]
pub const fn required_hops(height: u32) -> u32 {
    PROTOCOL.generations.required(height)
}

/// The next height at which the requirement changes, with its new value.
pub fn next_increment(height: u32) -> Option<(u32, u32)> {
    PROTOCOL.generations.next_increment(height)
}

impl GenerationParams {
    /// The number of blocks in generation `k` that require exactly
    /// `required(k)` on their first block. Display only.
    pub const fn span(&self) -> u32 {
        self.generation_len
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_vectors_hold_at_every_boundary() {
        let g = PROTOCOL.generations;
        let start = g.genesis;
        for (offset, want) in [
            (0u32, 5u32),
            (143, 5),
            (144, 6),
            (95 * 144 - 1, 99),
            (95 * 144, 100),
            (95 * 144 + 14_399, 100),
            (28_080, 5),
            (28_080 + 144, 6),
        ] {
            assert_eq!(required_hops(start + offset), want, "offset {offset}");
        }
    }

    #[test]
    fn a_frog_born_in_g1_can_still_hop_in_g3() {
        let g = PROTOCOL.generations;
        let gen = g.generation(g.genesis);
        assert_eq!(gen, 1);
        // The label never changes; the target does.
        assert_eq!(g.generation(g.genesis + 2 * g.generation_len), 3);
        assert_eq!(generation(g.genesis + 2 * g.generation_len + 144), 3);
    }

    #[test]
    fn next_increment_examples() {
        let g = PROTOCOL.generations;
        assert_eq!(next_increment(g.genesis - 1), Some((g.genesis, 5)));
        assert_eq!(next_increment(g.genesis), Some((g.genesis + 144, 6)));
        assert_eq!(
            next_increment(g.genesis + 95 * 144 + 14_399),
            Some((g.genesis + 28_080, 5))
        );
    }
}
