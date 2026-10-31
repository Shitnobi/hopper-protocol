// HOPPER PWA — boot, vault, routing, and event handling.

import {
  busy, closeOverlay, copyText, downloadText, esc, openOverlay, seedText,
  shortHash, sats, spriteUri, toast,
} from './ui/dom.js';
import * as screens from './ui/screens.js';
import { decorate, frogMarkSvg } from './ui/theme.js';
import { paintRulesArt, playIntro } from './ui/tour.js';
import { volumeFromRange } from './ui/volume.js';
import { Sound } from './sound.js';
import {
  DEFAULT_SETTINGS, WalletSession, loadSettings, saveSettings,
} from './wallet/wallet.js';
import {
  createVault, destroyVault, hasVault, lockVault, unlockVault, vaultInfo,
} from './wallet/vault.js';
import { newMnemonic, isValidMnemonic, deriveWallet } from './wallet/keys.js';
import { decodeAddress } from './wallet/addresses.js';
import { DemoBackend } from './wallet/backend.js';
import { FEE_CACHE_MS, fetchFeeQuote } from './wallet/fees.js';
import { idbGet, KEYS } from './wallet/storage.js';

const app = {
  w: null,
  settings: loadSettings(),
  view: 'wallet',
  busy: false,
  leaders: [],
  road: [],
  rulePage: 0,
  frogSat: null,
  frogRecord: null,
  mintSeed: 0,
  mintName: '',
  ob: { step: 'welcome', mode: 'create', mnemonic: '', password: '', confirm: '', network: 'mainnet', remember: false },
  lockError: '',
  frogLogo: spriteUri(0x9058d0fa, 'idle'),
  previewUri: '',
  historyDom: [],
  screen: 'boot',
  menuOpen: false,
  intro: false,
  rulesWalk: null,
  receiveTab: 'btc',
  previewTx: null,
  feeQuote: { status: 'idle', fastestFee: null, halfHourFee: null, economyFee: null, fetchedAt: 0, error: '' },
  frogRefusal: null,
  navChosen: false,
  seenFirstFrog: false,
  scanArmed: false,
  booted: false,
};

// The mint seed is wallet-local randomness, not a user choice. Rotate it
// whenever a mint draft is finished so an old seed cannot be reused by
// accident (or by replaying the previous form).
function newMintSeed() {
  const previous = app.mintSeed >>> 0;
  let seed = previous;
  while (seed === previous) seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
  app.mintSeed = seed;
  app.previewUri = spriteUri(seed, 'idle');
  return seed;
}

function resetMintDraft() {
  newMintSeed();
  app.mintName = '';
}

newMintSeed();

const sound = new Sound({ volume: app.settings.volume, mute: app.settings.mute });
app.sound = sound;
if (typeof window !== 'undefined') window.hopperSound = sound;
let viewSeq = 0;
let lastLocation = null;
// Kept on every gesture on purpose: a context created during the first
// tap can still be suspended by the browser (autoplay policy, a tab that
// started hidden). Sound.arm() only builds the graph once and otherwise
// retries resume(), so later taps can always bring the score back.
function armSound() {
  sound.arm();
}
document.addEventListener('pointerdown', armSound, { passive: true });
document.addEventListener('touchstart', armSound, { passive: true });
document.addEventListener('click', armSound, { passive: true });
document.addEventListener('keydown', armSound);

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

function viewHtml() {
  switch (app.view) {
    case 'pond': return screens.pond(app);
    case 'road': return screens.road(app);
    case 'mint': return screens.mint(app);
    case 'leaders': return screens.leaders(app);
    case 'history': return screens.history(app);
    case 'settings': return screens.settings(app);
    case 'rules': return screens.rulesPage(app);
    case 'bio': return screens.bio(app, app.frogSat);
    case 'frog': return screens.frogDetail(app, app.frogSat);
    default: return screens.wallet(app);
  }
}

/** FROGGER's landing rule: the WALLET page until the wallet's first
 *  frog is detected; once a frog exists, THE POND is always first. */
function applyLanding() {
  if (!app.w || app.rulesWalk || app.intro) return;
  if (app.seenFirstFrog) return;
  if (app.w.frogs.length) {
    app.seenFirstFrog = true;
    if (!app.navChosen && app.view === 'wallet') app.view = 'pond';
  } else if (!app.navChosen && app.w.tipHeight != null && app.view === 'pond') {
    app.view = 'wallet';
  }
}

let rulesRaf = 0;
let ruleSwipe = null;
let ruleSwipeUntil = 0;
const RULE_SWIPE_MIN = 44;

function moveRules(delta) {
  if (!app.rulesWalk) return;
  const page = app.rulesWalk.page | 0;
  const next = Math.max(0, Math.min(screens.RULES.length - 1, page + delta));
  if (next === page) return false;
  app.rulesWalk.page = next;
  render();
  return true;
}

function startRulesLoop() {
  cancelAnimationFrame(rulesRaf);
  const tick = () => {
    if (!app.rulesWalk) { rulesRaf = 0; return; }
    const cv = document.querySelector('canvas[data-rule-art]');
    if (cv) paintRulesArt(cv, cv.dataset.ruleArt, app.rulesWalk.page, performance.now() / 1000);
    rulesRaf = requestAnimationFrame(tick);
  };
  rulesRaf = requestAnimationFrame(tick);
}

function mountVolume() {
  const track = document.querySelector('[data-volume-track]');
  if (!track || !app.w) return;
  const fill = track.querySelector('[data-volume-fill]');
  const thumb = track.querySelector('[data-volume-thumb]');
  const pctEl = document.querySelector('[data-volume-pct]');
  const set = (clientX) => {
    const r = track.getBoundingClientRect();
    const v = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)));
    app.w.settings.volume = v;
    app.settings.volume = v;
    sound.setVolume(v);
    const pct = Math.round(v * 100);
    if (fill) fill.style.width = `${pct}%`;
    if (thumb) thumb.style.left = `calc(${pct}% - 3px)`;
    if (pctEl) pctEl.textContent = `${pct}%`;
  };
  track.onpointerdown = (ev) => {
    track.setPointerCapture(ev.pointerId);
    set(ev.clientX);
    track.onpointermove = (move) => set(move.clientX);
  };
  track.onpointerup = () => {
    track.onpointermove = null;
    if (app.w) saveSettings(app.w.settings);
  };
  track.onpointercancel = () => { track.onpointermove = null; };
}

function render() {
  const root = document.getElementById('app');
  if (!root) return;
  applyLanding();
  if (app.screen === 'onboard') root.innerHTML = onboarding();
  else if (app.screen === 'lock') root.innerHTML = lockScreen();
  else if (app.rulesWalk) root.innerHTML = screens.rulesPage(app);
  else if (app.w) root.innerHTML = screens.topbar(app) + viewHtml();
  else root.innerHTML = '';

  const drawer = document.getElementById('drawer');
  if (drawer) {
    drawer.innerHTML = app.w && !app.rulesWalk ? screens.drawer(app) : '';
    if (app.w && !app.rulesWalk) drawer.dataset.lily = 'accent';
    else delete drawer.dataset.lily;
    drawer.classList.toggle('open', !!app.menuOpen && !app.rulesWalk);
  }
  const backdrop = document.getElementById('drawer-backdrop');
  if (backdrop) backdrop.classList.toggle('open', !!app.menuOpen && !app.rulesWalk);
  const tabbar = document.getElementById('tabbar');
  if (tabbar) { tabbar.hidden = true; tabbar.innerHTML = ''; }
  const b = document.getElementById('busy');
  if (b) b.hidden = !app.busy;
  decorate(document);
  mountVolume();
  updateMintPreview();
  if (app.rulesWalk) startRulesLoop();
  // Keep the painted History order for the Settings download. The button
  // lives in Settings now, after History has been replaced in the DOM.
  if (!app.rulesWalk && app.w && app.view === 'history') {
    app.historyDom = screens.historyDomOrder();
  }
}

function setBusy(on, text = 'working…') {
  app.busy = on;
  busy(on, text);
}

function updateMintPreview() {
  if (!app.w || app.view !== 'mint') return;
  const img = document.getElementById('mint-preview');
  if (img) img.src = spriteUri(app.mintSeed, 'idle');
  const name = document.getElementById('mint-name-preview');
  if (name) name.textContent = app.mintName || 'UNNAMED';
  for (const seedLabel of document.querySelectorAll('[data-seed-label]')) {
    seedLabel.textContent = `SEED ${seedText(app.mintSeed)}`;
  }
  for (const seedInput of document.querySelectorAll('[data-seed-value]')) {
    seedInput.value = (app.mintSeed >>> 0).toString(16).padStart(8, '0');
  }
}

// ---------------------------------------------------------------------------
// onboarding / lock
// ---------------------------------------------------------------------------

function logoMark(tag = 'THE POND ON BITCOIN') {
  return `<div class="logo">${frogMarkSvg(96)}<span class="word">HOPPER</span><span class="tag">${esc(tag)}</span></div>`;
}

function button(label, action, edge = 'dim', cls = '', attrs = '') {
  return `<button class="btn ${cls}" data-action="${action}" data-edge="${edge}" ${attrs}>${label}</button>`;
}

function onboarding() {
  const o = app.ob;
  const logo = logoMark();
  if (o.step === 'welcome') {
    return `<div class="onboard"><div class="stage" style="text-align:center">
      ${logo}
      <div class="window" data-lily="accent" style="text-align:left">
        <div style="font-weight:700;font-size:17px">NO SERVER ON THE ART'S TRUST PATH</div>
        <p class="onboard-flavor">A Hopper is a satoshi whose life is a sequence of Bitcoin transactions. The wallet signs; the chain decides. Twelve words are the only backup.</p>
        <div class="actions mt14">
          ${button('CREATE A WALLET', 'ob-create', 'accent')}
          ${button('IMPORT 12 WORDS', 'ob-import', 'dim')}
        </div>
        ${hasVault() ? `<div class="mt10">${button('I HAVE A VAULT — UNLOCK', 'ob-lock', 'dim', 'small block')}</div>` : ''}
        <div class="hint">Mainnet is real Bitcoin. New wallets start live on the public defaults — Blockstream Esplora and ordinals.com. The HOPPER indexer is optional; choose Demo in Settings for the in-browser chain.</div>
      </div>
      <div class="footer">HOPPER v7 · HOPPER-PROTOCOL</div>
    </div></div>`;
  }
  if (o.step === 'words') {
    const words = o.mnemonic.trim().split(/\s+/);
    return `<div class="onboard"><div class="stage">
      ${logo}
      <div class="window" data-lily="accent">
        <div class="row"><div style="font-weight:700;font-size:17px">YOUR 12 WORDS</div><div class="spacer"></div><span class="chip-ui accent">ONLY BACKUP</span></div>
        <div class="warnbox mt10">Write these on paper. Anyone who reads them owns every frog at this address. Never a screenshot, never a chat.</div>
        <div class="words mt10">${words.map((w, i) => `<span><b>${i + 1}</b>${esc(w)}</span>`).join('')}</div>
        <div class="actions mt10">
          ${button('COPY', 'copy', 'dim', '', `data-text="${esc(words.join(' '))}"`)}
          ${button('I WROTE THEM DOWN', 'ob-words-done', 'accent')}
        </div>
        <div class="mt10">${button('BACK', 'ob-back', 'dim', 'small')}</div>
      </div>
    </div></div>`;
  }
  if (o.step === 'import') {
    return `<div class="onboard"><div class="stage">
      ${logo}
      <div class="window" data-lily="accent">
        <div style="font-weight:700;font-size:17px">IMPORT A WALLET</div>
        <p class="muted small">Twelve lowercase words, separated by spaces.</p>
        <textarea data-input="ob-mnemonic" spellcheck="false" autocomplete="off" placeholder="deliver cat inch coyote …">${esc(o.mnemonic)}</textarea>
        ${o.error ? `<div class="warnbox bad mt10">${esc(o.error)}</div>` : ''}
        <div class="actions mt10">
          ${button('BACK', 'ob-back', 'dim')}
          ${button('CONTINUE', 'ob-import-next', 'accent')}
        </div>
      </div>
    </div></div>`;
  }
  // password step
  const networks = [['mainnet', 'Mainnet'], ['testnet', 'Testnet'], ['signet', 'Signet'], ['regtest', 'Regtest (local)']];
  return `<div class="onboard"><div class="stage">
    ${logo}
    <div class="window" data-lily="accent">
      <div style="font-weight:700;font-size:17px">SEAL THE VAULT</div>
      <p class="muted small">AES-256-GCM under a non-extractable WebCrypto KEK. The password never leaves this device.</p>
      <label class="field"><span>Password (min 6)</span><input type="password" data-input="ob-password" value="${esc(o.password)}" autocomplete="new-password"></label>
      <label class="field"><span>Confirm</span><input type="password" data-input="ob-confirm" value="${esc(o.confirm)}" autocomplete="new-password"></label>
      <label class="field"><span>Network</span>
        <select data-input="ob-network">${networks.map(([v, l]) => `<option value="${v}" ${o.network === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <label class="check"><input type="checkbox" data-input="ob-remember" ${o.remember ? 'checked' : ''}> <span>Keep this device unlocked</span></label>
      <div class="hint">Coin type: mainnet 0, everything else 1. No password is stored; the KEK stays in this browser only if you ask. The 12 words are the only recovery.</div>
      <div class="hint">Mainnet uses real sats. Its default backends are Blockstream Esplora and ordinals.com; set your own in Settings to avoid third parties.</div>
      ${o.error ? `<div class="warnbox bad mt10">${esc(o.error)}</div>` : ''}
      <div class="actions mt10">
        ${button('BACK', 'ob-back', 'dim')}
        ${button('OPEN THE POND', 'ob-finish', 'accent')}
      </div>
    </div>
  </div></div>`;
}

function lockScreen() {
  const info = vaultInfo();
  return `<div class="onboard"><div class="stage" style="max-width:520px">
    ${logoMark('LOCKED')}
    <div class="window" data-lily="accent">
      <div class="stat-grid">
        <dt>Network</dt><dd>${esc(info?.network || '—')}</dd>
        <dt>Fingerprint</dt><dd>${esc(info?.fingerprint || '—')}</dd>
        <dt>Backup</dt><dd>${info?.words || 12} words</dd>
      </div>
      <label class="field mt10"><span>Password</span>
        <input type="password" data-input="lock-password" autocomplete="current-password" placeholder="••••••••">
      </label>
      <label class="check"><input type="checkbox" data-input="lock-remember" ${app.remember ? 'checked' : ''}> <span>Keep this device unlocked</span></label>
      ${app.lockError ? `<div class="warnbox bad mt10">${esc(app.lockError)}</div>` : ''}
      <div class="mt10">${button('UNLOCK', 'unlock', 'accent', 'block')}</div>
      <div class="actions mt10">
        ${button('USE ANOTHER VAULT', 'use-another', 'dim', 'small')}
        ${button('WIPE DEVICE', 'wipe', 'dead', 'small danger')}
      </div>
      <div class="hint">Wrong passwords never decrypt. The KEK is derived with PBKDF2 (210,000 rounds, SHA-256) and is non-extractable.</div>
    </div>
  </div></div>`;
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

function endSession() {
  try { app.w?.stop(); } catch { /* nothing left to stop */ }
  app.w = null;
}

async function startSession({ mnemonic, network, fingerprint }) {
  app.screen = 'wallet';
  app.view = 'wallet';
  app.frogSat = null;
  app.frogRecord = null;
  app.w = new WalletSession({ mnemonic, network, fingerprint, settings: loadSettings() });
  app.settings = app.w.settings;
  app.leaders = [];
  app.road = [];
  app.lockError = '';
  app.remember = false;
  sound.setVolume(app.settings.volume);
  sound.setMute(app.settings.mute);
  sound.startLoop();

  // Open the backend, but do not make unlock wait for a chain refresh.
  // PBKDF2 + AES-GCM is the security boundary; a cold gap walk or a
  // rate-limited public Esplora must not hold the lock screen hostage.
  let backendReady = false;
  try {
    await app.w.connect();
    backendReady = true;
  } catch (e) {
    // Keep the wallet shell alive so Settings (where the endpoint can be
    // fixed) is reachable. A half-configured live backend must not trap the
    // user behind a lock screen they can never satisfy.
    console.warn('session backend unavailable', e.message || String(e));
    toast('Chain unavailable — open Settings to fix the endpoint', 'err');
  }

  resetMintDraft();
  app.seenFirstFrog = false;
  app.navChosen = false;
  if (location.hash) { parseHash(); app.navChosen = true; }
  if (app.view === 'frog') app.frogRecord = app.w.frogBySat(app.frogSat) || null;
  navigate(app.view, { push: false });
  if (!app.booted) {
    app.booted = true;
    beginBootIntro();
  }

  if (!backendReady) return;
  const session = app.w;
  session.refresh().then(async () => {
    if (app.w !== session) return;
    if (app.settings.mode === 'demo' && session.balance.total === 0n && !session.actions.length) {
      try {
        await session.demoFund(8, 200000);
        toast('Demo faucet: 8 coins funded', 'ok');
      } catch (e) { /* faucet is optional */ }
    }
    // The first render happened before this pass. Repaint remote-backed
    // views (pond/road/frog) with the newly discovered records.
    if (['pond', 'leaders', 'road', 'frog', 'bio'].includes(app.view)) ensureViewData(app.view);
  }).catch((e) => {
    console.warn('session refresh unavailable', e.message || String(e));
    if (app.w === session) toast('Chain unavailable — open Settings to fix the endpoint', 'err');
  });
}

// The boot splash runs once per page load (the egui app plays it every
// boot); the rules walkthrough follows the first splash until the visitor
// asks never to see them again.
function beginBootIntro() {
  const host = document.getElementById('intro');
  if (!host) { maybeShowRules(); render(); return; }
  app.intro = true;
  playIntro(host, () => {
    app.intro = false;
    maybeShowRules();
    render();
  });
}

function maybeShowRules() {
  if (app.rulesWalk) return;
  try {
    if (!localStorage.getItem('hopper.rulesSeen')) app.rulesWalk = { page: 0, neverAgain: false };
  } catch { /* storage can be denied */ }
}

function finishRules() {
  const walk = app.rulesWalk;
  if (walk?.neverAgain) {
    try { localStorage.setItem('hopper.rulesSeen', '1'); } catch { /* ignore */ }
  }
  app.rulesWalk = null;
  render();
}

async function boot() {
  app.screen = 'boot';
  // The score belongs to the whole app, not to an unlocked wallet: ask for
  // it before onboarding/lock so the first gesture can start it anywhere.
  sound.startLoop();
  if (!hasVault()) {
    app.screen = 'onboard';
    render();
    return;
  }
  // A remembered KEK unlocks without re-deriving it; otherwise ask.
  try {
    const kek = await idbGet('keys', 'kek');
    if (kek) {
      setBusy(true, 'unlocking the pond');
      try {
        const data = await unlockVault('');
        await startSession(data);
        return;
      } finally {
        setBusy(false);
        render();
      }
    }
  } catch {
    // A remembered KEK can be stale, or a live backend can be unreachable.
    // Do not leave a half-started session behind an apparently locked UI.
    endSession();
    app.leaders = [];
    app.road = [];
    app.frogRecord = null;
    sound.stopLoop();
  }
  app.screen = 'lock';
  app.lockError = '';
  render();
}

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

function navigate(view, { push = true, chosen = push } = {}) {
  if (view !== 'settings') app.scanArmed = false;
  app.view = view;
  if (chosen) app.navChosen = true;
  closeDrawer();
  if (push) {
    const hash = (view === 'frog' || view === 'bio')
      ? `#/${view}/${app.frogSat}`
      : `#/${view}`;
    if (location.hash !== hash) history.pushState({ hopper: true }, '', hash);
  }
  lastLocation = location.hash;
  // A route change is not a data refresh: start at the top of the new page.
  window.scrollTo(0, 0);
  render();
  ensureViewData(view);
}

async function ensureFrogRecord(sat, seq) {
  if (!app.w || !app.w.backend || !Number.isSafeInteger(Number(sat))) return;
  const own = app.w.frogBySat(sat);
  if (own) {
    if (seq === viewSeq && (app.view === 'frog' || app.view === 'bio')) app.frogRecord = own;
    return;
  }
  const record = await app.w.backend.frogger(Number(sat)).catch(() => null);
  if (seq !== viewSeq || (app.view !== 'frog' && app.view !== 'bio') || Number(app.frogSat) !== Number(sat)) return;
  app.frogRecord = record;
  render();
}

async function ensureViewData(view) {
  if (!app.w) return;
  const seq = ++viewSeq;
  try {
    if (view === 'frog' || view === 'bio') {
      await ensureFrogRecord(app.frogSat, seq);
    } else if (view === 'pond' || view === 'leaders') {
      const rows = await app.w.leaderboard(30);
      if (seq !== viewSeq) return;
      app.leaders = rows;
      if (app.view === view) render();
    } else if (view === 'road') {
      const rows = await app.w.road();
      if (seq !== viewSeq) return;
      app.road = rows;
      if (app.view === view) render();
    }
  } catch (e) { /* views tolerate missing data */ }
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [view, arg] = h.split('/');
  if ((view === 'frog' || view === 'bio') && arg) {
    const sat = Number(arg);
    if (Number.isSafeInteger(sat)) {
      if (app.frogSat !== sat) app.frogRecord = null;
      app.frogSat = sat;
      app.view = view;
    } else {
      app.view = 'wallet';
    }
  } else if (view === 'rules') {
    app.view = 'wallet';
    app.rulesWalk = { page: 0, neverAgain: false };
  } else if (['wallet', 'pond', 'road', 'mint', 'leaders', 'history', 'settings'].includes(view)) {
    app.view = view;
  } else {
    // An empty or unknown hash is the base route. This matters on Back from
    // a frog detail URL: leaving app.view at 'frog' would render stale data.
    app.view = 'wallet';
  }
}

function handleLocationChange() {
  if (!app.w || app.screen !== 'wallet') return;
  if (location.hash === lastLocation) return;
  lastLocation = location.hash;
  const beforeView = app.view;
  const beforeSat = app.frogSat;
  app.navChosen = true;
  parseHash();
  if (app.view === 'frog' || app.view === 'bio') app.frogRecord = app.w.frogBySat(app.frogSat) || null;
  if (app.view !== beforeView || app.frogSat !== beforeSat) window.scrollTo(0, 0);
  render();
  ensureViewData(app.view);
}

// Both events fire for hash-changing history navigation. Deduplicate them
// by the location we last handled, otherwise every Back/Forward does the
// render and leaderboard/road fetch twice.
window.addEventListener('popstate', handleLocationChange);

// ---------------------------------------------------------------------------
// drawer
// ---------------------------------------------------------------------------

function openDrawer() {
  app.menuOpen = true;
  document.getElementById('drawer')?.classList.add('open');
  document.getElementById('drawer-backdrop')?.classList.add('open');
  render();
}
function closeDrawer() {
  app.menuOpen = false;
  document.getElementById('drawer')?.classList.remove('open');
  document.getElementById('drawer-backdrop')?.classList.remove('open');
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function run(label, fn) {
  if (app.busy) return;
  setBusy(true, label);
  // Let the browser paint the busy overlay before any synchronous work.
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    await fn();
    sound.sfx('tap');
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'err');
    sound.sfx('error');
  } finally {
    setBusy(false);
    render();
  }
}

function openFrog(sat) {
  const n = Number(sat);
  app.frogSat = n;
  // Render the owned record immediately; ensureViewData('frog') fetches a
  // public record. The old await here could navigate after the user had
  // already moved somewhere else.
  app.frogRecord = app.w.frogBySat(n) || null;
  navigate('frog');
}

// ---------------------------------------------------------------------------
// fee recommendations
// ---------------------------------------------------------------------------

let feeRequest = null;

function refreshFeePickers() {
  for (const host of document.querySelectorAll('[data-fee-presets]')) {
    const input = host.dataset.feeFor || '';
    host.innerHTML = screens.feePresets(app, input);
    const picker = host.closest('[data-fee-picker]');
    const source = picker?.querySelector('[data-fee-source]');
    if (source) source.textContent = screens.feeSourceText(app);
    const note = picker?.querySelector('[data-fee-note]');
    if (note) note.textContent = screens.feeNoteText(app);
  }
}

async function loadFeeQuote({ force = false } = {}) {
  const q = app.feeQuote;
  if (!force && q?.status === 'ready' && Date.now() - Number(q.fetchedAt || 0) < FEE_CACHE_MS) return q;
  if (feeRequest) return feeRequest;
  app.feeQuote = { ...q, status: 'loading', error: '' };
  refreshFeePickers();
  feeRequest = fetchFeeQuote()
    .then((quote) => {
      app.feeQuote = { status: 'ready', ...quote };
      refreshFeePickers();
      return app.feeQuote;
    })
    .catch((e) => {
      app.feeQuote = { ...app.feeQuote, status: 'error', error: e.message || String(e) };
      refreshFeePickers();
      throw e;
    })
    .finally(() => { feeRequest = null; });
  return feeRequest;
}

function ensureFeeQuote() {
  if (app.feeQuote?.status === 'loading') return;
  if (app.feeQuote?.status === 'ready'
      && Date.now() - Number(app.feeQuote.fetchedAt || 0) < FEE_CACHE_MS) return;
  loadFeeQuote().catch(() => { /* the manual fee field remains usable */ });
}

function readFeeRate(input) {
  const raw = Number(document.querySelector(`[data-input="${input}"]`)?.value);
  return Number.isFinite(raw) && raw > 0 ? Math.max(1, Math.min(1000, raw)) : app.w.settings.feeRate;
}

function dismissOverlay() {
  app.previewTx = null;
  closeOverlay();
}

const handlers = {
  nav(el) { navigate(el.dataset.view); },
  drawer() {
    if (app.menuOpen) { closeDrawer(); render(); } else openDrawer();
  },
  'drawer-close'() { closeDrawer(); render(); },
  back() {
    // A direct link has no HOPPER history to go back to; stay in the app.
    if (history.state && history.state.hopper) history.back();
    else if (app.w?.frogs?.length) navigate('pond');
    else navigate('wallet');
  },
  'menu-mute'() {
    if (!app.w) return;
    app.w.settings.mute = !app.w.settings.mute;
    app.settings.mute = app.w.settings.mute;
    sound.setMute(app.w.settings.mute);
    saveSettings(app.w.settings);
    render();
  },
  qr() {
    toast('Camera scanning is not wired in this browser build — paste the address instead.', 'err');
  },
  refresh() {
    run('refreshing', async () => {
      await app.w.refresh();
      toast('refreshing…', 'ok');
    });
  },
  rescan() {
    if (!app.w?.startRescan || app.w.scan?.rescan) return;
    // Two taps: a walk of the whole gap is minutes on a public server.
    if (!app.scanArmed) {
      app.scanArmed = true;
      toast('This walks every address in the gap — tap RESCAN again.', 'ok');
      render();
      return;
    }
    app.scanArmed = false;
    app.w.startRescan()
      .then((ok) => { if (ok) toast('Rescan finished', 'ok'); })
      .catch((e) => toast(e.message || String(e), 'err'));
    render();
  },
  'stop-rescan'() {
    app.scanArmed = false;
    app.w?.cancelRescan?.();
    render();
  },
  'toggle-scan'() {
    if (!app.w?.scanState) return;
    if (app.w.scanState().paused) {
      app.w.resumeScan();
      toast('Automatic scanning resumed', 'ok');
    } else {
      app.w.pauseScan();
      toast('Automatic scanning paused — REFRESH still works', 'ok');
    }
    if (app.view === 'settings') refreshScanPanel();
    else render();
  },
  'extend-gap'() {
    if (!app.w?.extendGap) return;
    app.scanArmed = false;
    app.w.extendGap(20)
      .then((n) => toast(`Gap limit is now ${n} addresses`, 'ok'))
      .catch((e) => toast(e.message || String(e), 'err'));
    render();
  },
  'on-road'() {
    app.frogRefusal = 'finish (or die on) the road first — sending mid-crossing would retreat it';
    render();
  },
  'dead-frogs'() {
    openOverlay(screens.deadFrogs(app));
  },
  bio(el) {
    const sat = Number(el.dataset.sat);
    if (!Number.isSafeInteger(sat)) return;
    app.frogSat = sat;
    app.frogRecord = app.w.frogBySat(sat) || app.frogRecord;
    navigate('bio');
  },
  detail(el) {
    const sat = Number(el.dataset.sat ?? app.frogSat);
    if (!Number.isSafeInteger(sat)) return;
    app.frogSat = sat;
    app.frogRecord = app.w.frogBySat(sat) || app.frogRecord;
    navigate('frog');
  },
  'rule-next'() {
    moveRules(1);
  },
  'rule-prev'() {
    moveRules(-1);
  },
  'rule-start'() {
    if (!app.rulesWalk) return;
    finishRules();
  },
  'rule-skip'() {
    finishRules();
  },
  'open-rules'() {
    app.rulesWalk = { page: 0, neverAgain: false };
    app.menuOpen = false;
    render();
  },
  'replay-intro'() {
    const host = document.getElementById('intro');
    if (!host) return;
    app.menuOpen = false;
    app.intro = true;
    playIntro(host, () => { app.intro = false; render(); });
  },

  'ob-create'() {
    app.ob = { ...app.ob, step: 'words', mode: 'create', mnemonic: newMnemonic(12), error: '' };
    render();
  },
  'ob-import'() {
    app.ob = { ...app.ob, step: 'import', mode: 'import', mnemonic: '', error: '' };
    render();
  },
  'ob-words-done'() {
    app.ob = { ...app.ob, step: 'password', error: '' };
    render();
  },
  'ob-import-next'() {
    const m = (app.ob.mnemonic || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!isValidMnemonic(m)) {
      app.ob = { ...app.ob, error: 'That is not a valid BIP-39 mnemonic.' };
      render();
      return;
    }
    app.ob = { ...app.ob, mnemonic: m, step: 'password', error: '' };
    render();
  },
  'ob-back'() {
    const step = app.ob.step;
    const next = step === 'password' ? (app.ob.mode === 'create' ? 'words' : 'import') : 'welcome';
    app.ob = { ...app.ob, step: next, error: '' };
    render();
  },
  'ob-lock'() {
    app.screen = 'lock';
    app.lockError = '';
    render();
  },
  'use-another'() {
    if (!confirm('Replace the vault on this device? The current 12 words are the only way back.')) return;
    sound.stopLoop();
    destroyVault();
    endSession();
    app.view = 'wallet';
    app.frogSat = null;
    app.frogRecord = null;
    app.leaders = [];
    app.road = [];
    app.screen = 'onboard';
    app.ob = { step: 'welcome', mode: 'create', mnemonic: '', password: '', confirm: '', network: 'mainnet', remember: false };
    app.lockError = '';
    history.replaceState(null, '', location.pathname);
    render();
  },
  'ob-finish'() {
    run('sealing the vault', async () => {
      const o = app.ob;
      if (o.password.length < 6) throw new Error('Use a password of at least 6 characters');
      if (o.password !== o.confirm) throw new Error('The passwords do not match');
      const wallet = deriveWallet(o.mnemonic, o.network);
      const data = await createVault({
        mnemonic: o.mnemonic, password: o.password, network: o.network,
        fingerprint: wallet.fingerprint, remember: !!o.remember,
      });
      try {
        await startSession(data);
      } catch (e) {
        // The vault exists, but the session did not start (for example a
        // configured live backend is down). Leave a usable lock screen
        // rather than a wallet shell with no backend.
        endSession();
        app.screen = 'lock';
        app.lockError = e.message;
        sound.stopLoop();
        throw e;
      }
      toast('Vault sealed. Welcome to the pond.', 'ok');
    });
  },
  unlock() {
    run('unlocking', async () => {
      const pw = document.querySelector('[data-input=lock-password]')?.value || '';
      app.remember = !!document.querySelector('[data-input=lock-remember]')?.checked;
      try {
        const data = await unlockVault(pw, { remember: app.remember });
        await startSession(data);
        toast('Unlocked', 'ok');
      } catch (e) {
        endSession();
        app.leaders = [];
        app.road = [];
        app.frogRecord = null;
        app.lockError = e.message;
        app.screen = 'lock';
        sound.stopLoop();
        throw e;
      }
    });
  },
  lock() {
    run('locking', async () => {
      await lockVault();
      sound.stopLoop();
      endSession();
      app.remember = false;
      app.leaders = [];
      app.road = [];
      app.frogRecord = null;
      app.screen = 'lock';
      app.lockError = '';
      navigate('wallet', { push: false });
    });
  },
  wipe() {
    if (!confirm('Wipe this device? The 12 words are the only way back.')) return;
    run('wiping', async () => {
      sound.stopLoop();
      // Wipe every HOPPER key, not just the current ledger: settings,
      // address book, demo chain and ledger are all user data.
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('hopper.')) localStorage.removeItem(key);
      }
      destroyVault();
      if (globalThis.indexedDB) indexedDB.deleteDatabase('hopper');
      endSession();
      app.view = 'wallet';
      app.frogSat = null;
      app.frogRecord = null;
      app.leaders = [];
      app.road = [];
      app.screen = 'onboard';
      app.ob = { step: 'welcome', mode: 'create', mnemonic: '', password: '', confirm: '', network: 'mainnet', remember: false };
      app.settings = loadSettings();
      history.replaceState(null, '', location.pathname);
      // Reload closes the IndexedDB connection so the delete can finish.
      setTimeout(() => location.reload(), 60);
    });
  },
  'reveal-words'() {
    if (app.w) openOverlay(screens.seedWarning(), { lily: 'dead' });
  },
  'reveal-words-approved'() {
    if (app.w) openOverlay(screens.wordsModal(app), { lily: 'dead' });
  },
  'sheet-receive'() { openOverlay(screens.receiveSheet(app), { type: 'sheet', lily: 'home' }); },
  'receive-tab'(el) {
    app.receiveTab = el.dataset.tab === 'ord' ? 'ord' : 'btc';
    openOverlay(screens.receiveSheet(app), { type: 'sheet', lily: 'home' });
  },
  'new-receive'() {
    if (!app.w) return;
    app.w.newReceiveAddress();
    app.receiveTab = 'btc';
    openOverlay(screens.receiveSheet(app), { type: 'sheet', lily: 'home' });
    toast('new receive address', 'ok');
  },
  'full-qr'(el) {
    const address = el.dataset.text || app.w?.receiveAddress() || '';
    openOverlay(screens.qrSheet(app, address), { lily: 'home' });
  },
  'receive-book'() { openOverlay(screens.receiveBook(app), { lily: 'home' }); },
  'sheet-send'() {
    openOverlay(screens.sendSheet(app), { type: 'sheet' });
    ensureFeeQuote();
  },
  'bump-fee'(el) {
    const action = app.w?.actions?.find((a) => a.txid === el.dataset.txid && a.kind === 'send');
    if (action) {
      openOverlay(screens.bumpFeeSheet(app, action), { lily: 'accent' });
      ensureFeeQuote();
    }
  },
  'sheet-transfer'(el) {
    const f = app.w.frogBySat(el.dataset.sat);
    if (f) {
      openOverlay(screens.transferSheet(app, f));
      ensureFeeQuote();
    }
  },
  'sheet-cross'(el) {
    const f = app.w.frogBySat(el.dataset.sat);
    if (f) {
      openOverlay(screens.crossSheet(app, f));
      ensureFeeQuote();
    }
  },
  'fee-choice'(el) {
    const target = el.dataset.target;
    const rate = Number(el.dataset.rate);
    const input = document.querySelector(`[data-input="${target}"]`);
    if (!input || !Number.isFinite(rate) || rate <= 0) return;
    input.value = String(rate);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (const b of document.querySelectorAll(`[data-action="fee-choice"][data-target="${target}"]`)) {
      b.classList.toggle('on', b === el);
    }
  },
  'fee-retry'() {
    if (feeRequest) return;
    loadFeeQuote({ force: true }).catch((e) => toast(e.message || String(e), 'err'));
  },
  'preview-send'() {
    if (app.busy) return;
    const to = (document.querySelector('[data-input=send-to]')?.value || '').trim();
    const amount = Number(document.querySelector('[data-input=send-amount]')?.value || 0);
    const feeRate = readFeeRate('send-fee');
    if (!to) { toast('Enter a recipient address first', 'err'); return; }
    run('building the transaction preview', async () => {
      const preview = await app.w.previewSend(to, amount, { feeRate });
      app.previewTx = preview;
      openOverlay(screens.txPreviewSheet(app, preview), { lily: 'accent' });
    });
  },
  'preview-transfer'(el) {
    if (app.busy) return;
    const f = app.w.frogBySat(el.dataset.sat);
    if (!f) return;
    const to = (document.querySelector('[data-input=transfer-to]')?.value || '').trim();
    const feeRate = readFeeRate('transfer-fee');
    if (!to) { toast('Enter a recipient address first', 'err'); return; }
    run('building the Hopper transfer preview', async () => {
      const preview = await app.w.previewTransfer(f, to, { feeRate });
      app.previewTx = preview;
      openOverlay(screens.txPreviewSheet(app, preview), { lily: 'accent' });
    });
  },
  'abort-preview'() {
    dismissOverlay();
    toast('transaction cancelled', 'ok');
  },
  'do-approve-tx'() {
    if (app.busy) return;
    const preview = app.previewTx;
    if (!preview) { dismissOverlay(); return; }
    run('checking and broadcasting', async () => {
      const built = await app.w.broadcastPreview(preview);
      app.previewTx = null;
      closeOverlay();
      if (preview.kind === 'mint') {
        resetMintDraft();
        updateMintPreview();
        sound.sfx('mint');
        toast(`Minted ${preview.name || 'frog'} on sat ${sats(preview.sat)}`, 'ok');
        navigate('pond');
      } else if (preview.kind === 'transfer') {
        toast(`Hopper sent to ${shortHash(preview.to, 6)}`, 'ok');
        navigate('pond');
      } else if (preview.kind === 'hop') {
        const direction = ['LEFT', 'STRAIGHT', 'RIGHT'][preview.dir];
        sound.sfx('cross');
        toast(`HOP ${direction} confirmed at H ${sats(app.w.tipHeight)} — the next block decides, settlement in 6`, 'ok');
        navigate('road');
      } else {
        toast(`Sent ${sats(preview.amountNumber)} sats in ${shortHash(built.txid, 6)}`, 'ok');
      }
    });
  },
  'close-overlay'() { dismissOverlay(); },
  copy(el) { copyText(el.dataset.text || '', el.dataset.copyLabel || 'copied'); },
  'download-history-debug'() {
    // The last History paint is saved in app.historyDom; Settings is on
    // screen now, so reading #app would return no History rows.
    const data = screens.historyDebug(app.w, app.historyDom || []);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadText(data, `hopper-history-${stamp}.txt`, 'history data downloaded');
  },
  'esplora-preset'(el) {
    const input = document.querySelector('[data-input=esploraUrl]');
    if (!input) return;
    input.value = el.dataset.url || '';
    input.focus();
    toast('Endpoint filled — press APPLY to connect', 'ok');
  },

  'open-frog'(el) { openFrog(el.dataset.sat); },

  faucet() {
    run('tapping the faucet', async () => {
      await app.w.demoFund(8, 200000);
      toast('8 coins funded', 'ok');
      await ensureViewData(app.view);
    });
  },
  mine(el) {
    run('mining', async () => {
      const n = Number(el.dataset.n || 1);
      const before = new Map(app.w.frogs.map((f) => [Number(f.sat), f.state]));
      await app.w.mine(n);
      const settled = app.w.frogs.filter((f) => before.get(Number(f.sat)) === 'crossing' && f.state !== 'crossing');
      for (const f of settled) {
        toast(`${f.name || 'frog'}: ${String(f.state).toUpperCase()}`, f.state === 'home' ? 'ok' : 'err');
        sound.sfx(f.state === 'home' ? 'win' : 'error');
      }
      toast(`Mined ${n} block${n === 1 ? '' : 's'}`, 'ok');
      await ensureViewData(app.view);
    });
  },
  'random-seed'() {
    newMintSeed();
    updateMintPreview();
  },
  'preview-mint'() {
    if (app.busy) return;
    const seed = app.mintSeed >>> 0;
    const name = app.mintName.slice(0, 38);
    run('building the mint preview', async () => {
      const preview = await app.w.previewMint({ seed, name });
      app.previewTx = preview;
      openOverlay(screens.txPreviewSheet(app, preview), { lily: 'accent' });
    });
  },
  'export-emergency'() {
    openOverlay(screens.emergencyWarning(app), { lily: 'dim' });
  },
  'export-recovery'() {
    const doc = app.w?.recoveryPackDoc?.();
    if (!doc || !doc.packs.length) {
      toast('No recovery packs yet — TRAVEL TO ROAD first', 'warn');
      return;
    }
    openOverlay(screens.recoverySheet(app, doc), { lily: 'accent' });
  },
  'copy-recovery'() {
    const text = document.querySelector('[data-recovery-json]')?.textContent || '';
    if (!text) return;
    navigator.clipboard?.writeText(text).then(
      () => toast('Recovery packs copied', 'ok'),
      () => toast('Clipboard is not available', 'warn'),
    );
  },
  'show-emergency'() {
    const doc = app.w.emergencyDescriptors();
    if (!doc.frogs.length) {
      toast('No staged Hopper to export — TRAVEL TO ROAD first', 'warn');
      return;
    }
    openOverlay(screens.emergencySheet(app, doc), { lily: 'accent' });
  },
  'copy-emergency'() {
    const text = document.querySelector('[data-emergency-json]')?.textContent || '';
    if (!text) return;
    navigator.clipboard?.writeText(text).then(
      () => toast('Emergency descriptors copied', 'ok'),
      () => toast('Clipboard is not available', 'warn'),
    );
  },
  'travel-to-road'(el) {
    const f = app.w?.frogBySat(el.dataset.sat);
    if (f) openOverlay(screens.travelWarning(app, f), { lily: 'accent' });
  },
  'travel-approved'(el) {
    const f = app.w?.frogBySat(el.dataset.sat);
    if (!f) return;
    const staged = app.w._frogUtxo?.(f)?.kind === 'state';
    closeOverlay();
    if (staged) {
      toast('This Hopper is already staged on The Road', 'ok');
      navigate('road');
      return;
    }
    run('traveling to The Road', async () => {
      const built = await app.w.prepare(f);
      toast(`Staged on The Road in ${shortHash(built.txid, 6)} · normal spends still work`, 'ok');
      navigate('road');
    });
  },
  'preview-hop'(el) {
    const f = app.w.frogBySat(el.dataset.sat);
    if (!f) return;
    const dir = Number(el.dataset.dir);
    if (!Number.isInteger(dir) || dir < 0 || dir > 2) {
      toast('Choose LEFT, STRAIGHT or RIGHT', 'warn');
      return;
    }
    const ownerAddr = (document.querySelector('[data-input=cross-owner]')?.value || '').trim();
    const fee = Number(document.querySelector('[data-input=cross-fee]')?.value || app.settings.feeRate);
    let newOwnerXonly = null;
    if (ownerAddr) {
      try {
        const d = decodeAddress(ownerAddr, app.w.network);
        if (d.type !== 'p2tr') throw new Error('The new owner must be a P2TR address');
        newOwnerXonly = d.program;
      } catch (err) {
        toast(err.message || 'The new owner must be a P2TR address', 'warn');
        return;
      }
    }
    run('building the hop preview', async () => {
      const preview = await app.w.previewCross(f, { dir, feeRate: fee, newOwnerXonly });
      app.previewTx = preview;
      openOverlay(screens.hopReviewSheet(app, preview), { lily: 'accent' });
    });
  },
  'do-cross'(el) {
    const f = app.w.frogBySat(el.dataset.sat);
    if (!f) return;
    const dir = Number(el.dataset.dir);
    if (!Number.isInteger(dir) || dir < 0 || dir > 2) {
      toast('Choose LEFT, STRAIGHT or RIGHT', 'warn');
      return;
    }
    const direction = ['LEFT', 'STRAIGHT', 'RIGHT'][dir];
    const fee = Number(el.dataset.fee || app.settings.feeRate);
    const ownerHex = String(el.dataset.owner || '');
    let newOwnerXonly = null;
    if (ownerHex) {
      if (!/^[0-9a-f]{64}$/i.test(ownerHex)) {
        toast('The previewed owner key is malformed', 'warn');
        return;
      }
      newOwnerXonly = Uint8Array.from(ownerHex.match(/../g).map((x) => parseInt(x, 16)));
    }
    run(`hopping ${direction.toLowerCase()}`, async () => {
      const built = await app.w.cross(f, { feeRate: fee, newOwnerXonly, dir });
      closeOverlay();
      sound.sfx('cross');
      toast(`HOP ${direction} confirmed at H ${sats(app.w.tipHeight)} — the next block decides, settlement in 6`, 'ok');
      navigate('road');
    });
  },
  'do-bump'(el) {
    const txid = el.dataset.txid;
    const feeRate = Number(document.querySelector('[data-input=bump-fee-rate]')?.value || 0);
    run('replacing the transaction', async () => {
      const built = await app.w.bumpFee(txid, { feeRate });
      closeOverlay();
      toast(`Bumped to ${sats(built.fee)} sats in ${shortHash(built.txid, 6)}`, 'ok');
      navigate('history');
    });
  },
  'apply-backend'() {
    run('connecting', async () => {
      const q = (k) => document.querySelector(`[data-input=${k}]`)?.value;
      const previous = { ...app.w.settings };
      const next = {
        ...previous,
        mode: q('mode') || 'live',
        esploraUrl: q('esploraUrl') || '',
        indexerUrl: q('indexerUrl') || '',
        electrumUrl: q('electrumUrl') || '',
        ordUrl: q('ordUrl') || '',
      };
      try {
        app.w.settings = next;
        app.settings = next;
        const changed = next.mode !== previous.mode
          || next.esploraUrl !== previous.esploraUrl
          || next.indexerUrl !== previous.indexerUrl
          || next.electrumUrl !== previous.electrumUrl
          || next.ordUrl !== previous.ordUrl;
        if (changed && app.w.resetScan) app.w.resetScan();
        await app.w.connect();
        // refresh() tolerates a missing chain (views degrade gracefully);
        // APPLY should not. Probe the tip before adopting the new backend.
        await app.w.backend.tipHeight();
        await app.w.refresh();
        saveSettings(app.w.settings);
        toast(`Connected in ${app.w.settings.mode} mode`, 'ok');
        navigate(app.view);
      } catch (e) {
        // APPLY used to save a half-applied mode/URL first, leaving the UI
        // claiming "live" while the old backend was still in use. Restore
        // both the backend and the settings on any connection failure.
        app.w.settings = previous;
        app.settings = previous;
        try { await app.w.connect(); } catch { /* keep the old backend if possible */ }
        throw e;
      }
    });
  },
  'test-backend'() {
    run('testing the chain', async () => {
      const h = await app.w.backend.tipHeight();
      let probe = '';
      try {
        const key = app.w.keys.receive(0);
        const list = await app.w.backend.addressUtxos(key.address, key.script);
        probe = ` · address endpoint answered (${list.length} UTXO${list.length === 1 ? '' : 's'})`;
      } catch (e) {
        throw new Error(`height ${sats(h)} answered, but the address endpoint failed: ${e.message || String(e)}`);
      }
      toast(`Chain answered: height ${sats(h)}${probe}`, 'ok');
    });
  },
  'add-address'() {
    const name = (document.querySelector('[data-input=book-name]')?.value || '').trim();
    const address = (document.querySelector('[data-input=book-address]')?.value || '').trim();
    try {
      decodeAddress(address, app.w.network);
      if (!name) throw new Error('Give the address a name');
      app.w.settings.addressBook = [...(app.w.settings.addressBook || []), { name, address }];
      saveSettings(app.w.settings);
      render();
      toast('Address saved', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  },
  'drop-address'(el) {
    app.w.settings.addressBook.splice(Number(el.dataset.i), 1);
    saveSettings(app.w.settings);
    render();
  },
  'reset-demo'() {
    if (!confirm('Reset the local demo chain? Frogs and coins in the demo are lost.')) return;
    run('resetting the demo chain', async () => {
      app.w.backend = new DemoBackend(app.w.network, { fresh: true });
      app.w.imported.clear();
      app.w.actions = [];
      app.w.receives = [];
      app.w.receivesVersion = 0;
      app.w.changes = [];
      app.w.changesVersion = 0;
      app.w.chainMints = [];
      app.w.mempool = [];
      app.w.pending = [];
      app.w.history = [];
      app.w.frogs = [];
      app.w.utxos = [];
      app.w._saveLedger();
      await app.w.refresh();
      await app.w.demoFund(8, 200000);
      toast('Demo chain reset', 'ok');
      navigate('wallet');
    });
  },
};

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

// Swipe the rules like a deck of cards. The gesture is deliberately
// touch/pen-only: dragging a mouse across the rules should still select
// text. `touch-action: pan-y` on .rules-screen leaves vertical scrolling
// to the browser while letting a horizontal gesture reach these events.
document.addEventListener('pointerdown', (ev) => {
  if (ev.isPrimary === false) { ruleSwipe = null; return; }
  if (!app.rulesWalk || ev.pointerType === 'mouse' || !ev.target.closest?.('.rules-screen')) {
    ruleSwipe = null;
    return;
  }
  if (ev.target.closest('button, input, label, a, select, textarea, [contenteditable="true"]')) {
    ruleSwipe = null;
    return;
  }
  ruleSwipe = { id: ev.pointerId, x: ev.clientX, y: ev.clientY };
});

document.addEventListener('pointerup', (ev) => {
  if (!ruleSwipe || ruleSwipe.id !== ev.pointerId) return;
  const dx = ev.clientX - ruleSwipe.x;
  const dy = ev.clientY - ruleSwipe.y;
  ruleSwipe = null;
  if (!app.rulesWalk) return;
  if (Math.abs(dx) < RULE_SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 1.2) return;
  if (moveRules(dx < 0 ? 1 : -1)) ruleSwipeUntil = performance.now() + 350;
});

document.addEventListener('pointercancel', (ev) => {
  if (ruleSwipe && ruleSwipe.id === ev.pointerId) ruleSwipe = null;
});

// A finger that leaves the screen over a button must not also activate it.
document.addEventListener('click', (ev) => {
  if (performance.now() > ruleSwipeUntil) return;
  if (!ev.target.closest?.('.rules-screen')) return;
  ev.preventDefault();
  ev.stopPropagation();
  ruleSwipeUntil = 0;
}, true);

document.addEventListener('click', (ev) => {
  const target = ev.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  const handler = handlers[action];
  if (!handler) return;
  ev.preventDefault();
  ev.stopPropagation();
  handler(target, ev);
});

document.addEventListener('input', (ev) => {
  const key = ev.target.dataset?.input;
  if (!key) return;
  const value = ev.target.value;
  if (key === 'mint-name') {
    app.mintName = value;
    updateMintPreview();
  } else if (key === 'ob-mnemonic') {
    app.ob = { ...app.ob, mnemonic: value };
  } else if (key === 'ob-password') {
    app.ob = { ...app.ob, password: value };
  } else if (key === 'ob-confirm') {
    app.ob = { ...app.ob, confirm: value };
  } else if (key === 'ob-network') {
    app.ob = { ...app.ob, network: value };
  } else if (key === 'ob-remember') {
    app.ob = { ...app.ob, remember: !!ev.target.checked };
  } else if (key === 'lock-remember') {
    app.remember = !!ev.target.checked;
  } else if (key === 'rules-never') {
    if (app.rulesWalk) app.rulesWalk.neverAgain = !!ev.target.checked;
  } else if (key === 'volume' && app.w) {
    // Update the live gain while dragging; persist once on `change` so a
    // range drag does not synchronously rewrite localStorage sixty times.
    const volume = volumeFromRange(value, ev.target.max);
    if (volume == null) return;
    app.w.settings.volume = volume;
    app.settings.volume = volume;
    sound.setVolume(volume);
  }
  const picker = ev.target.closest?.('[data-fee-picker]');
  if (picker) {
    const rate = Number(value);
    for (const b of picker.querySelectorAll('[data-action="fee-choice"]')) {
      b.classList.toggle('on', Number(b.dataset.rate) === rate);
    }
  }
});

document.addEventListener('change', (ev) => {
  const key = ev.target.dataset?.input;
  if (!key || !app.w) return;
  const value = ev.target.value;
  if (key === 'deepScan') {
    app.w.settings.deepScan = value === '1';
    saveSettings(app.w.settings);
  } else if (key === 'spendUnconfirmed') {
    app.w.settings.spendUnconfirmed = value !== '0';
    saveSettings(app.w.settings);
    app.w._computeBalance();
    render();
  } else if (key === 'mute') {
    app.w.settings.mute = value === '1';
    app.settings.mute = app.w.settings.mute;
    sound.setMute(app.w.settings.mute);
    saveSettings(app.w.settings);
    render();
  } else if (key === 'volume') {
    const volume = volumeFromRange(value, ev.target.max);
    if (volume == null) return;
    app.w.settings.volume = volume;
    app.settings.volume = volume;
    sound.setVolume(volume);
    saveSettings(app.w.settings);
    render();
  } else if (['esploraUrl', 'indexerUrl', 'electrumUrl', 'ordUrl', 'mode'].includes(key)) {
    // Applied explicitly by APPLY so a half-typed URL never disconnects.
  } else if (key === 'mint-name') {
    app.mintName = value;
    updateMintPreview();
  }
});

document.getElementById('overlay')?.addEventListener('click', (ev) => {
  if (ev.target.id === 'overlay' && ev.target.dataset.dismissable !== '0') dismissOverlay();
  if (ev.target.closest('[data-action=close-overlay]')) dismissOverlay();
});
document.getElementById('drawer-backdrop')?.addEventListener('click', () => { closeDrawer(); render(); });

// The shell is static; a service worker makes the demo (and the UI over a
// flaky link) work offline. Live chain calls are always network-only.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  let reloadedForWorker = false;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloadedForWorker) return;
    reloadedForWorker = true;
    location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
      .catch((e) => console.warn('service worker', e.message));
  });
}
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { dismissOverlay(); closeDrawer(); render(); }
  if (ev.key === 'Enter' && app.screen === 'lock') {
    const el = document.querySelector('[data-action=unlock]');
    if (el) el.click();
  }
});

function refreshScanPanel() {
  const host = document.querySelector('[data-scan-panel]');
  if (!host || !app.w || typeof screens.scanPanel !== 'function') return;
  host.innerHTML = screens.scanPanel(app);
}

window.addEventListener('hopper:refresh', () => {
  if (!app.w) return;
  if (app.busy && app.view !== 'history') return;
  if (app.view === 'settings') {
    // Do not re-render the whole settings form while the user is editing
    // a URL; the scan window is the only part that changes on a tick.
    refreshScanPanel();
    return;
  }
  if (!['wallet', 'pond', 'road', 'history', 'frog', 'leaders'].includes(app.view)) return;
  render();
});


// A ledger repair can land while History is already on screen. Repaint it
// on return-to-foreground as well as on the wallet refresh event, so the
// corrected group is never hidden behind a stale card list.
function repaintHistory() {
  if (app.w && !app.busy && app.view === 'history') render();
}
window.addEventListener('focus', repaintHistory);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) repaintHistory();
});

window.addEventListener('hopper:scan', () => {
  if (!app.w) return;
  if (app.view === 'settings') refreshScanPanel();
});

// A paid receive address is retired by the wallet. If the receive window is
// open on BITCOIN, repaint it with the next address instead of leaving a QR
// that is no longer the wallet's fresh receive address. The HOPPERS tab is a
// fixed Taproot address and must not be repainted by BTC rotation.
window.addEventListener('hopper:receive-address', () => {
  if (!app.w) return;
  const node = document.getElementById('overlay');
  if (!node || node.hidden) return;
  const sheet = node.querySelector('.sheet');
  if (!sheet || !sheet.querySelector('.receive-tabs')) return;
  if (app.receiveTab !== 'btc') return;
  const shown = sheet.querySelector('.receive-address')?.textContent.trim() || '';
  if (shown === app.w.receiveAddress()) return;
  openOverlay(screens.receiveSheet(app), { type: 'sheet', lily: 'home' });
});

// Keep settings in sync if another tab edits them.
window.addEventListener('storage', (ev) => {
  if (ev.key === KEYS.settings) {
    app.settings = loadSettings();
    if (app.w) app.w.settings = { ...app.w.settings, ...app.settings };
    sound.setVolume(app.settings.volume);
    sound.setMute(app.settings.mute);
    render();
  }
});

// ---------------------------------------------------------------------------

window.addEventListener('hashchange', handleLocationChange);

function refreshSoundLines() {
  if (typeof document === 'undefined' || document.hidden) return;
  const text = screens.soundLine(app);
  for (const el of document.querySelectorAll('[data-sound-line]')) el.textContent = text;
}
setInterval(refreshSoundLines, 1000);

boot().catch((e) => {
  console.error(e);
  app.screen = 'onboard';
  render();
  toast(e.message || String(e), 'err');
});
