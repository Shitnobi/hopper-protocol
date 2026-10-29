// Wallet session: keys, discovery, balances, and action orchestration.
//
// Public state is re-derivable: the ledger file on disk holds only what
// makes the UI fast (address gaps, imported sats, history). A fresh device
// unlocks with the 12 words and rebuilds everything from the chain.

import {
  bytesToHex, equalBytes, hexToBytes, reverseBytes,
} from '../core/hex.js';
import { CARD_VALUE, GENESIS, requiredAt } from '../core/params.js';
import { decodeAddress, p2trScript, scriptToAddress } from './addresses.js';
import { deriveWallet } from './keys.js';
import { DemoBackend, LiveBackend } from './backend.js';
import { buildMintOffThread } from './mint-client.js';
import { KEYS, loadJson, saveJson } from './storage.js';
import {
  anchorOffsetOf, buildBurn, buildCross, buildMint, buildPrepare, buildSend,
  buildTransfer, stateScripts,
} from './actions.js';

// Bound the number of chain requests in flight. Sequential scans used to
// take one RTT per address (and per public frog); a small pool keeps a live
// refresh from turning into a multi-second wall of requests.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function rateOr(value, fallback = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(1000, n));
}

export const DEFAULT_SETTINGS = {
  mode: 'demo',
  esploraUrl: 'http://127.0.0.1:3002',
  indexerUrl: 'http://127.0.0.1:9770',
  electrumUrl: '',
  feeRate: 2,
  sound: true,
  mute: false,
  volume: 0.55,
  deepScan: false,
  gap: 20,
  addressBook: [],
};

export function loadSettings() {
  const s = { ...DEFAULT_SETTINGS, ...(loadJson(KEYS.settings, {}) || {}) };
  // Settings are user-editable and survive upgrades. Normalize the values
  // that flow into fee math or the scan loop so a corrupt/empty field can
  // never become NaN or an unbounded gap.
  s.mode = s.mode === 'live' ? 'live' : 'demo';
  s.feeRate = rateOr(s.feeRate);
  const gap = Number(s.gap);
  s.gap = Number.isFinite(gap) ? Math.max(5, Math.min(50, Math.trunc(gap))) : 20;
  const volume = Number(s.volume);
  s.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.55;
  s.mute = s.mute === true;
  s.deepScan = s.deepScan === true;
  s.addressBook = Array.isArray(s.addressBook) ? s.addressBook : [];
  return s;
}

export function saveSettings(settings) {
  saveJson(KEYS.settings, settings);
}

export class WalletSession {
  constructor({ mnemonic, network = 'regtest', fingerprint, settings = null }) {
    this.mnemonic = mnemonic;
    this.network = network;
    this.settings = settings || loadSettings();
    this.settings.network = network;
    this.keys = deriveWallet(mnemonic, network);
    this.fingerprint = fingerprint || this.keys.fingerprint;
    this.ord = this.keys.ordInfo();
    this.backend = null;
    this.utxos = [];
    this.frogs = [];
    this.history = [];
    this.actions = [];
    this.imported = new Set();
    this.tipHeight = null;
    this.tipHash = null;
    this.balance = { total: 0n, spendable: 0n, cards: 0n, unspendable: 0n };
    this._txCache = new Map();
    this._loadLedger();
  }

  // --- persistence -------------------------------------------------------

  _ledgerKey() { return KEYS.ledger(this.fingerprint); }

  _loadLedger() {
    const l = loadJson(this._ledgerKey(), null);
    if (!l) return;
    this.actions = l.actions || [];
    this.history = l.history || [];
    this.imported = new Set(l.imported || []);
    this.used = l.used || {};
  }

  _saveLedger() {
    saveJson(this._ledgerKey(), {
      network: this.network,
      actions: this.actions.slice(-300),
      history: this.history.slice(-200),
      imported: [...this.imported],
      used: this.used || {},
      lastRefresh: new Date().toISOString(),
      tipHeight: this.tipHeight,
    });
  }

  // --- backend -----------------------------------------------------------

  async connect() {
    if (this.settings.mode === 'demo') {
      this.backend = new DemoBackend(this.network);
    } else {
      this.backend = new LiveBackend({
        esploraUrl: this.settings.esploraUrl,
        indexerUrl: this.settings.indexerUrl,
        electrumUrl: this.settings.electrumUrl,
      });
    }
    return this;
  }

  async setMode(mode, urls = {}) {
    this.settings.mode = mode;
    Object.assign(this.settings, urls);
    saveSettings(this.settings);
    await this.connect();
    await this.refresh();
  }

  // --- discovery ---------------------------------------------------------

  _watched() {
    const out = [];
    const gap = this.settings.gap || 20;
    for (const branch of ['receive', 'change']) {
      for (let i = 0; i < gap; i++) {
        const key = this.keys[branch](i);
        out.push({ branch, index: i, key, address: key.address, script: key.script, kind: 'p2wpkh' });
      }
    }
    const frogAddress = this.keys.frogAddress();
    out.push({
      branch: 'ord', index: 0, key: this.keys.ord,
      address: frogAddress, script: p2trScript(this.keys.ord.outputXonly), kind: 'frog',
    });
    return out;
  }

  async _getTx(txid) {
    if (this._txCache.has(txid)) return this._txCache.get(txid);
    const tx = await this.backend.getTx(txid).catch(() => null);
    if (tx) this._txCache.set(txid, tx);
    return tx;
  }

  async refresh({ deep: deepOpt = null } = {}) {
    if (!this.backend) await this.connect();
    this._txCache.clear();
    const [tipHeight, tipHash] = await Promise.all([
      this.backend.tipHeight().catch(() => this.tipHeight),
      this.backend.tipHash().catch(() => this.tipHash),
    ]);
    this.tipHeight = tipHeight;
    this.tipHash = tipHash;

    // Scan the watched addresses in a small pool. The demo resolves almost
    // instantly, but live Esplora/Electrum would otherwise spend one full
    // RTT per address on every action.
    const utxos = [];
    const used = {};
    const scanned = await mapLimit(this._watched(), 6, async (w) => {
      let list = [];
      try { list = await this.backend.addressUtxos(w.address, w.script); } catch { list = []; }
      const dtos = await mapLimit(list, 4, async (u) => {
        try { return await this.backend.utxo(u.txid, u.vout); } catch { return null; }
      });
      return { w, list, dtos };
    });
    for (const { w, list, dtos } of scanned) {
      list.forEach((u, i) => {
        const dto = dtos[i];
        const ranges = dto && dto.ranges
          ? dto.ranges.map(([a, b]) => [a, b - 1])
          : (u.ranges || null);
        const exact = dto ? (dto.exact !== false && !(ranges && ranges.some(([a]) => a >= 4e15))) : false;
        const frogs = dto ? (dto.frogs || []) : (u.frogs || []);
        const kind = w.kind === 'frog' ? 'frog' : 'p2wpkh';
        const key = w.kind === 'frog' ? this.keys.ord : w.key;
        utxos.push({
          txid: u.txid, vout: u.vout, value: Number(u.value), script: u.script,
          address: w.address, kind, ranges, exact, frogs,
          key, keyRef: { branch: w.branch, index: w.index },
          spendable: kind !== 'state' && exact && !frogs.length,
        });
        // Only record addresses that actually hold coins. Marking the whole
        // gap made the old address cursor think every index was used.
        if (w.branch !== 'ord' && list.length) used[w.address] = true;
      });
    }

    // Frog candidates: imported sats, sats on our coins, and (optionally)
    // a bounded public scan so a restored wallet finds state outputs that
    // live at no derivation path.
    const candidates = new Set([...this.imported].map(Number).filter(Number.isSafeInteger));
    for (const u of utxos) {
      for (const sat of u.frogs) {
        const n = Number(sat);
        if (Number.isSafeInteger(n)) candidates.add(n);
      }
    }
    const deep = deepOpt ?? (this.settings.mode === 'demo' ? true : this.settings.deepScan);
    const records = new Map();
    if (deep && this.backend.froggers) {
      try {
        const page = await this.backend.froggers({ limit: 300 });
        for (const f of page.items || []) {
          if (!f || f.sat == null) continue;
          const sat = Number(f.sat);
          if (!Number.isSafeInteger(sat)) continue;
          candidates.add(sat);
          // `/v1/froggers` already returns full records. Re-requesting every
          // one with /v1/frogger/{sat} doubled the scan for no new data.
          records.set(sat, f);
        }
      } catch { /* live indexer may be absent */ }
    }

    const missing = [...candidates].filter((sat) => !records.has(sat));
    const fetched = await mapLimit(missing, 6, async (sat) => {
      try { return [sat, await this.backend.frogger(sat)]; } catch { return [sat, null]; }
    });
    for (const [sat, record] of fetched) if (record) records.set(sat, record);

    const ownership = await mapLimit(
      [...candidates].filter((sat) => records.has(sat)),
      6,
      async (sat) => {
        try { return [sat, records.get(sat), await this._ownsFrog(records.get(sat), utxos)]; }
        catch { return [sat, records.get(sat), { owned: false }]; }
      },
    );

    const frogs = [];
    for (const [sat, record, owned] of ownership) {
      if (!owned.owned) continue;
      frogs.push(record);
      if (owned.utxo) {
        if (owned.custody) {
          owned.utxo.kind = 'state';
          owned.utxo.key = this.keys.ord;
          owned.utxo.spendable = false;
        }
        if (!utxos.some((u) => u.txid === owned.utxo.txid && u.vout === owned.utxo.vout)) {
          utxos.push(owned.utxo);
        }
      }
      this.imported.add(Number(sat));
    }

    this.utxos = utxos.sort((a, b) => b.value - a.value);
    this.frogs = frogs.sort((a, b) => b.dist - a.dist || a.sat - b.sat);
    this.used = used;
    this._computeBalance();
    try {
      const ev = await this.backend.events(200);
      this.history = (ev.events || []).map((e) => ({
        height: e.height, txid: e.txid, blockHash: e.block_hash,
        kind: e.action.kind || e.action.action, payload: e.action,
      }));
    } catch { /* history is optional */ }
    this._saveLedger();
    this.dispatch('refresh', this.summary());
    return this;
  }

  async _ownsFrog(record, utxos) {
    // 1. The location is one of our watched outputs (mint / received).
    const direct = utxos.find((u) => record.location && u.txid === record.location.txid && u.vout === record.location.vout);
    if (direct) return { owned: true, utxo: direct, custody: direct.kind === 'state' };
    const inRanges = utxos.find((u) => u.ranges && u.ranges.some(([a, b]) => record.sat >= a && record.sat <= b));
    if (inRanges) return { owned: true, utxo: inRanges, custody: false };

    // 2. A custody output commits to (sat, mint, owner): derive it and
    //    compare with the output script at the indexer's location.
    if (!record.location) return { owned: false };
    // Still at its mint outpoint? It is not a custody output. The direct
    // watch above already covered a mint paid to one of our addresses; do
    // not fetch the mint transaction for every public frog in a deep scan.
    if (record.mint_txid
      && record.location.txid === record.mint_txid
      && Number(record.location.vout) === Number(record.mint_index ?? 0)) {
      return { owned: false };
    }
    const tx = await this._getTx(record.location.txid);
    if (!tx) return { owned: false };
    const out = tx.outputs[record.location.vout];
    if (!out) return { owned: false };
    let want;
    try { want = stateScripts(record, this.keys.ord.ownerXonly); } catch { return { owned: false }; }
    if (!equalBytes(out.script, want.script)) return { owned: false };
    let dto = null;
    try { dto = await this.backend.utxo(record.location.txid, record.location.vout); } catch { dto = null; }
    const ranges = dto ? dto.ranges.map(([a, b]) => [a, b - 1]) : [[record.sat, record.sat]];
    return {
      owned: true,
      custody: true,
      utxo: {
        txid: record.location.txid, vout: record.location.vout, value: Number(out.value),
        script: out.script, kind: 'state', address: null, ranges,
        exact: dto ? dto.exact !== false : true, frogs: [record.sat],
        key: this.keys.ord, keyRef: { branch: 'ord', index: 0 }, spendable: false,
      },
    };
  }

  _computeBalance() {
    let total = 0n;
    let spendable = 0n;
    let cards = 0n;
    let unspendable = 0n;
    for (const u of this.utxos) {
      total += BigInt(u.value);
      if (!u.exact || !u.ranges) unspendable += BigInt(u.value);
      else if (u.kind === 'p2wpkh' && !u.frogs.length) spendable += BigInt(u.value);
      else cards += BigInt(u.value);
    }
    this.balance = { total, spendable, cards, unspendable };
  }

  summary() {
    return {
      network: this.network,
      mode: this.settings.mode,
      tipHeight: this.tipHeight,
      tipHash: this.tipHash,
      balance: this.balance,
      utxos: this.utxos,
      frogs: this.frogs,
      history: this.history,
      actions: this.actions,
      keys: this.keys,
      ord: this.ord,
      settings: this.settings,
    };
  }

  // --- events ------------------------------------------------------------

  dispatch(name, detail) {
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent(`hopper:${name}`, { detail }));
    }
  }

  // --- demo faucet -------------------------------------------------------

  async demoFund(coins = 8, value = 200000) {
    if (this.settings.mode !== 'demo') throw new Error('the faucet only exists in demo mode');
    const receive = this.keys.receive(0);
    await this.backend.fund(receive.script, value, coins);
    await this.refresh();
  }

  // --- actions -----------------------------------------------------------

  _funding() {
    // Funding inputs are BIP84 P2WPKH, never the frog address or a card.
    return this.utxos.filter((u) => u.kind === 'p2wpkh' && u.exact && !u.frogs.length);
  }

  _frogUtxo(frog) {
    return this.utxos.find((u) => frog.location && u.txid === frog.location.txid && u.vout === frog.location.vout) || null;
  }

  _recordAction(action) {
    this.actions.unshift({ ...action, at: new Date().toISOString(), height: this.tipHeight });
    this.actions = this.actions.slice(0, 300);
    this._saveLedger();
  }

  async mint({ seed, name = '', feeRate = null, revealFeeRate = null, onBroadcast = null }) {
    await this.refresh();
    const rate = rateOr(feeRate ?? this.settings.feeRate);
    const args = {
      utxos: this._funding(), seed, name, feeRate: rate,
      revealFeeRate: rateOr(revealFeeRate ?? rate),
    };
    let built;
    try {
      if (!this.mnemonic) throw Object.assign(new Error('no mnemonic in this session'), { workerUnavailable: true });
      built = await buildMintOffThread({
        mnemonic: this.mnemonic, network: this.network, ...args,
      });
    } catch (err) {
      // A build error is authoritative; only a worker/startup problem falls
      // back to the main thread. The fallback keeps unusual browsers usable.
      if (!err.workerUnavailable) throw err;
      console.warn('mint worker unavailable; building on the main thread', err.message);
      built = buildMint({ keys: this.keys, ...args });
    }
    await this.backend.broadcast(built.commit.hex);
    await this.backend.broadcast(built.reveal.hex);
    // The reveal is the mint. Tell the UI immediately so its seed draft can
    // rotate even if the post-broadcast refresh (below) fails.
    if (onBroadcast) {
      try { onBroadcast(built); } catch (e) {
        console.warn('mint broadcast callback failed', e.message || String(e));
      }
    }
    this._recordAction({
      kind: 'mint', sat: built.sat, seed, name,
      txid: built.reveal.txid, commit: built.commit.txid, inscriptionId: built.reveal.inscriptionId,
    });
    this.imported.add(Number(built.sat));
    // The mint output belongs to the minted sat; a refresh sees it.
    await this.refresh();
    return built;
  }

  async prepare(frog, { feeRate = null } = {}) {
    await this.refresh();
    // `frog` is a UI object captured before the busy overlay/scan; use the
    // freshly discovered record so a settlement in between cannot be missed.
    frog = this.frogBySat(frog.sat) || frog;
    if (frog.state === 'crossing') throw new Error('the frog is on the road; wait for settlement');
    const utxo = this._frogUtxo(frog);
    if (!utxo) throw new Error('the frog output is not in this wallet');
    if (utxo.kind === 'state') throw new Error('the frog is already in custody');
    const offset = anchorOffsetOf(utxo, frog.sat);
    if (offset != null && offset !== 0) {
      throw new Error('the frog sat is not first in this coin; split it before preparing');
    }
    const built = buildPrepare({
      keys: this.keys, utxo, frog, funding: this._funding(),
      feeRate: rateOr(feeRate ?? this.settings.feeRate),
    });
    await this.backend.broadcast(built.hex);
    this._recordAction({ kind: 'prepare', sat: frog.sat, txid: built.txid });
    await this.refresh();
    return built;
  }

  async cross(frog, { feeRate = null, newOwnerXonly = null } = {}) {
    await this.refresh();
    frog = this.frogBySat(frog.sat) || frog;
    if (frog.state !== 'idle') throw new Error(`the frog is ${frog.state}; only an idle frog can cross`);
    const utxo = this._frogUtxo(frog);
    if (!utxo || utxo.kind !== 'state') throw new Error('the frog must be in custody before it can cross');
    const offset = anchorOffsetOf(utxo, frog.sat);
    if (offset != null && offset !== 0) {
      throw new Error('the frog sat is not first in this card; it cannot cross safely');
    }
    const built = buildCross({
      keys: this.keys, stateUtxo: utxo, frog, funding: this._funding(),
      feeRate: rateOr(feeRate ?? this.settings.feeRate), newOwnerXonly,
    });
    await this.backend.broadcast(built.hex);
    this._recordAction({ kind: 'cross', sat: frog.sat, txid: built.txid, at: new Date().toISOString() });
    // Custody now belongs to the optional new P2TR owner. Stop carrying the
    // sat as an owned candidate if that owner is not this wallet.
    if (newOwnerXonly && !equalBytes(newOwnerXonly, this.keys.ord.ownerXonly)) {
      this.imported.delete(Number(frog.sat));
    }
    await this.refresh();
    return built;
  }

  async transfer(frog, address) {
    await this.refresh();
    frog = this.frogBySat(frog.sat) || frog;
    if (frog.state === 'crossing') throw new Error('the frog is on the road; wait for settlement');
    const utxo = this._frogUtxo(frog);
    if (!utxo) throw new Error('the frog output is not in this wallet');
    const recipient = decodeAddress(address, this.network);
    const built = buildTransfer({
      keys: this.keys, utxo, frog, recipientScript: recipient.script,
      feeRate: rateOr(this.settings.feeRate),
    });
    await this.backend.broadcast(built.hex);
    this._recordAction({ kind: 'transfer', sat: frog.sat, txid: built.txid, to: address });
    this.imported.delete(Number(frog.sat));
    await this.refresh();
    return built;
  }

  async burn(frog) {
    await this.refresh();
    frog = this.frogBySat(frog.sat) || frog;
    const utxo = this._frogUtxo(frog);
    if (!utxo) throw new Error('the frog output is not in this wallet');
    const built = buildBurn({ keys: this.keys, utxo, frog, feeRate: rateOr(this.settings.feeRate) });
    await this.backend.broadcast(built.hex);
    this._recordAction({ kind: 'burn', sat: frog.sat, txid: built.txid });
    this.imported.delete(Number(frog.sat));
    await this.refresh();
    return built;
  }

  async send(address, amountSats) {
    if (!Number.isSafeInteger(amountSats) || amountSats < 546) {
      throw new Error('amount must be a whole number of at least 546 sats');
    }
    await this.refresh();
    const recipient = decodeAddress(address, this.network);
    const built = buildSend({
      keys: this.keys, utxos: this._funding(), recipientScript: recipient.script,
      amount: BigInt(amountSats), feeRate: rateOr(this.settings.feeRate),
    });
    await this.backend.broadcast(built.hex);
    this._recordAction({ kind: 'send', txid: built.txid, to: address, amount: String(amountSats) });
    await this.refresh();
    return built;
  }

  async importFrog(sat) {
    const record = await this.backend.frogger(Number(sat));
    if (!record) throw new Error(`no frog at sat ${sat}`);
    this.imported.add(Number(sat));
    await this.refresh();
    return record;
  }

  async mine(count = 1) {
    if (this.settings.mode !== 'demo') throw new Error('mining is a demo feature');
    this.backend.chain.mine(count);
    await this.refresh();
  }

  // --- views -------------------------------------------------------------

  async leaderboard(limit = 25) {
    if (!this.backend) await this.connect();
    const data = await this.backend.leaderboard(limit).catch(() => ({ entries: [] }));
    return data.entries || [];
  }

  async road() {
    if (!this.backend) await this.connect();
    const data = await this.backend.road().catch(() => ({ active: [] }));
    return (data.active || []).map((c) => ({
      sat: c.frogger_sat ?? c.sat,
      seed: c.seed, name: c.name, dist: c.dist,
      inFlight: c.in_flight ?? {
        txid: c.txid, height: c.cross_height, target_hops: c.target_hops,
        settle_height: (c.cross_height ?? 0) + 6,
      },
      provisionalDead: c.provisional_dead ?? null,
      outcomeBlockHash: c.outcome_block_hash ?? null,
    }));
  }

  frogBySat(sat) {
    return this.frogs.find((f) => Number(f.sat) === Number(sat)) || null;
  }

  addressInfo(addr) {
    const r = this.keys.receive(0);
    if (addr === r.address) return { branch: 'receive', index: 0 };
    return { branch: 'receive', index: 0 };
  }

  static newAddress(wallet) {
    const used = Object.keys(wallet.used || {}).length;
    return { change: wallet.keys.change(used % 20), receive: wallet.keys.receive(used % 20) };
  }
}

export { CARD_VALUE, GENESIS, requiredAt, scriptToAddress, bytesToHex, reverseBytes, hexToBytes };
