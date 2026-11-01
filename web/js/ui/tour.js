// The boot cutscene and the rules walkthrough pictures.
//
// The boot intro is the rendered HOPPER cutscene (media/hopper-cutscene.mp4),
// played before the wallet is created or unlocked. The rules pictures are a
// JavaScript port of `rules_art` from frogger-wallet-gui/src/app.rs; the
// sprites, car, road and palette are the theme's own, so a rule page can
// never show a hopper the wallet cannot produce.

import {
  C, carBodyColor, dim, paintCar, paintLily, paintRoad, paintSideCar,
  paintSprite,
} from './theme.js';

// The cutscene is 15s. If the media cannot start (offline, a stale cache, a
// browser without H.264) or stalls, resolve instead of trapping the app
// behind a blank cover.
const INTRO_MAX_MS = 40000;

/**
 * Play the boot cutscene. `onDone` fires on skip, error or after the last
 * frame. `host` is the #intro element; its <video> is the cutscene.
 */
export function playIntro(host, onDone) {
  if (!host) { onDone?.(); return; }
  const video = host.querySelector('video');
  if (!video) { onDone?.(); return; }
  host.hidden = false;

  let done = false;
  let watchdog = 0;
  const finish = (skipped) => {
    if (done) return;
    done = true;
    clearTimeout(watchdog);
    host.removeEventListener('pointerdown', onPointer);
    host.removeEventListener('click', onPointer);
    window.removeEventListener('keydown', onKey);
    video.removeEventListener('ended', onEnded);
    video.removeEventListener('error', onError);
    try { video.pause(); } catch { /* nothing to pause */ }
    try { video.currentTime = 0; } catch { /* metadata not loaded */ }
    host.hidden = true;
    onDone?.(skipped);
  };
  const onPointer = () => finish(true);
  const onKey = () => finish(true);
  const onEnded = () => finish(false);
  const onError = () => finish(false);

  host.addEventListener('pointerdown', onPointer);
  host.addEventListener('click', onPointer);
  window.addEventListener('keydown', onKey);
  video.addEventListener('ended', onEnded);
  video.addEventListener('error', onError);

  // The score waits for the next gesture on a cold page, so an unmuted
  // play() is usually refused by the autoplay policy. Try it (a replay from
  // Settings has activation), then fall back to a muted cutscene rather
  // than skipping the intro.
  video.muted = !navigator.userActivation?.hasBeenActive;
  try { video.currentTime = 0; } catch { /* metadata not loaded */ }
  watchdog = setTimeout(() => finish(false), INTRO_MAX_MS);
  let started = null;
  try { started = video.play(); } catch { finish(false); return; }
  if (started && typeof started.catch === 'function') {
    started.catch(() => {
      if (done) return;
      video.muted = true;
      video.play().catch(() => finish(false));
    });
  }
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
      const carH = carW / 2;
      let carX;
      if (p < 0.62) carX = lerp(w + carW, fx, Math.min(1, (p - 0.3) / 0.32));
      else carX = lerp(fx, -carW, Math.min(1, (p - 0.62) / 0.38));
      const c = document.createElement('canvas');
      c.width = Math.round(carW); c.height = Math.round(carH);
      // The cutscene's side-view car, mirrored because it crosses right-to-left.
      paintSideCar(c.getContext('2d'), carW, carH, carBodyColor(seed), true, C.accent);
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
