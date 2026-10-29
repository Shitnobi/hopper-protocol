// Deterministic PWA icons from the canonical 16x16 sprite.
import { writeFileSync } from 'node:fs';
import { renderSprite } from '../js/core/art.js';
import { encodePng } from '../js/core/png.js';

const BG = [24, 36, 26, 255];
const RING = [126, 170, 88, 255];
const sprite = renderSprite(0x9058d0fa, 'home');

function icon(size, { maskable = false, glyph = 0.78 } = {}) {
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const r = Math.hypot(dx, dy);
      const inner = 0.5 - 10 / size;
      const c = r > inner ? RING : BG;
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = c[3];
    }
  }
  const px = Math.max(1, Math.floor((size * glyph) / 16));
  const ox = Math.floor((size - px * 16) / 2);
  const oy = Math.floor((size - px * 16) / 2);
  for (let sy = 0; sy < 16; sy++) {
    for (let sx = 0; sx < 16; sx++) {
      const p = sprite.px(sx, sy);
      if (p[3] === 0) continue;
      for (let yy = 0; yy < px; yy++) {
        for (let xx = 0; xx < px; xx++) {
          const x = ox + sx * px + xx;
          const y = oy + sy * px + yy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const i = (y * size + x) * 4;
          const a = p[3] / 255;
          rgba[i] = Math.round(p[0] * a + rgba[i] * (1 - a));
          rgba[i + 1] = Math.round(p[1] * a + rgba[i + 1] * (1 - a));
          rgba[i + 2] = Math.round(p[2] * a + rgba[i + 2] * (1 - a));
          rgba[i + 3] = 255;
        }
      }
    }
  }
  return encodePng(size, size, rgba);
}

const out = {
  'icon-192.png': icon(192),
  'icon-512.png': icon(512),
  'icon-maskable-512.png': icon(512, { maskable: true, glyph: 0.62 }),
  'apple-touch-icon.png': icon(180),
  'favicon-32.png': icon(32, { glyph: 0.9 }),
};
for (const [name, png] of Object.entries(out)) {
  writeFileSync(new URL(`../icons/${name}`, import.meta.url), png);
  console.log(name, png.length, 'bytes');
}
