// Chain + indexer adapters.
//
// Two chain ports (SPEC §5.2): Esplora over HTTP and Electrum over
// WebSocket. Discovery is either the HOPPER indexer (/v1/…) or, in demo
// mode, the in-browser MockChain.

import { bytesToHex, hexToBytes, reverseBytes, sha256, sha256d } from '../core/hex.js';
import { parseTx } from './txparse.js';
import { MockChain } from '../mock/chain.js';

const REQUEST_TIMEOUT_MS = 20000;

async function timedFetch(url, opts = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// --- Esplora --------------------------------------------------------------

export class EsploraClient {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  async req(path, opts = {}) {
    const res = await timedFetch(this.base + path, {
      ...opts,
      headers: { 'content-type': 'text/plain', ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`esplora ${path}: ${res.status}`);
    return res;
  }

  async tipHeight() {
    return Number((await (await this.req('/blocks/tip/height')).text()).trim());
  }

  async tipHash() {
    return (await (await this.req('/blocks/tip/hash')).text()).trim();
  }

  async blockHashAt(height) {
    return (await (await this.req(`/block-height/${height}`)).text()).trim();
  }

  async addressUtxos(address) {
    const list = await (await this.req(`/address/${encodeURIComponent(address)}/utxo`)).json();
    return list.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: Number(u.value),
      status: u.status || {},
    }));
  }

  async addressTxs(address) {
    return (await (await this.req(`/address/${encodeURIComponent(address)}/txs`)).json());
  }

  async getTx(txid) {
    const tx = await (await this.req(`/tx/${txid}`)).json();
    return {
      txid: tx.txid,
      hex: null,
      outputs: tx.vout.map((o) => ({
        value: Number(o.value),
        script: hexToBytes(o.scriptpubkey),
        address: o.scriptpubkey_address || null,
      })),
      status: tx.status || {},
    };
  }

  async getTxHex(txid) {
    return (await (await this.req(`/tx/${txid}/hex`)).text()).trim();
  }

  async feeRate(target = 3) {
    const estimates = await (await this.req('/fee-estimates')).json();
    const key = String(target);
    const rate = estimates[key] ?? Object.values(estimates)[0] ?? 2;
    return Math.max(1, Math.min(1000, Number(rate)));
  }

  async broadcast(hex) {
    const res = await timedFetch(`${this.base}/tx`, { method: 'POST', body: hex }, 30000);
    const text = (await res.text()).trim();
    if (!res.ok) throw new Error(`broadcast rejected: ${text}`);
    return text;
  }
}

// --- Electrum over WebSocket ---------------------------------------------

export class ElectrumClient {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.ws = null;
    this.tip = null;
  }

  async connect() {
    if (this.ws && this.ws.readyState === 1 && this.tip) return this;
    // Several address scans may call connect() together. Share one handshake
    // instead of opening a socket per worker.
    if (this._connecting) return this._connecting;
    const connecting = (async () => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      await new Promise((resolve, reject) => {
        let done = false;
        let timer = null;
        const finish = (err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          ws.onopen = null;
          ws.onerror = null;
          ws.onclose = null;
          if (err) {
            try { ws.close(); } catch { /* already closed */ }
            reject(err);
          } else {
            resolve();
          }
        };
        timer = setTimeout(() => finish(new Error(`electrum connect timed out (${this.url})`)), 15000);
        ws.onopen = () => finish(null);
        ws.onerror = () => finish(new Error(`cannot connect to ${this.url}`));
        ws.onclose = () => finish(new Error('electrum socket closed before opening'));
      });
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || 'electrum error'));
          else resolve(msg.result);
        } else if (msg.method === 'blockchain.headers.subscribe') {
          this.tip = msg.params[0];
        }
      };
      ws.onclose = () => {
        for (const { reject } of this.pending.values()) reject(new Error('electrum socket closed'));
        this.pending.clear();
      };
      try {
        this.tip = await this.call('blockchain.headers.subscribe');
      } catch (err) {
        try { ws.close(); } catch { /* already closed */ }
        throw err;
      }
      return this;
    })();
    this._connecting = connecting;
    try { return await connecting; } finally {
      if (this._connecting === connecting) this._connecting = null;
    }
  }

  call(method, params = []) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        reject(new Error(`electrum ${method}: ${err.message || err}`));
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 30000);
    });
  }

  scripthash(script) {
    return bytesToHex(reverseBytes(sha256(script)));
  }

  async tipHeight() {
    await this.connect();
    return this.tip.height;
  }

  async tipHash() {
    await this.connect();
    return bytesToHex(reverseBytes(sha256d(hexToBytes(this.tip.hex))));
  }

  async blockHashAt(height) {
    await this.connect();
    const header = await this.call('blockchain.block.header', [height]);
    return bytesToHex(reverseBytes(sha256d(hexToBytes(header))));
  }

  async addressUtxos(address, script) {
    await this.connect();
    const sh = this.scripthash(script);
    const list = await this.call('blockchain.scripthash.listunspent', [sh]);
    return list.map((u) => ({
      txid: u.tx_hash, vout: u.tx_pos, value: Number(u.value), status: { height: u.height },
    }));
  }

  async getTx(txid) {
    await this.connect();
    const tx = await this.call('blockchain.transaction.get', [txid, true]);
    return {
      txid,
      hex: tx.hex,
      outputs: tx.vout.map((o) => ({
        value: Math.round(Number(o.value) * 1e8),
        script: hexToBytes(o.scriptPubKey.hex),
      })),
      status: tx.confirmations != null ? { confirmed: tx.confirmations > 0 } : {},
    };
  }

  async getTxHex(txid) {
    await this.connect();
    return this.call('blockchain.transaction.get', [txid, false]);
  }

  async feeRate() {
    await this.connect();
    const btcPerKb = await this.call('blockchain.estimatefee', [3]);
    if (!btcPerKb || btcPerKb <= 0) return 2;
    return Math.max(1, Math.min(1000, Math.round(btcPerKb * 100000)));
  }

  async broadcast(hex) {
    await this.connect();
    return this.call('blockchain.transaction.broadcast', [hex]);
  }
}

// --- HOPPER indexer -------------------------------------------------------

export class IndexerClient {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  async get(path) {
    const res = await timedFetch(this.base + path, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`indexer ${path}: ${res.status} ${body}`.trim());
    }
    return res.json();
  }

  status() { return this.get('/v1/status'); }
  params() { return this.get('/v1/params'); }
  frogger(sat) { return this.get(`/v1/frogger/${sat}`); }
  froggers({ limit = 50, offset = 0, afterSat = null, toSat = null } = {}) {
    const q = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (afterSat != null) q.set('after_sat', String(afterSat));
    if (toSat != null) q.set('to_sat', String(toSat));
    return this.get(`/v1/froggers?${q}`);
  }
  utxo(txid, vout) { return this.get(`/v1/utxo/${txid}/${vout}`); }
  road() { return this.get('/v1/road'); }
  leaderboard(limit = 25) { return this.get(`/v1/leaderboard?limit=${limit}`); }
  events(limit = 100) { return this.get(`/v1/events?limit=${limit}`); }
  fees() { return this.get('/v1/fees'); }
}

// --- unified backends -----------------------------------------------------

// The demo chain implements both interfaces itself.
export class DemoBackend {
  constructor(network = 'regtest', { fresh = false } = {}) {
    this.kind = 'demo';
    this.chain = new MockChain({ network, fresh });
    this.chain.network = network;
  }

  async tipHeight() { return this.chain.tipHeight(); }
  async tipHash() { return this.chain.tipHash(); }
  async blockHashAt(h) { return this.chain.blockHashAt(h); }

  async addressUtxos(address, script) {
    return this.chain.utxosForAddress(address).map((u) => ({
      txid: u.txid, vout: u.vout, value: u.value,
      script: hexToBytes(u.scriptHex),
      ranges: u.ranges, frogs: u.frogs,
      status: { confirmed: u.txid !== 'pending' },
    }));
  }

  async getTx(txid) {
    const entry = this.chain.txs.find((t) => t.txid === txid);
    if (!entry || !entry.hex) return null;
    const tx = parseTx(entry.hex);
    return {
      txid, hex: entry.hex,
      outputs: tx.outputs.map((o) => ({ value: Number(o.value), script: o.script })),
      status: { confirmed: entry.height != null, height: entry.height },
    };
  }

  async feeRate() { return 2; }
  async broadcast(hex) { return this.chain.submit(hex); }
  async fund(script, value = 200000, count = 8) {
    return this.chain.fund({ script, value, count });
  }

  async status() { return this.chain.status(); }
  async frogger(sat) { return this.chain.record(sat); }
  async froggers(params = {}) { return this.chain.listFrogs(params); }
  async utxo(txid, vout) { return this.chain.utxoDto(txid, vout); }
  async road() { return { active: this.chain.road() }; }
  async leaderboard(limit = 25) { return { entries: this.chain.leaderboard(limit) }; }
  async events(limit = 100) { return { events: this.chain.events.slice(-limit).reverse() }; }
  async fees() {
    return { suggested_sat_vb: 2, economy_sat_vb: 1, target_blocks: 3, source: 'demo', clamped: false };
  }
}

export class LiveBackend {
  constructor({ esploraUrl = '', indexerUrl = '', electrumUrl = '' } = {}) {
    this.kind = 'live';
    this.esplora = esploraUrl ? new EsploraClient(esploraUrl) : null;
    this.electrum = electrumUrl ? new ElectrumClient(electrumUrl) : null;
    this.indexer = indexerUrl ? new IndexerClient(indexerUrl) : null;
    this.chain = this.esplora || this.electrum;
    if (!this.chain) throw new Error('configure an Esplora or Electrum URL');
  }

  async tipHeight() { return this.chain.tipHeight(); }
  async tipHash() { return this.chain.tipHash(); }
  async blockHashAt(h) { return this.chain.blockHashAt(h); }

  async addressUtxos(address, script) {
    const list = await this.chain.addressUtxos(address, script);
    return list.map((u) => ({ ...u, script }));
  }

  async getTx(txid) { return this.chain.getTx(txid); }
  async getTxHex(txid) { return this.chain.getTxHex(txid); }
  async feeRate() { return this.chain.feeRate(); }
  async broadcast(hex) { return this.chain.broadcast(hex); }

  async status() { return this.indexer ? this.indexer.status() : null; }
  async frogger(sat) { return this.indexer ? this.indexer.frogger(sat) : null; }
  async froggers(params) { return this.indexer ? this.indexer.froggers(params) : { items: [], total: 0 }; }
  async utxo(txid, vout) { return this.indexer ? this.indexer.utxo(txid, vout) : null; }
  async road() { return this.indexer ? this.indexer.road() : { active: [] }; }
  async leaderboard(limit) { return this.indexer ? this.indexer.leaderboard(limit) : { entries: [] }; }
  async events(limit) { return this.indexer ? this.indexer.events(limit) : { events: [] }; }
  async fees() { return this.indexer ? this.indexer.fees() : null; }
}
