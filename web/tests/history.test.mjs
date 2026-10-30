// History is the wallet's complete ledger view, not just local actions.
// Ordinary deposits, internal change and a Hopper output must appear
// alongside the action row, confirmed rows must not stay "PENDING", and a
// restored browser must see the same mints without the local action ledger.
// The global indexer feed must not paint NPC mints as this wallet's history.
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
const { KEYS } = await import('../js/wallet/storage.js');

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
  const deposit = w.receives[0];
  ok(html.includes('data-action="copy"'), 'history offers copy controls');
  ok(html.includes(`data-text="${deposit.txid}"`), 'the shortened txid copies the full txid');
  ok(html.includes(`data-text="${deposit.address}"`), 'the shortened address copies the full address');
  ok(html.includes('data-copy-label="txid copied"'), 'the txid copy has its own confirmation');
  ok(html.includes('data-copy-label="address copied"'), 'the address copy has its own confirmation');

  const preview = await w.previewMint({ seed: 0x9058d0fa, name: 'History Hopper', feeRate: 2 });
  eq('a mint preview does not add a receive', w.receives.length, 1);
  eq('a mint preview does not add an action', w.actions.length, 0);

  await w.broadcastPreview(preview);
  eq('the mint creates the Hopper arrival row', w.receives.filter((r) => r.frog).length, 1);
  eq('the mint change is not recorded as a receive', w.receives.filter((r) => !r.frog).length, 1);
  eq('the mint change has its own ledger row', w.changes.length, 1);
  ok(w.changes[0].amount > 0, 'the mint change keeps its value');
  eq('the mint change is at the change branch', w.changes[0].address, w.keys.change(0).address);
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
  ok(/CHANGE/.test(after), 'history renders the internal change');
  const order = after.match(/\b(MINT|HOPPER ARRIVED|CHANGE)\b/g) || [];
  eq('the mint is shown before its change and arrival',
    order.slice(0, 3), ['MINT', 'CHANGE', 'HOPPER ARRIVED']);
  const shortTx = (tx) => `${tx.slice(0, 10)}…${tx.slice(-6)}`;
  const commit = preview.built.commit.txid;
  const reveal = preview.built.reveal.txid;
  ok(after.includes(`MINT ${shortTx(commit)}`),
    'the MINT row carries the commit txid');
  ok(after.includes(`CHANGE ${shortTx(commit)}`),
    'the change row follows the same commit');
  ok(after.includes(`HOPPER ARRIVED ${shortTx(reveal)}`),
    'the arrival carries the reveal txid');
  ok(!/sat 0\b/.test(after), 'a row without a sat is not shown as sat 0');
  const mintRows = (after.match(/\bMINT\b/g) || []).length;
  eq('the global NPC mint feed is filtered out', mintRows, 1);
  ok(!/\bPip\b/.test(after), 'an NPC name from the global event feed is absent');
  ok(!/\bBogart\b/.test(after), 'another NPC name from the global event feed is absent');

  const before = w.receives.length;
  await w.refresh({ force: true });
  eq('a refresh does not duplicate observed receives', w.receives.length, before);

  const w2 = new WalletSession({ mnemonic: MNEMONIC, network: 'regtest', settings: { ...settings } });
  eq('receives are loaded from the ledger', w2.receives.length, before);
  eq('changes are loaded from the ledger', w2.changes.length, 1);
  await w2.connect();
  await w2.refresh({ force: true });
  eq('a second session does not duplicate receives', w2.receives.length, before);
  eq('a second session does not duplicate change', w2.changes.length, 1);
}

{
  // An older local mint action can have no `sat` and no recovered chain-mint
  // row. The arrival still names the reveal and therefore the minted sat;
  // that evidence must keep MINT, CHANGE and HOPPER ARRIVED together instead
  // of sorting HOPPER (newer reveal) and CHANGE (older commit) above MINT.
  store.clear();
  const w = new WalletSession({
    mnemonic: 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong',
    network: 'regtest', settings: { ...settings },
  });
  await w.connect();
  await w.demoFund(1, 200000);
  const minted = await w.mint({ seed: 0x55555555, name: 'Old', feeRate: 2 });
  w.chainMints = [];
  w.actions[0].sat = null;
  w.actions[0].height = null;
  for (const c of w.changes) delete c.mintSat;
  const oldText = plain(history({ w }));
  const oldOrder = oldText.match(/\b(MINT|HOPPER ARRIVED|CHANGE)\b/g) || [];
  eq('an old sat-less action still reads mint, change, arrival',
    oldOrder.slice(0, 3), ['MINT', 'CHANGE', 'HOPPER ARRIVED']);
  const shortOld = (tx) => `${tx.slice(0, 10)}…${tx.slice(-6)}`;
  ok(oldText.includes(`MINT ${shortOld(minted.commit.txid)}`),
    'the repaired MINT row still names the commit');

  // The oldest action ledgers did not store the commit at all. Read it back
  // from input 0 of the reveal, then the commit's change joins the mint.
  w.actions[0].commit = null;
  const repaired = await w._repairMintCommits();
  eq('the missing commit is read from the reveal', repaired, 1);
  eq('the repaired action names the commit', w.actions[0].commit, minted.commit.txid);
  w._tagChanges();
  const repairedText = plain(history({ w }));
  const repairedOrder = repairedText.match(/\b(MINT|HOPPER ARRIVED|CHANGE)\b/g) || [];
  eq('a repaired commit keeps mint, change, arrival together',
    repairedOrder.slice(0, 3), ['MINT', 'CHANGE', 'HOPPER ARRIVED']);

  // Worst case: no row stores the minted sat at all. The reveal and commit
  // txids are enough to make one cluster, so the rows cannot drift apart.
  for (const r of w.receives) if (r.frog) r.sat = null;
  for (const f of w.frogs) f.sat = null;
  const worstText = plain(history({ w }));
  const worstOrder = worstText.match(/\b(MINT|HOPPER ARRIVED|CHANGE)\b/g) || [];
  eq('no sat anywhere still groups by reveal and commit txids',
    worstOrder.slice(0, 3), ['MINT', 'CHANGE', 'HOPPER ARRIVED']);
  ok(!/sat 0\b/.test(worstText), 'the no-sat fallback never renders sat 0');
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
  const firstMint = await w.mint({ seed: 0x11111111, name: 'First', feeRate: 2 });
  const secondMint = await w.mint({ seed: 0x22222222, name: 'Second', feeRate: 2 });
  eq('both original deposit coins were spent', w.utxos.filter((u) => u.value === 200000).length, 0);

  // Simulate the ledger written by the version before receives existed.
  w.receives = [];
  w.receivesVersion = 0;
  w.changes = [];
  w.changesVersion = 0;
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
  eq('change history recovers both mint changes', w.changes.length, 2);
  ok(w.changes.every((r) => r.confirmed), 'recovered change is confirmed');
  ok(w.changes.some((r) => r.txid === firstMint.commit.txid), 'the first mint change is recovered');
  ok(w.changes.some((r) => r.txid === secondMint.commit.txid), 'the second mint change is recovered');
  const upgradeText = plain(history({ w }));
  eq('history renders both mint changes', (upgradeText.match(/\bCHANGE\b/g) || []).length, 2);
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

{
  // Device B has the same seed and the same chain, but no local action
  // ledger and no HOPPER indexer. It must still reconstruct both mints,
  // both change outputs, both deposits and both Hopper arrivals.
  store.clear();
  const a = new WalletSession({ mnemonic: MNEMONIC, network: 'regtest', settings: { ...settings } });
  await a.connect();
  await a.demoFund(2, 200000);
  const mintOne = await a.mint({ seed: 0x33333333, name: 'One', feeRate: 2 });
  await a.mint({ seed: 0x44444444, name: 'Two', feeRate: 2 });
  const chain = store.get(KEYS.mock);
  ok(!!chain, 'the demo chain has a snapshot');

  store.clear();
  store.set(KEYS.mock, chain);
  const b = new WalletSession({ mnemonic: MNEMONIC, network: 'regtest', settings: { ...settings } });
  await b.connect();
  // Simulate the older ledger that called this internal change a RECEIVE.
  b.receives.push({
    txid: mintOne.commit.txid, amount: Number(mintOne.commit.changeValue),
    address: b.keys.change(0).address, height: null, frog: false,
    confirmed: true, at: new Date().toISOString(),
  });
  b.backend.events = async () => ({ events: [] });
  b.backend.froggers = async () => ({ total: 0, items: [] });
  b.backend.frogger = async () => null;
  await b.refresh({ force: true });

  eq('a restored device has no local actions', b.actions.length, 0);
  eq('both mints are recovered from chain evidence', b.chainMints.length, 2);
  eq('both change outputs are recovered', b.changes.length, 2);
  eq('both deposits are recovered', b.receives.filter((r) => !r.frog).length, 2);
  eq('both Hopper arrivals are recovered', b.receives.filter((r) => r.frog).length, 2);
  eq('no change output is mislabeled as a receive',
    b.receives.filter((r) => !r.frog && r.address === b.keys.change(0).address).length, 0);

  const text = plain(history({ w: b }));
  eq('a restored device renders both mints', (text.match(/\bMINT\b/g) || []).length, 2);
  eq('a restored device renders both arrivals', (text.match(/HOPPER ARRIVED/g) || []).length, 2);
  eq('a restored device renders both changes', (text.match(/\bCHANGE\b/g) || []).length, 2);
  eq('a restored device renders both deposits', (text.match(/\+200,000 sats/g) || []).length, 2);
  ok(!/\bPip\b|\bBogart\b/.test(text), 'a restored device does not show NPC mints');
  ok(b.chainMints.every((m) => /^[0-9a-f]{64}$/.test(m.commit || '')),
    'a restored local mint keeps its commit txid');

  // Mac-like upgrade: the address scan knows each arrival's block, but the
  // local/ord mint record has no height and the action ledger is absent.
  // MINT must reclaim that height and sort above its HOPPER ARRIVED row.
  const byMint = new Map(b.chainMints.map((m, i) => [m.txid, i === 0 ? 973267 : 973265]));
  for (const r of b.receives) if (r.frog) r.height = byMint.get(r.txid) ?? null;
  for (const m of b.chainMints) m.height = null;
  b._recordChainMints();
  eq('a height-less restored mint reuses the arrival height',
    b.chainMints.map((m) => m.height).sort((x, y) => x - y), [973265, 973267]);
  const ordered = plain(history({ w: b }));
  const order = ordered.match(/\b(MINT|HOPPER ARRIVED|CHANGE)\b/g) || [];
  eq('each restored mint is listed before its change and arrival',
    order.slice(0, 6), ['MINT', 'CHANGE', 'HOPPER ARRIVED', 'MINT', 'CHANGE', 'HOPPER ARRIVED']);
  ok(ordered.indexOf('MINT') < ordered.indexOf('HOPPER ARRIVED'),
    'a restored arrival never appears above its mint');

  // The commit block can be older than the reveal and the change txid is the
  // commit, not the reveal. It still belongs inside the same mint group.
  for (const c of b.changes) c.height = 973260;
  const commitOlder = plain(history({ w: b }));
  const commitOrder = commitOlder.match(/\b(MINT|HOPPER ARRIVED|CHANGE)\b/g) || [];
  eq('an older commit change stays inside its mint group',
    commitOrder.slice(0, 6), ['MINT', 'CHANGE', 'HOPPER ARRIVED', 'MINT', 'CHANGE', 'HOPPER ARRIVED']);
  ok(b.changes.every((c) => Number.isSafeInteger(c.mintSat)),
    'restored change stays linked to its minted sat');

  // A restored device can also have no block heights at all. Falling back
  // to row insertion time used to put the newest-observed change first and
  // the older mint last (CHANGE, HOPPER ARRIVED, MINT). Grouping by the
  // minted sat must decide the order even when every height is unknown.
  for (const c of b.changes) { c.height = null; delete c.mintSat; }
  for (const m of b.chainMints) m.height = null;
  for (const r of b.receives) r.height = null;
  const heightless = plain(history({ w: b }));
  const heightlessOrder = heightless.match(/\b(MINT|HOPPER ARRIVED|CHANGE)\b/g) || [];
  eq('a height-less restore still reads mint, change, arrival',
    heightlessOrder.slice(0, 6),
    ['MINT', 'CHANGE', 'HOPPER ARRIVED', 'MINT', 'CHANGE', 'HOPPER ARRIVED']);

  // Older receive ledgers can have a frog row without its sat. The frog
  // record still names the reveal, so the arrival must not be pushed above
  // the mint just because that field is missing.
  for (const r of b.receives) if (r.frog) { r.sat = null; r.height = 973267; }
  for (const m of b.chainMints) m.height = null;
  const noSat = plain(history({ w: b }));
  const noSatOrder = noSat.match(/\b(MINT|HOPPER ARRIVED|CHANGE)\b/g) || [];
  eq('a sat-less old arrival still joins its mint',
    noSatOrder.slice(0, 6),
    ['MINT', 'CHANGE', 'HOPPER ARRIVED', 'MINT', 'CHANGE', 'HOPPER ARRIVED']);
  ok(!/sat 0\b/.test(noSat), 'a sat-less arrival never renders sat 0');

  // Even if the frog record has already moved away, the reveal txid in the
  // mint ledger is enough to attach the old arrival to its mint.
  b.frogs = [];
  const noFrog = plain(history({ w: b }));
  const noFrogOrder = noFrog.match(/\b(MINT|HOPPER ARRIVED|CHANGE)\b/g) || [];
  eq('a sat-less arrival groups by its reveal txid alone',
    noFrogOrder.slice(0, 6),
    ['MINT', 'CHANGE', 'HOPPER ARRIVED', 'MINT', 'CHANGE', 'HOPPER ARRIVED']);
}

console.log(`history: ${checks} checks passed`);
