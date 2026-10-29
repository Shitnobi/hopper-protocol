// The boot splash and the rules walkthrough pictures.
//
// A direct JavaScript port of `show_intro` / `rules_art` from
// frogger-wallet-gui/src/app.rs: the frog's first hop into the road (and
// the car that answers it), plus one moving picture per rule page. The
// sprites, car, road and palette are the theme's own, so the splash can
// never show a hopper the wallet cannot produce.

import {
  C, carBodyColor, dim, laneDashes, paintCar, paintLily, paintRoad,
  paintSprite,
} from './theme.js';

const INTRO_SECONDS = 2.8;
const INTRO_FADE = 0.35;
const INTRO_HOPS = 3;
const INTRO_SEED = 0x0f70c0de;

function fitFull(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function centered(ctx, text, x, y, size, color) {
  ctx.fillStyle = color;
  ctx.font = `700 ${size}px "Courier New", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function frogMarkCanvas(ctx, cx, cy, size, body, cut) {
  // The install icon's frog: body ellipse, two eyes, pupils and a stripe.
  ctx.save();
  ctx.translate(cx - size * 0.5, cy - size * 0.5);
  ctx.scale(size / 64, size / 64);
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.ellipse(32, 44, 18, 10, 0, 0, Math.PI * 2);
  ctx.fill();
  for (const [x, y] of [[24, 26], [40, 26]]) {
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = cut;
  for (const [x, y] of [[24, 26], [40, 26]]) {
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = cut;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(18, 46);
  ctx.lineTo(46, 46);
  ctx.stroke();
  ctx.restore();
}

function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * Play the boot intro. `onDone` fires on skip or after the full run.
 * `host` is the #intro element.
 */
export function playIntro(host, onDone) {
  if (!host) { onDone?.(); return; }
  host.hidden = false;
  const canvas = host.querySelector('canvas');
  if (!canvas) { onDone?.(); return; }
  const start = performance.now();
  let done = false;
  let raf = 0;

  const finish = (skipped) => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    host.hidden = true;
    host.removeEventListener('pointerdown', onPointer);
    host.removeEventListener('click', onPointer);
    window.removeEventListener('keydown', onKey);
    onDone?.(skipped);
  };
  const onPointer = () => finish(true);
  const onKey = () => finish(true);
  host.addEventListener('pointerdown', onPointer);
  host.addEventListener('click', onPointer);
  window.addEventListener('keydown', onKey);

  const frame = (now) => {
    if (done) return;
    const elapsed = (now - start) / 1000;
    if (elapsed >= INTRO_SECONDS) { finish(false); return; }
    drawIntro(canvas, elapsed);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
}

function drawIntro(canvas, elapsed) {
  const { ctx, w, h } = fitFull(canvas);
  const fade = elapsed >= INTRO_SECONDS - INTRO_FADE
    ? Math.max(0, 1 - (elapsed - (INTRO_SECONDS - INTRO_FADE)) / INTRO_FADE)
    : 1;

  // The road: an asphalt band with dashed lane markings.
  const roadTop = h * 0.44;
  const roadBottom = h * 0.60;
  const midY = (roadTop + roadBottom) / 2;
  ctx.fillStyle = C.road;
  ctx.fillRect(0, roadTop, w, roadBottom - roadTop);
  laneDashes(ctx, 0, w, midY);

  // Wordmark + loading dots.
  const markSize = Math.max(28, Math.min(64, w * 0.07)) * (0.6 + 0.4 * fade);
  const wordSize = Math.max(20, Math.min(44, w * 0.05));
  ctx.save();
  ctx.globalAlpha = fade;
  const wordW = wordSize * 3.6;
  const total = markSize + wordSize * 0.3 + wordW;
  const left = w / 2 - total / 2;
  const wordY = h * 0.22;
  frogMarkCanvas(ctx, left + markSize / 2, wordY, markSize * 1.15, C.accent, C.bg);
  ctx.fillStyle = C.accent;
  ctx.font = `700 ${wordSize}px "Courier New", monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('HOPPER', left + markSize + wordSize * 0.3, wordY);
  ctx.restore();

  const dots = '.'.repeat(Math.max(0, Math.floor(elapsed * 2.5) % 4));
  ctx.globalAlpha = fade;
  centered(ctx, `loading${dots}`, w / 2, h * 0.30, Math.max(14, Math.min(22, w * 0.022)), C.textDim);
  const explainer = Math.max(12, Math.min(19, w * 0.021));
  centered(ctx, 'Every Hopper is a satoshi. Cross, and the road is inscribed.', w / 2, h * 0.345, explainer, C.textDim);
  centered(ctx, 'The next block decides — and any ord viewer can prove it.', w / 2, h * 0.385, explainer, C.textDim);
  ctx.globalAlpha = fade * 0.6;
  centered(ctx, 'Ghost Hoppers still owe the toll.', w / 2, h * 0.425, explainer * 0.9, C.textDim);
  ctx.globalAlpha = 1;

  // The frog: three parabolic hops into the road, then the car lands.
  const hopSpan = INTRO_SECONDS - INTRO_FADE;
  const p = Math.max(0, Math.min(1, elapsed / hopSpan));
  const size = Math.max(64, Math.min(160, h * 0.14));
  const startX = w * 0.18;
  const startY = h - size * 0.6;
  const endX = w * 0.52;
  const endY = midY;
  const hopPath = (q) => {
    const seg = q * INTRO_HOPS;
    const hop = Math.min(INTRO_HOPS - 1, Math.floor(seg));
    const local = seg - hop;
    const yFrom = lerp(startY, endY, hop / INTRO_HOPS);
    const yTo = lerp(startY, endY, (hop + 1) / INTRO_HOPS);
    const arc = 4 * local * (1 - local);
    return [lerp(startX, endX, q), lerp(yFrom, yTo, local) - arc * h * 0.10];
  };
  const squishP = 0.78;
  const [squishX, squishY] = hopPath(squishP);
  const squished = p >= squishP;
  const [fx, fy] = squished
    ? [squishX, squishY + size * 0.16]
    : hopPath(p);
  const frogState = squished ? 'idle' : (p < 1 ? 'crossing' : 'idle');
  ctx.globalAlpha = fade;
  if (squished) {
    // The pancake: the sprite squashed to 0.26 of its height.
    ctx.save();
    ctx.translate(fx, fy);
    ctx.scale(1.35, 0.26);
    paintSprite(ctx, INTRO_SEED, frogState, 0, 0, size);
    ctx.restore();
  } else {
    paintSprite(ctx, INTRO_SEED, frogState, fx, fy, size);
  }

  if (squished) {
    ctx.strokeStyle = 'rgba(10,10,12,.9)';
    ctx.lineWidth = Math.max(2, size * 0.045);
    for (const dy of [-size * 0.09, size * 0.09]) {
      ctx.beginPath();
      ctx.moveTo(fx - size * 0.35, fy + dy);
      ctx.lineTo(fx - size * 1.05, fy + dy);
      ctx.stroke();
    }
  }

  // The car: enters from the right, meets the frog, exits left.
  const carW = size * 1.9;
  const carH = size * 0.95;
  let carX;
  if (p < squishP) {
    const approach = Math.max(0, Math.min(1, (p - 0.5) / (squishP - 0.5)));
    carX = lerp(w + carW, squishX, approach);
  } else {
    const leave = Math.max(0, Math.min(1, (p - squishP) / (1 - squishP)));
    carX = lerp(squishX, -carW, leave);
  }
  const carCanvas = document.createElement('canvas');
  carCanvas.width = Math.max(1, Math.round(carW));
  carCanvas.height = Math.max(1, Math.round(carH));
  paintCar(carCanvas.getContext('2d'), carW, carH, dim(carBodyColor(INTRO_SEED), fade), true, C.accent);
  ctx.globalAlpha = fade;
  ctx.drawImage(carCanvas, carX - carW / 2, squishY + size * 0.06 - carH / 2, carW, carH);

  ctx.globalAlpha = fade * 0.7;
  centered(ctx, 'tap to skip', w / 2, h - 24, 14, C.textDim);
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Rules art
// ---------------------------------------------------------------------------

const DESIGNS = [3, 11, 29, 47, 61, 88];

export function paintRulesArt(canvas, art, page, time) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(200, rect.width || 600);
  const h = Math.max(120, rect.height || 190);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const road = ['hop', 'squish', 'toll'].includes(art);
  let band = { left: 0, top: 0, right: w, bottom: h };
  if (road) {
    const bh = Math.max(38, h * 0.5);
    band = { left: 0, top: h / 2 - bh / 2, right: w, bottom: h / 2 + bh / 2 };
    ctx.fillStyle = C.road;
    ctx.fillRect(0, band.top, w, bh);
    let x = 8;
    while (x < w) {
      ctx.strokeStyle = dim(C.accent, 0.5);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(x, h / 2);
      ctx.lineTo(Math.min(x + 22, w), h / 2);
      ctx.stroke();
      x += 38;
    }
  }
  const size = Math.max(44, Math.min(132, h * 0.78));
  const seed = (3 + page * 17) >>> 0;
  const cx = w / 2;
  const cy = h / 2;

  switch (art) {
    case 'designs': {
      const which = Math.floor(time / 0.55) % DESIGNS.length;
      paintSprite(ctx, DESIGNS[which], 'idle', cx, cy, size);
      break;
    }
    case 'sat': {
      const r = size * 0.42;
      ctx.fillStyle = 'rgba(240,200,60,.22)';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(240,200,60,.7)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      paintSprite(ctx, seed, 'idle', cx, cy - size * 0.10, size * 0.72);
      break;
    }
    case 'hop': {
      const p = (time / 2.4) % 1;
      const left = 20;
      const right = w - 20;
      const x = left + (right - left) * p;
      const y = h / 2 - Math.sin(p * Math.PI * 3) * (h * 0.18);
      paintSprite(ctx, seed, 'crossing', x, y, size);
      break;
    }
    case 'squish': {
      const cycle = time % 3;
      const p = cycle / 3;
      const squished = p >= 0.62;
      const fx = 20 + (w - 40) * Math.min(1, p / 0.62) * 0.65;
      const fy = h / 2 + (squished ? size * 0.10 : -Math.sin((p / 0.62) * Math.PI) * h * 0.15);
      paintSprite(ctx, seed, squished ? 'dead' : 'crossing', fx, fy, squished ? size * 0.92 : size);
      const carW = size * 1.9;
      const carH = size * 0.9;
      let carX;
      if (p < 0.62) carX = lerp(w + carW, fx, Math.min(1, (p - 0.3) / 0.32));
      else carX = lerp(fx, -carW, Math.min(1, (p - 0.62) / 0.38));
      const c = document.createElement('canvas');
      c.width = Math.round(carW); c.height = Math.round(carH);
      paintCar(c.getContext('2d'), carW, carH, carBodyColor(seed), false, dim(C.accent, 0.45));
      ctx.drawImage(c, carX - carW / 2, h / 2 + size * 0.06 - carH / 2, carW, carH);
      break;
    }
    case 'home':
      paintSprite(ctx, seed, 'home', cx, cy, size * 1.06);
      break;
    case 'toll': {
      const p = (time / 3) % 1;
      const bh = band.bottom - band.top;
      const postH = Math.max(20, Math.min(bh, bh * (0.55 + 0.45 * p)));
      ctx.fillStyle = 'rgba(240,200,60,.6)';
      ctx.fillRect(cx + size * 0.55, h / 2 - postH / 2, 6, postH);
      paintSprite(ctx, seed, 'idle', cx - size * 0.1, h / 2, size);
      break;
    }
    case 'grave':
    default:
      paintSprite(ctx, seed, 'dead', cx, cy, size * 0.94);
      break;
  }
}

// Re-exported for tests / callers that want the palette in one import.
export { C, paintLily, paintRoad };
