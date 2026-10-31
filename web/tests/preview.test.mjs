// Preview is a hard boundary: building a send/transfer must not broadcast,
// record an action, or touch the mempool. Approval broadcasts exactly once.
import assert from 'node:assert/strict';
import { vsize } from '../js/wallet/tx.js';
import { isFundingUtxo, selectFunding } from '../js/wallet/actions.js';

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
  // Unconfirmed SEND funding: the user opt-in is default-on, lets a plain
  // BIP84 mempool coin pay a fee even before ord/indexer know its ranges,
  // but never changes the mint/prepare/cross funding pool.
  const w = await wallet();
  const raw = w.utxos.find((u) => u.kind === 'p2wpkh');
  const coin = {
    ...raw,
    unconfirmed: true, exact: false, ranges: null, spendable: false,
    status: { confirmed: false },
  };
  eq('default settings allow unconfirmed spending', DEFAULT_SETTINGS.spendUnconfirmed, true);
  eq('a non-exact unconfirmed coin is not strict funding', isFundingUtxo(coin), false);
  eq('the SEND opt-in accepts a non-exact unconfirmed coin', isFundingUtxo(coin, { allowUnconfirmed: true }), true);
  eq('strict selection refuses it', (() => {
    try { selectFunding([coin], 1000n); return 'selected'; } catch (e) { return /insufficient/.test(e.message) ? 'insufficient' : e.message; }
  })(), 'insufficient');
  eq('the opt-in selection takes it', selectFunding([coin], 1000n, [], { allowUnconfirmed: true }).length, 1);

  w.utxos = [coin];
  w.refresh = async () => w;
  w.settings.spendUnconfirmed = true;
  w._computeBalance();
  eq('unconfirmed pending is counted', String(w.balance.pending), String(coin.value));
  eq('unconfirmed funds are spendable by default', String(w.balance.spendable), String(coin.value));
  const p = await w.previewSend(w.keys.receive(9).address, 25000, { feeRate: 2 });
  eq('SEND uses the unconfirmed coin', p.built.inputs.length, 1);
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

console.log(`preview: ${checks} checks passed`);
