// The QR widget: the egui app's `qr_ui` (frogger-wallet-gui/src/qr.rs)
// ported to a canvas. It paints the code on its own paper with the QR
// spec's four-module quiet zone, and an empty/dim placeholder for a
// payload no QR version can hold — never an exception.
//
// The encoder is qrcode-generator (MIT, Kazuhiko Arase), bundled into
// js/vendor/qr.js by vendor-src (`npm run build:qr`). Error correction M
// matches the ergui app's default and survives a phone camera at an angle.

import qrcode from '../vendor/qr.js';

export const QR_LIGHT = '#f2f6f0';
export const QR_DARK = '#121a14';
const QUIET_ZONE = 4;

/** Encode a payload into a square boolean grid, or null if impossible. */
export function qrModules(payload) {
  if (!payload) return null;
  try {
    const code = qrcode(0, 'M');
    code.addData(String(payload), 'Byte');
    code.make();
    const n = code.getModuleCount();
    const grid = [];
    for (let y = 0; y < n; y += 1) {
      const row = [];
      for (let x = 0; x < n; x += 1) row.push(code.isDark(y, x));
      grid.push(row);
    }
    return grid;
  } catch (_) {
    return null;
  }
}

/** Paint one square QR in the canvas's current CSS box. */
export function paintQR(canvas, payload) {
  if (!canvas || !canvas.getContext) return;
  const rect = canvas.getBoundingClientRect();
  const css = Math.max(40, Math.min(rect.width || 260, rect.height || 320));
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const cw = Math.round(css * dpr);
  if (canvas.width !== cw) canvas.width = cw;
  if (canvas.height !== cw) canvas.height = cw;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, cw, cw);
  ctx.fillStyle = QR_LIGHT;
  ctx.fillRect(0, 0, cw, cw);

  const grid = qrModules(payload);
  if (!grid) {
    ctx.strokeStyle = '#8a9a8c';
    ctx.lineWidth = Math.max(2, Math.round(dpr * 2));
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, cw - ctx.lineWidth, cw - ctx.lineWidth);
    ctx.fillStyle = '#8a9a8c';
    ctx.font = `600 ${Math.max(10, Math.round(cw / 18))}px "Hopper Digits", "Pixelify Sans", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('no code', cw / 2, cw / 2);
    return;
  }

  // Integer module sizes keep every edge on a device-pixel boundary; a
  // fractional module makes the finder patterns shimmer under a camera.
  const n = grid.length;
  const total = n + QUIET_ZONE * 2;
  const module = Math.max(1, Math.floor(cw / total));
  const span = module * total;
  const ox = Math.floor((cw - span) / 2);
  const oy = Math.floor((cw - span) / 2);
  ctx.fillStyle = QR_DARK;
  for (let y = 0; y < n; y += 1) {
    const row = grid[y];
    for (let x = 0; x < n; x += 1) {
      if (!row[x]) continue;
      ctx.fillRect(
        ox + (x + QUIET_ZONE) * module,
        oy + (y + QUIET_ZONE) * module,
        module,
        module,
      );
    }
  }
}
