// Per-outpoint sat-range cache.
//
// The sat ranges of an outpoint are immutable: a txid commits to its inputs,
// so `(txid, vout)` always names the same sats. The only thing that can
// invalidate an entry is the outpoint ceasing to exist — spent, or replaced
// by a conflicting transaction — which the live UTXO set already tells us.
// So a verified answer is reused for the life of the coin: across passes,
// index rechecks, reloads, reorgs and re-mining.
//
// Entries keep the answer in the backend DTO's own convention (`ranges` are
// `[start, end)` pairs, as ord and the mock chain return them) so a cache hit
// can be handed back exactly like a fresh answer. Only answers that are
// provably exact are stored: ordered, non-overlapping ranges that sum to the
// output value. A partial or carried-forward answer is never cached.

export const RANGE_CACHE_VERSION = 1;
export const RANGE_CACHE_MAX = 4096;

const TXID = /^[0-9a-f]{64}$/;

/** Canonical `txid:vout` key, or null when the outpoint is malformed. */
export function outpointKey(txid, vout) {
  const id = String(txid || '').toLowerCase();
  if (!TXID.test(id)) return null;
  const n = Number(vout);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return `${id}:${n}`;
}

/** Validate a range answer and return a normalized copy, or null when it
 *  cannot be proven exact for `value`. `ranges` are `[start, end)` pairs. */
export function normalizeRanges(ranges, value) {
  if (!Array.isArray(ranges) || ranges.length === 0) return null;
  const v = Number(value);
  if (!Number.isSafeInteger(v) || v <= 0) return null;
  const out = [];
  let sum = 0;
  let priorEnd = -1;
  for (const pair of ranges) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const a = Number(pair[0]);
    const b = Number(pair[1]);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
    if (a < 0 || b <= a) return null;
    if (out.length && a < priorEnd) return null; // overlap or disorder
    priorEnd = b;
    sum += b - a;
    out.push([a, b]);
  }
  return sum === v ? out : null;
}

export class RangeCache {
  constructor() { this.entries = new Map(); }

  get size() { return this.entries.size; }

  clear() {
    const had = this.entries.size > 0;
    this.entries.clear();
    return had;
  }

  /** Look up an outpoint. Touches the LRU clock. */
  get(txid, vout) {
    const key = outpointKey(txid, vout);
    if (!key) return null;
    const e = this.entries.get(key);
    if (!e) return null;
    e.t = Date.now();
    return e;
  }

  /** Store a verified answer. Returns false when it cannot be proven exact. */
  put(txid, vout, { value, ranges, address } = {}) {
    const key = outpointKey(txid, vout);
    if (!key) return false;
    const v = Number(value);
    const r = normalizeRanges(ranges, v);
    if (!r) return false;
    const prior = this.entries.get(key);
    this.entries.set(key, {
      v,
      r,
      a: typeof address === 'string' ? address : (prior?.a || ''),
      t: Date.now(),
      m: 0,
    });
    this.prune();
    return true;
  }

  /** Count a miss for a live outpoint the oracle could not name yet (ord
   *  index lag, 404). Never creates an entry. */
  noteMiss(txid, vout) {
    const key = outpointKey(txid, vout);
    if (!key) return 0;
    const e = this.entries.get(key);
    if (!e) return 0;
    e.m += 1;
    return e.m;
  }

  drop(txid, vout) {
    const key = outpointKey(txid, vout);
    return key ? this.entries.delete(key) : false;
  }

  /** Drop the entries belonging to one address whose outpoints are no longer
   *  live. Only call this after a COMPLETE address answer: a partial pass
   *  must never treat absence as evidence. */
  dropMissing(address, liveKeys) {
    let n = 0;
    for (const [key, e] of this.entries) {
      if (e.a === address && !liveKeys.has(key)) {
        this.entries.delete(key);
        n += 1;
      }
    }
    return n;
  }

  /** Evict the least recently used entries above `max`. */
  prune(max = RANGE_CACHE_MAX) {
    if (this.entries.size <= max) return 0;
    const byAge = [...this.entries.entries()].sort((p, q) => (p[1].t || 0) - (q[1].t || 0));
    let n = 0;
    for (const [key] of byAge) {
      if (this.entries.size <= max) break;
      this.entries.delete(key);
      n += 1;
    }
    return n;
  }

  /** Compact persisted form: [value, ranges, address, lastUsed, misses]. */
  toJSON() {
    const entries = {};
    for (const [key, e] of this.entries) {
      entries[key] = [e.v, e.r, e.a || '', e.t || 0, e.m || 0];
    }
    return { version: RANGE_CACHE_VERSION, entries };
  }

  /** Replace the cache from persisted JSON. Malformed rows are skipped; a
   *  version mismatch loads nothing (safe: it only costs asks). */
  load(doc) {
    this.entries.clear();
    if (!doc || doc.version !== RANGE_CACHE_VERSION || !doc.entries
        || typeof doc.entries !== 'object') return 0;
    let n = 0;
    for (const [key, row] of Object.entries(doc.entries)) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const sep = key.lastIndexOf(':');
      if (sep < 1) continue;
      const txid = key.slice(0, sep);
      const vout = key.slice(sep + 1);
      if (outpointKey(txid, vout) !== key) continue; // non-canonical key
      const [v, r, a, t, m] = row;
      const ranges = normalizeRanges(r, v);
      if (!ranges) continue;
      this.entries.set(key, {
        v: Number(v),
        r: ranges,
        a: typeof a === 'string' ? a : '',
        t: Number(t) || 0,
        m: Number(m) || 0,
      });
      n += 1;
    }
    this.prune();
    return n;
  }
}
