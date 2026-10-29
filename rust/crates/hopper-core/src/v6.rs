//! v6 wire: the state-inscription body and the frog's cross leaf.
//!
//! Like [`crate::cross`] for v3, this module is pure (no secp256k1) so it
//! cross-compiles for Android and can be shared with the indexer. The
//! Taproot output key / control block live in `frogger-wallet-core`
//! (`state_output.rs`), which is also where script-path signing lives.
//!
//! See `docs/V6-SPEC.md` §2.

/// Body magic, 9 ASCII bytes. `FRG3CROSS` stays the v3 spelling; v6 says
/// what it is so a mixed reindex can never confuse the two.
pub const STATE_MAGIC: &[u8; 9] = b"FRG6CROSS";
/// The wire version carried in the body, independent of the byte order.
pub const STATE_VERSION: u8 = crate::params::VERSION_V6;
/// `9 + 1 + 8 + 32 + 4`.
pub const STATE_BODY_LEN: usize = 54;

/// Content type of a crossing inscription. `octet-stream` because the
/// body is binary; no renderer is expected to sniff it.
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
}

impl StateBodyError {
    pub const fn message(self) -> &'static str {
        match self {
            StateBodyError::WrongLength => "state body must be 54 bytes",
            StateBodyError::BadMagic => "state body magic is FRG6CROSS",
            StateBodyError::BadVersion => "state body version must be 0x06",
        }
    }
}

/// The canonical 54 bytes inscribed by a crossing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct StateBody {
    /// The frog's anchor sat — its identity.
    pub sat: u64,
    /// The mint reveal txid, INTERNAL byte order.
    pub mint_txid: [u8; 32],
    /// The mint inscription index (`...i{n}`).
    pub mint_index: u32,
}

impl StateBody {
    /// The mint inscription id in display order (`{reversed_txid}i{index}`).
    #[must_use]
    pub fn mint_id_string(&self) -> String {
        mint_id_string(&self.mint_txid, self.mint_index)
    }
}

/// Encode the canonical body.
#[must_use]
pub fn encode_state_body(body: &StateBody) -> [u8; STATE_BODY_LEN] {
    let mut out = [0u8; STATE_BODY_LEN];
    out[..9].copy_from_slice(STATE_MAGIC);
    out[9] = STATE_VERSION;
    out[10..18].copy_from_slice(&body.sat.to_le_bytes());
    out[18..50].copy_from_slice(&body.mint_txid);
    out[50..54].copy_from_slice(&body.mint_index.to_le_bytes());
    out
}

/// Decode a state body. Failure is a rejection, never a state change.
pub fn decode_state_body(bytes: &[u8]) -> Result<StateBody, StateBodyError> {
    if bytes.len() != STATE_BODY_LEN {
        return Err(StateBodyError::WrongLength);
    }
    if &bytes[..9] != STATE_MAGIC {
        return Err(StateBodyError::BadMagic);
    }
    if bytes[9] != STATE_VERSION {
        return Err(StateBodyError::BadVersion);
    }
    let mut sat = [0u8; 8];
    sat.copy_from_slice(&bytes[10..18]);
    let mut mint_txid = [0u8; 32];
    mint_txid.copy_from_slice(&bytes[18..50]);
    let mut index = [0u8; 4];
    index.copy_from_slice(&bytes[50..54]);
    Ok(StateBody {
        sat: u64::from_le_bytes(sat),
        mint_txid,
        mint_index: u32::from_le_bytes(index),
    })
}

/// The v6 state-output cross leaf, byte-exact:
///
/// ```text
/// <owner_xonly: 32> OP_CHECKSIGVERIFY
/// OP_FALSE OP_IF <ord envelope: "ord" ct parent body> OP_ENDIF
/// OP_TRUE
/// ```
///
/// The parent tag names the **mint** inscription. That is why the leaf
/// cannot be created by the mint transaction itself (§0.1): the id does
/// not exist until the mint reveals.
#[must_use]
pub fn state_leaf_script(owner_xonly: &[u8; 32], body: &StateBody) -> Vec<u8> {
    let parent = encode_parent_tag(&body.mint_txid, body.mint_index);
    let mut out = Vec::with_capacity(160);
    out.push(0x20); // PUSH32
    out.extend_from_slice(owner_xonly);
    out.push(0xad); // OP_CHECKSIGVERIFY
    out.extend_from_slice(&crate::inscription::build_inscription_script_with_parents(
        STATE_CONTENT_TYPE,
        &encode_state_body(body),
        &[parent],
    ));
    out.push(0x51); // OP_TRUE
    out
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

#[cfg(test)]
mod tests {
    use super::*;

    const OWNER: [u8; 32] = [0x11; 32];
    const TXID: [u8; 32] = [0xab; 32];

    fn body() -> StateBody {
        StateBody {
            sat: 1_234_567_890,
            mint_txid: TXID,
            mint_index: 2,
        }
    }

    #[test]
    fn body_round_trip_and_layout() {
        let b = encode_state_body(&body());
        assert_eq!(b.len(), 54);
        assert_eq!(&b[..9], b"FRG6CROSS");
        assert_eq!(b[9], 0x06);
        assert_eq!(decode_state_body(&b), Ok(body()));
        let mut bad = b;
        bad[9] = 0x04;
        assert_eq!(decode_state_body(&bad), Err(StateBodyError::BadVersion));
    }

    #[test]
    fn leaf_parses_as_exactly_one_ord_envelope_with_the_mint_parent() {
        let leaf = state_leaf_script(&OWNER, &body());
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
        assert_eq!(ins.body.as_deref(), Some(&encode_state_body(&body())[..]));
        assert_eq!(ins.parents.len(), 1);
        assert_eq!(crate::decode_parent_tag(&ins.parents[0]), Ok((TXID, 2)));
        assert!(!ins.duplicate_field && !ins.incomplete_field);
    }

    #[test]
    fn every_owner_and_index_changes_the_leaf() {
        let a = state_leaf_script(&OWNER, &body());
        let mut other_owner = OWNER;
        other_owner[0] ^= 1;
        assert_ne!(a, state_leaf_script(&other_owner, &body()));
        let mut other = body();
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
///
/// Index `0` is the bare 32-byte txid; every other index uses the full
/// four little-endian bytes.
#[must_use]
pub fn encode_parent_tag(mint_txid: &[u8; 32], mint_index: u32) -> Vec<u8> {
    if mint_index == 0 {
        return mint_txid.to_vec();
    }
    let mut out = Vec::with_capacity(36);
    out.extend_from_slice(mint_txid);
    out.extend_from_slice(&mint_index.to_le_bytes());
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
    // ord: a non-canonical integer whose last byte is zero is dropped.
    if index.len() != 4 && index[index.len() - 1] == 0 {
        return Err(ParentTagError::NonMinimalIndex);
    }
    let mut buf = [0u8; 4];
    buf[..index.len()].copy_from_slice(index);
    Ok((txid, u32::from_le_bytes(buf)))
}
