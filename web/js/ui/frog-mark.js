// The HOPPER frog mark on a 16x16 pixel grid.
//
// The mark keeps the install icon's silhouette — two eyes, a wide body and
// the stripe across it — but every edge is a square pixel so it sits with
// Pixelify Sans instead of looking like a smooth vector glyph.
//
// `#` is the body, `o` is a cut (pupil or body stripe), `.` is transparent.
export const FROG_MARK_SIZE = 16;
export const FROG_MARK_ROWS = [
  '................',
  '................',
  '...###....###...',
  '..#####..#####..',
  '..#ooo#..#ooo#..',
  '..#####..#####..',
  '...###....###...',
  '....##....##....',
  '...##########...',
  '..############..',
  '.##############.',
  '.####oooooo####.',
  '.##############.',
  '..############..',
  '...##########...',
  '................',
];

const COLORS = { '#': true, o: true };

/** Inline SVG mark. `body` fills `#`; `cut` fills `o` (eyes and stripe). */
export function frogMarkSvg(size = 24, body = '#f0c83c', cut = '#18241a') {
  const rects = [];
  for (let y = 0; y < FROG_MARK_ROWS.length; y += 1) {
    const row = FROG_MARK_ROWS[y];
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (!COLORS[ch]) { x += 1; continue; }
      let end = x + 1;
      while (end < row.length && row[end] === ch) end += 1;
      rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${ch === '#' ? body : cut}"/>`);
      x = end;
    }
  }
  return `<svg class="frog-mark" width="${size}" height="${size}" viewBox="0 0 ${FROG_MARK_SIZE} ${FROG_MARK_SIZE}" shape-rendering="crispEdges" aria-hidden="true">${rects.join('')}</svg>`;
}

/** Paint the same grid on a canvas at a whole-device-pixel scale. */
export function paintFrogMark(ctx, cx, cy, size, body = '#f0c83c', cut = '#18241a') {
  const m = typeof ctx.getTransform === 'function'
    ? ctx.getTransform()
    : { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const scale = Math.max(1, Math.hypot(m.a, m.b));
  const cell = Math.max(1, Math.floor((size * scale) / FROG_MARK_SIZE));
  const span = cell * FROG_MARK_SIZE;
  const centerX = m.a * cx + m.c * cy + m.e;
  const centerY = m.b * cx + m.d * cy + m.f;
  const x0 = Math.round(centerX - span / 2);
  const y0 = Math.round(centerY - span / 2);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (let y = 0; y < FROG_MARK_ROWS.length; y += 1) {
    const row = FROG_MARK_ROWS[y];
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (!COLORS[ch]) { x += 1; continue; }
      let end = x + 1;
      while (end < row.length && row[end] === ch) end += 1;
      ctx.fillStyle = ch === '#' ? body : cut;
      ctx.fillRect(x0 + x * cell, y0 + y * cell, (end - x) * cell, cell);
      x = end;
    }
  }
  ctx.restore();
}
