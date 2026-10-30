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
import {
  DemoBackend, LiveBackend, effectiveEsploraUrl, effectiveOrdUrl,
} from './backend.js';
import { parseLocalMint } from './localmint.js';
import { buildMintOffThread } from './mint-client.js';
import { KEYS, loadJson, saveJson } from './storage.js';
import {
  anchorOffsetOf, buildCross, buildMint, buildPrepare, buildSend,
  buildTransfer, stateScripts,
} from './actions.js';
import {
  RBF_POLICY, buildReplacement, buildSendRbfEnvelope, safeBumpFunding,
} from './rbf.js';

// The FROGGER scan policy, ported to the browser wallet.
//
// A settled chain answer can change only with a block, so a warm pass asks
// about a handful of scripts (the ordinals address, the next unused index
// per branch plus one guard, and the indices that held coins last pass).
// The full gap walk is a COLD-only cost: boot, RESCAN, EXTEND. A public
// source gets one tip probe every ten minutes while idle, and a 15 s
// cadence only while something of ours is in flight.
export const GAP_LIMIT = 20;
export const SCAN_WAVE = 8;
export const WATCH_AHEAD = 2;
export const PUBLIC_IDLE_TICK_MS = 10 * 60 * 1000;
export const PUBLIC_BUSY_TICK_MS = 15 * 1000;
export const RESCAN_DELAY_MS = 400;
export const LOCAL_TICK_MS = 3000;

/** Same bounded backoff as FROGGER: 5, 10, 20, 40, 80, 160, 300 s. */
export function failureBackoffMs(fails) {
  const n = Math.max(1, Math.min(7, Math.trunc(Number(fails) || 1)));
  return Math.min(300_000, 5_000 * (2 ** (n - 1)));
}

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;
  if (h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  return /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

/** A metered, someone-else's endpoint. A local node/pool is free. */
export function isPublicEndpoint(url) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  try {
    return !isPrivateHost(new URL(raw).hostname);
  } catch {
    // A malformed URL is not a local node; be conservative about it.
    return true;
  }
}

export function settingsPublicSource(settings = {}) {
  if (settings.mode === 'demo') return false;
  return [settings.esploraUrl, settings.indexerUrl, settings.electrumUrl, settings.ordUrl]
    .some((url) => isPublicEndpoint(url));
}

/** `next_unused`: what the wallet has SEEN, never a chain walk. */
export function nextUnusedIndex(lastUsed = {}, receiveFloor = 0, branch = 0) {
  const seen = Number(lastUsed?.[branch]);
  const next = Number.isSafeInteger(seen) && seen >= 0 ? seen + 1 : 0;
  return branch === 0 ? Math.max(next, Number(receiveFloor) || 0) : next;
}

/**
 * The WARM plan: 6–10 scripts, not every address up to the gap limit.
 * `next - 1` is included because that is where this wallet's change (and
 * the coin a mint/reveal left behind) actually sits.
 */
export function buildWatchPlan({ lastUsed = {}, receiveFloor = 0, hot = [] } = {}) {
  const plan = new Map();
  const add = (branch, index) => {
    const b = Number(branch);
    const i = Number(index);
    if ((b !== 0 && b !== 1) || !Number.isSafeInteger(i) || i < 0) return;
    plan.set(`${b}:${i}`, [b, i]);
  };
  add(0, receiveFloor);
  for (const branch of [0, 1]) {
    const next = nextUnusedIndex(lastUsed, receiveFloor, branch);
    add(branch, Math.max(0, next - 1));
    for (let i = 0; i < WATCH_AHEAD; i += 1) add(branch, next + i);
  }
  for (const pair of hot || []) {
    if (Array.isArray(pair)) add(pair[0], pair[1]);
  }
  return [...plan.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** The COLD plan: every index the gap walk reached, plus the warm plan. */
export function buildColdPlan(warmPlan, watched = {}) {
  const plan = new Map((warmPlan || []).map(([b, i]) => [`${b}:${i}`, [b, i]]));
  for (const branch of [0, 1]) {
    const end = Number(watched?.[branch]) || 0;
    for (let i = 0; i < end; i += 1) plan.set(`${branch}:${i}`, [branch, i]);
  }
  return [...plan.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/** A fresh wallet need not look at change; a restore/rescan must. */
export function shouldSkipChange(rescanning, receiveFound, receiveFloor, spendable) {
  return !rescanning && !receiveFound && !receiveFloor && !spendable;
}

/** An address query already tells us whether its outputs are settled.
 *  Esplora sends `status.confirmed`; Electrum sends height 0 for mempool.
 *  Do not make a second request just to classify a coin. */
export function isUnconfirmedUtxo(u) {
  const st = u?.status || {};
  if (st.confirmed === true) return false;
  if (st.confirmed === false) return true;
  return (st.height != null && Number(st.height) === 0)
    || (st.block_height != null && Number(st.block_height) === 0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  mode: 'live',
  esploraUrl: '',
  indexerUrl: '',
  electrumUrl: '',
  ordUrl: '',
  feeRate: 2,
  sound: true,
  mute: false,
  volume: 0.55,
  deepScan: false,
  gap: GAP_LIMIT,
  gapExtra: 0,
  addressBook: [],
};

export function loadSettings() {
  const saved = loadJson(KEYS.settings, {}) || {};
  const s = { ...DEFAULT_SETTINGS, ...saved };
  // Settings are user-editable and survive upgrades. Normalize the values
  // that flow into fee math or the scan loop so a corrupt/empty field can
  // never become NaN or an unbounded gap.
  s.mode = s.mode === 'live' ? 'live' : 'demo';
  s.ordUrl = String(s.ordUrl || '').trim();
  s.feeRate = rateOr(s.feeRate);
  // Compatibility: older files had a user-editable 5–50 gap and no
  // extension. Keep a wider old setting by turning the part above the
  // built-in 20 into a persisted extension, never by shrinking it (that
  // could strand a payment made to an address the old build watched).
  const legacyGap = Number(s.gap);
  let extra = Number(saved.gapExtra);
  if (!Number.isFinite(extra) || extra < 0) {
    extra = Number.isFinite(legacyGap) ? Math.max(0, Math.trunc(legacyGap) - GAP_LIMIT) : 0;
  }
  s.gapExtra = Math.max(0, Math.min(1_000_000, Math.trunc(extra)));
  s.gap = GAP_LIMIT + s.gapExtra;
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
  constructor({ mnemonic, network = 'mainnet', fingerprint, settings = null }) {
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
    this.mempool = [];
    this.pending = [];
    this.imported = new Set();
    this.tipHeight = null;
    this.tipHash = null;
    this.receiveIndex = 0;
    this.receiveFloor = 0;
    this.receiveHistory = [];
    this.balance = { total: 0n, spendable: 0n, cards: 0n, unspendable: 0n, pending: 0n };
    // Scan state, persisted where it matters and rebuilt by the next cold
    // pass where it does not. `fullScanTip` is the FROGGER tip gate.
    this.used = {};
    this.lastUsed = {};
    this.hot = [];
    this.watched = {};
    this.fullScanTip = null;
    this.watchTip = null;
    this.forceWatch = false;
    this.cold = true;
    this.fails = 0;
    this.publicSource = false;
    this.scan = {
      busy: false, rescan: null, note: '', lastPass: null, lastTip: null,
      nextAt: null, cold: true, partial: false,
    };
    this._autoSync = false;
    this._timer = null;
    this._refreshing = null;
    this._wakeQueued = false;
    this._rescanCancel = false;
    this._stopped = false;
    this._blockUnsub = null;
    this._visHandler = null;
    this._txCache = new Map();
    this._localMintCache = new Map();
    this._loadLedger();
  }

  // --- persistence -------------------------------------------------------

  _ledgerKey() { return KEYS.ledger(this.fingerprint); }

  _loadLedger() {
    const l = loadJson(this._ledgerKey(), null);
    if (!l) return;
    this.actions = l.actions || [];
    this.pending = Array.isArray(l.pending) ? l.pending.filter((p) => p && p.txid) : [];
    this.history = l.history || [];
    this.mempool = Array.isArray(l.mempool)
      ? l.mempool.filter((m) => m && m.txid && Number.isSafeInteger(m.amount) && m.amount > 0)
        .slice(-50)
      : [];
    this.imported = new Set(l.imported || []);
    this.used = l.used || {};
    this.lastUsed = l.lastUsed && typeof l.lastUsed === 'object' ? l.lastUsed : {};
    this.hot = Array.isArray(l.hot)
      ? l.hot.filter((p) => Array.isArray(p) && (p[0] === 0 || p[0] === 1) && Number.isSafeInteger(Number(p[1])))
        .map((p) => [Number(p[0]), Number(p[1])])
      : [];
    this.fullScanTip = Number.isSafeInteger(l.fullScanTip) ? l.fullScanTip : null;
    this.receiveFloor = Number.isSafeInteger(l.receiveFloor)
      ? Math.min(1_000_000, Math.max(0, l.receiveFloor)) : 0;
    const gap = this.gapLimit();
    const index = Number(l.receiveIndex);
    this.receiveIndex = Number.isInteger(index) && index >= 0
      ? Math.min(1_000_000, index) : 0;
    this.receiveFloor = Math.max(this.receiveFloor, this.receiveIndex);
    this.receiveHistory = Array.isArray(l.receiveHistory) ? l.receiveHistory.slice(-gap * 4) : [];
    if (l.balance && typeof l.balance === 'object') {
      const big = (v) => { try { return BigInt(v); } catch { return 0n; } };
      this.balance = {
        total: big(l.balance.total), spendable: big(l.balance.spendable),
        cards: big(l.balance.cards), unspendable: big(l.balance.unspendable),
        pending: big(l.balance.pending),
      };
    }
  }

  _saveLedger() {
    saveJson(this._ledgerKey(), {
      network: this.network,
      actions: this.actions.slice(-300),
      pending: this.pending.slice(-24),
      history: this.history.slice(-200),
      mempool: this.mempool.slice(-50),
      imported: [...this.imported],
      used: this.used || {},
      lastUsed: this.lastUsed || {},
      hot: this.hot || [],
      fullScanTip: this.fullScanTip,
      receiveFloor: this.receiveFloor || 0,
      receiveIndex: this.receiveIndex || 0,
      receiveHistory: this.receiveHistory || [],
      balance: {
        total: String(this.balance.total), spendable: String(this.balance.spendable),
        cards: String(this.balance.cards), unspendable: String(this.balance.unspendable),
        pending: String(this.balance.pending || 0n),
      },
      lastRefresh: new Date().toISOString(),
      tipHeight: this.tipHeight,
    });
  }

  // --- backend -----------------------------------------------------------

  async connect() {
    this.stop();
    this._stopped = false;
    if (this.settings.mode === 'demo') {
      this.backend = new DemoBackend(this.network);
    } else {
      const esploraUrl = effectiveEsploraUrl(this.settings, this.network);
      this.backend = new LiveBackend({
        esploraUrl,
        indexerUrl: this.settings.indexerUrl,
        electrumUrl: this.settings.electrumUrl,
        ordUrl: effectiveOrdUrl(this.settings, this.network),
      });
    }
    const effective = {
      ...this.settings,
      esploraUrl: effectiveEsploraUrl(this.settings, this.network),
      ordUrl: effectiveOrdUrl(this.settings, this.network),
    };
    this.publicSource = settingsPublicSource(effective);
    this._setupAutoSync();
    return this;
  }

  /** A different chain/indexer must not inherit scan pointers from the
   *  previous backend. A demo tip (H 973,263) is not a live tip and could
   *  make the first live pass skip its cold gap walk. The next refresh is
   *  forced, so the caller immediately pays for the cold scan it asked for. */
  resetScan(note = 'backend changed — a cold scan will start') {
    this.fullScanTip = null;
    this.watchTip = null;
    this.cold = true;
    this.forceWatch = true;
    this.scan.note = note;
    this.scan.partial = false;
    this.scan.lastPass = null;
    this.scan.lastTip = null;
    this.scan.nextAt = null;
    this._saveLedger();
  }

  /** Stop background work (lock/wipe/backend change). Network requests
   *  already in flight are left to finish; nothing is rescheduled. */
  stop() {
    this._autoSync = false;
    this._stopped = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._wakeQueued = false;
    this.scan.nextAt = null;
    if (this._blockUnsub) {
      try { this._blockUnsub(); } catch { /* already gone */ }
      this._blockUnsub = null;
    }
    if (this._visHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visHandler);
      this._visHandler = null;
    }
  }

  _setupAutoSync() {
    this._autoSync = true;
    if (typeof document !== 'undefined' && !this._visHandler) {
      this._visHandler = () => { if (!document.hidden) this._wake(); };
      document.addEventListener('visibilitychange', this._visHandler);
    }
    if (this.backend?.onNewBlock) {
      this._blockUnsub = this.backend.onNewBlock(() => this._wake());
    }
  }

  /** FROGGER's `tick_interval`: failure backoff, then public idle/busy,
   *  then the local node's own cadence. */
  tickIntervalMs() {
    if (this.fails > 0) return failureBackoffMs(this.fails);
    if (!this.publicSource) return LOCAL_TICK_MS;
    return this._inFlight() ? PUBLIC_BUSY_TICK_MS : PUBLIC_IDLE_TICK_MS;
  }

  _inFlight() {
    if ((this.pending || []).length) return true;
    return this.frogs.some((f) => String(f?.state) === 'crossing' || f?.in_flight);
  }

  /** Clear broadcasts that confirmed, and expire a transaction that never
   *  landed (so a dropped relay cannot make a public source poll forever).
   *  One `getTx` per pending tx, only while one is actually pending. */
  async _reconcilePending(tip) {
    if (!this.pending?.length) return;
    const seen = new Set((this.history || []).map((e) => e.txid).filter(Boolean));
    const keep = [];
    for (const p of this.pending) {
      if (!p?.txid || seen.has(p.txid)) continue;
      if (Number.isInteger(p.sinceTip) && tip - p.sinceTip > 144) continue;
      try {
        const tx = await this.backend.getTx(p.txid);
        const st = tx?.status || {};
        if (st.confirmed === true || Number.isInteger(st.block_height) || Number.isInteger(st.height)) continue;
      } catch { /* a mempool/API miss is not a confirmation */ }
      keep.push(p);
    }
    this.pending = keep;
  }

  _scheduleNext(ms = this.tickIntervalMs()) {
    if (!this._autoSync || this._stopped) return;
    if (this._timer) clearTimeout(this._timer);
    this.scan.nextAt = Date.now() + ms;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._tick();
    }, Math.max(0, ms));
    if (this._timer?.unref) this._timer.unref();
  }

  _tick() {
    if (!this._autoSync || this._stopped) return;
    if (typeof document !== 'undefined' && document.hidden) {
      this._scheduleNext();
      return;
    }
    this.refresh({ force: false, auto: true }).catch((e) => {
      console.warn('background sync failed', e.message || String(e));
    });
  }

  _wake() {
    if (!this._autoSync || this._stopped) return;
    this._wakeQueued = true;
    if (this._refreshing) return;
    this._wakeQueued = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._scheduleNext(250);
  }

  gapLimit() { return GAP_LIMIT + (Number(this.settings.gapExtra) || 0); }

  _noteUsed(branch, index) {
    const b = Number(branch);
    const i = Number(index);
    if ((b !== 0 && b !== 1) || !Number.isSafeInteger(i) || i < 0) return;
    const prev = Number(this.lastUsed?.[b]);
    if (!Number.isSafeInteger(prev) || i > prev) this.lastUsed = { ...this.lastUsed, [b]: i };
  }

  scanState() {
    return {
      busy: this.scan.busy,
      rescan: this.scan.rescan ? { ...this.scan.rescan } : null,
      note: this.scan.note,
      lastPass: this.scan.lastPass,
      lastTip: this.scan.lastTip,
      nextAt: this.scan.nextAt,
      cold: this.cold,
      partial: this.scan.partial,
      publicSource: this.publicSource,
      fails: this.fails,
      pending: (this.pending || []).length,
      tip: this.tipHeight,
      fullScanTip: this.fullScanTip,
      gapLimit: this.gapLimit(),
      gapExtra: Number(this.settings.gapExtra) || 0,
      auto: this._autoSync,
    };
  }

  async setMode(mode, urls = {}) {
    this.settings.mode = mode;
    Object.assign(this.settings, urls);
    saveSettings(this.settings);
    await this.connect();
    await this.refresh();
  }

  // --- discovery ---------------------------------------------------------

  _entry(branch, index) {
    if (branch === 'ord') {
      return {
        branch: 'ord', index: 0, key: this.keys.ord,
        address: this.keys.frogAddress(),
        script: p2trScript(this.keys.ord.outputXonly), kind: 'frog',
      };
    }
    const b = Number(branch);
    const i = Number(index);
    if ((b !== 0 && b !== 1) || !Number.isSafeInteger(i) || i < 0) return null;
    const key = b === 0 ? this.keys.receive(i) : this.keys.change(i);
    return { branch: b, index: i, key, address: key.address, script: key.script, kind: 'p2wpkh' };
  }

  _watchPlan() {
    const floor = Math.max(Number(this.receiveFloor) || 0, Number(this.receiveIndex) || 0);
    return buildWatchPlan({ lastUsed: this.lastUsed, receiveFloor: floor, hot: this.hot });
  }

  _plan(cold) {
    const plan = this._watchPlan();
    return cold ? buildColdPlan(plan, this.watched) : plan;
  }
  async _getTx(txid) {
    if (this._txCache.has(txid)) return this._txCache.get(txid);
    const tx = await this.backend.getTx(txid).catch(() => null);
    if (tx) this._txCache.set(txid, tx);
    return tx;
  }

  /** A user-facing refresh is forced; the scheduler calls with force:false
   *  so an unchanged tip can pass without a single address query. */
  async refresh({ deep = null, force = true } = {}) {
    if (!this.backend) await this.connect();
    if (this._refreshing) {
      if (force) this.forceWatch = true;
      return this._refreshing;
    }
    const wantedForce = force || this.forceWatch;
    this.scan.busy = true;
    this.dispatch('scan', this.scanState());
    const job = this._refreshInner({ deep, force: wantedForce });
    this._refreshing = job;
    try {
      await job;
    } catch (e) {
      this._noteFailure(e);
      throw e;
    } finally {
      if (this._refreshing === job) this._refreshing = null;
      this.scan.busy = false;
      if (this._autoSync && !this._stopped) {
        if (this._wakeQueued) {
          this._wakeQueued = false;
          this._scheduleNext(0);
        } else {
          this._scheduleNext();
        }
      }
      this.dispatch('scan', this.scanState());
    }
    return this;
  }

  _noteFailure(err) {
    const why = err?.message || String(err);
    this.fails += 1;
    this.watchTip = null;
    this.scan.partial = true;
    this.scan.note = `sync failed: ${why} (retry in ${Math.round(this.tickIntervalMs() / 1000)}s)`;
    if (this.scan.rescan) {
      const { asked } = this.scan.rescan;
      this.scan.rescan = null;
      this.scan.note = `rescan failed after ${asked} addresses: ${why}`;
      this._rescanCancel = false;
    }
    this._saveLedger();
  }

  async _refreshInner({ deep: deepOpt = null, force: forceOpt = false } = {}) {
    let tip;
    let tipNote = null;
    try {
      tip = Number(await this.backend.tipHeight());
      if (!Number.isFinite(tip)) throw new Error('chain returned no tip height');
    } catch (e) {
      // The balance does not need the height. Fall back to the last height
      // this wallet saw, but a cold start has no previous answer to use.
      const last = [this.watchTip, this.fullScanTip, this.tipHeight]
        .find((h) => Number.isSafeInteger(h));
      if (last == null) throw e;
      tip = last;
      tipNote = `tip height unavailable (${e.message || String(e)}) — using ${last}`;
    }
    this.tipHeight = tip;
    await this._reconcilePending(tip);

    let force = !!forceOpt || this.forceWatch;
    this.forceWatch = false;

    // THE GATE. A settled answer can change only with a block. While
    // nothing of ours is in flight, an unchanged tip costs one request.
    if (!force && !this.scan.rescan && this.fullScanTip != null
        && this.watchTip === tip && !this._inFlight()) {
      this.scan.lastPass = Date.now();
      this.scan.lastTip = tip;
      this.scan.partial = false;
      this.scan.note = tipNote
        ? `${tipNote} · no address queries`
        : `tip ${tip} unchanged — ${this.publicSource ? 'public source' : 'local node'} asked nothing`;
      return this;
    }

    this.cold = this.fullScanTip == null;
    this._txCache.clear();
    const previousUtxos = this.utxos.slice();
    const previousFrogs = this.frogs.slice();
    const previousMempool = this.mempool.slice();
    const previousBalance = this.balance;
    const previousHot = (this.hot || []).slice();
    const used = { ...(this.used || {}) };
    const notes = [];
    if (tipNote) notes.push(tipNote);
    const rescanning = !!this.scan.rescan;
    let readFailed = null;
    let cancelled = false;
    let receiveFound = false;
    let asked = 0;
    let hits = 0;

    // 0. COLD GAP WALK. Only boot, RESCAN and EXTEND reach this. Small
    //    concurrent waves (SCAN_WAVE) keep the user from staring at a
    //    spinner; a rescan on a public source waits RESCAN_DELAY between
    //    waves, reports progress, and can be stopped.
    if (this.cold) {
      for (const branch of [0, 1]) {
        if (branch === 1 && shouldSkipChange(
          rescanning, receiveFound, this.receiveFloor, Number(this.balance.spendable),
        )) {
          notes.push('change addresses not scanned (nothing on receive); RESCAN walks them');
          continue;
        }
        let index = 0;
        let consecutiveEmpty = 0;
        const floor = branch === 0
          ? Math.max(Number(this.receiveIndex) || 0, Number(this.receiveFloor) || 0)
          : 0;
        const gapLimit = this.gapLimit();
        while (!(consecutiveEmpty >= gapLimit && index > floor)) {
          if (this._stopped) { cancelled = true; break; }
          const wave = [];
          for (let n = 0; n < SCAN_WAVE; n += 1, index += 1) {
            const entry = this._entry(branch, index);
            if (entry) wave.push(entry);
          }
          const answers = await mapLimit(wave, SCAN_WAVE, async (w) => {
            try {
              const hist = this.backend.addressHistory
                ? await this.backend.addressHistory(w.address, w.script)
                : await this.backend.addressUtxos(w.address, w.script);
              return { ok: true, history: Array.isArray(hist) ? hist : [] };
            } catch (e) {
              return { ok: false, error: e };
            }
          });
          for (let i = 0; i < wave.length; i += 1) {
            asked += 1;
            const answer = answers[i];
            if (!answer.ok) {
              readFailed = answer.error?.message || String(answer.error);
              break;
            }
            if (answer.history.length === 0) {
              consecutiveEmpty += 1;
            } else {
              consecutiveEmpty = 0;
              hits += 1;
              if (branch === 0) {
                receiveFound = true;
                used[wave[i].address] = true;
              }
              this._noteUsed(branch, wave[i].index);
            }
          }
          if (readFailed) break;
          if (rescanning) {
            this.scan.rescan = { asked, hits };
            this.dispatch('scan', this.scanState());
            if (this._rescanCancel) { cancelled = true; break; }
            if (this.publicSource) await sleep(RESCAN_DELAY_MS);
          }
        }
        this.watched[branch] = Math.max(Number(this.watched[branch]) || 0, index);
        if (readFailed || cancelled) break;
      }
    }

    // 1. WATCH PLAN. A warm pass asks about the ordinals address, the
    //    next unused index on each branch plus one guard, the last used
    //    index, and every index that held coins last pass. A cold pass
    //    asks about everything the walk reached.
    const entries = [];
    for (const [branch, index] of this._plan(this.cold)) {
      const entry = this._entry(branch, index);
      if (entry) entries.push(entry);
    }
    entries.push(this._entry('ord'));

    const utxos = [];
    const mempoolByTx = new Map();
    const queriedOk = new Set();
    let hotNow = [];
    let watchFailed = null;
    const prevByAddress = new Map();
    for (const u of previousUtxos) {
      if (!u.address) continue;
      if (!prevByAddress.has(u.address)) prevByAddress.set(u.address, []);
      prevByAddress.get(u.address).push(u);
    }

    // Sequential on purpose: a warm pass is 6–10 scripts and a public
    // source must not see them as a burst.
    for (const w of entries) {
      let list;
      try {
        list = await this.backend.addressUtxos(w.address, w.script);
        if (!Array.isArray(list)) list = [];
        queriedOk.add(w.address);
      } catch (e) {
        watchFailed = e.message || String(e);
        list = prevByAddress.get(w.address) || [];
        for (const u of list) utxos.push(u);
        continue;
      }
      const dtos = await mapLimit(list, 2, async (u) => {
        try { return await this.backend.utxo(u.txid, u.vout); } catch { return null; }
      });
      // The UTXO answer already carries mempool status. Aggregate outputs
      // from one transaction into one history row; nothing here asks the
      // backend anything new.
      list.forEach((u) => {
        if (!isUnconfirmedUtxo(u)) return;
        const txid = String(u.txid || '');
        if (!txid) return;
        const row = mempoolByTx.get(txid) || {
          txid, amount: 0, address: w.address, vout: Number(u.vout) || 0, at: null,
        };
        row.amount += Number(u.value) || 0;
        if (!row.address) row.address = w.address;
        mempoolByTx.set(txid, row);
      });
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
          status: u.status || null, unconfirmed: isUnconfirmedUtxo(u),
          key, keyRef: { branch: w.branch, index: w.index },
          spendable: kind !== 'state' && exact && !frogs.length,
        });
      });
      if (list.length) {
        if (w.branch === 0) {
          used[w.address] = true;
          this._noteReceiveAddress(w.address);
        }
        if (typeof w.branch === 'number') {
          this._noteUsed(w.branch, w.index);
          if (!hotNow.some(([b, i]) => b === w.branch && i === w.index)) {
            hotNow.push([w.branch, w.index]);
          }
        }
      }
    }

    // A pass that could not name every address keeps the coins it already
    // knew: absence is not evidence. Only a completed pass may shrink hot.
    const preserve = !!(readFailed || watchFailed || cancelled);
    if (preserve) {
      const queried = new Set(entries.map((w) => w.address));
      for (const u of previousUtxos) {
        if (!u.address || !queried.has(u.address)) {
          if (!utxos.some((x) => x.txid === u.txid && x.vout === u.vout)) utxos.push(u);
        }
      }
      const merged = new Map();
      for (const pair of [...previousHot, ...hotNow]) merged.set(`${pair[0]}:${pair[1]}`, pair);
      hotNow = [...merged.values()];
      for (const row of previousMempool) {
        if (!row?.txid || queriedOk.has(row.address)) continue;
        if (!mempoolByTx.has(row.txid)) mempoolByTx.set(row.txid, { ...row });
      }
    }
    this.hot = hotNow;
    this.mempool = [...mempoolByTx.values()].sort((a, b) => b.amount - a.amount);
    if (readFailed) notes.push(`gap walk stopped: ${readFailed}`);
    if (watchFailed) notes.push(`address scan stopped: ${watchFailed}`);
    if (cancelled) notes.push(`scan stopped by user after ${asked} addresses`);
    // The session was locked/wiped/pointed at another backend while this
    // pass was in flight. Do not write a ledger after the vault is gone.
    if (this._stopped) return this;

    // 2. Frog candidates: imported sats, sats on our coins, and (optionally)
    //    a bounded public scan so a restored wallet finds state outputs that
    //    live at no derivation path.
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

    // A mint reveals its own inscription in the taproot witness. Recover
    // that record even when no HOPPER indexer is configured (the public
    // defaults have none) and ord's range endpoint is unavailable.
    const localMints = await this._localMintRecords(utxos, records);
    for (const record of localMints) {
      if (records.has(record.sat)) continue;
      records.set(record.sat, record);
      candidates.add(record.sat);
    }
    if (localMints.length) {
      notes.push(`${localMints.length} Hopper mint${localMints.length === 1 ? '' : 's'} recognized from the ord address`);
    }

    let recordFailed = false;
    const missing = [...candidates].filter((sat) => !records.has(sat));
    const fetched = await mapLimit(missing, 4, async (sat) => {
      try { return [sat, await this.backend.frogger(sat)]; } catch { return [sat, null]; }
    });
    for (const [sat, record] of fetched) {
      if (record) records.set(sat, record);
      else recordFailed = true;
    }

    let ownershipFailed = false;
    const ownership = await mapLimit(
      [...candidates].filter((sat) => records.has(sat)),
      4,
      async (sat) => {
        try {
          return [sat, records.get(sat), await this._ownsFrog(records.get(sat), utxos)];
        } catch {
          ownershipFailed = true;
          return [sat, records.get(sat), { owned: false, error: true }];
        }
      },
    );

    const frogs = [];
    for (const [sat, record, owned] of ownership) {
      if (!owned.owned) {
        if (owned.error) ownershipFailed = true;
        continue;
      }
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
    if (recordFailed) notes.push('some Hopper records could not be fetched');
    if (ownershipFailed) notes.push('some Hopper ownership checks did not answer — known frogs stay visible');

    // On an incomplete pass a registered frog must not vanish. This is the
    // same "no opinion" rule FROGGER applies to a failed UTXO pass.
    if (preserve || recordFailed || ownershipFailed) {
      for (const f of previousFrogs) {
        if (!frogs.some((g) => Number(g.sat) === Number(f.sat))) frogs.push(f);
      }
    }

    const unique = new Map();
    for (const u of utxos) unique.set(`${u.txid}:${u.vout}`, u);
    this.utxos = [...unique.values()].sort((a, b) => b.value - a.value);
    this.frogs = frogs.sort((a, b) => b.dist - a.dist || a.sat - b.sat);
    this.used = used;

    const priorTotal = this.balance.total;
    this._computeBalance();
    if (preserve && this.balance.total < priorTotal) this.balance = previousBalance;
    // A receive address that has been paid is retired. If the receive window
    // is open, the receive-address event repaints it with the next one; if it
    // is closed, the wallet simply opens on a fresh address next time.
    const rotatedReceive = this._rotatePaidReceive();

    try {
      const ev = await this.backend.events(200);
      this.history = (ev.events || []).map((e) => ({
        height: e.height, txid: e.txid, blockHash: e.block_hash,
        kind: e.action.kind || e.action.action, payload: e.action,
      }));
    } catch { /* history is optional */ }

    // 3. Scan bookkeeping and the tip gate.
    if (rescanning) {
      const note = cancelled
        ? `rescan stopped after ${asked} addresses (${hits} had history) — the rest was not checked`
        : readFailed
          ? `rescan failed after ${asked} addresses — the chain source stopped answering`
          : `rescan complete: ${asked} addresses asked, ${hits} with history`;
      notes.unshift(note);
      this.scan.rescan = null;
      this._rescanCancel = false;
    }
    if (readFailed || watchFailed) {
      this.fails += 1;
      this.watchTip = null;
    } else {
      this.fails = 0;
      this.watchTip = tip;
    }
    if (this.cold) {
      if (!readFailed && !cancelled) {
        this.fullScanTip = tip;
        this.cold = false;
      }
    }
    this.scan.lastPass = Date.now();
    this.scan.lastTip = tip;
    this.scan.partial = !!(readFailed || watchFailed || cancelled || recordFailed || ownershipFailed);
    if (this._stopped) return this;
    if (!notes.length) notes.push(`synced at block ${tip}`);
    this.scan.note = notes.join(' · ');
    this._saveLedger();
    this.dispatch('refresh', this.summary());
    if (rotatedReceive) this.dispatch('receive-address', rotatedReceive);
    return this;
  }

  // --- manual scan controls (FROGGER's RESCAN / STOP / EXTEND) ----------

  async startRescan() {
    if (!this.backend) await this.connect();
    if (this.scan.rescan) return false;
    if (this._refreshing) {
      try { await this._refreshing; } catch { /* the rescan can still start */ }
    }
    if (this.scan.rescan) return false;
    this._rescanCancel = false;
    this.scan.rescan = { asked: 0, hits: 0 };
    this.scan.note = 'rescanning from the chain — this walks every address in the gap';
    this.fullScanTip = null;
    this.cold = true;
    this.forceWatch = true;
    this.dispatch('scan', this.scanState());
    await this.refresh({ force: true });
    return true;
  }

  cancelRescan() {
    if (!this.scan.rescan) return false;
    this._rescanCancel = true;
    this.scan.note = 'stopping after this wave…';
    this.dispatch('scan', this.scanState());
    return true;
  }

  async extendGap(n = GAP_LIMIT) {
    if (!this.backend) await this.connect();
    const add = Math.max(1, Math.min(100_000, Math.trunc(Number(n) || GAP_LIMIT)));
    if (this._refreshing) {
      try { await this._refreshing; } catch { /* extend anyway */ }
    }
    const before = this.gapLimit();
    this.settings.gapExtra = Math.min(1_000_000, (Number(this.settings.gapExtra) || 0) + add);
    this.settings.gap = GAP_LIMIT + this.settings.gapExtra;
    saveSettings(this.settings);
    this.scan.note = `gap limit extended by ${add}: ${before} → ${this.gapLimit()}`;
    this.fullScanTip = null;
    this.cold = true;
    this.forceWatch = true;
    this.dispatch('scan', this.scanState());
    await this.refresh({ force: true });
    return this.gapLimit();
  }

  /** Recover HOPPER mints paid to our ordinals address from their reveal
   *  witnesses. Positive answers are cached by outpoint; the chain remains
   *  the source, and a spent reveal simply disappears from `utxos`. */
  async _localMintRecords(utxos, records) {
    if (!this.backend?.getTxHex) return [];
    const known = new Set();
    for (const record of records.values()) {
      const location = record?.location;
      if (location?.txid) known.add(`${String(location.txid).toLowerCase()}:${Number(location.vout)}`);
    }
    const ordAddress = this.keys.frogAddress();
    const ordScript = p2trScript(this.keys.ord.outputXonly);
    const candidatesForMint = utxos.filter((u) => u.kind === 'frog'
      && u.address === ordAddress
      && !known.has(`${String(u.txid).toLowerCase()}:${Number(u.vout)}`));
    const found = [];
    await mapLimit(candidatesForMint, 2, async (u) => {
      const key = `${String(u.txid).toLowerCase()}:${Number(u.vout)}`;
      const height = u.status?.block_height ?? u.status?.height ?? null;
      let record = null;
      if (this._localMintCache.has(key)) {
        // `false` means this immutable outpoint is not a mint reveal. A
        // missing entry means the network did not answer; try again.
        record = this._localMintCache.get(key) || null;
        if (!record) return;
        if (!record.mint_height && Number.isInteger(Number(height)) && Number(height) > 0) {
          record = { ...record, mint_height: Number(height) };
          this._localMintCache.set(key, record);
        }
      } else {
        let hex = null;
        try { hex = await this.backend.getTxHex(u.txid); } catch { return; }
        if (!hex) return;
        record = parseLocalMint({ hex, utxo: u, script: ordScript, mintHeight: height });
        this._localMintCache.set(key, record || false);
        if (!record) return;
      }
      if (!records.has(record.sat) && !found.some((r) => r.sat === record.sat)) found.push(record);
    });
    return found;
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
    // A source that cannot name the transaction is not proof of absence.
    if (!tx) return { owned: false, error: true };
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
    let pending = 0n;
    for (const u of this.utxos) {
      total += BigInt(u.value);
      if (u.unconfirmed) pending += BigInt(u.value);
      if (!u.exact || !u.ranges) unspendable += BigInt(u.value);
      else if (u.kind === 'p2wpkh' && !u.frogs.length) spendable += BigInt(u.value);
      else cards += BigInt(u.value);
    }
    this.balance = { total, spendable, cards, unspendable, pending };
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
      mempool: this.mempool,
      keys: this.keys,
      ord: this.ord,
      settings: this.settings,
      scan: this.scanState(),
    };
  }

  // --- events ------------------------------------------------------------

  dispatch(name, detail) {
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent(`hopper:${name}`, { detail }));
    }
  }

  // --- receive addresses -------------------------------------------------

  /** The address the BITCOIN tab shows: a fresh BIP84 address that rotates. */
  receiveAddress() {
    if (!Number.isInteger(this.receiveIndex) || this.receiveIndex < 0) this.receiveIndex = 0;
    const address = this.keys.receive(this.receiveIndex).address;
    this._noteReceiveAddress(address);
    return address;
  }

  _noteReceiveAddress(address) {
    if (!Array.isArray(this.receiveHistory)) this.receiveHistory = [];
    if (!this.receiveHistory.includes(address)) {
      this.receiveHistory.push(address);
      const max = Math.max(80, this.gapLimit() * 4);
      if (this.receiveHistory.length > max) this.receiveHistory = this.receiveHistory.slice(-max);
      this._saveLedger();
    }
  }

  /** Rotate to a previously-unused receive address (never the frogs' one).
   *  The floor only moves forward: every address we ever handed out stays
   *  covered by the scan. */
  _advanceReceiveAddress() {
    const gap = Math.max(1, this.gapLimit());
    const current = this.receiveIndex || 0;
    const history = new Set(this.receiveHistory || []);
    history.add(this.keys.receive(current).address);
    // Skip addresses this wallet already handed out OR saw funds on. The
    // latter matters after an upgrade: an old receiveIndex could point at a
    // paid address that was never rotated.
    let next = null;
    for (let step = 1; step <= gap; step += 1) {
      const candidate = (current + step) % gap;
      const address = this.keys.receive(candidate).address;
      if (!history.has(address) && !this.used?.[address]) { next = candidate; break; }
    }
    // Every address in the window is spent. Do not reuse one; continue the
    // derivation beyond the old window and let the scan follow the floor.
    if (next == null) next = current + 1;
    this.receiveIndex = next;
    this.receiveFloor = Math.max(Number(this.receiveFloor) || 0, next);
    this.forceWatch = true;
    const address = this.receiveAddress();
    this._saveLedger();
    return { address, index: next };
  }

  newReceiveAddress() {
    const { address, index } = this._advanceReceiveAddress();
    this.dispatch('receive-address', { address, index });
    return address;
  }

  /** A fresh receive address is the default after the current one is paid.
   *  This is deliberately silent: refresh() emits one receive-address event
   *  after the pass, so an open receive window can repaint without races. */
  _rotatePaidReceive() {
    const current = this.receiveIndex || 0;
    const address = this.keys.receive(current).address;
    if (!this.used?.[address]) return null;
    return this._advanceReceiveAddress();
  }

  /** Every bitcoin receive address handed out, newest first. */
  receiveAddresses() {
    const history = new Set(this.receiveHistory || []);
    // The current address is always handed out, even before it is paid.
    history.add(this.keys.receive(this.receiveIndex || 0).address);
    const rows = [];
    const limit = Math.max(
      this.gapLimit(),
      Number(this.receiveIndex) + 1 || 0,
      Number(this.receiveFloor) + 1 || 0,
      (this.receiveHistory || []).length,
    );
    for (let i = 0; i < limit; i += 1) {
      const key = this.keys.receive(i);
      if (!history.has(key.address)) continue;
      const coins = this.utxos.filter((u) => u.address === key.address);
      rows.push({
        index: i,
        address: key.address,
        current: i === (this.receiveIndex || 0),
        used: !!this.used?.[key.address],
        sats: coins.reduce((n, u) => n + Number(u.value || 0), 0),
        txs: 0,
      });
    }
    return rows.sort((a, b) => b.index - a.index);
  }

  // --- demo faucet -------------------------------------------------------

  async demoFund(coins = 8, value = 200000) {
    if (this.settings.mode !== 'demo') throw new Error('the faucet only exists in demo mode');
    const receive = this.keys.receive(this.receiveIndex || 0);
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
    this.forceWatch = true;
    this.actions.unshift({ ...action, at: new Date().toISOString(), height: this.tipHeight });
    this.actions = this.actions.slice(0, 300);
    if (action.txid) {
      const pending = (this.pending || []).filter((p) => p.txid !== action.txid);
      pending.unshift({ txid: action.txid, sinceTip: this.tipHeight, at: Date.now() });
      this.pending = pending.slice(0, 24);
    }
    this._saveLedger();
  }

  /** Every outpoint the wallet currently knows to carry a Hopper/card. */
  _protectedOutpoints() {
    const set = new Set();
    for (const f of this.frogs || []) {
      if (f?.location?.txid) set.add(`${String(f.location.txid).toLowerCase()}:${Number(f.location.vout)}`);
    }
    for (const u of this.utxos || []) {
      if (u.kind !== 'p2wpkh' || (u.frogs && u.frogs.length) || u.spendable === false) {
        set.add(`${String(u.txid).toLowerCase()}:${Number(u.vout)}`);
      }
    }
    return set;
  }

  /** All known Hopper sats. A send's inputs and the bump's fee ranges are
   *  checked against this again at bump time, so a later discovery cannot
   *  slip through metadata recorded before the frog appeared. */
  _protectedSats() {
    const set = new Set();
    for (const f of this.frogs || []) if (Number.isSafeInteger(Number(f.sat))) set.add(Number(f.sat));
    for (const sat of this.imported || []) if (Number.isSafeInteger(Number(sat))) set.add(Number(sat));
    return set;
  }

  /** Confirmed, plain BIP84 coins that may top up a replacement. The
   *  builder rechecks every one; this only narrows the list. */
  _rbfFunding() {
    return (this.utxos || []).filter((u) => {
      if (u.kind !== 'p2wpkh' || u.exact !== true || u.spendable === false) return false;
      if (u.frogs && u.frogs.length) return false;
      if (!u.keyRef) return false;
      const st = u.status || {};
      return st.confirmed === true || Number(st.height) > 0 || Number(st.block_height) > 0;
    });
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
    if (utxo.kind === 'state') throw new Error('the Hopper is already staged on The Road');
    const offset = anchorOffsetOf(utxo, frog.sat);
    if (offset != null && offset !== 0) {
      throw new Error('the Hopper sat is not first in this coin; transfer it to its own output before traveling to The Road');
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
    if (!utxo || utxo.kind !== 'state') throw new Error('TRAVEL TO ROAD before crossing');
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

  /** Build a normal send without broadcasting it. The returned object is
   *  the preview: the exact signed transaction plus its output map. */
  async previewSend(address, amountSats, { feeRate = null } = {}) {
    if (!Number.isSafeInteger(amountSats) || amountSats < 546) {
      throw new Error('amount must be a whole number of at least 546 sats');
    }
    await this.refresh();
    const recipient = decodeAddress(address, this.network);
    const rate = rateOr(feeRate ?? this.settings.feeRate);
    const change = this.keys.change(0);
    const built = buildSend({
      keys: this.keys, utxos: this._funding(), recipientScript: recipient.script,
      amount: BigInt(amountSats), feeRate: rate,
    });
    const changeOut = built.changeIndex == null ? null : built.tx.outputs[built.changeIndex];
    return {
      kind: 'send',
      built,
      to: address,
      amount: BigInt(amountSats),
      amountNumber: amountSats,
      feeRate: rate,
      fee: built.fee,
      vsize: built.vsize,
      effectiveFeeRate: Number(built.fee) / Math.max(1, built.vsize),
      destinationAmount: built.tx.outputs[0].value,
      changeAddress: changeOut ? change.address : null,
      changeAmount: changeOut ? changeOut.value : 0n,
    };
  }

  /** Build a Hopper transfer without broadcasting it. A transfer is a
   *  single output: the fee comes out of the Hopper's coin, so there is no
   *  change address to show. */
  async previewTransfer(frog, address, { feeRate = null } = {}) {
    await this.refresh();
    frog = this.frogBySat(frog.sat) || frog;
    if (frog.state === 'crossing') throw new Error('the frog is on the road; wait for settlement');
    const utxo = this._frogUtxo(frog);
    if (!utxo) throw new Error('the frog output is not in this wallet');
    const recipient = decodeAddress(address, this.network);
    const rate = rateOr(feeRate ?? this.settings.feeRate);
    const built = buildTransfer({
      keys: this.keys, utxo, frog, recipientScript: recipient.script, feeRate: rate,
    });
    return {
      kind: 'transfer',
      built,
      frogSat: Number(frog.sat),
      frogName: frog.name || '',
      to: address,
      amount: built.valueToRecipient,
      amountNumber: Number(built.valueToRecipient),
      feeRate: rate,
      fee: built.fee,
      vsize: built.vsize,
      effectiveFeeRate: Number(built.fee) / Math.max(1, built.vsize),
      destinationAmount: built.valueToRecipient,
      changeAddress: null,
      changeAmount: 0n,
    };
  }

  /** Re-read the wallet and prove that a preview's inputs are still exactly
   *  spendable. A stale preview must never be broadcast by accident. */
  async _revalidatePreview(preview) {
    await this.refresh();
    if (this._stopped) throw new Error('the wallet was locked before the transaction was approved');
    const inputs = preview?.built?.inputs;
    if (!Array.isArray(inputs) || !inputs.length) throw new Error('transaction preview has no inputs');
    for (const input of inputs) {
      const live = (this.utxos || []).find((u) => u.txid === input.txid && Number(u.vout) === Number(input.vout));
      if (!live) {
        throw new Error('preview expired: an input has already been spent; cancel and preview again');
      }
      if (Number(live.value) !== Number(input.value)) {
        throw new Error('preview expired: an input value changed; cancel and preview again');
      }
      if (live.script && input.script && !equalBytes(live.script, input.script)) {
        throw new Error('preview expired: an input script changed; cancel and preview again');
      }
      if (preview.kind === 'send'
          && (live.kind !== 'p2wpkh' || live.exact === false || live.spendable === false
            || (live.frogs && live.frogs.length))) {
        throw new Error('preview expired: a funding coin now carries a Hopper; cancel and preview again');
      }
    }
    if (preview.kind === 'transfer') {
      const frog = this.frogBySat(preview.frogSat);
      if (!frog) throw new Error('preview expired: the Hopper is no longer in this wallet');
      if (frog.state === 'crossing') throw new Error('the Hopper is on the road; wait for settlement');
      const utxo = this._frogUtxo(frog);
      if (!utxo || !inputs.some((i) => i.txid === utxo.txid && Number(i.vout) === Number(utxo.vout))) {
        throw new Error('preview expired: the Hopper output changed; cancel and preview again');
      }
    }
  }

  /** Approve a preview: revalidate state, then broadcast exactly once.
   *  There is no broadcast call anywhere in previewSend/previewTransfer. */
  async broadcastPreview(preview, { revalidate = true } = {}) {
    if (!preview?.built?.hex || !preview?.built?.tx) throw new Error('no transaction preview to broadcast');
    if (revalidate) await this._revalidatePreview(preview);
    if (preview.kind === 'send') {
      // Record the full safety envelope before broadcasting. If it cannot be
      // produced, the send still goes out but is explicitly not bumpable.
      let rbf = null;
      try {
        rbf = buildSendRbfEnvelope({
          tx: preview.built.tx,
          hex: preview.built.hex,
          fee: Number(preview.built.fee),
          inputs: preview.built.inputs,
          to: preview.to,
          amount: preview.amountNumber,
          network: this.network,
          changeIndex: preview.built.changeIndex,
          protectedSats: this._protectedSats(),
        });
      } catch (e) {
        rbf = { eligible: false, reason: e.message || String(e), policy: RBF_POLICY };
      }
      await this.backend.broadcast(preview.built.hex);
      this._recordAction({
        kind: 'send', txid: preview.built.txid, to: preview.to, amount: String(preview.amountNumber),
        fee: Number(preview.built.fee), rbf,
      });
    } else if (preview.kind === 'transfer') {
      await this.backend.broadcast(preview.built.hex);
      this._recordAction({
        kind: 'transfer', sat: preview.frogSat, txid: preview.built.txid, to: preview.to,
      });
      this.imported.delete(Number(preview.frogSat));
    } else {
      throw new Error(`unknown transaction preview kind: ${preview.kind}`);
    }
    try { await this.refresh(); } catch (e) {
      console.warn('transaction broadcast, but the refresh failed', e.message || String(e));
    }
    return preview.built;
  }

  /** Direct helpers retained for callers that do not need a UI preview. */
  async transfer(frog, address) {
    const preview = await this.previewTransfer(frog, address);
    return this.broadcastPreview(preview, { revalidate: false });
  }

  async send(address, amountSats) {
    const preview = await this.previewSend(address, amountSats);
    return this.broadcastPreview(preview, { revalidate: false });
  }

  /**
   * Replace one of our unconfirmed plain sends under BIP125.
   *
   * Safety properties, all rechecked here rather than trusted from the UI:
   *  - only a persisted plain-send action with an eligible envelope;
   *  - the original is still unconfirmed and the node returns exactly the
   *    bytes we recorded;
   *  - no original input is now a frog/card or contains a known Hopper sat;
   *  - the replacement keeps every original output byte-for-byte and adds
   *    confirmed plain funding plus one new change output;
   *  - it pays a strictly higher absolute fee and feerate, including the
   *    +1 sat/vB incremental-relay margin.
   *
   * No game transaction is ever replaceable.
   */
  async bumpFee(txid, { feeRate = null } = {}) {
    if (!txid) throw new Error('no transaction to bump');
    await this.refresh();
    const action = (this.actions || []).find((a) => a.txid === txid && a.kind === 'send');
    if (!action) throw new Error('only an unconfirmed plain send can be bumped');
    if (action.rbf?.eligible !== true) {
      throw new Error(`RBF is not available: ${action.rbf?.reason || 'this send has no safety record'}`);
    }
    if (!(this.pending || []).some((p) => p.txid === txid)) {
      throw new Error('that transaction is not pending any more');
    }
    if ((this.history || []).some((e) => e.txid === txid)) {
      throw new Error('that transaction is already confirmed');
    }
    let live;
    try { live = await this.backend.getTx(txid); } catch {
      throw new Error('the original transaction is no longer in the mempool');
    }
    if (!live) throw new Error('the original transaction is no longer in the mempool');
    const st = live.status || {};
    if (st.confirmed === true || Number(st.block_height) > 0 || Number(st.height) > 0) {
      throw new Error('that transaction is already confirmed');
    }
    if (typeof this.backend.getTxHex !== 'function') {
      throw new Error('this backend cannot prove the original bytes; refusing to bump');
    }
    let liveHex;
    try { liveHex = await this.backend.getTxHex(txid); } catch {
      throw new Error('the backend would not return the original bytes; refusing to bump');
    }
    if (!liveHex || String(liveHex).trim().toLowerCase() !== String(action.rbf.hex).toLowerCase()) {
      throw new Error('the backend bytes do not match the recorded transaction; refusing to bump');
    }

    const protectedOutpoints = this._protectedOutpoints();
    const protectedSats = this._protectedSats();
    const change = this.keys.change(0);
    const candidates = safeBumpFunding(this._rbfFunding(), {
      keys: this.keys,
      original: {
        txid,
        inputs: action.rbf.inputs.map((i) => ({ txid: i.txid, vout: i.vout })),
        outputs: action.rbf.outputs.map((o, vout) => ({ vout })),
      },
      protectedOutpoints,
      protectedSats,
    }).sort((a, b) => Number(a.snapshot.value) - Number(b.snapshot.value));

    const picked = [];
    let built = null;
    let last = null;
    for (const candidate of candidates) {
      picked.push(candidate);
      try {
        built = buildReplacement({
          action,
          keys: this.keys,
          addedInputs: picked.map((p) => ({
            txid: p.snapshot.txid,
            vout: p.snapshot.vout,
            value: p.snapshot.value,
            script: hexToBytes(p.snapshot.scriptHex),
            key: p.key,
            keyRef: p.snapshot.keyRef,
            ranges: p.snapshot.ranges,
            frogs: p.snapshot.frogs,
            kind: 'p2wpkh',
            exact: true,
            spendable: true,
            status: { confirmed: true },
          })),
          feeRate: rateOr(feeRate ?? this.settings.feeRate),
          changeScript: change.script,
          protectedOutpoints,
          protectedSats,
        });
        break;
      } catch (e) {
        if (e.code !== 'RBF_INSUFFICIENT_FUNDING') throw e;
        last = e;
      }
      if (picked.length >= 8) break;
    }
    if (!built) {
      throw new Error(last?.message || 'no confirmed plain funding coin is available for a fee bump');
    }

    await this.backend.broadcast(built.hex);
    const oldTxid = action.txid;
    action.txid = built.txid;
    action.rbf = built.rbf;
    action.fee = Number(built.fee);
    action.vsize = built.vsize;
    action.bumps = Number(action.bumps || 0) + 1;
    action.replaced = [...(action.replaced || []), oldTxid];
    action.bumpedAt = new Date().toISOString();
    this.pending = (this.pending || []).filter((p) => p.txid !== oldTxid);
    this.pending.unshift({ txid: built.txid, sinceTip: this.tipHeight, at: Date.now() });
    this.pending = this.pending.slice(0, 24);
    this.forceWatch = true;
    this._saveLedger();
    try { await this.refresh(); } catch (e) {
      console.warn('fee bump broadcast, but the refresh failed', e.message || String(e));
    }
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
