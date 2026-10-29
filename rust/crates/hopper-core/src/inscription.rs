//! Ord inscription envelope codec (protocol rework Change B, plan B.2).
//!
//! Pinned against **ord 0.22.2** (`crates.io` source, `src/inscriptions/
//! envelope.rs` + `inscription.rs`): the reveal script that engraves an
//! inscription on a sat is
//!
//! ```text
//! OP_FALSE OP_IF
//!   "ord"                       ; protocol id (3-byte push)
//!   0x01 "image/png"            ; tag 1 = content type (v5: "text/html;charset=utf-8")
//!   <tag, value> …              ; other fields (pairs)
//!   0x00                        ; empty push = body tag
//!   <body chunk> …              ; ≤520 bytes per push, concatenated
//! OP_ENDIF
//! ```
//!
//! and the inscription sits in a tapleaf script spent via the script
//! path. Anything before/after an envelope in the script is ignored;
//! a script may carry multiple envelopes; OP_PUSHNUM opcodes count as
//! one-byte pushes. `parse_inscriptions` mirrors ord's decoder
//! faithfully so the indexer sees exactly what ord sees.
//!
//! Tags (ord `inscriptions/tag.rs`): pointer=2, content-type=1,
//! parent=3, metadata=5, metaprotocol=7, content-encoding=9,
//! delegate=11, rune=13, unbound=66. **FROGGER never writes a pointer**
//! (it would move the inscription off the anchor sat) and rejects
//! pointer-carrying mint inscriptions.
//!
//! No new dependencies: Bitcoin Script push encoding is hand-rolled
//! (the crate stays sha2-only for Android cross-compilation).

/// The ord protocol identifier pushed first in every envelope.
pub const PROTOCOL_ID: [u8; 3] = *b"ord";
/// ord's `MAX_SCRIPT_ELEMENT_SIZE` — max bytes per script push.
pub const MAX_SCRIPT_ELEMENT_SIZE: usize = 520;

// Opcodes we encode/decode (values are Bitcoin Script constants).
const OP_FALSE: u8 = 0x00; // also: push of empty byte vector
const OP_1NEGATE: u8 = 0x4f;
const OP_PUSHDATA1: u8 = 0x4c;
const OP_PUSHDATA2: u8 = 0x4d;
const OP_PUSHDATA4: u8 = 0x4e;
const OP_IF: u8 = 0x63;
const OP_ENDIF: u8 = 0x68;
const OP_PUSHNUM_1: u8 = 0x51; // 0x51..=0x60 push 1..=16

// Field tags (ord `Tag`), as single-byte pushes in the payload stream.
pub const TAG_POINTER: [u8; 1] = [2];
pub const TAG_CONTENT_TYPE: [u8; 1] = [1];
pub const TAG_METADATA: [u8; 1] = [5];
/// Parent tag (ord tag 3): the value is
/// `parent_txid(32, internal) || index(0..=4, LE, minimal)` — V3 §6.3.
/// Kept raw so the caller can apply ord's canonical-form rule; the
/// parent may also be absent, in which case the body is authoritative.
pub const TAG_PARENT: [u8; 1] = [3];
pub const TAG_UNBOUND: [u8; 1] = [66];

/// A parsed inscription envelope — the subset of ord's `Inscription`
/// the indexer needs for mint validation, plus the ord validity flags.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Inscription {
    /// Tag-1 field value (e.g. `image/png`).
    pub content_type: Option<Vec<u8>>,
    /// Everything after the body tag (all chunks concatenated).
    pub body: Option<Vec<u8>>,
    /// Tag-5 field value (chunked field in ord; here pre-concatenated).
    pub metadata: Option<Vec<u8>>,
    /// Tag-2 field value. FROGGER mints never carry one.
    pub pointer: Option<Vec<u8>>,
    /// Raw tag-3 (parent) values, in payload order (V3 §6.3). Empty for
    /// every v2 inscription.
    pub parents: Vec<Vec<u8>>,
    /// ord: the same tag appeared twice (inscription is unbound).
    pub duplicate_field: bool,
    /// ord: a tag without a value before the body tag.
    pub incomplete_field: bool,
    /// ord: an unrecognized even tag (inscription is unbound).
    pub unrecognized_even_field: bool,
    /// ord: OP_PUSHNUM opcodes in the payload (non-canonical).
    pub pushnum: bool,
    /// ord: the envelope is preceded by `OP_FALSE OP_FALSE`-style junk.
    pub stutter: bool,
}

/// One decoded push-or-opcode of a script — the stream `parse_inscriptions`
/// walks. `Push` covers data pushes AND pushnum opcodes (ord maps both to
/// payload entries).
#[derive(Debug, Clone, PartialEq, Eq)]
enum Item {
    Push(Vec<u8>),
    Op(u8),
}

/// Decode a Bitcoin Script byte stream into pushes and opcodes.
///
/// Truncated pushes are an error (ord ignores unparsable scripts —
/// callers treat `Err` as "no inscriptions").
fn decode_script(script: &[u8]) -> Result<Vec<Item>, ()> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < script.len() {
        let op = script[pos];
        pos += 1;
        let len = match op {
            0x00 => {
                // OP_FALSE: pushes an empty vector (the envelope opener
                // and ord's body tag are exactly this).
                out.push(Item::Push(Vec::new()));
                continue;
            }
            0x01..=0x4b => op as usize, // direct push
            OP_PUSHDATA1 => {
                let Some(&l) = script.get(pos) else {
                    return Err(());
                };
                pos += 1;
                l as usize
            }
            OP_PUSHDATA2 => {
                if script.len() < pos + 2 {
                    return Err(());
                }
                let l = u16::from_le_bytes([script[pos], script[pos + 1]]) as usize;
                pos += 2;
                l
            }
            OP_PUSHDATA4 => {
                if script.len() < pos + 4 {
                    return Err(());
                }
                let l = u32::from_le_bytes([
                    script[pos],
                    script[pos + 1],
                    script[pos + 2],
                    script[pos + 3],
                ]) as usize;
                pos += 4;
                l
            }
            _ => {
                out.push(Item::Op(op));
                continue;
            }
        };
        if script.len() < pos + len || len > MAX_SCRIPT_ELEMENT_SIZE {
            return Err(());
        }
        out.push(Item::Push(script[pos..pos + len].to_vec()));
        pos += len;
    }
    Ok(out)
}

/// Append a data push to `out` using the minimal encoding for `data`
/// (matches `bitcoin::script::Builder::push_slice`).
fn push_bytes(out: &mut Vec<u8>, data: &[u8]) {
    let len = data.len();
    if len == 0 {
        out.push(OP_FALSE);
    } else if len <= 75 {
        out.push(len as u8);
        out.extend_from_slice(data);
    } else if len <= 255 {
        out.push(OP_PUSHDATA1);
        out.push(len as u8);
        out.extend_from_slice(data);
    } else {
        debug_assert!(len <= MAX_SCRIPT_ELEMENT_SIZE);
        out.push(OP_PUSHDATA2);
        out.extend_from_slice(&(len as u16).to_le_bytes());
        out.extend_from_slice(data);
    }
}

/// Build the ord-envelope reveal script for one inscription:
/// `OP_FALSE OP_IF "ord" [1] content-type … [0] body-chunks OP_ENDIF`.
///
/// Byte-exact with ord 0.22.2's `append_reveal_script_to_builder` for
/// the field set FROGGER writes (content type + body; no metadata,
/// pointer, parents, delegate, runes). Body is chunked at 520 bytes.
pub fn build_inscription_script(content_type: &[u8], body: &[u8]) -> Vec<u8> {
    build_inscription_script_with_parents(content_type, body, &[])
}

/// The same envelope with ord parent tags (tag 3) before the body tag.
/// Each entry is the raw `txid || minimal index` value; callers build it
/// with [`crate::cross::encode_parent_tag`]. Order is payload order.
pub fn build_inscription_script_with_parents(
    content_type: &[u8],
    body: &[u8],
    parents: &[Vec<u8>],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + content_type.len() + 32 + 40 * parents.len());
    out.push(OP_FALSE);
    out.push(OP_IF);
    push_bytes(&mut out, &PROTOCOL_ID);
    push_bytes(&mut out, &TAG_CONTENT_TYPE);
    push_bytes(&mut out, content_type);
    for parent in parents {
        push_bytes(&mut out, &TAG_PARENT);
        push_bytes(&mut out, parent);
    }
    // Body: empty push marks the body tag, then ≤520-byte chunks.
    push_bytes(&mut out, &[]);
    for chunk in body.chunks(MAX_SCRIPT_ELEMENT_SIZE) {
        push_bytes(&mut out, chunk);
    }
    out.push(OP_ENDIF);
    out
}

/// The v6 mint body: the self-contained fold document. `sat` is the
/// frog's anchor sat — the body embeds it, which is why it cannot be
/// built before the commit inputs are chosen.
#[must_use]
pub fn mint_body(seed: u32, sat: u64) -> (&'static str, Vec<u8>) {
    (
        crate::live_v6::V6_CONTENT_TYPE,
        crate::live_v6::live_v6_html(seed, sat).into_bytes(),
    )
}

/// SHA-256 of [`mint_body`] — the digest a NEW mint must carry.
#[must_use]
pub fn mint_body_digest(seed: u32, sat: u64) -> [u8; 32] {
    let (_, body) = mint_body(seed, sat);
    use sha2::Digest as _;
    sha2::Sha256::digest(&body).into()
}

/// Every digest the wire accepts for `(seed, sat)`: the current body and
/// the pre-fix v6 body that every frog minted before the fold's boot fix
/// already carries. Old inscriptions stay valid by construction; only
/// [`mint_body_digest`] can be produced by a wallet.
#[must_use]
pub fn mint_body_digests(seed: u32, sat: u64) -> [[u8; 32]; 2] {
    crate::live_v6::live_v6_html_digests(seed, sat)
}

/// Build the frog mint inscription script (v6 body).
#[must_use]
pub fn build_frog_mint_script(seed: u32, sat: u64) -> Vec<u8> {
    let (content_type, body) = mint_body(seed, sat);
    build_inscription_script(content_type.as_bytes(), &body)
}

/// Parse every inscription envelope in a tapleaf script, mirroring ord
/// 0.22.2's `RawEnvelope::from_tapscript` + `From<RawEnvelope> for
/// ParsedEnvelope`:
///
/// - envelopes start at `OP_FALSE OP_IF "ord"`, end at `OP_ENDIF`;
/// - junk opcodes between envelopes are skipped; `OP_FALSE OP_FALSE`
///   before an envelope marks it `stutter`;
/// - payload items are pushes and OP_PUSHNUM opcodes (pushnum flag);
/// - fields are (tag, value) pairs until the first empty push at an
///   even index — that push is the body tag, the rest is the body;
/// - duplicate tags, incomplete fields, and unrecognized even tags set
///   the corresponding validity flags (ord: unbound inscription).
pub fn parse_inscriptions(script: &[u8]) -> Vec<Inscription> {
    let items = match decode_script(script) {
        Ok(items) => items,
        Err(()) => return Vec::new(), // ord: unparsable script ⇒ nothing
    };
    let mut out = Vec::new();
    let mut i = 0usize;
    let mut stuttered = false;
    while i < items.len() {
        // Envelope opener: an empty push directly followed by OP_IF.
        if items[i] == Item::Push(Vec::new()) && items.get(i + 1) == Some(&Item::Op(OP_IF)) {
            let (stutter, envelope) = parse_envelope(&items, i);
            match envelope {
                Some(ins) => out.push(ins),
                None => stuttered = stutter,
            }
            if let Some(ins) = out.last_mut() {
                ins.stutter = stuttered;
                stuttered = false;
            }
            // Advance past the opener either way; parse_envelope reports
            // how far it got by re-scanning (kept simple: re-derive).
            i = advance_past(&items, i);
        } else {
            if items[i] == Item::Push(Vec::new()) {
                // Potential stutter prefix for the NEXT envelope.
                stuttered = true;
            } else {
                stuttered = false;
            }
            i += 1;
        }
    }
    out
}

/// Scan forward from an envelope opener at `start` to the index just
/// past its `OP_ENDIF` (or the whole script if unterminated).
fn advance_past(items: &[Item], start: usize) -> usize {
    let mut i = start + 2; // skip OP_FALSE-equivalent push + OP_IF
    while i < items.len() {
        if items[i] == Item::Op(OP_ENDIF) {
            return i + 1;
        }
        i += 1;
    }
    items.len()
}

/// Parse one envelope starting at `items[start] == Push([])`,
/// `items[start+1] == OP_IF` — ord's `from_instructions`.
fn parse_envelope(items: &[Item], start: usize) -> (bool, Option<Inscription>) {
    let mut i = start + 2;
    // Protocol id must be the first push.
    match items.get(i) {
        Some(Item::Push(p)) if p.as_slice() == PROTOCOL_ID => i += 1,
        _ => return (false, None),
    }
    let mut pushnum = false;
    let mut payload: Vec<Vec<u8>> = Vec::new();
    loop {
        match items.get(i) {
            None => return (false, None), // no OP_ENDIF
            Some(Item::Op(OP_ENDIF)) => {
                return (false, Some(build_inscription(payload, pushnum)));
            }
            Some(Item::Op(OP_1NEGATE)) => {
                pushnum = true;
                payload.push(vec![0x81]);
                i += 1;
            }
            Some(Item::Op(op @ OP_PUSHNUM_1..=0x60)) => {
                pushnum = true;
                payload.push(vec![op - OP_PUSHNUM_1 + 1]);
                i += 1;
            }
            Some(Item::Push(p)) => {
                payload.push(p.clone());
                i += 1;
            }
            Some(Item::Op(_)) => return (false, None), // non-push in envelope
        }
    }
}

/// ord's `From<RawEnvelope> for ParsedEnvelope`: split the payload into
/// fields + body at the first empty push on an even index.
fn build_inscription(mut payload: Vec<Vec<u8>>, pushnum: bool) -> Inscription {
    let body_at = payload
        .iter()
        .enumerate()
        .position(|(i, push)| i % 2 == 0 && push.is_empty());

    // Fields: (tag, value) pairs before the body tag.
    let mut fields: std::collections::BTreeMap<Vec<u8>, Vec<Vec<u8>>> =
        std::collections::BTreeMap::new();
    let mut incomplete_field = false;
    let field_end = body_at.unwrap_or(payload.len());
    {
        let mut i = 0usize;
        while i < field_end {
            let key = payload[i].clone();
            if i + 1 < field_end {
                fields.entry(key).or_default().push(payload[i + 1].clone());
                i += 2;
            } else {
                incomplete_field = true;
                i += 1;
            }
        }
    }
    let duplicate_field = fields.values().any(|v| v.len() > 1);

    let mut take = |tag: &[u8; 1]| -> Option<Vec<u8>> {
        // Metadata is chunked in ord: all values concatenated.
        let key: Vec<u8> = tag.to_vec();
        let vs = fields.remove(&key)?;
        Some(vs.into_iter().flatten().collect())
    };
    let content_type = take(&TAG_CONTENT_TYPE);
    let metadata = take(&TAG_METADATA);
    let pointer = take(&TAG_POINTER);
    let parents = fields.remove(TAG_PARENT.as_slice()).unwrap_or_default();
    // Recognized-but-unused tags (parent/metaprotocol/encoding/delegate/
    // rune) are simply ignored here; the caller validates the field set.
    let unrecognized_even_field = fields
        .keys()
        .any(|tag| tag.first().map(|lsb| lsb % 2 == 0).unwrap_or(false));

    let body = body_at.map(|at| payload.drain(at + 1..).flatten().collect::<Vec<u8>>());

    Inscription {
        content_type,
        body,
        metadata,
        pointer,
        parents,
        duplicate_field,
        incomplete_field,
        unrecognized_even_field,
        pushnum,
        stutter: false,
    }
}

/// Ord inscription id: `{reveal_txid}i{index}` (decimal, no 0x).
pub fn inscription_id(txid_hex: &str, index: u32) -> String {
    format!("{txid_hex}i{index}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: append a script fragment to another (byte concat).
    fn cat(parts: &[&[u8]]) -> Vec<u8> {
        parts.concat()
    }

    #[test]
    fn tag_3_parents_are_surfaced_raw() {
        // V3 §6.3: value = txid(32) || minimal index. The parser must not
        // interpret it (ord's canonical rule is the caller's job), and a
        // missing parent is simply absent.
        let parent = [0xABu8; 32];
        let mut script = cat(&[&[0x00, 0x63], &[0x03, b'o', b'r', b'd']]);
        script.extend_from_slice(&[0x01, 0x03]); // tag 3
        script.extend_from_slice(&[0x20]); // 32-byte push
        script.extend_from_slice(&parent);
        script.extend_from_slice(&[0x00]); // body tag (empty push)
        script.extend_from_slice(&[0x68]); // OP_ENDIF
        let ins = &parse_inscriptions(&script)[0];
        assert_eq!(ins.parents, vec![parent.to_vec()]);
        assert_eq!(ins.body.as_deref(), Some(&[][..]));
    }

    #[test]
    fn round_trip_content_type_and_body() {
        let script = build_inscription_script(b"image/png", &[1, 2, 3]);
        let inscriptions = parse_inscriptions(&script);
        assert_eq!(inscriptions.len(), 1);
        let ins = &inscriptions[0];
        assert_eq!(ins.content_type.as_deref(), Some(b"image/png".as_slice()));
        assert_eq!(ins.body.as_deref(), Some(&[1u8, 2, 3][..]));
        assert!(ins.metadata.is_none());
        assert!(ins.pointer.is_none());
        assert!(!ins.duplicate_field);
        assert!(!ins.incomplete_field);
        assert!(!ins.unrecognized_even_field);
        assert!(!ins.pushnum);
        assert!(!ins.stutter);
    }

    #[test]
    fn body_chunks_are_reassembled() {
        // >520 bytes forces chunking (ord's MAX_SCRIPT_ELEMENT_SIZE).
        let body: Vec<u8> = (0..1108u32).map(|i| (i % 251) as u8).collect();
        let script = build_inscription_script(b"image/png", &body);
        let ins = &parse_inscriptions(&script)[0];
        assert_eq!(ins.body.as_deref(), Some(&body[..]));
    }

    #[test]
    fn frog_mint_script_carries_the_fold_document() {
        let seed = 0x0bad_f00d;
        let sat = 1_234_567_890;
        let script = build_frog_mint_script(seed, sat);
        let ins = &parse_inscriptions(&script)[0];
        assert_eq!(
            ins.content_type.as_deref(),
            Some(crate::live_v6::V6_CONTENT_TYPE.as_bytes())
        );
        assert_eq!(
            ins.body.as_deref(),
            Some(crate::live_v6::live_v6_html(seed, sat).as_bytes()),
            "the engraved body must be the fold document"
        );
        assert_eq!(
            <sha2::Sha256 as sha2::Digest>::digest(ins.body.as_deref().unwrap()).as_slice(),
            mint_body_digest(seed, sat),
            "the digest the indexer enforces is SHA-256 of the same bytes"
        );
    }

    #[test]
    fn script_bytes_have_exact_shape() {
        // OP_FALSE OP_IF "ord" [1] "image/png" [] "ok" OP_ENDIF — pinned
        // against ord 0.22.2's builder output.
        let script = build_inscription_script(b"image/png", b"ok");
        assert_eq!(
            script,
            cat(&[
                &[OP_FALSE, OP_IF],
                &[3, b'o', b'r', b'd'],
                &[1, TAG_CONTENT_TYPE[0]],
                &[9, b'i', b'm', b'a', b'g', b'e', b'/', b'p', b'n', b'g'],
                &[0], // body tag: empty push
                &[2, b'o', b'k'],
                &[OP_ENDIF],
            ])
        );
    }

    #[test]
    fn long_content_type_uses_pushdata1() {
        let ct = vec![b'x'; 100]; // > 75 bytes
        let script = build_inscription_script(&ct, b"");
        assert_eq!(script[6], 1, "tag push is 1 byte");
        assert_eq!(script[7], TAG_CONTENT_TYPE[0]);
        assert_eq!(script[8], OP_PUSHDATA1);
        assert_eq!(script[9], 100);
        let ins = &parse_inscriptions(&script)[0];
        assert_eq!(ins.content_type.as_deref(), Some(&ct[..]));
    }

    #[test]
    fn junk_before_and_after_envelopes_is_ignored() {
        // ord's valid_ignore_preceding/trailing: OP_CHECKSIG on both sides.
        let mut script = vec![0xacu8]; // OP_CHECKSIG
        script.extend_from_slice(&build_inscription_script(b"image/png", b"ord"));
        script.push(0xac);
        let ins = &parse_inscriptions(&script)[0];
        assert_eq!(ins.body.as_deref(), Some(&b"ord"[..]));
    }

    #[test]
    fn multiple_inscriptions_in_one_script() {
        let mut script = build_inscription_script(b"image/png", b"foo");
        script.extend_from_slice(&build_inscription_script(b"image/png", b"bar"));
        let inscriptions = parse_inscriptions(&script);
        assert_eq!(inscriptions.len(), 2);
        assert_eq!(inscriptions[0].body.as_deref(), Some(&b"foo"[..]));
        assert_eq!(inscriptions[1].body.as_deref(), Some(&b"bar"[..]));
    }

    #[test]
    fn no_op_false_means_no_envelope() {
        // OP_IF without the leading OP_FALSE: not an envelope (ord's
        // no_op_false).
        let script = vec![OP_IF, 3, b'o', b'r', b'd', OP_ENDIF];
        assert!(parse_inscriptions(&script).is_empty());
    }

    #[test]
    fn wrong_protocol_id_is_not_an_envelope() {
        let mut script = vec![OP_FALSE, OP_IF, 3, b'f', b'o', b'o', OP_ENDIF];
        script.shrink_to_fit();
        assert!(parse_inscriptions(&script).is_empty());
    }

    #[test]
    fn truncated_script_yields_nothing() {
        // A push that runs off the end: unparsable ⇒ no inscriptions.
        let script = [0x05, 0x01, 0x02];
        assert!(parse_inscriptions(&script).is_empty());
        // Push length beyond MAX_SCRIPT_ELEMENT_SIZE is refused.
        let script = [OP_PUSHDATA2, 0x0a, 0xff, 0x00];
        assert!(parse_inscriptions(&script).is_empty());
    }

    #[test]
    fn pushnum_opcodes_become_payload_bytes() {
        // ord: OP_PUSHNUM_1 in the payload = push [1] + pushnum flag.
        let script = [
            OP_FALSE,
            OP_IF,
            3,
            b'o',
            b'r',
            b'd',         // opener + protocol id
            OP_PUSHNUM_1, // body tag (push [1])… wait: [1] is content-type tag
            0x02,
            b'o',
            b'k', // value for tag 1
            0x00, // body tag (empty push at even index)
            0x51, // OP_PUSHNUM_1: body chunk [1]
            OP_ENDIF,
        ];
        let ins = &parse_inscriptions(&script)[0];
        assert!(ins.pushnum, "OP_PUSHNUM in the payload sets the flag");
        assert_eq!(ins.body.as_deref(), Some(&[1u8][..]));
        assert_eq!(ins.content_type.as_deref(), Some(&b"ok"[..]));
    }

    #[test]
    fn duplicate_and_incomplete_and_even_fields_flag() {
        // Duplicate content-type field (tag 1 twice).
        let script = [
            OP_FALSE,
            OP_IF,
            3,
            b'o',
            b'r',
            b'd',
            1,
            TAG_CONTENT_TYPE[0],
            2,
            b'a',
            b'a',
            1,
            TAG_CONTENT_TYPE[0],
            2,
            b'b',
            b'b',
            0x00,
            OP_ENDIF,
        ];
        let ins = &parse_inscriptions(&script)[0];
        assert!(ins.duplicate_field);

        // Incomplete field: a tag with no value and no body tag at all
        // (ord's incomplete_field test: envelope(&[ord, [99]])).
        let script = [
            OP_FALSE, OP_IF, 3, b'o', b'r', b'd', 1, 99, // lone tag push, no value
            OP_ENDIF,
        ];
        let ins = &parse_inscriptions(&script)[0];
        assert!(ins.incomplete_field);

        // Unrecognized even tag (22): unbound inscription.
        let script = [
            OP_FALSE, OP_IF, 3, b'o', b'r', b'd', 1, 22, 1, 0, 0x00, OP_ENDIF,
        ];
        let ins = &parse_inscriptions(&script)[0];
        assert!(ins.unrecognized_even_field);

        // Unrecognized ODD tag: ignored, still bound.
        let script = [
            OP_FALSE, OP_IF, 3, b'o', b'r', b'd', 1, 99, 1, 0, 0x00, OP_ENDIF,
        ];
        let ins = &parse_inscriptions(&script)[0];
        assert!(!ins.unrecognized_even_field);
    }

    #[test]
    fn pointer_and_metadata_are_extracted() {
        // Metadata is a chunked field in ord: two (tag,value) pairs
        // concatenate.
        let script = [
            OP_FALSE,
            OP_IF,
            3,
            b'o',
            b'r',
            b'd',
            1,
            TAG_METADATA[0],
            1,
            0,
            1,
            TAG_METADATA[0],
            1,
            1,
            1,
            TAG_POINTER[0],
            1,
            4,
            0x00,
            OP_ENDIF,
        ];
        let ins = &parse_inscriptions(&script)[0];
        assert_eq!(ins.metadata.as_deref(), Some(&[0u8, 1][..]));
        assert_eq!(ins.pointer.as_deref(), Some(&[4u8][..]));
        assert!(ins.duplicate_field, "metadata appearing twice is duplicate");
    }

    #[test]
    fn stuttering_is_flagged() {
        // OP_FALSE OP_FALSE OP_IF …: the envelope stutters (ord's test).
        let mut script = vec![OP_FALSE];
        script.extend_from_slice(&build_inscription_script(b"image/png", b"x"));
        let ins = &parse_inscriptions(&script)[0];
        assert!(ins.stutter);
    }

    #[test]
    fn no_endif_is_not_an_envelope() {
        let script = [OP_FALSE, OP_IF, 3, b'o', b'r', b'd', 0x00];
        assert!(parse_inscriptions(&script).is_empty());
    }

    #[test]
    fn inscription_id_formats_like_ord() {
        assert_eq!(
            inscription_id(
                "0123abcd0000000000000000000000000000000000000000000000000000c0de",
                0
            ),
            "0123abcd0000000000000000000000000000000000000000000000000000c0dei0"
        );
        assert_eq!(inscription_id("ab", 12), "abi12");
    }
}
