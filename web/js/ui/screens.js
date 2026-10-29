// Screen templates — a JavaScript reimplementation of the FROGGER egui GUI
// (frogger-wallet-gui/src/app.rs). Pure string builders; main.js owns events
// and theme.js owns the painted materials.
//
// Screen map (same names in the drawer as the egui app):
//   WALLET · HISTORY · THE POND · THE ROAD · MINT · LEADERBOARD
//   DETAIL (one hopper) · BIO (one hopper's life story) · SETTINGS

import {
  btc, esc, frogImg, sats, seedText,
} from './dom.js';
import { requiredAt, deathBps, nextIncrement, paramsHashHex } from '../core/params.js';
import { deriveTraits } from '../core/art.js';
import {
  C, RARITY_NAMES, frogMarkSvg, rarityColor,
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

function chip(text, tone = 'dim') {
  return `<span class="chip-ui ${esc(tone)}">${esc(text)}</span>`;
}

const LIFE = {
  idle: ['IDLE', 'dim'],
  crossing: ['CROSSING', 'accent'],
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

function pips(dist) {
  const n = Math.max(0, Math.min(5, Number(dist) || 0));
  const dots = Array.from({ length: 5 }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
  return `<span class="pips">${dots}<b>×${Number(dist) || 0}</b></span>`;
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
      ${item('pond', '🐸 THE POND')}
      ${item('road', '🚦 THE ROAD')}
      ${item('mint', '✨ MINT')}
      ${item('leaders', '🏆 LEADERBOARD')}
      ${item('settings', '⚙ SETTINGS')}
    </div>
    <div class="slider-row"><span>VOLUME</span><span data-volume-pct>${Math.round((w?.settings?.volume ?? app.settings.volume) * 100)}%</span></div>
    <div class="track" data-volume-track>
      <div class="fill" data-volume-fill style="width:${Math.round((w?.settings?.volume ?? app.settings.volume) * 100)}%"></div>
      <div class="thumb" data-volume-thumb style="left:calc(${Math.round((w?.settings?.volume ?? app.settings.volume) * 100)}% - 3px)"></div>
    </div>
    <div class="stack mt14">
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

    ${Number(b.unspendable) > 0 ? `
      <div class="notice-bar">⚠ ${sats(b.unspendable)} sats of this balance have no known sat ranges yet — they are counted here but cannot be spent until an ord server (or an indexer) names their sats.</div>` : ''}

    <div class="mt14 action-row">
      ${logBtn('📤 SEND', 'sheet-send', { edge: 'accent', cls: 'send' })}
      ${logBtn('QR', 'qr', { edge: 'dim', cls: 'qr' })}
      ${logBtn('📥 RECEIVE', 'sheet-receive', { edge: 'home', cls: 'receive' })}
    </div>

    ${alive.length ? `
    <div class="water-box send-hoppers">
      <canvas class="pond-water" data-pond-water></canvas>
      <div class="box-title">SEND HOPPERS</div>
      <div class="box-sub">Move a frog to any address by spending its sat — ordinary bitcoin movement, no envelope.</div>
      <div class="pond-grid">
        ${alive.map((f) => pondItem(app, f, { mode: 'wallet' })).join('')}
      </div>
      ${app.frogRefusal ? `<div class="refusal">${esc(app.frogRefusal)}</div>` : ''}
      <div class="road-edge bleed" data-action="dead-frogs" role="button" aria-label="dead hoppers">
        <canvas class="grave-art" data-grave width="45" height="56"></canvas>
      </div>
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
  const name = esc(f.name || 'UNNAMED');
  let action = '';
  if (pending) {
    action = '<span class="tiny muted">✏ INSCRIBING</span>';
  } else if (crossing && mode !== 'road') {
    action = logBtn('🚫 ON ROAD', 'on-road', { edge: 'dim', cls: 'small' });
  } else if (mode === 'road') {
    // HOPPER custody: a minted frog still sits in its mint output and must
    // be PREPAREd into the 25,000-sat state output before a crossing can
    // be signed. The egui app's one-tap CROSS is preserved for frogs that
    // are already in custody.
    const utxo = app.w._frogUtxo?.(f);
    action = utxo?.kind === 'state'
      ? logBtn('🚦 CROSS', 'sheet-cross', { edge: 'accent', cls: 'small', attrs: `data-sat="${f.sat}"` })
      : logBtn('PREPARE', 'prepare', { edge: 'accent', cls: 'small', attrs: `data-sat="${f.sat}"` });
  } else if (mode === 'wallet' || mode === 'pond') {
    action = logBtn('SEND', 'sheet-transfer', { edge: 'accent', cls: 'small', attrs: `data-sat="${f.sat}"` });
  }
  const sub = pending
    ? '<span class="tiny muted">✏ INSCRIBING</span>'
    : mode === 'pond'
      ? `<span style="color:${rarityColor(rarityOf(f))}">${esc(rarityOf(f))}</span>`
      : mode === 'road'
        ? '<span class="tiny muted">inscribed on Bitcoin</span>'
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
        <div class="box-title">Start a crossing</div>
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
  return `
    <div class="pond-item road-entry">
      <div class="pond-tap" data-action="open-frog" data-sat="${c.sat}">
        <canvas class="pond-art" data-roadfrog="${seed >>> 0}" width="320" height="275"></canvas>
        <span class="pf-name">${esc(name)}</span>
        <span class="pf-sub">${pips(c.dist)}</span>
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
    <div class="sub">Every wallet transaction — sends, receives, mints and road actions. Newest first.</div>
    <div class="mt14">
      ${rows.length ? rows.map((r) => txRow(app, r)).join('') : '<div class="sub">No transactions yet — they appear here as you use the wallet.</div>'}
    </div>`;
}

function historyRows(w) {
  const rows = [];
  for (const e of w.history || []) {
    rows.push({
      kind: String(e.kind || e.action || 'chain').toLowerCase(),
      height: e.height ?? null,
      txid: e.txid || null,
      sat: e.payload?.frogger_sat ?? e.payload?.sat ?? null,
      seed: e.payload?.seed,
      name: e.payload?.name,
      outcome: e.payload?.outcome ?? null,
      at: null,
      chain: true,
    });
  }
  for (const a of w.actions || []) {
    rows.push({
      kind: String(a.kind || 'action').toLowerCase(),
      height: a.height ?? null,
      txid: a.txid || null,
      sat: a.sat ?? null,
      seed: a.seed,
      name: a.name,
      amount: a.amount,
      to: a.to,
      at: a.at,
      chain: false,
      outcome: null,
    });
  }
  const seen = new Set();
  return rows
    .filter((r) => {
      const k = `${r.kind}:${r.txid || ''}:${r.sat ?? ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => {
      const ah = a.height ?? -1;
      const bh = b.height ?? -1;
      if (ah !== bh) return bh - ah;
      return String(b.at || '').localeCompare(String(a.at || ''));
    });
}

const KIND_LABEL = {
  mint: 'MINT', prepare: 'PREPARE', cross: 'CROSS', settle: 'SETTLE',
  transfer: 'TRANSFER', burn: 'BURN', send: 'SEND', receive: 'RECEIVE',
  faucet: 'RECEIVE', chain: 'CHAIN',
};

function txRow(app, r) {
  const w = app.w;
  const f = r.sat != null ? w.frogBySat(r.sat) : null;
  const seed = r.seed ?? f?.seed;
  const name = r.name || f?.name;
  let icon;
  if (r.kind === 'send' || r.kind === 'transfer') {
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

  const detail = [];
  if (r.sat != null) detail.push(`sat ${sats(r.sat)}`);
  if (r.kind === 'settle' && r.outcome) detail.push(String(r.outcome).toUpperCase());
  if (r.to) detail.push(`to ${truncTxid(r.to)}`);
  if (r.name && r.kind !== 'send') detail.push(String(r.name));

  let amount = '';
  if (r.kind === 'send' && r.amount != null) {
    amount = `<span class="tx-amt out">-${sats(r.amount)} sats</span>`;
  } else if (Number(r.amount) > 0) {
    amount = `<span class="tx-amt in">+${sats(r.amount)} sats</span>`;
  } else if (r.kind === 'settle' && String(r.outcome || '').toLowerCase() === 'dead') {
    amount = '<span class="tx-amt out">roadkill is forever</span>';
  } else {
    amount = '<span class="tx-amt dim">amount unknown</span>';
  }

  const state = r.height != null
    ? `<span class="tiny muted">⬛ ${sats(r.height)}</span>`
    : chip(r.at ? 'PENDING' : 'PENDING', 'accent');

  return `
    <div class="card-row" ${r.sat != null ? `data-action="open-frog" data-sat="${r.sat}" style="cursor:pointer"` : ''}>
      <div class="tx-row">
        <div class="tx-icon">${icon}</div>
        <div class="tx-main">
          <div class="tx-top">
            <span class="kind">${esc(KIND_LABEL[r.kind] || String(r.kind).toUpperCase())}</span>
            <span class="txid">${esc(truncTxid(r.txid))}</span>
          </div>
          ${detail.length ? `<div class="tx-detail">${esc(detail.join(' · '))}</div>` : ''}
          <div class="tx-bottom">
            ${amount}
            <span class="spacer"></span>
            <span class="tx-state">${state}</span>
          </div>
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
  const bps = deathBps(target);
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
            ${logBtn('MINT!', 'mint', { edge: 'accent', cls: '', attrs: `${app.busy || !coin ? 'disabled' : ''}` })}
          </div>
          <div class="hint">Rarity is cosmetic — it never affects crossing odds. Fair by design.</div>
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
          <dt>Next rise</dt><dd>${next ? `H ${sats(next[0])} → ${next[1]} hops` : 'capped at 100'}</dd>
          <dt>Death at target</dt><dd>${(bps / 100).toFixed(2)}%</dd>
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
    <div class="sub">Every Hopper the Hopper indexer has seen, ranked by distance.</div>
    <div class="mt14">
      ${rows.length ? rows.map((r) => {
    const mine = app.w.frogs.some((f) => Number(f.sat) === Number(r.sat));
    return `
          <div class="leader-row" data-action="open-frog" data-sat="${r.sat}">
            <span class="rank">#${r.rank}</span>
            <span class="name">${esc(shortName(r.name))}${mine ? ' <span class="chip-ui accent">YOU</span>' : ''}</span>
            <span class="hops">${r.dist} hops</span>
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
  const canBurn = owned && !!utxo && !['burned', 'retired'].includes(f.state);
  const target = requiredAt((w.tipHeight || 0) + 1);
  const body = f.mint_txid ? `${f.mint_txid}i${f.mint_index ?? 0}` : f.inscription_id;
  const state = f.state || 'idle';

  return `
    ${backButton()}
    <div class="detail-head">
      ${frogImg(f.seed, SPRITE_STATE(f), 'sprite', f.name || '')}
      <div class="detail-info">
        <div class="detail-name">${esc(f.name || 'UNNAMED')}</div>
        ${logBtn('📜 BIO', 'bio', { edge: 'dim', cls: 'small', attrs: `data-sat="${f.sat}"` })}
        <div class="mt10">${pips(f.dist)}</div>
        <div class="row mt6">
          ${chip(rarityOf(f), rarityClass(f))}
          ${lifeChip(state)}
        </div>

        <div class="stat-grid mt14">
          <dt>Crossings completed</dt><dd>${Number(f.dist) || 0}</dd>
          <dt>Road entries</dt><dd>${Number(f.crossings_entered) || 0}</dd>
          <dt>Seed</dt><dd>${(Number(f.seed) >>> 0).toString(16).toUpperCase().padStart(8, '0')}</dd>
          <dt>Hopper sat</dt><dd>${sats(f.sat)}</dd>
          <dt>Next hop target</dt><dd>${target} hops</dd>
          <dt>Next hop risk</dt><dd>${(deathBps(target) / 100).toFixed(2)}% roadkill</dd>
          <dt>Inscription</dt><dd class="tiny wrap">${esc(body || (f.commit_pending ? 'inscribing…' : '—'))}</dd>
        </div>

        <div class="mt14">
          ${state === 'idle' && !f.commit_pending ? (canCross
    ? logBtn('🚦 CROSS THE ROAD', 'sheet-cross', { edge: 'accent', attrs: `data-sat="${f.sat}"` })
    : canPrepare
      ? logBtn('PREPARE CUSTODY', 'prepare', { edge: 'accent', attrs: `data-sat="${f.sat}"` })
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
          ${canBurn ? logBtn('BURN', 'burn', { edge: 'dead', cls: 'small danger', attrs: `data-sat="${f.sat}"` }) : ''}
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
        <dt>Target at T</dt><dd>${f.in_flight ? f.in_flight.target_hops : (f.last_target_hops != null ? `${f.last_target_hops} (last)` : '— no crossing')}</dd>
        <dt>Required at next</dt><dd>${requiredAt((w.tipHeight || 0) + 1)} hops</dd>
        <dt>Death table now</dt><dd>${(deathBps(requiredAt((w.tipHeight || 0) + 1)) / 100).toFixed(2)}%</dd>
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
        <div class="mt10">${pips(f.dist)}</div>
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

// ---------------------------------------------------------------------------
// Settings (HOPPER's own controls, in the FROGGER window material)
// ---------------------------------------------------------------------------

export function settings(app) {
  const w = app.w;
  const s = app.settings;
  const book = s.addressBook || [];
  return `
    ${heading('⚙ Settings')}
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
        <input type="text" data-input="esploraUrl" value="${esc(s.esploraUrl || '')}" placeholder="https://…">
        <label>Indexer</label>
        <input type="text" data-input="indexerUrl" value="${esc(s.indexerUrl || '')}" placeholder="http://…">
        <label>Electrum</label>
        <input type="text" data-input="electrumUrl" value="${esc(s.electrumUrl || '')}" placeholder="wss://…">
        <label>Fee rate</label>
        <input type="number" min="1" max="1000" data-input="fee-rate" value="${s.feeRate}">
        <label>Address gap</label>
        <input type="number" min="5" max="50" data-input="gap" value="${s.gap}">
        <label>Deep scan</label>
        <select data-input="deepScan">
          <option value="1" ${s.deepScan ? 'selected' : ''}>On</option>
          <option value="0" ${!s.deepScan ? 'selected' : ''}>Off</option>
        </select>
      </div>
      <div class="actions mt14">
        ${logBtn('TEST', 'test-backend', { edge: 'dim', cls: 'small' })}
        ${logBtn('APPLY', 'apply-backend', { edge: 'accent', cls: 'small' })}
      </div>
      <div class="hint">A live backend needs an indexer or ord server for sat ranges; Esplora alone can answer coins, not frog custody.</div>
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
        <input type="range" min="0" max="100" data-input="volume" value="${Math.round((s.volume ?? 0.55) * 100)}">
      </div>
    </div>

    <div class="window" data-lily="accent">
      <div style="font-weight:700">BACKUP</div>
      <div class="sub">The 12 words ARE the wallet. They never leave this device.</div>
      <div class="actions mt10">${logBtn('👁 REVEAL 12 WORDS', 'reveal-words', { edge: 'accent', cls: 'small' })}</div>
    </div>

    <div class="window" data-lily="accent">
      <div style="font-weight:700">THE RULES</div>
      <div class="sub">Eight pages: the sat, the road, the toll, the odds.</div>
      <div class="actions mt10">
        ${logBtn('📖 READ THE GAME RULES', 'open-rules', { edge: 'accent', cls: 'small' })}
        ${logBtn('▶ REPLAY THE INTRO', 'replay-intro', { edge: 'dim', cls: 'small' })}
      </div>
    </div>

    <div class="window" data-lily="${s.mode === 'demo' ? 'accent' : 'dim'}">
      <div style="font-weight:700">DEMO CHAIN</div>
      <div class="sub">${esc(w.network)} · the in-browser chain. Not Bitcoin.</div>
      <div class="actions mt10">
        ${logBtn('FAUCET', 'faucet', { edge: 'dim', cls: 'small' })}
        ${logBtn('MINE 1', 'mine', { edge: 'dim', cls: 'small', attrs: 'data-n="1"' })}
        ${logBtn('MINE 6', 'mine', { edge: 'dim', cls: 'small', attrs: 'data-n="6"' })}
        ${logBtn('RESET DEMO', 'reset-demo', { edge: 'dead', cls: 'small danger' })}
      </div>
    </div>

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

    <div class="footer">HOPPER v6 · WIRE 0x06 · ${esc(paramsHashHex().slice(0, 16))}…</div>`;
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
      'Crossing moves the Hopper: its coin is spent into a new output whose inscription records the next state. That is the whole game — one crossing, one state.',
      'You cannot take a Hopper back. A crossing is a spend: once it confirms, the old state is history.',
    ],
  },
  {
    kicker: '4 / 8',
    title: 'HOME',
    art: 'home',
    lines: [
      'A Hopper is home once it has survived the number of crossings the road asks, and no car can kill it after that.',
      'Distance is how many crossings it has survived; the leaderboard ranks Hoppers by it.',
    ],
  },
  {
    kicker: '5 / 8',
    title: 'THE TOLL',
    art: 'toll',
    lines: [
      'The road raises its toll with the block height: one more every 64 blocks since the Hopper genesis block, then every 144 until 50, then every 2,016 until 100, where it stops.',
      'Mint later and the road asks more of you.',
    ],
  },
  {
    kicker: '6 / 8',
    title: 'CARS AND DEATH',
    art: 'squish',
    lines: [
      'Whether a Hopper lives is not a choice and not a skill: the block that confirms the crossing already decides it. A dead Hopper is gone for good.',
      'The verdict settles a few blocks later, once the chain has buried it; until then the Hopper shows as crossing.',
    ],
  },
  {
    kicker: '7 / 8',
    title: 'THE ODDS',
    art: 'grave',
    lines: [
      'About one death in four at the start, one in fifteen at 25, one in thirty-four at 100.',
      'Fewer die per crossing later — but each Hopper must make more, so a path from scratch falls from about one in four to about one in twenty.',
      'Only ever cross a Hopper you can afford to lose.',
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
  const rows = [0, 1, 2].map((i) => w.keys.receive(i).address);
  const frogAddress = w.keys.frogAddress();
  return `
    <div class="row"><h2>RECEIVE</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="sub">BIP84 P2WPKH · ${esc(w.network)}</div>
    <div class="sep"></div>
    ${rows.map((a, i) => `
      <div class="mt10">
        <div class="tiny muted">${i === 0 ? 'MAIN' : `INDEX ${i}`}</div>
        <div class="wrap small">${esc(a)}</div>
        <button class="copy" data-action="copy" data-text="${esc(a)}">COPY</button>
      </div>`).join('')}
    <div class="mt10 tiny muted">FROG ADDRESS</div>
    <div class="wrap small">${esc(frogAddress)}</div>
    <button class="copy" data-action="copy" data-text="${esc(frogAddress)}">COPY</button>
    <div class="hint mt10">Coins arriving here are ordinary P2WPKH. A frog arrives as the anchor sat inside a coin; PREPARE re-enters custody.</div>`;
}

export function sendSheet(app) {
  return `
    <div class="row"><h2>SEND</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="sub">Ordinary Bitcoin. Never touches a frog card.</div>
    <label class="field"><span>Recipient</span><input type="text" data-input="send-to" placeholder="${esc(app.w.network === 'mainnet' ? 'bc1…' : 'bcrt1… / tb1…')}"></label>
    <label class="field"><span>Amount (sats)</span><input type="number" data-input="send-amount" min="546" value="10000"></label>
    <div class="hint">Spendable: ${sats(app.w.balance.spendable)} sats. Fees come from the tail of the change.</div>
    <div class="mt14">${logBtn('SEND', 'do-send', { edge: 'accent', cls: 'block' })}</div>`;
}

export function transferSheet(app, f) {
  return `
    <div class="row"><h2>TRANSFER ${esc(f.name || '')}</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="sub">No inscription, no state change. The frog walks to an ordinary address.</div>
    <div class="stat-grid mt10">
      <dt>Sat</dt><dd>${sats(f.sat)}</dd>
      <dt>State</dt><dd>${esc(String(f.state || '').toUpperCase())}</dd>
    </div>
    <label class="field"><span>Recipient address</span><input type="text" data-input="transfer-to" placeholder="bcrt1…"></label>
    <div class="hint">The recipient re-enters custody with PREPARE on their next action.</div>
    <div class="mt14">${logBtn('TRANSFER', 'do-transfer', { edge: 'accent', cls: 'block', attrs: `data-sat="${f.sat}"` })}</div>`;
}

export function crossSheet(app, f) {
  const target = requiredAt((app.w.tipHeight || 0) + 1);
  return `
    <div class="row"><h2>CROSS ${esc(f.name || '')}</h2><div class="spacer"></div>${logBtn('✕', 'close-overlay', { edge: 'dim', cls: 'icon' })}</div>
    <div class="sub">One inscription. One state output. The anchor sat at offset 0.</div>
    <div class="stat-grid mt10">
      <dt>Current dist</dt><dd>${f.dist}</dd>
      <dt>Target at T</dt><dd>${target} hops</dd>
      <dt>Death at target</dt><dd>${(deathBps(target) / 100).toFixed(2)}%</dd>
      <dt>Settlement</dt><dd>T+6 blocks</dd>
    </div>
    <label class="field"><span>New owner P2TR address (optional)</span><input type="text" data-input="cross-owner" placeholder="leave empty to keep this wallet"></label>
    <label class="field"><span>Fee rate (sat/vB)</span><input type="number" min="1" data-input="cross-fee" value="${app.settings.feeRate}"></label>
    <div class="mt14">${logBtn('CROSS', 'do-cross', { edge: 'accent', cls: 'block', attrs: `data-sat="${f.sat}"` })}</div>`;
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
