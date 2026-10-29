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

wallet.stop();
console.log(`scan: ${checks} checks passed`);
