//! FROGGER app-icon generator: renders the BRAND frogger — the first
//! seed (ascending) whose rarity is Exotic with a true-orange body hue
//! (Common/Uncommon hues are pinned green 95–140°, Golden is amber
//! 48°, so Exotic is the only orange family) — and writes the full
//! Android icon set plus a 512px logo.
//!
//! Output (into `<res-dir>` = crates/frogger-wallet-android/res):
//! - `mipmap-{mdpi..xxxhdpi}/ic_launcher.png` (+ `_round`) — legacy
//!   full-square bitmaps (dark-green app background, big frog)
//! - `mipmap-{d}/ic_launcher_foreground.png` — adaptive-icon
//!   foregrounds (transparent, frog centered inside the 66dp safe
//!   zone)
//!
//! and `<logo-path>` — a 512px transparent logo.
//!
//! PNG encoding is hand-rolled here (stored-deflate zlib, filter 0) so
//! hopper-core stays dependency-free. Scaling is nearest-neighbor
//! with INTEGER pixel scale from the 16×16 source — chunky pixels,
//! never smeared.
//!
//! Usage: cargo run -p hopper-core --example icon -- <res-dir> <logo-path>

use hopper_core::art::{derive_traits, render_sprite};
use hopper_core::sprite::Sprite;
use hopper_core::{FrogState, Rarity};

/// The app background (GUI `theme::BG`, dark green).
const BG: [u8; 4] = [24, 36, 26, 255];

/// True-orange hue band for the brand frogger's body.
const ORANGE_HUE: std::ops::RangeInclusive<f64> = 22.0..=40.0;

fn main() {
    let mut args = std::env::args().skip(1);
    let res_dir = args.next().expect("usage: icon <res-dir> <logo-path>");
    let logo_path = args.next().expect("usage: icon <res-dir> <logo-path>");

    // The brand seed: deterministic, documented, and reproducible —
    // anyone re-running this generator gets the same frog.
    let mut brand_seed = None;
    for seed in 0u32.. {
        let t = derive_traits(seed);
        if matches!(t.rarity, Rarity::Exotic) && ORANGE_HUE.contains(&t.hue) {
            brand_seed = Some(seed);
            println!(
                "brand seed {seed:#010x}: rarity {:?}, hue {:.0}°, pattern {:?}, eyes {:?}, mouth {:?}, chonk {}, legs {}",
                t.rarity, t.hue, t.pattern, t.eyes, t.mouth, t.chonk, t.legs
            );
            break;
        }
    }
    let seed = brand_seed.expect("an orange Exotic seed exists in the scan space");
    let sprite = render_sprite(seed, FrogState::Idle);

    // Legacy launchers (and anything reading the bitmap directly):
    // full square on the app background, frog at ~80% of the canvas.
    // Adaptive foreground: transparent, frog at 50% of the 108dp
    // canvas — the drawn content (≈80% of the 16×16 square) then fits
    // inside the 66dp circular safe zone with margin.
    let densities = [
        ("mdpi", 48usize, 108usize),
        ("hdpi", 72, 162),
        ("xhdpi", 96, 216),
        ("xxhdpi", 144, 324),
        ("xxxhdpi", 192, 432),
    ];
    for (d, launcher_px, foreground_px) in densities {
        let dir = format!("{res_dir}/mipmap-{d}");
        std::fs::create_dir_all(&dir).expect("create mipmap dir");
        write_png(
            &format!("{dir}/ic_launcher.png"),
            launcher_px,
            launcher_px,
            &compose(launcher_px, Some(BG), &sprite, 0.80),
        )
        .expect("write legacy icon");
        write_png(
            &format!("{dir}/ic_launcher_round.png"),
            launcher_px,
            launcher_px,
            &compose(launcher_px, Some(BG), &sprite, 0.80),
        )
        .expect("write legacy round icon");
        write_png(
            &format!("{dir}/ic_launcher_foreground.png"),
            foreground_px,
            foreground_px,
            &compose(foreground_px, None, &sprite, 0.50),
        )
        .expect("write adaptive foreground");
        println!("mipmap-{d}: {launcher_px}px legacy + {foreground_px}px foreground");
    }

    write_png(&logo_path, 512, 512, &compose(512, None, &sprite, 0.80)).expect("write 512px logo");
    println!("logo: {logo_path} (512px, transparent)");
}

/// Compose a `size`×`size` RGBA canvas: optional background fill, the
/// 16×16 sprite nearest-neighbor upscaled to `frac` of the canvas
/// (integer pixel scale, centered).
fn compose(size: usize, bg: Option<[u8; 4]>, sprite: &Sprite, frac: f64) -> Vec<u8> {
    let scale = ((size as f64 * frac) / 16.0).floor().max(1.0) as usize;
    let frog = 16 * scale;
    let off = (size - frog) / 2;
    let mut canvas = vec![0u8; size * size * 4];
    if let Some(bg) = bg {
        for px in canvas.as_chunks_mut::<4>().0 {
            px.copy_from_slice(&bg);
        }
    }
    for y in 0..frog {
        for x in 0..frog {
            let c = sprite.px(x / scale, y / scale);
            if c[3] == 0 {
                continue;
            }
            let i = ((off + y) * size + (off + x)) * 4;
            canvas[i..i + 4].copy_from_slice(&c);
        }
    }
    canvas
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (RGBA8, filter 0, stored-deflate zlib)
// ---------------------------------------------------------------------------

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (n, slot) in table.iter_mut().enumerate() {
        let mut c = n as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
        *slot = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for chunk in data.chunks(5552) {
        for &byte in chunk {
            a += byte as u32;
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    (b << 16) | a
}

fn chunk(tag: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(12 + data.len());
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let mut body = Vec::with_capacity(4 + data.len());
    body.extend_from_slice(tag);
    body.extend_from_slice(data);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
    out
}

/// zlib stream with stored (uncompressed) deflate blocks — valid for
/// any payload, no compressor needed.
fn zlib_stored(raw: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    let mut blocks = raw.chunks(65535).peekable();
    if raw.is_empty() {
        out.extend_from_slice(&[0x01, 0, 0, 0xFF, 0xFF]);
    }
    while let Some(data) = blocks.next() {
        let last = blocks.peek().is_none();
        out.push(u8::from(last));
        let len = data.len() as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(data);
    }
    out.extend_from_slice(&adler32(raw).to_be_bytes());
    out
}

fn write_png(path: &str, w: usize, h: usize, rgba: &[u8]) -> std::io::Result<()> {
    // Filter byte 0 per row.
    let stride = w * 4;
    let mut raw = Vec::with_capacity(h * (stride + 1));
    for row in 0..h {
        raw.push(0);
        raw.extend_from_slice(&rgba[row * stride..(row + 1) * stride]);
    }
    let mut ihdr = Vec::with_capacity(13);
    ihdr.extend_from_slice(&(w as u32).to_be_bytes());
    ihdr.extend_from_slice(&(h as u32).to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA, no filter/interlace

    let mut png = Vec::new();
    png.extend_from_slice(&[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n']);
    png.extend_from_slice(&chunk(b"IHDR", &ihdr));
    png.extend_from_slice(&chunk(b"IDAT", &zlib_stored(&raw)));
    png.extend_from_slice(&chunk(b"IEND", &[]));
    std::fs::write(path, png)
}
