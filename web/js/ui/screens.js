// Screen templates. Pure string builders; main.js owns events.

import {
  btc, chip, esc, frogImg, frogProgress, sats, seedText, shortHash,
  stateLabel, targetOf, timeAgo,
} from './dom.js';
import {
  deathBps, paramsHashHex, requiredAt, completionBps, nextIncrement, foldParams,
} from '../core/params.js';

export function topbar(app) {
  const w = app.w;
  const tip = w?.tipHeight;
  const state = app.busy ? 'wait' : w ? 'ok' : 'bad';
  return `
  <header class="topbar">
    <div class="brand">
      <img src="${app.frogLogo}" alt="">
      <div><span class="word">HOPPER</span><span class="tag">THE POND ON BITCOIN</span></div>
    </div>
    <div class="spacer"></div>
    ${w ? `<span class="chip"><i class="dot ${state === 'ok' ? '' : state}"></i><b>${tip != null ? sats(tip) : '—'}</b><span class="tiny">HEIGHT</span></span>` : ''}
    <button class="icon-btn" data-action="drawer" aria-label="menu">☰</button>
  </header>`;
}

export function drawer(app) {
  const items = [
    ['wallet', '◈', 'Wallet'], ['pond', '🐸', 'The Pond'], ['road', '➜', 'The Road'],
    ['mint', '✦', 'Mint'], ['leaders', '♛', 'Leaderboard'], ['history', '≣', 'History'],
    ['rules', '?', 'Rules'], ['settings', '⚙', 'Settings'],
  ];
  return `
    <div class="row"><h2>HOPPER</h2><div class="spacer"></div>
      <button class="icon-btn" data-action="drawer-close" aria-label="close">✕</button></div>
    <div class="sub muted small">${app.w ? `${esc(app.w.network)} · ${esc(app.settings.mode)}` : ''}</div>
    <h3>Navigate</h3>
    <div class="nav">
      ${items.map(([view, icon, label]) => `<button data-action="nav" data-view="${view}" class="${app.view === view ? 'active' : ''}"><span>${icon}</span>${label}</button>`).join('')}
    </div>
    ${app.w ? `
    <h3>${esc(app.w.fingerprint || '')}</h3>
    <div class="small muted">12 words are the only backup.</div>
    <div class="sep"></div>
    <button class="btn ghost wide small" data-action="lock">LOCK WALLET</button>` : ''}
  `;
}

export function tabbar(app) {
  const items = [['wallet', '◈', 'Bank'], ['pond', '🐸', 'Pond'], ['road', '➜', 'Road'], ['mint', '✦', 'Mint'], ['settings', '⚙', 'More']];
  return items.map(([view, icon, label]) => `
    <button data-action="nav" data-view="${view}" class="${app.view === view ? 'active' : ''}">
      <span>${icon}</span><span>${label}</span>
    </button>`).join('');
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

export function wallet(app) {
  const w = app.w;
  const b = w.balance;
  const receive = w.keys.receive(0).address;
  const frogAddress = w.keys.frogAddress();
  const next = nextIncrement(w.tipHeight);
  return `
  <section class="panel lily">
    <div class="kicker">THE BANK</div>
    <div class="bank">
      <div class="total">${sats(b.total)} <small>sats</small>
        <div class="btc">${btc(b.total)} BTC</div>
      </div>
      <div class="spacer"></div>
      <span class="chip"><i class="dot ${app.settings.mode === 'demo' ? 'wait' : ''}"></i>${esc(app.settings.mode.toUpperCase())}</span>
    </div>
    <div class="split">
      <div class="stat"><b>${sats(b.spendable)}</b><span>spendable</span></div>
      <div class="stat"><b>${sats(b.cards)}</b><span>frog cards</span></div>
      <div class="stat"><b>${sats(b.unspendable)}</b><span>unattributable</span></div>
    </div>
    <div class="actions" style="margin-top:14px">
      <button class="btn primary" data-action="nav" data-view="mint">✦ MINT</button>
      <button class="btn" data-action="sheet-receive">RECEIVE</button>
      <button class="btn" data-action="sheet-send">SEND</button>
      ${app.settings.mode === 'demo' ? '<button class="btn ghost" data-action="faucet">FAUCET</button>' : ''}
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>YOUR ADDRESSES</h2><div class="spacer"></div>
      <span class="badge">BIP84 · BIP86</span></div>
    <div class="kv">
      <dt>Frog address</dt>
      <dd class="wrap small">${esc(frogAddress)}<button class="copy" data-action="copy" data-text="${esc(frogAddress)}">COPY</button></dd>
      <dt>Receive</dt>
      <dd class="wrap small">${esc(receive)}<button class="copy" data-action="copy" data-text="${esc(receive)}">COPY</button></dd>
      <dt>Treasury</dt>
      <dd class="small">${w.frogs.length} frog${w.frogs.length === 1 ? '' : 's'} · ${sats(b.cards)} sats in custody</dd>
    </div>
    <div class="hint">The mint pays the frog address. A frog sent to Receive arrives as an ordinary coin; PREPARE re-enters custody.</div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>COINS</h2><div class="spacer"></div>
      <span class="badge">${w.utxos.length}</span></div>
    ${w.utxos.length ? `<div class="list">${w.utxos.map(coinRow).join('')}</div>` : `
      <div class="empty">No coins yet.${app.settings.mode === 'demo' ? '<br><button class="btn primary small" data-action="faucet" style="margin-top:10px">TAP THE FAUCET</button>' : ''}</div>`}
  </section>

  <section class="panel">
    <div class="panel-head"><h2>THE CHAIN</h2><div class="spacer"></div><span class="badge good">WIRE 0x06</span></div>
    <div class="kv">
      <dt>Height</dt><dd>${w.tipHeight != null ? sats(w.tipHeight) : '—'}${next ? ` <span class="dim small">· next road at ${sats(next[0])} → ${next[1]} hops</span>` : ''}</dd>
      <dt>Tip</dt><dd class="wrap tiny dim">${esc(w.tipHash || '—')}</dd>
      <dt>Params</dt><dd class="tiny wrap">${esc(paramsHashHex())}</dd>
      <dt>Finality</dt><dd>6 blocks</dd>
    </div>
  </section>
  <div class="footer">NO SERVER ON THE ART'S TRUST PATH · STATE FROM THE CHAIN</div>`;
}

function coinRow(u) {
  const kind = u.kind === 'state' ? 'FROG CARD' : u.kind === 'frog' ? 'FROG ADDR' : 'P2WPKH';
  const cls = u.kind === 'state' ? 'warn' : '';
  const flags = [
    u.exact ? '' : '<span class="badge bad">NO RANGES</span>',
    u.frogs?.length ? `<span class="badge warn">FROG ${u.frogs.map(Number).join(',')}</span>` : '',
  ].join(' ');
  return `
    <div class="item">
      <div class="col" style="min-width:88px">
        <b>${sats(u.value)}</b><span class="tiny dim">sats</span>
      </div>
      <div class="grow">
        <div class="small"><span class="badge ${cls}">${kind}</span> ${flags}</div>
        <div class="tiny dim wrap">${esc(u.txid)}:${u.vout}</div>
        ${u.address ? `<div class="tiny dim trunc">${esc(u.address)}</div>` : ''}
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Pond
// ---------------------------------------------------------------------------

export function pond(app) {
  const w = app.w;
  const owned = w.frogs;
  const wild = (app.leaders || []).filter((l) => !owned.some((f) => Number(f.sat) === Number(l.sat))).slice(0, 6);
  return `
  <section class="panel lily">
    <div class="panel-head"><h2>THE POND</h2><div class="spacer"></div>
      <span class="badge">${owned.length} FROG${owned.length === 1 ? '' : 'S'}</span></div>
    <div class="sub">Every frog is a satoshi. Its state is read from the chain, not from a server.</div>
    ${owned.length ? `<div class="grid frogs" style="margin-top:12px">${owned.map((f) => frogCard(f, app.w.tipHeight)).join('')}</div>` : `
      <div class="empty" style="margin-top:12px">
        <div style="font-size:34px">🐸</div>
        No frogs on this bank yet.
        <div style="margin-top:10px"><button class="btn primary" data-action="nav" data-view="mint">MINT YOUR FIRST FROG</button></div>
      </div>`}
  </section>

  <section class="panel">
    <div class="panel-head"><h2>WILD RESIDENTS</h2><div class="spacer"></div>
      <span class="badge">PUBLIC</span></div>
    <div class="sub">Frogs living in the pond that this wallet does not hold.</div>
    ${wild.length ? `<div class="grid frogs" style="margin-top:12px">${wild.map((l) => wildCard(app, l)).join('')}</div>` : '<div class="empty" style="margin-top:12px">The indexer has no public residents.</div>'}
  </section>`;
}

function frogCard(f, tip) {
  const { dist, target, pct } = frogProgress(f, tip);
  const state = f.state === 'crossing' ? 'crossing' : f.state;
  return `
    <div class="frog-card" data-action="open-frog" data-sat="${f.sat}">
      ${frogImg(f.seed, state)}
      <div class="name">${esc(f.name || 'UNNAMED')}</div>
      <div class="sat">SAT ${sats(f.sat)}</div>
      <div class="center" style="margin:6px 0">${chip(stateLabel(f.state), state)}</div>
      <div class="row small"><span class="dim">HOPS</span><span class="spacer"></span><b>${dist} / ${target}</b></div>
      <div class="bar ${f.state === 'dead' ? 'dead' : ''}"><i style="width:${pct}%"></i></div>
    </div>`;
}

function wildCard(app, l) {
  const owned = app.w.frogs.some((f) => Number(f.sat) === Number(l.sat));
  return `
    <div class="frog-card" data-action="open-frog" data-sat="${l.sat}">
      ${frogImg(l.seed, l.state === 'dead' ? 'dead' : l.state === 'home' ? 'home' : 'idle')}
      <div class="name">${esc(l.name || 'UNNAMED')}</div>
      <div class="sat">SAT ${sats(l.sat)}</div>
      <div class="center" style="margin:6px 0">${chip(stateLabel(l.state), l.state)}</div>
      <div class="row small"><span class="dim">HOPS</span><span class="spacer"></span><b>${l.dist}</b></div>
      ${owned ? '<div class="center tiny" style="color:var(--accent)">YOURS</div>' : ''}
    </div>`;
}

// ---------------------------------------------------------------------------
// Road
// ---------------------------------------------------------------------------

export function road(app) {
  const w = app.w;
  const items = app.road || [];
  return `
  <section class="panel lily">
    <div class="panel-head"><h2>THE ROAD</h2><div class="spacer"></div>
      <span class="badge">${items.length} IN FLIGHT</span></div>
    <div class="sub">One crossing per frog. Outcome is frozen at T+1 and settles six blocks later.</div>
    ${app.settings.mode === 'demo' ? `
      <div class="actions" style="margin-top:12px">
        <button class="btn" data-action="mine" data-n="1">MINE 1</button>
        <button class="btn" data-action="mine" data-n="6">MINE 6</button>
      </div>` : ''}
  </section>
  ${items.length ? items.map((c) => roadCard(app, c)).join('') : `
    <section class="panel"><div class="empty">The road is clear.<br><span class="dim small">A crossing appears here between CROSS and settlement.</span></div></section>`}`;
}

function roadCard(app, c) {
  const tip = app.w.tipHeight || 0;
  const settle = c.inFlight?.settle_height ?? (c.inFlight?.height ?? tip) + 6;
  const left = Math.max(0, settle - tip);
  const f = app.w.frogBySat(c.sat);
  const seed = c.seed ?? f?.seed ?? 0;
  const name = c.name || f?.name || 'UNNAMED';
  const target = c.inFlight?.target_hops ?? targetOf(f, tip);
  return `
  <section class="panel">
    <div class="frog-hero">
      ${frogImg(seed, 'crossing', 'sprite', name)}
      <div class="grow">
        <div class="row"><span class="big">${esc(name)}</span><span class="spacer"></span>${c.provisionalDead == null ? chip('ON THE ROAD', 'crossing') : chip(c.provisionalDead ? 'DEAD SEALED' : 'ALIVE SEALED', c.provisionalDead ? 'dead' : 'home')}</div>
        <div class="small dim">SAT ${sats(c.sat)} · CROSSED AT ${sats(c.inFlight?.height ?? 0)}</div>
        <div class="row small" style="margin-top:8px"><span class="dim">HOPS</span><span class="spacer"></span><b>${c.dist} / ${target}</b></div>
        <div class="bar"><i style="width:${Math.min(100, (c.dist / Math.max(1, target)) * 100)}%"></i></div>
        <div class="progress-row"><span>${left ? `${left} BLOCK${left === 1 ? '' : 'S'} TO SETTLEMENT` : 'SETTLING…'}</span><span>H ${sats(settle)}</span></div>
      </div>
    </div>
  </section>`;
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
  const coin = w._funding().find((u) => u.ranges && u.ranges.length);
  const anchorSat = coin ? coin.ranges[0][0] : null;
  return `
  <section class="panel lily">
    <div class="panel-head"><h2>MINT A HOPPER</h2><div class="spacer"></div><span class="badge">WIRE 0x06</span></div>
    <div class="sub">One inscription folds the chain. The frog's identity is the sat it lands on.</div>

    <div class="frog-hero" style="margin-top:14px">
      <img id="mint-preview" class="sprite" style="width:112px;height:112px" src="${app.previewUri}" alt="">
      <div class="grow">
        <div class="big" id="mint-name-preview">${esc(app.mintName || 'UNNAMED')}</div>
        <div class="row small" style="margin-top:2px">
          <span class="dim" data-seed-label>SEED ${seedText(seed)}</span>
          <span class="spacer"></span>
          <button class="btn small" data-action="random-seed">DICE</button>
        </div>
        <div class="hint">Use DICE for a different seed. You cannot type one, and a new seed is assigned after every mint.</div>
        <div class="row small" style="margin-top:6px">
          <span class="dim">NEXT TARGET</span><span class="spacer"></span><b>${target} HOPS</b>
        </div>
        <div class="row small"><span class="dim">DEATH AT TARGET</span><span class="spacer"></span><b>${(bps / 100).toFixed(2)}%</b></div>
        <div class="row small"><span class="dim">COMPLETION</span><span class="spacer"></span><b>${(completionBps(target) / 100).toFixed(2)}%</b></div>
      </div>
    </div>

    <label class="field" style="margin-top:14px"><span>Name (≤ 38 bytes)</span>
      <input type="text" data-input="mint-name" maxlength="38" value="${esc(app.mintName)}" placeholder="optional · leave blank for UNNAMED">
      <div class="hint">Optional. The name is written into the mint OP_RETURN.</div>
    </label>

    <label class="field"><span>Fee rate (sat/vB)</span>
      <input type="number" min="1" max="1000" data-input="fee-rate" value="${app.settings.feeRate}">
    </label>

    <div class="panel bark" style="margin:14px 0">
      <div class="kv">
        <dt>Anchor sat</dt><dd>${anchorSat != null ? sats(anchorSat) : '<span style="color:var(--danger)">no tracked coin</span>'}</dd>
        <dt>Anchor output</dt><dd>1,000 sats to the frog address</dd>
        <dt>Card value</dt><dd>25,000 sats after PREPARE</dd>
        <dt>Fee</dt><dd class="small">commit + reveal, sized from the inscription (~14 KiB)</dd>
      </div>
      <div class="hint">Minting needs a coin whose ordinal ranges the indexer knows. The anchor sat is the first sat of input 0.</div>
    </div>

    <button class="btn primary wide" data-action="mint" ${app.busy || !anchorSat ? 'disabled' : ''}>✦ INSCRIBE THE FROG</button>
    <div class="hint center">The commit/reveal pair is signed by your ordinals key. SIGHASH_ALL commits every output.</div>
  </section>
  <section class="panel">
    <div class="panel-head"><h2>THE SCHEDULE</h2><div class="spacer"></div><span class="badge">FROZEN</span></div>
    <div class="kv">
      <dt>Genesis</dt><dd>${sats(973263)}</dd>
      <dt>Now</dt><dd>${requiredAt(tip)} hops at H ${sats(tip)}</dd>
      <dt>Next rise</dt><dd>${next ? `H ${sats(next[0])} → ${next[1]} hops` : 'capped at 100'}</dd>
      <dt>Death curve</dt><dd>25% → 2.95% (hybrid floor)</dd>
    </div>
    <button class="btn ghost small" data-action="nav" data-view="rules">READ THE 8 RULES</button>
  </section>`;
}

// ---------------------------------------------------------------------------
// Leaderboard / history
// ---------------------------------------------------------------------------

export function leaders(app) {
  const rows = app.leaders || [];
  return `
  <section class="panel lily">
    <div class="panel-head"><h2>LEADERBOARD</h2><div class="spacer"></div><span class="badge">DIST</span></div>
    <div class="sub">Completed crossings. Home frogs are immortal; their hops stop counting.</div>
  </section>
  <section class="panel">
    ${rows.length ? `
    <table class="leaders">
      <thead><tr><th>#</th><th></th><th>FROG</th><th>STATE</th><th class="right">HOPS</th></tr></thead>
      <tbody>
        ${rows.map((r) => {
          const mine = app.w.frogs.some((f) => Number(f.sat) === Number(r.sat));
          return `<tr class="${mine ? 'me' : ''}" data-action="open-frog" data-sat="${r.sat}" style="cursor:pointer">
            <td class="dim">${r.rank}</td>
            <td>${frogImg(r.seed, r.state === 'dead' ? 'dead' : r.state === 'home' ? 'home' : 'idle')}</td>
            <td><div>${esc(r.name || 'UNNAMED')}${mine ? ' <span class="badge warn">YOU</span>' : ''}</div>
              <div class="tiny dim">SAT ${sats(r.sat)}</div></td>
            <td>${chip(stateLabel(r.state), r.state)}</td>
            <td class="right"><b>${r.dist}</b></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>` : '<div class="empty">No frogs ranked yet.</div>'}
  </section>`;
}

export function history(app) {
  const w = app.w;
  const events = (w.history || []).map((h) => ({
    kind: h.kind, sat: h.payload?.frogger_sat, height: h.height, txid: h.txid, payload: h.payload,
  }));
  const actions = (w.actions || []).map((a) => ({
    kind: a.kind, sat: a.sat, height: a.height, txid: a.txid, at: a.at, payload: a,
  }));
  // Merge the two sources before slicing: appending all actions after all
  // events hid new wallet actions below older chain history.
  const all = [...events, ...actions]
    .map((e) => ({ ...e, _sort: e.height != null ? Number(e.height) : (e.at ? Date.parse(e.at) : 0) }))
    .sort((a, b) => b._sort - a._sort)
    .slice(0, 80);
  return `
  <section class="panel lily">
    <div class="panel-head"><h2>HISTORY</h2><div class="spacer"></div><span class="badge">RE-DERIVABLE</span></div>
    <div class="sub">Events from the chain plus actions signed by this wallet.</div>
  </section>
  <section class="panel">
    ${all.length ? `<div class="list">${all.map((e) => `
      <div class="item">
        <div class="col" style="min-width:74px"><b class="small">${esc(String(e.kind || '?').toUpperCase())}</b>
          <span class="tiny dim">${e.height != null ? `H ${sats(e.height)}` : timeAgo(e.at)}</span></div>
        <div class="grow">
          ${e.sat != null ? `<div class="small">SAT ${sats(e.sat)}</div>` : ''}
          ${e.txid ? `<div class="tiny dim wrap">${esc(e.txid)}</div>` : ''}
          ${e.payload?.outcome ? `<div class="tiny">${esc(String(e.payload.outcome).toUpperCase())}</div>` : ''}
        </div>
        ${e.sat != null ? `<button class="btn small ghost" data-action="open-frog" data-sat="${e.sat}">OPEN</button>` : ''}
      </div>`).join('')}</div>` : '<div class="empty">Nothing has happened yet.</div>'}
  </section>`;
}

// ---------------------------------------------------------------------------
// Frog detail
// ---------------------------------------------------------------------------

export function frogDetail(app, sat) {
  const w = app.w;
  const f = w.frogBySat(sat)
    || (app.frogRecord && Number(app.frogRecord.sat) === Number(sat) ? app.frogRecord : null);
  if (!f) return `<section class="panel"><div class="empty">No frog at sat ${esc(sat)}.</div></section>`;
  const utxo = w._frogUtxo(f);
  const kind = utxo?.kind || 'none';
  const target = targetOf(f, w.tipHeight);
  const { dist, pct } = frogProgress(f, w.tipHeight);
  const state = f.state;
  const inFlight = f.in_flight;
  const canPrepare = state === 'idle' && utxo && kind !== 'state';
  const canCross = state === 'idle' && utxo && kind === 'state';
  const canTransfer = !!utxo && !['burned', 'crossing'].includes(state);
  const canBurn = !!utxo && !['burned', 'retired'].includes(state);
  const body = f.mint_txid ? `${f.mint_txid}i${f.mint_index ?? 0}` : f.inscription_id;

  return `
  <section class="panel lily">
    <div class="panel-head">
      <button class="btn small ghost" data-action="back">← BACK</button>
      <div class="spacer"></div>
      ${chip(stateLabel(state), state)}
    </div>
    <div class="frog-hero">
      ${frogImg(f.seed, state === 'dead' ? 'dead' : state === 'home' ? 'home' : state === 'crossing' ? 'crossing' : 'idle', 'sprite', f.name)}
      <div class="grow">
        <div class="big">${esc(f.name || 'UNNAMED')}</div>
        <div class="small dim">SAT ${sats(f.sat)}${f.rarity ? ` · ${esc(String(f.rarity).toUpperCase())}` : ''}</div>
        <div class="row small" style="margin-top:8px"><span class="dim">HOPS</span><span class="spacer"></span><b>${dist} / ${target}</b></div>
        <div class="bar ${state === 'dead' ? 'dead' : ''}"><i style="width:${pct}%"></i></div>
        ${inFlight ? `<div class="progress-row"><span>SETTLES AT H ${sats(inFlight.height + 6)}</span><span>${Math.max(0, inFlight.height + 6 - (w.tipHeight || 0))} BLOCKS</span></div>` : ''}
      </div>
    </div>
    <div class="actions" style="margin-top:16px">
      ${canPrepare ? '<button class="btn primary" data-action="prepare" data-sat="' + f.sat + '">PREPARE CUSTODY</button>' : ''}
      ${canCross ? '<button class="btn primary" data-action="sheet-cross" data-sat="' + f.sat + '">CROSS THE ROAD</button>' : ''}
      ${canTransfer ? '<button class="btn" data-action="sheet-transfer" data-sat="' + f.sat + '">TRANSFER</button>' : ''}
      ${canBurn ? '<button class="btn danger" data-action="burn" data-sat="' + f.sat + '">BURN</button>' : ''}
      ${!utxo ? '<span class="badge bad">NOT IN THIS WALLET</span>' : ''}
    </div>
    <div class="hint">${canPrepare ? 'Prepare funds the 25,000-sat card and creates the two-leaf state output (NUMS internal key).' : canCross ? 'A crossing is one inscription in input 0 and the anchor sat at offset 0 of output 0.' : state === 'crossing' ? 'The outcome is sealed at T+1. Nothing can change it now.' : ''}</div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>THE RECORD</h2><div class="spacer"></div><span class="badge">INDEXER</span></div>
    <div class="kv">
      <dt>Mint id</dt><dd class="wrap tiny">${esc(body || '—')}</dd>
      <dt>Mint height</dt><dd>${f.mint_height != null ? sats(f.mint_height) : '—'}</dd>
      <dt>Location</dt><dd class="wrap tiny">${f.location ? `${esc(f.location.txid)}:${f.location.vout}` : (state === 'burned' ? 'burned to fees' : '—')}</dd>
      <dt>Owner leaf</dt><dd class="tiny wrap">${utxo ? esc(Array.from(w.ord.ownerXonly, (b) => b.toString(16).padStart(2, '0')).join('')) : 'not held by this wallet'}</dd>
      <dt>Entered</dt><dd>${sats(f.crossings_entered || 0)} crossings</dd>
      <dt>Settled</dt><dd>${sats(f.crossings_settled || 0)}</dd>
      ${f.death_height != null ? `<dt>Death</dt><dd>H ${sats(f.death_height)}</dd>` : ''}
      ${f.immortal_height != null ? `<dt>Immortal</dt><dd>H ${sats(f.immortal_height)}</dd>` : ''}
      ${inFlight ? `<dt>In flight</dt><dd>${esc(inFlight.txid)} · target ${inFlight.target_hops}</dd>` : ''}
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>VERIFICATION</h2><div class="spacer"></div><span class="badge good">SELF-CHECK</span></div>
    <div class="kv">
      <dt>Target at T</dt><dd>${inFlight ? inFlight.target_hops : (f.last_target_hops != null ? `${f.last_target_hops} (last)` : '— no crossing')}</dd>
      <dt>Required at next</dt><dd>${requiredAt((w.tipHeight || 0) + 1)} hops</dd>
      <dt>Death table now</dt><dd>${(deathBps(requiredAt((w.tipHeight || 0) + 1)) / 100).toFixed(2)}%</dd>
      <dt>Outcome hash</dt><dd class="tiny wrap">${esc(f.outcome_block_hash || 'not sealed')}</dd>
      <dt>Provisional</dt><dd>${f.provisional_dead == null ? '—' : f.provisional_dead ? '<span style="color:var(--danger)">DEAD PENDING FINALITY</span>' : '<span style="color:var(--good)">ALIVE PENDING FINALITY</span>'}</dd>
      <dt>Fold params</dt><dd class="tiny">${JSON.stringify(foldParams()).slice(0, 36)}…</dd>
    </div>
    <div class="hint">${verifyLine(f, w)}</div>
  </section>`;
}

function verifyLine(f, w) {
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
  if (f.state === 'burned') {
    return 'Burned. The state output was spent to fees; the card is gone and the sat is unspendable.';
  }
  return 'The frozen fold source is loaded locally, but full settlement history is not replayed in the browser. The indexer record above is authoritative.';
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function settings(app) {
  const w = app.w;
  const s = app.settings;
  return `
  <section class="panel lily">
    <div class="panel-head"><h2>SETTINGS</h2><div class="spacer"></div><span class="badge">${esc(w.network)}</span></div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>CHAIN ACCESS</h2><div class="spacer"></div><span class="badge">${esc(s.mode)}</span></div>
    <label class="field"><span>Mode</span>
      <select data-input="mode">
        <option value="demo" ${s.mode === 'demo' ? 'selected' : ''}>Local demo chain (offline)</option>
        <option value="live" ${s.mode === 'live' ? 'selected' : ''}>Live indexer + chain</option>
      </select>
    </label>
    <label class="field"><span>Esplora URL</span><input type="text" data-input="esploraUrl" value="${esc(s.esploraUrl)}"></label>
    <label class="field"><span>Indexer URL</span><input type="text" data-input="indexerUrl" value="${esc(s.indexerUrl)}"></label>
    <label class="field"><span>Electrum WebSocket (optional)</span><input type="text" data-input="electrumUrl" value="${esc(s.electrumUrl)}" placeholder="wss://relay.example/electrum"></label>
    <div class="actions">
      <button class="btn primary" data-action="apply-backend">APPLY</button>
      <button class="btn ghost" data-action="test-backend">TEST</button>
    </div>
    <div class="hint">Two chain ports, chosen by URL. Discovery comes from the indexer; without one the wallet can still watch addresses.</div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>FEES & SCAN</h2></div>
    <label class="field"><span>Fee rate (sat/vB)</span><input type="number" min="1" max="1000" data-input="feeRate" value="${s.feeRate}"></label>
    <label class="field"><span>Deep scan (public frogs; slow on a live indexer)</span>
      <select data-input="deepScan"><option value="1" ${s.deepScan ? 'selected' : ''}>on</option><option value="0" ${!s.deepScan ? 'selected' : ''}>off</option></select>
    </label>
    <label class="field"><span>Address gap</span><input type="number" min="5" max="50" data-input="gap" value="${s.gap}"></label>
    <div class="hint">Demo mode always scans. Live mode scans only when this is on; it is off by default. Every coin with unknown ranges is counted but shown unspendable; ranges are the ownership proof.</div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>SOUND</h2><div class="spacer"></div>
      <span class="badge">${s.mute ? 'MUTED' : `${Math.round(s.volume * 100)}%`}</span></div>
    <label class="field"><span>Mute</span>
      <select data-input="mute"><option value="0" ${!s.mute ? 'selected' : ''}>sound on</option><option value="1" ${s.mute ? 'selected' : ''}>muted</option></select>
    </label>
    <label class="field"><span>Volume</span><input type="range" min="0" max="1" step="0.05" data-input="volume" value="${s.volume}"></label>
    <div class="hint">Nothing sounds before a gesture. Gain is 0.5 · volume².</div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>VAULT</h2><div class="spacer"></div><span class="badge">AES-256-GCM</span></div>
    <div class="kv">
      <dt>Network</dt><dd>${esc(w.network)} (coin type ${w.keys.coinType})</dd>
      <dt>Fingerprint</dt><dd>${esc(w.fingerprint)}</dd>
      <dt>Path</dt><dd class="tiny">${esc(w.keys.account)} · ord ${esc(w.keys.ordPath)}</dd>
      <dt>KEK</dt><dd>non-extractable, PBKDF2 210k</dd>
      <dt>Frogs</dt><dd>${w.frogs.length}</dd>
    </div>
    <div class="actions" style="margin-top:12px">
      <button class="btn" data-action="reveal-words">BACKUP WORDS</button>
      <button class="btn ghost" data-action="lock">LOCK</button>
      <button class="btn danger" data-action="wipe">WIPE DEVICE</button>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>DEMO CHAIN</h2><div class="spacer"></div><span class="badge warn">LOCAL</span></div>
    <div class="kv">
      <dt>Height</dt><dd>${sats(w.tipHeight || 0)}</dd>
      <dt>Blocks</dt><dd>every broadcast mines one</dd>
    </div>
    <div class="actions" style="margin-top:12px">
      <button class="btn" data-action="faucet">FAUCET</button>
      <button class="btn ghost" data-action="mine" data-n="1">MINE 1</button>
      <button class="btn ghost" data-action="mine" data-n="6">MINE 6</button>
      <button class="btn danger" data-action="reset-demo">RESET DEMO</button>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>ADDRESS BOOK</h2><div class="spacer"></div><span class="badge">${(s.addressBook || []).length}</span></div>
    ${(s.addressBook || []).length ? `<div class="list">${s.addressBook.map((e, i) => `
      <div class="item"><div class="grow"><b class="small">${esc(e.name)}</b><div class="tiny dim wrap">${esc(e.address)}</div></div>
      <button class="btn small ghost" data-action="copy" data-text="${esc(e.address)}">COPY</button>
      <button class="btn small danger" data-action="drop-address" data-i="${i}">×</button></div>`).join('')}</div>` : '<div class="empty">No saved addresses.</div>'}
    <div class="grid two" style="margin-top:12px">
      <label class="field"><span>Name</span><input type="text" data-input="book-name" placeholder="Marsh"></label>
      <label class="field"><span>Address</span><input type="text" data-input="book-address" placeholder="bcrt1…"></label>
    </div>
    <button class="btn ghost small" data-action="add-address">SAVE ADDRESS</button>
  </section>

  <div class="footer">HOPPER v6 · 0x06 · ${esc(paramsHashHex().slice(0, 16))}…</div>`;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export const RULES = [
  {
    title: 'A frog is one satoshi',
    tag: 'IDENTITY',
    art: 'frog',
    body: "One satoshi — the smallest unit of Bitcoin — can carry a tiny program that tracks your frog: a little record that says which frog it is and follows the satoshi from wallet to wallet. HOPPER does not create a separate token or a separate balance. The satoshi is the frog; the program is how everyone recognizes it and follows its story.",
    analogy: "Think of the frog as a numbered marble with a passport taped to it. Wallets are just pockets; moving the marble to another pocket does not make a new marble.",
  },
  {
    title: 'Birth takes two transactions',
    tag: 'BIRTH',
    art: 'mint',
    body: "A frog is born in two steps. First, you create a locked coin that holds the frog's starting record and your permission to open it. Then a second transaction opens that coin and moves the frog to a fresh 1,000-satoshi coin. The first satoshi of the locked coin becomes the frog. Two steps are needed because the starting coin has to exist before the second transaction can point back to it.",
    analogy: "Like sealing a birth certificate in a locked box and then opening it: the box has to exist before it can hold the certificate.",
  },
  {
    title: 'The road asks for hops',
    tag: 'THE ROAD',
    art: 'road',
    body: "A hop is one crossing that survives its six-block wait. At the start, the road asks for 5 hops. Over time it asks for more: one extra hop every 64 blocks (about 11 hours) up to 25, then one extra every 144 blocks (about a day) up to 50, then one extra every 2,016 blocks (about two weeks) up to 100. The number is fixed when your crossing is confirmed, so later increases do not change that attempt.",
    analogy: "Like a bus that raises its fare during the day: you pay the price on the board when you get on, not the price when it reaches the next stop.",
  },
  {
    title: 'The next block decides',
    tag: 'THE VERDICT',
    art: 'dead',
    body: "A crossing is a bet. The very next block casts the deciding vote: its unique fingerprint, your frog's number, and the number of hops the road asked for are mixed together to decide whether the frog lives or becomes roadkill. The answer stays provisional for six blocks (about an hour), then becomes final. You choose when to cross; Bitcoin chooses what happens.",
    analogy: "Like handing in a sealed exam and letting the next block grade it: you choose the moment, not the grade.",
  },
  {
    title: 'The travel box has two doors',
    tag: 'THE BOX',
    art: 'custody',
    body: "While a frog is in play, it lives inside a small protected coin: a 25,000-satoshi travel box. The box has exactly two doors. One door can only approve a crossing; the other can only hand the frog to a new owner. There is no master key, so not even the people who built the wallet can open it another way. The box is stamped with the frog's identity and its current owner.",
    analogy: "Like a glass safe with two numbered slots: one says 'cross the road', the other says 'give it away'. There is no third slot and no locksmith.",
  },
  {
    title: 'Prepare, then cross',
    tag: 'PREPARE',
    art: 'prepare',
    body: "PREPARE is the packing step. A newly born frog is still in its starting coin. Before it can cross, it must move into the travel box. That move records which frog it is and who owns it, so it can only happen after the frog exists. CROSS then uses the box, writes exactly one crossing record to the road, and keeps the frog first in line: it must go in first and come out first. No other frog or record may hitch a ride.",
    analogy: "Like packing a parcel before mailing it: the label needs the frog's details, and the parcel has to be first on the truck, not hidden behind someone else's boxes.",
  },
  {
    title: 'A handoff is not a hop',
    tag: 'HANDOFF',
    art: 'transfer',
    body: "Sending the frog to another wallet is just moving the satoshi. It writes no crossing record, so it does not count as a hop, change the frog's progress, or put it in danger in the game. A handoff uses up the coin the frog was sitting in, so a new holder who wants to keep playing has to set it up in a new travel box before the next crossing. A handoff alone never kills the frog in the game.",
    analogy: "Like passing a baton: the handoff does not count as a lap, but the next runner still has to get ready before running.",
  },
  {
    title: 'Home is forever',
    tag: 'HOME',
    art: 'home',
    body: "Six blocks after a crossing, the result is final. Survive and the frog gains one hop. When its total reaches the number the road asked for at that crossing, it is home. Home frogs stop crossing, cannot die, and keep their place on the leaderboard. The road is still hard: the chance of death starts at 25% per crossing and only eases to about 3% at the far end.",
    analogy: "Like finishing a mountain climb: the last step is the same as the others, but once you reach the top you never have to come down.",
  },
];

export function rules(app) {
  const page = Math.max(0, Math.min(RULES.length - 1, app.rulePage || 0));
  const r = RULES[page];
  const artState = r.art === 'dead' ? 'dead' : r.art === 'home' ? 'home' : r.art === 'road' ? 'crossing' : 'idle';
  return `
  <section class="panel lily">
    <div class="panel-head"><h2>THE 8 RULES</h2><div class="spacer"></div><span class="badge">${page + 1} / ${RULES.length}</span></div>
    <div class="sub">The whole game in plain English: one satoshi, one road, and a decision every six blocks.</div>
    <div class="steps">${RULES.map((_, i) => `<i class="${i <= page ? 'on' : ''}"></i>`).join('')}</div>
    <h2 style="margin-top:8px">${esc(r.title)}</h2>
    <div class="rule-art">${frogImg(app.w.frogs[0]?.seed ?? 0x9058d0fa, artState, 'sprite')}</div>
    <p>${esc(r.body)}</p>
    <p class="analogy"><b>Think of it this way</b> ${esc(r.analogy)}</p>
    <div class="pager">
      <button class="btn small ghost" data-action="rule-prev" ${page === 0 ? 'disabled' : ''}>← PREV</button>
      <div class="spacer"></div>
      <span class="tiny dim">${esc(r.tag)} · HOPPER</span>
      <div class="spacer"></div>
      <button class="btn small" data-action="rule-next" ${page === RULES.length - 1 ? 'disabled' : ''}>NEXT →</button>
    </div>
  </section>
  <section class="panel">
    <div class="panel-head"><h2>THE SHORT VERSION</h2><div class="spacer"></div><span class="badge">RECAP</span></div>
    <div class="kv">
      <dt>Your frog</dt><dd>One satoshi carrying a tiny program that tells its story.</dd>
      <dt>A hop</dt><dd>One crossing that survives the six-block wait.</dd>
      <dt>The goal</dt><dd>Reach the number of hops the road asks for and come home forever.</dd>
      <dt>The risk</dt><dd>About 25% chance of death per crossing at the start, easing to about 3% near home.</dd>
      <dt>The travel box</dt><dd>A 25,000-satoshi coin that protects the frog while it plays.</dd>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// Sheets / modals content
// ---------------------------------------------------------------------------

export function receiveSheet(app) {
  const w = app.w;
  const rows = [0, 1, 2].map((i) => w.keys.receive(i).address);
  return `
    <div class="row"><h2>RECEIVE</h2><div class="spacer"></div><button class="icon-btn close" data-action="close-overlay">✕</button></div>
    <div class="sub">BIP84 P2WPKH · ${esc(w.network)}</div>
    <div class="sep"></div>
    ${rows.map((a, i) => `<div class="panel" style="margin:9px 0;padding:11px">
      <div class="tiny dim">${i === 0 ? 'MAIN' : `INDEX ${i}`}</div>
      <div class="wrap small">${esc(a)}</div>
      <button class="btn small ghost" data-action="copy" data-text="${esc(a)}" style="margin-top:8px">COPY</button>
    </div>`).join('')}
    <div class="hint">Coins arriving here are ordinary P2WPKH. A frog arrives as the anchor sat inside a coin; PREPARE re-enters custody.</div>`;
}

export function sendSheet(app) {
  return `
    <div class="row"><h2>SEND</h2><div class="spacer"></div><button class="icon-btn close" data-action="close-overlay">✕</button></div>
    <div class="sub">Ordinary Bitcoin. Never touches a frog card.</div>
    <label class="field"><span>Recipient</span><input type="text" data-input="send-to" placeholder="${esc(app.w.network === 'mainnet' ? 'bc1…' : 'bcrt1… / tb1…')}"></label>
    <label class="field"><span>Amount (sats)</span><input type="number" data-input="send-amount" min="546" value="10000"></label>
    <div class="hint">Spendable: ${sats(app.w.balance.spendable)} sats. Fees come from the tail of the change.</div>
    <button class="btn primary wide" data-action="do-send">SEND</button>`;
}

export function transferSheet(app, f) {
  return `
    <div class="row"><h2>TRANSFER ${esc(f.name || '')}</h2><div class="spacer"></div><button class="icon-btn close" data-action="close-overlay">✕</button></div>
    <div class="sub">No inscription, no state change. The frog walks to an ordinary address.</div>
    <div class="panel" style="padding:11px;margin:10px 0"><div class="kv"><dt>Sat</dt><dd>${sats(f.sat)}</dd><dt>State</dt><dd>${stateLabel(f.state)}</dd></div></div>
    <label class="field"><span>Recipient address</span><input type="text" data-input="transfer-to" placeholder="bcrt1…"></label>
    <div class="hint">The recipient re-enters custody with PREPARE on their next action. A custody output needs a P2TR owner; a transfer deliberately pays an ordinary address.</div>
    <button class="btn primary wide" data-action="do-transfer" data-sat="${f.sat}">TRANSFER</button>`;
}

export function crossSheet(app, f) {
  return `
    <div class="row"><h2>CROSS ${esc(f.name || '')}</h2><div class="spacer"></div><button class="icon-btn close" data-action="close-overlay">✕</button></div>
    <div class="sub">One inscription. One state output. The anchor sat at offset 0.</div>
    <div class="panel" style="padding:11px;margin:10px 0">
      <div class="kv"><dt>Current dist</dt><dd>${f.dist}</dd>
      <dt>Target at T</dt><dd>${requiredAt((app.w.tipHeight || 0) + 1)} hops</dd>
      <dt>Death at target</dt><dd>${(deathBps(requiredAt((app.w.tipHeight || 0) + 1)) / 100).toFixed(2)}%</dd>
      <dt>Settlement</dt><dd>T+6 blocks</dd></div>
    </div>
    <label class="field"><span>New owner P2TR address (optional)</span><input type="text" data-input="cross-owner" placeholder="leave empty to keep this wallet"></label>
    <div class="hint">The state output commits to the new owner's x-only key. Non-P2TR destinations are refused for custody.</div>
    <label class="field"><span>Fee rate (sat/vB)</span><input type="number" min="1" data-input="cross-fee" value="${app.settings.feeRate}"></label>
    <button class="btn primary wide" data-action="do-cross" data-sat="${f.sat}">CROSS</button>`;
}

export function wordsModal(app) {
  const words = (app.w.mnemonic || '').trim().split(/\s+/);
  return `
    <div class="row"><h2>BACKUP</h2><div class="spacer"></div><button class="icon-btn close" data-action="close-overlay">✕</button></div>
    <div class="warnbox">These 12 words are the only backup. Anyone who reads them owns every frog at this address. Write them on paper, never a screenshot.</div>
    <div class="words" style="margin-top:12px">${words.map((w2, i) => `<span><b>${i + 1}</b>${esc(w2)}</span>`).join('')}</div>
    <button class="btn ghost wide" style="margin-top:12px" data-action="copy" data-text="${esc(words.join(' '))}">COPY WORDS</button>`;
}
