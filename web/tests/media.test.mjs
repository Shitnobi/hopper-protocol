// The two assets that make the browser feel like the egui app: the MIDI
// score (and its parser) and the QR encoder. The players are exercised in
// a real browser by e2e.mjs; these checks are the pure-computation half.
import { readFileSync } from 'node:fs';
import { parseMidi, Sound } from '../js/sound.js';
import { qrModules } from '../js/ui/qr.js';
import { FROG_MARK_ROWS, FROG_MARK_SIZE, frogMarkSvg, paintFrogMark } from '../js/ui/frog-mark.js';

let checks = 0;
const ok = (cond, message) => {
  checks += 1;
  if (!cond) throw new Error(message);
};

// ---- music.mid -------------------------------------------------------
const song = parseMidi(readFileSync(new URL('../music.mid', import.meta.url)));
ok(song.notes.length > 1000, `the score has real notes (got ${song.notes.length})`);
ok(song.dur > 30, `the score is longer than 30 seconds (got ${song.dur.toFixed(1)}s)`);
ok(song.notes.every((n) => Number.isFinite(n.t0) && Number.isFinite(n.t1)
  && n.t1 >= n.t0 && n.note >= 0 && n.note <= 127), 'every note has sane timing and pitch');
ok(song.notes.some((n) => n.vel > 0 && n.vel <= 127), 'every note carries a MIDI velocity');
ok(song.pan.every(Array.isArray) && song.chanVol.every(Array.isArray), 'mixer lanes are arrays');

// The player is the app's soundtrack, not a wallet-only effect: it wants
// to play before any vault is opened (FROGGER parity), and reports it.
const player = new Sound({ volume: 0.4, mute: false });
ok(player.status().wanted, 'the score is wanted before a wallet is unlocked');
ok(player.status().mute === false && player.status().volume === 0.4, 'the player mirrors its fader and mute');

// ---- QR --------------------------------------------------------------
const address = 'bcrt1qzztk65v4te28ta2uxw7lk994zjzt6ktkm7xtzf';
const grid = qrModules(address);
ok(grid && grid.length >= 21, 'an address encodes to a QR grid');
ok(grid.every((row) => row.length === grid.length), 'the QR grid is square');
ok(grid[0].slice(0, 7).every(Boolean), 'the top-left finder border is dark');
ok(grid.slice(0, 7).every((row) => row[6]), 'the top-left finder side is dark');
ok(qrModules('') === null, 'an empty payload is a placeholder, not a throw');
ok(qrModules('x'.repeat(5000)) === null, 'an oversized payload is a placeholder');

// ---- pixel frog mark ------------------------------------------------
ok(FROG_MARK_ROWS.length === FROG_MARK_SIZE, 'the frog mark is a square grid');
ok(FROG_MARK_ROWS.every((row) => row.length === FROG_MARK_SIZE), 'every frog-mark row is 16 cells');
ok(FROG_MARK_ROWS.some((row) => row.includes('#')) && FROG_MARK_ROWS.some((row) => row.includes('o')), 'the frog mark has body and cut pixels');
const mark = frogMarkSvg(24);
ok(mark.includes('shape-rendering="crispEdges"') && mark.includes('viewBox="0 0 16 16"'), 'the inline mark is a crisp 16x16 SVG');

// The boot intro paints the same mark on a canvas. It must be blocks at
// whole device pixels, not the old smooth ellipses.
const rects = [];
const fakeCtx = {
  _fill: '',
  getTransform: () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 }),
  save() {},
  restore() {},
  setTransform() {},
  set fillStyle(value) { this._fill = value; },
  get fillStyle() { return this._fill; },
  fillRect(x, y, w, h) { rects.push({ fill: this._fill, x, y, w, h }); },
};
paintFrogMark(fakeCtx, 50, 50, 32, '#f0c83c', '#18241a');
ok(rects.length > 10, 'the intro mark is painted as blocks');
ok(rects.every((r) => [r.x, r.y, r.w, r.h].every(Number.isInteger)), 'the intro mark snaps to device pixels');
ok(new Set(rects.map((r) => r.fill)).size === 2, 'the intro mark uses body and cut colors');

console.log(`media: ${checks} checks passed`);
