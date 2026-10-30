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

console.log(`history: ${checks} checks passed`);
