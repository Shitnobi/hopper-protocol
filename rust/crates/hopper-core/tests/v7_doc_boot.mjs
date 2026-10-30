#!/usr/bin/env node
/* The v7 boot check: a minted Hopper must render from the chain, and the
 * document must never print a crossing count it cannot know.
 *
 * Run: node crates/hopper-core/tests/v7_doc_boot.mjs
 */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'live_v7.js'), 'utf8');

const ID = `${'11'.repeat(32)}i0`;
const CHILD = `${'22'.repeat(32)}i0`;
const SAT = 1_622_677_699_379_588;
const T = 973_400;
const DISPLAY_HASH_DEAD = `${'00'.repeat(28)}00000001`; // 1 % 3 = 1
const DISPLAY_HASH_ALIVE = `${'00'.repeat(28)}00000002`; // 2 % 3 = 2
const PARAMS = { g: 974_034, b: 5, gi: 144, cap: 25, hold: 3_600, gl: 6_480, fin: 6 };

function body(dir, sat = SAT) {
  const b = new Uint8Array(55);
  b.set(new TextEncoder().encode('FRG7CROSS'), 0);
  b[9] = 7;
  const lo = sat >>> 0;
  const hi = Math.floor(sat / 4294967296);
  new DataView(b.buffer).setUint32(10, lo, true);
  new DataView(b.buffer).setUint32(14, hi, true);
  const mint = Uint8Array.from(ID.slice(0, 64).match(/../g).map((x) => parseInt(x, 16))).reverse();
  b.set(mint, 18);
  b[54] = dir;
  return b;
}

function makeEnv({ dir, hash, tip }) {
  const routes = {
    '/r/blockheight': tip,
    [`/r/inscription/${ID}`]: { id: ID, height: T, sequence_number: 1, satpoint: `${ID.slice(0, 64)}:0:0` },
    [`/r/children/${ID}`]: { ids: [CHILD], more: false, page: 0 },
    [`/r/inscription/${CHILD}`]: { height: T, sequence_number: 2, satpoint: `${ID.slice(0, 64)}:0:0` },
    [`/r/content/${CHILD}`]: body(dir),
    [`/r/blockhash/${T + 1}`]: hash,
  };
  const window = { crypto: webcrypto, __hopperV7Boot: false };
  const bandEl = { textContent: '' };
  const genEl = { textContent: '' };
  const document = {
    readyState: 'complete',
    documentElement: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
    getElementById(id) {
      if (id === 'band') return bandEl;
      if (id === 'gen') return genEl;
      return null;
    },
    addEventListener() {},
  };
  const ctx = {
    window, document, crypto: webcrypto,
    location: { pathname: `/${ID}` },
    TextEncoder, Uint8Array, DataView, Array, String, Number, Math, JSON,
    console,
    fetch: async (url) => {
      const path = String(url).split('?')[0];
      if (!(path in routes)) return { ok: false, status: 404 };
      const value = routes[path];
      if (value instanceof Uint8Array) {
        return { ok: true, arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) };
      }
      return { ok: true, json: async () => value };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

async function run(label, { dir, hash, tip }) {
  const ctx = makeEnv({ dir, hash, tip });
  vm.runInContext(
    `V7 = { sat: ${SAT}, genHint: 1, name: "Hopkinson", p: ${JSON.stringify(PARAMS)} };`,
    ctx,
  );
  await ctx.boot();
  const state = ctx.document.documentElement.attrs['data-frogger'];
  const band = ctx.document.getElementById('band').textContent;
  const gen = ctx.document.getElementById('gen').textContent;
  console.log(`${label}: ${state} · ${band} · ${gen}`);
  return { state, band, gen };
}

const dead = await run('hop 1, block wraps 1', { dir: 1, hash: DISPLAY_HASH_DEAD, tip: T + 6 });
if (dead.state !== 'dead') throw new Error('the wrap must kill the chosen direction');
if (!dead.band.startsWith('RIP Hopkinson 🛣 0')) throw new Error(`RIP band wrong: ${dead.band}`);
if (dead.gen !== 'G1') throw new Error(`generation badge wrong: ${dead.gen}`);

const alive = await run('hop 1, block wraps 2', { dir: 1, hash: DISPLAY_HASH_ALIVE, tip: T + 6 });
if (alive.state !== 'idle') throw new Error('another direction must survive');
if (!alive.band.startsWith('Hopkinson 🛣 1')) throw new Error(`live band wrong: ${alive.band}`);

const pending = await run('hop 1, tip T+5', { dir: 1, hash: DISPLAY_HASH_ALIVE, tip: T + 5 });
if (pending.state !== 'crossing') throw new Error('before finality the Hopper is crossing');
if (!pending.band.startsWith('Hopkinson 🛣 0')) throw new Error(`pending band wrong: ${pending.band}`);

console.log('v7 boot: ok');
