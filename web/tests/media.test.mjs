// The two assets that make the browser feel like the egui app: the MIDI
// score (and its parser) and the QR encoder. The players are exercised in
// a real browser by e2e.mjs; these checks are the pure-computation half.
import { readFileSync } from 'node:fs';
import { parseMidi, Sound } from '../js/sound.js';
import { qrModules } from '../js/ui/qr.js';
import { FROG_MARK_ROWS, FROG_MARK_SIZE, frogMarkSvg, paintFrogMark } from '../js/ui/frog-mark.js';
import { POND_MARK_ROWS, POND_MARK_SIZE, pondMarkSvg, roadFrogFrame, SIDE_CAR_MAP, paintSideCar } from '../js/ui/theme.js';
import { pipPlan, pips, targetOf } from '../js/ui/dom.js';
import { GENESIS, requiredAt } from '../js/core/params.js';

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

// The in-flight road card is a treadmill: asphalt slides left while the
// frog arcs right. The frame geometry is pure so the motion is testable.
const road0 = roadFrogFrame(320, 275, 0x12345678, 0);
ok(road0.lift === 0 && road0.dx === 0 && road0.dash === 0,
  'the road frame starts grounded with the lane at phase zero');
const roadAir = roadFrogFrame(320, 275, 0x12345678, 250);
ok(roadAir.lift > 0 && roadAir.dx > 0 && roadAir.sy > 1,
  'the frog lifts and leans right during the hop');
const roadLand = roadFrogFrame(320, 275, 0x12345678, 580);
ok(roadLand.landing > 0.9 && roadLand.sy < 1 && roadLand.lift < 1,
  'landing squashes the frog back onto the asphalt');
const roadLater = roadFrogFrame(320, 275, 0x12345678, 1000);
ok(roadLater.dash < 0 && roadLater.dash > -44,
  'the lane dashes scroll left on the next cycle');

// The player is the app's soundtrack, not a wallet-only effect: it wants
// to play before any vault is opened (FROGGER parity), and reports it.
const player = new Sound({ volume: 0.4, mute: false });
ok(player.status().wanted, 'the score is wanted before a wallet is unlocked');
ok(player.status().mute === false && player.status().volume === 0.4, 'the player mirrors its fader and mute');

// iOS starts an AudioContext only from a completed gesture, and needs a real
// source started inside that gesture. arm() must resume, kick a silent buffer,
// and rebuild a context whose resume was refused instead of retrying it.
const param = () => ({ value: 0 });
const fakeNode = () => ({
  connect(next) { return next; },
  gain: param(), threshold: param(), knee: param(), ratio: param(),
  attack: param(), release: param(), frequency: param(), Q: param(), type: '',
});
class FakeAudioContext {
  constructor() {
    this.state = 'suspended';
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.destination = {};
    this.resumes = 0;
    this.starts = 0;
    this.closed = 0;
  }
  createGain() { return fakeNode(); }
  createDynamicsCompressor() { return fakeNode(); }
  createBiquadFilter() { return fakeNode(); }
  createPeriodicWave() { return {}; }
  createBuffer() { return {}; }
  createBufferSource() {
    const ctx = this;
    return {
      buffer: null,
      connect() { return this; },
      start() { ctx.starts += 1; },
      stop() {},
    };
  }
  resume() { this.resumes += 1; this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
  close() { this.closed += 1; this.state = 'closed'; return Promise.resolve(); }
}
const contexts = [];
const previousWindow = globalThis.window;
globalThis.window = {
  AudioContext: class extends FakeAudioContext {
    constructor() { super(); contexts.push(this); }
  },
};
const gesturePlayer = new Sound({ volume: 0.55, mute: true });
ok(gesturePlayer.arm() === true, 'a completed gesture opens the audio context');
ok(contexts.length === 1 && gesturePlayer.status().state === 'running',
  'the first context is resumed from the gesture');
ok(contexts[0].resumes === 1 && contexts[0].starts === 1,
  'arm resumes the context and starts a silent unlock buffer');
ok(gesturePlayer.status().unlocked === true && gesturePlayer.status().gestures === 1,
  'the player reports the unlock and the gesture');
ok(gesturePlayer.master.gain.value === 0.0001,
  'a muted player keeps its master gain at the mute floor');

// Force the next gesture to see a refused resume, then let a later one build
// a fresh context. This is the iOS failure mode: the old context is poisoned.
contexts[0].state = 'suspended';
contexts[0].resume = () => {
  contexts[0].resumes += 1;
  return Promise.reject(new Error('NotAllowedError'));
};
gesturePlayer.arm();
await Promise.resolve();
await Promise.resolve();
ok(gesturePlayer.status().resumeError === 'NotAllowedError',
  'a refused resume is recorded instead of thrown into the app');
gesturePlayer.arm();
ok(contexts.length === 2 && contexts[0].closed === 1,
  'a later gesture replaces a context whose resume was refused');
ok(gesturePlayer.status().state === 'running' && gesturePlayer.status().resumeError === '',
  'the replacement context is running and has no stale resume error');
if (previousWindow === undefined) delete globalThis.window;
else globalThis.window = previousWindow;

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

// ---- pixel pond mark (the drawer's THE POND icon) -------------------
ok(POND_MARK_SIZE === 14, 'the pond mark is a 14px glyph');
ok(POND_MARK_ROWS.length === POND_MARK_SIZE && POND_MARK_ROWS.every((row) => row.length === POND_MARK_SIZE), 'the pond mark is a square 14x14 grid');
ok(['b', 'w', 'p', 'f'].every((ch) => POND_MARK_ROWS.some((row) => row.includes(ch))), 'the pond mark has a bank, water, a pad and a flower');
const pond = pondMarkSvg(14);
ok(pond.includes('class="pond-mark"') && pond.includes('viewBox="0 0 14 14"') && pond.includes('shape-rendering="crispEdges"'), 'the pond glyph is a crisp 14x14 SVG');
ok(pond.includes('#3a7d89') && pond.includes('#68b270') && pond.includes('#eab0ca'), 'the pond glyph carries water, pad and flower colours');

// ---- page 6's side-view car ------------------------------------------
ok(SIDE_CAR_MAP.length === 8 && SIDE_CAR_MAP.every((row) => row.length === 16),
  'the rules car is the cutscene 16x8 side-view grid');
ok(['b', 'g', 'k', 'L', 'R'].every((ch) => SIDE_CAR_MAP.some((row) => row.includes(ch))),
  'the rules car has body, glass, tyres, headlight and tail light');
const carRects = [];
const carCtx = {
  _fill: '',
  set fillStyle(value) { this._fill = value; },
  get fillStyle() { return this._fill; },
  fillRect(x, y, w, h) { carRects.push({ fill: this._fill, x, y, w, h }); },
};
paintSideCar(carCtx, 160, 80, '#c63e30', true, '#f0c83c');
ok(carRects.length === SIDE_CAR_MAP.join('').replace(/\./g, '').length,
  'every non-empty cutscene car cell is painted');
ok(new Set(carRects.map((r) => r.fill)).size === 5
  && carRects.some((r) => r.fill === '#ff4632') && carRects.some((r) => r.fill === '#f0c83c'),
  'the rules car keeps the cutscene palette, including both lights');
const head = carRects.filter((r) => r.fill === '#f0c83c').map((r) => r.x);
ok(head.length > 0 && Math.min(...head) < 40,
  'mirroring points the headlight into the direction of travel');
const carFront = [];
const frontCtx = {
  _fill: '',
  set fillStyle(value) { this._fill = value; },
  get fillStyle() { return this._fill; },
  fillRect(x, y, w, h) { if (this._fill === '#f0c83c') carFront.push(x); },
};
paintSideCar(frontCtx, 160, 80, '#c63e30', false, '#f0c83c');
ok(carFront.length > 0 && Math.max(...carFront) > 120,
  'the unmirrored car points its headlight the other way');

// ---- crossing pips ----------------------------------------------------
// One dot per required hop, not a fixed five-dot cap: a 5/6 frog shows
// six dots with five filled, and a 100-hop target shows all 100.
const plan56 = pipPlan(5, 6);
ok(plan56.total === 6 && plan56.completed === 5, 'a 5/6 frog gets six dots, five filled');
ok(plan56.size === 7 && plan56.gap === 4, 'small targets keep the original pip size');
const ink56 = pips(5, 6);
ok((ink56.match(/<i /g) || []).length === 6 && (ink56.match(/<i class="on"/g) || []).length === 5, 'the 5/6 markup has six dots and five on');
ok(ink56.includes('×5 / 6') && ink56.includes('aria-label="5 of 6 crossings complete"'), 'the 5/6 label and accessible name tell the truth');
const plan100 = pipPlan(55, 100);
ok(plan100.total === 100 && plan100.completed === 55 && plan100.size === 4, 'a 100-hop target plans 100 smaller dots, 55 filled');
const ink100 = pips(55, 100);
ok((ink100.match(/<i /g) || []).length === 100 && (ink100.match(/<i class="on"/g) || []).length === 55, 'the 100-hop markup renders every dot and fill');
ok(pipPlan(0, 5).total === 5 && pipPlan(7, 5).total === 7, 'targets never truncate a completed count');
const tip = GENESIS + 63;
ok(targetOf({ state: 'idle', dist: 5, last_target_hops: 5 }, tip) === requiredAt(tip + 1), 'an idle frog follows the next required target');
ok(targetOf({ state: 'crossing', in_flight: { target_hops: 5 }, last_target_hops: 5 }, tip) === 5, 'an in-flight frog keeps its frozen target');
ok(targetOf({ state: 'dead', dist: 4, last_target_hops: 5 }, tip) === 5, 'a dead frog keeps the last target it faced');
ok(targetOf({ state: 'home', dist: 5 }, tip) === 5, 'a home frog shows the target it reached');

console.log(`media: ${checks} checks passed`);
