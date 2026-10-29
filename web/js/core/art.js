// FROGGER-ART v1 — deterministic 16×16 frog sprites from a 4-byte seed.
// Bit-exact port of rust/crates/hopper-core/src/art.rs (itself a port of
// the frozen Python reference). Any drift breaks the mint body digest,
// which is consensus-visible.

import { sha256, u32le } from './hex.js';

export const SPRITE_W = 16;
export const SPRITE_H = 16;
const MASK64 = (1n << 64n) - 1n;

class SplitMix64 {
  constructor(seed) {
    this.state = BigInt.asUintN(64, BigInt(seed));
  }
  next() {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  }
  nextF() {
    return Number(this.next()) / 18446744073709551616;
  }
  weightedIndex(weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    const roll = Number(this.next() % BigInt(total));
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i];
      if (roll < acc) return i;
    }
    return weights.length - 1;
  }
}

const pyInt = (x) => Math.trunc(x);
const pyMod = (a, m) => ((a % m) + m) % m;
const fModPy = (a, m) => {
  const r = a % m;
  return r < 0 ? r + m : r;
};

export const RARITY = ['common', 'uncommon', 'exotic', 'golden'];
export const PATTERN = ['none', 'spots', 'stripes', 'diamond'];
export const EYES = ['normal', 'wide', 'sleepy', 'laser'];
export const MOUTH = ['smile', 'flat', 'ooh', 'tongue'];

export function deriveTraits(seed) {
  const digest = sha256(u32le(seed));
  let h = 0n;
  for (let i = 0; i < 8; i++) h = (h << 8n) | BigInt(digest[i]);
  const rng = new SplitMix64(h);

  const rarity = rng.weightedIndex([880, 100, 18, 2]);
  let hue;
  let sat;
  let val;
  if (rarity === 3) {
    [hue, sat, val] = [48.0, 0.95, 0.85];
  } else if (rarity === 2) {
    hue = Number(rng.next() % 360n);
    sat = 0.70;
    val = 0.75;
  } else {
    hue = 95.0 + Math.trunc(rng.nextF() * 45.0);
    sat = 0.55 + rng.nextF() * 0.35;
    val = 0.55 + rng.nextF() * 0.25;
  }

  const pattern = rng.weightedIndex([30, 40, 25, 5]);
  const eyes = rng.weightedIndex([55, 25, 15, 5]);
  const mouth = Number(rng.next() % 4n);
  const chonk = Number(rng.next() % 3n);
  const legs = Number(rng.next() % 3n);

  return { rarity, hue, sat, val, pattern, eyes, mouth, chonk, legs };
}

function hsvToRgb(h, s, v) {
  if (s === 0) return [v, v, v];
  const i = pyInt(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (pyMod(i, 6)) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

export function palette(t) {
  const { hue: h, sat: s, val: v } = t;
  const hsv = (hh, ss, vv) => {
    const [r, g, b] = hsvToRgb(fModPy(hh, 360) / 360, Math.min(1, Math.max(0, ss)), Math.min(1, Math.max(0, vv)));
    return [Math.trunc(r * 255), Math.trunc(g * 255), Math.trunc(b * 255), 255];
  };
  return {
    body: hsv(h, s, v),
    shade: hsv(h - 8, s + 0.10, v * 0.62),
    dark: hsv(h - 12, s + 0.15, v * 0.45),
    belly: hsv(h + 20, s * 0.45, Math.min(1, v * 1.35)),
    eye_w: [245, 245, 240, 255],
    eye_b: [20, 16, 24, 255],
    laser: [255, 60, 60, 255],
    tongue: [255, 105, 140, 255],
  };
}

export class Sprite {
  constructor() { this.data = new Uint8Array(SPRITE_W * SPRITE_H * 4); }
  px(x, y) {
    const i = (y * SPRITE_W + x) * 4;
    return this.data.slice(i, i + 4);
  }
  set(x, y, c) {
    const i = (y * SPRITE_W + x) * 4;
    this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = c[3];
  }
  setWrap(x, y, c) { this.set(pyMod(x, SPRITE_W), pyMod(y, SPRITE_H), c); }
  equals(color, c) {
    return color[0] === c[0] && color[1] === c[1] && color[2] === c[2] && color[3] === c[3];
  }
}

export function renderSprite(seed, state = 'idle') {
  const t = deriveTraits(seed);
  const rng = new SplitMix64(BigInt(seed) ^ 0xa5a5a5a5a5a5a5a5n);
  const pal = palette(t);
  const s = new Sprite();

  const chonk = t.chonk;
  const rx = 4.6 + chonk * 0.5;
  const ry = 4.2 + chonk * 0.35;
  const cx = 7.5;
  const cy = 8.6;
  const dead = state === 'dead';
  const bodyColor = dead ? pal.shade : pal.body;
  const outline = !dead ? pal.shade : pal.dark;

  // haunches
  const hx = cx + rx - 0.4;
  const hy = cy + ry - 1.6;
  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      const d = ((x - (15.0 - hx)) / 2.3) ** 2 + ((y - (hy - 1.0)) / 2.6) ** 2;
      const d2 = ((x - hx) / 2.3) ** 2 + ((y - (hy - 1.0)) / 2.6) ** 2;
      if (d <= 1.0 || d2 <= 1.0) s.set(x, y, outline);
    }
  }

  const fy = pyInt(hy + 1.0);
  for (const dx of [-1, 0, 1]) {
    const first = pyInt(hx) + dx + 3;
    if (first >= 0 && first < SPRITE_W) {
      s.set(first, fy, pal.shade);
      const second = pyInt(15.0 - hx) - dx - 3;
      s.setWrap(second, fy, pal.shade);
    }
  }

  const legY = pyInt(cy - 1.0);
  for (const off of [-1, 0, 1]) {
    const spread = t.legs === 2 ? 1 : 0;
    const lx = pyInt(cx - rx) - spread;
    const rxp = pyInt(cx + rx) + spread;
    const by = legY + pyMod(off, 2);
    for (const bx of [lx + off - 1, rxp - off + 1]) {
      if (bx >= 0 && bx < SPRITE_W && by >= 0 && by < SPRITE_H) s.set(bx, by, pal.shade);
    }
  }

  for (let y = 0; y < SPRITE_H; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d <= 1.0) s.set(x, y, bodyColor);
      else if (d <= 1.22) s.set(x, y, outline);
    }
  }

  const bellyY0 = pyInt(cy + ry * 0.15);
  const bellyY1 = pyInt(cy + ry) + 1;
  for (let y = bellyY0; y < bellyY1; y++) {
    for (let x = 0; x < SPRITE_W; x++) {
      const d = ((x - cx) / (rx * 0.62)) ** 2 + ((y - cy - 1.2) / (ry * 0.55)) ** 2;
      if (d <= 1.0 && y < SPRITE_H && s.equals(s.px(x, y), bodyColor)) {
        s.set(x, y, !dead ? pal.belly : pal.shade);
      }
    }
  }

  if (t.pattern !== 0 && !dead) {
    if (t.pattern === 2) { // stripes
      for (let x = 0; x < SPRITE_W; x++) {
        if (pyMod(pyInt(x - cx), 3) === 0) {
          for (let y = 0; y < SPRITE_H; y++) {
            const d = ((x - cx) / (rx * 0.85)) ** 2 + ((y - (cy - 0.8)) / (ry * 0.7)) ** 2;
            const c = s.px(x, y);
            if (d <= 1.0 && (s.equals(c, bodyColor) || s.equals(c, pal.belly))) s.set(x, y, pal.dark);
          }
        }
      }
    } else if (t.pattern === 1) { // spots
      for (let k = 0; k < 5; k++) {
        const sx = Number(rng.next() % 16n);
        const sy = Number(rng.next() % 16n);
        const sz = 1 + Number(rng.next() % 2n);
        for (let yy = sy; yy < Math.min(SPRITE_H, sy + sz); yy++) {
          for (let xx = sx; xx < Math.min(SPRITE_W, sx + sz); xx++) {
            const d = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2;
            if (d <= 0.8 && s.equals(s.px(xx, yy), bodyColor)) s.set(xx, yy, pal.dark);
          }
        }
      }
    } else { // diamond
      for (let y = 0; y < SPRITE_H; y++) {
        for (let x = 0; x < SPRITE_W; x++) {
          const d = ((x - cx) / rx) ** 2 + ((y - (cy - 0.9)) / (ry * 0.75)) ** 2;
          if (d <= 0.9 && s.equals(s.px(x, y), bodyColor)) {
            const v = Math.abs(x - pyInt(cx)) + Math.abs(y - pyInt(cy) - 1);
            if (v === 2 || v === 3) s.set(x, y, pal.dark);
          }
        }
      }
    }
  }

  const eyeR = t.eyes === 1 ? 2.1 : t.eyes === 2 ? 1.4 : 1.6;
  const ey = 4;
  for (const ecx of [cx - rx * 0.55, cx + rx * 0.55]) {
    for (let y = 0; y < SPRITE_H; y++) {
      for (let x = 0; x < SPRITE_W; x++) {
        if (dead) {
          if (Math.abs(x - ecx) + Math.abs(y - ey) === 1.0) s.set(x, y, pal.eye_b);
          continue;
        }
        const d = ((x - ecx) / eyeR) ** 2 + ((y - ey) / eyeR) ** 2;
        if (d <= 1.0) s.set(x, y, pal.eye_w);
        if (d <= 0.30) s.set(x, y, pal.eye_b);
        if (t.eyes === 2 && y === ey - 1 && d <= 1.1) s.set(x, y, pal.shade);
        if (t.eyes === 3 && d <= 0.14) s.set(x, y, pal.laser);
      }
    }
  }

  const my = pyInt(cy + ry * 0.15) + 1;
  if (dead) {
    for (let x = 6; x < 10; x++) s.set(x, my, pal.eye_b);
  } else if (t.mouth === 0) {
    s.set(6, my - 1, pal.eye_b); s.set(7, my, pal.eye_b);
    s.set(8, my, pal.eye_b); s.set(9, my - 1, pal.eye_b);
  } else if (t.mouth === 1) {
    for (let x = 6; x < 10; x++) s.set(x, my - 1, pal.eye_b);
  } else if (t.mouth === 2) {
    s.set(7, my - 1, pal.eye_b); s.set(8, my - 1, pal.eye_b);
  } else {
    s.set(7, my, pal.tongue); s.set(8, my, pal.tongue); s.set(8, my + 1, pal.tongue);
  }

  if (state === 'home') {
    const crown = pal.eye_w;
    for (const x of [5, 7, 9]) s.set(x, 0, crown);
    s.set(6, 1, crown); s.set(8, 1, crown); s.set(5, 1, crown); s.set(9, 1, crown);
    s.set(7, 0, [255, 200, 60, 255]);
  }
  if (state === 'crossing') {
    for (const y of [6, 9]) {
      s.set(0, y, [255, 255, 255, 120]);
      s.set(1, y, [255, 255, 255, 80]);
    }
  }
  if (state === 'dead') s.set(3, 1, [220, 220, 255, 160]);

  return s;
}
