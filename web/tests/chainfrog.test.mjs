// The state address is the wallet's indexer-free road index: every TRAVEL
// and every HOP spends or creates an output at the same derived script.
// These tests replay real signed transactions, so the crossing body is
// parsed from the same witness the chain sees.

import assert from 'node:assert/strict';

import { buildCross, buildMint, buildPrepare, buildSend } from '../js/wallet/actions.js';
import { p2trScript } from '../js/wallet/addresses.js';
import { replayFrogChain, frogTxRole } from '../js/wallet/chainfrog.js';
import { deriveWallet } from '../js/wallet/keys.js';
import { parseLocalMint } from '../js/wallet/localmint.js';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};
const { WalletSession } = await import('../js/wallet/wallet.js');

let checks = 0;
const eq = (what, got, want) => {
  assert.deepEqual(got, want, `${what}\n got: ${JSON.stringify(got)}\nwant: ${JSON.stringify(want)}`);
  checks += 1;
};
const ok = (cond, message) => { assert.ok(cond, message); checks += 1; };

const MNEMONIC = 'deliver cat inch coyote consider beyond extend fence fish grain million stock';
const keys = deriveWallet(MNEMONIC, 'regtest');
const fundingKey = keys.receive(0);
const anchor = {
  txid: '11'.repeat(32), vout: 0, value: 200000, script: fundingKey.script,
  address: fundingKey.address, kind: 'p2wpkh', key: fundingKey,
  ranges: [[1000, 200999]], exact: true, frogs: [], spendable: true,
  status: { confirmed: true, block_height: 100 },
};
const ordScript = p2trScript(keys.ord.outputXonly);
const seed = 0x9058d0fa;
const mint = buildMint({ keys, utxos: [anchor], seed, name: 'Hoppamoto', feeRate: 2 });
const reveal = {
  txid: mint.reveal.txid, vout: 0, value: 1000, script: ordScript,
  address: keys.frogAddress(), kind: 'frog',
  ranges: [[Number(mint.sat), Number(mint.sat) + 999]],
  status: { confirmed: true, block_height: 100 },
};
const record = parseLocalMint({
  hex: mint.reveal.hex, utxo: reveal, script: ordScript, mintHeight: 100,
});
ok(record, 'the real reveal yields a mint record');

const prepare = buildPrepare({
  keys,
  utxo: { txid: reveal.txid, vout: 0, value: 1000, script: ordScript, kind: 'frog', key: keys.ord, ranges: reveal.ranges, exact: true },
  frog: record,
  funding: [anchor],
  feeRate: 2,
});
const stateUtxo = {
  txid: prepare.txid, vout: 0, value: 25000, script: prepare.stateScript,
  kind: 'state', key: keys.ord, spendable: false,
  ranges: [[Number(record.sat), Number(record.sat) + 24999]],
};
const changeKey = keys.change(0);
const crossFunding = {
  txid: '22'.repeat(32), vout: 0, value: 100000, script: changeKey.script,
  address: changeKey.address, kind: 'p2wpkh', key: changeKey,
  ranges: [[300000, 399999]], exact: true, frogs: [], spendable: true,
  status: { confirmed: true, block_height: 100 },
};
const cross = buildCross({
  keys, stateUtxo, frog: record, funding: [crossFunding], feeRate: 2, dir: 1,
});
const zeroHash = '00'.repeat(32);
const txHex = new Map([[prepare.txid, prepare.hex], [cross.txid, cross.hex]]);
const rows = [{ txid: prepare.txid, height: 100 }, { txid: cross.txid, height: 105 }];

{
  const role = frogTxRole({ record, hex: prepare.hex, stateScript: prepare.stateScript, ownerXonly: keys.ord.ownerXonly });
  eq('TRAVEL creates the state output', { stateOut: role.stateOut, crossing: role.crossing }, { stateOut: true, crossing: null });
  const hop = frogTxRole({ record, hex: cross.hex, stateScript: prepare.stateScript, ownerXonly: keys.ord.ownerXonly });
  eq('HOP carries direction STRAIGHT', hop.crossing, { dir: 1, input: 0 });
  eq('HOP spends into the same state script', hop.stateOut, true);

  // F-06: a payment to the public state address is an output-only deposit,
  // never a crossing. It has no input-0 envelope and no canonical leaf.
  const deposit = buildSend({
    keys, utxos: [crossFunding], recipientScript: prepare.stateScript,
    amount: 1000, feeRate: 2,
  });
  const depositRole = frogTxRole({
    record, hex: deposit.hex, stateScript: prepare.stateScript,
    ownerXonly: keys.ord.ownerXonly,
  });
  eq('an output-only deposit is not a crossing', depositRole?.crossing, null);
  eq('an output-only deposit is still a state-address payment', depositRole?.stateOut, true);
}

{
  const replay = replayFrogChain({
    record, rows, txHex, tip: 120,
    hashByHeight: new Map([[106, zeroHash]]),
    stateScript: prepare.stateScript, ownerXonly: keys.ord.ownerXonly,
  });
  eq('a surviving first HOP advances dist', replay.dist, 1);
  eq('one HOP is not yet home at target 5', replay.state, 'idle');
  eq('the HOP action keeps its confirmed height', replay.actions.find((a) => a.kind === 'cross').height, 105);
  eq('a settled HOP is marked settled', {
    settled: replay.actions.find((a) => a.kind === 'cross').settled,
    settles: replay.actions.find((a) => a.kind === 'cross').settle_height,
  }, { settled: true, settles: 111 });
  eq('settlement is six blocks after the HOP', replay.actions.find((a) => a.kind === 'settle').height, 111);
  eq('settlement records survival', replay.actions.find((a) => a.kind === 'settle').outcome, 'crossed');
  eq('TRAVEL is reconstructed too', replay.actions.find((a) => a.kind === 'prepare').height, 100);
  eq('entered is one', replay.crossingsEntered, 1);
  eq('settled is one', replay.crossingsSettled, 1);
}

{
  const replay = replayFrogChain({
    record, rows, txHex, tip: 108,
    hashByHeight: new Map([[106, zeroHash]]),
    stateScript: prepare.stateScript, ownerXonly: keys.ord.ownerXonly,
  });
  eq('a HOP inside finality stays crossing', replay.state, 'crossing');
  eq('an in-flight HOP does not advance dist', replay.dist, 0);
  eq('an in-flight HOP is not marked settled', replay.actions.find((a) => a.kind === 'cross').settled, false);
  eq('an in-flight HOP has no settlement row yet', replay.actions.some((a) => a.kind === 'settle'), false);
  eq('an in-flight HOP freezes its target', replay.inFlight.target_hops, 5);
}

{
  const dead = buildCross({
    keys, stateUtxo, frog: record, funding: [crossFunding], feeRate: 2, dir: 0,
  });
  const replay = replayFrogChain({
    record, rows,
    txHex: new Map([[prepare.txid, prepare.hex], [dead.txid, dead.hex]]),
    tip: 120, hashByHeight: new Map([[106, zeroHash]]),
    stateScript: prepare.stateScript, ownerXonly: keys.ord.ownerXonly,
  });
  eq('wrap 0 kills a LEFT HOP', replay.state, 'dead');
  eq('a death does not advance dist', replay.dist, 0);
  eq('the dead settle is marked', replay.actions.find((a) => a.kind === 'settle').outcome, 'dead');
  eq('the death height is the HOP height', replay.deathHeight, 105);
}

{
  // A pre-genesis mint is still G1/base 5. Its first surviving HOP must
  // advance dist exactly like a frog minted after genesis.
  const old = { ...record, mint_height: 974033 };
  const pre = buildPrepare({
    keys,
    utxo: { txid: reveal.txid, vout: 0, value: 1000, script: ordScript, kind: 'frog', key: keys.ord, ranges: reveal.ranges, exact: true },
    frog: old, funding: [anchor], feeRate: 2,
  });
  const preCross = buildCross({
    keys,
    stateUtxo: { txid: pre.txid, vout: 0, value: 25000, script: pre.stateScript, kind: 'state', key: keys.ord, ranges: [[Number(old.sat), Number(old.sat) + 24999]], exact: true },
    frog: old, funding: [crossFunding], feeRate: 2, dir: 1,
  });
  const replay = replayFrogChain({
    record: old,
    rows: [{ txid: pre.txid, height: 974033 }, { txid: preCross.txid, height: 974040 }],
    txHex: new Map([[pre.txid, pre.hex], [preCross.txid, preCross.hex]]),
    tip: 974050, hashByHeight: new Map([[974041, zeroHash]]),
    stateScript: pre.stateScript, ownerXonly: keys.ord.ownerXonly,
  });
  eq('pre-genesis HOP still advances', replay.dist, 1);
  eq('pre-genesis target is base 5', replay.lastTarget, 5);
}

{
  const missing = replayFrogChain({
    record, rows, txHex: new Map(), tip: 120, hashByHeight: new Map(),
    stateScript: prepare.stateScript, ownerXonly: keys.ord.ownerXonly,
  });
  eq('missing transaction hex does not invent state', missing, null);
}

{
  // The replay must feed the same state and action ledger the UI reads,
  // not just return a report. This is the restored-browser path.
  const w = new WalletSession({
    mnemonic: MNEMONIC, network: 'regtest',
    settings: { mode: 'live', feeRate: 2, esploraUrl: 'http://127.0.0.1:3002' },
  });
  w.backend = {
    addressHistory: async () => rows,
    getTxHex: async (txid) => txHex.get(txid) || null,
    blockHashAt: async (h) => (Number(h) === 106 ? zeroHash : null),
  };
  const r = { ...record };
  const records = new Map([[Number(r.sat), r]]);
  const stateOut = {
    txid: cross.txid, vout: 0, value: 25000, script: prepare.stateScript,
    kind: 'state', spendable: false, scriptHex: undefined,
  };
  const changed = await w._reconstructChainFrogs(records, [stateOut], { tip: 120 });
  eq('the wallet applies the replayed record', { state: r.state, dist: r.dist }, { state: 'idle', dist: 1 });
  eq('the wallet exposes the on-chain HOP', w.actions.find((a) => a.kind === 'cross')?.dir, 1);
  eq('the wallet exposes the on-chain TRAVEL', w.actions.some((a) => a.kind === 'prepare'), true);
  eq('the wallet exposes the settlement', w.actions.find((a) => a.kind === 'settle')?.outcome, 'crossed');
  eq('the replay reports a change', changed, true);

  w.actions = [
    ...w.actions,
    { kind: 'cross', sat: Number(r.sat), txid: cross.txid, dir: 99, height: null, at: 'local' },
  ];
  await w._reconstructChainFrogs(records, [stateOut], { tip: 120 });
  const hops = w.actions.filter((a) => a.kind === 'cross');
  eq('a local action is upgraded, not duplicated', hops.length, 1);
  eq('the confirmed height replaces the local tip height', hops[0].height, 105);
  eq('the chain direction replaces a stale local direction', hops[0].dir, 1);
  eq('the upgraded action is marked settled', hops[0].settled, true);

  w.frogs = [r];
  w.tipHeight = 120;
  w.backend.road = async () => ({ active: [] });
  eq('a settled HOP is not on The Road', w._localRoadEntries(), []);
  eq('The Road exposes the idle frog again', (await w.road()).length, 0);
  hops[0].settled = false;
  eq('an unsettled HOP is still on The Road', w._localRoadEntries().length, 1);
}


{
  // The next HOP is already in the mempool. The replay must report it as
  // in flight and must not count it as settled or offer a third HOP.
  const cross2 = buildCross({
    keys,
    stateUtxo: {
      txid: cross.txid, vout: 0, value: 25000, script: prepare.stateScript,
      kind: 'state', key: keys.ord,
      ranges: [[Number(record.sat), Number(record.sat) + 24999]], exact: true,
    },
    frog: record, funding: [crossFunding], feeRate: 2, dir: 2,
  });
  const replay = replayFrogChain({
    record, rows: [...rows, { txid: cross2.txid, height: null }],
    txHex: new Map([...txHex, [cross2.txid, cross2.hex]]),
    tip: 120, hashByHeight: new Map([[106, zeroHash]]),
    stateScript: prepare.stateScript, ownerXonly: keys.ord.ownerXonly,
  });
  eq('a mempool HOP keeps the confirmed dist', replay.dist, 1);
  eq('a mempool HOP puts the frog on the road', replay.state, 'crossing');
  eq('the mempool HOP is the in-flight tx', replay.inFlight.txid, cross2.txid);
  eq('an unconfirmed HOP has no height', replay.inFlight.height, null);
  eq('an unconfirmed HOP has no settlement', replay.actions.some((a) => a.kind === 'settle' && a.height == null), false);
  const pending = replay.actions.find((a) => a.txid === cross2.txid);
  eq('the mempool HOP is marked pending', { kind: pending.kind, mempool: pending.mempool, dir: pending.dir }, { kind: 'cross', mempool: true, dir: 2 });
  eq('the mempool HOP is not settled', pending.settled, false);
  eq('the mempool HOP has no settlement height', pending.settle_height, null);
}

console.log(`chainfrog.test.mjs: ${checks} checks passed`);
