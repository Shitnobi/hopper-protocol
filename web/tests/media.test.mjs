// The two assets that make the browser feel like the egui app: the MIDI
// score (and its parser) and the QR encoder. The players are exercised in
// a real browser by e2e.mjs; these checks are the pure-computation half.
import { readFileSync } from 'node:fs';
import { parseMidi } from '../js/sound.js';
import { qrModules } from '../js/ui/qr.js';

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

// ---- QR --------------------------------------------------------------
const address = 'bcrt1qzztk65v4te28ta2uxw7lk994zjzt6ktkm7xtzf';
const grid = qrModules(address);
ok(grid && grid.length >= 21, 'an address encodes to a QR grid');
ok(grid.every((row) => row.length === grid.length), 'the QR grid is square');
ok(grid[0].slice(0, 7).every(Boolean), 'the top-left finder border is dark');
ok(grid.slice(0, 7).every((row) => row[6]), 'the top-left finder side is dark');
ok(qrModules('') === null, 'an empty payload is a placeholder, not a throw');
ok(qrModules('x'.repeat(5000)) === null, 'an oversized payload is a placeholder');

console.log(`media: ${checks} checks passed`);
