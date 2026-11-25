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
  failureBackoffMs, isPublicEndpoint, isUnconfirmedUtxo, STAGED_RANGE_TRIES,
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

// --- coinbase maturity and broadcast coin hygiene -------------------------
{
  // A different mnemonic keeps this session's ledger out of the main one's.
  const w2 = new WalletSession({
    mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
    network: 'regtest',
    settings: { ...DEFAULT_SETTINGS, mode: 'demo' },
  });
  const coinTxid = 'cd'.repeat(32);
  const cb = (height, over = {}) => ({
    txid: coinTxid, vout: 0, value: 5000000000,
    script: w2.keys.receive(0).script, address: w2.keys.receive(0).address,
    kind: 'p2wpkh', exact: true, spendable: true, frogs: [],
    ranges: [[9000000, 9000000 + 5000000000 - 1]],
    key: w2.keys.receive(0), keyRef: { branch: 0, index: 0 },
    status: { confirmed: true, block_height: height },
    unconfirmed: false, ...over,
  });
  class CoinbaseBackend extends FakeBackend {
    async addressUtxos() { return [cb(151)]; }
    async getTxHex() {
      // A real coinbase transaction: one all-zero prevout, one output.
      return '01000000' + '01' + '00'.repeat(32) + 'ffffffff' + '00' + 'ffffffff'
        + '01' + '00f2052a01000000' + '00' + '00000000';
    }
  }
  w2.backend = new CoinbaseBackend(200);
  w2._autoSync = false;
  w2.utxos = [cb(151)];
  await w2._classifyCoinbases({ tip: 200 });
  eq('a coinbase coin is classified', w2.utxos[0].coinbase, true);
  eq('an immature coinbase is unspendable', w2.utxos[0].spendable, false);
  eq('the maturity countdown is exact', w2.utxos[0].maturity, { required: 100, confirms: 50, remaining: 50 });
  eq('an immature coinbase is out of the funding pool', w2._funding(), []);
  await w2._classifyCoinbases({ tip: 260 });
  eq('a matured coinbase returns to the funding pool', w2._funding().length, 1);
  eq('the maturity countdown clears', w2.utxos[0].maturity, undefined);

  // The same classification must ignore a plain transaction.
  class PlainBackend extends CoinbaseBackend {
    async getTxHex() {
      return '01000000' + '01' + '11'.repeat(32) + '00000000' + '00' + 'ffffffff'
        + '01' + '00f2052a01000000' + '00' + '00000000';
    }
  }
  const w3 = new WalletSession({
    mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
    network: 'regtest',
    settings: { ...DEFAULT_SETTINGS, mode: 'demo' },
  });
  w3.backend = new PlainBackend(200);
  w3._autoSync = false;
  w3.utxos = [cb(151)];
  await w3._classifyCoinbases({ tip: 200 });
  eq('a plain funding tx is not a coinbase', w3.utxos[0].coinbase, undefined);
  eq('a plain funding tx stays spendable', w3.utxos[0].spendable, true);

  // A broadcast must drop its own spent outpoints at once, or a second
  // send before the next scan rebuilds a conflicting transaction.
  const spendHex = '02000000' + '01' + Buffer.from(coinTxid, 'hex').reverse().toString('hex')
    + '00000000' + '00' + 'ffffffff' + '01' + '40420f0000000000' + '00' + '00000000';
  const other = { ...cb(151), txid: 'ee'.repeat(32), vout: 1 };
  w2.utxos = [cb(151), other];
  w2._coinbaseTxs = new Map();
  w2._computeBalance();
  const totalBefore = w2.balance.total;
  w2._dropSpentCoins(spendHex);
  eq('the broadcast input leaves the coin set at once', w2.utxos.length, 1);
  eq('the untouched coin stays', w2.utxos[0].txid, other.txid);
  eq('the balance follows the dropped coin', String(w2.balance.total), String(totalBefore - 5000000000n));
  w2._dropSpentCoins('zz');
  eq('unparsable hex marks nothing', w2.utxos.length, 1);

  // An imported sat (recovery import, no frog record) can sit inside an
  // ordinary plain coin. The wallet must attribute it to the coin: hold it
  // out of plain funding and bucket it with the cards — otherwise coin
  // selection keeps offering the coin and the last-line protection refuses
  // every send with a cryptic error while the GUI shows a healthy balance.
  const w4 = new WalletSession({
    mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
    network: 'regtest',
    settings: { ...DEFAULT_SETTINGS, mode: 'demo' },
  });
  w4.backend = new FakeBackend(200);
  w4._autoSync = false;
  const carrier = { ...cb(151), ranges: [[9000000, 9000000 + 5000000000 - 1]] };
  w4.utxos = [carrier];
  w4.imported = new Set([9000010]); // a sat inside the carrier's range
  w4._tagImportedSats();
  eq('a coin carrying an imported sat loses spendable', w4.utxos[0].spendable, false);
  eq('the imported sat is named on the coin', JSON.stringify(w4.utxos[0].importedSats), '[9000010]');
  eq('a coin carrying an imported sat is not plain funding', w4._funding().length, 0);
  w4._computeBalance();
  eq('an imported-sat coin is bucketed as a card, not spendable', String(w4.balance.cards), String(w4.balance.total));
  eq('an imported-sat coin adds nothing to spendable', String(w4.balance.spendable), '0');
  // A coin that does not carry it stays plain funding.
  const clean = { ...cb(151), txid: 'ff'.repeat(32), ranges: [[10000000, 10000000 + 5000000000 - 1]] };
  w4.utxos = [carrier, clean];
  w4._tagImportedSats();
  eq('an untouched coin stays funding-eligible', w4._funding().length, 1);
  eq('the clean coin keeps spendable', w4.utxos[1].spendable, true);
}

// --- in-flight mints ------------------------------------------------------
// A mint is broadcast, but the reveal output is not attributable until the
// indexer/ord sees it. The pending package is dropped the moment the reveal
// goes out, so the ledger must remember the sat on its own: otherwise the
// pond shows nothing at all for the whole confirmation window.
{
  const w5 = new WalletSession({
    mnemonic: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
    network: 'regtest',
    settings: { ...DEFAULT_SETTINGS, mode: 'demo' },
  });
  w5.backend = new FakeBackend(300);
  w5._autoSync = false;
  const sat5 = 612345678901;
  const ledgerKey = `hopper.ledger.${w5.fingerprint}.v1`;
  w5._addInflightMint({ sat: sat5, seed: 4242, name: 'In Flight Frog',
    commitTxid: 'AA'.repeat(32), revealTxid: 'BB'.repeat(32) });
  eq('an in-flight mint is remembered', w5.inflightMints.length, 1);
  eq('the in-flight sat is a number', w5.inflightMints[0].sat, sat5);
  eq('the in-flight txids are lowercase', w5.inflightMints[0].revealTxid, 'bb'.repeat(32));
  const saved5 = JSON.parse(settingsStore.get(ledgerKey));
  eq('the in-flight mint persists with the ledger', saved5.inflightMints[0].sat, sat5);
  eq('the persisted seed survives', saved5.inflightMints[0].seed, 4242);

  // Re-adding the same sat replaces the row instead of duplicating it.
  w5._addInflightMint({ sat: sat5, seed: 4242, name: 'In Flight Frog',
    commitTxid: 'AA'.repeat(32), revealTxid: 'CC'.repeat(32) });
  eq('the same sat is not duplicated', w5.inflightMints.length, 1);
  eq('the newest reveal txid wins', w5.inflightMints[0].revealTxid, 'cc'.repeat(32));
  // A non-integer sat is ignored outright.
  w5._addInflightMint({ sat: 'nope', seed: 1, name: 'x' });
  eq('a non-integer sat is ignored', w5.inflightMints.length, 1);

  // The pond paints an INSCRIBING placeholder while the sat is undiscovered.
  // The reveal output itself is unconfirmed on the ord address — that is what
  // makes the placeholder owned before the frogger record exists.
  const reveal5 = 'cc'.repeat(32);
  w5.inflightMints[0].revealTxid = reveal5;
  w5.backend.addressUtxos = async (address) => (address === w5.keys.ordInfo().address
    ? [{ txid: reveal5, vout: 0, value: 1000, status: { confirmed: false } }]
    : []);
  await w5.refresh({ force: true });
  const placed = w5.frogs.find((f) => Number(f.sat) === sat5);
  eq('the in-flight mint owns a pond slot', !!placed, true);
  eq('the placeholder is marked commit_pending', placed && placed.commit_pending, true);
  eq('the placeholder carries the name', placed && placed.name, 'In Flight Frog');
  eq('the placeholder points at the reveal txid', placed && placed.mint_txid, reveal5);

  // Discovery retires the row; a stale row expires at six hours.
  w5._pruneInflightMints(new Set([sat5]));
  eq('a discovered mint leaves the in-flight list', w5.inflightMints.length, 0);
  const oldSat = 612345678902;
  w5._addInflightMint({ sat: oldSat, seed: 7, name: 'Stale Frog',
    commitTxid: 'DD'.repeat(32), revealTxid: 'EE'.repeat(32) });
  w5.inflightMints[0].at = Date.now() - 7 * 60 * 60 * 1000;
  w5._pruneInflightMints(new Set());
  eq('a seven-hour-old in-flight mint expires', w5.inflightMints.length, 0);

  // The list is bounded: a wallet cannot accumulate unbounded placeholders.
  for (let i = 0; i < 20; i++) {
    w5._addInflightMint({ sat: sat5 + 1000 + i, seed: i, name: `F${i}`,
      commitTxid: 'AA'.repeat(32), revealTxid: reveal5 });
  }
  eq('the in-flight list is capped', w5.inflightMints.length, 12);
  eq('the newest mint is first', w5.inflightMints[0].name, 'F19');

  // A reload restores the list from the ledger and the pond stays populated.
  const w6 = new WalletSession({
    mnemonic: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
    network: 'regtest',
    settings: { ...DEFAULT_SETTINGS, mode: 'demo' },
  });
  w6.backend = new FakeBackend(300);
  w6._autoSync = false;
  eq('a reload restores the in-flight mints', w6.inflightMints.length, 12);
  await w6.refresh({ force: true });
  // Reload: same unconfirmed reveal output must be visible to the fake chain.
  w6.backend.addressUtxos = w5.backend.addressUtxos;
  await w6.refresh({ force: true });
  eq('a reloaded pond still shows an in-flight mint',
    w6.frogs.some((f) => f.commit_pending), true);
  eq('the restored placeholder keeps a name',
    /^F\d+$/.test(String(w6.frogs.find((f) => f.commit_pending)?.name || '')), true);
}


// --- API-courtesy scheduler (2026-11: rate-limit fixes) --------------------
{
  const w = new WalletSession({
    mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    network: 'regtest',
    settings: { ...DEFAULT_SETTINGS, mode: 'demo' },
  });
  const fb = new FakeBackend(500);
  w.backend = fb;
  w._autoSync = false;
  await w.refresh({ force: true });
  const utxosBefore = fb.utxoCalls;

  // (2) No record source configured -> no catch-up burst. Imported sats
  //     without records must NOT keep recheck passes alive per tip.
  fb.recordSourceAvailable = false; // mirrors a live backend with no indexer
  w.imported.add(424_242);          // an owned sat no record will ever cover
  fb.tip = 501; fb.hash = '11'.repeat(32);
  await w.refresh({ force: false, auto: true });
  const grace = w._recheckLeft;     // 2 from the new tip, by design
  await w.refresh({ force: false, auto: true });
  await w.refresh({ force: false, auto: true });
  await w.refresh({ force: false, auto: true });
  eq('no indexer: the catch-up window closes after the grace passes',
    w._recheckLeft, 0);
  eq('no indexer: nothing extends the sweep past the grace window',
    fb.utxoCalls - utxosBefore > 0, true);
  const afterCatchup = fb.utxoCalls;
  await w.refresh({ force: false, auto: true });
  eq('no indexer: the settled tip asks nothing again', fb.utxoCalls, afterCatchup);

  // (3) In-flight cheap watch: a pending tx at an unchanged tip costs no
  //     address queries and no range-oracle queries.
  fb.recordSourceAvailable = undefined; // restore generic backend
  w.pending = [{ txid: '22'.repeat(32), at: Date.now(), kind: 'send' }];
  const uBefore = fb.utxoCalls;
  await w.refresh({ force: false, auto: true });
  eq('in-flight pass at an unchanged tip asks no addresses', fb.utxoCalls, uBefore);
  eq('the in-flight note says so', /in flight/.test(w.scan.note), true);
  w.pending = [];

  // (4) The focus wake is floored; block pushes are not.
  w.scan.lastPass = Date.now() - 5_000;
  eq('a focus wake right after a pass waits out the floor',
    w._wakeDelayMs('focus') > 30_000, true);
  eq('a block wake is immediate', w._wakeDelayMs('block'), 250);
  w.scan.lastPass = Date.now() - 120_000;
  eq('a focus wake after a quiet stretch is immediate',
    w._wakeDelayMs('focus'), 250);
}


// --- range cache: ask the range oracle once per outpoint, ever -----------
//
// The chain adapter is the only thing polled about existence; sat ranges are
// immutable for a live outpoint, so a verified answer is reused across
// passes, rechecks and reloads, and only new/spent outpoints touch ord.

{
  const { RangeCache, normalizeRanges, outpointKey } = await import('../js/wallet/rangecache.js');
  const { RANGE_ASK_BURST, RANGE_BACKLOG_TICK_MS } = await import('../js/wallet/wallet.js');

  // Validation: only provably exact answers are cacheable.
  eq('valid ranges normalize', normalizeRanges([[0, 1000]], 1000), [[0, 1000]]);
  eq('a short sum is rejected', normalizeRanges([[0, 999]], 1000), null);
  eq('overlapping ranges are rejected', normalizeRanges([[0, 600], [500, 1000]], 1100), null);
  eq('unordered ranges are rejected', normalizeRanges([[500, 1000], [0, 500]], 1000), null);
  eq('an empty answer is rejected', normalizeRanges([], 1000), null);
  eq('outpoint keys normalize txid case', outpointKey('AB'.repeat(32), 3), `${'ab'.repeat(32)}:3`);
  eq('a malformed txid has no key', outpointKey('nope', 0), null);

  const lru = new RangeCache();
  for (let i = 0; i < 5; i += 1) {
    lru.put('ab'.repeat(32), i, { value: 10, ranges: [[0, 10]] });
    lru.entries.get(`${'ab'.repeat(32)}:${i}`).t = 1000 + i;
  }
  eq('LRU evicts down to the cap', (lru.prune(3), lru.size), 3);
  eq('LRU keeps the newest entries', [...lru.entries.keys()].sort(),
    [`${'ab'.repeat(32)}:2`, `${'ab'.repeat(32)}:3`, `${'ab'.repeat(32)}:4`].sort());

  // A backend with real live outputs and a counted range oracle.
  class RangeBackend {
    constructor() {
      this.tip = 200;
      this.hash = 'aa'.repeat(32);
      this.live = new Map();   // address -> [{txid, vout, value}]
      this.ranges = new Map(); // "txid:vout" -> [[start, end)] (exclusive)
      this.rangeCalls = 0;
      this.utxoCalls = 0;
      this.failAddress = null;
      this.throwOnRange = false;
      this.exact = true;
      this.unproven = new Set();
      this.ord = null;
      this.indexer = null;
    }
    async tipHeight() { return this.tip; }
    async tipHash() { return this.hash; }
    async addressHistory() { return []; }
    async addressUtxos(address) {
      this.utxoCalls += 1;
      if (this.failAddress === address) throw new Error('index down');
      return (this.live.get(address) || []).map((u) => ({ ...u, status: { confirmed: true } }));
    }
    async utxo(txid, vout) {
      this.rangeCalls += 1;
      if (this.throwOnRange) throw new Error('ord 429');
      const ranges = this.ranges.get(outpointKey(txid, vout));
      if (!ranges) return null;
      const exact = this.exact !== false && !this.unproven.has(outpointKey(txid, vout));
      return { value: ranges.value, ranges: ranges.ranges, exact, frogs: [] };
    }
    add(address, txid, vout, value, ranges) {
      const list = this.live.get(address) || [];
      list.push({ txid, vout, value });
      this.live.set(address, list);
      this.ranges.set(outpointKey(txid, vout), { value, ranges });
    }
    spend(address, txid, vout) {
      this.live.set(address, (this.live.get(address) || [])
        .filter((u) => !(u.txid === txid && Number(u.vout) === Number(vout))));
    }
    async frogger() { return null; }
    async froggers() { return { items: [] }; }
    async events() { return { events: [] }; }
    async getTx() { return null; }
    async broadcast() { throw new Error('not used'); }
    async leaderboard() { return { entries: [] }; }
    async road() { return { active: [] }; }
  }

  const mnemonic = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
  const mk = (settings = {}) => {
    const w = new WalletSession({
      mnemonic, network: 'regtest',
      settings: { ...DEFAULT_SETTINGS, mode: 'demo', ...settings },
    });
    w._autoSync = false;
    return w;
  };
  let rc = mk();
  let rb = new RangeBackend();
  rc.backend = rb;
  rc.publicSource = false; // local node: no ask ceiling
  const ordAddr = rc.keys.frogAddress();
  const recv = rc.keys.receive(0).address;
  const change = rc.keys.change(0).address;
  const t1 = '11'.repeat(32);
  const t2 = '22'.repeat(32);
  rb.add(recv, t1, 0, 1000, [[0, 1000]]);
  rb.add(recv, t2, 1, 2000, [[1000, 3000]]);

  await rc.refresh({ force: true });
  eq('cold pass asks the oracle once per live coin', rb.rangeCalls, 2);
  eq('cold pass caches both coins', rc.rangeCache.size, 2);
  eq('cold pass reports the asks', rc.rangeStats.asked, 2);
  eq('cache counters are visible in scan state', rc.scanState().ranges.cached, 2);

  // The big win: a new tip runs three passes and a settled wallet asks ord
  // NOTHING. Existence still comes from the chain adapter.
  rb.tip = 201;
  rb.hash = 'bb'.repeat(32);
  const addrBefore = rb.utxoCalls;
  await rc.refresh({ force: false, auto: true });
  await rc.refresh({ force: false, auto: true });
  await rc.refresh({ force: false, auto: true });
  eq('a new tip still walks the address set', rb.utxoCalls - addrBefore, 9);
  eq('a new tip asks the range oracle nothing', rb.rangeCalls, 2);
  eq('the pass reports cache hits', rc.rangeStats.hits, 2);
  eq('the pass reports no new asks', rc.rangeStats.asked, 0);

  // A new coin is asked exactly once, then served from the cache by the
  // index-catch-up passes at the same tip.
  const t3 = '33'.repeat(32);
  rb.add(change, t3, 0, 500, [[5000, 5500]]);
  rb.tip = 202;
  rb.hash = 'cc'.repeat(32);
  await rc.refresh({ force: false, auto: true });
  await rc.refresh({ force: false, auto: true });
  await rc.refresh({ force: false, auto: true });
  eq('a new outpoint costs exactly one oracle ask', rb.rangeCalls, 3);
  eq('the new coin is cached', rc.rangeCache.size, 3);

  // Spent: a complete answer evicts the outpoint.
  rb.spend(recv, t1, 0);
  rb.tip = 203;
  rb.hash = 'dd'.repeat(32);
  const spentCalls = rb.rangeCalls;
  await rc.refresh({ force: false, auto: true });
  eq('a spent coin is evicted', rc.rangeCache.get(t1, 0), null);
  eq('eviction costs no oracle ask', rb.rangeCalls, spentCalls);
  eq('the surviving coins stay cached', rc.rangeCache.size, 2);

  // Partial pass: absence is not evidence.
  rb.failAddress = recv;
  rb.spend(recv, t2, 1);
  rb.tip = 204;
  rb.hash = 'ee'.repeat(32);
  await rc.refresh({ force: false, auto: true }).catch(() => {});
  eq('a failed address pass keeps its cached coins', rc.rangeCache.get(t2, 1) !== null, true);
  rb.failAddress = null;

  // A value disagreement is a corrupt entry: drop it and ask again.
  const t3key = outpointKey(t3, 0);
  rc.rangeCache.entries.get(t3key).v = 999999;
  rb.tip = 205;
  rb.hash = 'ff'.repeat(32);
  const beforeMismatch = rb.rangeCalls;
  await rc.refresh({ force: false, auto: true });
  eq('a value mismatch re-asks the oracle', rb.rangeCalls, beforeMismatch + 1);
  eq('the re-ask repairs the entry', rc.rangeCache.get(t3, 0).v, 500);

  // Reliability: 429s are retried, then left uncached (never poisoned).
  const t4 = '44'.repeat(32);
  rb.add(recv, t4, 0, 700, [[7000, 7700]]);
  rb.throwOnRange = true;
  rb.tip = 206;
  rb.hash = 'ab'.repeat(32);
  await rc.refresh({ force: false, auto: true });
  eq('a failing oracle is retried three times', rb.rangeCalls, beforeMismatch + 1 + 3);
  eq('a failed answer is not cached', rc.rangeCache.get(t4, 0), null);
  rb.throwOnRange = false;

  // Persistence: a reload answers from the cache, no oracle traffic.
  rc._saveRangeCache(true);
  const reloaded = mk();
  const rb2 = new RangeBackend();
  rb2.tip = rb.tip;
  rb2.hash = rb.hash;
  rb2.live = new Map([...rb.live].map(([k, v]) => [k, v.map((u) => ({ ...u }))]));
  rb2.ranges = new Map(rb.ranges);
  reloaded.backend = rb2;
  reloaded.publicSource = false;
  // Only the change coin survives: the spent receive coins were evicted by
  // the complete passes that followed, exactly as they should be.
  eq('a reloaded session loads the cache', reloaded.rangeCache.size, 1);
  await reloaded.refresh({ force: true });
  // Two live coins are known from the reloaded cache; the coin whose ask
  // failed before the reload is the only one asked.
  eq('a reloaded cold pass asks only the uncached coin', rb2.rangeCalls, 1);

  // RESCAN is the rebuild escape hatch: clear the cache, refill the budget.
  const beforeRescan = rb2.rangeCalls;
  await reloaded.startRescan();
  eq('a rescan clears the cache first', reloaded.rangeCache.size >= 2, true);
  eq('a rescan re-asks every live coin', rb2.rangeCalls - beforeRescan, 2);

  // Ask budget: a public source fills a cold cache in tranches.
  const budget = mk();
  const rb3 = new RangeBackend();
  budget.backend = rb3;
  budget.publicSource = true;
  const many = '55'.repeat(32);
  for (let i = 0; i < 30; i += 1) {
    rb3.add(budget.keys.receive(0).address, many, i, 1000, [[i * 1000, i * 1000 + 1000]]);
  }
  await budget.refresh({ force: true });
  eq('the ask budget caps one tranche', rb3.rangeCalls, RANGE_ASK_BURST);
  eq('the rest is queued as backlog', budget._rangeBacklog, 30 - RANGE_ASK_BURST);
  eq('a backlog shortens the next pass', budget.tickIntervalMs(), RANGE_BACKLOG_TICK_MS);
  const firstTranche = rb3.rangeCalls;
  await budget.refresh({ force: false, auto: true });
  eq('a second pass without refill asks nothing', rb3.rangeCalls, firstTranche);
  budget._rangeBudget.at = Date.now() - 2_600; // one token is 2.5 s
  await budget.refresh({ force: false, auto: true });
  eq('refilled tokens drain the backlog one at a time', rb3.rangeCalls, firstTranche + 1);

  // Cooldown: ask nothing while ord is backing off, and do not queue work.
  const cool = mk();
  const rb4 = new RangeBackend();
  rb4.ord = { backoffMs: 5000 };
  cool.backend = rb4;
  cool.publicSource = true;
  rb4.add(cool.keys.receive(0).address, '66'.repeat(32), 0, 1000, [[0, 1000]]);
  await cool.refresh({ force: true });
  eq('a cooling-down oracle is not asked', rb4.rangeCalls, 0);
  eq('a cooling-down oracle creates no backlog', cool._rangeBacklog, 0);

  // Rollback flag: the pre-cache behaviour, on demand.
  const old = mk({ rangeCache: false });
  const rb5 = new RangeBackend();
  old.backend = rb5;
  old.publicSource = false;
  rb5.add(old.keys.receive(0).address, '77'.repeat(32), 0, 1000, [[0, 1000]]);
  await old.refresh({ force: true });
  rb5.tip += 1;
  rb5.hash = 'bc'.repeat(32);
  await old.refresh({ force: false, auto: true });
  await old.refresh({ force: false, auto: true });
  await old.refresh({ force: false, auto: true });
  eq('with the cache off every pass asks again', rb5.rangeCalls, 4); // cold + 3 passes
  eq('with the cache off nothing is stored', old.rangeCache.size, 0);

  // Solution 2: PREPARE seeds the state outpoint it just built. Warm passes
  // watch the derived state script from then on (the old code only looked on
  // a cold/forced pass, so the Hopper vanished from The Road); HOP stays
  // fail-closed until ranges are proven, and that one question is retried
  // within the backlog cadence instead of waiting for the next block.
  const stg = mk();
  const rb6 = new RangeBackend();
  stg.backend = rb6;
  stg.publicSource = false;
  const stateTxid = '88'.repeat(32);
  const stagedFrog = { sat: 4_242, mint_txid: '99'.repeat(32), mint_index: 0 };
  const seeded = stg._seedStaged(stagedFrog, { txid: stateTxid, vout: 0, value: 25_000 });
  eq('staging seeds the state outpoint immediately',
    !!(seeded && seeded.txid === stateTxid && seeded.provisional === true), true);
  eq('the seeded script joins the watch set', stg.scanState().watch.staged, 1);

  rb6.live.set(seeded.address, [{ txid: stateTxid, vout: 0, value: 25_000 }]);
  const beforeStagedAsk = rb6.rangeCalls;
  await stg.refresh({ force: true });
  eq('a warm pass asks the chain about the seeded script', rb6.rangeCalls, beforeStagedAsk + 1);
  eq('an unanswered staged coin is retried soon', stg._rangeBacklog, 1);
  eq('the staged entry stays provisional without ranges', stg.staged['4242'].provisional, true);

  rb6.ranges.set(outpointKey(stateTxid, 0), { value: 25_000, ranges: [[0, 25_000]] });
  const provenStats = { hits: 0, asked: 0, misses: 0, backlog: 0 };
  const proven = await stg._rangeAnswers(
    [{ txid: stateTxid, vout: 0, value: 25_000 }], provenStats, seeded.address);
  eq('a proven ranged answer clears the provisional flag', stg.staged['4242'].provisional, false);
  eq('the proven answer carries the ranges', proven[0]?.ranges?.length, 1);
  eq('the proven answer is counted as an ask', provenStats.asked, 1);

  // --- adversarial: `provisional` must mean "not proven" ------------------
  const fresh = (settings = {}) => {
    for (const k of [...settingsStore.keys()]) {
      if (k.startsWith('hopper.ledger.') || k.startsWith('hopper.ranges.')) settingsStore.delete(k);
    }
    return mk(settings);
  };
  const seedFrog = (w, sat, txid, value = 25_000) =>
    ({ frog: { sat, mint_txid: '99'.repeat(32), mint_index: 0 },
      row: w._seedStaged({ sat, mint_txid: '99'.repeat(32), mint_index: 0 },
        { txid, vout: 0, value }) });

  // 1. An answer that cannot be proven exact is not proof. Clearing the flag
  //    here would stop the retry with a coin HOP still refuses to spend.
  const unproven = fresh();
  const rb7 = new RangeBackend();
  unproven.backend = rb7;
  unproven.publicSource = false;
  const uTxid = 'ab'.repeat(32);
  const uSat = 7_777;
  const uRow = seedFrog(unproven, uSat, uTxid).row;
  rb7.add(uRow.address, uTxid, 0, 25_000, [[0, 25_000]]);
  rb7.exact = false;
  await unproven.refresh({ force: true });
  eq('an unproven answer keeps the card fail-closed', unproven.staged[String(uSat)].provisional, true);
  eq('an unproven answer keeps the retry alive', unproven._rangeBacklog, 1);
  eq('an unproven answer is not cached', unproven.rangeCache.size, 0);
  rb7.exact = true;
  await unproven.refresh({ force: false, auto: true }); // backlog bypasses the gate
  eq('a proven answer on the retry clears the flag', unproven.staged[String(uSat)].provisional, false);
  eq('the proven answer is cached', unproven.rangeCache.size, 1);

  // 2. The retry is bounded: a staged output no source can ever name must
  //    not leave a 15 s poll alive forever.
  const bounded = fresh();
  const rb8 = new RangeBackend();
  bounded.backend = rb8;
  bounded.publicSource = false;
  const bTxid = 'cd'.repeat(32);
  const bSat = 8_888;
  const bRow = seedFrog(bounded, bSat, bTxid).row;
  rb8.live.set(bRow.address, [{ txid: bTxid, vout: 0, value: 25_000 }]);
  const oneMiss = async () => {
    const st = { hits: 0, asked: 0, misses: 0, backlog: 0 };
    await bounded._rangeAnswers([{ txid: bTxid, vout: 0, value: 25_000 }], st, bRow.address);
    return st;
  };
  for (let i = 1; i <= STAGED_RANGE_TRIES; i += 1) {
    eq(`staged miss ${i}${i < STAGED_RANGE_TRIES ? ' is' : ' is the last one'} retried`,
      (await oneMiss()).backlog, i < STAGED_RANGE_TRIES ? 1 : 0);
  }
  eq('the retry counter stops at the bound',
    bounded.staged[String(bSat)].range_misses, STAGED_RANGE_TRIES);
  eq('past the bound the cadence is normal again', (await oneMiss()).backlog, 0);

  // 3. A proven state output clears the flag from the watch loop too (the
  //    range answer and the watch loop must agree).
  const watchClear = fresh();
  const rb9 = new RangeBackend();
  watchClear.backend = rb9;
  const wTxid = 'ef'.repeat(32);
  const wSat = 9_999;
  const wRow = seedFrog(watchClear, wSat, wTxid).row;
  rb9.add(wRow.address, wTxid, 0, 25_000, [[0, 25_000]]);
  await watchClear.refresh({ force: true });
  eq('a proven state utxo clears the flag on a pass',
    watchClear.staged[String(wSat)].provisional, false);

  // 4. The seed is persisted: a reload must watch the same state script and
  //    keep HOP fail-closed until ranges arrive.
  const seedStore = fresh();
  const rb10 = new RangeBackend();
  seedStore.backend = rb10;
  const rTxid = '12'.repeat(32);
  const rSat = 12_345;
  seedFrog(seedStore, rSat, rTxid);
  const reloadedSeed = mk();
  eq('a provisional row survives a reload', reloadedSeed.staged[String(rSat)]?.provisional, true);
  eq('the reloaded row is watched immediately', reloadedSeed.scanState().watch.staged, 1);

  // 5. `_seedStaged` is the only writer of this shape: refuse anything that
  //    is not a real outpoint instead of seeding a sweep for garbage.
  const guard = fresh();
  eq('a short txid is refused', guard._seedStaged({ sat: 4_242 }, { txid: 'ab' }), null);
  eq('a non-hex txid is refused', guard._seedStaged({ sat: 4_242 }, { txid: 'zz'.repeat(32) }), null);
  eq('a fractional sat is refused', guard._seedStaged({ sat: 1.5 }, { txid: '34'.repeat(32) }), null);
  eq('a zero sat is refused', guard._seedStaged({ sat: 0 }, { txid: '34'.repeat(32) }), null);
  eq('nothing was seeded', Object.keys(guard.staged).length, 0);

  // 6. The builder's script is the truth. A re-derivation that disagreed
  //    with the transaction would watch an address the coin never pays.
  const scriptSeed = fresh();
  const payload = new Uint8Array(34);
  payload[0] = 0x51; payload[1] = 0x20; payload.fill(7, 2);
  const sRow = scriptSeed._seedStaged({ sat: 5_555, mint_txid: '99'.repeat(32), mint_index: 0 },
    { txid: '56'.repeat(32), script: payload });
  eq('the builder script wins over a re-derivation', sRow?.script,
    [...payload].map((b) => b.toString(16).padStart(2, '0')).join(''));
  eq('the seeded address belongs to that script', /^bcrt1p/.test(sRow?.address || ''), true);

  // 7. A planted ledger is untrusted input: no prototype pollution, no
  //    malformed rows in the watch set, and a hard bound on the sweep list.
  const seededKey = fresh()._ledgerKey();
  const rows = {};
  for (let i = 1; i <= 305; i += 1) {
    // Make the five LOWEST sats the newest rows: the cap must be by age, not
    // by the numeric key.
    rows[String(1000 + i)] = {
      sat: 1000 + i, address: `bcrt1p${'q'.repeat(40)}`, script: '51',
      txid: 'aa'.repeat(32), vout: 0, seeded_at: 10_000 - i,
    };
  }
  settingsStore.set(seededKey, JSON.stringify({
    staged: {
      ...rows,
      'oops': { sat: 'x' },
      '12.5': { address: 5, script: null },
      '999': null,
      ['__proto__']: { sat: 1, address: 'x', script: '51' },
    },
  }));
  const planted = mk();
  eq('the watch list is capped at 300', Object.keys(planted.staged).length, 300);
  eq('the newest rows are the ones kept', '1001' in planted.staged, true);
  eq('the oldest rows are the ones dropped', '1305' in planted.staged, false);
  eq('malformed rows are dropped', Object.keys(planted.staged).filter((k) => !/^[0-9]+$/.test(k)).length, 0);
  eq('a __proto__ key does not pollute Object', ({}).sat, undefined);

  // 8. Fail-closed end to end: a visible provisional card must refuse to
  //    build a HOP, and must not record one, until ranges are proven.
  const hopGuard = fresh();
  const rb11 = new RangeBackend();
  hopGuard.backend = rb11;
  hopGuard.publicSource = false;
  const hTxid = '78'.repeat(32);
  const hSat = 13_579;
  const hRow = seedFrog(hopGuard, hSat, hTxid).row;
  hopGuard.chainMints = [{
    sat: hSat, txid: '99'.repeat(32), mint_index: 0, seed: 'aa'.repeat(32), name: 'GUARD',
  }];
  rb11.add(hRow.address, hTxid, 0, 25_000, [[0, 25_000]]);
  // A spendable coin so the HOP can reach the range proof (the funding
  // check runs first and would otherwise mask it).
  rb11.add(hopGuard.keys.receive(0).address, '89'.repeat(32), 0, 100_000, [[25_000, 125_000]]);
  rb11.unproven.add(outpointKey(hTxid, 0));
  await hopGuard.refresh({ force: true });
  const hFrog = hopGuard.frogs.find((f) => Number(f.sat) === hSat);
  eq('the seeded Hopper is visible while unproven', !!hFrog, true);
  let hopErr = null;
  try { await hopGuard.previewCross(hFrog, { dir: 1 }); } catch (e) { hopErr = e; }
  eq('an unproven card cannot build a HOP',
    /exact ordinal ranges/.test(String(hopErr?.message)), true);
  eq('no HOP was recorded', hopGuard.actions.filter((a) => a.kind === 'cross').length, 0);

  rc.stop(); reloaded.stop(); budget.stop(); cool.stop(); old.stop(); stg.stop();
  unproven.stop(); bounded.stop(); watchClear.stop(); seedStore.stop(); guard.stop();
  scriptSeed.stop(); planted.stop(); hopGuard.stop();
}

console.log(`scan: ${checks} checks passed`);
