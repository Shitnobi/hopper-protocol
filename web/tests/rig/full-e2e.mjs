#!/usr/bin/env node
// Full live-mode end-to-end against the regtest rig.
//
//   node web/tests/rig/full-e2e.mjs [http://127.0.0.1:8130] [9223]
//
// Covers, in one browser session against real backends (Core regtest, ord with
// sat indexing, the logging Esplora shim, the ord proxy), the whole product:
//
//   P0  boot, create a wallet, fund it from a coinbase
//   P1  the scheduler and the per-outpoint range cache
//       - idle costs tip bookkeeping only
//       - a new block asks ord ZERO times for coins already named
//       - a reload re-asks nothing (the cache is persisted)
//   P2  mint a Hopper through the UI (commit + reveal broadcast, confirmation)
//   P3  play: stage it on The Road, sign a HOP, seal the direction, settle
//   P4  transact: an ordinary BTC send through the UI, confirmed and logged
//   P5  a brand-new outpoint does reach ord; a 429 starts the cooldown; the
//       cooldown stops later asks; the wallet recovers afterwards
//   P6  no page errors
//
// Requires the rig from README.md (bitcoind 19743, ord 18780, shim 18081,
// proxy 18080, static server 8130, chromium --remote-debugging-port=9223).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const base = process.argv[2] || 'http://127.0.0.1:8130';
const debugPort = process.argv[3] || '9223';
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
const phase = (name) => console.log(`\n=== ${name} ===`);

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
const click = (action, extra = '') => evaluate(`document.querySelector('[data-action="${action}"]${extra}').click()`);
const clickSel = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
const text = async (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.innerText || ''`);
const exists = async (sel) => evaluate(`Boolean(document.querySelector(${JSON.stringify(sel)}))`);
const fill = (input, value) => evaluate(`(() => {
  const el = document.querySelector('[data-input="${input}"]');
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
// A build action (`preview-send`, `preview-hop`) is ignored while the app
// is busy refreshing. Click, then retry until its review sheet is up.
async function clickUntil(action, overlayText, timeout = 60000) {
  const t0 = Date.now();
  let last = 0;
  while (Date.now() - t0 < timeout) {
    if (await evaluate(`document.querySelector('.overlay h2')?.innerText.includes(${JSON.stringify(overlayText)})`)) return true;
    // One click at a time: a second build while the wallet is busy is either
    // ignored or, worse, sees an emptied funding pool after the first send.
    if (Date.now() - last > 8000) {
      last = Date.now();
      await evaluate(`document.querySelector('[data-action="${action}"]')?.click()`);
    }
    await sleep(400);
  }
  throw new Error(`timeout waiting for the ${overlayText} sheet after ${action}: ${(await toasts()).slice(0, 200)}`);
}
const nav = async (view) => {
  await click('nav', `[data-view="${view}"]`);
  await sleep(400);
};
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
const cacheInfo = () => evaluate(`(() => {
  const keys = Object.keys(localStorage).filter((k) => k.startsWith('hopper.ranges.'));
  let entries = 0, ranges = 0;
  for (const k of keys) {
    try {
      const doc = JSON.parse(localStorage.getItem(k));
      for (const row of Object.values(doc.entries || {})) { entries += 1; ranges += (row?.[1] || []).length; }
    } catch { /* ignore a torn write */ }
  }
  return { keys: keys.length, entries, ranges };
})()`);
const toasts = () => evaluate(`document.querySelector('#toasts')?.innerText || ''`);

await call('Runtime.enable');
await call('Log.enable');
await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await fetch(`http://127.0.0.1:18080/__fault`, { method: 'DELETE' }).catch(() => {});
await fetch(`http://127.0.0.1:18081/__fault`, { method: 'DELETE' }).catch(() => {});

// A Core wallet with spendable coins, for a true external send into the app.
let coreAddr = null;
const onDisk = JSON.parse(btc('listwalletdir')).wallets.map((w) => w.name);
if (!onDisk.includes('rigfund')) btc('createwallet', 'rigfund');
else if (!JSON.parse(btc('listwallets')).includes('rigfund')) btc('loadwallet', 'rigfund');
coreAddr = btc('-rpcwallet=rigfund', 'getnewaddress', '', 'bech32');
if (Number(btc('-rpcwallet=rigfund', 'getbalance')) < 1) {
  btc('-rpcwallet=rigfund', 'generatetoaddress', '101', coreAddr);
}
console.log(`core wallet rigfund: ${coreAddr.slice(0, 14)}… balance ${btc('-rpcwallet=rigfund', 'getbalance')} BTC`);

// --- P0: boot, create, fund ----------------------------------------------
phase('P0 boot, wallet, funding');
await call('Page.navigate', { url: base });
await sleep(1200);
// Start from a clean device even when the profile was used by an earlier run:
// clear the vault + ledger + range cache, then reload into onboarding.
await evaluate(`(() => { localStorage.clear(); sessionStorage.clear(); return true; })()`);
await call('Page.reload', { ignoreCache: true });
await clearTourChrome();
await evaluate(`localStorage.setItem('hopper.settings.v1', JSON.stringify({
  mode: 'live', esploraUrl: ${JSON.stringify(ESPLORA)}, ordUrl: ${JSON.stringify(ORD)},
  indexerUrl: '', electrumUrl: '',
})); true`);
await call('Page.reload', { ignoreCache: true });
await clearTourChrome();
await waitFor('document.querySelector("[data-action=ob-create]")', 20000, 'onboarding');

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
if (await exists('.rules-screen')) await click('rule-skip');
await waitFor('document.querySelector(".balance")', 40000, 'wallet view');

await click('sheet-receive');
await waitFor('document.querySelector(".receive-address")', 8000, 'receive address');
const receive = await evaluate(`document.querySelector('.receive-address').textContent.trim()`);
await click('close-overlay');
ok('receive address is regtest', /^bcrt1/.test(receive), receive);
btc('generatetoaddress', '1', receive);
btc('generatetoaddress', '100', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
console.log(`funded ${receive.slice(0, 14)}… (+100 burn), tip ${btc('getblockcount')}`);

await waitFor(`(() => {
  const t = document.querySelector('.balance .total')?.textContent || '';
  return Number(t.replace(/[^0-9]/g, '')) > 0;
})()`, 60000, 'a spendable balance');
const funding = await text('.balance');
console.log('wallet:', funding.replace(/\n/g, ' | '));
ok('wallet shows a spendable balance', /SPENDABLE BALANCE/.test(funding));

// --- P1: scheduler + range cache ----------------------------------------
phase('P1 scheduler and range cache');
let ci = { keys: 0, entries: 0, ranges: 0 };
for (let i = 0; i < 60 && ci.entries === 0; i += 1) { await sleep(500); ci = await cacheInfo(); }
ok('the first pass cached the coin\'s sats', ci.entries >= 1, JSON.stringify(ci));
console.log(`range cache: ${ci.entries} outpoints, ${ci.ranges} ranges`);

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

markE = lines(esploraLog).length;
markO = lines(ordLog).length;
btc('generatetoaddress', '1', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
await sleep(10000);
rE = readSince(esploraLog, markE);
rO = readSince(ordLog, markO);
const addrHits = rE.filter((r) => r.p.includes('/address/')).length;
ok('new block sweeps the watched addresses', addrHits > 0 && addrHits <= 12, `address requests=${addrHits}`);
ok('new block asks ord ZERO times (cached ranges)', rO.length === 0, JSON.stringify(rO.map((r) => r.p)));
console.log(`new-block window: ${rE.length} esplora (${addrHits} address), ${rO.length} ord`);

// A reload must reuse the persisted cache: the first pass after unlock asks
// ord nothing for coins it already knows.
markO = lines(ordLog).length;
await call('Page.reload', { ignoreCache: true });
await clearTourChrome('document.querySelector("[data-input=lock-password]") || document.querySelector(".balance")');
await waitFor('document.querySelector("[data-input=lock-password]") || document.querySelector(".balance")', 30000, 'lock or wallet');
if (await exists('[data-input=lock-password]')) {
  await fill('lock-password', 'hopper-rig-1');
  await click('unlock');
}
await waitFor('document.querySelector(".balance")', 40000, 'wallet after reload');
await sleep(10000);
rO = readSince(ordLog, markO);
const reloaded = await cacheInfo();
ok('reload keeps the range cache', reloaded.entries >= 1, JSON.stringify(reloaded));
ok('reload asks ord ZERO times', rO.length === 0, JSON.stringify(rO.map((r) => r.p)));
console.log(`after reload: ${rO.length} ord, ${reloaded.entries} cached outpoints`);

// --- P2: mint through the real UI ---------------------------------------
phase('P2 mint');
await sleep(1500);
await nav('mint');
await waitFor('document.querySelector("[data-action=preview-mint]")', 10000, 'mint screen');
await fill('mint-name', 'RIGFROG');
await waitFor('!document.querySelector("[data-action=preview-mint]").disabled', 40000, 'a fundable mint');
await click('preview-mint');
await waitFor(`document.querySelector('.overlay')?.innerText.includes('REVIEW MINT')`, 30000, 'mint preview');
const mintPreview = await text('.overlay');
ok('mint preview names the Hopper', /RIGFROG/.test(mintPreview));
ok('mint preview shows the destination and fee', /Destination|Fee|Fee rate/i.test(mintPreview));
markO = lines(ordLog).length;
await click('do-approve-tx');
await waitFor(`document.querySelector('#toasts')?.innerText.includes('Minted')`, 40000, 'mint broadcast');
console.log('toast:', (await toasts()).replace(/\n/g, ' | ').slice(0, 200));
ok('mint broadcast reported', /Minted/.test(await toasts()));

btc('generatetoaddress', '2', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
await sleep(6000);
await nav('pond');
await sleep(1200);
const pond = await text('#app');
ok('the pond shows the minted Hopper', /RIGFROG/.test(pond), pond.slice(0, 200));
ok('one Hopper is in the pond', (await evaluate(`document.querySelectorAll('[data-action=open-frog]').length`)) >= 1);
const frogSat = await evaluate(`document.querySelector('[data-action=open-frog]')?.dataset.sat || ''`);
ok('the pond exposes the Hopper sat', /^[0-9]+$/.test(frogSat), frogSat);

// --- P3: play — stage, hop, seal, settle --------------------------------
phase('P3 play (stage on The Road, HOP, settle)');
await clickSel(`[data-action=open-frog][data-sat="${frogSat}"]`);
await waitFor('document.querySelector(".detail-name")', 15000, 'frog detail');
const detail = await text('#app');
ok('detail shows the Hopper record', /RIGFROG/.test(detail) && /Hopper sat/i.test(detail));
ok('detail offers TRAVEL TO ROAD', await exists('[data-action=travel-to-road]'));
await click('travel-to-road');
await waitFor('document.querySelector("[data-action=travel-approved]")', 10000, 'travel warning');
await click('travel-approved');
await waitFor(`document.querySelector('#toasts')?.innerText.includes('Staged on The Road')`, 60000, 'staging broadcast');
console.log('toast:', (await toasts()).replace(/\n/g, ' | ').slice(0, 200));
ok('staging transaction broadcast', /Staged on The Road/.test(await toasts()));

// Confirm the state output like a normal user would.
btc('generatetoaddress', '1', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
await sleep(5000);
await nav('road');
// Diagnostics if the road does not offer the hop: the ledger is the truth
// about where the wallet thinks the Hopper's sat lives.
await sleep(1500);
const roadDiag = await evaluate(`(() => {
  const lk = Object.keys(localStorage).find((k) => k.startsWith('hopper.ledger.'));
  const led = lk ? JSON.parse(localStorage.getItem(lk)) : null;
  return {
    road: document.querySelector('#app')?.innerText?.slice(0, 600),
    actions: led?.actions,
    staged: led?.staged,
    tip: led?.tipHeight,
    fullScanTip: led?.fullScanTip,
  };
})()`);
console.log('road diag:', JSON.stringify(roadDiag).slice(0, 1800));
let stagedVisible = false;
try {
  await waitFor('document.querySelector("[data-action=sheet-cross]")', 15000, 'a staged Hopper');
  stagedVisible = true;
} catch { /* recorded below */ }
ok('staging keeps the Hopper on the road without a manual rescan', stagedVisible,
  'the state output is only discovered on a cold/forced pass');
if (!stagedVisible) {
  // Known gap: _discoverStaged() runs once, inside prepare()'s refresh, and
  // that is usually before ord can name the brand-new state output. Warm
  // passes never retry, so the Hopper vanishes until a forced pass. RESCAN
  // is the in-app escape hatch; a reload does the same.
  console.log('   recovering with SETTINGS -> RESCAN FROM CHAIN');
  await nav('settings');
  await waitFor('document.querySelector("[data-action=rescan]")', 15000, 'RESCAN button');
  await click('rescan');
  await sleep(8000);
  await nav('road');
  await waitFor('document.querySelector("[data-action=sheet-cross]")', 120000, 'a staged Hopper after RESCAN');
}
const road = await text('#app');
ok('the road shows the staged Hopper', /RIGFROG/.test(road) && /CHOOSE A DIRECTION|HOP/i.test(road));

await click('sheet-cross');
await waitFor('document.querySelector("[data-input=cross-owner]")', 10000, 'hop direction sheet');
ok('the hop sheet explains the sealed outcome', /next block picks one direction/i.test(await text('.overlay')));
for (let i = 0; i < 12; i += 1) {
  if (await evaluate(`document.querySelector('.overlay h2')?.innerText.includes('HOP STRAIGHT')`)) break;
  await clickSel('[data-action=preview-hop][data-dir="1"]');
  await sleep(2500);
}
await waitFor(`document.querySelector('.overlay h2')?.innerText.includes('HOP STRAIGHT')`, 5000, 'hop preview');
const hopPreview = await text('.overlay');
ok('the hop preview fixes the direction', /HOP STRAIGHT/.test(hopPreview) && /Destination address/i.test(hopPreview));
markO = lines(ordLog).length;
await click('do-approve-tx');
await waitFor(`document.querySelector('#toasts')?.innerText.includes('HOP STRAIGHT confirmed')`, 40000, 'hop broadcast');
console.log('toast:', (await toasts()).replace(/\n/g, ' | ').slice(0, 240));
ok('hop broadcast reported', /HOP STRAIGHT confirmed/.test(await toasts()));
const ordForHop = readSince(ordLog, markO).length;
console.log(`ord asks during the hop: ${ordForHop} (new outpoints only)`);

const inFlight = await text('#app');
ok('the road lists the crossing as in flight', /ON THE ROAD|in mempool/i.test(inFlight), inFlight.slice(0, 240));

// The next block seals the direction; six more settle it.
btc('generatetoaddress', '1', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
await sleep(4000);
btc('generatetoaddress', '6', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
const settled = await (async () => {
  for (let i = 0; i < 60; i += 1) {
    const txt = await text('#app');
    if (/survived|died|came home/i.test(txt)) return txt;
    await sleep(1000);
  }
  return text('#app');
})();
const outcome = /came home/i.test(settled) ? 'came home'
  : /died/i.test(settled) ? 'died' : /survived/i.test(settled) ? 'survived' : 'unknown';
ok('the crossing settled with a recorded outcome', outcome !== 'unknown', `outcome=${outcome}\n${settled.slice(0, 300)}`);
console.log(`road outcome: ${outcome}`);
await nav('history');
const historyText = await text('#app');
ok('history records the mint and the road action', /RIGFROG|Mint/i.test(historyText) && /survived|died|came home|HOP|hop/i.test(historyText));

// --- P4: transact — an ordinary BTC send --------------------------------
phase('P4 transact (BTC send)');
const dest = btc('-rpcwallet=rigfund', 'getnewaddress', '', 'bech32');
await nav('wallet');
await sleep(2000);
const before = await text('.balance');
const beforeSats = Number((before.match(/([0-9,]+) sats/) || [])[1]?.replace(/,/g, '') || 0);
await click('sheet-send');
await waitFor('document.querySelector("[data-input=send-to]")', 10000, 'send sheet');
await fill('send-to', dest);
await fill('send-amount', '50000');
await clickUntil('preview-send', 'REVIEW TRANSACTION');
const sendPreview = await text('.overlay');
ok('send preview names the recipient and amount', /50,000|50000/.test(sendPreview), sendPreview.slice(0, 200));
await click('do-approve-tx');
await waitFor(`document.querySelector('#toasts')?.innerText.includes('Sent')`, 40000, 'send broadcast');
console.log('toast:', (await toasts()).replace(/\n/g, ' | ').slice(0, 200));
ok('send broadcast reported', /Sent 50,000 sats/.test(await toasts()));
btc('generatetoaddress', '1', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
await sleep(6000);
const after = await text('.balance');
const afterSats = Number((after.match(/([0-9,]+) sats/) || [])[1]?.replace(/,/g, '') || 0);
ok('the balance dropped after the send', beforeSats > 0 && afterSats > 0 && afterSats < beforeSats, `${beforeSats} -> ${afterSats}`);
await nav('history');
const hist2 = await text('#app');
ok('history lists the outgoing send', new RegExp(dest.slice(0, 8)).test(hist2) || /Sent|OUT|−/.test(hist2));

// --- P5: a new outpoint reaches ord; 429 cool-down ----------------------
phase('P5 new outpoint, 429 cool-down, recovery');
// Arm the fault, then have Core pay the wallet: a genuinely new outpoint is
// the only thing that may ask the range oracle now.
await fetch(`${ORD}/__fault`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ match: '/r/utxo', status: 429, times: 100, body: 'slow down' }) });
markO = lines(ordLog).length;
btc('-rpcwallet=rigfund', 'sendtoaddress', receive, '0.02');
btc('generatetoaddress', '1', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
// The wallet sees the new coin and asks; the ask is answered 429.
const firstBurst = await (async () => {
  for (let i = 0; i < 40; i += 1) {
    if (lines(ordLog).length - markO > 1) return lines(ordLog).length - markO;
    await sleep(500);
  }
  return lines(ordLog).length - markO;
})();
ok('a new outpoint reaches the range oracle', firstBurst > 0, String(firstBurst));

markO = lines(ordLog).length;
btc('generatetoaddress', '1', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
await sleep(9000);
const duringCooldown = lines(ordLog).length - markO;
ok('the 429 cooldown stops later ord asks entirely', duringCooldown === 0, String(duringCooldown));
await nav('wallet');
await sleep(800);
ok('the wallet still shows its balance', /SPENDABLE BALANCE/.test(await text('.balance')));

const cacheBeforeRecovery = await cacheInfo();
await fetch(`${ORD}/__fault`, { method: 'DELETE' });
// The 30 s ladder has to expire first, and a pass only runs at a new tip (or
// when the cache reports a backlog). Wait it out, then give the wallet a block.
await sleep(34000);
const recovered = await (async () => {
  const from = lines(ordLog).length;
  const t0 = Date.now();
  btc('generatetoaddress', '1', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
  while (Date.now() - t0 < 90000) {
    if (lines(ordLog).length - from > 0) {
      await sleep(3000); // give the answer time to land in the cache
      return { asks: lines(ordLog).length - from, ms: Date.now() - t0 };
    }
    await sleep(1000);
  }
  return { asks: 0, ms: Date.now() - t0 };
})();
ok('the range oracle recovers after the cooldown', recovered.asks > 0, JSON.stringify(recovered));
console.log(`recovery: ${recovered.asks} asks after ${Math.round(recovered.ms / 1000)}s`);
const finalCache = await cacheInfo();
ok('the recovered ranges were cached', finalCache.entries > cacheBeforeRecovery.entries,
  `${cacheBeforeRecovery.entries} -> ${finalCache.entries}`);

// --- P6: errors, screenshot --------------------------------------------
phase('P6 page errors');
const realErrors = consoleErrors.filter((e) => !/429|rate limit|slow down|ord |Failed to fetch|NetworkError/i.test(String(e)));
ok('no unexpected page errors', realErrors.length === 0, JSON.stringify(realErrors.slice(0, 3)));
await nav('wallet');
await sleep(800);
const shown = await text('.balance');
console.log('final balance:', shown.replace(/\n/g, ' | '));

const shot = await call('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(RIG, 'logs', 'full-e2e.png'), Buffer.from(shot.data, 'base64'));
console.log(`\nfull-e2e: ${checks} checks passed, ${failures.length} failed (screenshot: ${RIG}/logs/full-e2e.png)`);
if (failures.length) console.log('failed:', failures.join(' | '));
process.exit(failures.length ? 1 : 0);
