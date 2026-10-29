// End-to-end demo-chain game test: mint → prepare → cross → settle →
// transfer, using the real wallet transaction builders.
import assert from 'node:assert/strict';
import { deriveWallet } from '../js/wallet/keys.js';
import { DemoBackend } from '../js/wallet/backend.js';
import { buildMint, buildPrepare, buildCross, buildTransfer, buildSend, buildBurn } from '../js/wallet/actions.js';
import { stateScripts } from '../js/wallet/actions.js';
import { requiredAt, CARD_VALUE } from '../js/core/params.js';
import { p2trScript } from '../js/wallet/addresses.js';
import { bytesToHex, hexToBytes } from '../js/core/hex.js';
import { parseTx } from '../js/wallet/txparse.js';
import { writeFileSync } from 'node:fs';

const MNEMONIC = 'deliver cat inch coyote consider beyond extend fence fish grain million stock';
const wallet = deriveWallet(MNEMONIC, 'regtest');
const backend = new DemoBackend('regtest', { fresh: true });
const chain = backend.chain;

// Every signed transaction is exported with its prevouts so the Rust
// test `hopper-indexer-api/tests/js_tx_verify.rs` can verify the
// ECDSA/Schnorr signatures with rust-bitcoin's sighash implementation.
const exported = [];
function collect(label, hex) {
  const tx = parseTx(hex);
  const prevouts = tx.inputs.map((i) => {
    const coin = chain.utxo(i.txid, i.vout);
    assert.ok(coin, `${label}: prevout ${i.txid}:${i.vout} is known`);
    return { value: coin.value, script: coin.scriptHex };
  });
  exported.push({ label, hex, prevouts });
}

chain.fund({ script: wallet.receive(0).script, value: 200000, count: 8 });

async function scan() {
  const out = [];
  const frogKey = { address: wallet.frogAddress(), script: p2trScript(wallet.ord.outputXonly), kind: 'frog', key: wallet.ord };
  for (const u of await backend.addressUtxos(frogKey.address, frogKey.script)) {
    let dto = null; try { dto = await backend.utxo(u.txid, u.vout); } catch {}
    out.push({ ...u, ranges: dto ? dto.ranges.map(([a,b])=>[a,b-1]) : [], exact: dto ? dto.exact : true, frogs: dto ? dto.frogs : [], kind: 'frog', key: frogKey, script: u.script });
  }
  for (const branch of ['receive', 'change']) {
    for (let i = 0; i < 5; i++) {
      const key = wallet[branch](i);
      const us = await backend.addressUtxos(key.address, key.script);
      for (const u of us) {
        let dto = null;
        try { dto = await backend.utxo(u.txid, u.vout); } catch { /* not tracked */ }
        out.push({
          ...u,
          ranges: dto ? dto.ranges.map(([a, b]) => [a, b - 1]) : (u.ranges || []),
          exact: dto ? dto.exact : true,
          frogs: dto ? dto.frogs : (u.frogs || []),
          kind: key.address === wallet.frogAddress() ? 'frog' : 'p2wpkh',
          key,
          script: u.script,
        });
      }
    }
  }
  return out;
}

let utxos = await scan();
assert.ok(utxos.length >= 8, 'faucet coins visible');

const mint = buildMint({ keys: wallet, utxos, seed: 0x9058d0fa, name: 'Hopkinson', feeRate: 2 });
collect('mint-commit', mint.commit.hex);
const commitId = chain.submit(mint.commit.hex);
assert.equal(commitId, mint.commit.txid);
collect('mint-reveal', mint.reveal.hex);
const revealId = chain.submit(mint.reveal.hex);
assert.equal(revealId, mint.reveal.txid);
let frog = chain.record(mint.sat);
assert.ok(frog, `mint accepted at sat ${mint.sat}`);
assert.equal(frog.seed, 0x9058d0fa);
assert.equal(frog.name, 'Hopkinson');
assert.equal(frog.state, 'idle');
assert.equal(frog.mint_txid, mint.reveal.txid);
assert.equal(frog.inscription_id, mint.reveal.inscriptionId);

// The mint output is on the frog address.
utxos = await scan();
const mintOut = utxos.find((u) => u.kind === 'frog' && u.frogs.includes(mint.sat));
assert.ok(mintOut, 'mint output visible at the frog address');

// PREPARE into custody.
const prep = buildPrepare({ keys: wallet, utxo: mintOut, frog, funding: utxos, feeRate: 2 });
collect('prepare', prep.hex);
chain.submit(prep.hex);
frog = chain.record(mint.sat);
assert.equal(frog.location.txid, prep.txid);
assert.equal(frog.location.vout, 0);
assert.equal(frog.state, 'idle');
const state = stateScripts(frog, wallet.ord.ownerXonly);
const stUtxo = {
  txid: prep.txid, vout: 0, value: CARD_VALUE, script: state.script, kind: 'state',
  exact: true, ranges: [[mint.sat, mint.sat]], frogs: [mint.sat], key: wallet.ord,
};
assert.equal(chain.utxo(prep.txid, 0).value, Number(CARD_VALUE));

// CROSS.
utxos = await scan();
const cross = buildCross({ keys: wallet, stateUtxo: stUtxo, frog, funding: utxos, feeRate: 2 });
collect('cross', cross.hex);
chain.submit(cross.hex);
frog = chain.record(mint.sat);
assert.equal(frog.state, 'crossing');
assert.equal(frog.in_flight.height, chain.tipHeight());
assert.equal(frog.in_flight.target_hops, requiredAt(chain.tipHeight()));
// A crossing spends the frog's state output, but it is not a handoff:
// the mock history must not publish a Transfer for the CROSS txid.
assert.ok(!chain.events.some((e) => e.txid === cross.txid && e.action.action === 'transfer'),
  'CROSS must not also be a Transfer event');

// Timers: outcome at T+1, settlement at T+6.
chain.mine(1);
frog = chain.record(mint.sat);
assert.equal(typeof frog.provisional_dead, 'boolean');
assert.equal(frog.outcome_block_hash, chain.blockHashAt(frog.in_flight.height + 1));
chain.mine(5);
frog = chain.record(mint.sat);
assert.ok(['idle', 'home', 'dead', 'burned'].includes(frog.state), frog.state);
assert.equal(frog.in_flight, null);
assert.equal(frog.crossings_settled, 1);

if (frog.location) {
  const nextState = stateScripts(frog, wallet.ord.ownerXonly);
  const utxo = {
    txid: frog.location.txid, vout: frog.location.vout, value: CARD_VALUE,
    script: nextState.script, kind: 'state', exact: true, ranges: [[mint.sat, mint.sat]], frogs: [mint.sat],
  };
  const recipient = wallet.receive(1);
  const transfer = buildTransfer({ keys: wallet, utxo, frog, recipientScript: recipient.script, feeRate: 2 });
  collect('transfer', transfer.hex);
  chain.submit(transfer.hex);
  const moved = chain.record(mint.sat);
  assert.equal(moved.location.txid, transfer.txid);
  assert.equal(moved.state, frog.state);
  frog = moved;
}

// Ordinary send from a plain coin.
utxos = await scan();
const plain = utxos.find((u) => u.kind === 'p2wpkh' && !u.frogs.length);
if (plain) {
  const before = chain.tipHeight();
  const send = buildSend({ keys: wallet, utxos, recipientScript: wallet.receive(3).script, amount: 10000, feeRate: 2 });
  collect('send', send.hex);
  chain.submit(send.hex);
  assert.equal(chain.tipHeight(), before + 1);
  const got = await backend.addressUtxos(wallet.receive(3).address, wallet.receive(3).script);
  assert.ok(got.some((u) => u.value === 10000), 'recipient got the send');
}

// BURN: the card to fees, no frog output.
if (frog.location) {
  const at = chain.utxo(frog.location.txid, frog.location.vout);
  const burnState = stateScripts(frog, wallet.ord.ownerXonly);
  const atScript = hexToBytes(at.scriptHex);
  const isState = bytesToHex(atScript) === bytesToHex(burnState.script);
  const burnUtxo = {
    txid: frog.location.txid, vout: frog.location.vout, value: at.value,
    script: atScript, kind: isState ? 'state' : 'p2wpkh',
    key: isState ? undefined : wallet.receive(1),
    exact: true, ranges: [[mint.sat, mint.sat]], frogs: [mint.sat],
  };
  const stateBefore = frog.state;
  const burn = buildBurn({ keys: wallet, utxo: burnUtxo, frog, feeRate: 2 });
  collect('burn', burn.hex);
  chain.submit(burn.hex);
  const burned = chain.record(mint.sat);
  // A dead frog stays dead; the sat is still gone and the burn is recorded.
  assert.equal(burned.state, stateBefore === 'dead' ? 'dead' : 'burned');
  assert.equal(burned.location, null);
  assert.equal(burned.burn_txid, burn.txid);
}

writeFileSync(new URL('./js-txs.json', import.meta.url), JSON.stringify(exported, null, 1));
console.log('game: ok — mint', mint.sat, 'crossed', frog.dist, 'state', frog.state, '·', exported.length, 'signed txs exported');
