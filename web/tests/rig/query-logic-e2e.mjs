#!/usr/bin/env node
// Live-backend query-logic check against the regtest rig.
//
//   node web/tests/rig/query-logic-e2e.mjs
//
// Requires the rig (../rig/rig.sh) and reads its logs:
//   $RIG/logs/esplora.jsonl   (shim: every Esplora request)
//   $RIG/logs/ord.jsonl       (proxy: every ord request)
// Asserts the 2026-11 API-courtesy scheduler behaviour on a REAL chain:
//   gate: an unchanged tip asks one tip height and nothing else
//   new block: 3 sweeps max (the new-tip pass + 2 index-catch-up passes)
//   no indexer: no catch-up burst at all
//   in-flight at an unchanged tip: no address/range queries
//   ord 429: cooldown — no ord requests for the ladder interval
//   forced public-source: idle cadence, metered pacing, failure ladder

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const RIG = process.env.RIG || `${process.env.HOME}/AI/.hopper-e2e`;
const ESPLORA = process.env.ESPLORA || 'http://127.0.0.1:18081';
const ORD = process.env.ORD || 'http://127.0.0.1:18080';
const B = `${process.env.HOME}/AI/bitcoin/bitcoin-31.1/bin/bitcoin-cli`;
const BTC_ARGS = [`-datadir=${path.join(RIG, 'btc')}`];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
const eq = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) throw new Error(`${what}\n got: ${JSON.stringify(got)}\nwant: ${JSON.stringify(want)}`);
  console.log(`ok   ${what}`);
  checks += 1;
};
const ok = (what, cond, info = '') => {
  if (!cond) throw new Error(`${what} ${info}`);
  console.log(`ok   ${what}`);
  checks += 1;
};

const btc = (...args) => execFileSync(B, [...BTC_ARGS, ...args], { encoding: 'utf8' }).trim();

// --- request logs ---------------------------------------------------------
const esploraLog = path.join(RIG, 'logs', 'esplora.jsonl');
const ordLog = path.join(RIG, 'logs', 'ord.log.jsonl');
const lineCount = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0);
function readSince(f, n) {
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(n).map((l) => JSON.parse(l));
}
// Never inherit an injection from an aborted run.
await fetch(`${ORD}/__fault`, { method: 'DELETE' }).catch(() => {});
await fetch(`${ESPLORA}/__fault`, { method: 'DELETE' }).catch(() => {});

const MARK = { e: lineCount(esploraLog), o: lineCount(ordLog) };
const newReqs = () => ({
  esplora: readSince(esploraLog, MARK.e),
  ord: readSince(ordLog, MARK.o),
});
const mark = () => { MARK.e = lineCount(esploraLog); MARK.o = lineCount(ordLog); };
const count = (reqs, match) => reqs.filter((r) => r.p.includes(match)).length;

// --- module imports (node ignores browser-only globals) -------------------
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const { DEFAULT_SETTINGS, WalletSession } = await import('../../js/wallet/wallet.js');

const MNEMONIC = 'deliver cat inch coyote consider beyond extend fence fish grain million stock';
const wallet = new WalletSession({
  mnemonic: MNEMONIC, network: 'regtest',
  settings: {
    ...DEFAULT_SETTINGS, mode: 'live',
    esploraUrl: ESPLORA, ordUrl: ORD, indexerUrl: '', electrumUrl: '',
  },
});
wallet._autoSync = false; // the test drives passes; no timers

// --- fund the wallet from the chain itself --------------------------------
const fundAddr = wallet.receiveAddress(); // P2WPKH: plain, spendable coins
btc('generatetoaddress', '106', fundAddr);
await sleep(1500); // let ord index the blocks
console.log(`funded ${fundAddr} with 106 coinbases`);

await wallet.refresh({ force: true });
// connect() re-arms auto-sync lazily, which would let background passes race
// the six the test drives (the sweep count is then luck). The test owns the
// scheduler: unsubscribe and clear the timer, manually pass.
wallet._teardownAutoSync();
eq('a cold pass records the tip', wallet.fullScanTip, Number(btc('getblockcount')));
ok('a cold pass found spendable coins', wallet.balance.spendable > 0n, String(wallet.balance.spendable));

// --- 1. GATE: an unchanged tip asks one question --------------------------
mark();
await wallet.refresh({ force: false, auto: true });
let r = newReqs();
eq('idle pass: exactly two chain-metadata requests (height + hash)', r.esplora.length, 2);
ok('idle pass: only tip bookkeeping, no address sweep',
  r.esplora.every((x) => x.p.startsWith('/blocks/tip/')), JSON.stringify(r.esplora.map((x) => x.p)));
eq('idle pass: zero address queries', count(r.esplora, '/address/'), 0);
eq('idle pass: zero ord queries', r.ord.length, 0);

// --- 2. NEW BLOCK: bounded sweeps, no catch-up without an indexer ---------
mark();
btc('generatetoaddress', '1', fundAddr);
await sleep(800);
// simulate the scheduler: first pass on the new tip, then keep ticking
await wallet.refresh({ force: false, auto: true });
const sweeps = [];
for (let i = 0; i < 6; i += 1) {
  const before = lineCount(esploraLog);
  await wallet.refresh({ force: false, auto: true });
  sweeps.push(lineCount(esploraLog) - before);
}
r = newReqs();
const addrReqs = r.esplora.filter((x) => x.p.includes('/address/')).map((x) => x.p);
ok('new block: no catch-up burst without an indexer (<= 3 sweeps)',
  count(r.esplora, '/address/') <= 3 * 4,
  `address queries=${count(r.esplora, '/address/')} watch=${JSON.stringify(wallet.scanState().watch)} rechecks=${wallet._recheckLeft} paths=${JSON.stringify(addrReqs)}`);
ok('after the grace passes the tip gate closes again',
  sweeps[sweeps.length - 1] <= 2, `tail requests=${JSON.stringify(sweeps)}`);
eq('recheck window is empty', wallet._recheckLeft, 0);

// --- 3. IN-FLIGHT at an unchanged tip: cheap watch ------------------------
wallet.pending = [{ txid: '11'.repeat(32), at: Date.now(), kind: 'send' }];
mark();
await wallet.refresh({ force: false, auto: true });
r = newReqs();
eq('in-flight pass: zero address queries', count(r.esplora, '/address/'), 0);
eq('in-flight pass: zero ord queries', r.ord.length, 0);
ok('in-flight note is honest', /in flight/.test(wallet.scan.note), wallet.scan.note);
wallet.pending = [];

// --- 4. ORD 429: cooldown ladder ------------------------------------------
// Force a new tip so the next pass wants range answers from ord.
mark();
btc('generatetoaddress', '1', fundAddr);
await sleep(800);
const inject = async (body) => {
  await fetch(`${ORD}/__fault`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body) });
};
await inject({ match: '/r/utxo', status: 429, times: 100, body: 'slow down' });
await wallet.refresh({ force: false, auto: true });
r = newReqs();
ok('429: the first pass asks ord once per output', r.ord.length >= 1, `ord=${r.ord.length}`);
const cooldownAfter = wallet.backend.ord.backoffMs;
ok('429: a cooldown started', cooldownAfter > 0, `${cooldownAfter}ms`);
const asksBefore = lineCount(ordLog);
// Two more passes at the same tip: the grace window may still be open, but
// the ord client must not send a single request.
wallet._recheckLeft = 2; // force the sweeps that would normally ask ord
await wallet.refresh({ force: false, auto: true });
await wallet.refresh({ force: false, auto: true });
eq('429: during the cooldown ord is not asked at all', lineCount(ordLog), asksBefore);
await fetch(`${ORD}/__fault`, { method: 'DELETE' });
wallet.backend.ord._cooldownUntil = 0; // let the test continue promptly
wallet.backend.ord._backoffMs = 0;

// --- 5. PUBLIC-SOURCE MODE on local endpoints (forcePublicSource hook) ----
wallet.settings.forcePublicSource = true;
await wallet.connect();
wallet._autoSync = false;
eq('forced public source is recognised', wallet.publicSource, true);
eq('forced public source: metered Esplora pacing', wallet.backend.esplora.metered, true);
eq('forced public source: idle cadence is 10 minutes', wallet.tickIntervalMs(), 10 * 60 * 1000);
wallet.fails = 1;
eq('forced public source: failure ladder starts at a minute',
  wallet.tickIntervalMs(), 60 * 1000);
wallet.fails = 0;

console.log(`\nquery-logic: ${checks} checks passed`);
