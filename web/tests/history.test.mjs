// History is the wallet's complete ledger view, not just local actions.
// Ordinary deposits and a Hopper output must appear alongside the action
// row, confirmed deposits must not stay "PENDING", and the global indexer
// event feed must not paint every NPC mint as this wallet's transaction.
import assert from 'node:assert/strict';

const store = new Map();
store.clear();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const { WalletSession, DEFAULT_SETTINGS } = await import('../js/wallet/wallet.js');
const { history } = await import('../js/ui/screens.js');

let checks = 0;
const ok = (cond, message) => { checks += 1; assert.ok(cond, message); };
const eq = (what, got, want) => {
  checks += 1;
  assert.deepEqual(got, want, `${what}: ${String(got)} !== ${String(want)}`);
};

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const UPGRADE_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const settings = { ...DEFAULT_SETTINGS, mode: 'demo', feeRate: 2 };
const wallet = async () => {
  const w = new WalletSession({ mnemonic: MNEMONIC, network: 'regtest', settings: { ...settings } });
  await w.connect();
  await w.demoFund(1, 200000);
  return w;
};
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

{
  const w = await wallet();
  eq('the faucet output is one deposit', w.receives.length, 1);
  eq('the deposit amount is kept', w.receives[0].amount, 200000);
  eq('the deposit is confirmed', w.receives[0].confirmed, true);
  ok(w.receives[0].txid, 'the deposit has its txid');

  const html = history({ w });
  const text = plain(html);
  ok(/RECEIVE/.test(text), 'history renders the deposit');
  ok(/\+200,000 sats/.test(text), 'history shows the deposit amount');
  ok(/CONFIRMED/.test(text), 'a confirmed deposit is not labelled pending');
  ok(!/PENDING/.test(text), 'history does not invent a pending deposit');

  const preview = await w.previewMint({ seed: 0x9058d0fa, name: 'History Hopper', feeRate: 2 });
  eq('a mint preview does not add a receive', w.receives.length, 1);
  eq('a mint preview does not add an action', w.actions.length, 0);

  await w.broadcastPreview(preview);
  eq('the mint creates the Hopper arrival row', w.receives.filter((r) => r.frog).length, 1);
  eq('the mint change is not recorded as a receive', w.receives.filter((r) => !r.frog).length, 1);
  const arrived = w.receives.find((r) => r.frog);
  eq('the arrival amount is the frog output', arrived.amount, 1000);
  eq('the arrival carries the Hopper sat', arrived.sat, preview.sat);
  eq('the arrival carries the Hopper name', arrived.name, 'History Hopper');
  eq('the faucet deposit survives the spend', w.receives.some((r) => r.amount === 200000), true);
  eq('history itself only contains our event', w.history.length, 1);
  eq('history event belongs to this Hopper', Number(w.history[0].payload.frogger_sat), preview.sat);

  const after = plain(history({ w }));
  ok(/MINT/.test(after), 'history renders the mint action');
  ok(/HOPPER ARRIVED/.test(after), 'history renders the Hopper arrival');
  ok(/\+1,000 sats/.test(after), 'history shows the Hopper arrival amount');
  ok(/\+200,000 sats/.test(after), 'history still shows the initial deposit');
  const mintRows = (after.match(/\bMINT\b/g) || []).length;
  eq('the global NPC mint feed is filtered out', mintRows, 1);
  ok(!/\bPip\b/.test(after), 'an NPC name from the global event feed is absent');
  ok(!/\bBogart\b/.test(after), 'another NPC name from the global event feed is absent');

  const before = w.receives.length;
  await w.refresh({ force: true });
  eq('a refresh does not duplicate observed receives', w.receives.length, before);

  const w2 = new WalletSession({ mnemonic: MNEMONIC, network: 'regtest', settings: { ...settings } });
  eq('receives are loaded from the ledger', w2.receives.length, before);
  await w2.connect();
  await w2.refresh({ force: true });
  eq('a second session does not duplicate receives', w2.receives.length, before);
}

{
  // Upgrade path: a wallet whose deposits predate the receive ledger. Both
  // deposit coins have already been spent by two mints, so only address
  // history can recover them.
  const w = new WalletSession({ mnemonic: UPGRADE_MNEMONIC, network: 'regtest', settings: { ...settings } });
  await w.connect();
  await w.demoFund(2, 200000);
  eq('the upgrade fixture starts with the two deposits', w.receives.length, 2);
  eq('the upgrade fixture keeps both deposit addresses', new Set(w.receives.map((r) => r.address)).size, 1);
  await w.mint({ seed: 0x11111111, name: 'First', feeRate: 2 });
  await w.mint({ seed: 0x22222222, name: 'Second', feeRate: 2 });
  eq('both original deposit coins were spent', w.utxos.filter((u) => u.value === 200000).length, 0);

  // Simulate the ledger written by the version before receives existed.
  w.receives = [];
  w.receivesVersion = 0;
  w._saveLedger();
  let historyCalls = 0;
  const originalHistory = w.backend.addressHistory.bind(w.backend);
  w.backend.addressHistory = async (...args) => {
    historyCalls += 1;
    return originalHistory(...args);
  };
  await w.refresh({ force: true });
  const recovered = w.receives.filter((r) => !r.frog && r.amount === 200000);
  eq('address history recovers both spent deposits', recovered.length, 2);
  eq('the recovered deposits are confirmed', recovered.every((r) => r.confirmed), true);
  eq('the upgrade pass queried the used receive addresses', historyCalls >= 1, true);
  eq('the upgrade marker is persisted', w.receivesVersion, 2);
  const upgradeText = plain(history({ w }));
  eq('history renders both original deposits', (upgradeText.match(/\+200,000 sats/g) || []).length, 2);
  ok(/CONFIRMED/.test(upgradeText), 'recovered deposits are confirmed');

  historyCalls = 0;
  await w.refresh({ force: true });
  eq('the backfill does not run twice', historyCalls, 0);
  eq('the recovered deposits do not duplicate', w.receives.filter((r) => !r.frog && r.amount === 200000).length, 2);
}

{
  // Electrum-style address history carries only txids. The fallback reads
  // the transaction and matches the receive script before recording it.
  const w = new WalletSession({ mnemonic: UPGRADE_MNEMONIC, network: 'regtest', settings: { ...settings } });
  await w.connect();
  const receive = w.keys.receive(0);
  const txid = 'feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface';
  w.receives = [];
  w.receivesVersion = 0;
  w._receiveBackfillFailedAt = 0;
  w.used = { [receive.address]: true };
  w.receiveHistory = [receive.address];
  w.actions = [];
  w.backend.addressHistory = async () => [{ txid, height: 77 }];
  w.backend.getTx = async () => ({
    txid,
    outputs: [{ value: 54321, script: receive.script }],
    status: { confirmed: true, height: 77 },
  });
  const added = await w._backfillReceives();
  eq('minimal address history falls back to the transaction', added, 1);
  eq('the fallback amount is the output paying us', w.receives[0].amount, 54321);
  eq('the fallback height is kept', w.receives[0].height, 77);
  eq('the fallback row is confirmed', w.receives[0].confirmed, true);
  eq('the fallback marks the upgrade complete', w.receivesVersion, 2);
}

console.log(`history: ${checks} checks passed`);
