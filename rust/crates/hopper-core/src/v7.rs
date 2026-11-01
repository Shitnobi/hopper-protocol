//! Versioned state-inscription body and leaves (v8 current, v7 legacy) and the frog's four leaves.
//!
//! Like the rest of this crate this module is pure (no secp256k1) so it
//! cross-compiles and can be shared with the indexer. The taproot output
//! key needs a curve implementation and lives in the wallet
//! (`web/js/wallet/keys.js`); this module provides the tagged hashes and
//! the exact script bytes, which are what consensus actually checks.
//!
//! See `SPEC.md` §2.4, §3.1–§3.3.

/// Current body magic, 9 ASCII bytes (SPEC §2.4).
pub const STATE_MAGIC: &[u8; 9] = b"FRG8CROSS";
/// Released v7 body magic, accepted only for the grandfathered Hopper.
pub const LEGACY_STATE_MAGIC: &[u8; 9] = b"FRG7CROSS";
/// The current wire version carried in the body.
pub const STATE_VERSION: u8 = crate::params::VERSION_V8;
/// The released v7 version, accepted only for the grandfathered Hopper.
pub const LEGACY_STATE_VERSION: u8 = crate::params::VERSION_V7;
/// `9 + 1 + 8 + 32 + 4 + 1`.
pub const STATE_BODY_LEN: usize = 55;

/// Content type of a crossing inscription.
pub const STATE_CONTENT_TYPE: &[u8] = b"application/octet-stream";

/// Why a state body cannot be decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StateBodyError {
    /// Not exactly [`STATE_BODY_LEN`] bytes.
    WrongLength,
    /// The first nine bytes are not [`STATE_MAGIC`].
    BadMagic,
    /// The version byte is not [`STATE_VERSION`].
    BadVersion,
    /// `dir > 2`.
    BadDirection,
}

impl StateBodyError {
    pub const fn message(self) -> &'static str {
        match self {
            StateBodyError::WrongLength => "state body must be 55 bytes",
            StateBodyError::BadMagic => "state body magic is FRG8CROSS or the legacy FRG7CROSS",
            StateBodyError::BadVersion => "state body version must be 0x08 or the legacy 0x07",
            StateBodyError::BadDirection => "state body direction must be 0, 1 or 2",
        }
    }
}

/// The canonical 55 bytes inscribed by a hop.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct StateBody {
    /// The frog's anchor sat — its identity.
    pub sat: u64,
    /// The mint reveal txid, INTERNAL byte order.
    pub mint_txid: [u8; 32],
    /// The mint inscription index (`...i{n}`).
    pub mint_index: u32,
    /// The direction the player committed to: 0 left, 1 straight, 2 right.
    pub dir: u8,
}

impl StateBody {
    /// The mint inscription id in display order (`{reversed_txid}i{index}`).
    #[must_use]
    pub fn mint_id_string(&self) -> String {
        mint_id_string(&self.mint_txid, self.mint_index)
    }
}

fn encode_body(magic: &[u8; 9], version: u8, body: &StateBody) -> [u8; STATE_BODY_LEN] {
    let mut out = [0u8; STATE_BODY_LEN];
    out[..9].copy_from_slice(magic);
    out[9] = version;
    out[10..18].copy_from_slice(&body.sat.to_le_bytes());
    out[18..50].copy_from_slice(&body.mint_txid);
    out[50..54].copy_from_slice(&body.mint_index.to_le_bytes());
    out[54] = body.dir;
    out
}

/// Encode the current v8 body.
#[must_use]
pub fn encode_state_body(body: &StateBody) -> [u8; STATE_BODY_LEN] {
    encode_body(STATE_MAGIC, STATE_VERSION, body)
}

/// Encode the released v7 body (grandfathered Hopper only).
#[must_use]
pub fn encode_legacy_state_body(body: &StateBody) -> [u8; STATE_BODY_LEN] {
    encode_body(LEGACY_STATE_MAGIC, LEGACY_STATE_VERSION, body)
}

/// Decode a state body and report whether it used the legacy envelope.
pub fn decode_state_body_versioned(bytes: &[u8]) -> Result<(StateBody, bool), StateBodyError> {
    if bytes.len() != STATE_BODY_LEN {
        return Err(StateBodyError::WrongLength);
    }
    let legacy = &bytes[..9] == LEGACY_STATE_MAGIC && bytes[9] == LEGACY_STATE_VERSION;
    if !legacy && !(&bytes[..9] == STATE_MAGIC && bytes[9] == STATE_VERSION) {
        return Err(if &bytes[..9] == STATE_MAGIC || &bytes[..9] == LEGACY_STATE_MAGIC {
            StateBodyError::BadVersion
        } else {
            StateBodyError::BadMagic
        });
    }
    let mut sat = [0u8; 8];
    sat.copy_from_slice(&bytes[10..18]);
    let mut mint_txid = [0u8; 32];
    mint_txid.copy_from_slice(&bytes[18..50]);
    let mut index = [0u8; 4];
    index.copy_from_slice(&bytes[50..54]);
    let dir = bytes[54];
    if dir > crate::wrap::DIR_RIGHT {
        return Err(StateBodyError::BadDirection);
    }
    Ok((
        StateBody {
            sat: u64::from_le_bytes(sat),
            mint_txid,
            mint_index: u32::from_le_bytes(index),
            dir,
        },
        legacy,
    ))
}

/// Decode a state body. Failure is a rejection, never a state change.
pub fn decode_state_body(bytes: &[u8]) -> Result<StateBody, StateBodyError> {
    decode_state_body_versioned(bytes).map(|(body, _)| body)
}

/// The v7 state-output crossing leaf, byte-exact (SPEC §3.2):
///
/// ```text
/// <owner_xonly: 32> OP_CHECKSIGVERIFY
/// OP_FALSE OP_IF <ord envelope: "ord" ct parent body> OP_ENDIF
/// OP_TRUE
/// ```
///
/// The parent tag names the **mint** inscription. The body's last byte is
/// `body.dir`; the three leaves differ only in that byte, so choosing a
/// direction selects a leaf whose bytes were fixed when the state output
/// was created.
fn state_leaf_script_with(
    owner_xonly: &[u8; 32],
    body: &StateBody,
    legacy: bool,
) -> Vec<u8> {
    let parent = encode_parent_tag(&body.mint_txid, body.mint_index);
    let encoded = if legacy {
        encode_legacy_state_body(body)
    } else {
        encode_state_body(body)
    };
    let mut out = Vec::with_capacity(165);
    out.push(0x20); // PUSH32
    out.extend_from_slice(owner_xonly);
    out.push(0xad); // OP_CHECKSIGVERIFY
    out.extend_from_slice(&crate::inscription::build_inscription_script_with_parents(
        STATE_CONTENT_TYPE,
        &encoded,
        &[parent],
    ));
    out.push(0x51); // OP_TRUE
    out
}

#[must_use]
pub fn state_leaf_script(owner_xonly: &[u8; 32], body: &StateBody) -> Vec<u8> {
    state_leaf_script_with(owner_xonly, body, false)
}

#[must_use]
pub fn legacy_state_leaf_script(owner_xonly: &[u8; 32], body: &StateBody) -> Vec<u8> {
    state_leaf_script_with(owner_xonly, body, true)
}

fn cross_leaf_script_with(
    owner_xonly: &[u8; 32],
    body: &StateBody,
    dir: u8,
    legacy: bool,
) -> Vec<u8> {
    let mut with = *body;
    with.dir = dir;
    state_leaf_script_with(owner_xonly, &with, legacy)
}

/// The crossing leaf for an explicit direction (overrides `body.dir`).
#[must_use]
pub fn cross_leaf_script(owner_xonly: &[u8; 32], body: &StateBody, dir: u8) -> Vec<u8> {
    cross_leaf_script_with(owner_xonly, body, dir, false)
}

#[must_use]
pub fn legacy_cross_leaf_script(owner_xonly: &[u8; 32], body: &StateBody, dir: u8) -> Vec<u8> {
    cross_leaf_script_with(owner_xonly, body, dir, true)
}

/// The send leaf: an ordinary owner signature, no envelope.
#[must_use]
pub fn send_leaf_script(owner_xonly: &[u8; 32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(35);
    out.push(0x20);
    out.extend_from_slice(owner_xonly);
    out.push(0xac); // OP_CHECKSIG
    out
}

// ---------------------------------------------------------------------------
// Taproot tagged hashes (pure SHA-256; no curve arithmetic)
// ---------------------------------------------------------------------------

/// `tagged_hash(tag, msg) = SHA256(SHA256(tag) || SHA256(tag) || msg)`.
#[must_use]
pub fn tagged_hash(tag: &[u8], msg: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let tag_hash = Sha256::digest(tag);
    let mut h = Sha256::new();
    h.update(tag_hash);
    h.update(tag_hash);
    h.update(msg);
    h.finalize().into()
}

/// BIP-341 leaf hash: `tagged_hash("TapLeaf", 0xc0 || compact_size(len) || script)`.
#[must_use]
pub fn leaf_hash(script: &[u8]) -> [u8; 32] {
    let mut msg = Vec::with_capacity(script.len() + 4);
    msg.push(0xc0);
    if script.len() < 0xfd {
        msg.push(script.len() as u8);
    } else {
        msg.push(0xfd);
        msg.extend_from_slice(&(script.len() as u16).to_le_bytes());
    }
    msg.extend_from_slice(script);
    tagged_hash(b"TapLeaf", &msg)
}

/// BIP-341 branch hash: children sorted lexicographically.
#[must_use]
pub fn branch_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut msg = [0u8; 64];
    if a <= b {
        msg[..32].copy_from_slice(a);
        msg[32..].copy_from_slice(b);
    } else {
        msg[..32].copy_from_slice(b);
        msg[32..].copy_from_slice(a);
    }
    tagged_hash(b"TapBranch", &msg)
}

/// The four leaf hashes of the state output, in `[L, S, R, X]` order.
#[must_use]
pub fn state_leaf_hashes(
    owner_xonly: &[u8; 32],
    body: &StateBody,
) -> [[u8; 32]; 4] {
    [
        leaf_hash(&cross_leaf_script(owner_xonly, body, crate::wrap::DIR_LEFT)),
        leaf_hash(&cross_leaf_script(owner_xonly, body, crate::wrap::DIR_STRAIGHT)),
        leaf_hash(&cross_leaf_script(owner_xonly, body, crate::wrap::DIR_RIGHT)),
        leaf_hash(&send_leaf_script(owner_xonly)),
    ]
}

#[must_use]
pub fn legacy_state_leaf_hashes(
    owner_xonly: &[u8; 32],
    body: &StateBody,
) -> [[u8; 32]; 4] {
    [
        leaf_hash(&legacy_cross_leaf_script(owner_xonly, body, crate::wrap::DIR_LEFT)),
        leaf_hash(&legacy_cross_leaf_script(owner_xonly, body, crate::wrap::DIR_STRAIGHT)),
        leaf_hash(&legacy_cross_leaf_script(owner_xonly, body, crate::wrap::DIR_RIGHT)),
        leaf_hash(&send_leaf_script(owner_xonly)),
    ]
}

/// The state output's merkle root (SPEC §3.1):
/// `branch(branch(hL, hS), branch(hR, hX))`.
#[must_use]
pub fn state_tree_root(hashes: &[[u8; 32]; 4]) -> [u8; 32] {
    let hls = branch_hash(&hashes[0], &hashes[1]);
    let hrx = branch_hash(&hashes[2], &hashes[3]);
    branch_hash(&hls, &hrx)
}

/// The two siblings a given leaf's 97-byte control block carries, in
/// order (SPEC §3.1 table).
#[must_use]
pub fn control_path(hashes: &[[u8; 32]; 4], dir_or_send: u8) -> [[u8; 32]; 2] {
    let hls = branch_hash(&hashes[0], &hashes[1]);
    let hrx = branch_hash(&hashes[2], &hashes[3]);
    match dir_or_send {
        crate::wrap::DIR_LEFT => [hashes[1], hrx],
        crate::wrap::DIR_STRAIGHT => [hashes[0], hrx],
        crate::wrap::DIR_RIGHT => [hashes[3], hls],
        _ => [hashes[2], hls], // send leaf X
    }
}

/// A 97-byte control block: `[parity | 0xc0] || internal || sibling(s)`.
#[must_use]
pub fn control_block(
    internal_xonly: &[u8; 32],
    path: &[[u8; 32]; 2],
    parity: u8,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(97);
    out.push(0xc0 | (parity & 1));
    out.extend_from_slice(internal_xonly);
    out.extend_from_slice(&path[0]);
    out.extend_from_slice(&path[1]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wrap::{DIR_LEFT, DIR_RIGHT, DIR_STRAIGHT};

    const OWNER: [u8; 32] = [0x11; 32];
    const TXID: [u8; 32] = [0xab; 32];

    fn body(dir: u8) -> StateBody {
        StateBody {
            sat: 1_234_567_890,
            mint_txid: TXID,
            mint_index: 2,
            dir,
        }
    }

    #[test]
    fn body_round_trip_and_layout() {
        for dir in 0..3 {
            let b = encode_state_body(&body(dir));
            assert_eq!(b.len(), 55);
            assert_eq!(&b[..9], STATE_MAGIC);
            assert_eq!(b[9], STATE_VERSION);
            assert_eq!(b[54], dir);
            assert_eq!(decode_state_body(&b), Ok(body(dir)));
        }
        let mut bad = encode_state_body(&body(0));
        bad[9] = 0x06;
        assert_eq!(decode_state_body(&bad), Err(StateBodyError::BadVersion));
        let mut bad = encode_state_body(&body(0));
        bad[54] = 3;
        assert_eq!(decode_state_body(&bad), Err(StateBodyError::BadDirection));
        assert_eq!(
            decode_state_body(&[0u8; 54]),
            Err(StateBodyError::WrongLength)
        );
    }

    #[test]
    fn leaf_parses_as_exactly_one_ord_envelope_with_the_mint_parent() {
        for dir in 0..3 {
            let leaf = state_leaf_script(&OWNER, &body(dir));
            assert_eq!(leaf[0], 0x20);
            assert_eq!(&leaf[1..33], &OWNER);
            assert_eq!(leaf[33], 0xad);
            assert_eq!(leaf[34], 0x00);
            assert_eq!(leaf[35], 0x63);
            assert_eq!(&leaf[leaf.len() - 2..], &[0x68, 0x51]);

            let parsed = crate::parse_inscriptions(&leaf);
            assert_eq!(parsed.len(), 1);
            let ins = &parsed[0];
            assert_eq!(ins.content_type.as_deref(), Some(STATE_CONTENT_TYPE));
            assert_eq!(
                ins.body.as_deref(),
                Some(&encode_state_body(&body(dir))[..])
            );
            assert_eq!(ins.parents.len(), 1);
            assert_eq!(crate::decode_parent_tag(&ins.parents[0]), Ok((TXID, 2)));
            assert!(!ins.duplicate_field && !ins.incomplete_field);
        }
    }

    #[test]
    fn the_parent_index_is_minimal_little_endian() {
        assert_eq!(encode_parent_tag(&TXID, 0).len(), 32);
        assert_eq!(encode_parent_tag(&TXID, 1).len(), 33);
        assert_eq!(encode_parent_tag(&TXID, 256).len(), 34);
        assert_eq!(encode_parent_tag(&TXID, 0x01_02_03).len(), 35);
        assert_eq!(encode_parent_tag(&TXID, 0x01_02_03_04).len(), 36);
        assert_eq!(&encode_parent_tag(&TXID, 256)[32..], &[0x00, 0x01]);
        assert_eq!(
            decode_parent_tag(&encode_parent_tag(&TXID, 0x01_02_03)),
            Ok((TXID, 0x01_02_03))
        );
    }

    #[test]
    fn the_canonical_state_leaf_is_161_bytes_at_index_zero() {
        let mut b = body(DIR_LEFT);
        b.mint_index = 0;
        let leaf = state_leaf_script(&OWNER, &b);
        assert_eq!(leaf.len(), 161);
        // The only reachable form: the mint has one envelope, so index 0.
        let parsed = crate::parse_inscriptions(&leaf);
        assert_eq!(crate::decode_parent_tag(&parsed[0].parents[0]), Ok((TXID, 0)));
        assert_eq!(state_leaf_script(&OWNER, &body(DIR_LEFT)).len(), 162);
    }

    #[test]
    fn the_three_leaves_differ_only_in_the_direction_byte() {
        let l = cross_leaf_script(&OWNER, &body(0), DIR_LEFT);
        let s = cross_leaf_script(&OWNER, &body(0), DIR_STRAIGHT);
        let r = cross_leaf_script(&OWNER, &body(0), DIR_RIGHT);
        assert_eq!(l.len(), s.len());
        assert_eq!(l.len(), r.len());
        // Exactly one byte differs: the direction at the end of the body.
        let diffs: Vec<usize> = (0..l.len()).filter(|&i| l[i] != s[i]).collect();
        assert_eq!(diffs, vec![l.len() - 3]);
        assert_eq!(l[l.len() - 3], DIR_LEFT);
        assert_eq!(s[s.len() - 3], DIR_STRAIGHT);
        assert_eq!(r[r.len() - 3], DIR_RIGHT);
        assert_ne!(leaf_hash(&l), leaf_hash(&s));
        assert_ne!(leaf_hash(&s), leaf_hash(&r));
    }

    #[test]
    fn tree_shape_matches_the_spec_table() {
        let hashes = state_leaf_hashes(&OWNER, &body(DIR_LEFT));
        let [hl, hs, hr, hx] = hashes;
        let hls = branch_hash(&hl, &hs);
        let hrx = branch_hash(&hr, &hx);
        assert_eq!(state_tree_root(&hashes), branch_hash(&hls, &hrx));
        assert_eq!(control_path(&hashes, DIR_LEFT), [hs, hrx]);
        assert_eq!(control_path(&hashes, DIR_STRAIGHT), [hl, hrx]);
        assert_eq!(control_path(&hashes, DIR_RIGHT), [hx, hls]);
        assert_eq!(control_path(&hashes, 0xff), [hr, hls]);
        let cb = control_block(&crate::params::NUMS_XONLY, &control_path(&hashes, DIR_LEFT), 1);
        assert_eq!(cb.len(), 97);
        assert_eq!(cb[0], 0xc1);
        assert_eq!(&cb[1..33], &crate::params::NUMS_XONLY);
    }

    #[test]
    fn every_owner_and_index_changes_the_leaf() {
        let a = state_leaf_script(&OWNER, &body(0));
        let mut other_owner = OWNER;
        other_owner[0] ^= 1;
        assert_ne!(a, state_leaf_script(&other_owner, &body(0)));
        let mut other = body(0);
        other.mint_index = 3;
        assert_ne!(a, state_leaf_script(&OWNER, &other));
    }
}

// ---------------------------------------------------------------------------
// Parent tags — ord's tag 3, linking a state inscription to its mint
// ---------------------------------------------------------------------------

/// Why a parent tag cannot be decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParentTagError {
    /// Shorter than a txid or longer than txid + full `u32`.
    WrongLength,
    /// A 1–3 byte index ending in `0x00` is not minimal (ord's rule).
    NonMinimalIndex,
}

impl ParentTagError {
    pub const fn message(self) -> &'static str {
        match self {
            ParentTagError::WrongLength => "parent tag must be 32..=36 bytes",
            ParentTagError::NonMinimalIndex => "parent tag index must be minimal",
        }
    }
}

/// `{reversed_txid}i{index}` — the ord display form of a mint id.
#[must_use]
pub fn mint_id_string(mint_txid: &[u8; 32], mint_index: u32) -> String {
    let mut rev = *mint_txid;
    rev.reverse();
    let hex: String = rev.iter().map(|b| format!("{b:02x}")).collect();
    format!("{hex}i{mint_index}")
}

/// Encode a tag-3 parent value: `txid || index`, minimal.
#[must_use]
pub fn encode_parent_tag(mint_txid: &[u8; 32], mint_index: u32) -> Vec<u8> {
    // ord's rule: the index is minimal little-endian. Index 0 is the bare
    // txid; a non-zero index appends only its significant bytes.
    let mut index = mint_index.to_le_bytes().to_vec();
    while index.last() == Some(&0) {
        index.pop();
    }
    let mut out = Vec::with_capacity(32 + index.len());
    out.extend_from_slice(mint_txid);
    out.extend_from_slice(&index);
    out
}

/// Decode a tag-3 parent value, accepting ord's 32–36 byte forms.
pub fn decode_parent_tag(bytes: &[u8]) -> Result<([u8; 32], u32), ParentTagError> {
    if !(32..=36).contains(&bytes.len()) {
        return Err(ParentTagError::WrongLength);
    }
    let mut txid = [0u8; 32];
    txid.copy_from_slice(&bytes[..32]);
    let index = &bytes[32..];
    if index.is_empty() {
        return Ok((txid, 0));
    }
    if index.len() != 4 && index[index.len() - 1] == 0 {
        return Err(ParentTagError::NonMinimalIndex);
    }
    let mut buf = [0u8; 4];
    buf[..index.len()].copy_from_slice(index);
    Ok((txid, u32::from_le_bytes(buf)))
}
