// Pins the ported FROGGER scan policy: a full gap walk only on a cold
// start/rescan/extend, a 6–10 script warm plan for every new block, and a
// tip gate that asks the chain NOTHING while the tip is unchanged.

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
  GAP_LIMIT, DEFAULT_SETTINGS, WalletSession, loadSettings,
  buildWatchPlan, shouldSkipChange, failureBackoffMs, isPublicEndpoint,
  isUnconfirmedUtxo,
} = await import('../js/wallet/wallet.js');

let checks = 0;
function eq(what, got, want) {
  assert.deepEqual(got, want, `${what}\n got: ${JSON.stringify(got)}\nwant: ${JSON.stringify(want)}`);
  checks++;
}

// --- settings migration ---------------------------------------------------
const migrated = loadSettings();
eq('legacy gap becomes a persisted extension', migrated.gapExtra, 30);
eq('effective gap keeps the old window', migrated.gap, 50);

// --- warm plan ------------------------------------------------------------
eq('warm plan is small and exact', buildWatchPlan({
  lastUsed: { 0: 5, 1: 2 }, receiveFloor: 7, hot: [[0, 2], [1, 9]],
}), [[0, 2], [0, 6], [0, 7], [0, 8], [1, 2], [1, 3], [1, 4], [1, 9]]);

eq('fresh wallet change skip', shouldSkipChange(false, false, 0, 0), true);
eq('rescan never skips change', shouldSkipChange(true, false, 0, 0), false);
eq('a used receive address keeps change in scope', shouldSkipChange(false, true, 0, 0), false);
eq('a rotated receive address keeps change in scope', shouldSkipChange(false, false, 1, 0), false);
eq('a restored balance keeps change in scope', shouldSkipChange(false, false, 0, 1), false);

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
eq('backoff 1', failureBackoffMs(1), 5_000);
eq('backoff 2', failureBackoffMs(2), 10_000);
eq('backoff 7', failureBackoffMs(7), 300_000);
eq('backoff clamps high counts', failureBackoffMs(99), 300_000);

// --- integration: cold walk, tip gate, warm pass --------------------------
class FakeBackend {
  constructor(tip = 100) {
    this.tip = tip;
    this.tipCalls = 0;
    this.historyCalls = 0;
    this.utxoCalls = 0;
  }
  async tipHeight() { this.tipCalls += 1; return this.tip; }
  async tipHash() { throw new Error('tip hash must not be needed for the gate'); }
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
  settings: { ...DEFAULT_SETTINGS, mode: 'demo', gap: GAP_LIMIT, gapExtra: 0 },
});
const fake = new FakeBackend(100);
wallet.backend = fake;
wallet._autoSync = false;

await wallet.refresh({ force: true });
eq('cold pass walked receive only (fresh wallet skips change)', fake.historyCalls, 24);
eq('cold plan queried every reached script', fake.utxoCalls, 27);
eq('cold pass records the tip gate', wallet.fullScanTip, 100);
eq('cold pass sets the watched tip', wallet.watchTip, 100);
eq('cold pass is not partial', wallet.scan.partial, false);

const beforeGate = { h: fake.historyCalls, u: fake.utxoCalls, t: fake.tipCalls };
await wallet.refresh({ force: false });
eq('unchanged tip asks one tip question only', fake.tipCalls, beforeGate.t + 1);
eq('unchanged tip walks no history', fake.historyCalls, beforeGate.h);
eq('unchanged tip queries no addresses', fake.utxoCalls, beforeGate.u);

const beforeWarm = { h: fake.historyCalls, u: fake.utxoCalls };
fake.tip = 101;
await wallet.refresh({ force: false });
eq('new block runs no gap walk', fake.historyCalls, beforeWarm.h);
eq('new block asks the warm plan only', fake.utxoCalls - beforeWarm.u, 5);
eq('new block watches both guard indices', wallet.watchTip, 101);

const beforeForced = fake.utxoCalls;
await wallet.refresh({ force: true });
eq('a forced pass stays warm', fake.utxoCalls - beforeForced, 5);

// --- RESCAN ---------------------------------------------------------------
const beforeRescan = { h: fake.historyCalls, u: fake.utxoCalls };
await wallet.startRescan();
eq('rescan walks both branches even when receive is empty', fake.historyCalls - beforeRescan.h, 48);
eq('rescan has no progress line when finished', wallet.scan.rescan, null);
eq('rescan re-arms the gate', wallet.fullScanTip, 101);

// --- EXTEND ---------------------------------------------------------------
await wallet.extendGap(5);
eq('extend grows the effective window', wallet.gapLimit(), 25);
eq('extend re-walks the wider gap', fake.utxoCalls > beforeRescan.u, true);
eq('extend re-arms the gate', wallet.fullScanTip, 101);
const savedSettings = JSON.parse(settingsStore.get('hopper.settings.v1'));
eq('extend persists the extension', savedSettings.gapExtra, 5);
const savedLedger = JSON.parse(settingsStore.get(`hopper.ledger.${wallet.fingerprint}.v1`));
eq('the gate tip persists with the ledger', savedLedger.fullScanTip, 101);
eq('the warm plan state persists with the ledger', savedLedger.hot, []);

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
eq('mempool output adds only the normal warm plan', mempoolAddressCalls, 5);
eq('mempool output adds no gap/history walk', fake.historyCalls, beforeMempool.h);
eq('mempool output is tracked', wallet.mempool.length, 1);
eq('mempool output keeps its txid', wallet.mempool[0].txid, memTxid);
eq('mempool output keeps its amount', wallet.mempool[0].amount, 1234);
eq('mempool output is flagged on the coin', wallet.utxos[0].unconfirmed, true);
eq('mempool total is in the balance summary', String(wallet.balance.pending), '1234');
const savedMempool = JSON.parse(settingsStore.get(`hopper.ledger.${wallet.fingerprint}.v1`));
eq('mempool rows persist with the ledger', savedMempool.mempool[0].txid, memTxid);
eq('the pending total persists with the ledger', savedMempool.balance.pending, '1234');

// A paid receive address retires immediately, even while the payment is
// still in the mempool. The next pass is forced once so the new address is
// watched; after that the tip gate is quiet again.
eq('a paid receive address rotates automatically', wallet.receiveIndex, 1);
eq('the paid receive address is marked used', wallet.used[receive0.address], true);
eq('the rotated address is not marked used', !!wallet.used[wallet.keys.receive(1).address], false);
const afterMempool = mempoolAddressCalls;
await wallet.refresh({ force: false });
eq('rotation queues one warm pass for the new address', mempoolAddressCalls > afterMempool, true);
const afterRotationPass = mempoolAddressCalls;
await wallet.refresh({ force: false });
eq('an unchanged tip is quiet again after rotation', mempoolAddressCalls, afterRotationPass);

fake.tip = 103;
await wallet.refresh({ force: false });
eq('a payment to an older address does not rotate the current one', wallet.receiveIndex, 1);
eq('the known mempool row survives the tip gate', wallet.mempool.length, 1);

// Rotation never lands on a known-paid address. If every index in the old
// window is exhausted, continue the derivation beyond it rather than reuse.
const rotate = new WalletSession({
  mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  network: 'regtest',
  settings: { ...DEFAULT_SETTINGS, mode: 'demo', gap: GAP_LIMIT, gapExtra: 0 },
});
rotate.receiveIndex = 0;
rotate.receiveHistory = [rotate.keys.receive(0).address];
rotate.used = { [rotate.keys.receive(1).address]: true };
eq('rotation skips a paid address even without scan history', rotate._advanceReceiveAddress().index, 2);
const exhausted = new WalletSession({
  mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
  network: 'regtest',
  settings: { ...DEFAULT_SETTINGS, mode: 'demo', gap: GAP_LIMIT, gapExtra: 0 },
});
exhausted.receiveIndex = GAP_LIMIT - 1;
exhausted.receiveHistory = Array.from({ length: GAP_LIMIT }, (_, i) => exhausted.keys.receive(i).address);
exhausted.used = Object.fromEntries(exhausted.receiveHistory.map((a) => [a, true]));
eq('exhausted rotation advances past the old window', exhausted._advanceReceiveAddress().index, GAP_LIMIT);

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
eq('public source polls a wallet while in flight', wallet.tickIntervalMs(), 15_000);
fake.getTx = async () => ({ status: { confirmed: true, block_height: 101 } });
await wallet._reconcilePending(101);
eq('a confirmed broadcast leaves the pending set', wallet.pending.length, 0);
eq('an idle public source drops to 10 minutes', wallet.tickIntervalMs(), 600_000);
wallet.fails = 2;
eq('a failed public pass backs off', wallet.tickIntervalMs(), 10_000);

// --- STOP a paced public rescan ------------------------------------------
wallet.fails = 0;
wallet.fullScanTip = 101;
const slow = wallet.startRescan();
await new Promise((resolve) => setTimeout(resolve, 60));
wallet.cancelRescan();
await slow;
eq('a cancelled rescan does not claim the gap was walked', wallet.fullScanTip, null);
eq('a cancelled rescan clears the progress line', wallet.scan.rescan, null);
eq('a cancelled rescan says it stopped', /rescan stopped/.test(wallet.scan.note), true);

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
console.log(`scan: ${checks} checks passed`);
