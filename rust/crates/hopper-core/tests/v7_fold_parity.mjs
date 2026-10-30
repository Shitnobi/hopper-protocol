#!/usr/bin/env node
/* The embedded fold and web/js/core/fold.js must answer the same
 * (state, dist, dir) for the same crossing set, including the global wrap.
 *
 * Run: node crates/hopper-core/tests/v7_fold_parity.mjs
 */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const here = dirname(fileURLToPath(import.meta.url));
const embedded = readFileSync(join(here, '..', 'src', 'live_v7.js'), 'utf8');
const embeddedFold = new Function(`${embedded}\nreturn {foldFrog};`)().foldFrog;
const { foldFrog: jsFold } = await import(join(here, '..', '..', '..', '..', 'web', 'js', 'core', 'fold.js'));

const P = { g: 974_034, b: 5, gi: 144, cap: 25, hold: 3_600, gl: 6_480, fin: 6 };
const SP = `${'aa'.repeat(32)}:0:0`;
const id = `${'aa'.repeat(32)}i0`;
const hashFor = (dir) => `${'00'.repeat(28)}0000000${dir}`; // internal 0..2
const mk = (height, dir) => ({ id, height, sequence: height, satpoint: SP, bodyOk: true, dir });

let checks = 0;
function eq(what, a, b) {
  const A = JSON.stringify({ state: a.state, dist: a.dist, dir: a.dir, target: a.target });
  const B = JSON.stringify({ state: b.state, dist: b.dist, dir: b.dir, target: b.target });
  if (A !== B) throw new Error(`${what}: ${A} != ${B}`);
  checks += 1;
}

for (let dir = 0; dir < 3; dir += 1) {
  for (const wrap of [0, 1, 2]) {
    for (const tip of [973_400 + 5, 973_400 + 6, 973_400 + 7]) {
      const input = {
        sat: 42, tip, me: { satpoint: SP },
        children: [mk(973_400, dir)],
        hash: { 973_401: hashFor(wrap) }, p: P,
      };
      eq(`dir ${dir} wrap ${wrap} tip ${tip}`, embeddedFold(input), jsFold(input));
    }
  }
}

// Idle frog, no crossings.
const idleIn = { sat: 7, tip: 974_034, me: { satpoint: SP }, children: [], hash: {}, p: P };
eq('idle', embeddedFold(idleIn), jsFold(idleIn));

console.log(`v7 fold parity: ${checks} cases OK`);
