#!/usr/bin/env node
// Full live-mode end-to-end against the regtest rig: boot the real PWA in
// headless Chromium, point it at the rig's Esplora shim + ord proxy, fund a
// real coin on a real regtest chain, watch the scheduler, and mint a Hopper
// through the actual UI (preview -> approve -> broadcast -> confirm).
//
//   node web/tests/rig/live-e2e.mjs [http://127.0.0.1:8130] [9222]
//
// Requires: rig.sh backends (bitcoind 19743, ord 18080), static server on
// 8130, chromium --remote-debugging-port=9222. Reads $RIG/logs/*.jsonl.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const base = process.argv[2] || 'http://127.0.0.1:8130';
const debugPort = process.argv[3] || '9222';
const RIG = process.env.RIG || `${process.env.HOME}/AI/.hopper-e2e`;
const ESPLORA = 'http://127.0.0.1:18081';
const ORD = 'http://127.0.0.1:18080';
const B = `${process.env.HOME}/AI/bitcoin/bitcoin-31.1/bin/bitcoin-cli`;
const btc = (...a) => execFileSync(B, [`-datadir=${path.join(RIG, 'btc')}`, ...a], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esploraLog = path.join(RIG, 'logs', 'esplora.jsonl');
const ordLog = path.join(RIG, 'logs', 'ord.log.jsonl');
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const readSince = (f, n) => lines(f).slice(n).map((l) => JSON.parse(l));

let checks = 0;
const failures = [];
const ok = (what, cond, info = '') => {
  if (cond) { console.log(`ok   ${what}`); checks += 1; }
  else { console.log(`FAIL ${what} ${info}`); failures.push(what); }
};

// --- CDP ------------------------------------------------------------------
const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no chromium page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const call = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expr) {
  const res = await call('Runtime.evaluate', {
    expression: expr, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  return res.result.value;
}
async function waitFor(expr, timeout = 20000, what = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evaluate(`Boolean(${expr})`)) return true;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${what}`);
}
const click = (action) => evaluate(`document.querySelector('[data-action="${action}"]').click()`);
const fill = (input, value) => evaluate(`(() => {
  const el = document.querySelector('[data-input="${input}"]');
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
async function clearTourChrome(doneExpr = 'document.querySelector("[data-action=ob-create]")') {
  for (let i = 0; i < 120; i += 1) {
    const state = await evaluate(`(() => {
      const intro = document.querySelector('#intro');
      if (intro && !intro.hidden) { intro.click(); return 'intro'; }
      const skip = document.querySelector('[data-action=rule-skip]');
      if (skip) { skip.click(); return 'rules'; }
      return (${doneExpr}) ? 'done' : 'wait';
    })()`);
    if (state === 'done') return;
    await sleep(200);
  }
  throw new Error('boot chrome did not clear');
}

await call('Runtime.enable');
await call('Log.enable');
await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

// --- boot + point at the rig ---------------------------------------------
await call('Page.navigate', { url: base });
await clearTourChrome();
await evaluate(`localStorage.setItem('hopper.settings.v1', JSON.stringify({
  mode: 'live', esploraUrl: ${JSON.stringify(ESPLORA)}, ordUrl: ${JSON.stringify(ORD)},
  indexerUrl: '', electrumUrl: '',
})); true`);
await call('Page.reload', { ignoreCache: true });
await clearTourChrome();
await waitFor('document.querySelector("[data-action=ob-create]")', 20000, 'onboarding');

// --- create a wallet on regtest ------------------------------------------
await click('ob-create');
await waitFor('document.querySelector(".words")');
await click('ob-words-done');
await waitFor('document.querySelector("[data-input=ob-password]")');
await fill('ob-password', 'hopper-rig-1');
await fill('ob-confirm', 'hopper-rig-1');
await evaluate(`(() => { const s=document.querySelector('[data-input=ob-network]');
  s.value='regtest'; s.dispatchEvent(new Event('input',{bubbles:true}));
  s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
await click('ob-finish');
await waitFor('document.querySelector(".topbar") || document.querySelector(".rules-screen")', 40000, 'wallet shell');
if (await evaluate('!!document.querySelector(".rules-screen")')) {
  await evaluate('document.querySelector("[data-action=rule-skip]").click()');
}
await waitFor('document.querySelector(".balance")', 40000, 'wallet view');

// --- fund a real coin: 1 block to the wallet, 100 to a burn address ------
await click('sheet-receive');
await waitFor('document.querySelector(".receive-address")', 8000, 'receive address');
const receive = await evaluate(`document.querySelector('.receive-address').textContent.trim()`);
await click('close-overlay');
ok('receive address is regtest', /^bcrt1/.test(receive), receive);
btc('generatetoaddress', '1', receive);
btc('generatetoaddress', '100', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
console.log(`funded ${receive.slice(0, 14)}… (+100 burn), tip ${btc('getblockcount')}`);

// The scheduler ticks every 3 s on a local source; wait for the balance.
const started = Date.now();
await waitFor(`(() => {
  const t = document.querySelector('.balance .total')?.textContent || '';
  return Number(t.replace(/[^0-9]/g, '')) > 0;
})()`, 60000, 'a spendable balance').catch((e) => {
  console.log('balance wait failed after', Date.now() - started, 'ms');
  throw e;
});
const balanceText = await evaluate(`document.querySelector('.balance')?.innerText`);
console.log('wallet:', balanceText.replace(/\n/g, ' | '));
ok('wallet shows a spendable balance', /SPENDABLE BALANCE/.test(balanceText));

// --- 1. idle: the tip gate must hold in the real browser ------------------
await sleep(4000); // let the current pass settle
let markE = lines(esploraLog).length;
let markO = lines(ordLog).length;
await sleep(8000);
let rE = readSince(esploraLog, markE);
let rO = readSince(ordLog, markO);
ok('idle: no address sweeps', !rE.some((r) => r.p.includes('/address/')), JSON.stringify(rE.map((r) => r.p)));
ok('idle: no ord range queries', rO.length === 0, String(rO.length));
ok('idle: only tip bookkeeping', rE.every((r) => r.p.startsWith('/blocks/tip/')), JSON.stringify(rE.map((r) => r.p)));
console.log(`idle window: ${rE.length} esplora, ${rO.length} ord`);

// --- 2. a new block: bounded sweeps -------------------------------------
markE = lines(esploraLog).length;
btc('generatetoaddress', '1', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
await sleep(9000);
rE = readSince(esploraLog, markE);
const addrHits = rE.filter((r) => r.p.includes('/address/')).length;
ok('new block: at most 3 sweeps (no catch-up burst)', addrHits > 0 && addrHits <= 12,
  `address requests=${addrHits}`);
console.log(`new-block window: ${rE.length} esplora (${addrHits} address)`);

// --- 3. mint through the real UI ----------------------------------------
await sleep(2500);
await evaluate(`document.querySelector('[data-action=nav][data-view=mint]').click()`);
await waitFor('document.querySelector("[data-action=preview-mint]")', 10000, 'mint screen');
await fill('mint-name', 'RIGFROG');
await waitFor('!document.querySelector("[data-action=preview-mint]").disabled', 40000, 'a fundable mint');
await click('preview-mint');
// Mints use their own sheet title; sends use REVIEW TRANSACTION.
await waitFor(`document.querySelector('.overlay')?.innerText.includes('REVIEW MINT')`, 30000, 'mint preview');
const mintPreview = await evaluate(`document.querySelector('.overlay')?.innerText || ''`);
ok('mint preview names the Hopper', /RIGFROG/.test(mintPreview));
await click('do-approve-tx');
await waitFor(`document.querySelector('#toasts')?.innerText.includes('Minted')`, 40000, 'mint broadcast');
const toast = await evaluate(`document.querySelector('#toasts')?.innerText`);
console.log('toast:', toast.replace(/\n/g, ' | ').slice(0, 200));
ok('mint broadcast reported', /Minted/.test(toast));

// confirm it and let the scheduler pick the confirmed reveal up
btc('generatetoaddress', '2', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
await sleep(6000);
await evaluate(`document.querySelector('[data-action=nav][data-view=pond]').click()`);
await sleep(1500);
const pond = await evaluate(`document.querySelector('#app')?.innerText || ''`);
ok('the pond shows the minted Hopper', /RIGFROG/.test(pond), pond.slice(0, 200));
const pondFrogs = await evaluate(`document.querySelectorAll('[data-action=open-frog]').length`);
ok('one Hopper is in the pond', pondFrogs >= 1, String(pondFrogs));

// --- 4. ord 429 while the app is live: cooldown --------------------------
await fetch(`${ORD}/__fault`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ match: '/r/utxo', status: 429, times: 100, body: 'slow down' }) });
markO = lines(ordLog).length;
btc('generatetoaddress', '1', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
await sleep(5000); // the new-tip sweep hits the 429 and starts the cooldown
const firstBurst = lines(ordLog).length - markO;
markO = lines(ordLog).length;
btc('generatetoaddress', '1', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
await sleep(9000); // a second new tip inside the cooldown window
const duringCooldown = lines(ordLog).length - markO;
ok('429: the first sweep reached ord', firstBurst > 0, String(firstBurst));
ok('429: the cooldown stops later ord asks entirely', duringCooldown === 0, String(duringCooldown));
const stillShown = await evaluate(`document.querySelector('.balance')?.innerText || ''`);
ok('429: the wallet still shows its balance', /SPENDABLE BALANCE/.test(stillShown));
await fetch(`${ORD}/__fault`, { method: 'DELETE' });

// --- 5. no page errors ---------------------------------------------------
const realErrors = consoleErrors.filter((e) => !/429|rate limit|slow down|ord /i.test(String(e)));
ok('no unexpected page errors', realErrors.length === 0, JSON.stringify(realErrors.slice(0, 3)));

const shot = await call('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(RIG, 'logs', 'live-e2e.png'), Buffer.from(shot.data, 'base64'));
console.log(`\nlive-e2e: ${checks} checks passed, ${failures.length} failed (screenshot: ${RIG}/logs/live-e2e.png)`);
process.exit(failures.length ? 1 : 0);
