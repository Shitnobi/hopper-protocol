// Screen templates — a JavaScript reimplementation of the FROGGER egui GUI
// (frogger-wallet-gui/src/app.rs). Pure string builders; main.js owns events
// and theme.js owns the painted materials.
//
// Screen map (same names in the drawer as the egui app):
//   WALLET · HISTORY · THE POND · THE ROAD · MINT · LEADERBOARD
//   DETAIL (one hopper) · BIO (one hopper's life story) · SETTINGS

import {
  btc, esc, frogImg, pips, sats, seedText, targetOf,
} from './dom.js';
import {
  completionBps, generationAt, hopDeathBps, MAX_TARGET, nextIncrement, paramsHashHex, requiredAt,
} from '../core/params.js';
import { canBumpSend } from '../wallet/rbf.js';
import { stateScripts } from '../wallet/actions.js';
import {
  FEE_SOURCE, feeRateLabel, feeRecommendations, usableFeeRate,
} from '../wallet/fees.js';
import { deriveTraits } from '../core/art.js';
import {
  C, RARITY_NAMES, frogMarkSvg, pondMarkSvg, rarityColor,
} from './theme.js';

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

const SPRITE_STATE = (f) => {
  const s = String(f?.state || 'idle');
  if (s === 'crossing' || s === 'home' || s === 'dead') return s;
  return 'idle';
};

function rarityIndex(f) {
  if (f && Number.isInteger(f.rarity) && f.rarity >= 0 && f.rarity < 4) return f.rarity;
  return deriveTraits(Number(f?.seed) >>> 0).rarity;
}

function rarityOf(f) {
  return RARITY_NAMES[rarityIndex(f)];
}

function rarityClass(f) {
  return `rarity-${String(rarityOf(f)).toLowerCase()}`;
}

/**
 * The honest state of the soundtrack, for the drawer and Settings. A
 * silent app should be able to say why: muted, volume at zero, waiting
 * for the browser's first gesture, a suspended context, a score that
 * failed to load, or actually playing.
 */
export function soundLine(app) {
  const s = app?.sound?.status?.();
  if (!s) return '♪ no player';
  if (s.mute) return '♪ MUTED — tap SOUND: ON';
  if (s.volume <= 0) return '♪ VOLUME 0% — raise the fader';
  if (!s.armed) return '♪ TAP ONCE TO START (browser policy)';
  if (s.error) return `♪ ${s.error}`;
  if (s.state === 'none') return '♪ NO AUDIO CONTEXT IN THIS BROWSER';
  if (s.state !== 'running') return `♪ ${String(s.state).toUpperCase()} — TAP TO RETRY`;
  if (!s.notes) return '♪ LOADING THE SCORE…';
  if (!s.timer) return `♪ READY · ${s.notes} NOTES`;
  return `♪ PLAYING · ${s.notes} NOTES`;
}

function chip(text, tone = 'dim') {
  return `<span class="chip-ui ${esc(tone)}">${esc(text)}</span>`;
}

const LIFE = {
  idle: ['IDLE', 'dim'],
  crossing: ['HOPPING', 'accent'],
  home: ['HOME 👑', 'home'],
  dead: ['DEAD 💀', 'dead'],
  burned: ['LOST TO FEES', 'dead'],
  retired: ['RETIRED', 'dim'],
  sent: ['SENT ↗', 'dim'],
  away: ['NOT HERE ✈', 'dim'],
  syncing: ['SYNCING…', 'dim'],
};

function lifeChip(state) {
  const [label, tone] = LIFE[String(state || 'idle')] || [String(state || '').toUpperCase(), 'dim'];
  return chip(label, tone);
}


function logBtn(label, action, { edge = 'dim', cls = '', attrs = '' } = {}) {
  return `<button class="btn ${cls}" data-action="${esc(action)}" data-edge="${esc(edge)}" ${attrs}>${label}</button>`;
}

function shortName(name, max = 22) {
  const s = String(name || 'UNNAMED');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function truncTxid(txid) {
  if (!txid) return '—';
  return txid.length > 22 ? `${txid.slice(0, 10)}…${txid.slice(-6)}` : txid;
}

/** A shortened identifier that copies its full value on tap/click. */
function copyButton(value, shown, label, copyLabel) {
  const text = String(value || '');
  if (!text) return esc(shown || '—');
  return `<button type="button" class="tx-copy" data-action="copy" data-text="${esc(text)}" data-copy-label="${esc(copyLabel)}" title="${esc(label)}" aria-label="${esc(label)} ${esc(shown)}">${esc(shown)}</button>`;
}

function heading(text) {
  return `<div class="page-head">${text}</div>`;
}

function backButton(action = 'back') {
  return logBtn('◀ Back', action, { edge: 'dim', cls: 'small' });
}

// ---------------------------------------------------------------------------
// Top bar and drawer
// ---------------------------------------------------------------------------

export function topbar(app) {
  return `
  <header class="topbar">
    <div class="brand">${frogMarkSvg(24)}<span class="word">HOPPER</span></div>
    <div class="spacer"></div>
    ${logBtn(app.menuOpen ? '✖' : '☰', 'drawer', { edge: 'dim', cls: 'icon', attrs: 'aria-label="menu"' })}
  </header>`;
}

export function drawer(app) {
  const w = app.w;
  const item = (view, label) => `
    <button data-action="nav" data-view="${view}" class="${app.view === view ? 'active' : ''}">${label}</button>`;
  return `
    <div class="drawer-kicker">HOPPER</div>
    <div class="nav">
      ${item('wallet', '💰 WALLET')}
      ${item('history', '📜 HISTORY')}
      ${item('pond', `${pondMarkSvg(14)}<span>THE POND</span>`)}
      ${item('road', '🚦 THE ROAD')}
      ${item('mint', '✨ MINT')}
      ${item('leaders', '🏆 LEADERBOARD')}
      <button data-action="open-rules">📖 READ THE RULES</button>
      ${item('settings', '⚙ SETTINGS')}
    </div>
    <div class="slider-row"><span>VOLUME</span><span data-volume-pct>${Math.round((w?.settings?.volume ?? app.settings.volume) * 100)}%</span></div>
    <div class="track" data-volume-track>
      <div class="fill" data-volume-fill style="width:${Math.round((w?.settings?.volume ?? app.settings.volume) * 100)}%"></div>
      <div class="thumb" data-volume-thumb style="left:calc(${Math.round((w?.settings?.volume ?? app.settings.volume) * 100)}% - 3px)"></div>
    </div>
    <div class="sound-line" data-sound-line>${esc(soundLine(app))}</div>
    <div class="stack mt10">
      ${logBtn(w?.settings?.mute ? 'SOUND: MUTED' : 'SOUND: ON', 'menu-mute', { edge: w?.settings?.mute ? 'dim' : 'accent', cls: 'small block' })}
      ${w ? logBtn('🔒 LOCK WALLET', 'lock', { edge: 'dim', cls: 'small block' }) : ''}
    </div>
    <div class="foot">
      <div>HOPPER metaprotocol</div>
      <div>roadkill is forever</div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export function wallet(app) {
  const w = app.w;
  const b = w.balance || { spendable: 0n, unspendable: 0n };
  const syncing = w.tipHeight == null && !w.frogs.length;
  if (syncing) {
    return `
      ${heading('💰 Wallet')}
      <div class="mt18 muted">Syncing the wallet…</div>
      <div class="mt10 small" style="color:var(--car)">The chain source has not answered yet. Settings can change the endpoint.</div>
      <div class="mt10">${logBtn('TRY AGAIN', 'refresh', { edge: 'dim', cls: 'small' })}</div>`;
  }

  const alive = (w.frogs || []).filter((f) => f.state !== 'dead');
  const spendable = b.spendable ?? 0n;
  return `
    <div class="wallet-page">
    <div class="balance">
      <div class="kicker">SPENDABLE BALANCE</div>
      <div class="total">${sats(spendable)} <small>sats</small></div>
      <div class="usd">≈ —</div>
      <div class="meta">= ${btc(spendable)} BTC · ${esc(w.network)}</div>
    </div>

    ${Number(b.pending) > 0 ? `
      <div class="notice-bar mempool-bar">◌ ${sats(b.pending)} sats in mempool — waiting for confirmation.</div>` : ''}

    ${Number(b.unspendable) > 0 ? `
      <div class="notice-bar">⚠ ${sats(b.unspendable)} sats of this balance have no known sat ranges yet — they are counted here but cannot be spent until an ord server (or an indexer) names their sats.</div>` : ''}

    <div class="mt14 action-row">
      ${logBtn('📤 SEND', 'sheet-send', { edge: 'accent', cls: 'send' })}
      ${logBtn('QR', 'qr', { edge: 'dim', cls: 'qr' })}
      ${logBtn('📥 RECEIVE', 'sheet-receive', { edge: 'home', cls: 'receive' })}
    </div>

    ${alive.length ? `
    <div class="send-pond-wrap">
      <button class="send-pond" type="button" data-action="nav" data-view="pond" data-send-pond>
        <canvas class="send-pond-art" data-send-pond-art width="240" height="240" aria-hidden="true"></canvas>
        <span class="send-pond-label">SEND HOPPERS FROM THE POND</span>
      </button>
      ${app.frogRefusal ? `<div class="refusal">${esc(app.frogRefusal)}</div>` : ''}
    </div>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// The Pond
// ---------------------------------------------------------------------------

export function pond(app) {
  const w = app.w;
  const frogs = (w.frogs || []).filter((f) => f.state !== 'dead');
  const empty = `
    <div class="empty-pond">
      <canvas class="lily" data-empty-lily width="160" height="130"></canvas>
      <div class="line">Your pond is empty…</div>
      ${logBtn('✨ Mint your first Hopper', 'nav', { edge: 'accent', cls: 'small', attrs: 'data-view="mint"' })}
    </div>`;
  return `
    <div class="pond-page">
      <canvas class="pond-water" data-pond-water></canvas>
      <div class="pond-content">
        ${heading('The Pond')}
        ${app.frogRefusal ? `<div class="refusal">${esc(app.frogRefusal)}</div>` : ''}
        ${frogs.length ? `<div class="pond-grid">${frogs.map((f) => pondItem(app, f, { mode: 'pond' })).join('')}</div>` : empty}
      </div>
      <div class="pond-road" data-action="dead-frogs" role="button" aria-label="dead hoppers">
        <canvas class="grave-art" data-grave width="45" height="56"></canvas>
      </div>
    </div>`;
}

function pondItem(app, f, { mode } = {}) {
  const state = SPRITE_STATE(f);
  const crossing = f.state === 'crossing';
  const pending = !!f.commit_pending;
  const gen = Number(f.gen) || generationAt(f.mint_height ?? (app.w?.tipHeight || 0));
  const displayName = state === 'dead' ? `RIP ${f.name || 'UNNAMED'}` : (f.name || 'UNNAMED');
  const name = esc(displayName);
  let action = '';
  if (pending) {
    action = '<span class="tiny muted">✏ INSCRIBING</span>';
  } else if (crossing && mode !== 'road') {
    action = logBtn('🚫 ON ROAD', 'on-road', { edge: 'dim', cls: 'small' });
  } else if (mode === 'road') {
    // A minted Hopper still sits in its mint output and must be staged in
    // the 25,000-sat tapscript state output before a crossing can be signed.
    const utxo = app.w._frogUtxo?.(f);
    action = utxo?.kind === 'state'
      ? logBtn('🚦 HOP', 'sheet-cross', { edge: 'accent', cls: 'small', attrs: `data-sat="${f.sat}"` })
      : logBtn('TRAVEL TO ROAD', 'travel-to-road', { edge: 'accent', cls: 'small', attrs: `data-sat="${f.sat}"` });
  } else if (mode === 'wallet' || mode === 'pond') {
    const utxo = app.w._frogUtxo?.(f);
    action = logBtn('SEND', 'sheet-transfer', { edge: 'accent', cls: 'small', attrs: `data-sat="${f.sat}"` });
    if (utxo && f.state === 'idle') {
      action += logBtn('TRAVEL TO ROAD', 'travel-to-road', { edge: 'dim', cls: 'small', attrs: `data-sat="${f.sat}"` });
    }
  }
  const sub = pending
    ? '<span class="tiny muted">✏ INSCRIBING</span>'
    : mode === 'pond'
      ? `<span style="color:${rarityColor(rarityOf(f))}">${esc(rarityOf(f))}</span> · G${gen}`
      : mode === 'road'
        ? `G${gen} · <span class="tiny muted">inscribed on Bitcoin</span>`
        : '';
  return `
    <div class="pond-item">
      <div class="pond-tap" data-action="open-frog" data-sat="${f.sat}">
        <canvas class="pond-art" data-pondfrog="${f.seed >>> 0}:${state}" width="320" height="275"></canvas>
        <span class="pf-name">${name}</span>
        <span class="pf-sub">${sub}</span>
      </div>
      ${action ? `<div class="pf-actions">${action}</div>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// The Road
// ---------------------------------------------------------------------------

export function road(app) {
  const w = app.w;
  const idle = (w.frogs || []).filter((f) => f.state === 'idle');
  const inFlight = app.road || [];
  const demo = app.settings.mode === 'demo';
  return `
    ${heading('🚦 The Road')}
    <div class="sub">Crossings in flight. Sealed phases — nobody can see the outcome early.</div>

    ${idle.length ? `
      <div class="water-box">
        <canvas class="pond-water" data-pond-water></canvas>
        <div class="box-title">Choose a direction</div>
        <div class="pond-grid">
          ${idle.map((f) => pondItem(app, f, { mode: 'road' })).join('')}
        </div>
      </div>` : ''}

    ${inFlight.length
      ? `<div class="pond-grid" style="margin-top:12px">${inFlight.map((c) => roadEntry(app, c)).join('')}</div>`
      : `<div class="quiet-road"><div class="lane">The road is quiet tonight 🌙</div></div>`}

    ${demo ? `
      <div class="actions mt10">
        ${logBtn('MINE 1', 'mine', { edge: 'dim', cls: 'small', attrs: 'data-n="1"' })}
        ${logBtn('MINE 6', 'mine', { edge: 'dim', cls: 'small', attrs: 'data-n="6"' })}
      </div>` : ''}

    <div class="mt18">
      <div style="font-weight:700">📜 ROAD LOG</div>
      <div class="sub">Every trip and every death, newest at the top.</div>
      ${roadLog(app)}
    </div>`;
}

function roadEntry(app, c) {
  const tip = app.w.tipHeight || 0;
  const settle = c.inFlight?.settle_height ?? ((c.inFlight?.height ?? tip) + 6);
  const blocks = Math.max(0, settle - tip);
  const f = app.w.frogBySat(c.sat);
  const seed = c.seed ?? f?.seed ?? 0;
  const name = c.name || f?.name || 'UNNAMED';
  const tone = c.provisionalDead == null ? 'accent' : c.provisionalDead ? 'dead' : 'home';
  const label = c.provisionalDead == null ? 'ON THE ROAD' : c.provisionalDead ? 'DEAD SEALED' : 'ALIVE SEALED';
  const target = c.inFlight?.target_hops ?? (f ? targetOf(f, tip) : requiredAt(tip + 1));
  return `
    <div class="pond-item road-entry">
      <div class="pond-tap road-no-tap">
        <canvas class="pond-art" data-roadfrog="${seed >>> 0}" width="320" height="275"></canvas>
        <span class="pf-name">${esc(name)}</span>
        <span class="pf-sub">G${Number(c.gen) || generationAt(f?.mint_height ?? tip)} · ${pips(c.dist, target)}</span>
        <span class="pf-sub" style="display:flex;justify-content:center;gap:6px;align-items:center;margin-top:2px">
          ${chip(label, tone)}
          <span class="tiny muted">${blocks ? `⬛ ${blocks}` : 'settling…'}</span>
        </span>
      </div>
    </div>`;
}

function roadLog(app) {
  const rows = historyRows(app.w)
    .filter((r) => r.kind === 'cross' || r.kind === 'settle')
    .slice(0, 40);
  if (!rows.length) return `<div class="sub mt6">No road trips yet — send a Hopper out.</div>`;
  return rows.map((r) => {
    const name = frogName(app.w, r.sat);
    const dead = r.kind === 'settle' && String(r.outcome || '').toLowerCase() === 'dead';
    const crossed = r.kind === 'settle' && !dead;
    const icon = dead
      ? '<canvas data-squished width="36" height="26" style="width:36px;height:26px"></canvas>'
      : frogImg(r.seed ?? frogSeed(app.w, r.sat), crossed ? 'home' : 'crossing', 'sprite', name);
    const label = dead
      ? `<span style="color:#d98a80">💀 ${esc(name)} died</span>`
      : crossed
        ? `<span>${esc(name)} came home</span>`
        : `<span>${esc(name)} hops on</span>`;
    return `
      <div class="card-row" data-action="bio" data-sat="${r.sat ?? ''}" style="cursor:pointer">
        <div class="row">
          <span class="tiny muted" style="min-width:52px">⬛ ${r.height ?? '—'}</span>
          <span style="width:36px;display:grid;place-items:center">${icon}</span>
          <span style="font-weight:700">${label}</span>
        </div>
      </div>`;
  }).join('');
}

function frogName(w, sat) {
  const f = w.frogBySat?.(sat);
  if (f?.name) return f.name;
  // A dead/burned frog leaves the owned set; its mint event still names it.
  for (const e of w.history || []) {
    if (Number(e.payload?.frogger_sat) === Number(sat) && e.payload?.name) return e.payload.name;
  }
  for (const a of w.actions || []) {
    if (Number(a.sat) === Number(sat) && a.name) return a.name;
  }
  return `SAT ${sats(sat)}`;
}

function frogSeed(w, sat) {
  const f = w.frogBySat?.(sat);
  if (f?.seed != null) return f.seed;
  for (const e of w.history || []) {
    if (Number(e.payload?.frogger_sat) === Number(sat) && e.payload?.seed != null) return e.payload.seed;
  }
  for (const a of w.actions || []) {
    if (Number(a.sat) === Number(sat) && a.seed != null) return a.seed;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export function history(app) {
  const rows = historyRows(app.w).slice(0, 80);
  return `
    ${heading('📜 History')}
    <div class="sub">Every wallet transaction — sends, receives, change, mints and road actions. Newest first. Faded rows with an IN MEMPOOL label are not confirmed yet.</div>
    <div class="mt14">
      ${rows.length ? rows.map((r) => txRow(app, r)).join('') : '<div class="sub">No transactions yet — they appear here as you use the wallet.</div>'}
    </div>`;
}

function historyRows(w) {
  const rows = [];
  const pending = new Set((w.pending || []).map((p) => p.txid).filter(Boolean));
  // `Number(null)` is 0; a missing sat must never become sat 0.
  const satNumber = (v) => (v == null || v === '' ? NaN : Number(v));
  // A restored arrival can predate the `sat` field on the receive ledger.
  // Recover it from the frog record by mint or current-location txid so the
  // arrival can still join the mint that produced it.
  const frogByTx = new Map();
  const frogBySat = new Map();
  // A sat learned anywhere is evidence for every row naming the same tx.
  // This is what repairs older action rows whose `sat` was never stored:
  // the arrival still knows the minted sat and the action names its txids.
  const txSat = new Map();
  const noteSat = (sat, ...txids) => {
    const n = satNumber(sat);
    if (!Number.isSafeInteger(n)) return;
    for (const v of txids) {
      const tx = String(v || '').toLowerCase();
      if (/^[0-9a-f]{64}$/.test(tx) && !txSat.has(tx)) txSat.set(tx, n);
    }
  };
  const mintSatFor = (sat, ...txids) => {
    const n = satNumber(sat);
    if (Number.isSafeInteger(n)) return n;
    for (const v of txids) {
      const tx = String(v || '').toLowerCase();
      const known = txSat.get(tx);
      if (Number.isSafeInteger(known)) return known;
    }
    return null;
  };
  for (const f of w.frogs || []) {
    const sat = satNumber(f?.sat);
    if (!Number.isSafeInteger(sat)) continue;
    if (!frogBySat.has(sat)) frogBySat.set(sat, f);
    for (const v of [f?.mint_txid, f?.location?.txid, f?.txid]) {
      const tx = String(v || '').toLowerCase();
      if (/^[0-9a-f]{64}$/.test(tx) && !frogByTx.has(tx)) frogByTx.set(tx, sat);
    }
    noteSat(sat, f?.mint_txid, f?.location?.txid, f?.txid);
  }
  for (const a of w.actions || []) {
    if (String(a?.kind || '').toLowerCase() === 'mint') noteSat(a.sat, a.txid, a.commit);
  }
  for (const m of w.chainMints || []) noteSat(m.sat, m.txid, m.commit);
  for (const r of w.receives || []) noteSat(r.sat, r.txid);
  for (const e of w.history || []) {
    const n = satNumber(e.payload?.frogger_sat ?? e.payload?.sat);
    const sat = mintSatFor(n, e.txid);
    if (Number.isSafeInteger(sat)) noteSat(sat, e.txid);
    rows.push({
      kind: String(e.kind || e.action || 'chain').toLowerCase(),
      height: e.height ?? null,
      txid: e.txid || null,
      sat,
      seed: e.payload?.seed,
      name: e.payload?.name,
      outcome: e.payload?.outcome ?? null,
      at: null,
      chain: true,
      pending: false,
      fee: null,
      bumps: 0,
      bumpable: false,
    });
  }
  for (const r of w.receives || []) {
    if (!r?.txid) continue;
    const tx = String(r.txid).toLowerCase();
    const knownSat = satNumber(r.sat);
    rows.push({
      kind: 'receive',
      height: r.height ?? null,
      txid: r.txid,
      sat: Number.isSafeInteger(knownSat) ? knownSat : (frogByTx.get(tx) ?? null),
      seed: r.seed,
      name: r.name,
      amount: r.amount,
      address: r.address,
      at: r.at,
      chain: true,
      pending: false,
      confirmed: r.confirmed !== false,
      frog: !!r.frog,
      fee: null,
      bumps: 0,
      bumpable: false,
      outcome: null,
    });
  }
  for (const c of w.changes || []) {
    if (!c?.txid) continue;
    rows.push({
      kind: 'change',
      height: c.height ?? null,
      txid: c.txid,
      sat: null,
      seed: undefined,
      name: undefined,
      amount: c.amount,
      address: c.address,
      at: c.at,
      mintSat: c.mintSat ?? null,
      // The reveal that owns this change. Persisted by `_tagChanges` as soon
      // as the wallet learns the commit/reveal pair, so a restored ledger can
      // still place the change beside its MINT without another lookup.
      mintTxid: c.mintTxid ?? null,
      chain: true,
      pending: false,
      confirmed: c.confirmed !== false,
      fee: null,
      bumps: 0,
      bumpable: false,
      outcome: null,
    });
  }
  for (const a of w.actions || []) {
    const isPending = pending.has(a.txid);
    rows.push({
      kind: String(a.kind || 'action').toLowerCase(),
      height: a.height ?? null,
      txid: a.txid || null,
      sat: String(a.kind || '').toLowerCase() === 'mint'
        ? mintSatFor(a.sat, a.txid, a.commit) : (a.sat ?? null),
      seed: a.seed,
      name: a.name,
      amount: a.amount,
      to: a.to,
      commit: a.commit || null,
      at: a.at,
      chain: false,
      outcome: null,
      pending: isPending,
      fee: a.fee,
      bumps: Number(a.bumps || 0),
      bumpable: canBumpSend(a, isPending),
    });
  }
  // A mint seen on-chain is independent of this browser's local action
  // ledger. The MINT row must survive a seed restore and appear beside the
  // HOPPER ARRIVED row. Rows already supplied by an event/action win the
  // dedupe below.
  for (const m of w.chainMints || []) {
    if (!m?.txid) continue;
    rows.push({
      kind: 'mint',
      height: m.height ?? null,
      txid: m.txid,
      sat: mintSatFor(m.sat, m.txid, m.commit),
      seed: m.seed,
      name: m.name,
      amount: undefined,
      commit: m.commit || null,
      at: m.at,
      chain: true,
      synthetic: true,
      pending: false,
      confirmed: true,
      fee: null,
      bumps: 0,
      bumpable: false,
      outcome: null,
    });
  }
  // Unconfirmed outputs were already in the address answers; no extra
  // request is made to show them. A txid already represented by a local
  // action or an indexer event is not repeated here.
  const shownTx = new Set(rows.map((r) => r.txid).filter(Boolean));
  for (const m of w.mempool || []) {
    if (!m?.txid || shownTx.has(m.txid)) continue;
    shownTx.add(m.txid);
    rows.push({
      kind: 'receive', height: null, txid: m.txid, sat: null, seed: undefined,
      name: undefined, amount: m.amount, address: m.address, at: m.at ?? null,
      chain: true, mempool: true, pending: true, confirmed: false,
      fee: null, bumps: 0, bumpable: false, outcome: null,
    });
  }
  // A transaction can leave more than one row: MINT beside CHANGE and
  // HOPPER ARRIVED, SEND beside CHANGE, or a restore without a local action
  // height. Build mint clusters from every clue we have (sat, reveal txid,
  // commit txid) rather than requiring one field to be present. A cluster
  // does not depend on a sat at all: a reveal names the mint and its input 0
  // names the commit that carries the change.
  const clusterParent = [];
  const clusterNodes = [];
  const clusterByTx = new Map();
  const clusterBySat = new Map();
  const findCluster = (i) => {
    let root = i;
    while (clusterParent[root] !== root) root = clusterParent[root];
    while (clusterParent[i] !== i) { const next = clusterParent[i]; clusterParent[i] = root; i = next; }
    return root;
  };
  const unionCluster = (a, b) => {
    const ra = findCluster(a);
    const rb = findCluster(b);
    if (ra === rb) return ra;
    clusterParent[rb] = ra;
    const A = clusterNodes[ra];
    const B = clusterNodes[rb];
    for (const tx of B.txs) A.txs.add(tx);
    if (!Number.isSafeInteger(A.sat)) A.sat = B.sat;
    if (!A.commit) A.commit = B.commit;
    return ra;
  };
  const addMintSource = (sat, reveal, commit = null) => {
    const n = satNumber(sat);
    const txs = [reveal, commit]
      .map((v) => String(v || '').toLowerCase())
      .filter((tx) => /^[0-9a-f]{64}$/.test(tx));
    const hits = new Set();
    if (Number.isSafeInteger(n) && clusterBySat.has(n)) hits.add(findCluster(clusterBySat.get(n)));
    for (const tx of txs) if (clusterByTx.has(tx)) hits.add(findCluster(clusterByTx.get(tx)));
    let root;
    if (!hits.size) {
      root = clusterNodes.length;
      clusterParent.push(root);
      clusterNodes.push({ sat: null, txs: new Set(), commit: null });
    } else {
      const [first, ...rest] = [...hits];
      root = first;
      for (const other of rest) root = unionCluster(root, other);
      root = findCluster(root);
    }
    const node = clusterNodes[root];
    if (Number.isSafeInteger(n)) {
      node.sat = n;
      clusterBySat.set(n, root);
    }
    for (const tx of txs) {
      node.txs.add(tx);
      clusterByTx.set(tx, root);
    }
    const c = String(commit || '').toLowerCase();
    if (/^[0-9a-f]{64}$/.test(c) && !node.commit) node.commit = c;
    return root;
  };
  for (const f of w.frogs || []) {
    addMintSource(f?.sat, f?.mint_txid || f?.location?.txid, f?.commit);
  }
  for (const a of w.actions || []) {
    if (String(a?.kind || '').toLowerCase() === 'mint') {
      addMintSource(a.sat, a.txid, a.commit);
    }
  }
  for (const m of w.chainMints || []) addMintSource(m.sat, m.txid, m.commit);
  for (const r of rows) {
    if (r.kind === 'mint') addMintSource(r.sat, r.txid, r.commit);
  }
  // A change row's own txid is the commit, and the reveal it belongs to is
  // kept as `mintTxid`. That pair is enough to build the cluster even when
  // the minted sat was lost and the reveal's input was never read back — the
  // case that used to drop CHANGE out of the MINT group and, with no height
  // to separate them, sort it above the mint by observation time.
  for (const r of rows) {
    if (r.kind !== 'change' || !r.mintTxid) continue;
    addMintSource(r.mintSat, r.mintTxid, r.txid);
  }
  const clusterKeyCache = new Map();
  const clusterKey = (index) => {
    const root = findCluster(index);
    if (!clusterKeyCache.has(root)) {
      const node = clusterNodes[root];
      const key = Number.isSafeInteger(node.sat)
        ? `mint:${node.sat}`
        : `mintTx:${[...node.txs][0] || root}`;
      clusterKeyCache.set(root, key);
    }
    return clusterKeyCache.get(root);
  };
  const mintKeyForTx = (txid) => {
    const tx = String(txid || '').toLowerCase();
    const hit = clusterByTx.get(tx);
    return hit == null ? null : clusterKey(hit);
  };
  const mintKeyForSat = (sat) => {
    const n = satNumber(sat);
    if (!Number.isSafeInteger(n)) return null;
    const hit = clusterBySat.get(n);
    return hit == null ? null : clusterKey(hit);
  };
  const commitByTx = new Map();
  for (const [tx, index] of clusterByTx) {
    const commit = clusterNodes[findCluster(index)].commit;
    if (commit) commitByTx.set(tx, commit);
  }
  for (const r of rows) {
    if (r.kind !== 'mint') continue;
    const byReveal = r.txid ? commitByTx.get(String(r.txid).toLowerCase()) : null;
    const byCommit = r.commit ? commitByTx.get(String(r.commit).toLowerCase()) : null;
    if (!r.commit && (byReveal || byCommit)) r.commit = byReveal || byCommit;
  }

  const mintGroupOf = (r) => {
    const tx = r.txid ? String(r.txid).toLowerCase() : '';
    const n = satNumber(r.sat);
    if (r.kind === 'mint') {
      return mintKeyForTx(tx)
        || mintKeyForTx(r.commit)
        || mintKeyForSat(n)
        || (Number.isSafeInteger(n) ? `mint:${n}` : null);
    }
    if (r.kind === 'receive' && r.frog) {
      // A later transfer-in of the same sat must stay separate; the reveal
      // txid is the reliable marker of the original arrival. If the frog
      // record names this transaction as its mint, fall back to the sat.
      const direct = mintKeyForTx(tx);
      if (direct) return direct;
      const f = frogBySat.get(n);
      const origin = String(f?.mint_txid || '').toLowerCase();
      if (origin && origin === tx) return mintKeyForSat(n);
      if (!f && Number.isSafeInteger(n)) return mintKeyForSat(n);
      return null;
    }
    if (r.kind === 'change') {
      const tagged = satNumber(r.mintSat);
      return (Number.isSafeInteger(tagged) ? mintKeyForSat(tagged) : null)
        || mintKeyForTx(r.mintTxid)
        || mintKeyForTx(tx);
    }
    return null;
  };

  // Sort by the transaction/mint's best-known height so rows stay adjacent,
  // then put the authoring row before its consequences. Without this, a
  // receipt observed in a later block can appear above the mint that
  // produced it.
  const groupHeight = new Map();
  for (const r of rows) {
    if (!r.txid || r.mempool) continue;
    const h = Number(r.height);
    if (!Number.isInteger(h) || h <= 0) continue;
    const k = String(r.txid).toLowerCase();
    if (!groupHeight.has(k) || h > groupHeight.get(k)) groupHeight.set(k, h);
  }
  for (const r of rows) {
    if (!r.txid) { r.groupHeight = null; continue; }
    const tx = String(r.txid).toLowerCase();
    const commit = r.kind === 'mint' && r.commit ? String(r.commit).toLowerCase() : '';
    r.groupHeight = groupHeight.get(commit || tx) ?? groupHeight.get(tx) ?? null;
  }

  const seen = new Set();
  const unique = rows.filter((r) => {
    // Receives are one row per transaction even when a frog output and
    // ordinary change were both observed. A mint is still allowed to have
    // its own MINT row beside the Hopper-arrival row.
    const k = r.kind === 'receive'
      ? `receive:${r.txid || ''}`
      : `${r.kind}:${r.txid || ''}:${r.sat ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Group rows by transaction/mint, order the groups, then order inside
  // each group. A transaction's rows must never be split by a different
  // txid, even when the restored device has no block height for either row.
  const groups = [];
  const byTx = new Map();
  for (const r of unique) {
    const tx = r.txid ? String(r.txid).toLowerCase() : '';
    const mintKey = mintGroupOf(r);
    const key = mintKey || (tx ? `tx:${tx}` : `row:${groups.length}`);
    r.mintKey = key;
    let g = byTx.get(key) || null;
    if (!g) {
      g = { key, rows: [], height: -1, at: '', mempool: false, order: groups.length };
      byTx.set(key, g);
      groups.push(g);
    }
    g.rows.push(r);
    if (r.mempool) g.mempool = true;
    const h = Number(r.groupHeight ?? r.height);
    if (Number.isInteger(h) && h > g.height) g.height = h;
    const at = String(r.at || '');
    if (at > g.at) g.at = at;
  }
  groups.sort((a, b) => {
    const ap = a.mempool ? 1 : 0;
    const bp = b.mempool ? 1 : 0;
    if (ap !== bp) return bp - ap;
    if (a.height !== b.height) return b.height - a.height;
    if (a.at !== b.at) return b.at.localeCompare(a.at);
    return a.order - b.order;
  });
  return groups.flatMap((g) => {
    if (g.rows.length < 2) return g.rows;
    return g.rows.slice().sort((a, b) => {
      const ar = sameTxRank(a);
      const br = sameTxRank(b);
      if (ar !== br) return ar - br;
      return String(b.at || '').localeCompare(String(a.at || ''));
    });
  });
}

/** The kind labels actually painted by the last History render. */
export function historyDomOrder() {
  if (typeof document === 'undefined') return [];
  return [...document.querySelectorAll('#app .card-row .tx-top .kind')]
    .map((el) => String(el.textContent || '').trim());
}

/**
 * A downloadable snapshot of the history inputs and the keys History
 * actually grouped by. No seed, mnemonic, or private material is included:
 * only the public transaction/address metadata needed to explain a bad
 * ordering. `domOrder` carries the last painted History order when the
 * download is started from Settings.
 */
export function historyDebug(w, domOrder = null) {
  const txid = (v) => {
    const tx = String(v || '').toLowerCase();
    return /^[0-9a-f]{64}$/.test(tx) ? tx : null;
  };
  const rows = historyRows(w).map((r) => ({
    kind: r.kind,
    txid: txid(r.txid),
    shown: r.kind === 'mint' && r.commit ? txid(r.commit) : txid(r.txid),
    commit: txid(r.commit),
    sat: r.sat ?? null,
    height: r.height ?? null,
    groupHeight: r.groupHeight ?? null,
    mintKey: r.mintKey || null,
    frog: !!r.frog,
    amount: r.amount ?? null,
    at: r.at ?? null,
    name: r.name || null,
  }));
  const actions = (w.actions || []).map((a) => ({
    kind: a.kind || null,
    txid: txid(a.txid),
    commit: txid(a.commit),
    sat: a.sat ?? null,
    height: a.height ?? null,
    at: a.at ?? null,
    amount: a.amount ?? null,
    fee: a.fee ?? null,
    name: a.name || null,
  }));
  const chainMints = (w.chainMints || []).map((m) => ({
    txid: txid(m.txid),
    commit: txid(m.commit),
    sat: m.sat ?? null,
    height: m.height ?? null,
    at: m.at ?? null,
    name: m.name || null,
  }));
  const changes = (w.changes || []).map((c) => ({
    txid: txid(c.txid),
    amount: c.amount ?? null,
    height: c.height ?? null,
    at: c.at ?? null,
    mintSat: c.mintSat ?? null,
    mintTxid: txid(c.mintTxid),
  }));
  const receives = (w.receives || []).map((r) => ({
    txid: txid(r.txid),
    sat: r.sat ?? null,
    amount: r.amount ?? null,
    height: r.height ?? null,
    at: r.at ?? null,
    frog: !!r.frog,
    name: r.name || null,
  }));
  const frogs = (w.frogs || []).map((f) => ({
    sat: f.sat ?? null,
    mint_txid: txid(f.mint_txid),
    location: txid(f.location?.txid),
    mint_height: f.mint_height ?? f.height ?? null,
    name: f.name || null,
  }));
  const events = (w.history || []).map((e) => ({
    kind: e.kind || e.action || null,
    txid: txid(e.txid),
    height: e.height ?? null,
    sat: e.payload?.frogger_sat ?? e.payload?.sat ?? null,
    name: e.payload?.name || null,
  }));
  const kindOrder = (html) => [...String(html).matchAll(/class="kind">([^<]+)/g)]
    .map((m) => m[1].trim());
  // `computed` is the order the current data produces through history().
  // `dom` is the order actually painted in the app. If they differ, the
  // ledger is right and the History screen is a stale paint.
  const computed = kindOrder(history({ w }));
  const dom = Array.isArray(domOrder) ? domOrder : historyDomOrder();
  return JSON.stringify({
    build: globalThis.HOPPER_BUILD || 'development',
    href: typeof location !== 'undefined' ? location.href : '',
    tip: w.tipHeight ?? null,
    computed, dom,
    rows, actions, chainMints, changes, receives, frogs, events,
  }, null, 2);
}

/** The feed is newest first: top of the screen is the latest row, bottom is
 *  the earliest. So inside one transaction the row the wallet learned last
 *  sits highest: the Hopper arriving, then the change the mint or send
 *  returned, then the mint/send itself at the bottom of its own block.
 *  This is display order, not confirmation order. */
function sameTxRank(r) {
  if (r.kind === 'receive') return 0;
  if (r.kind === 'change') return 1;
  return 2;
}

const KIND_LABEL = {
  mint: 'MINT', prepare: 'TRAVEL TO ROAD', cross: 'HOP', settle: 'SETTLE',
  transfer: 'TRANSFER', send: 'SEND', receive: 'RECEIVE', faucet: 'RECEIVE',
  change: 'CHANGE', chain: 'CHAIN',
  // Only an indexer event from a transaction built elsewhere. The wallet
  // has no burn action and never constructs one.
  burn: 'FEE SWEEP',
};

function txRow(app, r) {
  const w = app.w;
  const f = r.sat != null ? w.frogBySat(r.sat) : null;
  const seed = r.seed ?? f?.seed;
  const name = r.name || f?.name;
  let icon;
  if (r.mempool) {
    icon = '<span class="coin in mempool-coin"></span>';
  } else if (r.kind === 'send' || r.kind === 'transfer') {
    icon = '<span class="coin out"></span>';
  } else if (r.kind === 'burn') {
    icon = '<span class="coin out"></span>';
  } else if (r.kind === 'settle' && String(r.outcome || '').toLowerCase() === 'dead') {
    icon = '<canvas data-squished width="32" height="24" style="width:32px;height:24px"></canvas>';
  } else if (seed != null) {
    const st = r.kind === 'cross' ? 'crossing'
      : r.kind === 'settle' ? (String(r.outcome || '').toLowerCase() === 'dead' ? 'dead' : 'home')
        : 'idle';
    icon = frogImg(seed, st, 'sprite', name || '');
  } else if (r.kind === 'settle') {
    icon = '<span class="coin ring"></span>';
  } else {
    icon = '<span class="coin ring"></span>';
  }

  const inMempool = !!(r.mempool || r.pending);
  const shownHeight = r.groupHeight ?? r.height;
  const shownTxid = r.kind === 'mint' && r.commit ? r.commit : r.txid;
  const label = r.frog ? 'HOPPER ARRIVED' : (KIND_LABEL[r.kind] || String(r.kind).toUpperCase());
  const detail = [];
  if ((r.mempool || r.kind === 'receive' || r.kind === 'change') && r.address) {
    detail.push({
      prefix: 'to ',
      value: r.address,
      shown: `${r.address.slice(0, 12)}…`,
      label: 'Copy address',
      copyLabel: 'address copied',
    });
  }
  if (r.sat != null) detail.push(`sat ${sats(r.sat)}`);
  if (r.kind === 'settle' && r.outcome) detail.push(String(r.outcome).toUpperCase());
  if (r.to) {
    detail.push({
      prefix: 'to ',
      value: r.to,
      shown: truncTxid(r.to),
      label: 'Copy address',
      copyLabel: 'address copied',
    });
  }
  if (r.name && r.kind !== 'send') detail.push(String(r.name));
  if (r.fee != null) detail.push(`fee ${sats(r.fee)} sats`);
  if (r.bumps) detail.push(`bumped ×${r.bumps}`);
  const detailHtml = detail.map((part) => {
    if (typeof part === 'string') return esc(part);
    return `${esc(part.prefix || '')}${copyButton(part.value, part.shown, part.label, part.copyLabel)}`;
  }).join(' · ');

  let amount = '';
  if (r.kind === 'send' && r.amount != null) {
    amount = `<span class="tx-amt out">-${sats(r.amount)} sats</span>`;
  } else if (r.kind === 'change' && Number(r.amount) > 0) {
    amount = `<span class="tx-amt dim">${sats(r.amount)} sats</span>`;
  } else if (Number(r.amount) > 0) {
    amount = `<span class="tx-amt in">+${sats(r.amount)} sats</span>`;
  } else if (r.kind === 'settle' && String(r.outcome || '').toLowerCase() === 'dead') {
    amount = '<span class="tx-amt out">roadkill is forever</span>';
  } else {
    amount = '<span class="tx-amt dim">amount unknown</span>';
  }

  const state = inMempool
    ? chip('IN MEMPOOL', 'accent')
    : shownHeight != null
      ? `<span class="tiny muted">⬛ ${sats(shownHeight)}</span>`
      : r.confirmed
        ? chip('CONFIRMED', 'dim')
        : chip('PENDING', 'accent');

  return `
    <div class="card-row${inMempool ? ' mempool' : ''}" ${r.sat != null ? `data-action="open-frog" data-sat="${r.sat}" style="cursor:pointer"` : ''}>
      <div class="tx-row">
        <div class="tx-icon">${icon}</div>
        <div class="tx-main">
          <div class="tx-top">
            <span class="kind">${esc(label)}</span>
            <span class="txid">${copyButton(shownTxid, truncTxid(shownTxid), 'Copy transaction ID', 'txid copied')}</span>
          </div>
          ${detail.length ? `<div class="tx-detail">${detailHtml}</div>` : ''}
          <div class="tx-bottom">
            ${amount}
            <span class="spacer"></span>
            <span class="tx-state">${state}</span>
          </div>
          ${r.bumpable ? `<div class="tx-actions">${logBtn('⛽ BUMP FEE', 'bump-fee', {
            edge: 'accent', cls: 'small', attrs: `data-txid="${esc(r.txid)}"`,
          })}</div>` : ''}
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

export function mint(app) {
  const w = app.w;
  const seed = app.mintSeed >>> 0;
  const tip = w.tipHeight || 0;
  const target = requiredAt(tip + 1);
  const next = nextIncrement(tip);
  const coin = w._funding?.().find((u) => u.ranges && u.ranges.length);
  const traits = deriveTraits(seed);
  const rarity = RARITY_NAMES[traits.rarity];
  const pattern = ['none', 'spots', 'stripes', 'diamond'][traits.pattern] || 'none';
  const eyes = ['normal', 'wide', 'sleepy', 'laser'][traits.eyes] || 'normal';
  const mouth = ['smile', 'flat', 'ooh', 'tongue'][traits.mouth] || 'smile';
  return `
    <div class="mint-block">
      ${heading('✨ Mint a Hopper')}
      <div class="mint-hero">
        <img id="mint-preview" class="sprite" src="${app.previewUri}" alt="">
        <div class="info">
          <div class="tiny muted" data-seed-label>seed ${seedText(seed)}</div>
          <div class="mt10">${chip(rarity, rarityClass({ rarity: traits.rarity, seed }))}</div>
          <label class="field mt10"><span>Name (optional)</span>
            <input type="text" data-input="mint-name" maxlength="38" value="${esc(app.mintName)}" placeholder="optional · leave blank for UNNAMED">
          </label>
          <div class="mint-actions">
            ${logBtn('🎲 Reroll', 'random-seed', { edge: 'dim', cls: '' })}
            ${logBtn('MINT!', 'preview-mint', { edge: 'accent', cls: '', attrs: `${app.busy || !coin ? 'disabled' : ''}` })}
          </div>
          <div class="hint">Rarity is cosmetic — it never affects the road. Every hop is one of three directions, and the next block decides one for everyone.</div>
        </div>
      </div>

      <div class="mt14">
        <div style="font-weight:700">Preview traits</div>
        <div class="stat-grid">
          <dt>Rarity</dt><dd>${esc(rarity)}</dd>
          <dt>Pattern · Eyes · Mouth</dt><dd>${esc(pattern)} · ${esc(eyes)} · ${esc(mouth)}</dd>
          <dt>Chonk · Legs</dt><dd>${traits.chonk} · ${traits.legs}</dd>
        </div>
      </div>

      <div class="mt14">
        <div style="font-weight:700">The schedule</div>
        <div class="stat-grid">
          <dt>Next target</dt><dd>${target} hops at H ${sats(tip)}</dd>
          <dt>Next rise</dt><dd>${next ? `H ${sats(next[0])} → ${next[1]} hops` : `capped at ${MAX_TARGET}`}</dd>
          <dt>Hop risk</dt><dd>${(hopDeathBps() / 100).toFixed(2)}% — one of three directions</dd>
          <dt>Finality</dt><dd>6 blocks</dd>
          <dt>Params</dt><dd class="tiny wrap">${esc(paramsHashHex())}</dd>
        </div>
      </div>

      ${!coin ? '<div class="notice-bar">⚠ no tracked coin — the mint needs a coin whose ordinal ranges the indexer knows.</div>' : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export function leaders(app) {
  const rows = app.leaders || [];
  return `
    ${heading('🏆 Leaderboard')}
    <div class="sub">Every Hopper the indexer has seen, ranked by generation, then distance.</div>
    <div class="mt14">
      ${rows.length ? rows.map((r) => {
    const mine = app.w.frogs.some((f) => Number(f.sat) === Number(r.sat));
    return `
          <div class="leader-row" data-action="open-frog" data-sat="${r.sat}">
            <span class="rank">#${r.rank}</span>
            <span class="name">${esc(shortName(r.name))}${mine ? ' <span class="chip-ui accent">YOU</span>' : ''}</span>
            <span class="hops">G${Number(r.gen) || 1} · ${r.dist} hops</span>
            <span class="state">${esc(String(r.state || '').toUpperCase())}</span>
          </div>`;
  }).join('') : `
        <div class="center mt18">
          <div style="font-weight:700;font-size:15px">Connect to Hopper Indexer to see Leaderboard</div>
          <div class="sub mt6">The board is your indexer's view — it ranks frogs this wallet has never seen.<br>Coins and frogs work without one.</div>
          <div class="mt14">${logBtn('⚙ OPEN SETTINGS', 'nav', { edge: 'accent', attrs: 'data-view="settings"' })}</div>
        </div>`}
    </div>`;
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export function frogDetail(app, sat) {
  const w = app.w;
  const f = w.frogBySat(Number(sat))
    || (app.frogRecord && Number(app.frogRecord.sat) === Number(sat) ? app.frogRecord : null);
  if (!f) {
    return `${backButton()}<div class="sub mt14">No frog at sat ${esc(sat)}.</div>`;
  }
  const owned = !!w.frogBySat(Number(sat));
  const utxo = w._frogUtxo?.(f);
  const kind = utxo?.kind || 'none';
  const canPrepare = owned && f.state === 'idle' && utxo && kind !== 'state';
  const canCross = owned && f.state === 'idle' && utxo && kind === 'state';
  const canTransfer = owned && !!utxo && !['burned', 'crossing', 'retired'].includes(f.state);
  const state = f.state || 'idle';
  const target = targetOf(f, w.tipHeight || 0);
  const targetLabel = state === 'idle' ? 'Next hop target'
    : state === 'crossing' ? 'Crossing target'
      : state === 'home' ? 'Target reached' : 'Last target';
  const body = f.mint_txid ? `${f.mint_txid}i${f.mint_index ?? 0}` : f.inscription_id;

  return `
    ${backButton()}
    <div class="detail-head">
      ${frogImg(f.seed, SPRITE_STATE(f), 'sprite', f.name || '')}
      <div class="detail-info">
        <div class="detail-name">${esc(f.name || 'UNNAMED')}</div>
        ${logBtn('📜 HISTORY', 'bio', { edge: 'dim', cls: 'small', attrs: `data-sat="${f.sat}"` })}
        <div class="mt10">${pips(f.dist, target)}</div>
        <div class="row mt6">
          ${chip(rarityOf(f), rarityClass(f))}
          ${lifeChip(state)}
        </div>

        <div class="stat-grid mt14">
          <dt>Generation</dt><dd>G${Number(f.gen) || generationAt(f.mint_height ?? (w.tipHeight || 0))}</dd>
          <dt>Crossings completed</dt><dd>${Number(f.dist) || 0}</dd>
          <dt>Road entries</dt><dd>${Number(f.crossings_entered) || 0}</dd>
          <dt>Seed</dt><dd>${(Number(f.seed) >>> 0).toString(16).toUpperCase().padStart(8, '0')}</dd>
          <dt>Hopper sat</dt><dd>${sats(f.sat)}</dd>
          <dt>${targetLabel}</dt><dd>${target} hops</dd>
          <dt>Hop risk</dt><dd>${(hopDeathBps() / 100).toFixed(2)}% roadkill (1 of 3 directions)</dd>
          <dt>Inscription</dt><dd class="tiny wrap">${esc(body || (f.commit_pending ? 'inscribing…' : '—'))}</dd>
        </div>

        <div class="mt14">
          ${state === 'idle' && !f.commit_pending ? (canCross
    ? logBtn('🚦 HOP THE ROAD', 'sheet-cross', { edge: 'accent', attrs: `data-sat="${f.sat}"` })
    : canPrepare
      ? logBtn('TRAVEL TO ROAD', 'travel-to-road', { edge: 'accent', attrs: `data-sat="${f.sat}"` })
      : '') : ''}
          ${f.commit_pending ? '<div class="life-note">✏ INSCRIBING — the reveal is being confirmed. Crossing unlocks right after.</div>' : ''}
          ${state === 'crossing' ? `<div class="life-note">On the road… see The Road screen.</div><div class="mt6">${logBtn('Go to The Road', 'nav', { edge: 'dim', cls: 'small', attrs: 'data-view="road"' })}</div>` : ''}
          ${state === 'home' ? '<div class="life-note home">👑 HOME — crowned and immortal. This Hopper never crosses again.</div>' : ''}
          ${state === 'dead' ? '<div class="life-note dead">💀 Forever dead. The traffic was merciless.</div>' : ''}
          ${state === 'burned' ? '<div class="life-note dead">🔥 LOST TO FEES — the sat carrying this frog was swept into a transaction fee. Nothing can bring it back.</div>' : ''}
          ${state === 'retired' ? '<div class="life-note">RETIRED — this card is no longer tracked by the chain.</div>' : ''}
          ${!owned ? '<div class="life-note">NOT IN THIS WALLET — the record is public; there is nothing here to sign.</div>' : ''}
        </div>

        ${owned && !f.commit_pending ? `
        <div class="actions mt10">
          ${canTransfer ? logBtn('TRANSFER', 'sheet-transfer', { edge: 'dim', cls: 'small', attrs: `data-sat="${f.sat}"` }) : ''}
        </div>` : ''}
      </div>
    </div>

    <div class="mt18">
      <div style="font-weight:700">THE RECORD</div>
      <div class="stat-grid mt6">
        <dt>Mint id</dt><dd class="tiny wrap">${esc(body || '—')}</dd>
        <dt>Mint height</dt><dd>${f.mint_height != null ? sats(f.mint_height) : '—'}</dd>
        <dt>Location</dt><dd class="tiny wrap">${f.location ? `${esc(f.location.txid)}:${f.location.vout}` : (state === 'burned' ? 'burned to fees' : '—')}</dd>
        <dt>Owner leaf</dt><dd class="tiny wrap">${utxo ? esc(Array.from(w.ord.ownerXonly, (b) => b.toString(16).padStart(2, '0')).join('')) : 'not held by this wallet'}</dd>
        <dt>Entered</dt><dd>${sats(f.crossings_entered || 0)} crossings</dd>
        <dt>Settled</dt><dd>${sats(f.crossings_settled || 0)}</dd>
        ${f.death_height != null ? `<dt>Death</dt><dd>H ${sats(f.death_height)}</dd>` : ''}
        ${f.immortal_height != null ? `<dt>Immortal</dt><dd>H ${sats(f.immortal_height)}</dd>` : ''}
        ${f.in_flight ? `<dt>In flight</dt><dd class="tiny wrap">${esc(f.in_flight.txid)} · target ${f.in_flight.target_hops}</dd>` : ''}
      </div>
    </div>

    <div class="mt18">
      <div style="font-weight:700">VERIFICATION</div>
      <div class="stat-grid mt6">
        <dt>Target at T</dt><dd>${f.in_flight ? f.in_flight.target_hops : (f.last_target_hops != null ? `${f.last_target_hops} (last)` : '— no hop')}</dd>
        <dt>Required at next</dt><dd>${requiredAt((w.tipHeight || 0) + 1)} hops</dd>
        <dt>Hop risk</dt><dd>${(hopDeathBps() / 100).toFixed(2)}% — the block wraps one direction</dd>
        <dt>Chosen direction</dt><dd>${f.in_flight ? ['LEFT', 'STRAIGHT', 'RIGHT'][f.in_flight.dir] || '—' : '—'}</dd>
        <dt>Block wrap</dt><dd>${f.outcome_wrap == null ? 'not sealed' : ['LEFT', 'STRAIGHT', 'RIGHT'][f.outcome_wrap]}</dd>
        <dt>Outcome hash</dt><dd class="tiny wrap">${esc(f.outcome_block_hash || 'not sealed')}</dd>
        <dt>Provisional</dt><dd>${f.provisional_dead == null ? '—' : f.provisional_dead ? '<span style="color:#d98a80">DEAD PENDING FINALITY</span>' : '<span style="color:var(--tx-in)">ALIVE PENDING FINALITY</span>'}</dd>
      </div>
      <div class="hint">${esc(verifyLine(f))}</div>
    </div>`;
}

function verifyLine(f) {
  if (!f.crossings_entered) {
    return 'No crossing yet. This is a plain 25,000-sat card; there is no fold history to replay until it enters the road.';
  }
  if (f.state === 'crossing') {
    return 'The outcome is frozen at T+1 and settles six blocks later. Nothing can change it while the anchor is in flight.';
  }
  if (f.state === 'dead') {
    return `Dead at H ${sats(f.death_height)}. The death table is deterministic, so the indexer record above is final.`;
  }
  if (f.state === 'home') {
    return `Home since H ${sats(f.immortal_height)}. A home frog is immortal; its hops stop counting.`;
  }
  return 'The frozen fold source is loaded locally. The indexer record above is authoritative.';
}

// ---------------------------------------------------------------------------
// Bio — the life-history timeline
// ---------------------------------------------------------------------------

export function bio(app, sat) {
  const w = app.w;
  const f = w.frogBySat(Number(sat)) || app.frogRecord;
  if (!f) return `${backButton()}<div class="sub mt14">No frog at sat ${esc(sat)}.</div>`;
  const target = targetOf(f, w.tipHeight || 0);
  const events = frogEvents(w, Number(sat));
  const iconFor = (e) => {
    if (e.type === 'born') return '<canvas class="timeline-icon" data-tadpole width="44" height="30"></canvas>';
    if (e.type === 'died') return '<canvas class="timeline-icon" data-squished width="44" height="30"></canvas>';
    if (e.type === 'crossed') return frogImg(f.seed, 'home', 'sprite', '');
    return frogImg(f.seed, 'crossing', 'sprite', '');
  };
  return `
    <div class="row">
      ${backButton()}
      ${logBtn('📋 STATS', 'detail', { edge: 'dim', cls: 'small', attrs: `data-sat="${sat}"` })}
    </div>
    <div class="bio-head mt10">
      ${frogImg(f.seed, SPRITE_STATE(f), 'sprite', f.name || '')}
      <div class="detail-info">
        <div class="detail-name">${esc(f.name || 'UNNAMED')}</div>
        <div class="mt10">${pips(f.dist, target)}</div>
        <div class="row mt6">${chip(rarityOf(f), rarityClass(f))}${lifeChip(f.state)}</div>
      </div>
    </div>
    <div class="mt14">
      <div style="font-weight:700">LIFE STORY</div>
      <div class="timeline mt6">
        ${events.length ? events.map((e) => `
          <div class="timeline-row">
            <div class="timeline-icon">${iconFor(e)}</div>
            <div>
              <div class="timeline-label" style="color:${e.color}">${esc(e.label)}</div>
              <div class="timeline-detail">${esc(e.detail)}</div>
            </div>
          </div>`).join('') : '<div class="sub">No history on record yet — this Hopper is a mystery.</div>'}
      </div>
    </div>`;
}

function frogEvents(w, sat) {
  const out = [];
  for (const e of w.history || []) {
    const s = e.payload?.frogger_sat ?? e.payload?.sat;
    if (Number(s) !== Number(sat)) continue;
    const kind = String(e.kind || '').toLowerCase();
    const height = e.height;
    if (kind === 'mint') {
      out.push({ type: 'born', label: 'MINTED', detail: `block ${height}`, color: C.text, height });
    } else if (kind === 'cross') {
      out.push({ type: 'cross', label: 'HOPPED ONTO THE ROAD', detail: `block ${height}`, color: C.accent, height });
    } else if (kind === 'settle') {
      const dead = String(e.payload?.outcome || '').toLowerCase() === 'dead';
      out.push(dead
        ? { type: 'died', label: 'DIED', detail: `block ${height} — roadkill is forever`, color: '#d98a80', height }
        : { type: 'crossed', label: 'CROSSED THE ROAD', detail: `block ${height}`, color: C.home, height });
    }
  }
  return out.sort((a, b) => (a.height ?? 0) - (b.height ?? 0));
}


function scanAge(ts) {
  if (!ts) return '—';
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  return `${Math.round(secs / 60)}m ago`;
}

function scanEta(ts) {
  if (!ts) return '—';
  const secs = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (secs < 2) return 'now';
  if (secs < 60) return `in ${secs}s`;
  return `in ${Math.round(secs / 60)}m`;
}

/**
 * The live scan policy, shown in SETTINGS. This is deliberately explicit:
 * on a public API the idle cost is one tip query every ten minutes, a gap
 * walk only happens on request, and a rescan says where it is and can be
 * stopped.
 */
export function scanPanel(app) {
  const w = app?.w;
  if (!w || typeof w.scanState !== 'function') return '';
  const sc = w.scanState();
  const mode = w.settings?.mode === 'demo'
    ? 'DEMO — in-browser chain'
    : sc.publicSource ? 'PUBLIC — metered' : 'LOCAL NODE — free';
  const builtIn = Math.max(0, sc.gapLimit - (sc.gapExtra || 0));
  const paused = sc.paused === true;
  const progress = sc.rescan
    ? `Rescanning ${sc.rescan.asked} addresses · ${sc.rescan.hits} with history`
    : sc.note || (paused ? 'Scanning paused — automatic passes are off.' : 'No scan has run yet.');
  return `
    <div class="settings-grid mt10">
      <label>Source</label><dd>${esc(mode)}</dd>
      <label>Scan window</label><dd>${sats(sc.gapLimit)} addresses (${sats(builtIn)} built-in + ${sats(sc.gapExtra || 0)})</dd>
      <label>Last pass</label><dd>${esc(sc.lastPass ? `tip ${sats(sc.lastTip)} · ${scanAge(sc.lastPass)}` : '—')}</dd>
      <label>Next pass</label><dd>${esc(sc.busy || sc.rescan ? 'running' : paused ? 'paused' : sc.nextAt ? scanEta(sc.nextAt) : sc.auto ? 'scheduled' : 'manual')}</dd>
      ${sc.fails ? `<label>Backoff</label><dd>${sats(sc.fails)} failed pass${sc.fails === 1 ? '' : 'es'} — ${paused ? 'paused; no automatic retries' : 'retrying slower'}</dd>` : ''}
      ${sc.pending ? `<label>Confirming</label><dd>${sats(sc.pending)} transaction${sc.pending === 1 ? '' : 's'} — polling faster until confirmed</dd>` : ''}
    </div>
    <div class="actions mt10">
      ${paused
        ? logBtn('RESUME SCANNING', 'toggle-scan', { edge: 'accent', cls: 'small' })
        : logBtn('STOP SCANNING', 'toggle-scan', { edge: 'dead', cls: 'small' })}
      ${sc.rescan
        ? logBtn('STOP RESCAN', 'stop-rescan', { edge: 'dead', cls: 'small' })
        : app.scanArmed
          ? logBtn('RESCAN? TAP AGAIN', 'rescan', { edge: 'dead', cls: 'small' })
          : logBtn('RESCAN FROM CHAIN', 'rescan', { edge: 'accent', cls: 'small' })}
      ${logBtn('EXTEND +20', 'extend-gap', { edge: 'dim', cls: 'small' })}
    </div>
    <div class="scan-line ${sc.rescan ? 'accent' : ''}" data-scan-line>${esc(progress)}</div>
    <div class="hint">STOP SCANNING clears the timer, block subscription and foreground wake; REFRESH and RESCAN still work by hand. A public source is asked for the tip once every 10 minutes while idle, once every 30 seconds only while one of our transactions is confirming, and never for an unchanged block. Failed public passes back off from 1 minute to 30 minutes.</div>`;
}

// ---------------------------------------------------------------------------
// Settings (HOPPER's own controls, in the FROGGER window material)
// ---------------------------------------------------------------------------

export function settings(app) {
  const w = app.w;
  const s = app.settings;
  const book = s.addressBook || [];
  const recovery = typeof w?.recoverySummary === 'function'
    ? w.recoverySummary()
    : { count: 0, last_seen_tip: null, updated_at: null };
  const recoveryLine = recovery.count
    ? `${recovery.count} saved pack${recovery.count === 1 ? '' : 's'} · last seen at tip ${recovery.last_seen_tip == null ? '—' : sats(recovery.last_seen_tip)} · updated ${recovery.updated_at ? new Date(recovery.updated_at).toLocaleString() : '—'}`
    : 'No packs yet — one is written automatically when a Hopper is staged.';
  return `
    ${heading('⚙ Settings')}
    <div class="hint">BUILD ${esc(globalThis.HOPPER_BUILD || 'development')}</div>
    <div class="window" data-lily="accent">
      <div style="font-weight:700">CHAIN</div>
      <div class="sub">${esc(w.network)} · ${esc(s.mode)}</div>
      <div class="settings-grid mt10">
        <label>Mode</label>
        <select data-input="mode">
          <option value="demo" ${s.mode === 'demo' ? 'selected' : ''}>Demo (in-browser)</option>
          <option value="live" ${s.mode === 'live' ? 'selected' : ''}>Live (indexer / Esplora)</option>
        </select>
        <label>Esplora</label>
        <input type="text" data-input="esploraUrl" value="${esc(s.esploraUrl || '')}" placeholder="https://blockstream.info/api (mainnet default)">
        <label>Indexer</label>
        <input type="text" data-input="indexerUrl" value="${esc(s.indexerUrl || '')}" placeholder="https://… (optional)">
        <label>Ord</label>
        <input type="text" data-input="ordUrl" value="${esc(s.ordUrl || '')}" placeholder="https://ordinals.com (mainnet default)">
        <label>Electrum</label>
        <input type="text" data-input="electrumUrl" value="${esc(s.electrumUrl || '')}" placeholder="wss://…">
        <label>Deep scan</label>
        <select data-input="deepScan">
          <option value="1" ${s.deepScan ? 'selected' : ''}>On</option>
          <option value="0" ${!s.deepScan ? 'selected' : ''}>Off</option>
        </select>
      </div>
      <div class="actions mt6">
        ${logBtn('USE MEMPOOL.SPACE', 'esplora-preset', { edge: 'dim', cls: 'small', attrs: 'data-url="https://mempool.space/api"' })}
        ${logBtn('USE BLOCKSTREAM', 'esplora-preset', { edge: 'dim', cls: 'small', attrs: 'data-url="https://blockstream.info/api"' })}
      </div>
      <div class="actions mt14">
        ${logBtn('TEST', 'test-backend', { edge: 'dim', cls: 'small' })}
        ${logBtn('APPLY', 'apply-backend', { edge: 'accent', cls: 'small' })}
      </div>
      <div class="hint">Defaults: Esplora empty on mainnet uses blockstream.info/api (unless an Electrum URL is set), and Ord empty uses ordinals.com on mainnet. Both public hosts speak Esplora; mempool.space can be slower on busy addresses and is subject to browser-extension blocking (allowlist it in NoScript). A self-hosted Esplora must send Access-Control-Allow-Origin for this site — curl does not enforce CORS, so a working curl can still fail in the wallet.</div>
      <div class="hint">An empty Indexer means no HOPPER indexer. A mint paid to this wallet's ordinals address is recovered from its reveal witness; a frog transferred in later, the road and the leaderboard still need an indexer. Sat ranges come from the indexer when it knows the coin; otherwise the Ord server names them.</div>
    </div>

    <div class="window" data-lily="accent">
      <div style="font-weight:700">SPENDING</div>
      <div class="sub">What a SEND may use while it is still in the mempool.</div>
      <div class="settings-grid mt10">
        <label>Unconfirmed funds</label>
        <select data-input="spendUnconfirmed">
          <option value="1" ${s.spendUnconfirmed !== false ? 'selected' : ''}>Spend (default)</option>
          <option value="0" ${s.spendUnconfirmed === false ? 'selected' : ''}>Wait for confirmation</option>
        </select>
      </div>
      <div class="hint">On: an unconfirmed payment or change may fund a SEND, so you can chain spends. Mint, TRAVEL TO ROAD and HOP still require known sat ranges, which in practice means confirmed funding. Off: only confirmed coins fund anything.</div>
    </div>

    <div class="window" data-lily="home">
      <div style="font-weight:700">SCAN POLICY</div>
      <div data-scan-panel>${scanPanel(app)}</div>
    </div>

    <div class="window" data-lily="home">
      <div style="font-weight:700">SOUND</div>
      <div class="settings-grid mt10">
        <label>Sound</label>
        <select data-input="mute">
          <option value="0" ${!s.mute ? 'selected' : ''}>On</option>
          <option value="1" ${s.mute ? 'selected' : ''}>Muted</option>
        </select>
        <label>Volume</label>
        <input type="range" min="0" max="100" step="1" data-input="volume" aria-label="Volume" value="${Math.round((s.volume ?? 0.55) * 100)}">
      </div>
      <div class="sound-line" data-sound-line>${esc(soundLine(app))}</div>
    </div>

    <div class="window" data-lily="home">
      <div style="font-weight:700">AUTO RECOVERY PACKS</div>
      <div class="sub">Saved automatically when a Hopper is staged and updated whenever a transaction moves its state output. Layout only — never the seed.</div>
      <div class="hint" data-recovery-summary>${esc(recoveryLine)}</div>
      <div class="actions mt10">${logBtn('EXPORT RECOVERY PACKS', 'export-recovery', { edge: 'dim', cls: 'small' })}</div>
    </div>

    <div class="window" data-lily="home">
      <div style="font-weight:700">EMERGENCY DESCRIPTORS</div>
      <div class="sub">A live snapshot for every staged Hopper: raw leaves, control blocks, output key and owner path. The automatic packs above keep the stored copy current. It never contains the seed.</div>
      <div class="actions mt10">${logBtn('EXPORT EMERGENCY DESCRIPTORS', 'export-emergency', { edge: 'dim', cls: 'small' })}</div>
    </div>

    <div class="window" data-lily="dim">
      <div style="font-weight:700">HISTORY DATA</div>
      <div class="sub">Download a plain-text snapshot of this wallet's public ledger: txids, sats, heights and the keys History grouped by.</div>
      <div class="actions mt10">${logBtn('DOWNLOAD HISTORY TXT', 'download-history-debug', { edge: 'dim', cls: 'small' })}</div>
      <div class="hint">Never includes the seed, mnemonic or private keys. Useful when a History row groups incorrectly on a device we cannot inspect directly.</div>
    </div>

    <div class="window" data-lily="accent">
      <div style="font-weight:700">BACKUP</div>
      <div class="sub">The 12 words ARE the wallet. They never leave this device.</div>
      <div class="actions mt10">${logBtn('👁 REVEAL 12 WORDS', 'reveal-words', { edge: 'accent', cls: 'small' })}</div>
    </div>

    <div class="window" data-lily="accent">
      <div style="font-weight:700">THE INTRO</div>
      <div class="sub">The first hop into the road, again.</div>
      <div class="actions mt10">
        ${logBtn('▶ REPLAY THE INTRO', 'replay-intro', { edge: 'dim', cls: 'small' })}
      </div>
    </div>

    ${s.mode === 'demo' ? `
    <div class="window" data-lily="accent">
      <div style="font-weight:700">DEMO CHAIN</div>
      <div class="sub">${esc(w.network)} · the in-browser chain. Not Bitcoin.</div>
      <div class="actions mt10">
        ${logBtn('FAUCET', 'faucet', { edge: 'dim', cls: 'small' })}
        ${logBtn('MINE 1', 'mine', { edge: 'dim', cls: 'small', attrs: 'data-n="1"' })}
        ${logBtn('MINE 6', 'mine', { edge: 'dim', cls: 'small', attrs: 'data-n="6"' })}
        ${logBtn('RESET DEMO', 'reset-demo', { edge: 'dead', cls: 'small danger' })}
      </div>
    </div>` : ''}

    <div class="window" data-lily="dim">
      <div style="font-weight:700">ADDRESS BOOK</div>
      <div class="sub">${book.length} saved address${book.length === 1 ? '' : 'es'}</div>
      ${book.length ? book.map((row, i) => `
        <div class="row mt6">
          <span class="small" style="min-width:90px">${esc(row.name)}</span>
          <span class="tiny wrap grow">${esc(row.address)}</span>
          <button class="copy" data-action="drop-address" data-i="${i}">DROP</button>
        </div>`).join('') : '<div class="hint">No addresses saved.</div>'}
      <div class="settings-grid mt10">
        <label>Name</label>
        <input type="text" data-input="book-name" placeholder="cold storage">
        <label>Address</label>
        <input type="text" data-input="book-address" placeholder="bcrt1…">
      </div>
      <div class="actions mt10">${logBtn('ADD ADDRESS', 'add-address', { edge: 'dim', cls: 'small' })}</div>
    </div>

    <div class="window" data-lily="dead">
      <div style="font-weight:700">DANGER</div>
      <div class="sub">The 12 words are the only way back.</div>
      <div class="actions mt10">
        ${logBtn('LOCK', 'lock', { edge: 'dim', cls: 'small' })}
        ${logBtn('USE ANOTHER VAULT', 'use-another', { edge: 'dim', cls: 'small' })}
        ${logBtn('WIPE DEVICE', 'wipe', { edge: 'dead', cls: 'small danger' })}
      </div>
    </div>

    <div class="footer">HOPPER v7 · WIRE 0x07 · ${esc(paramsHashHex().slice(0, 16))}…</div>`;
}

// ---------------------------------------------------------------------------
// Rules — the eight pages of the walkthrough
// ---------------------------------------------------------------------------

export const RULES = [
  {
    kicker: '1 / 8',
    title: 'A HOPPER IS ONE SAT',
    art: 'designs',
    lines: [
      'Minting a Hopper claims one satoshi of bitcoin and inscribes it. The sat is the Hopper: it rides every coin that carries it, and nothing else can be that Hopper.',
      'The inscription stands alone — any ord viewer can read it. It needs no server of ours.',
    ],
  },
  {
    kicker: '2 / 8',
    title: 'WHAT A MINT COSTS',
    art: 'sat',
    lines: [
      'Minting costs a commit, the inscription and the fee. Watch the price before you mint, and never mint what you would miss.',
      'The sat is chosen for you. The Hopper is the sat, not the picture — the picture is how you recognise it.',
    ],
  },
  {
    kicker: '3 / 8',
    title: 'THE ROAD',
    art: 'hop',
    lines: [
      'A hop moves the Hopper: its coin is spent into a new output whose inscription records the direction. That is the whole game — one hop, one state.',
      'You cannot take a hop back. A hop is a spend: once it confirms, the old state is history.',
    ],
  },
  {
    kicker: '4 / 8',
    title: 'HOME',
    art: 'home',
    lines: [
      'A Hopper is home once it has survived the number of hops the road asks, and nothing on the blockchain can kill it after that.',
      'Distance is how many hops it has survived; the leaderboard ranks by generation, then distance.',
    ],
  },
  {
    kicker: '5 / 8',
    title: 'THE TOLL',
    art: 'toll',
    lines: [
      'The road runs in generations of 6,480 blocks: 5 hops at the start of each, one more every 144 blocks up to 25, then 3,600 blocks at 25, and a reset to 5.',
      'The generation a Hopper was minted in is its label forever: G1, G2, … Mint later and the road asks more of you.',
    ],
  },
  {
    kicker: '6 / 8',
    title: 'THE BLOCK DECIDES',
    art: 'squish',
    lines: [
      'You choose left, straight or right. The next block picks which direction the cars drive in: a Hopper that picked that direction dies, every other Hopper in the block survives.',
      'The verdict is fixed at the next block and settles six blocks later; until then the Hopper shows as crossing.',
    ],
  },
  {
    kicker: '7 / 8',
    title: 'THE ODDS',
    art: 'grave',
    lines: [
      'Every hop is in one of three directions that cars could drive in, so each hop is a one-in-three chance of dying — no matter the generation.',
      'Longer roads are harder, not safer: surviving 5 hops is about 13%, 10 hops about 1.7%.',
      'Only ever hop a Hopper you can afford to lose.',
    ],
  },
  {
    kicker: '8 / 8',
    title: 'YOURS TO KEEP',
    art: 'sat',
    lines: [
      'Your seed phrase IS the wallet. Lose it and the Hoppers are unrecoverable; write it down, offline, before you fund anything.',
      'A public server can show you the chain without you trusting it with your coins. Your own node (bitcoind, electrum, ord) shows more and asks nobody.',
      'Sending a Hopper away is final. Check the address.',
    ],
  },
];

export function rulesPage(app) {
  const walk = app.rulesWalk || { page: 0, neverAgain: false };
  const page = Math.max(0, Math.min(RULES.length - 1, walk.page | 0));
  const last = page === RULES.length - 1;
  const text = RULES[page];
  return `
    <div class="rules-screen">
      <div class="rules-inner">
        <div class="center">
          <div class="rules-kicker">HOW HOPPER WORKS</div>
          <div class="rules-page-kicker">${esc(text.kicker)}</div>
          <div class="rules-title">${esc(text.title)}</div>
        </div>
        <div class="rules-art"><canvas data-rule-art="${esc(text.art)}" width="600" height="190"></canvas></div>
        <div class="rules-card">
          ${text.lines.map((line) => `<p>${esc(line)}</p>`).join('')}
        </div>
        <div class="rules-dots">
          ${RULES.map((_, i) => `<i class="${i === page ? 'on' : ''}"></i>`).join('')}
        </div>
        <label class="check"><input type="checkbox" data-input="rules-never" ${walk.neverAgain ? 'checked' : ''}> <span>Don't show these again</span></label>
        <div class="rules-controls">
          ${page > 0 ? logBtn('◀ BACK', 'rule-prev', { edge: 'dim', cls: 'small' }) : ''}
          ${logBtn(last ? 'START' : 'NEXT ▶', last ? 'rule-start' : 'rule-next', { edge: 'accent', cls: 'small' })}
          ${logBtn('SKIP', 'rule-skip', { edge: 'dim', cls: 'small' })}
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Overlays (the floating windows)
// ---------------------------------------------------------------------------

export function receiveSheet(app) {
  const w = app.w;
  const tab = app.receiveTab === 'ord' ? 'ord' : 'btc';
  const address = tab === 'ord' ? w.keys.frogAddress() : w.receiveAddress();
  const warning = tab === 'ord'
    ? { cls: 'green', text: '🐸 ONLY SEND HOPPERS HERE' }
    : { cls: 'red', text: "DON'T SEND HOPPERS HERE" };
  // Both notes are deliberately the same length and live in a fixed
  // three-line box: switching tabs must not resize the window.
  const note = tab === 'ord'
    ? 'Fixed Taproot address for Hoppers and inscriptions. Its sats never fund a mint or a send.'
    : 'Fresh address — rotates after it is paid. Ordinary Bitcoin only; these sats fund mints and sends.';
  return `
    <div class="receive-warning ${warning.cls}" data-warning="${tab}">
      <span>${esc(warning.text)}</span>
      <button class="receive-x" data-action="close-overlay" aria-label="close">✖</button>
    </div>
    <div class="receive-tabs" role="tablist" aria-label="receive address kind">
      <button class="receive-tab ${tab === 'btc' ? 'on' : ''}" role="tab" aria-selected="${tab === 'btc'}" data-action="receive-tab" data-tab="btc">BITCOIN</button>
      <button class="receive-tab ${tab === 'ord' ? 'on' : ''}" role="tab" aria-selected="${tab === 'ord'}" data-action="receive-tab" data-tab="ord">HOPPERS</button>
    </div>
    <div class="qr-wrap">
      <canvas class="qr-canvas" data-qr="${esc(address)}" width="260" height="260" role="img" aria-label="QR code for ${esc(address)}"></canvas>
    </div>
    <div class="receive-address wrap">${esc(address)}</div>
    <div class="receive-note">${esc(note)}</div>
    <div class="receive-actions">
      ${logBtn('📋 COPY', 'copy', { edge: 'dim', cls: 'small', attrs: `data-text="${esc(address)}"` })}
      ${logBtn('⛶ FULL QR', 'full-qr', { edge: 'dim', cls: 'small', attrs: `data-text="${esc(address)}"` })}
    </div>
    <div class="receive-book-row">
      ${tab === 'btc'
        ? `${logBtn('✚ NEW ADDRESS', 'new-receive', { edge: 'accent', cls: 'small' })}
           ${logBtn('USED ADDRESSES', 'receive-book', { edge: 'dim', cls: 'small' })}`
        : '<span class="receive-book-note">Fixed Taproot address · no rotation</span>'}
    </div>
    <div class="sep"></div>
    <div class="sub">${tab === 'btc' ? 'BIP84 P2WPKH' : 'BIP86 P2TR'} · ${esc(w.network)}</div>`;
}

export function qrSheet(app, address) {
  return `
    <div class="row"><h2>SCAN TO RECEIVE</h2><div class="spacer"></div>${logBtn('✖', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="qr-wrap qr-wrap-full">
      <canvas class="qr-canvas" data-qr="${esc(address)}" width="300" height="300" role="img" aria-label="QR code for ${esc(address)}"></canvas>
    </div>
    <div class="receive-address wrap">${esc(address)}</div>
    <div class="mt14">${logBtn('📋 COPY ADDRESS', 'copy', { edge: 'accent', cls: 'block', attrs: `data-text="${esc(address)}"` })}</div>`;
}

export function receiveBook(app) {
  const rows = app.w.receiveAddresses();
  return `
    <div class="row"><h2>ADDRESSES THIS WALLET USED</h2><div class="spacer"></div>${logBtn('✖', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="sub">Every Bitcoin receive address this wallet generated — newest first. The frogs' address is one fixed thing and is not in this rotation.</div>
    <div class="sep"></div>
    ${rows.length ? rows.map((r) => `
      <div class="address-row">
        <div class="row">
          <span class="tiny strong">BITCOIN #${r.index}${r.current ? ' · CURRENT' : ''}</span>
          <div class="spacer"></div>
          <span class="tiny ${r.sats ? 'good' : 'muted'}">${r.sats ? `${sats(r.sats)} sats` : 'empty'}</span>
        </div>
        <div class="wrap small">${esc(r.address)}</div>
        <div class="row tiny muted">
          <span>${r.used ? 'used' : 'never paid'}</span>
          <div class="spacer"></div>
          <button class="copy" data-action="copy" data-text="${esc(r.address)}">COPY</button>
        </div>
      </div>`).join('') : '<div class="muted small">no addresses have been generated yet</div>'}
    <div class="lane-dashes" aria-hidden="true"></div>`;
}

function feeAge(ts) {
  if (!ts) return 'not fetched';
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 8) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  return `${Math.round(secs / 60)}m ago`;
}

export function feeSourceText(app) {
  const q = app?.feeQuote;
  if (q?.status === 'loading') return `${FEE_SOURCE} · fetching…`;
  if (q?.status === 'error') return `${FEE_SOURCE} · unavailable`;
  if (q?.status === 'ready') return `${FEE_SOURCE} · ${feeAge(q.fetchedAt)}`;
  return `${FEE_SOURCE} · ready on open`;
}

export function feeNoteText(app) {
  const q = app?.feeQuote;
  if (q?.status === 'error') return 'Recommendations could not be fetched. The rate below still works manually.';
  if (q?.status === 'loading') return 'Fetching fastestFee, halfHourFee and economyFee.';
  if (q?.status === 'ready') {
    const below = feeRecommendations(q).some((r) => r.rate != null && r.rate < 1);
    return below
      ? 'API values below 1 sat/vB are raised to this wallet\'s 1 sat/vB relay floor. The field stays editable.'
      : 'Tap a band or type any rate. The field stays editable.';
  }
  return 'Fast, Medium and Slow fill the field; you can always type another rate.';
}

export function feePresets(app, input) {
  const q = app?.feeQuote;
  if (q?.status === 'loading') {
    return '<div class="fee-presets-loading">fetching fastestFee / halfHourFee / economyFee…</div>';
  }
  if (q?.status === 'error') {
    return `<div class="fee-presets-error"><span>mempool.space unavailable</span><button class="copy" data-action="fee-retry">RETRY</button></div>`;
  }
  if (q?.status !== 'ready') {
    return '<div class="fee-presets-loading">open the transaction window to fetch fees…</div>';
  }
  return feeRecommendations(q).map((r) => {
    const value = usableFeeRate(r.rate);
    return `<button class="fee-choice" data-action="fee-choice" data-target="${esc(input)}" data-rate="${value}" title="mempool.space ${r.key}">
      <b>${r.label}</b><span>${esc(feeRateLabel(r.rate))}</span><small>${esc(r.hint)}</small>
    </button>`;
  }).join('');
}

export function feePicker(app, { input, value = app.settings.feeRate, label = 'Fee rate' } = {}) {
  return `
    <div class="fee-picker" data-fee-picker>
      <div class="fee-picker-head">
        <span>${esc(label)}</span>
        <span class="tiny muted" data-fee-source>${esc(feeSourceText(app))}</span>
      </div>
      <div class="fee-presets" data-fee-presets data-fee-for="${esc(input)}">${feePresets(app, input)}</div>
      <label class="field mt6"><span>Custom rate (sat/vB)</span>
        <input type="number" min="1" max="1000" step="any" inputmode="decimal" data-input="${esc(input)}" value="${esc(value)}">
      </label>
      <div class="hint" data-fee-note>${esc(feeNoteText(app))}</div>
    </div>`;
}

export function sendSheet(app) {
  return `
    <div class="row"><h2>SEND</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="sub">Ordinary Bitcoin. Never touches a frog card.</div>
    <label class="field"><span>Recipient</span><input type="text" data-input="send-to" placeholder="${esc(app.w.network === 'mainnet' ? 'bc1…' : 'bcrt1… / tb1…')}"></label>
    <label class="field"><span>Amount (sats)</span><input type="number" data-input="send-amount" min="546" value="10000"></label>
    <div class="hint">Spendable: ${sats(app.w.balance.spendable)} sats. Fees come from the tail of the change.</div>
    ${feePicker(app, { input: 'send-fee' })}
    <div class="mt14">${logBtn('PREVIEW TRANSACTION', 'preview-send', { edge: 'accent', cls: 'block' })}</div>`;
}

export function txPreviewSheet(app, p) {
  const hopper = p.kind === 'transfer';
  const mint = p.kind === 'mint';
  const title = mint ? 'REVIEW MINT' : 'REVIEW TRANSACTION';
  const subtitle = mint
    ? 'MINT HOPPER · nothing is broadcast until you approve.'
    : `${hopper ? 'SEND HOPPER' : 'SEND BITCOIN'} · nothing is broadcast until you approve.`;
  const changeRow = (label, address, amount) => (address
    ? `<dt>${esc(label)}</dt><dd class="tiny wrap">${esc(address)}</dd>
       <dt>${esc(label)} amount</dt><dd>${sats(amount)} sats</dd>`
    : `<dt>${esc(label)}</dt><dd>none — no change output</dd>`);
  const feeRate = mint && Number(p.revealFeeRate) !== Number(p.feeRate)
    ? `${feeRateLabel(p.feeRate)} commit / ${feeRateLabel(p.revealFeeRate)} reveal`
    : feeRateLabel(p.feeRate);
  const rows = mint ? `
      <dt>Hopper</dt><dd>${esc(p.mintName || 'UNNAMED')}</dd>
      <dt>Seed</dt><dd>${esc(seedText(p.seed))}</dd>
      <dt>Frog address</dt><dd class="tiny wrap">${esc(p.destinationAddress || p.to)}</dd>
      <dt>Frog amount</dt><dd>${sats(p.destinationAmount)} sats + 0-sat envelope</dd>
      <dt>Commit txid</dt><dd class="tiny wrap">${esc(p.commitTxid || p.built.commit.txid)}</dd>
      <dt>Reveal txid</dt><dd class="tiny wrap">${esc(p.revealTxid || p.built.reveal.txid)}</dd>
      ${changeRow('Commit change', p.changeAddress, p.changeAmount)}
      ${changeRow('Reveal change', p.revealChangeAddress, p.revealChangeAmount)}
      <dt>Commit fee</dt><dd>${sats(p.commitFee ?? p.built.commit.fee)} sats · ${sats(p.commitVsize ?? p.built.commit.vsize)} vB</dd>
      <dt>Reveal fee</dt><dd>${sats(p.revealFee ?? p.built.reveal.fee)} sats · ${sats(p.revealVsize ?? p.built.reveal.vsize)} vB</dd>
      <dt>Total actual fee</dt><dd>${sats(p.fee)} sats</dd>
      <dt>Total size</dt><dd>${sats(p.vsize || (Number(p.commitVsize) + Number(p.revealVsize)) || 0)} vB · 2 transactions</dd>
      <dt>Fee rate</dt><dd>${esc(feeRate)}</dd>` : `
      <dt>Destination address</dt><dd class="tiny wrap">${esc(p.to)}</dd>
      <dt>Destination amount</dt><dd>${sats(p.destinationAmount)} sats</dd>
      <dt>Change address</dt>${p.changeAddress
        ? `<dd class="tiny wrap">${esc(p.changeAddress)}</dd>`
        : '<dd>none — this transaction has one output</dd>'}
      <dt>Change amount</dt><dd>${sats(p.changeAddress ? p.changeAmount : 0n)} sats</dd>
      ${p.usesUnconfirmed ? '<dt>Funding</dt><dd>includes unconfirmed mempool sats</dd>' : ''}
      <dt>Fee rate</dt><dd>${esc(feeRate)}</dd>
      <dt>Actual fee</dt><dd>${sats(p.fee)} sats</dd>
      <dt>Transaction size</dt><dd>${sats(p.built.vsize || 0)} vB</dd>`;
  const warning = mint
    ? `<b>APPROVING BROADCASTS BOTH TRANSACTIONS.</b><br>
      The commit is broadcast first. The reveal spends that commit and creates the Hopper. The
      wallet rechecks the anchor and funding inputs before either goes out. Cancel leaves the
      wallet untouched and puts nothing in the mempool.`
    : `<b>APPROVING BROADCASTS THIS TRANSACTION.</b><br>
      The wallet rechecks the inputs first, then broadcasts this exact signed
      transaction. Cancel leaves the wallet untouched and puts nothing in the mempool.`;
  return `
    <div class="row"><h2>${title}</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="sub">${subtitle}</div>
    <div class="stat-grid mt10">${rows}
    </div>
    <div class="warnbox mt10">${warning}</div>
    <div class="hint">Actual fee is what these signed transactions pay, not an estimate. Effective rate:
      ${esc(feeRateLabel(p.effectiveFeeRate))}.${mint ? ' The reveal cannot confirm before its commit.' : ''}${p.usesUnconfirmed ? ' Some funding is unconfirmed, so this transaction can only confirm after its parent.' : ''}</div>
    <div class="actions mt14">
      ${logBtn('CANCEL', 'abort-preview', { edge: 'dim', cls: 'small' })}
      ${logBtn('APPROVE & BROADCAST', 'do-approve-tx', { edge: 'accent' })}
    </div>`;
}

export function bumpFeeSheet(app, action) {
  const r = action.rbf;
  const oldRate = Number(r.fee) / Math.max(1, Number(r.vsize));
  const suggested = Math.max(1, Math.floor(oldRate) + 1, Math.ceil(Number(app.settings.feeRate) || 1));
  return `
    <div class="row"><h2>⛽ BUMP FEE</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="sub">Replace one unconfirmed plain send. The original outputs are preserved exactly.</div>
    <div class="stat-grid mt10">
      <dt>Original txid</dt><dd class="tiny wrap">${esc(action.txid)}</dd>
      <dt>Original fee</dt><dd>${sats(r.fee)} sats · ${oldRate.toFixed(1)} sat/vB</dd>
      <dt>Size</dt><dd>${sats(r.vsize)} vB</dd>
      <dt>Bumps so far</dt><dd>${action.bumps || 0}</dd>
    </div>
    <div class="warnbox mt10">
      <b>NO KNOWN HOPPER OR ORDINAL-BEARING COIN IS ELIGIBLE.</b><br>
      The replacement keeps every existing output — including the change — at the same script and
      exactly the same value. It adds one or more separate confirmed BIP84 funding coins and one
      new change output. The higher fee comes only from those added coins, never from an existing
      output or a Hopper card. This guard uses the wallet's current Hopper/indexer view.
    </div>
    ${feePicker(app, { input: 'bump-fee-rate', value: suggested, label: 'New fee rate' })}
    <div class="hint">The wallet raises this to at least one sat/vB above the original and enforces BIP125's incremental-relay margin. Only one replacement can win: if the original confirms first, this bump is rejected and the original stays.</div>
    <div class="actions mt14">
      ${logBtn('CANCEL', 'close-overlay', { edge: 'dim', cls: 'small' })}
      ${logBtn('REPLACE TRANSACTION', 'do-bump', { edge: 'accent', attrs: `data-txid="${esc(action.txid)}"` })}
    </div>`;
}

export function transferSheet(app, f) {
  return `
    <div class="row"><h2>TRANSFER ${esc(f.name || '')}</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="sub">No inscription, no state change. The Hopper walks to an ordinary address.</div>
    <div class="stat-grid mt10">
      <dt>Sat</dt><dd>${sats(f.sat)}</dd>
      <dt>State</dt><dd>${esc(String(f.state || '').toUpperCase())}</dd>
    </div>
    <label class="field"><span>Recipient address</span><input type="text" data-input="transfer-to" placeholder="bcrt1…"></label>
    <div class="hint">The recipient can stage it on The Road again with TRAVEL TO ROAD.</div>
    ${feePicker(app, { input: 'transfer-fee' })}
    <div class="mt14">${logBtn('PREVIEW TRANSACTION', 'preview-transfer', { edge: 'accent', cls: 'block', attrs: `data-sat="${f.sat}"` })}</div>`;
}

export function crossSheet(app, f) {
  const tip = app.w.tipHeight || 0;
  const target = requiredAt(tip + 1);
  const gen = Number(f.gen) || generationAt(f.mint_height ?? tip);
  return `
    <div class="row"><h2>HOP ${esc(f.name || '')}</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="sub">Choose a direction. The next block picks one direction for <b>every</b> Hopper; a Hopper that picked it dies.</div>
    <div class="stat-grid mt10">
      <dt>Generation</dt><dd>G${gen}</dd>
      <dt>Current dist</dt><dd>${f.dist}</dd>
      <dt>Target at T</dt><dd>${target} hops</dd>
      <dt>Hop risk</dt><dd>${(hopDeathBps() / 100).toFixed(2)}% roadkill (one of three)</dd>
      <dt>Settlement</dt><dd>T+6 blocks</dd>
    </div>
    <label class="field"><span>New owner P2TR address (optional)</span><input type="text" data-input="cross-owner" placeholder="leave empty to keep in this wallet"></label>
    ${feePicker(app, { input: 'cross-fee', label: 'Hop fee rate' })}
    <div class="mt14" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">
      ${['⬅ LEFT', '⬆ STRAIGHT', '➡ RIGHT'].map((label, dir) => logBtn(label, 'preview-hop', {
    edge: dir === 1 ? 'accent' : 'dim', cls: 'block',
    attrs: `data-sat="${f.sat}" data-dir="${dir}"`,
  })).join('')}
    </div>
    <div class="hint mt10">Choosing a direction builds the exact signed transaction: it selects the leaf spent and the byte the body inscribes. You will review the destination, change and fee before anything is broadcast.</div>`;
}

/** The signed HOP, ready to approve: direction, destination, change, fee
 *  (SPEC §3.6). Nothing here can change after this preview. */
export function hopReviewSheet(app, p) {
  const direction = ['LEFT', 'STRAIGHT', 'RIGHT'][p.dir];
  const tip = app.w.tipHeight || 0;
  const target = requiredAt(tip + 1);
  const gen = p.gen || generationAt(tip);
  return `
    <div class="row"><h2>HOP ${direction}</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="sub">This is the preview. The direction and the leaf are fixed: approving broadcasts exactly this signed transaction.</div>
    <div class="stat-grid mt10">
      <dt>Direction</dt><dd>${direction} (dir ${p.dir})</dd>
      <dt>Leaf spent</dt><dd class="tiny wrap">${esc(p.leafHex)}</dd>
      <dt>Generation</dt><dd>G${gen} · dist ${p.dist}</dd>
      <dt>Target at T</dt><dd>${target} hops</dd>
      <dt>Hop risk</dt><dd>${(hopDeathBps() / 100).toFixed(2)}% roadkill (one of three)</dd>
      <dt>Destination address</dt><dd class="tiny wrap">${esc(p.to)}</dd>
      <dt>Destination amount</dt><dd>${sats(p.destinationAmount)} sats</dd>
      <dt>Change address</dt><dd class="tiny wrap">${esc(p.changeAddress || 'none — no change output')}</dd>
      <dt>Change amount</dt><dd>${sats(p.changeAddress ? p.changeAmount : 0n)} sats</dd>
      <dt>Fee rate</dt><dd>${esc(feeRateLabel(p.feeRate))}</dd>
      <dt>Actual fee</dt><dd>${sats(p.fee)} sats</dd>
      <dt>Transaction size</dt><dd>${sats(p.vsize || 0)} vB</dd>
      <dt>Settlement</dt><dd>T+6 blocks</dd>
    </div>
    <div class="warnbox mt10"><b>APPROVING BROADCASTS THIS EXACT SIGNED TRANSACTION.</b><br>
      The wallet rechecks the Hopper output and every funding input first, then broadcasts these
      bytes. The direction is already in the leaf and the body; no later screen can change it.
      Cancel leaves the wallet untouched and puts nothing in the mempool.</div>
    <div class="hint">The next block picks one direction for every Hopper. If it picks ${direction}, this Hopper dies; any other direction and it survives.</div>
    <div class="actions mt14">
      ${logBtn('CANCEL', 'abort-preview', { edge: 'dim', cls: 'small' })}
      ${logBtn(`CONFIRM HOP ${direction}`, 'do-approve-tx', { edge: 'accent' })}
    </div>`;
}

export function emergencyWarning() {
  return `
    <div class="row"><h2>Emergency descriptors</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="sub">This document describes how each staged Hopper's taproot output is built, so another taproot-capable tool can spend it if this wallet is gone.</div>
    <div class="stat-grid mt10">
      <dt>Contains</dt><dd>leaves, control blocks, output keys, owner path, fingerprint</dd>
      <dt>Never contains</dt><dd>seed words, xprv, private keys</dd>
      <dt>Still public</dt><dd>yes — it describes your holdings</dd>
    </div>
    <div class="hint">The 12 words remain the only key backup. Hand this out only to a tool you trust, and never share it in public.</div>
    <div class="mt14">${logBtn('SHOW THE EXPORT', 'show-emergency', { edge: 'accent', cls: 'block' })}</div>`;
}

export function emergencySheet(app, doc) {
  const json = JSON.stringify(doc, null, 2);
  // A QR version-40/M code holds 2,331 bytes. The full document is far
  // larger once a Hopper has three 161-byte leaves; the QR therefore
  // carries the compact document when it fits, or the one-Hopper layout
  // summary (descriptor + outpoint) when it does not. The JSON is always
  // authoritative.
  const compact = JSON.stringify(doc);
  let qrPayload = compact.length <= 2300 ? compact : null;
  let qrNote = '';
  if (!qrPayload && (doc.frogs || []).length === 1) {
    const f = doc.frogs[0];
    qrPayload = JSON.stringify({
      type: doc.type, version: doc.version, network: doc.network,
      fingerprint: doc.fingerprint, owner_path: doc.owner_path,
      generated_at: doc.generated_at, tip_height: doc.tip_height,
      frog: {
        sat: f.sat, mint_id: f.mint_id, state_outpoint: f.state_outpoint,
        state_value: f.state_value, descriptor: f.descriptor,
      },
    });
    qrNote = 'The QR carries the layout summary; the JSON above is authoritative.';
  }
  const qrFit = qrPayload && qrPayload.length <= 2300;
  const qr = qrFit
    ? `<canvas class="qr-canvas" data-qr="${esc(qrPayload)}" width="260" height="260" role="img" aria-label="QR code for the emergency descriptors"></canvas>`
    : '<div class="hint">The export is too large for one QR. Copy the JSON instead.</div>';
  const staged = (doc.frogs || []).filter((f) => f.state_outpoint).length;
  return `
    <div class="row"><h2>Emergency descriptors</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="sub">${staged} staged Hopper${staged === 1 ? '' : 's'} · tip ${sats(doc.tip_height)} · generated ${esc(doc.generated_at)}</div>
    <div class="hint">Snapshot only: every HOP, PREPARE or TRANSFER changes a state outpoint. A tool that sees a spent outpoint must discard the entry.</div>
    <div class="mt10">${qr}</div>
    ${qrFit && qrNote ? `<div class="hint">${esc(qrNote)}</div>` : ''}
    <pre class="emergency-json" data-emergency-json style="max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:11px">${esc(json)}</pre>
    <div class="actions mt10">
      <button class="copy" data-action="copy-emergency">COPY JSON</button>
      ${logBtn('CLOSE', 'close-overlay', { edge: 'dim', cls: 'small' })}
    </div>`;
}

export function recoverySheet(app, doc) {
  const packs = Array.isArray(doc?.packs) ? doc.packs : [];
  const json = JSON.stringify(doc, null, 2);
  return `
    <div class="row"><h2>Recovery packs</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="sub">${packs.length} saved pack${packs.length === 1 ? '' : 's'} · tip ${doc?.last_scan_tip == null ? '—' : sats(doc.last_scan_tip)} · updated ${esc(doc?.updated_at || '—')}</div>
    <div class="stat-grid mt10">
      <dt>Contains</dt><dd>leaves, control blocks, output keys, owner path, fingerprint, state outpoints</dd>
      <dt>Never contains</dt><dd>seed words, xprv, private keys</dd>
      <dt>History</dt><dd>previous layouts are kept; the newest state_outpoint in each pack is authoritative</dd>
    </div>
    <div class="hint">A pack is a snapshot of a staged output. After a HOP, PREPARE or TRANSFER, check that the on-chain script still matches the pack's newest entry before spending from it.</div>
    <pre class="emergency-json" data-recovery-json style="max-height:240px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:11px">${esc(json)}</pre>
    <div class="actions mt10">
      <button class="copy" data-action="copy-recovery">COPY JSON</button>
      ${logBtn('CLOSE', 'close-overlay', { edge: 'dim', cls: 'small' })}
    </div>`;
}

export function travelWarning(app, f) {
  const name = esc(f?.name || 'THIS HOPPER');
  const utxo = f ? app.w?._frogUtxo?.(f) : null;
  const staged = utxo?.kind === 'state';
  const unavailable = !utxo;
  return `
    <div class="row"><h2>🚦 TRAVEL TO ROAD</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="warnbox mt10">
      <b>${unavailable ? 'NO SPENDABLE OUTPUT.' : staged ? 'ALREADY STAGED.' : 'THIS IS A STAGING TRANSACTION.'}</b><br>
      ${unavailable
        ? `This wallet cannot find a spendable output for ${name} right now. Nothing will be signed or broadcast.`
        : staged
          ? `${name} is already in the HOPPER tapscript staging address used to play the game. No new transaction will be broadcast.`
          : `Approving moves ${name} into the HOPPER tapscript staging address used to play the game. It is not a hop: no road result starts yet.`}
    </div>
    <div class="stat-grid mt10">
      <dt>Hopper</dt><dd>${name}</dd>
      ${f ? `<dt>Sat</dt><dd>${sats(f.sat)}</dd>` : ''}
      <dt>State card</dt><dd>25,000 sats, still yours</dd>
      <dt>Broadcast</dt><dd>${unavailable ? 'unavailable' : staged ? 'none — already staged' : 'on approval'}</dd>
    </div>
    ${unavailable ? '' : `<div class="warnbox mt10"><b>NORMAL SPENDS ARE STILL POSSIBLE.</b><br>
      You can SEND or TRANSFER the Hopper normally from this tapscript address without hopping.
      Traveling to The Road only makes it ready for a future HOP. The 25,000-sat card stays
      yours; only the Bitcoin miner fee leaves the wallet.
    </div>`}
    <div class="hint">${unavailable ? 'Close this window and refresh the wallet after its scan finishes.' : 'The approval button is the last step. Nothing is signed or broadcast before it.'}</div>
    <div class="actions mt14">
      ${logBtn('CANCEL', 'close-overlay', { edge: 'dim', cls: 'small' })}
      ${f && !unavailable ? logBtn(staged ? 'GO TO THE ROAD' : '✓ APPROVE & TRAVEL', 'travel-approved', { edge: 'accent', attrs: `data-sat="${f.sat}"` }) : ''}
    </div>`;
}

export function seedWarning() {
  return `
    <div class="row"><h2>⚠ REVEAL BACKUP</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="warnbox bad mt10">
      <b>ANYONE WHO SEES THESE 12 WORDS OWNS THE WALLET.</b><br>
      They can move every sat and take every Hopper. The words are shown on this screen only —
      they are never sent to a server — but a person, camera, screen share or recording can still see them.
    </div>
    <div class="hint">Make sure nobody is watching. Never photograph the words, paste them into a website, or store them in a screenshot. Write them on paper and keep that paper offline.</div>
    <div class="actions mt14">
      ${logBtn('CANCEL', 'close-overlay', { edge: 'dim', cls: 'small' })}
      ${logBtn('✓ SHOW THE 12 WORDS', 'reveal-words-approved', { edge: 'accent' })}
    </div>`;
}

export function wordsModal(app) {
  const words = (app.w.mnemonic || '').trim().split(/\s+/);
  return `
    <div class="row"><h2>BACKUP</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="warnbox mt10">These 12 words are the only backup. Anyone who reads them owns every frog at this address. Write them on paper, never a screenshot.</div>
    <div class="words mt10">${words.map((word, i) => `<span><b>${i + 1}</b>${esc(word)}</span>`).join('')}</div>
    <div class="mt10">${logBtn('COPY WORDS', 'copy', { edge: 'dim', cls: 'small block', attrs: `data-text="${esc(words.join(' '))}"` })}</div>`;
}

export function deadFrogs(app) {
  const dead = (app.w.frogs || []).filter((f) => f.state === 'dead');
  return `
    <div class="row"><h2>💀 THE GRAVEYARD</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="sub">Dead hoppers are sorted here, off the living pond.</div>
    ${dead.length ? `<div class="pond-grid mt14">${dead.map((f) => `
      <div class="pond-item">
        <div class="pond-tap" data-action="bio" data-sat="${f.sat}" style="background:var(--water)">
          <canvas class="pond-art" data-pondfrog="${f.seed >>> 0}:dead" width="320" height="275"></canvas>
          <span class="pf-name">${esc(f.name || 'UNNAMED')}</span>
          <span class="pf-sub">DEAD 💀</span>
        </div>
      </div>`).join('')}</div>` : '<div class="sub mt14">No graves yet. The road is quiet tonight 🌙</div>'}`;
}
