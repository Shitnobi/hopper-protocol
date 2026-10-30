//! The road's wrap (SPEC §1.2).
//!
//! There is no per-Hopper death table and no per-Hopper randomness. Each
//! block has exactly one direction, and every crossing that confirmed in
//! the previous block is judged against it:
//!
//! ```text
//! wrap(B)  = u32LE(H(B)_internal[0..4]) mod 3
//! outcome  = (in_flight.dir == wrap(T + 1)) => dead
//! ```
//!
//! `H(B)_internal` is the 32-byte block hash in internal byte order — the
//! reverse of the hex an explorer or ord returns.
//!
//! `2^32 = 3 * 1_431_655_765 + 1`, so `mod 3` is biased by one part in
//! `2^32` toward left. That bias is accepted. An implementation MUST use
//! this exact integer; it MUST NOT substitute a wider word, a rejection
//! scheme or a hash of the hash.

/// Direction encoding (SPEC §2.4): the last byte of the 55-byte body.
pub const DIR_LEFT: u8 = 0;
/// Straight ahead.
pub const DIR_STRAIGHT: u8 = 1;
/// Right.
pub const DIR_RIGHT: u8 = 2;
/// Number of directions on the road.
pub const DIRECTIONS: u8 = 3;

/// `wrap(B)` — the block's single direction.
#[must_use]
pub fn wrap(block_hash: &[u8; 32]) -> u8 {
    let x = u32::from_le_bytes([block_hash[0], block_hash[1], block_hash[2], block_hash[3]]);
    (x % u32::from(DIRECTIONS)) as u8
}

/// True = ROADKILL: the Hopper picked the direction the block wrapped.
#[must_use]
pub fn dies(dir: u8, block_hash: &[u8; 32]) -> bool {
    dir == wrap(block_hash)
}

/// `wrap` from a display-order hex hash (`sha256("<salt>:<height>")` style
/// fixtures and explorers both serve display order).
#[must_use]
pub fn wrap_display_hex(display: &str) -> Option<u8> {
    let bytes = hex32(display)?;
    let mut internal = [0u8; 32];
    for i in 0..32 {
        internal[i] = bytes[31 - i];
    }
    Some(wrap(&internal))
}

fn hex32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash_with_prefix(prefix: [u8; 4]) -> [u8; 32] {
        let mut h = [0u8; 32];
        h[..4].copy_from_slice(&prefix);
        h
    }

    #[test]
    fn wrap_is_the_first_four_internal_bytes_mod_three() {
        assert_eq!(wrap(&hash_with_prefix([0, 0, 0, 0])), 0);
        assert_eq!(wrap(&hash_with_prefix([1, 0, 0, 0])), 1);
        assert_eq!(wrap(&hash_with_prefix([2, 0, 0, 0])), 2);
        assert_eq!(wrap(&hash_with_prefix([3, 0, 0, 0])), 0);
        assert_eq!(wrap(&hash_with_prefix([255, 255, 255, 255])), 0);
        // 0xFFFFFFFE = 4294967294 = 3 * 1431655764 + 2.
        assert_eq!(wrap(&hash_with_prefix([254, 255, 255, 255])), 2);
    }

    #[test]
    fn bias_is_one_part_in_two_to_the_thirty_two() {
        // Residue 0 occurs one more time than 1 and 2 in 0..2^32.
        assert_eq!(4_294_967_296u64, 3 * 1_431_655_765 + 1);
    }

    #[test]
    fn display_hex_is_reversed_before_the_wrap() {
        // internal = 01 00 00 00 …; display = … 00 00 00 01.
        let mut internal = [0u8; 32];
        internal[0] = 1;
        let mut display = internal;
        display.reverse();
        let hex: String = display.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(wrap_display_hex(&hex), Some(1));
        assert_eq!(wrap_display_hex("nope"), None);
    }

    #[test]
    fn the_block_decides_for_everyone() {
        let h = hash_with_prefix([7, 0, 0, 0]); // 7 % 3 == 1
        assert!(dies(DIR_STRAIGHT, &h));
        assert!(!dies(DIR_LEFT, &h));
        assert!(!dies(DIR_RIGHT, &h));
    }
}
