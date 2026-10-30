#!/usr/bin/env node
// Cross-implementation test: the JS wallet builds the transactions, the
// Rust indexer (running at $HOPPER_API) ingests them through the admin
// wire. This is the seam that matters: consensus bytes, not two mocks.
//
//   HOPPER_INSCRIPTION_ACTIVATION_HEIGHT=0 \
//   HOPPER_API_ADDR=127.0.0.1:9771 HOPPER_SNAPSHOT_PATH=/tmp/h.bin \
//   ./target/debug/hopper-indexer-api &
//   node web/tests/indexer-e2e.mjs http://127.0.0.1:9771

import assert from 'node:assert/strict';
import { deriveWallet } from '../js/wallet/keys.js';
import { DemoBackend } from '../js/wallet/backend.js';
import { buildMint, buildPrepare, buildCross } from '../js/wallet/actions.js';
import { stateScripts } from '../js/wallet/actions.js';
import { CARD_VALUE, GENESIS, requiredAt } from '../js/core/params.js';
import { p2trScript } from '../js/wallet/addresses.js';
import { bytesToHex, sha256 } from '../js/core/hex.js';
import { opReturnPush, parseTx, witnessControl, witnessTapscript } from '../js/wallet/txparse.js';
import { parseInscriptions } from '../js/core/inscription.js';
import { wrapOfDisplayHex } from '../js/core/wrap.js';

const API = (process.argv[2] || 'http://127.0.0.1:9771').replace(/\/+$/, '');
const MNEMONIC = 'deliver cat inch coyote consider beyond extend fence fish grain million stock';

const wallet = deriveWallet(MNEMONIC, 'regtest');
const backend = new DemoBackend('regtest', { fresh: true });
const chain = backend.chain;
const faucet = chain.fund({ script: wallet.receive(0).script, value: 200000, count: 8 });

async function post(path, body) {
  const res = await fetch(API + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text}`);
  return json;
}

// Seed every faucet coin: the indexer never saw the demo genesis.
for (const coin of faucet) {
  await post('/v1/admin/seed', {
    txid: coin.txid, vout: coin.vout,
    ranges: coin.ranges.map(([a, b]) => [a, b + 1]),
  });
}

function inscriptionDto(input) {
  const tapscript = witnessTapscript(input);
  if (!tapscript) return undefined;
  const parsed = parseInscriptions(tapscript);
  if (!parsed.length) return undefined;
  const ins = parsed[0];
  return {
    content_type: new TextDecoder().decode(ins.content_type),
    body_hash: bytesToHex(sha256(ins.body)),
    inscription_id: `${input.txid}i0`,
    body: bytesToHex(ins.body),
    parents: ins.parents.map((p) => bytesToHex(p)),
    tapscript: bytesToHex(tapscript),
    control_block: bytesToHex(witnessControl(input)),
  };
}

async function submitTx(hex, label) {
  const tx = parseTx(hex);
  // Values must be captured before the demo chain applies the tx.
  const inputs = tx.inputs.map((input) => {
    const coin = chain.utxo(input.txid, input.vout);
    const ins = inscriptionDto({ ...input, txid: tx.txid });
    return {
      txid: input.txid, vout: input.vout,
      value: coin ? coin.value : 0,
      ...(ins ? { inscription: ins } : {}),
    };
  });
  const outputs = tx.outputs.map((o) => {
    const push = opReturnPush(o.script);
    return { value: Number(o.value), ...(push ? { op_return: bytesToHex(push) } : {}) };
  });
  const height = chain.tipHeight() + 1;
  chain.submit(hex); // keep the demo bookkeeping in lockstep
  const block = {
    hash: chain.blockHashAt(height),
    height,
    txs: [{ txid: tx.txid, inputs, outputs }],
  };
  const report = await post('/v1/admin/block', block);
  if (report.rejections?.length) {
    throw new Error(`${label} rejected: ${JSON.stringify(report.rejections)}`);
  }
  return { height, txid: tx.txid };
}

async function emptyBlock() {
  const height = chain.tipHeight() + 1;
  chain.mine(1);
  await post('/v1/admin/block', {
    hash: chain.blockHashAt(height), height, txs: [],
  });
  return height;
}

async function scan() {
  const out = [];
  const fk = { address: wallet.frogAddress(), script: p2trScript(wallet.ord.outputXonly) };
  const add = (u, kind, key) => out.push({
    ...u, ranges: u.ranges ? u.ranges.map(([a, b]) => [a, b - 1]) : [],
    exact: true, frogs: u.frogs || [], kind, key, script: u.script,
  });
  for (const u of await backend.addressUtxos(fk.address, fk.script)) add(u, 'frog', wallet.ord);
  for (const branch of ['receive', 'change']) {
    for (let i = 0; i < 5; i++) {
      const key = wallet[branch](i);
      for (const u of await backend.addressUtxos(key.address, key.script)) add(u, 'p2wpkh', key);
    }
  }
  return out;
}

let utxos = await scan();
const mint = buildMint({ keys: wallet, utxos, seed: 0x9058d0fa, name: 'RustCheck', feeRate: 2 });
await submitTx(mint.commit.hex, 'commit');
await submitTx(mint.reveal.hex, 'reveal');

let status = await (await fetch(`${API}/v1/status`)).json();
assert.equal(status.froggers, 1, 'the Rust indexer accepted the mint');
let rec = await (await fetch(`${API}/v1/frogger/${mint.sat}`)).json();
assert.equal(rec.seed, 0x9058d0fa);
assert.equal(rec.name, 'RustCheck');
assert.equal(rec.state, 'idle');
assert.equal(rec.mint_txid, mint.reveal.txid);

// PREPARE from the mint output.
utxos = await scan();
const mintOut = utxos.find((u) => u.kind === 'frog' && u.frogs.includes(mint.sat));
assert.ok(mintOut, 'mint output visible');
const prep = buildPrepare({ keys: wallet, utxo: mintOut, frog: rec, funding: utxos, feeRate: 2 });
const prepBlock = await submitTx(prep.hex, 'prepare');
rec = await (await fetch(`${API}/v1/frogger/${mint.sat}`)).json();
assert.equal(rec.location.txid, prep.txid);
assert.equal(rec.location.vout, 0);

// CROSS from the state output.
const state = stateScripts(rec, wallet.ord.ownerXonly);
const stUtxo = {
  txid: prep.txid, vout: 0, value: Number(CARD_VALUE), script: state.script,
  kind: 'state', exact: true, ranges: [[mint.sat, mint.sat]], frogs: [mint.sat],
};
const cross = buildCross({ keys: wallet, stateUtxo: stUtxo, frog: rec, funding: await scan(), feeRate: 2, dir: 0 });
const crossBlock = await submitTx(cross.hex, 'cross');
rec = await (await fetch(`${API}/v1/frogger/${mint.sat}`)).json();
assert.equal(rec.state, 'crossing');
assert.equal(rec.gen, 1, 'the indexer stamps the mint generation');
assert.equal(rec.in_flight.height, crossBlock.height);
assert.equal(rec.in_flight.target_hops, requiredAt(crossBlock.height));
assert.equal(rec.in_flight.dir, 0, 'the indexer reads the chosen direction');

// Timers: empty blocks through settlement.
await emptyBlock(); // T+1 captures the outcome
const h1 = await (await fetch(`${API}/v1/frogger/${mint.sat}`)).json();
assert.equal(typeof h1.provisional_dead, 'boolean', 'outcome frozen at T+1');
const outcomeHeight = crossBlock.height + 1;
const wantWrap = wrapOfDisplayHex(chain.blockHashAt(outcomeHeight));
assert.equal(h1.outcome_wrap, wantWrap, 'the indexer and the demo chain agree on the wrap');
assert.equal(h1.provisional_dead, wantWrap === 0, 'the direction alone decides');
const wrap = await (await fetch(`${API}/v1/wrap/${outcomeHeight}`)).json();
assert.equal(wrap.wrap, wantWrap, '/v1/wrap publishes the same integer');
const gen = await (await fetch(`${API}/v1/generation/${crossBlock.height}`)).json();
assert.equal(gen.required, requiredAt(crossBlock.height), '/v1/generation publishes required');
assert.equal(gen.generation, 1);
const params = await (await fetch(`${API}/v1/params`)).json();
assert.equal(params.wire_version, 7);
assert.equal(params.generations.generation_len, 28080);
const road = await (await fetch(`${API}/v1/road`)).json();
const mine = road.active.find((c) => c.frogger_sat === mint.sat);
assert.equal(typeof mine.provisional_dead, 'boolean', 'road exposes the sealed verdict');
assert.equal(typeof mine.outcome_block_hash, 'string', 'road exposes H(T+1)');
for (let i = 0; i < 5; i++) await emptyBlock();
rec = await (await fetch(`${API}/v1/frogger/${mint.sat}`)).json();
assert.equal(rec.in_flight, undefined);
assert.ok(['idle', 'home', 'dead', 'burned'].includes(rec.state), rec.state);
assert.equal(rec.crossings_settled, 1);

const root = await (await fetch(`${API}/v1/state/root`)).json();
console.log('indexer e2e: ok');
console.log(' sat', mint.sat, 'mint', mint.reveal.txid.slice(0, 12), 'prep H', prepBlock.height,
  'cross H', crossBlock.height, 'final', rec.state, 'dist', rec.dist);
console.log(' state root', JSON.stringify(root));
