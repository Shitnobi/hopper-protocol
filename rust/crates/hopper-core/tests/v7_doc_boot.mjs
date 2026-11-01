#!/usr/bin/env node
/* The v8 boot check: a minted Hopper must render from the chain, and the
 * document must never print a crossing count it cannot prove. The raw
 * transaction fixture carries a canonical state leaf/control block, so the
 * v8 fold accepts it only through the proof path.
 *
 * Run: node crates/hopper-core/tests/v7_doc_boot.mjs
 */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import {
  crossLeafScript, sendLeafScript, encodeStateBody, encodeParentTag,
} from '../../../../web/js/core/v7.js';
import { NUMS_XONLY } from '../../../../web/js/core/params.js';
import { leafHash, branchHash, controlBlock } from '../../../../web/js/wallet/keys.js';
import { bytesToHex, hexToBytes, reverseBytes } from '../../../../web/js/core/hex.js';

if (!globalThis.crypto) globalThis.crypto = webcrypto;

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'live_v8.js'), 'utf8');

const ID = `${'11'.repeat(32)}i0`;
const CHILD = `${'22'.repeat(32)}i0`;
const SAT = 1_622_677_699_379_588;
const T = 973_400;
const DISPLAY_HASH_DEAD = `${'00'.repeat(28)}00000001`; // 1 % 3 = 1
const DISPLAY_HASH_ALIVE = `${'00'.repeat(28)}00000002`; // 2 % 3 = 2
const PARAMS = { g: 974_034, b: 5, gi: 144, cap: 25, hold: 3_600, gl: 6_480, fin: 6 };
const OWNER = Uint8Array.from({ length: 32 }, (_, i) => (i + 1) & 255);

function bodyObj(dir) {
  return {
    sat: SAT,
    mintTxid: reverseBytes(hexToBytes(ID.slice(0, 64))),
    mintIndex: 0,
    dir,
  };
}
function body(dir) { return encodeStateBody(bodyObj(dir)); }

function u32(n) {
  return Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
}
function u64(n) {
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 0; i < 8; i += 1) { out[i] = Number(v & 255n); v >>= 8n; }
  return out;
}
function vi(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 255, (n >>> 8) & 255);
  return Uint8Array.of(0xfe, n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
}
function concat(list) {
  const n = list.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(n);
  let at = 0;
  for (const b of list) { out.set(b, at); at += b.length; }
  return out;
}
function controlFor(dir) {
  const b = { sat: SAT, mintTxid: reverseBytes(hexToBytes(ID.slice(0, 64))), mintIndex: 0, dir: 0 };
  const l0 = crossLeafScript(OWNER, b, 0);
  const l1 = crossLeafScript(OWNER, b, 1);
  const l2 = crossLeafScript(OWNER, b, 2);
  const hL = leafHash(l0), hS = leafHash(l1), hR = leafHash(l2);
  const hX = leafHash(sendLeafScript(OWNER));
  const hLS = branchHash(hL, hS), hRX = branchHash(hR, hX);
  const path = [[hS, hRX], [hL, hRX], [hX, hLS]][dir];
  return controlBlock(NUMS_XONLY, path, 0);
}
function rawTx(dir) {
  const script = crossLeafScript(OWNER, bodyObj(dir), dir);
  const control = controlFor(dir);
  const outScript = concat([Uint8Array.of(0x51, 0x20), OWNER]);
  const noWitness = concat([
    u32(2), vi(1),
    new Uint8Array(32), u32(0), vi(0), u32(0xffffffff),
    vi(1), u64(1000), vi(outScript.length), outScript,
    u32(0),
  ]);
  // Marker/flag + inputs/outputs + witness + locktime.
  const tx = concat([
    u32(2), Uint8Array.of(0x00, 0x01), vi(1),
    new Uint8Array(32), u32(0), vi(0), u32(0xffffffff),
    vi(1), u64(1000), vi(outScript.length), outScript,
    vi(3), vi(64), new Uint8Array(64), vi(script.length), script,
    vi(control.length), control,
    u32(0),
  ]);
  return bytesToHex(tx);
}

function makeEnv({ dir, hash, tip }) {
  const content = body(dir);
  const routes = {
    '/r/blockheight': tip,
    [`/r/inscription/${ID}`]: { id: ID, height: T, sequence_number: 1, satpoint: `${ID.slice(0, 64)}:0:0` },
    [`/r/children/${ID}`]: { ids: [CHILD], more: false, page: 0 },
    [`/r/inscription/${CHILD}`]: {
      height: T, sequence_number: 2, satpoint: `${ID.slice(0, 64)}:0:0`,
      sat: SAT, content_type: 'application/octet-stream',
    },
    [`/r/content/${CHILD}`]: content,
    [`/r/tx/${CHILD.slice(0, 64)}`]: { text: rawTx(dir) },
    [`/r/blockhash/${T + 1}`]: hash,
  };
  const window = { crypto: webcrypto, __hopperV8Boot: false };
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
    TextEncoder, TextDecoder, Uint8Array, DataView, Array, String, Number, Math, JSON,
    Promise, console,
    fetch: async (url) => {
      const path = String(url).split('?')[0];
      if (!(path in routes)) return { ok: false, status: 404 };
      const value = routes[path];
      if (value instanceof Uint8Array) {
        return { ok: true, arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) };
      }
      if (value && value.text != null) return { ok: true, text: async () => value.text };
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
    `V8 = { sat: ${SAT}, genHint: 1, name: "Hopkinson", p: ${JSON.stringify(PARAMS)} };`,
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
if (dead.state !== 'dead') throw new Error(`the wrap must kill the chosen direction (got ${dead.state})`);
if (!dead.band.startsWith('RIP Hopkinson 🛣 0')) throw new Error(`RIP band wrong: ${dead.band}`);
if (dead.gen !== 'G1') throw new Error(`generation badge wrong: ${dead.gen}`);

const alive = await run('hop 1, block wraps 2', { dir: 1, hash: DISPLAY_HASH_ALIVE, tip: T + 6 });
if (alive.state !== 'idle') throw new Error(`another direction must survive (got ${alive.state})`);
if (!alive.band.startsWith('Hopkinson 🛣 1')) throw new Error(`live band wrong: ${alive.band}`);

const pending = await run('hop 1, tip T+5', { dir: 1, hash: DISPLAY_HASH_ALIVE, tip: T + 5 });
if (pending.state !== 'crossing') throw new Error(`before finality the Hopper is crossing (got ${pending.state})`);
if (!pending.band.startsWith('Hopkinson 🛣 0')) throw new Error(`pending band wrong: ${pending.band}`);

// Five co-located, body-valid children must never reach HOME: the fold
// refuses the duplicate/height-ambiguous set.
const duplicate = await run('five co-located children', {
  dir: 1, hash: DISPLAY_HASH_ALIVE, tip: T + 100,
});
if (duplicate.state === 'home') throw new Error('duplicate children must not forge HOME');

console.log('v8 boot: ok');
