//! Deterministic PNG encoder (protocol rework Change B, plan B.2).
//!
//! The frog's identity art is engraved on-chain as an ord inscription,
//! and the indexer must be able to validate the body WITHOUT decoding
//! PNG: `sha256(inscription_body) == sha256(render_png(seed))`. That
//! only works if the encoding is canonical — exactly one byte sequence
//! per sprite. So this writer is fully specified:
//!
//! - signature, then IHDR (8-bit RGBA, no interlace)
//! - one IDAT: zlib stream `78 01` + **stored** (uncompressed) deflate
//!   blocks (≤ 65535 bytes each, `BFINAL` on the last) + Adler-32
//! - filter byte `0` (None) prefixed to every scanline
//! - IEND
//!
//! No new dependencies (sha2 stays the crate's only dep); ~hand-rolled
//! CRC-32 (PNG chunk checksums) and Adler-32 (zlib checksum) below.
//! The indexer-api `/art.png` endpoint and the wallet's inscription
//! builder both use this module — one encoder, one canonical body.

use crate::art::render_sprite;
use crate::sprite::{SPRITE_H, SPRITE_W};
use crate::FrogState;

/// PNG magic — every file starts here.
const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];
/// Max payload of a single stored deflate block (2-byte LEN field).
const STORED_MAX: usize = u16::MAX as usize;

// ---------------------------------------------------------------------------
// checksums
// ---------------------------------------------------------------------------

/// PNG chunk checksum: CRC-32 (poly 0xEDB88320, init/final 0xffffffff),
/// over the chunk type + chunk data.
pub fn crc32(data: &[u8]) -> u32 {
    // Standard reflected CRC-32 (same polynomial as zlib/PNG).
    let mut crc: u32 = 0xffff_ffff;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

/// zlib stream checksum: Adler-32 (mod 65521).
fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in data {
        a = (a + byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

// ---------------------------------------------------------------------------
// chunk + stream assembly
// ---------------------------------------------------------------------------

/// One PNG chunk: `len(u32 BE) ‖ type ‖ data ‖ crc32(type ‖ data)`.
fn push_chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(kind);
    crc_input.extend_from_slice(data);
    out.extend_from_slice(&crc32(&crc_input).to_be_bytes());
}

/// zlib stream of `raw` using only stored deflate blocks: canonical,
/// uncompressed, trivially verifiable.
fn zlib_stored(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len() + raw.len() / STORED_MAX * 5 + 11);
    // CMF/FLG: CM=8 (deflate), CINFO=7, FCHECK makes (CMF<<8|FLG) % 31 == 0.
    out.extend_from_slice(&[0x78, 0x01]);
    let mut chunks = raw.chunks(STORED_MAX).peekable();
    if raw.is_empty() {
        // A lone final empty stored block.
        out.extend_from_slice(&[0x01, 0x00, 0x00, 0xff, 0xff]);
    }
    while let Some(block) = chunks.next() {
        let bfinal = if chunks.peek().is_none() { 1u8 } else { 0u8 };
        let len = block.len() as u16;
        out.push(bfinal); // BTYPE=00 (stored) in the high bits
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(block);
    }
    out.extend_from_slice(&adler32(raw).to_be_bytes());
    out
}

/// Raw PNG image data for an RGBA8 buffer: filter byte 0 per scanline.
fn filtered_scanlines(width: usize, height: usize, rgba: &[u8]) -> Vec<u8> {
    let stride = width * 4;
    assert_eq!(rgba.len(), stride * height, "buffer must be w*h*4");
    let mut out = Vec::with_capacity(height * (stride + 1));
    for row in 0..height {
        out.push(0u8); // filter: None
        out.extend_from_slice(&rgba[row * stride..(row + 1) * stride]);
    }
    out
}

/// Encode `width × height` RGBA8 pixels as a canonical PNG.
///
/// Deterministic by construction: given the same pixels, the output is
/// always the same bytes (fixed zlib params, fixed filter, fixed chunk
/// split).
pub fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let raw = filtered_scanlines(width as usize, height as usize, rgba);
    let mut out = Vec::with_capacity(raw.len() + 64);
    out.extend_from_slice(&SIGNATURE);
    // IHDR: width, height, bit depth 8, color type 6 (RGBA),
    // compression 0 (deflate — the only legal value), filter 0,
    // interlace 0.
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&width.to_be_bytes());
    ihdr.extend_from_slice(&height.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]);
    push_chunk(&mut out, b"IHDR", &ihdr);
    push_chunk(&mut out, b"IDAT", &zlib_stored(&raw));
    push_chunk(&mut out, b"IEND", &[]);
    out
}

/// The frog's canonical identity PNG: the idle-state 16×16 sprite.
///
/// This exact byte sequence is what a Change-B mint engraves on the
/// anchor sat and what the indexer validates
/// (`sha256(body) == sha256(render_png(seed))`).
pub fn render_png(seed: u32) -> Vec<u8> {
    let sprite = render_sprite(seed, FrogState::Idle);
    encode_png(SPRITE_W as u32, SPRITE_H as u32, sprite.as_rgba())
}

/// SHA-256 of `render_png(seed)` — the inscription art digest the
/// indexer compares against the on-chain inscription body (Change B:
/// strict mint validation). Computing it here keeps the indexer free
/// of direct sha2 use and pins the comparison to one implementation.
pub fn render_png_digest(seed: u32) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let d = Sha256::digest(render_png(seed));
    let mut out = [0u8; 32];
    out.copy_from_slice(&d);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2×2 red/green/blue/transparent pixels.
    fn tiny_rgba() -> Vec<u8> {
        vec![
            255, 0, 0, 255, 0, 255, 0, 255, //
            0, 0, 255, 255, 0, 0, 0, 0,
        ]
    }

    #[test]
    fn crc32_matches_known_vectors() {
        // Standard CRC-32 test vectors (same function zlib/PNG use).
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
        assert_eq!(crc32(b""), 0);
        assert_eq!(crc32(b"a"), 0xe8b7_be43);
    }

    #[test]
    fn adler32_matches_known_vectors() {
        assert_eq!(adler32(b""), 1);
        assert_eq!(adler32(b"a"), 0x0062_0062);
        assert_eq!(adler32(b"abc"), 0x024d_0127);
        // Wikipedia's "Wikipedia" example.
        assert_eq!(adler32(b"Wikipedia"), 0x11e6_0398);
    }

    #[test]
    fn encode_is_byte_stable() {
        let a = encode_png(2, 2, &tiny_rgba());
        let b = encode_png(2, 2, &tiny_rgba());
        assert_eq!(a, b, "same pixels must encode to identical bytes");
    }

    #[test]
    fn structure_is_well_formed() {
        let png = encode_png(2, 2, &tiny_rgba());
        assert_eq!(&png[..8], &SIGNATURE);
        // IHDR length field + type.
        assert_eq!(&png[8..12], &13u32.to_be_bytes());
        assert_eq!(&png[12..16], b"IHDR");
        // IHDR fields: 2×2, depth 8, RGBA(6), deflate(0), filter 0, no
        // interlace.
        assert_eq!(&png[16..29], &[0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
        // Ends with IEND (empty data): len(0) ‖ "IEND" ‖ crc.
        assert_eq!(&png[png.len() - 12..png.len() - 8], &0u32.to_be_bytes());
        assert_eq!(&png[png.len() - 8..png.len() - 4], b"IEND");
    }

    #[test]
    fn idat_is_a_stored_zlib_stream() {
        let png = encode_png(2, 2, &tiny_rgba());
        // Layout: signature(8) + IHDR chunk(4+4+13+4=25) → IDAT length
        // field at 33, type at 37, data at 41.
        let idat_len = u32::from_be_bytes(png[33..37].try_into().unwrap()) as usize;
        assert_eq!(&png[37..41], b"IDAT");
        let stream = &png[41..41 + idat_len];
        // zlib header: 78 01, FCHECK valid ((0x7801) % 31 == 0).
        assert_eq!(&stream[..2], &[0x78, 0x01]);
        // One final stored block carrying 2 scanlines × (1 + 8) bytes.
        assert_eq!(stream[2], 0x01, "single BFINAL stored block");
        let len = u16::from_le_bytes(stream[3..5].try_into().unwrap()) as usize;
        assert_eq!(len, 2 * (1 + 2 * 4));
        let raw = &stream[7..7 + len];
        assert_eq!(raw[0], 0u8, "filter byte 0");
        // Adler-32 trailer covers the raw scanlines.
        let adler = u32::from_be_bytes(stream[7 + len..7 + len + 4].try_into().unwrap());
        assert_eq!(adler, adler32(raw));
        assert_eq!(stream.len(), 2 + 5 + len + 4);
    }

    #[test]
    fn chunk_crcs_recompute() {
        // Walk every chunk and verify its CRC against type+data.
        let png = encode_png(
            SPRITE_W as u32,
            SPRITE_H as u32,
            &[0u8; SPRITE_W * SPRITE_H * 4],
        );
        let mut pos = SIGNATURE.len();
        let mut seen: Vec<[u8; 4]> = Vec::new();
        while pos < png.len() {
            let len = u32::from_be_bytes(png[pos..pos + 4].try_into().unwrap()) as usize;
            let kind = &png[pos + 4..pos + 8];
            let data = &png[pos + 8..pos + 8 + len];
            let crc = u32::from_be_bytes(png[pos + 8 + len..pos + 12 + len].try_into().unwrap());
            let mut crc_input = Vec::new();
            crc_input.extend_from_slice(kind);
            crc_input.extend_from_slice(data);
            assert_eq!(crc, crc32(&crc_input), "chunk {kind:?} CRC mismatch");
            seen.push(kind.try_into().unwrap());
            pos += 12 + len;
        }
        assert_eq!(seen, vec!(*b"IHDR", *b"IDAT", *b"IEND"));
    }

    #[test]
    fn render_png_is_deterministic_and_sized() {
        let a = render_png(0x0bad_f00d);
        let b = render_png(0x0bad_f00d);
        assert_eq!(a, b);
        // 16×16 RGBA: raw = 16 × (1 + 64) = 1040 stored bytes + zlib
        // framing + IHDR/IEND.
        assert_eq!(&a[..8], &SIGNATURE);
        assert!(a.len() < 1200, "stored encoding stays small: {}", a.len());
        // Different seeds → different art → different bytes.
        assert_ne!(a, render_png(1));
    }

    #[test]
    fn large_buffers_split_into_stored_blocks() {
        // 70000 raw bytes needs two stored blocks (max 65535 each).
        let width = 10u32;
        let height = 1750u32; // 10*4*1750 = 70000
        let rgba = vec![7u8; (width * height * 4) as usize];
        let png = encode_png(width, height, &rgba);
        // Find the IDAT and walk its stored blocks.
        let idat = png
            .windows(4)
            .position(|w| w == b"IDAT")
            .expect("IDAT present");
        let len = u32::from_be_bytes(png[idat - 4..idat].try_into().unwrap()) as usize;
        let stream = &png[idat + 4..idat + 4 + len];
        let mut pos = 2; // skip zlib header
        let mut blocks = 0;
        let mut bfinal_seen = false;
        while pos < stream.len() - 4 {
            let header = stream[pos];
            let bfinal = header & 1 == 1;
            let blen = u16::from_le_bytes(stream[pos + 1..pos + 3].try_into().unwrap()) as usize;
            let nlen = u16::from_le_bytes(stream[pos + 3..pos + 5].try_into().unwrap());
            assert_eq!(!blen as u16, nlen, "NLEN must be one's complement");
            assert_eq!(header & 0xfe, 0, "BTYPE must be 00 (stored)");
            pos += 5 + blen;
            blocks += 1;
            bfinal_seen |= bfinal;
        }
        assert_eq!(blocks, 2, "70000 raw bytes split into two blocks");
        assert!(bfinal_seen, "last block must set BFINAL");
        assert_eq!(pos, stream.len() - 4, "only the Adler trailer remains");
    }
}
