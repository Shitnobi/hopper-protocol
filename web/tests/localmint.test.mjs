// A HOPPER mint can be identified from its reveal witness alone. This is
// the fallback for the public mainnet defaults, which have no HOPPER
// indexer, and for hosts where ord's `/r/utxo` endpoint is unavailable.

import assert from 'node:assert/strict';

import { buildMint, buildSend } from '../js/wallet/actions.js';
import { p2trScript } from '../js/wallet/addresses.js';
import { deriveWallet } from '../js/wallet/keys.js';
import { parseLocalMint } from '../js/wallet/localmint.js';

const settingsStore = new Map([
  ['hopper.settings.v1', JSON.stringify({ gap: 20 })],
]);
globalThis.localStorage = {
  getItem: (k) => settingsStore.get(k) ?? null,
  setItem: (k, v) => { settingsStore.set(k, String(v)); },
  removeItem: (k) => { settingsStore.delete(k); },
};

const { DEFAULT_SETTINGS, WalletSession } = await import('../js/wallet/wallet.js');

let checks = 0;
function eq(what, got, want) {
  assert.deepEqual(got, want, `${what}\n got: ${JSON.stringify(got)}\nwant: ${JSON.stringify(want)}`);
  checks++;
}

const MNEMONIC = 'deliver cat inch coyote consider beyond extend fence fish grain million stock';
const keys = deriveWallet(MNEMONIC, 'regtest');
const fundingKey = keys.receive(0);
const anchor = {
  txid: '11'.repeat(32), vout: 0, value: 200000, script: fundingKey.script,
  address: fundingKey.address, kind: 'p2wpkh', key: fundingKey,
  ranges: [[1000, 200999]], exact: true, frogs: [], spendable: true,
  status: { confirmed: true, block_height: 100 },
};
const seed = 0x9058d0fa;
const built = buildMint({ keys, utxos: [anchor], seed, name: 'Hopkinson', feeRate: 2 });
const ordScript = p2trScript(keys.ord.outputXonly);
const reveal = {
  txid: built.reveal.txid, vout: 0, value: 1000, script: ordScript,
  address: keys.frogAddress(), kind: 'frog',
  status: { confirmed: true, block_height: 110 },
};

const record = parseLocalMint({
  hex: built.reveal.hex, utxo: reveal, script: ordScript,
});
assert.ok(record, 'the reveal witness yields a mint record');
eq('sat comes from the canonical body', record.sat, built.sat);
eq('seed comes from the mint envelope', record.seed, seed);
eq('name comes from the mint envelope', record.name, 'Hopkinson');
eq('mint txid is the reveal', record.mint_txid, built.reveal.txid);
eq('mint outpoint is the ord output', record.location, { txid: built.reveal.txid, vout: 0 });
eq('inscription id', record.inscription_id, `${built.reveal.txid}i0`);
eq('mint index', record.mint_index, 0);
eq('fresh mint is idle', record.state, 'idle');
eq('fresh mint has no hops', record.dist, 0);
eq('record is marked local', record.local, true);
eq('record carries the block height', record.mint_height, 110);

eq('the commit transaction is not a mint reveal', parseLocalMint({
  hex: built.commit.hex, utxo: reveal, script: ordScript,
}), null);
eq('a different ord script is rejected', parseLocalMint({
  hex: built.reveal.hex,
  utxo: { ...reveal, script: p2trScript(keys.ord.outputXonly) },
  script: keys.receive(1).script,
}), null);
eq('a non-zero output index is rejected', parseLocalMint({
  hex: built.reveal.hex, utxo: { ...reveal, vout: 1 }, script: ordScript,
}), null);
eq('a different txid is rejected', parseLocalMint({
  hex: built.reveal.hex, utxo: { ...reveal, txid: '22'.repeat(32) }, script: ordScript,
}), null);
eq('a wrong value is rejected', parseLocalMint({
  hex: built.reveal.hex, utxo: { ...reveal, value: 999 }, script: ordScript,
}), null);

const plain = buildSend({
  keys, utxos: [anchor], recipientScript: ordScript, amount: 1000, feeRate: 2,
});
eq('a plain send to the ord address is not a mint', parseLocalMint({
  hex: plain.hex,
  utxo: { txid: plain.txid, vout: 0, value: 1000, script: ordScript, kind: 'frog' },
  script: ordScript,
}), null);

// --- wallet integration: no indexer, no ord ranges -----------------------
class LocalOnlyBackend {
  constructor(hex, utxo, frogAddress) {
    this.hex = hex;
    this.utxo = utxo;
    this.frogAddress = frogAddress;
    this.tip = 110;
    this.hexCalls = 0;
  }
  async tipHeight() { return this.tip; }
  async tipHash() { return '00'.repeat(32); }
  async addressHistory(address) {
    return address === this.frogAddress ? [{ txid: this.utxo.txid, height: 110 }] : [];
  }
  async addressUtxos(address) {
    return address === this.frogAddress ? [{ ...this.utxo }] : [];
  }
  async utxo() { return null; }
  async frogger() { return null; }
  async froggers() { return { items: [] }; }
  async events() { return { events: [] }; }
  async getTx() { return null; }
  async getTxHex(txid) {
    if (String(txid).toLowerCase() !== this.utxo.txid) return null;
    this.hexCalls += 1;
    return this.hex;
  }
  async broadcast() { throw new Error('not used'); }
  async leaderboard() { return { entries: [] }; }
  async road() { return { active: [] }; }
}

const wallet = new WalletSession({
  mnemonic: MNEMONIC,
  network: 'regtest',
  settings: { ...DEFAULT_SETTINGS, mode: 'live', gap: 20, gapExtra: 0 },
});
const backend = new LocalOnlyBackend(built.reveal.hex, reveal, keys.frogAddress());
wallet.backend = backend;
wallet._autoSync = false;

await wallet.refresh({ force: true });
eq('the wallet recognizes the mint without an indexer', wallet.frogs.length, 1);
eq('the recognized frog is the local mint', wallet.frogs[0].sat, built.sat);
eq('the recognized frog is marked local', wallet.frogs[0].local, true);
eq('the minted sat is imported', wallet.imported.has(built.sat), true);
eq('the reveal transaction was read once', backend.hexCalls, 1);
assert.match(wallet.scan.note, /recognized from the ord address/);
checks += 1;

await wallet.refresh({ force: true });
eq('the cached mint does not re-read the reveal', backend.hexCalls, 1);
eq('the frog survives a later pass', wallet.frogs.length, 1);

console.log(`localmint: ${checks} checks passed`);
