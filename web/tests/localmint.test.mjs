// A HOPPER mint can be identified from its reveal witness alone. This is
// the fallback for the public mainnet defaults, which have no HOPPER
// indexer, and for hosts where ord's `/r/utxo` endpoint is unavailable.

import assert from 'node:assert/strict';

import { buildMint, buildPrepare, buildSend, stateScripts } from '../js/wallet/actions.js';
import { p2trScript, scriptToAddress } from '../js/wallet/addresses.js';
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
eq('mint commit is the reveal input', record.commit, built.commit.txid);
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
eq('the chain mint remembers its commit', wallet.chainMints[0]?.commit, built.commit.txid);
eq('the minted sat is imported', wallet.imported.has(built.sat), true);
eq('the reveal transaction was read once', backend.hexCalls, 1);
assert.match(wallet.scan.note, /recognized from the ord address/);
checks += 1;

await wallet.refresh({ force: true });
eq('the cached mint does not re-read the reveal', backend.hexCalls, 1);
eq('the frog survives a later pass', wallet.frogs.length, 1);

// --- a spent reveal is recovered from ord-address history, then staged ---
{
  const fundKey = keys.receive(1);
  const funding = {
    txid: '33'.repeat(32), vout: 0, value: 200000,
    script: fundKey.script, address: fundKey.address, kind: 'p2wpkh', key: fundKey,
    ranges: [[0, 199999]], exact: true, frogs: [], spendable: true,
    status: { confirmed: true, block_height: 100 },
  };
  const prep = buildPrepare({ keys, utxo: reveal, frog: record, funding: [funding], feeRate: 2 });
  const stateAddress = scriptToAddress(prep.stateScript, 'regtest');
  const stateUtxo = {
    txid: prep.txid, vout: 0, value: Number(prep.stateValue),
    script: prep.stateScript, address: stateAddress,
    status: { confirmed: true, block_height: 120 },
  };

  class StagedBackend {
    constructor() { this.hexCalls = 0; }
    async tipHeight() { return 120; }
    async tipHash() { return '00'.repeat(32); }
    async addressHistory(address) {
      if (address !== keys.frogAddress()) return [];
      return [{
        txid: built.reveal.txid, height: 110,
        outputs: [{ value: 1000, script: ordScript, address: keys.frogAddress() }],
      }];
    }
    async addressUtxos(address) {
      if (address === stateAddress) return [{ ...stateUtxo }];
      return [];
    }
    async utxo() { return null; }
    async frogger() { return null; }
    async froggers() { return { items: [] }; }
    async events() { return { events: [] }; }
    async getTx() { return null; }
    async getTxHex(txid) {
      if (String(txid).toLowerCase() !== built.reveal.txid) return null;
      this.hexCalls += 1;
      return built.reveal.hex;
    }
    async broadcast() { throw new Error('not used'); }
    async leaderboard() { return { entries: [] }; }
    async road() { return { active: [] }; }
  }

  // The earlier session persisted a ledger for this mnemonic. A restored
  // device starts from the words alone.
  settingsStore.clear();
  const restored = new WalletSession({
    mnemonic: MNEMONIC, network: 'regtest',
    settings: { ...DEFAULT_SETTINGS, mode: 'live', gap: 20, gapExtra: 0 },
  });
  const backend = new StagedBackend();
  restored.backend = backend;
  restored._autoSync = false;
  await restored.refresh({ force: true });
  eq('a spent reveal is recovered from address history', restored.frogs.length, 1);
  eq('the recovered frog moves to its staged outpoint', restored.frogs[0].location, {
    txid: prep.txid, vout: 0,
  });
  eq('the state address is remembered for warm passes', restored.staged[String(record.sat)].address, stateAddress);
  eq('the state output is a card, not a plain coin', restored.utxos.find((u) => u.txid === prep.txid)?.kind, 'state');
  eq('the recovered mint is in the chain ledger', restored.chainMints[0]?.sat, record.sat);
  eq('the reveal transaction was read once', backend.hexCalls, 1);

  await restored.refresh({ force: true });
  eq('a warm forced pass keeps the staged frog', restored.frogs.length, 1);
  eq('the staged frog still points at the state output', restored.frogs[0].location.txid, prep.txid);
  eq('the cached reveal is not re-read', backend.hexCalls, 1);

  const reopened = new WalletSession({
    mnemonic: MNEMONIC, network: 'regtest',
    settings: { ...DEFAULT_SETTINGS, mode: 'live', gap: 20, gapExtra: 0 },
  });
  reopened.backend = backend;
  reopened._autoSync = false;
  await reopened.refresh({ force: true });
  eq('a reloaded ledger still watches the staged address', reopened.frogs.length, 1);
  eq('the staged outpoint survives the reload', reopened.frogs[0].location.txid, prep.txid);
  eq('the reveal is still not re-read after a reload', backend.hexCalls, 1);
}

// --- the ord address is asked before the HD plan, so a throttled gap
//     address cannot hide a mint -------------------------------------------
{
  class FailingPlanBackend extends LocalOnlyBackend {
    async addressUtxos(address) {
      if (address === keys.frogAddress()) return [{ ...reveal }];
      throw new Error('throttled');
    }
  }
  settingsStore.clear();
  const w = new WalletSession({
    mnemonic: MNEMONIC, network: 'regtest',
    settings: { ...DEFAULT_SETTINGS, mode: 'live', gap: 20, gapExtra: 0 },
  });
  w.backend = new FailingPlanBackend(built.reveal.hex, reveal, keys.frogAddress());
  w._autoSync = false;
  await w.refresh({ force: true });
  eq('a mint survives a failed HD address after the ord query', w.frogs.length, 1);
  assert.match(w.scan.note, /address scan stopped: throttled/);
}

console.log(`localmint: ${checks} checks passed`);
