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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryableNetworkError(err) {
  const name = String(err?.name || '');
  const message = String(err?.message || err || '');
  if (name === 'AbortError' || /timed out/i.test(message)) return false;
  return name === 'TypeError' || /failed to fetch|network|socket|econn|fetch failed/i.test(message);
}

function corsOriginHint() {
  const origin = typeof location !== 'undefined' && location.origin
    ? location.origin
    : 'this page';
  return `the API must send Access-Control-Allow-Origin for ${origin}; curl does not enforce CORS`;
}

export class EsploraClient {
  /**
   * `metered` turns on a small client-side request queue and one retry.
   * Public Esplora hosts (Blockstream, mempool.space) collapse under a
   * 24-address gap walk fired eight-at-a-time; a browser then reports
   * `Failed to fetch` or times out. A local node stays unthrottled.
   */
  constructor(baseUrl, { metered = false } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.metered = !!metered;
    this.minIntervalMs = this.metered ? 300 : 0;
    this.retries = this.metered ? 1 : 0;
    this._last = 0;
    this._queue = Promise.resolve();
  }

  async req(path, opts = {}) {
    if (!this.metered) return this._req(path, opts, false);
    const run = this._queue.then(() => this._req(path, opts, true));
    // Keep the queue alive after a failed request; the caller still gets
    // the rejection because it holds `run`, not the swallowed tail.
    this._queue = run.catch(() => {});
    return run;
  }

  async _req(path, opts, paced) {
    let attempt = 0;
    for (;;) {
      if (paced) {
        const wait = this.minIntervalMs - (Date.now() - this._last);
        if (wait > 0) await sleep(wait);
      }
      try {
        // GETs must stay a CORS *simple* request. A content-type header is
        // only needed on the broadcast POST; adding it to every read made
        // some self-hosted Esplora proxies preflight or reject the request.
        const res = await timedFetch(this.base + path, {
          ...opts,
          headers: { ...(opts.headers || {}) },
        });
        this._last = Date.now();
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const err = new Error(`esplora ${path}: ${res.status}${body ? ` ${body.slice(0, 200)}` : ''}`);
          err.status = res.status;
          if (paced && attempt < this.retries
              && (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504)) {
            attempt += 1;
            await sleep(500 * attempt);
            continue;
          }
          throw err;
        }
        return res;
      } catch (err) {
        this._last = Date.now();
        if (paced && attempt < this.retries && retryableNetworkError(err)) {
          attempt += 1;
          await sleep(600 * attempt);
          continue;
        }
        if (retryableNetworkError(err)) {
          throw new Error(`cannot reach ${this.base}${path}: the browser blocked the request (CORS, extension/NoScript, or offline) — ${corsOriginHint()}`);
        }
        throw err;
      }
    }
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

  /**
   * The address's transaction list, in the shape the gap walk needs:
   * "has this script ever been used?". Esplora returns up to 50 recent
   * transactions (mempool + chain); an address with more history than
   * that is certainly used, so the page limit cannot make a used index
   * look empty.
   */
  async addressHistory(address) {
    const txs = await this.addressTxs(address);
    // Include the outputs and status already present in this answer. The
    // wallet uses them for its one-time receive backfill, so a spent
    // deposit can be reconstructed without a /tx request per transaction.
    return (Array.isArray(txs) ? txs : []).map((tx) => ({
      txid: tx.txid,
      height: tx.status?.block_height ?? null,
      status: tx.status || {},
      outputs: (tx.vout || []).map((o) => ({
        value: Number(o.value),
        script: hexToBytes(o.scriptpubkey),
        address: o.scriptpubkey_address || null,
      })),
    }));
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
    const res = await timedFetch(`${this.base}/tx`, {
      method: 'POST',
      body: hex,
      // mempool.space (and Esplora generally) read the raw hex body;
      // text/plain is also a CORS-safelisted content type, so this stays a
      // simple request with no preflight.
      headers: { 'content-type': 'text/plain' },
    }, 30000);
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
    this._headerListeners = new Set();
  }

  /** Notify when a NEW block header arrives (Electrum push). The first
   *  subscribe reply is the current tip, not a new block. */
  onNewBlock(fn) {
    this._headerListeners.add(fn);
    return () => this._headerListeners.delete(fn);
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
          const before = this.tip?.height;
          this.tip = msg.params[0];
          if (before != null && this.tip?.height !== before) {
            for (const fn of this._headerListeners) {
              try { fn(this.tip.height); } catch { /* listener is best-effort */ }
            }
          }
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
      txid: u.tx_hash, vout: u.tx_pos, value: Number(u.value),
      status: { height: u.height, confirmed: Number(u.height) > 0 },
    }));
  }

  /** Full history of one script. Used by the cold gap walk: an address
   *  whose coins were spent still has history, and treating it as unused
   *  would reuse an index. */
  async addressHistory(address, script) {
    await this.connect();
    const sh = this.scripthash(script);
    const list = await this.call('blockchain.scripthash.get_history', [sh]);
    return list.map((h) => ({ txid: h.tx_hash, height: h.height }));
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
  async events(limit = 100) {
    // The Rust API returns a bare array; DemoBackend returns {events}.
    // Normalize here so live History and the ROAD LOG are not silently empty.
    const answer = await this.get(`/v1/events?limit=${limit}`);
    return { events: Array.isArray(answer) ? answer : (answer?.events || []) };
  }
  fees() { return this.get('/v1/fees'); }
}

// --- public defaults -----------------------------------------------------

export const BLOCKSTREAM_ESPLORA = 'https://blockstream.info/api';
/** mempool.space speaks the same Esplora HTTP API as Blockstream. */
export const MEMPOOL_ESPLORA = 'https://mempool.space/api';
export const ORDINALS_COM = 'https://ordinals.com';

/**
 * Mainnet gets a public Esplora when the field is empty, mirroring the
 * ord default. Two deliberate exceptions: an explicit URL always wins,
 * and an Electrum URL suppresses the default because the wallet has one
 * chain backend and Esplora would otherwise hide the Electrum choice.
 * Regtest/testnet/signet have no public default.
 */
export function effectiveEsploraUrl(settings = {}, network = 'mainnet') {
  const explicit = normalizeEsploraUrl(settings.esploraUrl);
  if (explicit) return explicit;
  if (network !== 'mainnet') return '';
  if (String(settings.electrumUrl || '').trim()) return '';
  return BLOCKSTREAM_ESPLORA;
}

/**
 * Accept the host root people naturally paste. Both public providers serve
 * their Esplora API under /api; `https://mempool.space` alone would 404 on
 * every /blocks or /address path. Explicit paths are never rewritten.
 */
export function normalizeEsploraUrl(raw) {
  let text = String(raw || '').trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if ((host === 'mempool.space' || host === 'blockstream.info')
        && (url.pathname === '/' || url.pathname === '')) {
      url.pathname = '/api';
      return url.toString().replace(/\/$/, '');
    }
  } catch {
    // A malformed URL is returned as typed; the connection error names it.
  }
  return String(raw || '').trim();
}

// --- ord sat ranges ------------------------------------------------------

/**
 * The public default is ordinals.com on mainnet. Regtest/testnet have no
 * public ord, so an empty field stays empty there and the HOPPER indexer
 * answers ranges (or its own configured ord does). An explicit URL always
 * wins, including a self-hosted `http://127.0.0.1:8080`.
 */
export function effectiveOrdUrl(settings = {}, network = 'mainnet') {
  const explicit = String(settings.ordUrl || '').trim();
  if (explicit) return explicit;
  return network === 'mainnet' ? ORDINALS_COM : '';
}

/**
 * Minimal ord client for the one endpoint the wallet needs. The
 * recursive `/r/utxo/:outpoint` view is the public, CORS-enabled one
 * (FROGGER uses it too); the HOPPER indexer remains the source for
 * frogs, road and events.
 *
 * `sat_ranges` is half-open [start, end); the wallet's `ranges` are
 * inclusive, so `end - 1` is deliberate.
 */
export class OrdClient {
  constructor(baseUrl) {
    this.base = String(baseUrl || '').trim().replace(/\/+$/, '');
  }

  async output(txid, vout) {
    const id = String(txid || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id) || !Number.isSafeInteger(Number(vout)) || Number(vout) < 0) {
      return null;
    }
    const url = `${this.base}/r/utxo/${id}:${Number(vout)}`;
    const res = await timedFetch(url, { headers: { accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`ord ${id}:${vout}: ${res.status}`);
    const json = await res.json();
    const raw = json?.sat_ranges;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const value = Number(json.value);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`ord ${id}:${vout}: missing output value`);
    }
    let sum = 0;
    const ranges = raw.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) {
        throw new Error(`ord ${id}:${vout}: malformed sat range`);
      }
      const start = Number(pair[0]);
      const end = Number(pair[1]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= end) {
        throw new Error(`ord ${id}:${vout}: empty sat range`);
      }
      sum += end - start;
      return [start, end - 1];
    });
    if (!Number.isSafeInteger(sum) || sum !== value) {
      throw new Error(`ord ${id}:${vout}: ranges do not sum to the output value`);
    }
    return { value, ranges, exact: true, frogs: [], ord: true };
  }
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

  async addressHistory(address) { return this.chain.addressHistory(address); }

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
  async getTxHex(txid) {
    const entry = this.chain.txs.find((t) => t.txid === txid);
    return entry?.hex || null;
  }
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
  constructor({ esploraUrl = '', indexerUrl = '', electrumUrl = '', ordUrl = '', esploraMetered = false } = {}) {
    this.kind = 'live';
    this.esplora = esploraUrl
      ? new EsploraClient(normalizeEsploraUrl(esploraUrl), { metered: esploraMetered })
      : null;
    this.electrum = electrumUrl ? new ElectrumClient(electrumUrl) : null;
    this.indexer = indexerUrl ? new IndexerClient(indexerUrl) : null;
    this.ord = ordUrl ? new OrdClient(ordUrl) : null;
    this.chain = this.esplora || this.electrum;
    if (!this.chain) throw new Error('configure an Esplora or Electrum URL');
  }

  async tipHeight() { return this.chain.tipHeight(); }
  async tipHash() { return this.chain.tipHash(); }
  async blockHashAt(h) { return this.chain.blockHashAt(h); }

  /** Register a block-header callback. Only Electrum has a push
   *  subscription; Esplora callers fall back to the scheduler's tip
   *  poll. */
  onNewBlock(fn) {
    return this.electrum ? this.electrum.onNewBlock(fn) : () => {};
  }

  async addressUtxos(address, script) {
    const list = await this.chain.addressUtxos(address, script);
    return list.map((u) => ({ ...u, script }));
  }

  async addressHistory(address, script) {
    return this.chain.addressHistory(address, script);
  }

  async getTx(txid) { return this.chain.getTx(txid); }
  async getTxHex(txid) { return this.chain.getTxHex(txid); }
  async feeRate() { return this.chain.feeRate(); }
  async broadcast(hex) { return this.chain.broadcast(hex); }

  async status() { return this.indexer ? this.indexer.status() : null; }
  async frogger(sat) { return this.indexer ? this.indexer.frogger(sat) : null; }
  async froggers(params) { return this.indexer ? this.indexer.froggers(params) : { items: [], total: 0 }; }
  async utxo(txid, vout) {
    let fromIndexer = null;
    if (this.indexer) {
      try {
        fromIndexer = await this.indexer.utxo(txid, vout);
      } catch {
        // A coin the indexer has never seen is expected on a fresh chain.
        fromIndexer = null;
      }
      // Shadow/empty ranges mean the indexer cannot name the sats.
      if (fromIndexer?.exact && fromIndexer.ranges?.length) return fromIndexer;
    }
    if (this.ord) {
      try {
        const direct = await this.ord.output(txid, vout);
        if (direct) return { ...direct, frogs: fromIndexer?.frogs || [] };
      } catch {
        // Fall back to the indexer's shadow answer, if it had one.
      }
    }
    return fromIndexer;
  }
  async road() { return this.indexer ? this.indexer.road() : { active: [] }; }
  async leaderboard(limit) { return this.indexer ? this.indexer.leaderboard(limit) : { entries: [] }; }
  async events(limit) { return this.indexer ? this.indexer.events(limit) : { events: [] }; }
  async fees() { return this.indexer ? this.indexer.fees() : null; }
}
