// Pins the fixed watch policy: ordinals, receive #0 and change #0, plus
// staged state scripts. There is no gap walk or address rotation, and a tip
// gate asks the chain NOTHING while the tip is unchanged.

import assert from 'node:assert/strict';

const settingsStore = new Map([
  ['hopper.settings.v1', JSON.stringify({ gap: 50 })],
]);
globalThis.localStorage = {
  getItem: (k) => settingsStore.get(k) ?? null,
  setItem: (k, v) => { settingsStore.set(k, String(v)); },
  removeItem: (k) => { settingsStore.delete(k); },
};

const {
  DEFAULT_SETTINGS, WalletSession, loadSettings,
  failureBackoffMs, isPublicEndpoint, isUnconfirmedUtxo,
} = await import('../js/wallet/wallet.js');
const { createVault } = await import('../js/wallet/vault.js');

let checks = 0;
function eq(what, got, want) {
  assert.deepEqual(got, want, `${what}\n got: ${JSON.stringify(got)}\nwant: ${JSON.stringify(want)}`);
  checks++;
}

// --- settings migration ---------------------------------------------------
const migrated = loadSettings();
eq('a legacy gap is ignored', migrated.gap, undefined);
eq('no gap extension survives', migrated.gapExtra, undefined);

// --- mempool classification ----------------------------------------------
eq('Esplora mempool output', isUnconfirmedUtxo({ status: { confirmed: false } }), true);
eq('Electrum mempool output', isUnconfirmedUtxo({ status: { height: 0, confirmed: false } }), true);
eq('Electrum unconfirmed-parent sentinel', isUnconfirmedUtxo({ status: { height: -1, confirmed: false } }), true);
eq('confirmed Esplora output', isUnconfirmedUtxo({ status: { confirmed: true } }), false);
eq('confirmed Electrum output', isUnconfirmedUtxo({ status: { height: 812345 } }), false);
eq('missing status is not guessed', isUnconfirmedUtxo({}), false);

// --- source policy --------------------------------------------------------
eq('localhost is free', isPublicEndpoint('http://127.0.0.1:3002'), false);
eq('LAN is free', isPublicEndpoint('http://192.168.1.4:9770'), false);
eq('public HTTPS is metered', isPublicEndpoint('https://mempool.space/api'), true);
eq('public WSS is metered', isPublicEndpoint('wss://electrum.example.org'), true);
eq('malformed URL is treated as metered', isPublicEndpoint('not a url'), true);

// --- failure backoff ------------------------------------------------------
eq('local backoff 1', failureBackoffMs(1), 5_000);
eq('local backoff 2', failureBackoffMs(2), 10_000);
eq('local backoff 7', failureBackoffMs(7), 300_000);
eq('local backoff clamps high counts', failureBackoffMs(99), 300_000);
eq('public backoff starts at a minute', failureBackoffMs(1, { publicSource: true }), 60_000);
eq('public backoff climbs', failureBackoffMs(2, { publicSource: true }), 120_000);
eq('public backoff reaches 30 minutes', failureBackoffMs(7, { publicSource: true }), 1_800_000);
eq('public backoff clamps high counts', failureBackoffMs(99, { publicSource: true }), 1_800_000);

// --- integration: cold walk, tip gate, warm pass --------------------------
class FakeBackend {
  constructor(tip = 100) {
    this.tip = tip;
    this.tipCalls = 0;
    this.historyCalls = 0;
    this.utxoCalls = 0;
    this.hash = 'aa'.repeat(32);
  }
  async tipHeight() { this.tipCalls += 1; return this.tip; }
  async tipHash() { return this.hash; }
  async addressHistory() { this.historyCalls += 1; return []; }
  async addressUtxos() { this.utxoCalls += 1; return []; }
  async utxo() { return null; }
  async frogger() { return null; }
  async froggers() { return { items: [] }; }
  async events() { return { events: [] }; }
  async getTx() { return null; }
  async broadcast() { throw new Error('not used'); }
  async leaderboard() { return { entries: [] }; }
  async road() { return { active: [] }; }
}

const wallet = new WalletSession({
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  network: 'regtest',
  settings: { ...DEFAULT_SETTINGS, mode: 'demo' },
});
const fake = new FakeBackend(100);
wallet.backend = fake;
wallet._autoSync = false;

await wallet.refresh({ force: true });
const legacyExtra = wallet.keys.legacyFrogAddress() === wallet.keys.frogAddress() ? 0 : 1;
eq('cold pass runs the two fixed history backfills', fake.historyCalls, 2);
eq('cold pass queries the fixed HD scripts plus the legacy recovery path', fake.utxoCalls, 3 + legacyExtra);
eq('cold pass records the tip gate', wallet.fullScanTip, 100);
eq('cold pass sets the watched tip', wallet.watchTip, 100);
eq('cold pass is not partial', wallet.scan.partial, false);
eq('receive is fixed at index 0', wallet.receiveAddress(), wallet.keys.receive(0).address);
eq('the watch set names the fixed scripts', wallet.scanState().watch,
  { ord: true, receive: 0, change: 0, staged: 0 });

const beforeGate = { h: fake.historyCalls, u: fake.utxoCalls, t: fake.tipCalls };
await wallet.refresh({ force: false });
eq('unchanged tip asks one tip question only', fake.tipCalls, beforeGate.t + 1);
eq('unchanged tip walks no history', fake.historyCalls, beforeGate.h);
eq('unchanged tip queries no addresses', fake.utxoCalls, beforeGate.u);

const beforeWarm = { h: fake.historyCalls, u: fake.utxoCalls };
fake.tip = 101;
fake.hash = 'cc'.repeat(32);
await wallet.refresh({ force: false, auto: true });
eq('new block runs no gap walk', fake.historyCalls, beforeWarm.h);
eq('new block asks only the fixed watch set', fake.utxoCalls - beforeWarm.u, 3);
eq('new block watches the new tip', wallet.watchTip, 101);
eq('new block owes two index-catch-up passes', wallet._recheckLeft, 2);

// A tip can arrive before the address index has the block's transactions.
// The two grace passes must bypass the same-tip gate and ask again.
const beforeCatchUp = fake.utxoCalls;
await wallet.refresh({ force: false, auto: true });
eq('first index-catch-up pass ignores the tip gate', fake.utxoCalls - beforeCatchUp, 3);
eq('first catch-up consumed', wallet._recheckLeft, 1);
await wallet.refresh({ force: false, auto: true });
eq('second index-catch-up pass ignores the tip gate', fake.utxoCalls - beforeCatchUp, 6);
eq('catch-up window closed', wallet._recheckLeft, 0);
await wallet.refresh({ force: false, auto: true });
eq('after the grace passes the same tip is gated again', fake.utxoCalls - beforeCatchUp, 6);

const beforeReorg = fake.utxoCalls;
fake.hash = 'bb'.repeat(32);
await wallet.refresh({ force: false });
eq('same height with a new tip hash forces a fresh scan', fake.utxoCalls - beforeReorg, 3);
eq('the new hash is recorded', wallet.tipHash, 'bb'.repeat(32));

const beforeForced = fake.utxoCalls;
await wallet.refresh({ force: true });
eq('a forced pass asks the fixed set plus the legacy recovery path', fake.utxoCalls - beforeForced, 3 + legacyExtra);

// --- RESCAN ---------------------------------------------------------------
const beforeRescan = { h: fake.historyCalls, u: fake.utxoCalls };
await wallet.startRescan();
eq('rescan re-runs the fixed history backfills', fake.historyCalls - beforeRescan.h, 2);
eq('rescan re-asks the fixed watch set plus the legacy path', fake.utxoCalls - beforeRescan.u, 3 + legacyExtra);
eq('rescan has no progress line when finished', wallet.scan.rescan, null);
eq('rescan re-arms the gate', wallet.fullScanTip, 101);
const savedLedger = JSON.parse(settingsStore.get(`hopper.ledger.${wallet.fingerprint}.v1`));
eq('the gate tip persists with the ledger', savedLedger.fullScanTip, 101);
eq('no gap state is persisted', savedLedger.receiveIndex, undefined);
eq('no hot-address state is persisted', savedLedger.hot, undefined);

// --- unconfirmed outputs from the same address answers --------------------
// An unconfirmed output arrives in the UTXO list we already request. It must
// be shown and counted without a second address/history call.
const receive0 = wallet.keys.receive(0);
const memTxid = 'ab'.repeat(32);
fake.tip = 102;
const beforeMempool = { h: fake.historyCalls, u: fake.utxoCalls };
let mempoolAddressCalls = 0;
fake.addressUtxos = async (address) => {
  mempoolAddressCalls += 1;
  return address === receive0.address
    ? [{ txid: memTxid, vout: 1, value: 1234, status: { confirmed: false } }]
    : [];
};
await wallet.refresh({ force: false });
eq('mempool output adds only the fixed watch set', mempoolAddressCalls, 3);
eq('mempool output adds no gap/history walk', fake.historyCalls, beforeMempool.h);
eq('mempool output is tracked', wallet.mempool.length, 1);
eq('mempool output keeps its txid', wallet.mempool[0].txid, memTxid);
eq('mempool output keeps its amount', wallet.mempool[0].amount, 1234);
eq('mempool output is flagged on the coin', wallet.utxos[0].unconfirmed, true);
eq('mempool total is in the balance summary', String(wallet.balance.pending), '1234');
const savedMempool = JSON.parse(settingsStore.get(`hopper.ledger.${wallet.fingerprint}.v1`));
eq('mempool rows persist with the ledger', savedMempool.mempool[0].txid, memTxid);
eq('the pending total persists with the ledger', savedMempool.balance.pending, '1234');

// A payment to the fixed address does not rotate it or force another pass.
eq('the fixed receive address never rotates', wallet.receiveAddress(), receive0.address);
const afterMempool = mempoolAddressCalls;
await wallet.refresh({ force: false });
eq('unchanged tip after payment stays quiet', mempoolAddressCalls, afterMempool);
fake.tip = 103;
await wallet.refresh({ force: false });
eq('the fixed address is still the watch address', wallet.receiveAddress(), receive0.address);
eq('the known mempool row survives the tip gate', wallet.mempool.length, 1);
eq('no receive rotation state exists', wallet.receiveIndex, undefined);

const { history: historyHtml } = await import('../js/ui/screens.js');
const html = historyHtml({
  w: { history: [], actions: [], mempool: wallet.mempool, frogBySat: () => null },
});
eq('history renders the mempool label', /IN MEMPOOL/.test(html), true);
eq('history marks the row transparent', /class="card-row mempool"/.test(html), true);
eq('history shows the incoming amount', /\+1,234 sats/.test(html), true);

// --- in-flight cadence ----------------------------------------------------
wallet.publicSource = true;
wallet.fails = 0;
wallet._recordAction({ kind: 'send', txid: 'aa'.repeat(32) });
eq('a broadcast is in flight', wallet._inFlight(), true);
eq('public source polls a wallet while in flight', wallet.tickIntervalMs(), 30_000);
fake.getTx = async () => ({ status: { confirmed: true, block_height: 101 } });
await wallet._reconcilePending(101);
eq('a confirmed broadcast leaves the pending set', wallet.pending.length, 0);
eq('an idle public source drops to 10 minutes', wallet.tickIntervalMs(), 600_000);
wallet.fails = 2;
eq('a failed public pass backs off to two minutes', wallet.tickIntervalMs(), 120_000);

// --- pause / resume -------------------------------------------------------
const pauseWallet = new WalletSession({
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  network: 'regtest',
  settings: { ...DEFAULT_SETTINGS, mode: 'demo' },
});
pauseWallet.backend = new FakeBackend(100);
pauseWallet.publicSource = true;
pauseWallet._autoSync = false;
eq('scanning starts unpaused', pauseWallet.scanState().paused, false);
pauseWallet.pauseScan();
eq('pause is persisted', pauseWallet.settings.scanPaused, true);
eq('pause clears the timer', pauseWallet._timer, null);
eq('pause stops auto scheduling', pauseWallet._autoSync, false);
eq('pause is visible in scan state', pauseWallet.scanState().paused, true);
eq('pause says no automatic passes', /scanning paused/i.test(pauseWallet.scan.note), true);
pauseWallet.resumeScan();
eq('resume is persisted', pauseWallet.settings.scanPaused, false);
eq('resume restores auto scheduling', pauseWallet._autoSync, true);
eq('resume schedules the next pass', pauseWallet.scan.nextAt > Date.now(), true);
eq('resume is visible in scan state', pauseWallet.scanState().paused, false);
pauseWallet.stop();
eq('stop after resume clears the timer', pauseWallet._timer, null);

// --- a failed tip stops a background pass before address queries ----------
const dead = new WalletSession({
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  network: 'regtest',
  settings: { ...DEFAULT_SETTINGS, mode: 'demo' },
});
const deadBackend = new FakeBackend(100);
deadBackend.tipHeight = async () => { deadBackend.tipCalls += 1; throw new Error('tip down'); };
dead.backend = deadBackend;
dead.publicSource = true;
dead.fullScanTip = 100;
dead.watchTip = 100;
dead._autoSync = false;
let tipThrew = false;
try { await dead.refresh({ force: false, auto: true }); } catch { tipThrew = true; }
eq('a background tip failure aborts the pass', tipThrew, true);
eq('a background tip failure makes no address requests',
  deadBackend.historyCalls + deadBackend.utxoCalls, 0);
eq('a background tip failure counts one failed pass', dead.fails, 1);
eq('a failed public pass retries in a minute', dead.tickIntervalMs(), 60_000);

// --- scan panel says STOP, then RESUME ------------------------------------
const { scanPanel } = await import('../js/ui/screens.js');
const panelState = {
  watch: { ord: true, receive: 0, change: 0, staged: 0 }, lastPass: null, lastTip: null, busy: false,
  rescan: null, note: '', nextAt: null, auto: false, fails: 0, pending: 0,
  publicSource: true, paused: false,
};
const panelApp = (paused) => ({
  w: { settings: { mode: 'live' }, scanState: () => ({ ...panelState, paused }) },
});
const runningPanel = scanPanel(panelApp(false));
eq('scan panel offers STOP', />STOP SCANNING</.test(runningPanel), true);
eq('scan panel names the fixed watch set', /ordinals \+ receive #0 \+ change #0/.test(runningPanel), true);
eq('scan panel has no gap controls', /EXTEND|Scan window/.test(runningPanel), false);
eq('scan panel does not offer RESUME while running', />RESUME SCANNING</.test(runningPanel), false);
const pausedPanel = scanPanel(panelApp(true));
eq('paused scan panel offers RESUME', />RESUME SCANNING</.test(pausedPanel), true);
eq('paused scan panel does not offer STOP', />STOP SCANNING</.test(pausedPanel), false);
eq('paused scan panel says paused', /paused/i.test(pausedPanel), true);

// --- backend switch resets the tip gate ---------------------------------
wallet.fullScanTip = 973263;
wallet.watchTip = 973263;
wallet.scan.lastPass = Date.now();
wallet.scan.lastTip = 973263;
wallet.resetScan();
eq('backend switch clears the demo full-scan tip', wallet.fullScanTip, null);
eq('backend switch clears the watched tip', wallet.watchTip, null);
eq('backend switch forces a cold pass', wallet.cold, true);
eq('backend switch forces the next refresh', wallet.forceWatch, true);
eq('backend switch names the reason', /cold scan/.test(wallet.scan.note), true);
eq('backend switch clears the old pass time', wallet.scan.lastTip, null);

// The Rust API answers /v1/events with a bare array; the wallet expects the
// same {events} shape DemoBackend returns. Do not let live History go blank.
const { IndexerClient } = await import('../js/wallet/backend.js');
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify([
  { height: 112, block_hash: '00', action: { kind: 'settle', frogger_sat: 5, outcome: 'dead' } },
]), { status: 200, headers: { 'content-type': 'application/json' } });
const liveEvents = await new IndexerClient('http://indexer.test').events(5);
globalThis.fetch = realFetch;
eq('live events are wrapped for History', liveEvents.events.length, 1);
eq('live settle keeps its kind', liveEvents.events[0].action.kind, 'settle');

wallet.stop();

// --- F-11: a vault is not "created" unless the ciphertext persists --------
{
  const original = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error('quota exceeded'); };
  let failed = null;
  try {
    await createVault({
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      password: 'test-password', network: 'regtest', fingerprint: '00000000',
    });
  } catch (e) { failed = e; }
  globalThis.localStorage.setItem = original;
  eq('storage denial is a vault error', /could not be stored/.test(failed?.message || ''), true);
  eq('storage denial leaves no vault', settingsStore.has('hopper.vault.v1'), false);
}

console.log(`scan: ${checks} checks passed`);
