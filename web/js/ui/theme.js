// THEME — a JavaScript port of frogger-wallet-gui/src/theme.rs.
//
// Every structural material of the FROGGER GUI is reproduced here with the
// same geometry as the egui original:
//
//   * wood "log" frames around every button (bark slabs, grain, knots and
//     cut ends with growth rings),
//   * lily-pad borders around every floating window (5x5 pads with a bite,
//     a shaded rim and the odd pink flower),
//   * pond water with ripple dashes, water lilies with the classic notch,
//   * asphalt with lane dashes, a pixel grave marker,
//   * the 8-bit tadpole / squished frog / top-down arcade car,
//   * the install icon's frog mark, drawn in road yellow,
//   * a tiny top-down pond glyph for THE POND in the drawer.
//
// The egui app paints these with `Painter`; here they are painted into
// <canvas> elements that are mounted behind the DOM after each render. The
// DOM carries the text and the events, the canvas carries the material, so
// the result reads like the egui frame while staying selectable and
// accessible.

import { renderSprite } from '../core/art.js';
import { paintQR } from './qr.js';
import { frogMarkSvg as pixelFrogMark } from './frog-mark.js';

// ---------------------------------------------------------------------------
// Palette — exact RGB values from theme.rs.
// ---------------------------------------------------------------------------

export const C = {
  bg: '#18241a',
  card: '#223226',
  accent: '#f0c83c',
  dead: '#963c3c',
  car: '#c63e30',
  home: '#e6b428',
  text: '#e6f0e6',
  textDim: '#96a596',
  bark: '#4e351e',
  barkDark: '#2e1e11',
  wood: '#7e5a32',
  ring: '#a87a44',
  pad: '#428a4c',
  padDark: '#24522c',
  padLight: '#68b270',
  flower: '#e896bc',
  water: '#0e2834',
  waterRipple: '#284e5c',
  lilyPad: '#3e7c42',
  lilyRim: '#24522a',
  lilyFlower: '#eab0ca',
  lilyCore: '#f0d25a',
  road: '#1a1a1e',
  graveStone: '#9698a2',
  graveEngraving: '#4a4c54',
  txIn: '#5abe6e',
};

export const RARITY_NAMES = ['Common', 'Uncommon', 'Exotic', 'Golden'];

export function rarityColor(rarity) {
  switch (String(rarity).toLowerCase()) {
    case 'uncommon': return '#5abe6e';
    case 'exotic': return '#b46edc';
    case 'golden': return '#ebbe3c';
    default: return '#8ca08c';
  }
}

/** `gamma_multiply` from egui: scale RGB towards black. */
export function dim(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * factor);
  const g = Math.round(((n >> 8) & 255) * factor);
  const b = Math.round((n & 255) * factor);
  return `rgb(${r},${g},${b})`;
}

/** The livery of a button's semantic rule. */
export function edgeOf(edge) {
  switch (String(edge || '').toLowerCase()) {
    case 'accent': return C.accent;
    case 'home': return C.home;
    case 'dead':
    case 'danger': return C.dead;
    case 'text': return C.text;
    default: return C.textDim;
  }
}

// ---------------------------------------------------------------------------
// Canvas primitives
// ---------------------------------------------------------------------------

function fill(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function line(ctx, x1, y1, x2, y2, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function circle(ctx, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** theme.rs::paint_log_frame — bark slabs, grain, knots and cut ends. */
export function paintLogFrame(ctx, w, h, edge) {
  const t = 5;
  if (w <= t * 2 + 2 || h <= t * 2 + 2) {
    ctx.strokeStyle = C.bark;
    ctx.lineWidth = t;
    ctx.strokeRect(t / 2, t / 2, w - t, h - t);
    return;
  }
  const x0 = 0.5;
  const y0 = 0.5;
  const rw = w - 1;
  const rh = h - 1;

  for (const [y, bottom] of [[y0, false], [y0 + rh - t, true]]) {
    fill(ctx, x0, y, rw, t, C.bark);
    fill(ctx, x0, bottom ? y + t - 1 : y, rw, 1, C.barkDark);
    // Grain: two dashed lines, offset between the slabs.
    for (let g = 0; g < 2; g += 1) {
      const gy = y + 1.4 + g * 1.9;
      let x = x0 + (bottom ? 2 : 5) + g * 3;
      while (x + 5 < x0 + rw - 2) {
        fill(ctx, x, gy, 5, 1, C.wood);
        x += 11;
      }
    }
    // Knots: a 3x1 ring with a dark core every 23 pt.
    let x = x0 + 12;
    while (x + 3 < x0 + rw - 12) {
      fill(ctx, x, y + 1.6, 3, 2, C.ring);
      fill(ctx, x + 1, y + 2.1, 1, 1, C.barkDark);
      x += 23;
    }
  }

  // Left and right: the cut face of the log.
  for (const [x, right] of [[x0, false], [x0 + rw - t, true]]) {
    const top = y0 + t;
    const bh = Math.max(0, rh - t * 2);
    fill(ctx, x, top, t, bh, C.bark);
    fill(ctx, right ? x + t - 1 : x, top, 1, bh, C.barkDark);
    for (let ring = 0; ring < 2; ring += 1) {
      const rx = x + 1.4 + ring * 1.8;
      fill(ctx, rx, top + 2, 1, Math.max(0, bh - 4), ring === 0 ? C.ring : C.wood);
    }
    fill(ctx, x + t * 0.5 - 1, top + bh * 0.5 - 1, 2, 2, C.barkDark);
  }

  // The semantic rule inside the wood.
  ctx.strokeStyle = dim(edge, 0.85);
  ctx.lineWidth = 1;
  ctx.strokeRect(x0 + t - 1 + 0.5, y0 + t - 1 + 0.5, rw - (t - 1) * 2 - 1, rh - (t - 1) * 2 - 1);
}

// The lily-pad pixel grid: '#' = pad, ' ' = water. The notch on the right
// is what makes it a lily pad and not a circle.
const LILY_GRID = ['..#..', '.###.', '###..', '####.', '.###.'];

export const LILY_W = 9;
export const LILY_MARGIN = 17;

function lilyPad(ctx, cx, cy, size, fillColor, flower) {
  const cell = size / 5;
  const ox = cx - size / 2;
  const oy = cy - size / 2;
  for (let r = 0; r < LILY_GRID.length; r += 1) {
    const row = LILY_GRID[r];
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] !== '#') continue;
      const rim = r === 0 || r === 4 || c === 0 || c === 4;
      fill(ctx, ox + c * cell, oy + r * cell, cell + 0.35, cell + 0.35, rim ? C.padDark : C.pad);
    }
  }
  const px = (c, r, color, inset) => {
    fill(
      ctx,
      ox + c * cell + inset * cell,
      oy + r * cell + inset * cell,
      cell * (1 - inset * 2),
      cell * (1 - inset * 2),
      color,
    );
  };
  px(1, 1, C.padLight, 0.2);
  if (flower) {
    px(2, 1, fillColor, 0.55);
    px(2, 1, C.flower, 0.3);
  }
}

/** theme.rs::lily_border — a LINE of pads around a floating window. */
export function paintLilyBorder(ctx, w, h, tint, fillColor) {
  const pad = LILY_W;
  const r = {
    left: pad / 2,
    right: w - pad / 2,
    top: pad / 2,
    bottom: h - pad / 2,
  };
  const step = pad * 1.02;
  let i = 0;
  let x = r.left + pad * 0.5;
  while (x <= r.right - pad * 0.4) {
    for (const y of [r.top, r.bottom]) lilyPad(ctx, x, y, pad, fillColor, i % 3 === 0);
    x += step;
    i += 1;
  }
  let y = r.top + pad * 1.2;
  while (y <= r.bottom - pad * 1.2) {
    for (const xx of [r.left, r.right]) lilyPad(ctx, xx, y, pad, fillColor, i % 3 === 1);
    y += step;
    i += 1;
  }
  ctx.strokeStyle = dim(tint, 0.8);
  ctx.lineWidth = 1;
  ctx.strokeRect(pad - 1 + 0.5, pad - 1 + 0.5, w - (pad - 1) * 2 - 1, h - (pad - 1) * 2 - 1);
}

/** theme.rs::draw_pond — water plus ripple dashes. */
export function paintPond(ctx, w, h) {
  fill(ctx, 0, 0, w, h, C.water);
  let y = 16;
  let row = 0;
  while (y < h - 8) {
    let x = 6 + (row % 3) * 16;
    const dash = 12 + (row % 2) * 6;
    while (x < w - 24) {
      line(ctx, x, y, x + dash, y, C.waterRipple, 2);
      x += 38;
    }
    y += 26;
    row += 1;
  }
}

/** theme.rs::draw_lily — pad, rim, notch and optional blossom. */
export function paintLily(ctx, cx, cy, radius, flower) {
  ctx.strokeStyle = C.waterRipple;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 1.22, 0, Math.PI * 2);
  ctx.stroke();

  circle(ctx, cx, cy, radius, C.lilyPad);
  ctx.strokeStyle = C.lilyRim;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1, radius - 1), 0, Math.PI * 2);
  ctx.stroke();

  // The notch wedge, refilled with water.
  const angle = 0.7;
  const half = 0.24;
  const reach = radius + 2;
  ctx.fillStyle = C.water;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + reach * Math.cos(angle - half), cy + reach * Math.sin(angle - half));
  ctx.lineTo(cx + reach * Math.cos(angle + half), cy + reach * Math.sin(angle + half));
  ctx.closePath();
  ctx.fill();

  if (flower) {
    const fx = cx - radius * 0.42;
    const fy = cy - radius * 0.42;
    const pr = Math.max(2.5, radius * 0.15);
    for (const a of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
      circle(ctx, fx + pr * 1.2 * Math.cos(a), fy + pr * 1.2 * Math.sin(a), pr, C.lilyFlower);
    }
    circle(ctx, fx, fy, pr * 0.8, C.lilyCore);
  }
}

/** theme.rs::draw_road — asphalt plus the dashed lane line. */
export function paintRoad(ctx, w, h) {
  paintRoadAt(ctx, w, h, 0);
}

function paintRoadAt(ctx, w, h, offset = 0) {
  fill(ctx, 0, 0, w, h, C.road);
  const phase = ((offset % 44) + 44) % 44;
  for (let x = -44 + phase; x < w + 44; x += 44) {
    line(ctx, x + 10, h / 2, Math.min(x + 36, w), h / 2, dim(C.accent, 0.5), 3);
  }
}

export function laneDashes(ctx, left, right, y) {
  let x = left + 10;
  while (x < right) {
    line(ctx, x, y, Math.min(x + 26, right), y, dim(C.accent, 0.5), 3);
    x += 44;
  }
}

// ---------------------------------------------------------------------------
// Sprites and pixel art
// ---------------------------------------------------------------------------

const spriteCache = new Map();

function spriteCanvas(seed, state) {
  const key = `${seed >>> 0}:${state}`;
  let cv = spriteCache.get(key);
  if (cv) return cv;
  const sprite = renderSprite(seed >>> 0, state);
  cv = document.createElement('canvas');
  cv.width = 16;
  cv.height = 16;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(16, 16);
  img.data.set(sprite.data);
  ctx.putImageData(img, 0, 0);
  spriteCache.set(key, cv);
  return cv;
}

/** Paint one 16x16 sprite, nearest-neighbour, centred at (x, y). */
export function paintSprite(ctx, seed, state, cx, cy, size) {
  const src = spriteCanvas(seed, state);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, cx - size / 2, cy - size / 2, size, size);
  ctx.restore();
}

/** Deterministic -1..=1 scatter (theme/app.rs::pond_scatter). */
export function pondScatter(seed, channel) {
  let x = (BigInt(seed >>> 0) * 0x9e3779b97f4a7c15n + BigInt(channel)) & ((1n << 64n) - 1n);
  x ^= x >> 33n;
  x = (x * 0xff51afd7ed558ccdn) & ((1n << 64n) - 1n);
  x ^= x >> 33n;
  const f = Number((x >> 40n) & 0xffffffn) / 16777215;
  return f * 2 - 1;
}

/** Paint one frog sitting on its water lily (app.rs::paint_pond_frog). */
export function paintPondFrog(ctx, w, h, seed, state) {
  const side = Math.min(w, h);
  const cx = w / 2 + pondScatter(seed, 0) * side * 0.08;
  const cy = h / 2 + pondScatter(seed, 1) * side * 0.05;
  const radius = side * (0.34 + 0.05 * pondScatter(seed, 2));
  const flower = pondScatter(seed, 3) > 0.25;
  paintLily(ctx, cx, cy, radius, flower);
  // The pad stays in the same seed-scattered spot; only the frog is absent
  // while its sat is staged in a tapscript state output.
  if (state !== 'empty') paintSprite(ctx, seed, state, cx, cy - radius * 0.2, radius * 1.25);
}

/** The small, generic pond on the wallet screen. */
export function paintSendPond(ctx, w, h) {
  const r = Math.max(10, Math.min(w, h) / 2 - 4);
  const cx = w / 2;
  const cy = h / 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  paintPond(ctx, w, h);

  // Three fixed, imaginary frogs — never this wallet's actual Hoppers.
  const pads = [
    { x: cx - r * 0.38, y: cy - r * 0.34, rr: r * 0.17, seed: 0x9058d0fa, flower: false },
    { x: cx + r * 0.40, y: cy - r * 0.02, rr: r * 0.145, seed: 0x00c0ffee, flower: true },
    { x: cx - r * 0.04, y: cy + r * 0.40, rr: r * 0.18, seed: 0x12345678, flower: false },
  ];
  for (const pad of pads) {
    paintLily(ctx, pad.x, pad.y, pad.rr, pad.flower);
    paintSprite(ctx, pad.seed, 'idle', pad.x, pad.y - pad.rr * 0.3, pad.rr * 1.42);
  }
  ctx.restore();

  ctx.strokeStyle = C.bg;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = dim(C.lilyRim, 0.8);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
  ctx.stroke();
}

/**
 * Geometry for the in-flight road card. The road slides left under a frog
 * that hops right; the card is a treadmill, so the frog stays in frame.
 * `now` is milliseconds since the animation started. Pure and time-based,
 * which makes the motion testable without a canvas.
 */
export function roadFrogFrame(w, h, seed, now = 0) {
  const t = Number.isFinite(Number(now)) ? Math.max(0, Number(now)) : 0;
  const period = 1000;
  const p = (t % period) / period;
  const side = Math.min(w, h);
  const hopPhase = Math.min(1, p / 0.58);
  const hop = Math.sin(Math.PI * hopPhase);
  const landing = p >= 0.58
    ? Math.exp(-((p - 0.58) * period) / 110)
    : 0;
  return {
    period,
    p,
    side,
    cx: w * 0.45 + pondScatter(seed, 0) * side * 0.025,
    ground: h * 0.54 + pondScatter(seed, 1) * side * 0.025,
    dx: hop * side * 0.09,
    lift: hop * side * 0.11,
    hop,
    landing,
    sx: 1 + landing * 0.10 - hop * 0.02,
    sy: 1 - landing * 0.14 + hop * 0.03,
    tilt: hop * 0.08,
    size: side * 0.34,
    dash: -((t * 0.18) % 44),
  };
}

/** Paint one animated frame of a Hopper travelling right on The Road. */
export function paintRoadFrogFrame(ctx, w, h, seed, now = 0, state = 'crossing') {
  const f = roadFrogFrame(w, h, seed, now);
  paintRoadAt(ctx, w, h, f.dash);

  // Speed streaks trail the frog, moving left with the asphalt.
  for (let i = 0; i < 3; i += 1) {
    const slide = (Number(now) * 0.18 + i * 47) % Math.max(1, w * 0.55);
    const x1 = f.cx - f.size * 0.78 - slide;
    const x2 = x1 - (10 + i * 5);
    line(ctx, x2, f.ground - f.size * 0.16 + i * f.size * 0.11,
      x1, f.ground - f.size * 0.16 + i * f.size * 0.11,
      'rgba(230, 204, 124, 0.14)', 2);
  }

  // Contact shadow shrinks as the frog leaves the road.
  const shadowScale = 1 - Math.min(0.45, f.lift / (f.side * 0.24));
  ctx.save();
  ctx.fillStyle = `rgba(0, 0, 0, ${0.24 * shadowScale})`;
  ctx.beginPath();
  ctx.ellipse(f.cx + f.dx, f.ground + f.size * 0.30,
    f.size * 0.34 * shadowScale, f.size * 0.10 * shadowScale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // A small dust puff on landing, behind the rightward hop.
  if (f.p >= 0.58 && f.p < 0.88) {
    const q = (f.p - 0.58) / 0.30;
    for (let i = 0; i < 3; i += 1) {
      const alpha = (1 - q) * (0.40 - i * 0.08);
      fill(ctx, f.cx - f.size * 0.26 - i * f.size * 0.14 - q * f.size * 0.20,
        f.ground + f.size * 0.31 + (i % 2) * 3, 3, 3,
        `rgba(216, 190, 138, ${Math.max(0, alpha)})`);
    }
  }

  ctx.save();
  ctx.translate(f.cx + f.dx, f.ground - f.lift);
  ctx.rotate(f.tilt);
  ctx.scale(f.sx, f.sy);
  paintSprite(ctx, seed, state, 0, 0, f.size);
  ctx.restore();
}

/** Paint one frog on its own stretch of asphalt (app.rs::paint_road_frog). */
export function paintRoadFrog(ctx, w, h, seed, state = 'crossing') {
  paintRoadFrogFrame(ctx, w, h, seed, 0, state);
}

// --- tiny pixel grids ------------------------------------------------------

function gridMetrics(w, h, cols, rows) {
  const cell = Math.min(w / cols, h / rows);
  return [cell, (w - cell * cols) / 2, (h - cell * rows) / 2];
}

function blit(ctx, w, h, cols, rows, pixels, color) {
  const [cell, ox, oy] = gridMetrics(w, h, cols, rows);
  for (const [c, r] of pixels) fill(ctx, ox + c * cell, oy + r * cell, cell, cell, color);
  return [cell, ox, oy];
}

const TADPOLE_PIXELS = [
  [6, 3], [7, 2], [8, 2], [9, 2], [10, 3], [6, 4], [7, 3], [8, 3], [9, 3], [10, 4],
  [6, 5], [7, 4], [8, 4], [9, 4], [10, 5], [7, 5], [8, 5], [9, 5],
  [5, 3], [4, 3], [3, 4], [2, 4], [1, 5], [0, 5],
];

const SQUISHED_PIXELS = [
  [3, 4], [4, 3], [5, 3], [6, 3], [7, 3], [8, 4], [3, 5], [4, 4], [5, 4], [6, 4],
  [7, 4], [8, 5], [4, 5], [5, 5], [6, 5], [7, 5],
  [1, 3], [2, 3], [9, 3], [10, 3], [0, 5], [1, 4], [9, 4], [10, 5],
  [2, 7], [9, 7],
];

export function paintTadpole(ctx, w, h) {
  const [cell, ox, oy] = blit(ctx, w, h, 12, 8, TADPOLE_PIXELS, '#60a868');
  fill(ctx, ox + 9 * cell, oy + 3 * cell, cell * 0.6, cell * 0.6, '#000');
}

export function paintSquished(ctx, w, h) {
  const body = '#60a868';
  const [cell, ox, oy] = blit(ctx, w, h, 12, 8, SQUISHED_PIXELS, body);
  fill(ctx, ox + 4 * cell, oy + 4 * cell, cell * 0.7, cell * 0.7, '#000');
  fill(ctx, ox + 7 * cell, oy + 4 * cell, cell * 0.7, cell * 0.7, '#000');
  fill(ctx, ox + 2 * cell, oy + 7 * cell, cell * 0.7, cell * 0.7, dim(C.dead, 0.9));
  fill(ctx, ox + 9 * cell, oy + 7 * cell, cell * 0.7, cell * 0.7, dim(C.dead, 0.9));
}

const GRAVE_STONE = [
  [2, 0], [3, 0], [4, 0], [5, 0], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1],
  [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2],
  [1, 3], [2, 3], [3, 3], [4, 3], [5, 3], [6, 3],
  [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4],
  [1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5],
  [1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [6, 6],
  [1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7],
  [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [6, 8], [7, 8],
  [1, 9], [2, 9], [3, 9], [4, 9], [5, 9], [6, 9],
];

export function paintGrave(ctx, w, h) {
  const [cell, ox, oy] = blit(ctx, w, h, 8, 10, GRAVE_STONE, C.graveStone);
  for (const [c, r] of [[3, 3], [3, 4], [3, 5], [2, 4], [4, 4]]) {
    fill(ctx, ox + c * cell, oy + r * cell, cell * 0.6, cell * 0.6, C.graveEngraving);
  }
}

/**
 * The side-view car from `.scratch/hopper-vid/cutscene.mjs`, 16x8.
 *
 * `b` body, `g` glass, `k` tyre/underbody, `L` headlight, `R` tail light.
 * The cutscene paints this grid one pixel at a time; here the same map is
 * scaled into a canvas so the rules page and the film share one silhouette.
 */
export const SIDE_CAR_MAP = [
  '................',
  '....bbbbbbbb....',
  '...bggggggggb...',
  '..bbbbbbbbbbbb..',
  'RbbbbbbbbbbbbbbL',
  '.bbbbbbbbbbbbbb.',
  '..kkk......kkk..',
  '..kkk......kkk..',
];

/** Paint the cutscene's side-view car, facing right unless `mirror` is true. */
export function paintSideCar(ctx, w, h, body, mirror = false, headlight = C.accent) {
  const [cell, ox, oy] = gridMetrics(w, h, 16, 8);
  const glass = '#141a22';
  const ink = dim(C.water, 0.45);
  const tail = '#ff4632';
  for (let r = 0; r < SIDE_CAR_MAP.length; r += 1) {
    const row = SIDE_CAR_MAP[r];
    for (let c = 0; c < 16; c += 1) {
      const ch = row[mirror ? 15 - c : c];
      const color = ch === 'b' ? body : ch === 'g' ? glass : ch === 'k' ? ink
        : ch === 'L' ? headlight : ch === 'R' ? tail : null;
      if (color) fill(ctx, ox + c * cell, oy + r * cell, cell + 0.2, cell + 0.2, color);
    }
  }
}

/** theme.rs::draw_car_colored — the top-down arcade car, 16x8. */
export function paintCar(ctx, w, h, body, mirror = false, headlight = C.accent) {
  const [cell, ox, oy] = gridMetrics(w, h, 16, 8);
  const glass = '#141a22';
  const roof = dim(body, 0.7);
  const tail = '#ff4632';
  const px = (c, r, color) => {
    const cc = mirror ? 15 - c : c;
    fill(ctx, ox + cc * cell, oy + r * cell, cell * 0.95, cell * 0.95, color);
  };
  for (const r of [0, 7]) for (const c of [4, 5, 10, 11]) px(c, r, '#000');
  for (let c = 3; c <= 12; c += 1) { px(c, 1, body); px(c, 6, body); }
  for (let r = 2; r <= 5; r += 1) {
    for (let c = 1; c <= 14; c += 1) px(c, r, body);
    px(4, r, glass); px(5, r, glass);
    for (let c = 6; c <= 10; c += 1) px(c, r, roof);
    px(11, r, glass); px(12, r, glass);
  }
  for (let r = 2; r <= 5; r += 1) px(15, r, headlight);
  for (let r = 2; r <= 5; r += 1) px(0, r, tail);
}

/** theme.rs::car_body_color — one car color per frog seed. */
export function carBodyColor(seed) {
  const palette = ['#c63e30', '#e69632', '#ebc83c', '#5aaa78', '#508cc8', '#aa6ec8', '#c8c8cd', '#785a3c'];
  return palette[(seed >>> 0) % palette.length];
}

/** The install icon's frog, squared off to sit with the pixel type. */
export function frogMarkSvg(size = 24, body = C.accent, cut = C.bg) {
  return pixelFrogMark(size, body, cut);
}

// A tiny top-down pond for the drawer's THE POND item. This is a UI glyph,
// not the site favicon: bank, water, one lily pad, and its flower.
export const POND_MARK_SIZE = 14;
export const POND_MARK_ROWS = [
  '..............',
  '....bbbbbb....',
  '..bbwwwwwwbb..',
  '.bwwwhhhwwwwb.',
  'bwwwwwwwwwwwwb',
  'bwwwwwffwwwwwb',
  'bwwwwwfyppppwb',
  'bwwwpppppppwwb',
  'bwwpppppppwwwb',
  'bwwwppppppwwwb',
  'bwwwwwwwwwwwwb',
  '.bwwwwwwwwwwb.',
  '..bbwwwwwwbb..',
  '....bbbbbb....',
];
const POND_MARK_COLORS = {
  b: '#356c3a',
  w: '#3a7d89',
  h: '#8fd0d8',
  p: C.padLight,
  f: C.lilyFlower,
  y: C.lilyCore,
};

/** Inline SVG for the pond glyph used beside THE POND. */
export function pondMarkSvg(size = POND_MARK_SIZE) {
  const rects = [];
  for (let y = 0; y < POND_MARK_ROWS.length; y += 1) {
    const row = POND_MARK_ROWS[y];
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      const fill = POND_MARK_COLORS[ch];
      if (!fill) { x += 1; continue; }
      let end = x + 1;
      while (end < row.length && row[end] === ch) end += 1;
      rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${fill}"/>`);
      x = end;
    }
  }
  return `<svg class="pond-mark" width="${size}" height="${size}" viewBox="0 0 ${POND_MARK_SIZE} ${POND_MARK_SIZE}" shape-rendering="crispEdges" aria-hidden="true">${rects.join('')}</svg>`;
}

// ---------------------------------------------------------------------------
// Canvas mounting (the paint pass after every DOM render)
// ---------------------------------------------------------------------------

function fitCanvas(cv, cssW, cssH, dpr = Math.min(2, window.devicePixelRatio || 1)) {
  cv.width = Math.max(1, Math.round(cssW * dpr));
  cv.height = Math.max(1, Math.round(cssH * dpr));
  cv.style.width = `${cssW}px`;
  cv.style.height = `${cssH}px`;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return ctx;
}

function ensureChild(parent, className, tag = 'canvas') {
  let el = parent.querySelector(`:scope > .${className}`);
  if (!el) {
    el = document.createElement(tag);
    el.className = className;
    el.setAttribute('aria-hidden', 'true');
    parent.prepend(el);
  }
  return el;
}

function mountLogButton(btn) {
  const rect = btn.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return;
  const edge = edgeOf(btn.dataset.edge || 'dim');
  // The log canvas is a positioned child, so it paints above bare text
  // nodes. Wrap the label in its own stacking layer first.
  let label = btn.querySelector(':scope > .btn-label');
  if (!label) {
    label = document.createElement('span');
    label.className = 'btn-label';
    while (btn.firstChild) label.appendChild(btn.firstChild);
    btn.appendChild(label);
  }
  const cv = ensureChild(btn, 'log-art');
  const ctx = fitCanvas(cv, rect.width, rect.height);
  paintLogFrame(ctx, rect.width, rect.height, edge);
}

function mountLily(el) {
  const rect = el.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const edge = edgeOf(el.dataset.lily || 'accent');
  const fillColor = el.dataset.lilyFill || C.card;
  const cv = ensureChild(el, 'lily-canvas');
  const ctx = fitCanvas(cv, rect.width, rect.height);
  paintLilyBorder(ctx, rect.width, rect.height, edge, fillColor);
}

function mountPond(cv) {
  const [seedText, state] = (cv.dataset.pondfrog || '0:idle').split(':');
  const seed = Number(seedText) >>> 0;
  const w = 320;
  const h = Math.round(w * 0.86);
  const ctx = fitCanvas(cv, w, h, 1);
  // Responsive: the backing store is 320x275, the CSS box is the grid
  // cell. (fitCanvas's fixed style width would overflow a 320pt phone.)
  cv.style.width = '';
  cv.style.height = '';
  paintPondFrog(ctx, w, h, seed, state || 'idle');
}

function mountRoadFrog(cv) {
  if (cv._roadRaf) {
    cancelAnimationFrame(cv._roadRaf);
    cv._roadRaf = 0;
  }
  const [seedText, spriteState] = (cv.dataset.roadfrog || '0:crossing').split(':');
  const seed = Number(seedText) >>> 0;
  const state = spriteState === 'dead' ? 'dead' : 'crossing';
  const w = 320;
  const h = Math.round(w * 0.86);
  const ctx = fitCanvas(cv, w, h, 1);
  cv.style.width = '';
  cv.style.height = '';

  const reduced = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || state === 'dead') {
    cv.dataset.roadAnimated = 'false';
    paintRoadFrog(ctx, w, h, seed, state);
    return;
  }

  cv.dataset.roadAnimated = 'true';
  const started = performance.now();
  let lastPaint = -Infinity;
  const frame = (now) => {
    if (!cv.isConnected) {
      cv._roadRaf = 0;
      return;
    }
    // 30 fps is enough for a pixel road and leaves the main thread alone.
    if (now - lastPaint >= 32) {
      lastPaint = now;
      paintRoadFrogFrame(ctx, w, h, seed, now - started, state);
    }
    cv._roadRaf = requestAnimationFrame(frame);
  };
  cv._roadRaf = requestAnimationFrame(frame);
}

function mountGrave(cv) {
  const rect = cv.getBoundingClientRect();
  const w = rect.width || 52;
  const h = rect.height || 65;
  const ctx = fitCanvas(cv, w, h, 1);
  paintGrave(ctx, w, h);
}

function mountTadpole(cv) {
  const rect = cv.getBoundingClientRect();
  const w = rect.width || 44;
  const h = rect.height || 30;
  const ctx = fitCanvas(cv, w, h, 1);
  paintTadpole(ctx, w, h);
}

function mountSquished(cv) {
  const rect = cv.getBoundingClientRect();
  const w = rect.width || 44;
  const h = rect.height || 30;
  const ctx = fitCanvas(cv, w, h, 1);
  paintSquished(ctx, w, h);
}

function mountWater(cv) {
  const rect = cv.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) return;
  const ctx = fitCanvas(cv, rect.width, rect.height, Math.min(2, window.devicePixelRatio || 1));
  paintPond(ctx, rect.width, rect.height);
}

function mountSendPond(cv) {
  const rect = cv.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return;
  const size = Math.min(rect.width, rect.height);
  const ctx = fitCanvas(cv, size, size);
  // The CSS box stays responsive; the backing store is the square we paint.
  cv.style.width = '';
  cv.style.height = '';
  paintSendPond(ctx, size, size);
}

function mountEmptyLily(cv) {
  const rect = cv.getBoundingClientRect();
  const w = rect.width || 160;
  const h = rect.height || 120;
  const ctx = fitCanvas(cv, w, h, 1);
  paintLily(ctx, w / 2, h / 2, Math.min(w, h) * 0.3, true);
}

/** Run the paint pass: every material the DOM asked for. */
export function decorate(root = document) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll('.btn').forEach(mountLogButton);
  root.querySelectorAll('[data-lily]').forEach(mountLily);
  root.querySelectorAll('canvas[data-pondfrog]').forEach(mountPond);
  root.querySelectorAll('canvas[data-send-pond-art]').forEach(mountSendPond);
  root.querySelectorAll('canvas[data-roadfrog]').forEach(mountRoadFrog);
  root.querySelectorAll('canvas[data-grave]').forEach(mountGrave);
  root.querySelectorAll('canvas[data-tadpole]').forEach(mountTadpole);
  root.querySelectorAll('canvas[data-squished]').forEach(mountSquished);
  root.querySelectorAll('canvas[data-empty-lily]').forEach(mountEmptyLily);
  root.querySelectorAll('canvas[data-pond-water]').forEach(mountWater);
  root.querySelectorAll('canvas[data-qr]').forEach((cv) => paintQR(cv, cv.dataset.qr));
}

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => decorate(document));
  window.addEventListener('orientationchange', () => setTimeout(() => decorate(document), 120));
}
