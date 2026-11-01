// Wallet session: keys, discovery, balances, and action orchestration.
//
// Public state is re-derivable: the ledger file on disk holds only what
// makes the UI fast (staged scripts, imported sats, history). A fresh device
// unlocks with the 12 words and rebuilds everything from the chain.

import {
  bytesToHex, equalBytes, hexToBytes, reverseBytes,
} from '../core/hex.js';
import {
  CARD_VALUE, GENESIS, NUMS_XONLY, WIRE_VERSION, generationAt, isGrandfatheredSat,
  paramsHashHex, requiredAt,
} from '../core/params.js';
import { taprootDescriptor } from '../core/descriptor.js';
import { decodeAddress, p2trScript, scriptToAddress } from './addresses.js';
import { deriveWallet } from './keys.js';
import {
  DemoBackend, LiveBackend, effectiveEsploraUrl, effectiveOrdUrl,
} from './backend.js';
import { parseLocalMint } from './localmint.js';
import { frogTxRole, replayFrogChain } from './chainfrog.js';
import { parseTx } from './txparse.js';
import { buildMintOffThread } from './mint-client.js';
import { KEYS, loadJson, saveJson } from './storage.js';
import {
  emptyRecoveryStore, normalizeRecoveryStore, reconcileRecoveryStore,
  recoveryPackDoc, recoverySummary,
} from './recovery.js';
import {
  anchorOffsetOf, buildCross, buildMint, buildMintRefund, buildPrepare, buildSend,
  buildTransfer, proveAssignment, stateScripts,
} from './actions.js';
import {
  RBF_POLICY, buildReplacement, buildSendRbfEnvelope, safeBumpFunding,
} from './rbf.js';

// The watch set is fixed. BIP84 receive and change both live at index 0;
// the ordinals key lives at /2/0; every staged Hopper adds one derived state
// script. There is no HD gap to walk and no address rotation. A public
// source gets one tip probe every ten minutes while idle, and a 30 s cadence
// only while something of ours is in flight.
export const PUBLIC_IDLE_TICK_MS = 10 * 60 * 1000;
export const PUBLIC_BUSY_TICK_MS = 30 * 1000;
export const LOCAL_TICK_MS = 3000;

/** A local node recovers quickly: 5, 10, 20, 40, 80, 160, 300 s.
 *  A public source is being rate-limited when it fails, so start at a
 *  minute and climb to half an hour: 1, 2, 5, 10, 20, 30 min. */
export function failureBackoffMs(fails, { publicSource = false } = {}) {
  const n = Math.max(1, Math.min(7, Math.trunc(Number(fails) || 1)));
  if (publicSource) {
    const ladder = [60_000, 120_000, 300_000, 600_000, 1_200_000, 1_800_000];
    return ladder[Math.min(n, ladder.length) - 1];
  }
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

function sameRanges(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((r, i) => Array.isArray(r) && Array.isArray(b[i])
    && Number(r[0]) === Number(b[i][0]) && Number(r[1]) === Number(b[i][1]));
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
  scanPaused: false,
  spendUnconfirmed: true,
  addressBook: [],
};

export function loadSettings() {
  const saved = loadJson(KEYS.settings, {}) || {};
  const s = { ...DEFAULT_SETTINGS, ...saved };
  delete s.gap;
  delete s.gapExtra;
  // Settings are user-editable and survive upgrades. Normalize the values
  // that flow into fee math or the scan loop so a corrupt/empty field can
  // never become NaN.
  s.mode = s.mode === 'live' ? 'live' : 'demo';
  s.ordUrl = String(s.ordUrl || '').trim();
  s.feeRate = rateOr(s.feeRate);
  const volume = Number(s.volume);
  s.volume = Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 0.55;
  s.mute = s.mute === true;
  s.deepScan = s.deepScan === true;
  s.scanPaused = s.scanPaused === true;
  // Default-on for new and upgraded wallets. Only an explicit off value
  // disables the mempool spend path.
  s.spendUnconfirmed = s.spendUnconfirmed !== false && s.spendUnconfirmed !== '0';
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
    this.receives = [];
    this.receivesVersion = 0;
    this._receiveBackfillFailedAt = 0;
    this.changes = [];
    this.changesVersion = 0;
    this._changeBackfillFailedAt = 0;
    this.chainMints = [];
    this.mempool = [];
    this.pending = [];
    // F-04: a mint commit is a funded on-chain output. Persist the signed
    // reveal and the recovery material before the commit is broadcast.
    this.pendingMints = [];
    this.imported = new Set();
    // State outputs sit at scripts that are not on an HD index. Once a local
    // mint reveals one, remember its address/script/outpoint so the warm
    // watch plan can keep it without an indexer.
    this.staged = {};
    this.tipHeight = null;
    this.tipHash = null;
    this.balance = { total: 0n, spendable: 0n, cards: 0n, unspendable: 0n, pending: 0n };
    // Scan state, persisted where it matters and rebuilt by the next cold
    // pass where it does not. `fullScanTip` is the tip gate.
    this.fullScanTip = null;
    this.watchTip = null;
    this._scanTipHash = null;
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
    this._scanAbort = false;
    this._stopped = false;
    this._blockUnsub = null;
    this._visHandler = null;
    this._txCache = new Map();
    this._localMintCache = new Map();
    // Chain-derived frog history is bounded to the state address, but the
    // same transaction/header can be needed by several frogs. Keep the
    // parsed peer answers for the session; never persist private material.
    this._chainHexCache = new Map();
    this._chainHashCache = new Map();
    this._chainReconTip = null;
    this._loadLedger();
    this._loadRecovery();
  }

  // --- persistence -------------------------------------------------------

  _ledgerKey() { return KEYS.ledger(this.fingerprint); }

  _loadLedger() {
    const l = loadJson(this._ledgerKey(), null);
    if (!l) return;
    this.actions = l.actions || [];
    this.receives = Array.isArray(l.receives)
      ? l.receives.filter((r) => r && r.txid && Number(r.amount) >= 0) : [];
    this.receivesVersion = Number(l.receivesVersion) || 0;
    this.changes = Array.isArray(l.changes)
      ? l.changes.filter((r) => r && r.txid && Number(r.amount) >= 0) : [];
    this.changesVersion = Number(l.changesVersion) || 0;
    this.chainMints = Array.isArray(l.chainMints)
      ? l.chainMints.filter((m) => m && /^[0-9a-f]{64}$/i.test(String(m.txid)))
      : [];
    this.pending = Array.isArray(l.pending) ? l.pending.filter((p) => p && p.txid) : [];
    this.pendingMints = Array.isArray(l.pendingMints)
      ? l.pendingMints.filter((p) => p && p.commitTxid && p.revealHex) : [];
    this.history = l.history || [];
    this.mempool = Array.isArray(l.mempool)
      ? l.mempool.filter((m) => m && m.txid && Number.isSafeInteger(m.amount) && m.amount > 0)
        .slice(-50)
      : [];
    this.imported = new Set(l.imported || []);
    this.staged = l.staged && typeof l.staged === 'object' && !Array.isArray(l.staged)
      ? Object.fromEntries(Object.entries(l.staged).filter(([sat, row]) =>
        Number.isSafeInteger(Number(sat)) && row && typeof row.address === 'string'
          && typeof row.script === 'string'))
      : {};
    this.fullScanTip = Number.isSafeInteger(l.fullScanTip) ? l.fullScanTip : null;
    this._scanTipHash = /^[0-9a-f]{64}$/i.test(String(l.tipHash || ''))
      ? String(l.tipHash).toLowerCase() : null;
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
      receives: this.receives.slice(-300),
      receivesVersion: this.receivesVersion || 0,
      changes: this.changes.slice(-300),
      changesVersion: this.changesVersion || 0,
      chainMints: this.chainMints.slice(-300),
      pending: this.pending.slice(-24),
      pendingMints: this.pendingMints.slice(-12),
      history: this.history.slice(-200),
      mempool: this.mempool.slice(-50),
      imported: [...this.imported],
      staged: this.staged || {},
      fullScanTip: this.fullScanTip,
      balance: {
        total: String(this.balance.total), spendable: String(this.balance.spendable),
        cards: String(this.balance.cards), unspendable: String(this.balance.unspendable),
        pending: String(this.balance.pending || 0n),
      },
      lastRefresh: new Date().toISOString(),
      tipHeight: this.tipHeight,
      tipHash: this.tipHash || null,
    });
  }

  // --- automatic recovery packs -----------------------------------------

  _recoveryKey() { return KEYS.recovery(this.fingerprint); }

  _loadRecovery() {
    const raw = loadJson(this._recoveryKey(), null);
    this.recovery = normalizeRecoveryStore(raw, {
      fingerprint: this.fingerprint, network: this.network,
    });
  }

  _saveRecovery() {
    try {
      saveJson(this._recoveryKey(), this.recovery);
    } catch { /* storage may be unavailable; the live export still works */ }
  }

  recoveryPacks() {
    return Object.values(this.recovery?.packs || {})
      .sort((a, b) => (Number(b.last_seen_tip) || 0) - (Number(a.last_seen_tip) || 0)
        || Number(a.sat) - Number(b.sat));
  }

  recoverySummary() { return recoverySummary(this.recovery); }

  recoveryPackDoc({ now = new Date().toISOString() } = {}) {
    return recoveryPackDoc(this.recovery, { now });
  }

  /** Fold a fresh layout document into the persisted store. */
  _reconcileRecoveryPacks({ tipHeight = this.tipHeight, now = new Date().toISOString() } = {}) {
    if (!this.recovery) this.recovery = emptyRecoveryStore({
      fingerprint: this.fingerprint, network: this.network,
    });
    let doc;
    try { doc = this.emergencyDescriptors({ now }); } catch { return null; }
    const result = reconcileRecoveryStore(this.recovery, doc, { tipHeight, now });
    if (result.changed) {
      this.recovery = result.store;
      this._saveRecovery();
    } else {
      this.recovery = result.store;
    }
    return result;
  }

  /** Record a staged state output from a transaction we just broadcast.
   *  This makes PREPARE and HOP packs available before the indexer has
   *  confirmed the frog's new location. */
  _rememberRecovery(frog, { txid, vout = 0, value = CARD_VALUE, tipHeight = this.tipHeight } = {}) {
    if (!frog || !txid) return null;
    if (!this.recovery) this.recovery = emptyRecoveryStore({
      fingerprint: this.fingerprint, network: this.network,
    });
    const entry = this._emergencyEntry(frog, { txid, vout, value });
    if (!entry) return null;
    const now = new Date().toISOString();
    const doc = {
      type: 'hopper-v8-emergency',
      version: 1,
      network: this.network,
      fingerprint: this._emergencyFingerprint(),
      owner_path: this.keys.ordPath,
      generated_at: now,
      tip_height: Number(tipHeight) || 0,
      frogs: [entry],
    };
    const result = reconcileRecoveryStore(this.recovery, doc, {
      tipHeight: Number(tipHeight) || 0, now, local: true,
    });
    this.recovery = result.store;
    if (result.changed) this._saveRecovery();
    return result.store.packs[String(entry.sat)] || null;
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
        esploraMetered: isPublicEndpoint(esploraUrl),
      });
    }
    const effective = {
      ...this.settings,
      esploraUrl: effectiveEsploraUrl(this.settings, this.network),
      ordUrl: effectiveOrdUrl(this.settings, this.network),
    };
    this.publicSource = settingsPublicSource(effective);
    // The protocol-params gate belongs at signing time (previewMint /
    // previewCross), not on unlock. A slow or unreachable indexer must not
    // delay a vault from opening; the signing paths still refuse a
    // different params_hash before they build bytes.
    this._setupAutoSync();
    return this;
  }

  /** SPEC §1.3: refuse to mint or hop when the indexer publishes a
   *  different params_hash. A missing/unreachable indexer makes no claim
   *  and is not a mismatch; an answer with the wrong hash is fatal. */
  async _assertParams() {
    if (this.settings.mode === 'demo' || !this.settings.indexerUrl) return;
    if (!this.backend || typeof this.backend.params !== 'function') return;
    let published;
    try {
      published = await this.backend.params();
    } catch (e) {
      // F-13: a configured indexer that does not answer is not permission
      // to skip the identity gate.
      throw new Error(`the configured indexer did not answer its params gate: ${e.message || e}`);
    }
    if (!published || !published.params_hash) {
      throw new Error('the configured indexer published no params_hash; refusing to sign');
    }
    if (published.wire_version != null && Number(published.wire_version) !== WIRE_VERSION) {
      throw new Error(`the indexer speaks wire ${published.wire_version}; this wallet speaks ${WIRE_VERSION}`);
    }
    if (String(published.params_hash).toLowerCase() !== paramsHashHex()) {
      const err = new Error(
        `the indexer publishes different protocol parameters (wire v${published.wire_version}); this wallet refuses to sign`,
      );
      err.paramsMismatch = true;
      throw err;
    }
    if (published.network) {
      const map = { main: 'mainnet', test: 'testnet', testnet3: 'testnet' };
      const net = map[String(published.network)] || String(published.network);
      if (net !== String(this.network)) {
        throw new Error(`the indexer network is ${published.network}; this wallet is ${this.network}`);
      }
    }
  }

  /** A different chain/indexer must not inherit scan pointers from the
   *  previous backend. A demo tip (H 973,263) is not a live tip. The next
   *  refresh is forced, so the caller immediately pays for the cold pass. */
  resetScan(note = 'backend changed — a cold scan will start') {
    this.fullScanTip = null;
    this.watchTip = null;
    this._scanTipHash = null;
    this.cold = true;
    this.forceWatch = true;
    this.scan.note = note;
    this.scan.partial = false;
    this.scan.lastPass = null;
    this.scan.lastTip = null;
    this.scan.nextAt = null;
    this._saveLedger();
  }

  _teardownAutoSync() {
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

  /** Stop background work (lock/wipe/backend change). Network requests
   *  already in flight are left to finish; nothing is rescheduled. */
  stop() {
    this._autoSync = false;
    this._stopped = true;
    this._teardownAutoSync();
  }

  /** User-visible pause. Unlike lock/wipe this leaves the session usable:
   *  no timer, no block/visibility wake, no automatic retries. An explicit
   *  REFRESH or RESCAN still works, and clears the in-pass stop flag. */
  pauseScan({ save = true } = {}) {
    this.settings.scanPaused = true;
    if (save) saveSettings(this.settings);
    this._scanAbort = true;
    this._autoSync = false;
    this._teardownAutoSync();
    this.scan.note = 'scanning paused — automatic passes are off';
    this.dispatch('scan', this.scanState());
    return this.scanState();
  }

  /** Re-arm the timer and subscriptions after a pause. */
  resumeScan({ save = true } = {}) {
    this.settings.scanPaused = false;
    if (save) saveSettings(this.settings);
    this._scanAbort = false;
    if (this._stopped) {
      this._autoSync = false;
      this.dispatch('scan', this.scanState());
      return this.scanState();
    }
    this._setupAutoSync();
    this.scan.note = 'scanning resumed — automatic passes are back on';
    this.dispatch('scan', this.scanState());
    if (this._autoSync) this._scheduleNext(250);
    return this.scanState();
  }

  _setupAutoSync() {
    if (this._stopped || this.settings.scanPaused === true) {
      this._autoSync = false;
      this.scan.nextAt = null;
      return;
    }
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
    if (this.fails > 0) {
      return failureBackoffMs(this.fails, { publicSource: this.publicSource });
    }
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
    if (!this._autoSync || this._stopped || this.settings.scanPaused === true) return;
    if (this._timer) clearTimeout(this._timer);
    this.scan.nextAt = Date.now() + ms;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._tick();
    }, Math.max(0, ms));
    if (this._timer?.unref) this._timer.unref();
  }

  _tick() {
    if (!this._autoSync || this._stopped || this.settings.scanPaused === true) return;
    if (typeof document !== 'undefined' && document.hidden) {
      this._scheduleNext();
      return;
    }
    this.refresh({ force: false, auto: true }).catch((e) => {
      console.warn('background sync failed', e.message || String(e));
    });
  }

  _wake() {
    if (!this._autoSync || this._stopped || this.settings.scanPaused === true) return;
    this._wakeQueued = true;
    if (this._refreshing) return;
    this._wakeQueued = false;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._scheduleNext(250);
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
      watch: {
        ord: true, receive: 0, change: 0,
        staged: Object.keys(this.staged || {}).length,
      },
      auto: this._autoSync,
      paused: this.settings.scanPaused === true,
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

  /** Only three HD scripts exist in the watch set. The ordinals address
   *  covers mints and frogs; receive(0) and change(0) cover ordinary coins.
   *  Staged state scripts are added separately because they do not live on
   *  an HD path. */
  _entry(branch) {
    if (branch === 'ord') {
      return {
        branch: 'ord', index: 0, key: this.keys.ord,
        address: this.keys.frogAddress(),
        script: p2trScript(this.keys.ord.outputXonly), kind: 'frog',
      };
    }
    if (branch === 'ordLegacy') {
      return {
        branch: 'ordLegacy', index: 0, key: this.keys.legacyOrd,
        address: this.keys.legacyFrogAddress(),
        script: p2trScript(this.keys.legacyOrd.outputXonly), kind: 'frog', legacyPath: true,
      };
    }
    const b = Number(branch);
    if (b !== 0 && b !== 1) return null;
    const key = b === 0 ? this.keys.receive(0) : this.keys.change(0);
    return { branch: b, index: 0, key, address: key.address, script: key.script, kind: 'p2wpkh' };
  }

  async _getTx(txid) {
    if (this._txCache.has(txid)) return this._txCache.get(txid);
    const tx = await this.backend.getTx(txid).catch(() => null);
    if (tx) this._txCache.set(txid, tx);
    return tx;
  }

  /** A user-facing refresh is forced; the scheduler calls with force:false
   *  and auto:true so an unchanged tip can pass without a single address
   *  query. A manual refresh is also the escape hatch while paused. */
  async refresh({ deep = null, force = true, auto = false } = {}) {
    if (!auto) this._scanAbort = false;
    if (auto && this.settings.scanPaused === true) {
      this.scan.note = 'scanning paused — automatic passes are off';
      return this;
    }
    if (!this.backend) await this.connect();
    if (this._refreshing) {
      if (force) this.forceWatch = true;
      return this._refreshing;
    }
    const wantedForce = force || this.forceWatch;
    this.scan.busy = true;
    this.dispatch('scan', this.scanState());
    const job = this._refreshInner({ deep, force: wantedForce, auto });
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
    this.scan.note = this.settings.scanPaused === true
      ? `scanning paused — last pass failed: ${why}`
      : `sync failed: ${why} (retry in ${Math.round(this.tickIntervalMs() / 1000)}s)`;
    if (this.scan.rescan) {
      this.scan.rescan = null;
      this.scan.note = `rescan failed: ${why}`;
    }
    this._saveLedger();
  }

  async _refreshInner({ deep: deepOpt = null, force: forceOpt = false, auto = false } = {}) {
    let tip;
    let tipNote = null;
    let tipFailed = false;
    try {
      tip = Number(await this.backend.tipHeight());
      if (!Number.isFinite(tip)) throw new Error('chain returned no tip height');
    } catch (e) {
      // A background pass stops at the first failed request. Continuing to
      // address lookups while the backend is rate-limiting or down is what
      // turns a short outage into a long ban. A manual/action refresh may
      // reuse the last height so the user can still see its balance.
      const last = [this.watchTip, this.fullScanTip, this.tipHeight]
        .find((h) => Number.isSafeInteger(h));
      if (last == null || auto) throw e;
      tip = last;
      tipFailed = true;
      tipNote = `tip height unavailable (${e.message || String(e)}) — using ${last}`;
    }
    this.tipHeight = tip;
    // F-12: a height is not a chain identity. A same-height reorg must not
    // reuse the old outcome hashes or the old scan gate.
    try {
      const h = await this.backend.tipHash();
      if (typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h)) this.tipHash = h.toLowerCase();
    } catch { /* keep the old tip hash; the gate below forces a pass */ }
    await this._reconcilePending(tip);
    if (this._scanAbort) {
      this.scan.note = 'scanning paused — automatic passes are off';
      return this;
    }

    let force = !!forceOpt || this.forceWatch;
    this.forceWatch = false;

    // THE GATE. A settled answer can change only with a block. While
    // nothing of ours is in flight, an unchanged tip costs one request.
    if (!force && !this.scan.rescan && this.fullScanTip != null
        && this.watchTip === tip
        && (this.tipHash == null || this._scanTipHash === this.tipHash)
        && !this._inFlight()) {
      this.scan.lastPass = Date.now();
      this.scan.lastTip = tip;
      this._scanTipHash = this.tipHash;
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
    const notes = [];
    if (tipNote) notes.push(tipNote);
    const rescanning = !!this.scan.rescan;
    let pausedMidPass = false;
    let asked = 0;
    let hits = 0;

    // 1. WATCH SET. Three fixed HD scripts, plus one derived state script
    //    for every staged Hopper. Cold and warm passes ask the same set;
    //    only the history backfills run on a cold pass.
    const entries = [];
    const seenAddresses = new Set();
    const addEntry = (entry) => {
      if (!entry?.address || seenAddresses.has(entry.address)) return;
      seenAddresses.add(entry.address);
      entries.push(entry);
    };
    // The ordinals address comes first so a partial failure later in the
    // set cannot hide a mint. Known state scripts follow, then the fixed
    // receive/change scripts.
    addEntry(this._entry('ord'));
    // F-03: a released wallet may have minted at the unnormalized (odd-Y)
    // BIP86 address. Walk it on recovery/forced passes and whenever a
    // legacy frog is already known; warm passes keep the normal watch set.
    if (this.cold || force || rescanning
        || (this.frogs || []).some((f) => f.legacy_path === true)) {
      addEntry(this._entry('ordLegacy'));
    }
    for (const row of Object.values(this.staged || {})) {
      const sat = Number(row?.sat);
      if (!Number.isSafeInteger(sat) || !row?.address || !row?.script) continue;
      try {
        addEntry({
          branch: 'state', index: sat, key: this.keys.ord,
          address: row.address, script: hexToBytes(row.script), kind: 'state', sat,
        });
      } catch { /* a corrupt ledger row is not a reason to stop scanning */ }
    }
    for (const branch of [0, 1]) {
      const entry = this._entry(branch);
      if (entry) addEntry(entry);
    }

    const utxos = [];
    const mempoolByTx = new Map();
    const queriedOk = new Set();
    let watchFailed = null;
    let stagedChanged = false;
    const prevByAddress = new Map();
    for (const u of previousUtxos) {
      if (!u.address) continue;
      if (!prevByAddress.has(u.address)) prevByAddress.set(u.address, []);
      prevByAddress.get(u.address).push(u);
    }

    // Sequential on purpose: even the fixed set is a handful of requests,
    // and a public source must not see them as a burst.
    for (const w of entries) {
      if (this._scanAbort) { pausedMidPass = true; break; }
      asked += 1;
      let list;
      try {
        list = await this.backend.addressUtxos(w.address, w.script);
        if (!Array.isArray(list)) list = [];
        queriedOk.add(w.address);
      } catch (e) {
        // One failed address is enough: stop the pass rather than fire the
        // rest of the plan into a backend that is rate-limiting us.
        watchFailed = e.message || String(e);
        list = prevByAddress.get(w.address) || [];
        for (const u of list) utxos.push(u);
        break;
      }
      const isState = w.kind === 'state';
      // F-07/F-13: a state script does not prove which sats it holds. Ask
      // the same range source as any other coin and require value agreement.
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
        // The backend's `ranges` are inclusive in this app; DemoBackend and
        // the indexer DTO already use inclusive ends.
        // Prefer the range oracle. A chain adapter may already carry
        // inclusive ranges on the UTXO row (DemoBackend does); use that
        // only when it is complete and value-matched.
        const ranges = dto && Array.isArray(dto.ranges)
          ? dto.ranges.map(([a, b]) => [Number(a), Number(b) - 1])
          : (Array.isArray(u.ranges) && u.ranges.length
            ? u.ranges.map(([a, b]) => [Number(a), Number(b)]) : null);
        const valueOk = dto ? Number(dto.value) === Number(u.value) : true;
        const sumOk = ranges ? ranges.reduce((n, [a, b]) => n + (b - a + 1), 0) === Number(u.value) : false;
        const baseExact = (dto ? dto.exact !== false : true) && valueOk && sumOk;
        const frogSat = isState ? Number(w.sat) : null;
        const holdsFrog = isState && baseExact
          && ranges.some(([a, b]) => frogSat >= a && frogSat <= b);
        const exact = isState ? holdsFrog : baseExact;
        const frogs = isState
          ? (holdsFrog ? [frogSat] : [])
          : dto ? (dto.frogs || []) : (u.frogs || []);
        const kind = isState ? 'state' : w.kind === 'frog' ? 'frog' : 'p2wpkh';
        const key = w.kind === 'frog' || isState
          ? (w.branch === 'ordLegacy' ? this.keys.legacyOrd : this.keys.ord) : w.key;
        utxos.push({
          txid: u.txid, vout: u.vout, value: Number(u.value), script: u.script,
          address: w.address, kind, ranges: exact ? ranges : null, exact, frogs,
          status: u.status || null, unconfirmed: isUnconfirmedUtxo(u),
          key, keyRef: { branch: w.branch, index: w.index },
          spendable: kind !== 'state' && exact && !frogs.length,
        });
      });
      if (isState && list.length && this.staged[String(w.sat)]) {
        const prior = this.staged[String(w.sat)];
        const first = list[0];
        if (String(prior.txid || '').toLowerCase() !== String(first.txid).toLowerCase()
            || Number(prior.vout) !== Number(first.vout)) {
          prior.txid = String(first.txid).toLowerCase();
          prior.vout = Number(first.vout);
          stagedChanged = true;
        }
      }
      if (list.length) hits += 1;
    }

    // A pass that could not name every address keeps the coins it already
    // knew: absence is not evidence.
    const preserve = !!(watchFailed || pausedMidPass);
    if (preserve) {
      const queried = new Set(entries.map((w) => w.address));
      for (const u of previousUtxos) {
        if (!u.address || !queried.has(u.address)) {
          if (!utxos.some((x) => x.txid === u.txid && x.vout === u.vout)) utxos.push(u);
        }
      }
      for (const row of previousMempool) {
        if (!row?.txid || queriedOk.has(row.address)) continue;
        if (!mempoolByTx.has(row.txid)) mempoolByTx.set(row.txid, { ...row });
      }
    }
    if (stagedChanged) this._saveLedger();
    this.mempool = [...mempoolByTx.values()].sort((a, b) => b.amount - a.amount);
    if (watchFailed) notes.push(`address scan stopped: ${watchFailed}`);
    if (pausedMidPass) notes.push('scanning paused — this pass stopped early');
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
        // F-10: walk every page, not just the first 300 frogs.
        let offset = 0;
        let total = Infinity;
        for (let page = 0; page < 200; page += 1) {
          const answer = await this.backend.froggers({ limit: 300, offset });
          const items = answer.items || [];
          for (const f of items) {
            if (!f || f.sat == null) continue;
            const sat = Number(f.sat);
            if (!Number.isSafeInteger(sat)) continue;
            candidates.add(sat);
            records.set(sat, f);
          }
          total = Number.isFinite(Number(answer.total)) ? Number(answer.total) : total;
          offset += items.length;
          if (!items.length || offset >= total) break;
        }
      } catch { /* live indexer may be absent */ }
    }

    // A mint reveals its own inscription in the taproot witness. Recover
    // that record even when no HOPPER indexer is configured (the public
    // defaults have none) and ord's range endpoint is unavailable. If the
    // reveal has already been spent into its state output, the ord address
    // history still names it on a cold/forced pass.
    const localMints = await this._localMintRecords(utxos, records, {
      history: this.cold || (force && this.chainMints.length === 0),
    });
    for (const record of localMints) {
      if (records.has(record.sat)) continue;
      records.set(record.sat, record);
      candidates.add(record.sat);
    }
    // Fill in mints whose reveal is already spent. The parse above wins for
    // a reveal still in `utxos`; these rows only add missing sats.
    this._seedChainMints(records, candidates, previousFrogs, utxos);
    if (localMints.length) {
      notes.push(`${localMints.length} Hopper mint${localMints.length === 1 ? '' : 's'} recognized from the ord address`);
    }

    // A local/chain mint names sat + mint outpoint. Derive its state script
    // and ask the chain for that output; this is the only way a restored
    // wallet finds a staging address without an indexer or ord server.
    if (this.cold || force || rescanning) await this._discoverStaged(records, utxos);
    // A local HOP stays in the action ledger while it is in flight. Replay
    // once per new tip until it settles, so the confirmed dist/death appears
    // without making the user press REFRESH. Old crossings and unchanged tips
    // do not pay for another address-history walk.
    const recentCross = (this.actions || []).some((a) => {
      if (String(a?.kind || '').toLowerCase() !== 'cross') return false;
      const h = Number(a.height);
      return Number.isInteger(h) && h > 0 && tip - h <= 144;
    }) || (this.frogs || []).some((f) =>
      f?.local === true && (String(f.state || '') === 'crossing' || f.in_flight));
    const replayNow = this.cold || force || rescanning
      || (this.tipHash !== this._chainReconTip && recentCross);
    if (replayNow) {
      if (await this._reconstructChainFrogs(records, utxos, { tip })) {
        notes.push('Hopper road history rebuilt from the chain');
      }
      this._chainReconTip = this.tipHash;
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
      // The record's location is the outpoint that currently carries the
      // sat, not necessarily the mint reveal. A restored local record starts
      // at the reveal and must move to the discovered state outpoint.
      if (owned.utxo) {
        record.location = { txid: owned.utxo.txid, vout: Number(owned.utxo.vout) };
        if (owned.custody) {
          owned.utxo.kind = 'state';
          owned.utxo.key = this.keys.ord;
          owned.utxo.spendable = false;
        }
        if (!utxos.some((u) => u.txid === owned.utxo.txid && u.vout === owned.utxo.vout)) {
          utxos.push(owned.utxo);
        }
      }
      frogs.push(record);
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
    // Keep the automatic layout packs beside the live state. The snapshot
    // only replaces a pack when the state outpoint or tree actually moves;
    // a partial scan never deletes a copy.
    this._reconcileRecoveryPacks({ tipHeight: tip });
    this._recordObservedReceives(this.utxos);
    this._recordObservedChanges(this.utxos);
    this._recordChainMints();
    await this._repairMintCommits();
    this._tagChanges();
    const recovered = await this._backfillReceives();
    if (recovered) {
      notes.push(`${recovered} earlier receive${recovered === 1 ? '' : 's'} recovered from address history`);
    }
    const changeRecovered = await this._backfillChanges();
    this._tagChanges();
    if (changeRecovered) {
      notes.push(`${changeRecovered} earlier change output${changeRecovered === 1 ? '' : 's'} recovered from address history`);
    }

    const priorTotal = this.balance.total;
    this._computeBalance();
    if (preserve && this.balance.total < priorTotal) this.balance = previousBalance;

    try {
      const ev = await this.backend.events(200);
      // The indexer event feed is global. History is about this wallet, so
      // keep only events for Hoppers we own, imported, received, or have an
      // action for. Otherwise every NPC mint on the demo chain appears as if
      // this wallet made it.
      const walletSats = new Set();
      for (const f of this.frogs) walletSats.add(Number(f.sat));
      for (const sat of this.imported) walletSats.add(Number(sat));
      for (const a of this.actions) if (a?.sat != null) walletSats.add(Number(a.sat));
      for (const r of this.receives) if (r?.frog && r?.sat != null) walletSats.add(Number(r.sat));
      this.history = (ev.events || [])
        .filter((e) => {
          const sat = Number(e.action?.frogger_sat ?? e.action?.sat);
          return Number.isSafeInteger(sat) && walletSats.has(sat);
        })
        .map((e) => ({
          height: e.height, txid: e.txid, blockHash: e.block_hash,
          kind: e.action.kind || e.action.action, payload: e.action,
        }));
    } catch { /* history is optional */ }

    // 3. Scan bookkeeping and the tip gate.
    if (rescanning) {
      notes.unshift(watchFailed
        ? `rescan stopped: ${watchFailed}`
        : `rescan complete: ${asked} fixed script${asked === 1 ? '' : 's'} checked${hits ? `, ${hits} with coins` : ''}`);
      this.scan.rescan = null;
    }
    if (watchFailed || tipFailed) {
      this.fails += 1;
      this.watchTip = null;
    } else if (!pausedMidPass) {
      this.fails = 0;
      this.watchTip = tip;
      this._scanTipHash = this.tipHash;
    }
    if (this.cold && !watchFailed && !pausedMidPass) {
      this.fullScanTip = tip;
      this.cold = false;
    }
    this.scan.lastPass = Date.now();
    this.scan.lastTip = tip;
    this.scan.partial = !!(watchFailed || pausedMidPass || recordFailed || ownershipFailed);
    if (this._stopped) return this;
    if (!notes.length) notes.push(`synced at block ${tip}`);
    this.scan.note = this.settings.scanPaused === true
      ? `scanning paused — automatic passes are off · ${notes.join(' · ')}`
      : notes.join(' · ');
    this._saveLedger();
    this.dispatch('refresh', this.summary());
    return this;
  }

  // --- manual rescan ------------------------------------------------------

  async startRescan() {
    if (!this.backend) await this.connect();
    if (this.scan.rescan) return false;
    if (this._refreshing) {
      try { await this._refreshing; } catch { /* the rescan can still start */ }
    }
    if (this.scan.rescan) return false;
    // A rescan is the user's escape hatch if an older ledger has deposits
    // or change missing from History. It re-asks the fixed scripts and
    // resets both one-time history backfills.
    this.receivesVersion = 0;
    this._receiveBackfillFailedAt = 0;
    this.changesVersion = 0;
    this._changeBackfillFailedAt = 0;
    this.scan.rescan = { asked: 0, hits: 0 };
    this.scan.note = 'rescanning the fixed watch set';
    this.fullScanTip = null;
    this.cold = true;
    this.forceWatch = true;
    this.dispatch('scan', this.scanState());
    await this.refresh({ force: true });
    return true;
  }

  /** The state script for one local mint. State outputs sit at scripts that
   *  are not on an HD path; this is only reachable with the public mint data
   *  (sat + mint outpoint + owner key). */
  _stagedEntry(record) {
    try {
      const state = this._frogState(record);
      return {
        sat: Number(record.sat),
        address: scriptToAddress(state.script, this.network),
        script: bytesToHex(state.script),
      };
    } catch { return null; }
  }

  /** A local mint can already have been spent into its state output before
   *  this browser saw it. The state address is derivable, so ask the chain
   *  for it and remember the address for warm passes. No indexer or ord
   *  server is involved. */
  async _discoverStaged(records, utxos) {
    if (typeof this.backend?.addressUtxos !== 'function') return;
    const local = [...records.values()].filter((r) =>
      r?.local === true && Number.isSafeInteger(Number(r.sat)) && Number(r.sat) > 0
      && r.sat_verified !== false);
    let changed = false;
    await mapLimit(local, 2, async (record) => {
      const location = record.location;
      const direct = location && utxos.find((u) =>
        String(u.txid).toLowerCase() === String(location.txid).toLowerCase()
        && Number(u.vout) === Number(location.vout));
      if (direct) return;
      const entry = this._stagedEntry(record);
      if (!entry) return;
      let found;
      try { found = await this.backend.addressUtxos(entry.address, hexToBytes(entry.script)); } catch { return; }
      if (!Array.isArray(found) || !found.length) return;
      // F-07: a third-party payment to the same public state script is not
      // this Hopper. Select only an output whose complete ranges contain
      // the frog sat; otherwise leave the staged record alone.
      let match = null;
      let matchDto = null;
      for (const candidate of found) {
        let dto = null;
        try { dto = await this.backend.utxo(candidate.txid, candidate.vout); } catch { dto = null; }
        const rr = dto && Array.isArray(dto.ranges)
          ? dto.ranges.map(([a, b]) => [Number(a), Number(b) - 1]) : null;
        if (!rr || !rr.length || Number(dto.value) !== Number(candidate.value)) continue;
        const frogSat = Number(entry.sat);
        if (!rr.some(([a, b]) => frogSat >= a && frogSat <= b)) continue;
        match = candidate;
        matchDto = { ...dto, ranges: rr };
        break;
      }
      if (!match) return;
      const prior = this.staged[String(entry.sat)] || {};
      const next = {
        ...prior, ...entry,
        txid: String(match.txid).toLowerCase(), vout: Number(match.vout),
      };
      if (prior.address !== next.address || prior.script !== next.script
          || prior.txid !== next.txid || Number(prior.vout) !== Number(next.vout)) {
        this.staged[String(entry.sat)] = next;
        changed = true;
      }
      for (const u of found) {
        if (utxos.some((x) => String(x.txid).toLowerCase() === String(u.txid).toLowerCase()
          && Number(x.vout) === Number(u.vout))) continue;
        // F-07: the state script alone only proves where the coin lives,
        // not which sats it holds. Never invent `[[sat,sat]]`; ask the
        // chain/indexer for complete ranges and fail closed if absent.
        let dto = null;
        if (match && String(u.txid).toLowerCase() === String(match.txid).toLowerCase()
            && Number(u.vout) === Number(match.vout)) dto = matchDto;
        else {
          try { dto = await this.backend.utxo(u.txid, u.vout); } catch { dto = null; }
        }
        const ranges = dto && Array.isArray(dto.ranges)
          ? dto.ranges.map(([a, b]) => [Number(a), Number(b) - 1]) : null;
        const exact = !!(ranges && ranges.length && Number(dto.value) === Number(u.value));
        const frogSat = Number(entry.sat);
        const holdsFrog = exact && ranges.some(([a, b]) => frogSat >= a && frogSat <= b);
        utxos.push({
          ...u, kind: 'state', address: entry.address,
          ranges: holdsFrog ? ranges : null,
          exact: holdsFrog,
          frogs: holdsFrog ? [frogSat] : [],
          key: this.keys.ord, keyRef: { branch: 'ord', index: 0 },
          spendable: false, unconfirmed: isUnconfirmedUtxo(u),
        });
      }
    });
    if (changed) this._saveLedger();
  }

  /** Merge chain-derived road actions into the local ledger. Actions from
   *  this browser keep their fee/at fields; only the confirmed height and
   *  direction are filled in. Synthetic actions are tagged so a reorg can
   *  replace them on the next replay instead of accumulating ghosts. */
  _upsertChainActions(sat, actions) {
    const n = Number(sat);
    if (!Number.isSafeInteger(n)) return false;
    const before = this.actions.length;
    this.actions = (this.actions || []).filter((a) =>
      !(a?.source === 'chain-replay' && Number(a.sat) === n));
    let changed = this.actions.length !== before;
    for (const action of actions || []) {
      const kind = String(action.kind || '').toLowerCase();
      if (!kind) continue;
      const tx = String(action.txid || '').toLowerCase();
      const hit = this.actions.find((a) => {
        if (String(a?.kind || '').toLowerCase() !== kind) return false;
        if (tx) return String(a.txid || '').toLowerCase() === tx;
        return Number(a.height) === Number(action.height) && Number(a.sat) === n;
      });
      if (hit) {
        if (action.height != null && Number(hit.height) !== Number(action.height)) {
          hit.height = Number(action.height);
          changed = true;
        }
        if (action.dir != null && hit.dir !== action.dir) {
          hit.dir = Number(action.dir);
          changed = true;
        }
        if (action.outcome && hit.outcome !== action.outcome) {
          hit.outcome = action.outcome;
          changed = true;
        }
        for (const k of ['settled', 'settle_height', 'mempool']) {
          if (action[k] != null && hit[k] !== action[k]) {
            hit[k] = action[k];
            changed = true;
          }
        }
        continue;
      }
      this.actions.unshift({
        ...action,
        sat: n,
        at: new Date().toISOString(),
        source: 'chain-replay',
      });
      changed = true;
    }
    this.actions = this.actions.slice(0, 300);
    return changed;
  }

  async _chainTxHex(txid) {
    const tx = String(txid || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(tx)) return null;
    if (this._chainHexCache.has(tx)) return this._chainHexCache.get(tx);
    let hex = null;
    try {
      hex = await this.backend.getTxHex(tx);
    } catch {
      hex = null;
    }
    if (typeof hex === 'string' && /^[0-9a-f]+$/i.test(hex.trim())) {
      hex = hex.trim().toLowerCase();
      this._chainHexCache.set(tx, hex);
      if (this._chainHexCache.size > 600) {
        this._chainHexCache.delete(this._chainHexCache.keys().next().value);
      }
      return hex;
    }
    return null;
  }

  async _chainBlockHash(height) {
    const h = Number(height);
    if (!Number.isInteger(h) || h < 0) return null;
    const cacheKey = `${this.tipHash || ''}:${h}`;
    if (this._chainHashCache.has(cacheKey)) return this._chainHashCache.get(cacheKey);
    let hash = null;
    try { hash = await this.backend.blockHashAt(h); } catch { hash = null; }
    if (typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash)) {
      hash = hash.toLowerCase();
      this._chainHashCache.set(cacheKey, hash);
      if (this._chainHashCache.size > 1200) {
        this._chainHashCache.delete(this._chainHashCache.keys().next().value);
      }
      return hash;
    }
    return null;
  }

  /** Replay the state address's transaction history. The state script is
   *  fixed for (sat, mint, owner), so every TRAVEL and HOP appears in one
   *  address history. This is the indexer-free path that lets a restored
   *  browser see crossings it did not author itself. It is deliberately
   *  cold/manual-only: warm passes must not turn into history walks. */
  async _reconstructChainFrogs(records, utxos, { tip = 0 } = {}) {
    if (this.settings.mode === 'demo' || !this.backend?.addressHistory
        || !this.backend?.getTxHex || !this.backend?.blockHashAt) return false;
    const local = [...records.values()].filter((r) =>
      r?.local === true && Number.isSafeInteger(Number(r.sat)) && Number(r.sat) > 0);
    if (!local.length) return false;
    const scriptHex = (script) => {
      if (!script) return '';
      try { return typeof script === 'string' ? script.toLowerCase() : bytesToHex(script); } catch { return ''; }
    };
    let any = false;
    await mapLimit(local, 2, async (record) => {
      const sat = Number(record.sat);
      let state;
      try { state = this._frogState(record); } catch { return; }
      const stateHex = bytesToHex(state.script);
      // A frog that was sent to another owner no longer has an output at our
      // derived state script. Do not replay its old life as if we still held it.
      const current = utxos.find((u) => scriptHex(u.script) === stateHex
        && !u.spent && u.spendable !== true);
      if (!current) return;

      let rows = [];
      try {
        rows = await this.backend.addressHistory(
          scriptToAddress(state.script, this.network), state.script,
        );
      } catch { return; }
      if (!Array.isArray(rows) || !rows.length) return;

      const hexByTx = new Map();
      const roles = new Map();
      let complete = true;
      await mapLimit(rows, 4, async (row) => {
        const txid = String(row?.txid || '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(txid)) return;
        const hex = await this._chainTxHex(txid);
        if (!hex) { complete = false; return; }
        hexByTx.set(txid, hex);
        roles.set(txid, frogTxRole({
          record, hex, stateScript: state.script,
          ownerXonly: this._frogOwner(record), legacy: this._frogLegacyWire(record),
          txid,
        }));
      });
      if (!complete) return;

      const heights = new Set();
      for (const row of rows) {
        const txid = String(row?.txid || '').toLowerCase();
        const role = roles.get(txid);
        const h = Number(row?.height);
        if (role?.crossing && Number.isInteger(h) && h > 0 && h + 1 <= tip) {
          heights.add(h + 1);
        }
      }
      const hashByHeight = new Map();
      for (const h of heights) {
        const hash = await this._chainBlockHash(h);
        if (!hash) { complete = false; break; }
        hashByHeight.set(String(h), hash);
      }
      if (!complete) return;

      const replay = replayFrogChain({
        record, rows, txHex: hexByTx, hashByHeight, tip, stateScript: state.script,
        ownerXonly: this._frogOwner(record), legacy: this._frogLegacyWire(record),
      });
      if (!replay) return;

      record.state = replay.state;
      record.dist = replay.dist;
      record.crossings_entered = replay.crossingsEntered;
      record.crossings_settled = replay.crossingsSettled;
      record.deaths = replay.deaths;
      record.last_target_hops = replay.lastTarget;
      record.in_flight = replay.inFlight;
      record.immortal_height = replay.immortalHeight;
      record.death_height = replay.deathHeight;
      record.outcome_block_hash = replay.outcomeBlockHash;
      record.outcome_wrap = replay.outcomeWrap;
      record.provisional_dead = replay.provisionalDead;
      record.chain_replayed = true;
      if (this._upsertChainActions(sat, replay.actions)) this._saveLedger();
      any = true;
    });
    return any;
  }

  /** Recover HOPPER mints paid to our ordinals address from their reveal
   *  witnesses. Positive answers are cached by outpoint; the chain remains
   *  the source, and a spent reveal simply disappears from `utxos`.
   *
   *  On a cold/manual pass the ord address history is also walked. That is
   *  what recovers a mint that was already PREPAREd into its staging output
   *  on another device with the same mnemonic: the reveal is no longer a
   *  UTXO, but its transaction is still in the address history. */
  async _localMintRecords(utxos, records, { history = false } = {}) {
    if (!this.backend?.getTxHex) return [];
    const ordAddress = this.keys.frogAddress();
    const ordScript = p2trScript(this.keys.ord.outputXonly);
    const legacyAddress = this.keys.legacyFrogAddress();
    const legacyScript = p2trScript(this.keys.legacyOrd.outputXonly);
    const addressInfo = new Map([
      [ordAddress, { script: ordScript, hex: bytesToHex(ordScript), legacyPath: false }],
      [legacyAddress, { script: legacyScript, hex: bytesToHex(legacyScript), legacyPath: true }],
    ]);
    const known = new Set();
    for (const record of records.values()) {
      const location = record?.location;
      if (location?.txid) known.add(`${String(location.txid).toLowerCase()}:${Number(location.vout)}`);
    }
    const candidatesForMint = utxos.filter((u) => u.kind === 'frog'
      && addressInfo.has(u.address)
      && !known.has(`${String(u.txid).toLowerCase()}:${Number(u.vout)}`));
    for (const u of utxos) {
      if (u?.txid) known.add(`${String(u.txid).toLowerCase()}:${Number(u.vout)}`);
    }
    const found = [];
    const parseOne = async (u) => {
      const key = `${String(u.txid).toLowerCase()}:${Number(u.vout)}`;
      const height = u.status?.block_height ?? u.status?.height ?? null;
      // F-07: the reveal document cannot prove its own claimed sat. Add
      // complete ranges from the chain source before parsing, and let the
      // parser mark the record unverified when no source can name them.
      if ((!Array.isArray(u.ranges) || !u.ranges.length) && this.backend?.utxo) {
        try {
          const dto = await this.backend.utxo(u.txid, u.vout);
          if (dto && Array.isArray(dto.ranges)) {
            u = { ...u, ranges: dto.ranges.map(([a, b]) => [Number(a), Number(b) - 1]) };
          }
        } catch { /* leave unverified */ }
      }
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
        const info = addressInfo.get(u.address) || { script: ordScript, legacyPath: false };
        record = parseLocalMint({
          hex, utxo: { ...u, legacy_path: info.legacyPath },
          script: info.script, mintHeight: height,
        });
        // Do not cache an unverified record: a later pass may have the
        // complete ranges that prove the claimed sat.
        if (record && record.sat_verified !== false) this._localMintCache.set(key, record);
        else if (!record) this._localMintCache.set(key, false);
        if (!record) return;
      }
      if (!records.has(record.sat) && !found.some((r) => r.sat === record.sat)) found.push(record);
    };
    await mapLimit(candidatesForMint, 2, parseOne);

    if (history && typeof this.backend.addressHistory === 'function') {
      const seen = new Set(candidatesForMint.map((u) =>
        `${String(u.txid).toLowerCase()}:${Number(u.vout)}`));
      const extra = [];
      for (const [address, info] of addressInfo) {
        let rows = [];
        try { rows = await this.backend.addressHistory(address, info.script); } catch { rows = []; }
        for (const row of Array.isArray(rows) ? rows : []) {
          const txid = String(row?.txid || '').toLowerCase();
          const key = `${txid}:0`;
          if (!/^[0-9a-f]{64}$/.test(txid) || known.has(key) || seen.has(key)) continue;
          seen.add(key);
          // LiveBackend's history rows carry outputs. When present, only
          // fetch the transaction if its first output is this path's script.
          const out0 = row.outputs?.[0];
          if (out0?.script && bytesToHex(out0.script) !== info.hex) continue;
          extra.push({
            txid, vout: 0, value: out0?.value ?? null, script: info.script,
            address, kind: 'frog', legacy_path: info.legacyPath,
            status: { block_height: row.height ?? row.status?.block_height ?? null },
          });
        }
      }
      await mapLimit(extra, 2, parseOne);
    }
    return found;
  }

  /** Rebuild minimal local records from the persisted chain-mint ledger.
   *  This keeps a staged Hopper visible after a reload without asking an
   *  indexer or ord server; the state address is watched separately. */
  _seedChainMints(records, candidates, previousFrogs = [], utxos = []) {
    for (const mint of this.chainMints || []) {
      const sat = Number(mint?.sat);
      const mintTxid = String(mint?.txid || '').toLowerCase();
      if (!Number.isSafeInteger(sat) || sat <= 0 || !/^[0-9a-f]{64}$/.test(mintTxid)) continue;
      if (records.has(sat)) continue;
      const staged = this.staged[String(sat)];
      const stagedUtxo = staged?.txid && utxos.find((u) =>
        String(u.txid).toLowerCase() === String(staged.txid).toLowerCase()
        && Number(u.vout) === Number(staged.vout));
      const prior = previousFrogs.find((f) => Number(f?.sat) === sat);
      // Only trust a remembered state outpoint when this pass actually saw
      // it. Otherwise the old spend could be mistaken for a live coin.
      const location = stagedUtxo
        ? { txid: String(stagedUtxo.txid).toLowerCase(), vout: Number(stagedUtxo.vout) }
        : { txid: mintTxid, vout: Number(mint.mint_index) || 0 };
      records.set(sat, {
        ...(prior || {}),
        sat,
        seed: mint.seed,
        name: mint.name || '',
        state: prior?.state || 'idle',
        dist: Number(prior?.dist) || 0,
        mint_height: Number(mint.height) || 0,
        mint_txid: mintTxid,
        mint_index: Number.isSafeInteger(Number(mint.mint_index)) ? Number(mint.mint_index) : 0,
        commit: /^[0-9a-f]{64}$/.test(String(mint.commit || '').toLowerCase())
          ? String(mint.commit).toLowerCase() : null,
        location,
        local: true,
      });
      candidates.add(sat);
    }
  }

  /** Record every settled wallet output the chain has shown us. This is
   *  the receive half of history: chain/indexer events and local actions do
   *  not describe an ordinary deposit, and a confirmed deposit otherwise
   *  vanished from the UI when it left the mempool. Grouping is by txid so
   *  a transaction paying two of our addresses is one row. Nothing here
   *  makes a network request. */
  _recordObservedReceives(utxos) {
    if (!Array.isArray(this.receives)) this.receives = [];
    const actions = new Map();
    const commits = new Set();
    for (const a of this.actions || []) {
      if (a?.txid) actions.set(String(a.txid).toLowerCase(), a);
      if (a?.commit) commits.add(String(a.commit).toLowerCase());
    }
    const frogAt = new Map();
    for (const f of this.frogs || []) {
      const location = f?.location;
      if (location?.txid) {
        frogAt.set(`${String(location.txid).toLowerCase()}:${Number(location.vout)}`, f);
      }
    }
    const existing = new Map();
    for (const r of this.receives) {
      const key = `${r.frog ? 'frog' : 'receive'}:${String(r.txid).toLowerCase()}`;
      if (!existing.has(key)) existing.set(key, r);
    }
    const frogForTx = new Map();
    for (const u of utxos || []) {
      if (!u?.address || u.kind === 'state' || u.unconfirmed) continue;
      const txid = String(u.txid || '').toLowerCase();
      const record = frogAt.get(`${txid}:${Number(u.vout)}`)
        || (Array.isArray(u.frogs) && u.frogs.length
          ? { sat: Number(u.frogs[0]), name: null, seed: null } : null);
      if (record) frogForTx.set(txid, record);
    }
    const groups = new Map();
    for (const u of utxos || []) {
      if (!u?.address || u.kind === 'state' || u.unconfirmed) continue;
      const txid = String(u.txid || '').toLowerCase();
      if (!txid || commits.has(txid)) continue;
      const action = actions.get(txid) || null;
      const record = frogAt.get(`${txid}:${Number(u.vout)}`)
        || (Array.isArray(u.frogs) && u.frogs.length
          ? { sat: Number(u.frogs[0]), name: null, seed: null } : null);
      // A transaction we built has no receive row for its ordinary change.
      // Its frog output is still a real arrival and gets its own row.
      if (action && !record) continue;
      const frog = frogForTx.get(txid) || record;
      const key = frog ? `frog:${txid}` : `receive:${txid}`;
      const height = Number.isInteger(Number(u.status?.block_height))
        ? Number(u.status.block_height)
        : Number.isInteger(Number(u.status?.height)) && Number(u.status.height) > 0
          ? Number(u.status.height) : null;
      const row = groups.get(key) || {
        txid, amount: 0, address: u.address, height,
        frog: !!frog, sat: frog ? Number(frog.sat) : null,
        name: frog?.name ?? null, seed: frog?.seed ?? null,
        confirmed: true, at: new Date().toISOString(),
      };
      row.amount += Number(u.value) || 0;
      if (row.height == null && height != null) row.height = height;
      if (record) {
        row.frog = true;
        row.sat = Number(record.sat);
        if (record.name != null) row.name = record.name;
        if (record.seed != null) row.seed = record.seed;
        row.address = u.address;
      }
      groups.set(key, row);
    }
    for (const [key, incoming] of groups) {
      let prior = existing.get(key);
      // A delayed local-mint/indexer answer can upgrade a plain receive row
      // for the same transaction into a Hopper arrival. Do not add a second
      // row for the same txid.
      if (!prior && key.startsWith('frog:')) {
        const ordinaryKey = `receive:${incoming.txid}`;
        const ordinary = existing.get(ordinaryKey);
        if (ordinary) {
          Object.assign(ordinary, {
            frog: true, sat: incoming.sat, name: incoming.name, seed: incoming.seed,
            address: incoming.address,
          });
          existing.delete(ordinaryKey);
          existing.set(key, ordinary);
          prior = ordinary;
        }
      }
      if (prior) {
        if (prior.height == null && incoming.height != null) prior.height = incoming.height;
        if (prior.name == null && incoming.name != null) prior.name = incoming.name;
        if (prior.seed == null && incoming.seed != null) prior.seed = incoming.seed;
        continue;
      }
      this.receives.push(incoming);
      existing.set(key, incoming);
    }
    if (this.receives.length > 300) this.receives = this.receives.slice(-300);
  }

  /** The only change script this wallet ever uses. */
  _changeAddressEntries() {
    try {
      const key = this.keys.change(0);
      return [{ address: key.address, script: key.script, index: 0 }];
    } catch { return []; }
  }

  /** The mint context for a transaction. A mint has a commit (which usually
   *  carries the change) and a reveal (the MINT action and Hopper output);
   *  both identify the same minted sat. */
  _mintContext(txid) {
    const tx = String(txid || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(tx)) return null;
    for (const a of this.actions || []) {
      if (String(a?.kind || '').toLowerCase() !== 'mint') continue;
      const reveal = String(a.txid || '').toLowerCase();
      const commit = String(a.commit || '').toLowerCase();
      if (tx !== reveal && tx !== commit) continue;
      const sat = Number(a.sat);
      return {
        sat: Number.isSafeInteger(sat) ? sat : null,
        mintTxid: /^[0-9a-f]{64}$/.test(reveal) ? reveal : null,
        commit: /^[0-9a-f]{64}$/.test(commit) ? commit : null,
      };
    }
    for (const m of this.chainMints || []) {
      const reveal = String(m?.txid || '').toLowerCase();
      const commit = String(m?.commit || '').toLowerCase();
      if (tx !== reveal && tx !== commit) continue;
      const sat = Number(m.sat);
      return {
        sat: Number.isSafeInteger(sat) ? sat : null,
        mintTxid: /^[0-9a-f]{64}$/.test(reveal) ? reveal : null,
        commit: /^[0-9a-f]{64}$/.test(commit) ? commit : null,
      };
    }
    return null;
  }

  /** Keep persisted change rows linked to their mint after a restore. Their
   *  txid is normally the commit, so this is what lets the UI place MINT,
   *  CHANGE and HOPPER ARRIVED in one group even when the commit height is
   *  older than the reveal height. */
  _tagChanges() {
    for (const c of this.changes || []) {
      const ctx = this._mintContext(c?.txid);
      if (!ctx) continue;
      if (Number.isSafeInteger(ctx.sat)) c.mintSat = ctx.sat;
      if (ctx.mintTxid) c.mintTxid = ctx.mintTxid;
    }
  }

  _mergeChange(row) {
    if (!Array.isArray(this.changes)) this.changes = [];
    const txid = String(row?.txid || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) return null;
    const ctx = this._mintContext(txid);
    const prior = this.changes.find((r) => String(r?.txid || '').toLowerCase() === txid);
    if (prior) {
      prior.amount = Math.max(Number(prior.amount) || 0, Number(row.amount) || 0);
      if (prior.height == null && row.height != null) prior.height = row.height;
      if (prior.address == null && row.address != null) prior.address = row.address;
      prior.confirmed = prior.confirmed === true || row.confirmed === true;
      if (ctx) {
        if (Number.isSafeInteger(ctx.sat)) prior.mintSat = ctx.sat;
        if (ctx.mintTxid) prior.mintTxid = ctx.mintTxid;
      }
      return prior;
    }
    const next = {
      txid, amount: Number(row.amount) || 0, address: row.address || null,
      height: row.height ?? null, confirmed: row.confirmed === true,
      at: row.at || new Date().toISOString(),
    };
    if (ctx) {
      if (Number.isSafeInteger(ctx.sat)) next.mintSat = ctx.sat;
      if (ctx.mintTxid) next.mintTxid = ctx.mintTxid;
    }
    this.changes.push(next);
    return next;
  }

  /** Older builds recorded an own-change output as an ordinary RECEIVE.
   *  Move those rows into the CHANGE ledger instead of presenting internal
   *  change as outside income. This is local-state migration only. */
  _migrateChangeReceives(entries) {
    const addresses = new Set((entries || []).map((e) => e.address));
    if (!addresses.size || !Array.isArray(this.receives)) return 0;
    let moved = 0;
    this.receives = this.receives.filter((r) => {
      if (!r || r.frog || !addresses.has(r.address)) return true;
      this._mergeChange(r);
      moved += 1;
      return false;
    });
    return moved;
  }

  /** Record settled change outputs from the current watch pass. Change is
   *  not a receive: it is money returning from a transaction this wallet
   *  built, so it gets its own ledger row and label. */
  _recordObservedChanges(utxos) {
    const entries = this._changeAddressEntries();
    this._migrateChangeReceives(entries);
    const groups = new Map();
    for (const u of utxos || []) {
      if (!u?.txid || u.unconfirmed || u.keyRef?.branch !== 1) continue;
      const txid = String(u.txid).toLowerCase();
      const height = Number.isInteger(Number(u.status?.block_height))
        ? Number(u.status.block_height)
        : Number.isInteger(Number(u.status?.height)) && Number(u.status.height) > 0
          ? Number(u.status.height) : null;
      const row = groups.get(txid) || {
        txid, amount: 0, address: u.address || null, height,
        confirmed: true, at: new Date().toISOString(),
      };
      row.amount += Number(u.value) || 0;
      if (row.height == null && height != null) row.height = height;
      if (!row.address && u.address) row.address = u.address;
      groups.set(txid, row);
    }
    for (const row of groups.values()) this._mergeChange(row);
    if (this.changes.length > 300) this.changes = this.changes.slice(-300);
  }

  /** Older mint actions did not always persist the commit txid. The reveal
   *  names it as input 0, which is what links the commit's change output to
   *  the mint. Repair this once per transaction so restored ledgers do not
   *  render MINT and CHANGE in separate groups. */
  async _repairMintCommits() {
    if (typeof this.backend?.getTxHex !== 'function') return 0;
    const outputs = [
      ...(this.actions || []).filter((a) => String(a?.kind || '').toLowerCase() === 'mint'),
      ...(this.chainMints || []),
    ];
    let repaired = 0;
    for (const row of outputs) {
      const reveal = String(row?.txid || '').toLowerCase();
      const commit = String(row?.commit || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(reveal) || /^[0-9a-f]{64}$/.test(commit)) continue;
      let hex = null;
      try { hex = await this.backend.getTxHex(reveal); } catch { continue; }
      if (!hex) continue;
      let tx = null;
      try { tx = parseTx(hex); } catch { continue; }
      const found = String(tx?.inputs?.[0]?.txid || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(found)) continue;
      row.commit = found;
      repaired += 1;
    }
    if (repaired) this._saveLedger();
    return repaired;
  }

  /** A mint whose reveal output is still the owned ord output is provably
   *  ours, even on a device that has no local action ledger. Persist that
   *  chain fact so a restored browser still shows MINT beside the arrival.
   *  A Hopper received by transfer is not at its mint outpoint and is not
   *  recorded here. */
  _recordChainMints() {
    if (!Array.isArray(this.chainMints)) this.chainMints = [];
    const ordAddress = this.keys.frogAddress();
    for (const f of this.frogs || []) {
      const mintTxid = String(f?.mint_txid || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(mintTxid)) continue;
      const atMint = !!f.location
        && String(f.location.txid).toLowerCase() === mintTxid
        && Number(f.location.vout) === Number(f.mint_index ?? 0);
      if (!atMint && f.local !== true) continue;
      const mintUtxo = (this.utxos || []).find((u) => String(u.txid).toLowerCase() === mintTxid
        && Number(u.vout) === Number(f.mint_index ?? 0));
      // A local record (parsed from the reveal or recovered from the mint
      // ledger) is already proved ours by the ord address/history. Indexer
      // records still need the current mint outpoint as proof.
      if (atMint && f.local !== true && (!mintUtxo || mintUtxo.address !== ordAddress)) continue;
      // Indexers normally carry mint_height, but local/ord records and old
      // ledgers may not. Reuse the height already learned from the Hopper
      // arrival or its UTXO so restored devices sort MINT beside, not below,
      // HOPPER ARRIVED.
      const heightOf = (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n > 0 ? n : null;
      };
      const height = heightOf(f.mint_height)
        ?? heightOf((this.receives || []).find((r) => r?.frog
          && String(r.txid || '').toLowerCase() === mintTxid)?.height)
        ?? heightOf(mintUtxo?.status?.block_height ?? mintUtxo?.status?.height);
      const prior = this.chainMints.find((m) => String(m.txid).toLowerCase() === mintTxid);
      const hasAction = (this.actions || []).some((a) => String(a?.txid || '').toLowerCase() === mintTxid);
      const commit = String(f.commit || '').toLowerCase();
      const row = {
        txid: mintTxid, sat: Number(f.sat), seed: f.seed, name: f.name || '',
        height, mint_index: Number(f.mint_index ?? 0) || 0,
        commit: /^[0-9a-f]{64}$/.test(commit) ? commit : null,
        at: new Date().toISOString(),
      };
      if (prior) {
        if (!(Number(prior.height) > 0) && row.height != null) prior.height = row.height;
        if (!prior.name && row.name) prior.name = row.name;
        if (prior.seed == null && row.seed != null) prior.seed = row.seed;
        if (!prior.commit && row.commit) prior.commit = row.commit;
        if (prior.mint_index == null) prior.mint_index = row.mint_index;
      } else {
        this.chainMints.unshift(row);
        // On a device without the local action ledger, a new on-chain mint
        // can also mean a change output that was spent before this browser
        // saw it. Recheck used change history once, then let the version
        // marker stop the queries again. The minting device already records
        // its own change from the watch pass.
        if (!hasAction) {
          this.changesVersion = 0;
          this._changeBackfillFailedAt = 0;
        }
      }
    }
    if (this.chainMints.length > 300) this.chainMints = this.chainMints.slice(0, 300);
  }

  /** One-time recovery for change outputs whose coins were already spent
   *  before this browser saw them. It asks only the change addresses the
   *  wallet has used, then records every output paying those scripts. This
   *  is what makes a restored wallet show the same internal change as the
   *  device that built the transactions. */
  async _backfillChanges() {
    const entries = this._changeAddressEntries();
    this._migrateChangeReceives(entries);
    if (this.changesVersion >= 1) return 0;
    if (Date.now() - (this._changeBackfillFailedAt || 0) < 60_000) return 0;
    if (!entries.length) {
      this.changesVersion = 1;
      return 0;
    }
    const found = new Map();
    let failed = false;
    let sawUnconfirmed = false;
    let asked = 0;
    for (const entry of entries) {
      if (asked && this.publicSource) await sleep(200);
      asked += 1;
      let hist;
      try {
        hist = await this.backend.addressHistory(entry.address, entry.script);
      } catch {
        failed = true;
        continue;
      }
      for (const h of Array.isArray(hist) ? hist : []) {
        const txid = String(h?.txid || '').toLowerCase();
        if (!txid) continue;
        let outputs = Array.isArray(h.outputs) ? h.outputs : null;
        let height = Number.isInteger(Number(h.height)) && Number(h.height) > 0
          ? Number(h.height) : null;
        let confirmed = h.confirmed === true || h.status?.confirmed === true || height != null;
        if (!outputs) {
          const tx = await this._getTx(txid);
          if (!tx) { failed = true; continue; }
          outputs = tx.outputs || [];
          const th = tx.status?.height ?? tx.status?.block_height;
          if (height == null && Number.isInteger(Number(th)) && Number(th) > 0) {
            height = Number(th);
          }
          confirmed = confirmed || tx.status?.confirmed === true || height != null;
        }
        const want = bytesToHex(entry.script).toLowerCase();
        let amount = 0;
        for (const o of outputs || []) {
          const hex = typeof o?.script === 'string'
            ? o.script.toLowerCase()
            : o?.script ? bytesToHex(o.script).toLowerCase() : '';
          if (hex === want) amount += Number(o.value) || 0;
        }
        if (!amount) continue;
        if (!confirmed) { sawUnconfirmed = true; continue; }
        const prior = found.get(txid);
        if (prior) {
          prior.amount += amount;
          if (prior.height == null && height != null) prior.height = height;
        } else {
          found.set(txid, {
            txid, amount, address: entry.address, height, confirmed: true,
          });
        }
      }
    }
    let added = 0;
    for (const row of found.values()) {
      const prior = (this.changes || []).find(
        (r) => String(r?.txid || '').toLowerCase() === row.txid,
      );
      this._mergeChange(row);
      if (!prior) added += 1;
    }
    if (this.changes.length > 300) this.changes = this.changes.slice(-300);
    if (failed) this._changeBackfillFailedAt = Date.now();
    else if (!sawUnconfirmed) this.changesVersion = 1;
    return added;
  }

  /** The only ordinary receive script this wallet ever uses. */
  _receiveBackfillEntries() {
    try {
      const key = this.keys.receive(0);
      return [{ address: key.address, script: key.script, index: 0 }];
    } catch { return []; }
  }

  /** One-time recovery of receives that predate the local receive ledger.
   *  A deposit whose coin was already spent leaves no UTXO, but the fixed
   *  receive script's history still names its transaction. This is
   *  deliberately versioned: after one successful pass the wallet does not
   *  touch that history again. */
  async _backfillReceives() {
    if (this.receivesVersion >= 2) return 0;
    if (Date.now() - (this._receiveBackfillFailedAt || 0) < 60_000) return 0;
    const entries = this._receiveBackfillEntries();
    if (!entries.length) {
      this.receivesVersion = 2;
      return 0;
    }
    const actionTxids = new Set();
    const commitTxids = new Set();
    for (const a of this.actions || []) {
      if (a?.txid) actionTxids.add(String(a.txid).toLowerCase());
      if (a?.commit) commitTxids.add(String(a.commit).toLowerCase());
    }
    const found = new Map();
    let failed = false;
    let sawUnconfirmed = false;
    let asked = 0;
    for (const entry of entries) {
      if (asked && this.publicSource) await sleep(200);
      asked += 1;
      let hist;
      try {
        hist = await this.backend.addressHistory(entry.address, entry.script);
      } catch {
        failed = true;
        continue;
      }
      for (const h of Array.isArray(hist) ? hist : []) {
        const txid = String(h?.txid || '').toLowerCase();
        if (!txid) continue;
        // An outgoing transaction's change is not a receive. Its commit
        // output is not one either. This keeps mint/SEND change out of
        // history while still recovering ordinary deposits.
        if (actionTxids.has(txid) || commitTxids.has(txid)) continue;
        let outputs = Array.isArray(h.outputs) ? h.outputs : null;
        let height = Number.isInteger(Number(h.height)) && Number(h.height) > 0
          ? Number(h.height) : null;
        let confirmed = h.confirmed === true || h.status?.confirmed === true || height != null;
        if (!outputs) {
          const tx = await this._getTx(txid);
          if (!tx) { failed = true; continue; }
          outputs = tx.outputs || [];
          const th = tx.status?.height ?? tx.status?.block_height;
          if (height == null && Number.isInteger(Number(th)) && Number(th) > 0) {
            height = Number(th);
          }
          confirmed = confirmed || tx.status?.confirmed === true || height != null;
        }
        const want = bytesToHex(entry.script).toLowerCase();
        let amount = 0;
        for (const o of outputs) {
          const hex = typeof o?.script === 'string'
            ? o.script.toLowerCase()
            : o?.script ? bytesToHex(o.script).toLowerCase() : '';
          if (hex !== want) continue;
          amount += Number(o.value) || 0;
        }
        if (!amount) continue;
        if (!confirmed) { sawUnconfirmed = true; continue; }
        const prior = found.get(txid);
        if (prior) {
          prior.amount += amount;
          if (prior.height == null && height != null) prior.height = height;
        } else {
          found.set(txid, {
            txid, amount, address: entry.address, height, confirmed: true,
          });
        }
      }
    }
    let added = 0;
    for (const row of found.values()) {
      const prior = (this.receives || []).find(
        (r) => String(r?.txid || '').toLowerCase() === row.txid,
      );
      // A Hopper arrival already represents this transaction. Do not add an
      // ordinary receive row beside it.
      if (prior?.frog) continue;
      if (prior) {
        prior.amount = Math.max(Number(prior.amount) || 0, row.amount);
        if (prior.height == null && row.height != null) prior.height = row.height;
        prior.confirmed = true;
        if (prior.address == null) prior.address = row.address;
        continue;
      }
      this.receives.push({
        txid: row.txid, amount: row.amount, address: row.address,
        height: row.height, frog: false, sat: null, name: null, seed: null,
        confirmed: true, at: new Date().toISOString(),
      });
      added += 1;
    }
    if (this.receives.length > 300) this.receives = this.receives.slice(-300);
    if (failed) this._receiveBackfillFailedAt = Date.now();
    else if (!sawUnconfirmed) this.receivesVersion = 2;
    return added;
  }

  async _ownsFrog(record, utxos) {
    // 1. The location is one of our watched outputs (mint / received).
    const direct = utxos.find((u) => record.location && u.txid === record.location.txid && u.vout === record.location.vout);
    if (direct) return { owned: true, utxo: direct, custody: direct.kind === 'state' };
    const inRanges = utxos.find((u) => u.ranges && u.ranges.some(([a, b]) => record.sat >= a && record.sat <= b));
    if (inRanges) return { owned: true, utxo: inRanges, custody: inRanges.kind === 'state' };

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
    let want = null;
    try {
      want = this._frogState(record);
      if (!equalBytes(out.script, want.script)
          && !this._frogLegacyPath(record) && !record.legacy_path) {
        // A recovered v7/legacy-path frog may live at the released
        // derivation. Try it once; never change the record's path in place.
        const legacyWant = stateScripts(
          record, this.keys.legacyOrd.ownerXonly, { legacy: this._frogLegacyWire(record) },
        );
        if (equalBytes(out.script, legacyWant.script)) {
          record.legacy_path = true;
          want = legacyWant;
        }
      }
    } catch { return { owned: false }; }
    if (!want || !equalBytes(out.script, want.script)) return { owned: false };
    let dto = null;
    try { dto = await this.backend.utxo(record.location.txid, record.location.vout); } catch { dto = null; }
    // F-07/F-13: a state script is not a set of sat ranges. Keep the coin
    // owned, but do not mark it exact or spendable unless the range source
    // is complete and value-matched. Actions fail closed on this flag.
    const ranges = dto && Array.isArray(dto.ranges)
      ? dto.ranges.map(([a, b]) => [Number(a), Number(b) - 1]) : null;
    const exact = !!(ranges && ranges.length && Number(dto.value) === Number(out.value));
    const holdsFrog = exact && ranges.some(([a, b]) => Number(record.sat) >= a && Number(record.sat) <= b);
    return {
      owned: true,
      custody: true,
      utxo: {
        txid: record.location.txid, vout: record.location.vout, value: Number(out.value),
        script: out.script, kind: 'state', address: null,
        ranges: holdsFrog ? ranges : null,
        exact: holdsFrog,
        frogs: holdsFrog ? [record.sat] : [],
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
    const spendUnconfirmed = this.settings.spendUnconfirmed !== false;
    for (const u of this.utxos) {
      const value = BigInt(u.value);
      const plain = u.kind === 'p2wpkh' && !(u.frogs && u.frogs.length);
      total += value;
      if (u.unconfirmed) pending += value;
      // Exact ranges keep a coin safe from sweeping an ordinal into a fee.
      // An unconfirmed plain coin can still fund a SEND when the opt-in is
      // on: its only unknown is where the sats came from, never a known
      // Hopper/card output. Mint/travel/hop use the stricter _funding().
      const pendingSend = spendUnconfirmed && u.unconfirmed === true && plain;
      if (plain && (u.spendable !== false && u.exact && u.ranges)
          && (!u.unconfirmed || spendUnconfirmed)) spendable += value;
      else if (pendingSend) spendable += value;
      else if (u.exact && u.ranges && !plain) cards += value;
      else unspendable += value;
    }
    this.balance = { total, spendable, cards, unspendable, pending };
  }

  /** Format the fingerprint exactly as the export does. */
  _emergencyFingerprint() {
    const fp = this.keys.fingerprint;
    return typeof fp === 'number'
      ? fp.toString(16).padStart(8, '0')
      : String(fp || '').toLowerCase().padStart(8, '0');
  }

  /** One staged Hopper's public layout. `txid/vout/value` is explicit so a
   *  transaction we just broadcast can be recorded before the indexer has
   *  named its new location. */
  _emergencyEntry(f, { txid, vout, value } = {}) {
    if (!f || !txid || !Number.isInteger(Number(vout))) return null;
    const ownerXonly = this.keys.ord.ownerXonly;
    const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    try {
      const scripts = stateScripts(f, ownerXonly);
      const leaves = [0, 1, 2].map((dir) => ({
        dir,
        script_hex: hex(scripts.crossLeaves[dir]),
        leaf_hash: hex(scripts.leafHashes[dir]),
        control_block: hex(scripts.crossControls[dir]),
      }));
      const sendLeaf = {
        script_hex: hex(scripts.sendLeaf),
        leaf_hash: hex(scripts.leafHashes[3]),
        control_block: hex(scripts.sendControl),
      };
      const descriptor = taprootDescriptor(
        hex(NUMS_XONLY),
        [...leaves.map((l) => l.script_hex), sendLeaf.script_hex],
      );
      return {
        sat: Number(f.sat),
        gen: Number(f.gen) || generationAt(f.mint_height || this.tipHeight || 0),
        dist: Number(f.dist) || 0,
        state: String(f.state || 'idle'),
        name: String(f.name || ''),
        mint_id: `${String(f.mint_txid || '').toLowerCase()}i${Number(f.mint_index) || 0}`,
        state_outpoint: `${String(txid).toLowerCase()}:${Number(vout)}`,
        state_value: Number(value || CARD_VALUE),
        owner_xonly: hex(ownerXonly),
        internal_key: hex(NUMS_XONLY),
        output_key: hex(scripts.outputXonly),
        leaves,
        send_leaf: sendLeaf,
        descriptor,
      };
    } catch { return null; }
  }

  /** SPEC §5.5 — the emergency descriptor export.
   *
   * Public layout data only: the raw leaves, their control blocks, the
   * output key and the owner path for every staged Hopper. It never
   * contains a seed, an xprv or a private key; whoever holds it still
   * needs the seeds. A receiving tool MUST rebuild the tree and compare
   * it with the on-chain scriptPubKey before trusting it.
   */
  emergencyDescriptors({ now = null } = {}) {
    const frogs = [];
    for (const f of this.frogs || []) {
      const utxo = this._frogUtxo?.(f);
      const staged = utxo && utxo.kind === 'state';
      if (!staged) continue;
      if (f.state === 'burned' || f.state === 'retired') continue;
      const entry = this._emergencyEntry(f, {
        txid: f.location?.txid, vout: Number(f.location?.vout), value: utxo.value,
      });
      if (entry) frogs.push(entry);
    }
    const staged = frogs.filter((f) => f.state_outpoint);
    return {
      type: 'hopper-v8-emergency',
      version: 1,
      network: this.network,
      fingerprint: this._emergencyFingerprint(),
      owner_path: this.keys.ordPath,
      // One descriptor can only describe one state tree (the leaf bodies
      // embed sat + mint id). The per-frog `descriptor` is authoritative;
      // this convenience line is present only when exactly one is staged.
      descriptor: staged.length === 1 ? staged[0].descriptor : null,
      generated_at: now || new Date().toISOString(),
      tip_height: Number(this.tipHeight) || 0,
      frogs,
    };
  }

  /** A tool that sees a different tip must treat the layout as a snapshot. */
  emergencyIsStale(doc, tipHeight = this.tipHeight) {
    return Number(doc?.tip_height) !== Number(tipHeight);
  }

  summary() {
    // F-11: refresh events are rendered and may be inspected by extensions.
    // Never publish private key material; the UI only needs public keys.
    const ord = {
      path: this.ord.path,
      address: this.ord.address,
      internalXonly: this.ord.internalXonly,
      ownerXonly: this.ord.ownerXonly,
      parity: this.ord.parity,
      legacyAddress: this.ord.legacyAddress,
      legacyOwnerXonly: this.ord.legacyOwnerXonly,
      legacyParity: this.ord.legacyParity,
    };
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
      receives: this.receives,
      mempool: this.mempool,
      ord,
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

  /** The BITCOIN tab is one fixed BIP84 address. It never rotates. */
  receiveAddress() {
    return this.keys.receive(0).address;
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
    // A confirmed coin needs exact sat ranges. An unconfirmed exact coin is
    // usable only when the user allows mempool funds; this same pool feeds
    // mint/travel/hop, so the opt-out is global.
    const spendUnconfirmed = this.settings.spendUnconfirmed !== false;
    return this.utxos.filter((u) => u.kind === 'p2wpkh' && u.exact
      && !(u.frogs && u.frogs.length) && (!u.unconfirmed || spendUnconfirmed));
  }

  /** SEND uses the same fail-closed funding pool as every other action.
   *  F-02: an empty ord/indexer answer is not proof that a coin carries no
   *  inscription, so an unknown-ranged mempool coin is not spendable. */
  _sendFunding() {
    return this._funding();
  }

  _frogUtxo(frog) {
    return this.utxos.find((u) => frog.location && u.txid === frog.location.txid && u.vout === frog.location.vout) || null;
  }

  _frogLegacyPath(frog) {
    return frog?.legacy_path === true;
  }

  _frogLegacyWire(frog) {
    return frog?.legacy_wire === true || isGrandfatheredSat(frog?.sat);
  }

  _frogOwner(frog) {
    return this._frogLegacyPath(frog)
      ? this.keys.legacyOrd.ownerXonly : this.keys.ord.ownerXonly;
  }

  _frogKeys(frog) {
    return this._frogLegacyPath(frog)
      ? { ...this.keys, ord: this.keys.legacyOrd }
      : this.keys;
  }

  _frogState(frog) {
    return stateScripts(frog, this._frogOwner(frog), { legacy: this._frogLegacyWire(frog) });
  }

  /** The derived tapscript address a Hopper pays while it is staged for
   *  gameplay. A mint or an ordinary-output Hopper has no state address yet;
   *  return null rather than showing a misleading destination. */
  stateAddress(frog) {
    if (!frog) return null;
    const utxo = this._frogUtxo(frog);
    if (!utxo || utxo.kind !== 'state') return null;
    if (utxo.address) return utxo.address;
    try {
      return scriptToAddress(this._frogState(frog).script, this.network);
    } catch { return null; }
  }

  _upsertPendingMint(pkg) {
    if (!pkg?.commitTxid) return null;
    const key = String(pkg.commitTxid).toLowerCase();
    const prior = (this.pendingMints || []).find((p) => p.commitTxid === key) || {};
    const row = { ...prior, ...pkg, commitTxid: key, updatedAt: new Date().toISOString() };
    this.pendingMints = [row, ...(this.pendingMints || []).filter((p) => p.commitTxid !== key)]
      .slice(0, 12);
    this._saveLedger();
    return row;
  }

  _dropPendingMint(commitTxid) {
    const key = String(commitTxid || '').toLowerCase();
    const before = (this.pendingMints || []).length;
    this.pendingMints = (this.pendingMints || []).filter((p) => p.commitTxid !== key);
    if (this.pendingMints.length !== before) this._saveLedger();
  }

  pendingMintPackages() {
    return (this.pendingMints || []).map((p) => ({ ...p }));
  }

  /** Re-broadcast a persisted commit/reveal pair. Replaying the same signed
   *  bytes is safe; repricing needs a fresh preview. */
  async retryPendingMint(commitTxid) {
    const key = String(commitTxid || '').toLowerCase();
    const pkg = (this.pendingMints || []).find((p) => p.commitTxid === key);
    if (!pkg) throw new Error('no pending mint package for that commit');
    if (!pkg.commitAccepted) {
      await this.backend.broadcast(pkg.commitHex);
      pkg.commitAccepted = true;
      this._upsertPendingMint(pkg);
    }
    try {
      await this.backend.broadcast(pkg.revealHex);
    } catch (e) {
      pkg.lastError = e.message || String(e);
      this._upsertPendingMint(pkg);
      throw e;
    }
    this._dropPendingMint(key);
    this._recordAction({
      kind: 'mint', sat: Number(pkg.sat), seed: pkg.seed, name: pkg.name,
      txid: pkg.revealTxid, commit: key, fee: null, recovered: true,
    });
    if (Number.isSafeInteger(Number(pkg.sat))) this.imported.add(Number(pkg.sat));
    await this.refresh().catch(() => {});
    return { commitTxid: key, revealTxid: pkg.revealTxid };
  }

  /** Refund an accepted commit whose reveal will never be replayed. */
  async refundPendingMint(commitTxid, { feeRate = null } = {}) {
    const key = String(commitTxid || '').toLowerCase();
    const pkg = (this.pendingMints || []).find((p) => p.commitTxid === key);
    if (!pkg) throw new Error('no pending mint package for that commit');
    if (!pkg.commitAccepted) throw new Error('the commit is not confirmed or accepted; retry it first');
    const commit = {
      txid: key,
      vout: Number(pkg.commitVout || 0),
      value: BigInt(pkg.commitValue),
      script: hexToBytes(pkg.commitScript),
      leaf: hexToBytes(pkg.leafHex),
    };
    const built = buildMintRefund({
      keys: this.keys, commit, recipientScript: this.keys.receive(0).script,
      feeRate: rateOr(feeRate ?? this.settings.feeRate),
    });
    await this.backend.broadcast(built.hex);
    this._dropPendingMint(key);
    this._recordAction({
      kind: 'mint-refund', txid: built.txid, commit: key, fee: built.fee,
      to: this.keys.receive(0).address,
    });
    await this.refresh().catch(() => {});
    return built;
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

  /** Build the commit/reveal pair and stop. This is the mint preview:
   *  building signs both transactions, but nothing is broadcast or recorded
   *  until broadcastPreview() is called. */
  async previewMint({ seed, name = '', feeRate = null, revealFeeRate = null } = {}) {
    await this._assertParams();
    await this.refresh();
    const rate = rateOr(feeRate ?? this.settings.feeRate);
    const revealRate = rateOr(revealFeeRate ?? rate);
    // The hint is the generation of the height the mint is expected to
    // confirm at. It is display-only; the indexer derives the real label
    // from the confirmed height.
    const genHint = generationAt((this.tipHeight || 0) + 2);
    const args = {
      utxos: this._funding(), seed, name, feeRate: rate, revealFeeRate: revealRate, genHint,
      protectedSats: [...this._protectedSats()],
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
    const destinationAmount = built.reveal.tx.outputs[0]?.value ?? 1000n;
    return {
      kind: 'mint',
      built,
      seed,
      name,
      mintName: name || 'UNNAMED',
      sat: Number(built.sat),
      to: this.keys.frogAddress(),
      destinationAddress: this.keys.frogAddress(),
      destinationAmount,
      amount: destinationAmount,
      amountNumber: Number(destinationAmount),
      changeAddress: built.commit.changeAddress,
      changeAmount: built.commit.changeValue,
      revealChangeAddress: built.reveal.changeAddress,
      revealChangeAmount: built.reveal.changeValue,
      feeRate: rate,
      revealFeeRate: revealRate,
      fee: built.fee,
      vsize: built.vsize,
      effectiveFeeRate: Number(built.fee) / Math.max(1, built.vsize),
      commitFee: built.commit.fee,
      revealFee: built.reveal.fee,
      commitVsize: built.commit.vsize,
      revealVsize: built.reveal.vsize,
      commitTxid: built.commit.txid,
      revealTxid: built.reveal.txid,
      inscriptionId: built.reveal.inscriptionId,
    };
  }

  /** Direct mint helper retained for non-UI callers. The UI uses
   *  previewMint() followed by broadcastPreview() so approval is explicit. */
  async mint({ seed, name = '', feeRate = null, revealFeeRate = null, onBroadcast = null } = {}) {
    const preview = await this.previewMint({ seed, name, feeRate, revealFeeRate });
    return this.broadcastPreview(preview, { onMintBroadcast: onBroadcast });
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
      keys: this._frogKeys(frog), utxo, frog, funding: this._funding(),
      feeRate: rateOr(feeRate ?? this.settings.feeRate),
      legacy: this._frogLegacyWire(frog),
      protectedSats: [...this._protectedSats()].filter((x) => Number(x) !== Number(frog.sat)),
    });
    await this.backend.broadcast(built.hex);
    this._recordAction({ kind: 'prepare', sat: frog.sat, txid: built.txid });
    // The state output is known now, before the indexer has confirmed it.
    this._rememberRecovery(frog, {
      txid: built.txid, vout: 0, value: built.stateValue, tipHeight: this.tipHeight,
    });
    await this.refresh();
    return built;
  }

  async cross(frog, { feeRate = null, newOwnerXonly = null, dir = 0 } = {}) {
    const preview = await this.previewCross(frog, { feeRate, newOwnerXonly, dir });
    return this.broadcastPreview(preview, { revalidate: false });
  }

  /** Build a HOP without broadcasting it (SPEC §3.6). The direction picks
   *  the leaf and is already baked into the signed body; approval can only
   *  broadcast these exact bytes. */
  async previewCross(frog, { feeRate = null, newOwnerXonly = null, dir = 0 } = {}) {
    await this._assertParams();
    await this.refresh();
    frog = this.frogBySat(frog.sat) || frog;
    if (frog.state !== 'idle') throw new Error(`the frog is ${frog.state}; only an idle frog can cross`);
    const utxo = this._frogUtxo(frog);
    if (!utxo || utxo.kind !== 'state') throw new Error('TRAVEL TO ROAD before crossing');
    const offset = anchorOffsetOf(utxo, frog.sat);
    if (offset != null && offset !== 0) {
      throw new Error('the frog sat is not first in this card; it cannot cross safely');
    }
    if (!Number.isInteger(dir) || dir < 0 || dir > 2) {
      throw new Error('choose LEFT, STRAIGHT or RIGHT before hopping');
    }
    const rate = rateOr(feeRate ?? this.settings.feeRate);
    const state = this._frogState(frog);
    const built = buildCross({
      keys: this._frogKeys(frog), stateUtxo: utxo, frog, funding: this._funding(),
      feeRate: rate, newOwnerXonly, dir, legacy: this._frogLegacyWire(frog),
      protectedSats: [...this._protectedSats()].filter((x) => Number(x) !== Number(frog.sat)),
    });
    const changeOut = built.changeIndex == null ? null : built.tx.outputs[built.changeIndex];
    return {
      kind: 'hop',
      built,
      dir,
      frogSat: Number(frog.sat),
      frogName: frog.name || '',
      gen: Number(frog.gen) || null,
      dist: Number(frog.dist) || 0,
      leafHex: bytesToHex(state.crossLeaves[dir]),
      to: scriptToAddress(built.stateScript, this.network),
      amount: built.tx.outputs[0].value,
      amountNumber: Number(built.tx.outputs[0].value),
      feeRate: rate,
      fee: built.fee,
      vsize: built.vsize,
      effectiveFeeRate: Number(built.fee) / Math.max(1, built.vsize),
      destinationAmount: built.tx.outputs[0].value,
      changeAddress: changeOut ? scriptToAddress(changeOut.script, this.network) : null,
      changeAmount: changeOut ? changeOut.value : 0n,
      newOwner: !!newOwnerXonly && !equalBytes(newOwnerXonly, this._frogOwner(frog)),
    };
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
    const spendUnconfirmed = this.settings.spendUnconfirmed !== false;
    const built = buildSend({
      keys: this.keys, utxos: this._sendFunding(), recipientScript: recipient.script,
      amount: BigInt(amountSats), feeRate: rate, allowUnconfirmed: spendUnconfirmed,
      protectedSats: [...this._protectedSats()],
    });
    const changeOut = built.changeIndex == null ? null : built.tx.outputs[built.changeIndex];
    const unconfirmedOutpoints = new Set(this.utxos
      .filter((u) => u.unconfirmed)
      .map((u) => `${u.txid}:${u.vout}`));
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
      usesUnconfirmed: built.inputs.some((i) => unconfirmedOutpoints.has(`${i.txid}:${i.vout}`)),
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
      keys: this._frogKeys(frog), utxo, frog, recipientScript: recipient.script, feeRate: rate,
      legacy: this._frogLegacyWire(frog),
      protectedSats: [...this._protectedSats()].filter((x) => Number(x) !== Number(frog.sat)),
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
      const inputScript = typeof input.script === 'string' ? hexToBytes(input.script) : input.script;
      if (live.script && inputScript && !equalBytes(live.script, inputScript)) {
        throw new Error('preview expired: an input script changed; cancel and preview again');
      }
      // F-08: every action that spends a funding coin must recheck the
      // complete asset/ranges classification, not only SEND and MINT.
      const isFrogInput = preview.kind === 'transfer'
        || (preview.kind === 'hop' && String(input.txid).toLowerCase()
          === String(preview?.built?.inputs?.[0]?.txid || '').toLowerCase()
          && Number(input.vout) === Number(preview?.built?.inputs?.[0]?.vout))
        || (preview.kind === 'mint' && preview?.built?.anchor
          && String(input.txid).toLowerCase() === String(preview.built.anchor.txid).toLowerCase()
          && Number(input.vout) === Number(preview.built.anchor.vout));
      if (!isFrogInput && live.kind !== 'p2wpkh') {
        throw new Error('preview expired: a funding input is no longer plain BTC; cancel and preview again');
      }
      if (!isFrogInput) {
        const spendUnconfirmed = this.settings.spendUnconfirmed !== false;
        const knownRanges = Array.isArray(live.ranges) && live.ranges.length
          && live.exact !== false && live.spendable !== false;
        const fundingOk = live.kind === 'p2wpkh'
          && !(live.frogs && live.frogs.length)
          && knownRanges
          && (!live.unconfirmed || spendUnconfirmed);
        if (!fundingOk) {
          throw new Error('preview expired: a funding coin now carries unknown ranges or a Hopper; cancel and preview again');
        }
      }
    }
    // Re-run the FIFO assignment over the live ranges and the exact signed
    // outputs. Input classification alone is not enough: a range change can
    // move the frog into a fee output without changing any outpoint.
    const liveInputs = inputs.map((input) => {
      const live = (this.utxos || []).find((u) => u.txid === input.txid
        && Number(u.vout) === Number(input.vout));
      return live;
    });
    if (preview.kind === 'send') {
      proveAssignment({
        inputs: liveInputs,
        outputValues: preview.built.tx.outputs.map((o) => Number(o.value)),
        protectedSats: [...this._protectedSats()],
        label: 'send revalidation',
      });
    } else if (preview.kind === 'transfer' || preview.kind === 'hop') {
      proveAssignment({
        inputs: liveInputs,
        outputValues: preview.built.tx.outputs.map((o) => Number(o.value)),
        sat: preview.frogSat,
        outputIndex: 0,
        protectedSats: [...this._protectedSats()].filter((x) => Number(x) !== Number(preview.frogSat)),
        label: `${preview.kind} revalidation`,
      });
    } else if (preview.kind === 'mint') {
      proveAssignment({
        inputs: liveInputs,
        outputValues: preview.built.commit.tx.outputs.map((o) => Number(o.value)),
        sat: Number(preview.built.sat),
        outputIndex: 0,
        protectedSats: [...this._protectedSats()].filter((x) => Number(x) !== Number(preview.built.sat)),
        label: 'mint commit revalidation',
      });
    }
    if (preview.kind === 'mint') {
      const anchor = preview.built.anchor;
      const anchorTxid = String(anchor?.txid || '').toLowerCase();
      const liveAnchor = (this.utxos || []).find((u) => String(u.txid).toLowerCase() === anchorTxid
        && Number(u.vout) === Number(anchor?.vout));
      if (!liveAnchor) {
        throw new Error('preview expired: the anchor coin has already been spent; cancel and preview again');
      }
      if (!sameRanges(liveAnchor.ranges, anchor.ranges)) {
        throw new Error('preview expired: the anchor coin ordinal ranges changed; cancel and preview again');
      }
      if (!preview.built.inputs?.some((i) => String(i.txid).toLowerCase() === anchorTxid
        && Number(i.vout) === Number(anchor.vout))) {
        throw new Error('preview expired: the mint inputs changed; cancel and preview again');
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
    if (preview.kind === 'hop') {
      const frog = this.frogBySat(preview.frogSat);
      if (!frog) throw new Error('preview expired: the Hopper is no longer in this wallet');
      if (frog.state !== 'idle') throw new Error('preview expired: the Hopper is no longer idle; cancel and preview again');
      const utxo = this._frogUtxo(frog);
      if (!utxo || utxo.kind !== 'state'
          || !inputs.some((i) => i.txid === utxo.txid && Number(i.vout) === Number(utxo.vout))) {
        throw new Error('preview expired: the Hopper output changed; cancel and preview again');
      }
    }
  }

  /** Approve a preview: revalidate state, then broadcast exactly once.
   *  There is no broadcast call anywhere in previewMint/previewSend/
   *  previewTransfer. A mint is the one preview that approves two chained
   *  transactions: the commit, then the reveal that spends it. */
  async broadcastPreview(preview, { revalidate = true, onMintBroadcast = null } = {}) {
    const mint = preview?.kind === 'mint';
    if (mint) {
      if (!preview?.built?.commit?.hex || !preview?.built?.reveal?.hex) {
        throw new Error('no mint preview to broadcast');
      }
    } else if (!preview?.built?.hex || !preview?.built?.tx) {
      throw new Error('no transaction preview to broadcast');
    }
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
    } else if (preview.kind === 'mint') {
      const built = preview.built;
      // F-04: write the recoverable package before the commit can leave
      // the wallet. A reload, crash, or rejected reveal now has durable
      // bytes and recovery instructions.
      const pkg = {
        commitTxid: String(built.commit.txid).toLowerCase(),
        commitHex: built.commit.hex,
        commitVout: 0,
        commitValue: Number(built.commit.tx.outputs[0]?.value ?? 0),
        commitScript: bytesToHex(built.commit.tx.outputs[0]?.script || new Uint8Array()),
        revealTxid: String(built.reveal.txid).toLowerCase(),
        revealHex: built.reveal.hex,
        leafHex: bytesToHex(built.reveal.tapscript),
        sat: Number(built.sat),
        seed: preview.seed,
        name: preview.name,
        createdAt: new Date().toISOString(),
        commitAccepted: false,
      };
      this._upsertPendingMint(pkg);
      try {
        await this.backend.broadcast(built.commit.hex);
      } catch (e) {
        pkg.lastError = e.message || String(e);
        this._upsertPendingMint(pkg);
        throw e;
      }
      pkg.commitAccepted = true;
      this._upsertPendingMint(pkg);
      try {
        await this.backend.broadcast(built.reveal.hex);
      } catch (e) {
        pkg.lastError = e.message || String(e);
        this._upsertPendingMint(pkg);
        const err = new Error(`commit ${String(built.commit.txid).slice(0, 12)}… was accepted, but the reveal was rejected: ${e.message || String(e)}`);
        err.commitBroadcast = true;
        err.commitTxid = built.commit.txid;
        err.recoverable = true;
        throw err;
      }
      this._dropPendingMint(pkg.commitTxid);
      // The reveal is the mint. Tell the UI immediately so its seed draft can
      // rotate even if the post-broadcast refresh (below) fails.
      if (onMintBroadcast) {
        try { onMintBroadcast(built); } catch (e) {
          console.warn('mint broadcast callback failed', e.message || String(e));
        }
      }
      this._recordAction({
        kind: 'mint', sat: built.sat, seed: preview.seed, name: preview.name,
        txid: built.reveal.txid, commit: built.commit.txid,
        inscriptionId: built.reveal.inscriptionId,
        fee: Number(built.fee), vsize: built.vsize,
      });
      this.imported.add(Number(built.sat));
    } else if (preview.kind === 'transfer') {
      await this.backend.broadcast(preview.built.hex);
      this._recordAction({
        kind: 'transfer', sat: preview.frogSat, txid: preview.built.txid, to: preview.to,
      });
      this.imported.delete(Number(preview.frogSat));
    } else if (preview.kind === 'hop') {
      await this.backend.broadcast(preview.built.hex);
      this._recordAction({
        kind: 'cross', sat: preview.frogSat, txid: preview.built.txid, dir: preview.dir,
        settled: false, at: new Date().toISOString(),
      });
      // Record the new state output immediately. If the Hopper was sent to a
      // different owner, the output is no longer ours and our last pack is
      // left untouched.
      if (!preview.newOwner) {
        const frog = this.frogBySat(preview.frogSat);
        if (frog) {
          this._rememberRecovery(frog, {
            txid: preview.built.txid, vout: 0, value: CARD_VALUE, tipHeight: this.tipHeight,
          });
        }
      }
      // Custody now belongs to the optional new P2TR owner. Stop carrying
      // the sat as an owned candidate when that owner is not this wallet.
      if (preview.newOwner) this.imported.delete(Number(preview.frogSat));
    } else {
      throw new Error(`unknown transaction preview kind: ${preview.kind}`);
    }
    try { await this.refresh(); } catch (e) {
      console.warn('transaction broadcast, but the refresh failed', e.message || String(e));
    }
    return preview.built;
  }

  /** F-03 migration: move a frog found on the released odd-Y derivation to
   *  the current BIP86 address. It is an explicit user action; recovery
   *  never rewrites the old path in place. */
  async migrateLegacyFrog(frog, to = this.keys.frogAddress()) {
    const current = this.frogBySat(frog?.sat) || frog;
    if (!current || current.legacy_path !== true) {
      throw new Error('this Hopper is not on the legacy derivation path');
    }
    return this.previewTransfer(current, to);
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

  /** A HOP that we broadcast but the indexer has not shown yet. The
   *  transaction is already public; waiting for an indexer would leave the
   *  Hopper sitting in the pond's direction picker until a block (or a
   *  remote refresh) arrives. Keep this local row only while the frog is
   *  still idle and the action is recent; a real crossing/settlement record
   *  supersedes it. */
  _localRoadEntries() {
    const tip = Number(this.tipHeight) || 0;
    const rows = [];
    for (const a of this.actions || []) {
      if (String(a?.kind || '').toLowerCase() !== 'cross') continue;
      const sat = Number(a.sat);
      if (!Number.isSafeInteger(sat)) continue;
      const f = this.frogBySat?.(sat);
      if (!f || String(f.state || 'idle') !== 'idle') continue;
      // A chain replay marks the crossing settled once T+6 has passed. The
      // action stays in History, but the frog is back on the bank and the
      // direction picker/HOP button must be available again.
      if (a.settled === true) continue;
      const txid = String(a.txid || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid)) continue;
      const at = Number(a.height);
      if (Number.isFinite(at) && at >= 0 && tip - at > 144) continue;
      // The demo chain has no state-address replay to mark the action
      // settled. Its six-block settlement is deterministic, so release the
      // frog once that height is reached. Live mode relies on the replay so
      // an unverifiable backend failure never claims a settlement.
      if (this.settings?.mode === 'demo' && Number.isFinite(at) && at + 6 <= tip) continue;
      const crossHeight = Number.isFinite(at) && at >= 0 ? at : tip;
      rows.push({
        sat,
        seed: f.seed,
        name: f.name,
        dist: f.dist,
        gen: f.gen,
        local: true,
        inFlight: {
          txid,
          // No inclusion height yet. roadEntry says "in mempool" rather
          // than inventing a six-block countdown.
          height: null,
          target_hops: requiredAt(crossHeight + 1),
          dir: Number(a.dir),
          settle_height: null,
          local: true,
        },
        provisionalDead: null,
        outcomeBlockHash: null,
      });
    }
    return rows;
  }

  async road() {
    if (!this.backend) await this.connect();
    const data = await this.backend.road().catch(() => ({ active: [] }));
    const remote = (data.active || []).map((c) => ({
      sat: c.frogger_sat ?? c.sat,
      seed: c.seed, name: c.name, dist: c.dist,
      gen: c.gen,
      inFlight: c.in_flight ?? {
        txid: c.txid, height: c.cross_height, target_hops: c.target_hops,
        dir: c.dir, settle_height: (c.cross_height ?? 0) + 6,
      },
      provisionalDead: c.provisional_dead ?? null,
      outcomeBlockHash: c.outcome_block_hash ?? null,
    }));
    const seen = new Set(remote.map((c) => Number(c.sat)));
    for (const c of this._localRoadEntries()) {
      if (!seen.has(Number(c.sat))) { remote.push(c); seen.add(Number(c.sat)); }
    }
    // A restored browser may know the crossing only from the state-address
    // replay. Keep that road row alive without asking the indexer again.
    for (const f of this.frogs || []) {
      const sat = Number(f?.sat);
      if (!Number.isSafeInteger(sat) || seen.has(sat) || !f.in_flight) continue;
      const inf = f.in_flight;
      const measured = Number.isFinite(Number(inf.height)) && Number(inf.height) > 0;
      remote.push({
        sat, seed: f.seed, name: f.name, dist: f.dist, gen: f.gen,
        inFlight: {
          txid: inf.txid, height: inf.height,
          target_hops: inf.target_hops, dir: inf.dir,
          settle_height: inf.settle_height ?? (measured ? Number(inf.height) + 6 : null),
        },
        provisionalDead: f.provisional_dead ?? null,
        outcomeBlockHash: f.outcome_block_hash ?? null,
      });
    }
    return remote;
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
    return { change: wallet.keys.change(0), receive: wallet.keys.receive(0) };
  }
}

export { CARD_VALUE, GENESIS, generationAt, requiredAt, scriptToAddress, bytesToHex, reverseBytes, hexToBytes };
