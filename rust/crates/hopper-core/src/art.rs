//! FROGGER-ART v1: deterministic 16×16 frog sprites from a 4-byte seed.
//!
//! This is a **bit-exact port** of the frozen Python reference
//! (`reference/artgen.py`). Python semantics that affect output are
//! replicated deliberately and documented inline:
//!
//! * `int()` truncates toward zero (not floor) — see [`py_int`].
//! * Python `%` on negatives returns a non-negative result — see [`pymod`]
//!   and [`fmod_py`].
//! * PIL pixel access wraps negative indices (`px[-1, y]` == `px[15, y]`)
//!   — see [`set_wrap`].
//!
//! Any behavior change here breaks golden-vector conformance
//! (`tests/golden.rs`); the frozen reference is the contract.

use crate::rng::SplitMix64;
use crate::sprite::{Sprite, SPRITE_H, SPRITE_W};
use sha2::{Digest, Sha256};

// ---------------------------------------------------------------------------
// Python semantics helpers
// ---------------------------------------------------------------------------

/// Python `int(x)`: truncation toward zero.
#[inline]
fn py_int(x: f64) -> i64 {
    x.trunc() as i64
}

/// Python `a % m` for integers: result takes the sign of `m` (non-negative).
#[inline]
fn pymod(a: i64, m: i64) -> i64 {
    ((a % m) + m) % m
}

/// Python `a % m` for floats: non-negative result.
#[inline]
fn fmod_py(a: f64, m: f64) -> f64 {
    let r = a % m;
    if r < 0.0 {
        r + m
    } else {
        r
    }
}

/// PIL-style pixel write with Python negative-index wrapping.
#[inline]
fn set_wrap(s: &mut Sprite, x: i64, y: i64, c: [u8; 4]) {
    let x = pymod(x, SPRITE_W as i64) as usize;
    let y = pymod(y, SPRITE_H as i64) as usize;
    s.set(x, y, c);
}

// ---------------------------------------------------------------------------
// Traits
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rarity {
    Common,
    Uncommon,
    Exotic,
    Golden,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pattern {
    None,
    Spots,
    Stripes,
    Diamond,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Eyes {
    Normal,
    Wide,
    Sleepy,
    Laser,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mouth {
    Smile,
    Flat,
    Ooh,
    Tongue,
}

/// Frog visual identity derived from the 4-byte mint seed (SPEC §5.3).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Traits {
    pub rarity: Rarity,
    pub hue: f64,
    pub sat: f64,
    pub val: f64,
    pub pattern: Pattern,
    pub eyes: Eyes,
    pub mouth: Mouth,
    /// 0 = slim, 1 = normal, 2 = chonky.
    pub chonk: u8,
    /// 0..2 leg spread.
    pub legs: u8,
}

/// Derive traits from a mint seed. Matches `artgen.derive_traits` exactly,
/// including RNG call order (rarity → hue → pattern → eyes → mouth →
/// chonk → legs).
pub fn derive_traits(seed: u32) -> Traits {
    // Trait stream: first 8 bytes of SHA256(LE32(seed)), big-endian.
    let digest = Sha256::digest(seed.to_le_bytes());
    let mut h_bytes = [0u8; 8];
    h_bytes.copy_from_slice(&digest[..8]);
    let mut rng = SplitMix64::new(u64::from_be_bytes(h_bytes));

    let rarity = match rng.weighted_index(&[880, 100, 18, 2]) {
        0 => Rarity::Common,
        1 => Rarity::Uncommon,
        2 => Rarity::Exotic,
        _ => Rarity::Golden,
    };

    let (hue, sat, val) = match rarity {
        Rarity::Golden => (48.0, 0.95, 0.85),
        Rarity::Exotic => ((rng.next_u64() % 360) as f64, 0.70, 0.75),
        _ => (
            95.0 + (rng.next_f() * 45.0).trunc(),
            0.55 + rng.next_f() * 0.35,
            0.55 + rng.next_f() * 0.25,
        ),
    };

    let pattern = match rng.weighted_index(&[30, 40, 25, 5]) {
        0 => Pattern::None,
        1 => Pattern::Spots,
        2 => Pattern::Stripes,
        _ => Pattern::Diamond,
    };
    let eyes = match rng.weighted_index(&[55, 25, 15, 5]) {
        0 => Eyes::Normal,
        1 => Eyes::Wide,
        2 => Eyes::Sleepy,
        _ => Eyes::Laser,
    };
    let mouth = match rng.next_u64() % 4 {
        0 => Mouth::Smile,
        1 => Mouth::Flat,
        2 => Mouth::Ooh,
        _ => Mouth::Tongue,
    };
    let chonk = (rng.next_u64() % 3) as u8;
    let legs = (rng.next_u64() % 3) as u8;

    Traits {
        rarity,
        hue,
        sat,
        val,
        pattern,
        eyes,
        mouth,
        chonk,
        legs,
    }
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/// HSV→RGB, a faithful port of CPython's `colorsys.hsv_to_rgb`.
/// Inputs/outputs in [0, 1]. h must be pre-wrapped to [0, 1).
fn hsv_to_rgb(h: f64, s: f64, v: f64) -> (f64, f64, f64) {
    if s == 0.0 {
        return (v, v, v);
    }
    let i = py_int(h * 6.0);
    let f = (h * 6.0) - i as f64;
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * f);
    let t = v * (1.0 - s * (1.0 - f));
    match pymod(i, 6) {
        0 => (v, t, p),
        1 => (q, v, p),
        2 => (p, v, t),
        3 => (p, q, v),
        4 => (t, p, v),
        _ => (v, p, q),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Palette {
    pub body: [u8; 4],
    pub shade: [u8; 4],
    pub dark: [u8; 4],
    pub belly: [u8; 4],
    pub eye_w: [u8; 4],
    pub eye_b: [u8; 4],
    pub laser: [u8; 4],
    pub tongue: [u8; 4],
}

/// Derive the sprite palette from traits. Matches `artgen.palette` exactly.
pub fn palette(t: &Traits) -> Palette {
    let (h, s, v) = (t.hue, t.sat, t.val);
    let hsv = |hh: f64, ss: f64, vv: f64| -> [u8; 4] {
        let hh = fmod_py(hh, 360.0);
        let ss = ss.clamp(0.0, 1.0);
        let vv = vv.clamp(0.0, 1.0);
        let (r, g, b) = hsv_to_rgb(hh / 360.0, ss, vv);
        [(r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8, 255]
    };
    Palette {
        body: hsv(h, s, v),
        shade: hsv(h - 8.0, s + 0.10, v * 0.62),
        dark: hsv(h - 12.0, s + 0.15, v * 0.45),
        belly: hsv(h + 20.0, s * 0.45, (v * 1.35).min(1.0)),
        eye_w: [245, 245, 240, 255],
        eye_b: [20, 16, 24, 255],
        laser: [255, 60, 60, 255],
        tongue: [255, 105, 140, 255],
    }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

/// Rendered game state overlay (SPEC §5.4 — state overlays are derived from
/// indexer state, never stored on chain).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrogState {
    Idle,
    Crossing,
    Home,
    Dead,
}

/// Render the 16×16 sprite for `(seed, state)`.
///
/// Bit-exact port of `artgen.render_sprite`. Drawing order (load-bearing):
/// haunches → feet → front legs → body → belly → pattern → eyes → mouth →
/// state accessories. Later draws overwrite earlier ones, exactly as PIL
/// pixel assignment does.
pub fn render_sprite(seed: u32, state: FrogState) -> Sprite {
    let t = derive_traits(seed);
    // Pattern-placement stream (separate from the trait stream).
    let mut rng = SplitMix64::new((seed as u64) ^ 0xA5A5_A5A5_A5A5_A5A5);
    let pal = palette(&t);

    let mut s = Sprite::transparent();

    let chonk = t.chonk as f64;
    let rx = 4.6 + chonk * 0.5;
    let ry = 4.2 + chonk * 0.35;
    let (cx, cy) = (7.5f64, 8.6f64);
    let dead = state == FrogState::Dead;
    let body_color = if dead { pal.shade } else { pal.body };
    let outline = if !dead { pal.shade } else { pal.dark };

    // ----- back legs (haunches) ------------------------------------------
    let hx = cx + rx - 0.4;
    let hy = cy + ry - 1.6;
    for y in 0..SPRITE_H as i64 {
        for x in 0..SPRITE_W as i64 {
            let d =
                ((x as f64 - (15.0 - hx)) / 2.3).powi(2) + ((y as f64 - (hy - 1.0)) / 2.6).powi(2);
            let d2 = ((x as f64 - hx) / 2.3).powi(2) + ((y as f64 - (hy - 1.0)) / 2.6).powi(2);
            if d <= 1.0 || d2 <= 1.0 {
                s.set(x as usize, y as usize, outline);
            }
        }
    }

    // feet (PIL negative-index wrap applies to the mirrored foot)
    let fy = py_int(hy + 1.0);
    for dx in [-1i64, 0, 1] {
        let first = py_int(hx) + dx + 3;
        if 0 <= first && first < SPRITE_W as i64 {
            s.set(first as usize, fy as usize, pal.shade);
            let second = py_int(15.0 - hx) - dx - 3;
            set_wrap(&mut s, second, fy, pal.shade);
        }
    }

    // ----- front legs ------------------------------------------------------
    let leg_y = py_int(cy - 1.0);
    for off in [-1i64, 0, 1] {
        let spread = if t.legs == 2 { 1i64 } else { 0 };
        let lx = py_int(cx - rx) - spread;
        let rxp = py_int(cx + rx) + spread;
        // Python: leg_y + off % 2 (Python modulo — off=-1 gives +1)
        let by = leg_y + pymod(off, 2);
        for bx in [lx + off - 1, rxp - off + 1] {
            if 0 <= bx && bx < SPRITE_W as i64 && 0 <= by && by < SPRITE_H as i64 {
                s.set(bx as usize, by as usize, pal.shade);
            }
        }
    }

    // ----- body ------------------------------------------------------------
    for y in 0..SPRITE_H as i64 {
        for x in 0..SPRITE_W as i64 {
            let d = ((x as f64 - cx) / rx).powi(2) + ((y as f64 - cy) / ry).powi(2);
            if d <= 1.0 {
                s.set(x as usize, y as usize, body_color);
            } else if d <= 1.22 {
                s.set(x as usize, y as usize, outline);
            }
        }
    }

    // ----- belly patch -----------------------------------------------------
    let belly_y0 = py_int(cy + ry * 0.15);
    let belly_y1 = py_int(cy + ry) + 1;
    for y in belly_y0..belly_y1 {
        for x in 0..SPRITE_W as i64 {
            let d = ((x as f64 - cx) / (rx * 0.62)).powi(2)
                + ((y as f64 - cy - 1.2) / (ry * 0.55)).powi(2);
            if d <= 1.0 && y < SPRITE_H as i64 && s.px(x as usize, y as usize) == body_color {
                let c = if !dead { pal.belly } else { pal.shade };
                s.set(x as usize, y as usize, c);
            }
        }
    }

    // ----- back pattern -----------------------------------------------------
    if t.pattern != Pattern::None && !dead {
        match t.pattern {
            Pattern::None => unreachable!(),
            Pattern::Stripes => {
                for x in 0..SPRITE_W as i64 {
                    if pymod(py_int(x as f64 - cx), 3) == 0 {
                        for y in 0..SPRITE_H as i64 {
                            let d = ((x as f64 - cx) / (rx * 0.85)).powi(2)
                                + ((y as f64 - (cy - 0.8)) / (ry * 0.7)).powi(2);
                            let c = s.px(x as usize, y as usize);
                            if d <= 1.0 && (c == body_color || c == pal.belly) {
                                s.set(x as usize, y as usize, pal.dark);
                            }
                        }
                    }
                }
            }
            Pattern::Spots => {
                for _ in 0..5 {
                    let sx = (rng.next_u64() % SPRITE_W as u64) as i64;
                    let sy = (rng.next_u64() % SPRITE_H as u64) as i64;
                    let sz = 1 + (rng.next_u64() % 2) as i64;
                    for yy in sy..(SPRITE_H as i64).min(sy + sz) {
                        for xx in sx..(SPRITE_W as i64).min(sx + sz) {
                            let d =
                                ((xx as f64 - cx) / rx).powi(2) + ((yy as f64 - cy) / ry).powi(2);
                            if d <= 0.8 && s.px(xx as usize, yy as usize) == body_color {
                                s.set(xx as usize, yy as usize, pal.dark);
                            }
                        }
                    }
                }
            }
            Pattern::Diamond => {
                for y in 0..SPRITE_H as i64 {
                    for x in 0..SPRITE_W as i64 {
                        let d = ((x as f64 - cx) / rx).powi(2)
                            + ((y as f64 - (cy - 0.9)) / (ry * 0.75)).powi(2);
                        if d <= 0.9 && s.px(x as usize, y as usize) == body_color {
                            let v = (x - py_int(cx)).abs() + (y - py_int(cy) - 1).abs();
                            if v == 2 || v == 3 {
                                s.set(x as usize, y as usize, pal.dark);
                            }
                        }
                    }
                }
            }
        }
    }

    // ----- eyes ---------------------------------------------------------------
    let eye_r = match t.eyes {
        Eyes::Wide => 2.1,
        Eyes::Sleepy => 1.4,
        _ => 1.6,
    };
    let ey = 4i64;
    for ecx in [cx - rx * 0.55, cx + rx * 0.55] {
        for y in 0..SPRITE_H as i64 {
            for x in 0..SPRITE_W as i64 {
                if dead {
                    // X eyes: |x-ecx| + |y-ey| == 1 (f64 comparison — the
                    // frozen reference's exact behavior, quirk included).
                    if (x as f64 - ecx).abs() + (y as f64 - ey as f64).abs() == 1.0 {
                        s.set(x as usize, y as usize, pal.eye_b);
                    }
                    continue;
                }
                let d =
                    ((x as f64 - ecx) / eye_r).powi(2) + ((y as f64 - ey as f64) / eye_r).powi(2);
                if d <= 1.0 {
                    s.set(x as usize, y as usize, pal.eye_w);
                }
                if d <= 0.30 {
                    s.set(x as usize, y as usize, pal.eye_b);
                }
                if t.eyes == Eyes::Sleepy && y == ey - 1 && d <= 1.1 {
                    s.set(x as usize, y as usize, pal.shade);
                }
                if t.eyes == Eyes::Laser && d <= 0.14 {
                    s.set(x as usize, y as usize, pal.laser);
                }
            }
        }
    }

    // ----- mouth ---------------------------------------------------------------
    let my = (py_int(cy + ry * 0.15) + 1) as usize;
    if dead {
        for x in 6..10 {
            s.set(x, my, pal.eye_b);
        }
    } else {
        match t.mouth {
            Mouth::Smile => {
                s.set(6, my - 1, pal.eye_b);
                s.set(7, my, pal.eye_b);
                s.set(8, my, pal.eye_b);
                s.set(9, my - 1, pal.eye_b);
            }
            Mouth::Flat => {
                for x in 6..10 {
                    s.set(x, my - 1, pal.eye_b);
                }
            }
            Mouth::Ooh => {
                s.set(7, my - 1, pal.eye_b);
                s.set(8, my - 1, pal.eye_b);
            }
            Mouth::Tongue => {
                s.set(7, my, pal.tongue);
                s.set(8, my, pal.tongue);
                s.set(8, my + 1, pal.tongue);
            }
        }
    }

    // ----- state accessories -----------------------------------------------------
    if state == FrogState::Home {
        let crown = pal.eye_w;
        for cxx in [5usize, 7, 9] {
            s.set(cxx, 0, crown);
        }
        s.set(6, 1, crown);
        s.set(8, 1, crown);
        s.set(5, 1, crown);
        s.set(9, 1, crown);
        s.set(7, 0, [255, 200, 60, 255]);
    }
    if state == FrogState::Crossing {
        for yy in [6usize, 9] {
            s.set(0, yy, [255, 255, 255, 120]);
            s.set(1, yy, [255, 255, 255, 80]);
        }
    }
    if state == FrogState::Dead {
        s.set(3, 1, [220, 220, 255, 160]);
    }

    s
}
