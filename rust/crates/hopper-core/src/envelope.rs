//! FROGGER envelope codec — one wire version, one action.
//!
//! Wire format: `"FRG" | version:u8 | action:u8 | payload` — all integers
//! little-endian, one envelope per transaction, ≤ 80-byte OP_RETURN push.
//!
//! `0x07` is the only version this build speaks. A MINT is the envelope;
//! a hop is a *state inscription* ([`crate::v7`]), never an
//! envelope. Every earlier version (v2's game actions, v3's `0x04`
//! tickets, v5's `0x05` live art) was removed: those bytes are
//! [`DecodeError::UnknownVersion`] now, and an indexer treats them as
//! "not a frog".

/// Protocol magic bytes.
pub const MAGIC: [u8; 3] = *b"FRG";

/// The only wire version: inscription-native state (`docs/V6-SPEC.md`).
pub const VERSION: u8 = 0x07;

/// Action bytes. `MINT` is the only one; the v2 game actions are gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Action {
    Mint = 0x01,
}

impl TryFrom<u8> for Action {
    type Error = DecodeError;

    fn try_from(v: u8) -> Result<Self, DecodeError> {
        match v {
            0x01 => Ok(Action::Mint),
            _ => Err(DecodeError::UnknownAction(v)),
        }
    }
}

/// A decoded protocol message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    /// Frogger birth: art seed + optional name.
    Mint { seed: u32, name: String },
}

/// Envelope decoding errors. Malformed payloads are ignored, never
/// chain-invalidating.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    TooShort,
    BadMagic,
    UnknownVersion(u8),
    UnknownAction(u8),
    TruncatedPayload,
    NameTooLong(u8),
    InvalidUtf8,
}

impl core::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            DecodeError::TooShort => write!(f, "envelope shorter than 5-byte header"),
            DecodeError::BadMagic => write!(f, "bad FRG magic"),
            DecodeError::UnknownVersion(v) => {
                write!(
                    f,
                    "version {v:#04x} is not supported (this build speaks 0x07)"
                )
            }
            DecodeError::UnknownAction(a) => write!(f, "unknown action {a:#04x}"),
            DecodeError::TruncatedPayload => write!(f, "truncated payload"),
            DecodeError::NameTooLong(n) => write!(f, "mint name length {n} exceeds 38"),
            DecodeError::InvalidUtf8 => write!(f, "mint name is not valid UTF-8"),
        }
    }
}

impl core::error::Error for DecodeError {}

/// Build a full envelope push from an action and payload.
///
/// # Panics
/// If `payload` exceeds 75 bytes (single OP_PUSHDATA budget).
#[must_use]
pub fn envelope(action: Action, payload: &[u8]) -> Vec<u8> {
    assert!(
        payload.len() <= 75,
        "payload too large for single OP_PUSHDATA"
    );
    let mut out = Vec::with_capacity(5 + payload.len());
    out.extend_from_slice(&MAGIC);
    out.push(VERSION);
    out.push(action as u8);
    out.extend_from_slice(payload);
    out
}

/// Encode a MINT payload: `seed:u32 ‖ name_len:u8 ‖ name[0..38]`.
///
/// # Panics
/// If `name` exceeds 38 bytes.
#[must_use]
pub fn encode_mint(seed: u32, name: &str) -> Vec<u8> {
    let name = name.as_bytes();
    assert!(name.len() <= 38, "mint name exceeds 38 bytes");
    let mut p = Vec::with_capacity(5 + name.len());
    p.extend_from_slice(&seed.to_le_bytes());
    p.push(name.len() as u8);
    p.extend_from_slice(name);
    p
}

/// Decode an OP_RETURN push into a [`Message`].
pub fn decode(push: &[u8]) -> Result<Message, DecodeError> {
    if push.len() < 5 {
        return Err(DecodeError::TooShort);
    }
    if push[..3] != MAGIC {
        return Err(DecodeError::BadMagic);
    }
    if push[3] != VERSION {
        return Err(DecodeError::UnknownVersion(push[3]));
    }
    let action = Action::try_from(push[4])?;
    let p = &push[5..];
    match action {
        Action::Mint => {
            if p.len() < 5 {
                return Err(DecodeError::TruncatedPayload);
            }
            let seed = u32::from_le_bytes([p[0], p[1], p[2], p[3]]);
            let nlen = p[4];
            if nlen > 38 {
                return Err(DecodeError::NameTooLong(nlen));
            }
            if p.len() < 5 + nlen as usize {
                return Err(DecodeError::TruncatedPayload);
            }
            let name = core::str::from_utf8(&p[5..5 + nlen as usize])
                .map_err(|_| DecodeError::InvalidUtf8)?;
            Ok(Message::Mint {
                seed,
                name: name.to_owned(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mint_round_trips() {
        for (seed, name) in [(0x9058_D0FAu32, "Hopkinson"), (42, "")] {
            let env = envelope(Action::Mint, &encode_mint(seed, name));
            assert!(env.len() <= 80, "envelope exceeds OP_RETURN budget");
            assert_eq!(
                decode(&env),
                Ok(Message::Mint {
                    seed,
                    name: name.to_owned()
                })
            );
        }
    }

    #[test]
    fn only_version_0x07_is_spoken() {
        // Every earlier version byte — v2 (0x03), v3 (0x04), live art
        // (0x05) — is simply not this protocol.
        for version in [0x02u8, 0x03, 0x04, 0x05, 0x06] {
            let push = [b'F', b'R', b'G', version, 0x01, 0, 0, 0, 0, 0];
            assert_eq!(decode(&push), Err(DecodeError::UnknownVersion(version)));
        }
    }

    #[test]
    fn v2_game_actions_are_unknown_now() {
        for action in [0x02u8, 0x03, 0x04] {
            let mut push = vec![b'F', b'R', b'G', VERSION, action];
            push.extend_from_slice(&[0u8; 39]);
            assert_eq!(decode(&push), Err(DecodeError::UnknownAction(action)));
        }
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(decode(b"XX"), Err(DecodeError::TooShort));
        assert_eq!(decode(b"XYZ\x06\x01\xff"), Err(DecodeError::BadMagic));
        assert_eq!(
            decode(b"FRG\x09\x01\xff"),
            Err(DecodeError::UnknownVersion(0x09))
        );
        assert_eq!(
            decode(b"FRG\x07\x07\xff"),
            Err(DecodeError::UnknownAction(0x07))
        );
        assert_eq!(
            decode(b"FRG\x07\x01\x00"),
            Err(DecodeError::TruncatedPayload)
        );
    }
}
