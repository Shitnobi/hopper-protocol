// Preview is a hard boundary: building a send/transfer must not broadcast,
// record an action, or touch the mempool. Approval broadcasts exactly once.
import assert from 'node:assert/strict';
import { vsize } from '../js/wallet/tx.js';
import { anchorOffsetOf, assertAnchorFirst, buildSend, buildSendAll, isFundingUtxo, selectFunding } from '../js/wallet/actions.js';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

const { WalletSession, DEFAULT_SETTINGS, scriptToAddress } = await import('../js/wallet/wallet.js');

let checks = 0;
const ok = (cond, message) => { checks += 1; assert.ok(cond, message); };
const eq = (what, got, want) => { checks += 1; assert.deepEqual(got, want, `${what}: ${String(got)} !== ${String(want)}`); };

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const wallet = async (mnemonic = MNEMONIC) => {
  const w = new WalletSession({
    mnemonic, network: 'regtest',
    settings: { ...DEFAULT_SETTINGS, mode: 'demo', feeRate: 2 },
  });
  await w.connect();
  await w.demoFund(4, 100000);
  return w;
};

function counter(w) {
  const original = w.backend.broadcast.bind(w.backend);
  const state = { count: 0 };
  w.backend.broadcast = async (hex) => { state.count += 1; return original(hex); };
  return state;
}

{
  const w = await wallet();
  const destination = w.keys.receive(8).address;
  const p = await w.previewSend(destination, 25000, { feeRate: 3 });
  eq('send preview kind', p.kind, 'send');
  eq('send preview destination', p.to, destination);
  eq('send preview destination amount', p.destinationAmount, 25000n);
  eq('send preview change address', p.changeAddress, w.keys.change(0).address);
  ok(p.changeAmount > 0n, 'send preview has change');
  ok(p.fee > 0n, 'send preview has an actual fee');
  eq('send preview fee rate', p.feeRate, 3);
  eq('a confirmed send is not flagged as unconfirmed', p.usesUnconfirmed, false);
  eq('send preview has no ledger action yet', w.actions.filter((a) => a.kind === 'send').length, 0);
  eq('send preview has no pending broadcast yet', w.pending.length, 0);
  eq('send preview is not on the demo chain', await w.backend.getTx(p.built.txid), null);

  const b = counter(w);
  const built = await w.broadcastPreview(p);
  eq('approval broadcasts once', b.count, 1);
  eq('approval returns the preview txid', built.txid, p.built.txid);
  eq('approval records a send', w.actions[0].kind, 'send');
  eq('the action keeps the actual fee', w.actions[0].fee, Number(p.fee));
  ok(w.actions[0].rbf?.eligible === true, 'the approved send carries its RBF envelope');
}

{
  const w = await wallet('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong');
  const destination = w.keys.receive(8).address;
  const pool = w._sendFunding();
  const total = pool.reduce((a, u) => a + BigInt(u.value), 0n);
  const p = await w.previewSendAll(destination, { feeRate: 3 });
  eq('send all kind', p.kind, 'send');
  eq('send all flag', p.sendAll, true);
  eq('send all destination', p.to, destination);
  eq('send all uses every eligible coin', p.built.inputs.length, pool.length);
  eq('send all has one output', p.built.tx.outputs.length, 1);
  eq('send all has no change', p.built.changeIndex, null);
  eq('send all deducts the fee', p.destinationAmount, total - p.fee);
  eq('send all amount number matches', p.amountNumber, Number(total - p.fee));
  ok(p.fee >= BigInt(Math.ceil(vsize(p.built.tx) * 3)), 'send all pays the requested rate');
  ok(p.changeAddress === null, 'send all preview shows no change address');
  const b = counter(w);
  const built = await w.broadcastPreview(p);
  eq('send all broadcasts once', b.count, 1);
  eq('send all returns the preview txid', built.txid, p.built.txid);
  eq('send all records a send', w.actions[0].kind, 'send');
}

{
  const w = await wallet('legal winner thank year wave sausage worth useful legal winner thank yellow');
  const pool = w._sendFunding();
  const total = pool.reduce((a, u) => a + BigInt(u.value), 0n);
  const fakeState = {
    txid: '11'.repeat(32), vout: 0, value: 50000, kind: 'state', exact: true,
    spendable: false, ranges: [[5000000000000000, 5000000000049999]], frogs: [5000000000000000],
  };
  const marked = {
    ...pool[0], txid: '22'.repeat(32), vout: 1, frogs: [pool[0].ranges[0][0]],
  };
  const built = buildSendAll({
    utxos: [...pool, fakeState, marked], recipientScript: w.keys.receive(8).script,
    feeRate: 2, protectedSats: [5000000000000000],
  });
  eq('send all ignores Hopper/state coins', built.inputs.length, pool.length);
  eq('send all total is plain BTC only', built.totalIn, total);
  ok(!built.inputs.some((u) => u.txid === fakeState.txid || u.txid === marked.txid),
    'send all never spends a Hopper or frog-marked coin');
  assert.throws(() => buildSendAll({
    utxos: [fakeState, marked], recipientScript: w.keys.receive(8).script, feeRate: 2,
  }), /no spendable plain BTC/);
  checks += 1;
}

{
  const w = await wallet('legal winner thank year wave sausage worth useful legal winner thank yellow');
  const p = await w.previewSend(w.keys.receive(9).address, 25000, { feeRate: 2 });
  w.utxos = w.utxos.filter((u) => u.txid !== p.built.inputs[0].txid || Number(u.vout) !== Number(p.built.inputs[0].vout));
  w.refresh = async () => w;
  const b = counter(w);
  await assert.rejects(() => w.broadcastPreview(p), /preview expired|input has already been spent/);
  checks += 1;
  eq('a stale preview broadcasts nothing', b.count, 0);
  eq('a stale preview records nothing', w.actions.filter((a) => a.kind === 'send').length, 0);
}

{
  const w = await wallet('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong');
  const p = await w.previewMint({ seed: 0x9058d0fa, name: 'Preview Mint', feeRate: 2 });
  eq('mint preview kind', p.kind, 'mint');
  eq('mint preview hopper name', p.mintName, 'Preview Mint');
  ok(p.commitTxid, 'mint preview has a commit txid');
  ok(p.revealTxid, 'mint preview has a reveal txid');
  ok(p.commitFee > 0n && p.revealFee > 0n, 'mint preview exposes both fees');
  eq('mint preview fee is commit + reveal', p.fee, p.commitFee + p.revealFee);
  const revealActual = vsize(p.built.reveal.tx);
  const revealNeeded = BigInt(Math.ceil(revealActual * p.revealFeeRate));
  ok(p.revealFee >= revealNeeded, 'reveal fee covers the signed reveal');
  ok(p.revealVsize >= revealActual && p.revealVsize - revealActual <= 2, 'reveal size estimate is not undersized');
  ok(p.revealFee - revealNeeded <= 2n, 'reveal fee does not overpay the signed size');
  ok(p.destinationAmount === 1000n, 'the frog output is 1,000 sats');
  ok(p.changeAddress, 'the commit preview shows a change address');
  eq('mint preview has no ledger action yet', w.actions.filter((a) => a.kind === 'mint').length, 0);
  eq('mint preview has no pending broadcast yet', w.pending.length, 0);
  eq('mint preview is not on the demo chain (commit)', await w.backend.getTx(p.commitTxid), null);
  eq('mint preview is not on the demo chain (reveal)', await w.backend.getTx(p.revealTxid), null);

  const b = counter(w);
  const built = await w.broadcastPreview(p);
  eq('mint approval broadcasts commit + reveal', b.count, 2);
  eq('mint approval returns the previewed reveal', built.reveal.txid, p.revealTxid);
  eq('mint approval records a mint', w.actions[0].kind, 'mint');
  eq('the mint action keeps the actual fee', w.actions[0].fee, Number(p.fee));
  eq('the mint action keeps both txids', [w.actions[0].commit, w.actions[0].txid], [p.commitTxid, p.revealTxid]);
  ok(w.imported.has(Number(p.sat)), 'mint approval imports the Hopper sat');

  const stale = await w.previewMint({ seed: 0x12345678, name: 'Stale', feeRate: 2 });
  const anchor = stale.built.anchor;
  w.utxos = w.utxos.filter((u) => String(u.txid).toLowerCase() !== anchor.txid);
  w.refresh = async () => w;
  const b2 = counter(w);
  await assert.rejects(() => w.broadcastPreview(stale), /preview expired|anchor coin/);
  checks += 1;
  eq('a stale mint preview broadcasts nothing', b2.count, 0);
  eq('a stale mint preview records nothing', w.actions.filter((a) => a.kind === 'mint').length, 1);
}

{
  const w = await wallet('legal winner thank year wave sausage worth useful legal winner thank yellow');
  const p = await w.previewMint({ seed: 0x11112222, name: 'Reveal Fail', feeRate: 2 });
  const original = w.backend.broadcast.bind(w.backend);
  let calls = 0;
  w.backend.broadcast = async (hex) => {
    calls += 1;
    if (calls === 2) throw new Error('relay unavailable');
    return original(hex);
  };
  await assert.rejects(
    () => w.broadcastPreview(p),
    /commit .*accepted.*reveal .*rejected|relay unavailable/i,
  );
  checks += 1;
  eq('a rejected reveal is not retried', calls, 2);
  eq('a partial mint records no action', w.actions.filter((a) => a.kind === 'mint').length, 0);
  eq('a partial mint imports no sat', w.imported.has(Number(p.sat)), false);
  ok(await w.backend.getTx(p.commitTxid), 'the accepted commit is the only chain transaction');
  eq('the reveal was not broadcast', await w.backend.getTx(p.revealTxid), null);
  eq('a rejected reveal leaves a durable package', w.pendingMintPackages().length, 1);
  eq('the package records that the commit was accepted', w.pendingMintPackages()[0].commitAccepted, true);
  ok(w.pendingMintPackages()[0].lastError, 'the package records the reveal failure');
  w.backend.broadcast = original;
  const retried = await w.retryPendingMint(p.commitTxid);
  eq('retry returns the reveal txid', retried.revealTxid, p.revealTxid);
  eq('retry clears the package', w.pendingMintPackages().length, 0);
  ok(await w.backend.getTx(p.revealTxid), 'retry broadcasts the persisted reveal');
  eq('retry records the mint', w.actions.filter((a) => a.kind === 'mint').length, 1);
}

{
  // F-04: an accepted commit whose reveal cannot be replayed can be
  // refunded by its key path without revealing the mint leaf.
  const w = await wallet('ozone drill grab fiber curtain grace pudding thank cruise elder eight picnic');
  const p = await w.previewMint({ seed: 0x22223333, name: 'Refund Me', feeRate: 2 });
  const original = w.backend.broadcast.bind(w.backend);
  let calls = 0;
  w.backend.broadcast = async (hex) => {
    calls += 1;
    if (calls === 2) throw new Error('reveal unavailable');
    return original(hex);
  };
  await assert.rejects(() => w.broadcastPreview(p), /reveal .*rejected|reveal unavailable/i);
  w.backend.broadcast = original;
  const refund = await w.refundPendingMint(p.commitTxid, { feeRate: 2 });
  eq('refund spends the accepted commit', refund.inputs[0].txid, p.commitTxid);
  ok(await w.backend.getTx(refund.txid), 'refund reaches the chain');
  eq('refund clears the pending package', w.pendingMintPackages().length, 0);
  eq('refund is recorded', w.actions.filter((a) => a.kind === 'mint-refund').length, 1);
}

{
  const w = await wallet('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong');
  await w.mint({ seed: 0x9058d0fa, name: 'Preview', feeRate: 1 });
  const frog = w.frogs[0];
  ok(!!frog, 'a Hopper was minted for the transfer preview');
  const source = w._frogUtxo(frog).value;
  const p = await w.previewTransfer(frog, w.keys.receive(7).address, { feeRate: 2 });
  eq('transfer preview kind', p.kind, 'transfer');
  eq('transfer preview destination amount + fee = coin', p.destinationAmount + p.fee, BigInt(source));
  eq('transfer preview has no change output', p.changeAddress, null);
  eq('transfer preview change amount is zero', p.changeAmount, 0n);
  eq('transfer preview has no transfer action yet', w.actions.filter((a) => a.kind === 'transfer').length, 0);
  const transferActual = vsize(p.built.tx);
  const transferNeeded = BigInt(Math.ceil(transferActual * p.feeRate));
  ok(p.fee >= transferNeeded, 'transfer fee covers the signed size');
  ok(p.fee - transferNeeded <= 2n, 'transfer fee does not overpay the signed size');
  const b = counter(w);
  await w.broadcastPreview(p);
  eq('transfer approval broadcasts once', b.count, 1);
  eq('transfer approval records a transfer', w.actions[0].kind, 'transfer');
}

{
  const w = await wallet('zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong');
  await w.mint({ seed: 0x9058d0fa, name: 'Hop', feeRate: 1 });
  await w.prepare(w.frogs[0]);
  const frog = w.frogBySat(w.frogs[0].sat);
  const p = await w.previewCross(frog, { dir: 1, feeRate: 2 });
  eq('hop preview kind', p.kind, 'hop');
  eq('hop preview direction', p.dir, 1);
  eq('hop preview destination amount', p.destinationAmount, 25000n);
  eq('hop preview leaf is the straight leaf (161 bytes)', p.leafHex.length, 322);
  eq('hop preview destination is the next state address', p.to, scriptToAddress(p.built.stateScript, 'regtest'));
  ok(p.changeAddress && p.changeAmount > 0n, 'hop preview has change');
  ok(p.fee > 0n && p.vsize > 0, 'hop preview has an actual fee and size');
  const hopActual = vsize(p.built.tx);
  const hopNeeded = BigInt(Math.ceil(hopActual * p.feeRate));
  ok(p.vsize >= hopActual && p.vsize - hopActual <= 2, 'hop size estimate is not undersized');
  ok(p.fee >= hopNeeded, 'hop fee covers the signed size');
  ok(p.fee - hopNeeded <= 2n, 'hop fee does not overpay the signed size');
  eq('hop preview has no crossing action yet', w.actions.filter((a) => a.kind === 'cross').length, 0);
  eq('hop preview is not on the demo chain', await w.backend.getTx(p.built.txid), null);
  const b = counter(w);
  const built = await w.broadcastPreview(p);
  eq('hop approval broadcasts once', b.count, 1);
  eq('hop approval returns the preview txid', built.txid, p.built.txid);
  eq('hop approval records a crossing', w.actions.filter((a) => a.kind === 'cross')[0]?.dir, 1);
  eq('hop approval put the preview bytes on the chain', !!(await w.backend.getTx(p.built.txid)), true);
}


{
  // Unconfirmed SEND funding is still fail-closed on unknown ranges. An
  // unconfirmed coin with complete ranges may pay a fee; an unknown coin
  // must never be selected, even with the mempool opt-in.
  const w = await wallet();
  const raw = w.utxos.find((u) => u.kind === 'p2wpkh');
  const unknown = {
    ...raw,
    unconfirmed: true, exact: false, ranges: null, spendable: false,
    status: { confirmed: false },
  };
  eq('default settings allow unconfirmed spending', DEFAULT_SETTINGS.spendUnconfirmed, true);
  // FIFO order of ranges is load-bearing: the first input's sat is at
  // offset 0 even when a later range starts at a numerically smaller sat.
  const fifoRanges = [[787_496_009_717, 787_496_010_492], [5_013_174_268, 5_013_198_491]];
  eq('anchor offset keeps FIFO range order', anchorOffsetOf({ ranges: fifoRanges }, 787_496_009_717), 0);
  eq('anchor offset counts earlier ranges in FIFO order', anchorOffsetOf({ ranges: fifoRanges }, 5_013_174_268), 776);
  assertAnchorFirst({ ranges: fifoRanges }, 787_496_009_717, 'fifo test');
  try { assertAnchorFirst({ ranges: fifoRanges }, 5_013_174_268, 'fifo test'); throw new Error('accepted non-first sat'); }
  catch (e) { if (!/not the first/.test(e.message)) throw e; }

  eq('a non-exact unconfirmed coin is not strict funding', isFundingUtxo(unknown), false);
  eq('the SEND opt-in still refuses unknown ranges', isFundingUtxo(unknown, { allowUnconfirmed: true }), false);
  eq('strict selection refuses the unknown coin', (() => {
    try { selectFunding([unknown], 1000n); return 'selected'; } catch (e) { return /insufficient/.test(e.message) ? 'insufficient' : e.message; }
  })(), 'insufficient');
  eq('the opt-in selection also refuses the unknown coin', (() => {
    try { selectFunding([unknown], 1000n, [], { allowUnconfirmed: true }); return 'selected'; } catch (e) { return /insufficient/.test(e.message) ? 'insufficient' : e.message; }
  })(), 'insufficient');

  const coin = { ...raw, unconfirmed: true, exact: true, spendable: true, status: { confirmed: false } };
  w.utxos = [coin];
  w.refresh = async () => w;
  w.settings.spendUnconfirmed = true;
  w._computeBalance();
  eq('unconfirmed pending is counted', String(w.balance.pending), String(coin.value));
  eq('unconfirmed exact funds are spendable by default', String(w.balance.spendable), String(coin.value));
  const p = await w.previewSend(w.keys.receive(9).address, 25000, { feeRate: 2 });
  eq('SEND uses the exact unconfirmed coin', p.built.inputs.length, 1);
  eq('SEND flags its unconfirmed funding', p.usesUnconfirmed, true);
  await w._revalidatePreview(p);
  checks += 1;

  w.settings.spendUnconfirmed = false;
  w._computeBalance();
  eq('opting out removes it from spendable', String(w.balance.spendable), '0');
  await assert.rejects(
    () => w.previewSend(w.keys.receive(10).address, 25000, { feeRate: 2 }),
    /insufficient funds/,
  );
  checks += 1;
}


{
  // F-02: the final signed bytes are checked against protected sats, even
  // when a caller bypasses discovery.
  const w = await wallet('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const key = w.keys.receive(2);
  const coin = {
    txid: '44'.repeat(32), vout: 0, value: 10_000, script: key.script,
    address: key.address, kind: 'p2wpkh', exact: true, spendable: true,
    ranges: [[100_000, 109_999]], frogs: [], key,
  };
  assert.throws(() => buildSend({
    keys: w.keys, utxos: [coin], recipientScript: w.keys.receive(9).script,
    amount: 546, feeRate: 1, protectedSats: [100_999],
  }), /protected Hopper sat/);
  checks += 1;
}

{
  // F-01: a Hopper at the end of a 1,000-sat coin must not be swept into
  // the fee. The old transfer builder produced a 900-sat output and a
  // 100-sat fee, assigning the last sat to fees.
  const w = await wallet('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const frog = {
    sat: 100_999, mint_txid: '11'.repeat(32), mint_index: 0, state: 'idle',
    location: { txid: '22'.repeat(32), vout: 0 },
  };
  const utxo = {
    txid: '22'.repeat(32), vout: 0, value: 1000, kind: 'state',
    script: w._frogState(frog).script, exact: true,
    ranges: [[100_000, 100_999]], frogs: [100_999],
  };
  w.utxos = [utxo];
  w.refresh = async () => w;
  await assert.rejects(
    () => w.previewTransfer(frog, w.keys.receive(9).address, { feeRate: 1 }),
    /not the first sat|own output/,
  );
  checks += 1;

  // F-02: a protected sat in otherwise plain funding is refused even if
  // the caller bypassed discovery.
  const funding = {
    txid: '33'.repeat(32), vout: 0, value: 1000, kind: 'p2wpkh',
    script: w.keys.receive(2).script, exact: true,
    ranges: [[100_000, 100_999]], frogs: [], spendable: true,
  };
}

console.log(`preview: ${checks} checks passed`);
