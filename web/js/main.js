// HOPPER PWA — boot, vault, routing, and event handling.

import {
  busy, closeOverlay, copyText, esc, frogImg, openOverlay, seedText,
  shortHash, sats, spriteUri, toast,
} from './ui/dom.js';
import * as screens from './ui/screens.js';
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
  ob: { step: 'welcome', mode: 'create', mnemonic: '', password: '', confirm: '', network: 'regtest', remember: false },
  lockError: '',
  frogLogo: spriteUri(0x9058d0fa, 'idle'),
  previewUri: '',
  screen: 'boot',
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
let armed = false;
let viewSeq = 0;
let lastLocation = null;
function armSound() {
  if (armed) return;
  armed = true;
  sound.arm();
}
document.addEventListener('pointerdown', armSound, { once: true });
document.addEventListener('keydown', armSound, { once: true });

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
    case 'rules': return screens.rules(app);
    case 'frog': return screens.frogDetail(app, app.frogSat);
    default: return screens.wallet(app);
  }
}

function render() {
  const root = document.getElementById('app');
  if (!root) return;
  if (app.screen === 'onboard') root.innerHTML = onboarding();
  else if (app.screen === 'lock') root.innerHTML = lockScreen();
  else if (app.w) root.innerHTML = screens.topbar(app) + viewHtml();
  else root.innerHTML = '';

  const drawer = document.getElementById('drawer');
  if (drawer) drawer.innerHTML = app.w ? screens.drawer(app) : '';
  const tabbar = document.getElementById('tabbar');
  if (tabbar) {
    tabbar.hidden = !app.w;
    tabbar.innerHTML = app.w ? screens.tabbar(app) : '';
  }
  const b = document.getElementById('busy');
  if (b) b.hidden = !app.busy;
  updateMintPreview();
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
}

// ---------------------------------------------------------------------------
// onboarding / lock
// ---------------------------------------------------------------------------

function onboarding() {
  const o = app.ob;
  const logo = `<div class="logo"><img src="${app.frogLogo}" alt=""><span class="word">HOPPER</span><span class="tag">THE POND ON BITCOIN</span></div>`;
  if (o.step === 'welcome') {
    return `<div class="onboard"><div class="stage" style="text-align:center">
      ${logo}
      <div class="panel lily" style="text-align:left">
        <h2>NO SERVER ON THE ART'S TRUST PATH</h2>
        <p class="muted">A Hopper is a satoshi whose life is a sequence of Bitcoin transactions. The wallet signs; the chain decides. Twelve words are the only backup.</p>
        <div class="panel bark" style="padding:12px;margin-top:12px">
          <div class="kv"><dt>Wire</dt><dd>v6 · 0x06</dd><dt>Cards</dt><dd>25,000 sats</dd><dt>Finality</dt><dd>6 blocks</dd></div>
        </div>
        <div class="actions" style="margin-top:14px">
          <button class="btn primary" data-action="ob-create">CREATE A WALLET</button>
          <button class="btn" data-action="ob-import">IMPORT 12 WORDS</button>
        </div>
        ${hasVault() ? '<button class="btn ghost wide small" style="margin-top:10px" data-action="ob-lock">I HAVE A VAULT — UNLOCK</button>' : ''}
        <div class="hint" style="margin-top:10px">Demo mode runs against an in-browser chain. Switch to a live indexer in Settings at any time.</div>
      </div>
      <div class="footer">HOPPER v6 · HOPPER-PROTOCOL</div>
    </div></div>`;
  }
  if (o.step === 'words') {
    const words = o.mnemonic.trim().split(/\s+/);
    return `<div class="onboard"><div class="stage">
      ${logo}
      <div class="panel lily">
        <div class="row"><h2>YOUR 12 WORDS</h2><div class="spacer"></div><span class="badge warn">ONLY BACKUP</span></div>
        <div class="warnbox" style="margin-top:10px">Write these on paper. Anyone who reads them owns every frog at this address. Never a screenshot, never a chat.</div>
        <div class="words" style="margin-top:12px">${words.map((w, i) => `<span><b>${i + 1}</b>${esc(w)}</span>`).join('')}</div>
        <div class="actions" style="margin-top:12px">
          <button class="btn ghost" data-action="copy" data-text="${esc(words.join(' '))}">COPY</button>
          <button class="btn primary" data-action="ob-words-done">I WROTE THEM DOWN</button>
        </div>
        <button class="btn ghost small" style="margin-top:8px" data-action="ob-back">BACK</button>
      </div>
    </div></div>`;
  }
  if (o.step === 'import') {
    return `<div class="onboard"><div class="stage">
      ${logo}
      <div class="panel lily">
        <h2>IMPORT A WALLET</h2>
        <p class="muted small">Twelve lowercase words, separated by spaces.</p>
        <textarea data-input="ob-mnemonic" spellcheck="false" autocomplete="off" placeholder="deliver cat inch coyote …">${esc(o.mnemonic)}</textarea>
        ${o.error ? `<div class="warnbox" style="margin-top:8px;border-color:var(--danger)">${esc(o.error)}</div>` : ''}
        <div class="actions" style="margin-top:12px">
          <button class="btn ghost" data-action="ob-back">BACK</button>
          <button class="btn primary" data-action="ob-import-next">CONTINUE</button>
        </div>
      </div>
    </div></div>`;
  }
  // password step
  const networks = [['regtest', 'Regtest (local)'], ['testnet', 'Testnet'], ['signet', 'Signet'], ['mainnet', 'Mainnet']];
  return `<div class="onboard"><div class="stage">
    ${logo}
    <div class="panel lily">
      <h2>SEAL THE VAULT</h2>
      <p class="muted small">AES-256-GCM under a non-extractable WebCrypto KEK. The password never leaves this device.</p>
      <label class="field"><span>Password (min 6)</span><input type="password" data-input="ob-password" value="${esc(o.password)}" autocomplete="new-password"></label>
      <label class="field"><span>Confirm</span><input type="password" data-input="ob-confirm" value="${esc(o.confirm)}" autocomplete="new-password"></label>
      <label class="field"><span>Network</span>
        <select data-input="ob-network">${networks.map(([v, l]) => `<option value="${v}" ${o.network === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <label class="check"><input type="checkbox" data-input="ob-remember" ${o.remember ? 'checked' : ''}> <span>Keep this device unlocked</span></label>
      <div class="hint">Coin type: mainnet 0, everything else 1. No password is stored; the KEK stays in this browser only if you ask. The 12 words are the only recovery.</div>
      ${o.error ? `<div class="warnbox" style="margin-top:8px;border-color:var(--danger)">${esc(o.error)}</div>` : ''}
      <div class="actions" style="margin-top:12px">
        <button class="btn ghost" data-action="ob-back">BACK</button>
        <button class="btn primary" data-action="ob-finish">OPEN THE POND</button>
      </div>
    </div>
  </div></div>`;
}

function lockScreen() {
  const info = vaultInfo();
  return `<div class="onboard"><div class="stage" style="max-width:520px">
    <div class="logo"><img src="${app.frogLogo}" alt=""><span class="word">HOPPER</span><span class="tag">LOCKED</span></div>
    <div class="panel lily">
      <div class="kv">
        <dt>Network</dt><dd>${esc(info?.network || '—')}</dd>
        <dt>Fingerprint</dt><dd>${esc(info?.fingerprint || '—')}</dd>
        <dt>Backup</dt><dd>${info?.words || 12} words</dd>
      </div>
      <label class="field" style="margin-top:12px"><span>Password</span>
        <input type="password" data-input="lock-password" autocomplete="current-password" placeholder="••••••••">
      </label>
      <label class="check"><input type="checkbox" data-input="lock-remember" ${app.remember ? 'checked' : ''}> <span>Keep this device unlocked</span></label>
      ${app.lockError ? `<div class="warnbox" style="border-color:var(--danger);margin-bottom:10px">${esc(app.lockError)}</div>` : ''}
      <button class="btn primary wide" data-action="unlock">UNLOCK</button>
      <div class="actions" style="margin-top:10px">
        <button class="btn ghost small" data-action="use-another">USE ANOTHER VAULT</button>
        <button class="btn danger small" data-action="wipe">WIPE DEVICE</button>
      </div>
      <div class="hint">Wrong passwords never decrypt. The KEK is derived with PBKDF2 (210,000 rounds, SHA-256) and is non-extractable.</div>
    </div>
  </div></div>`;
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

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
  try {
    await app.w.connect();
    await app.w.refresh();
  } catch (e) {
    // Keep the wallet shell alive so Settings (where the endpoint can be
    // fixed) is reachable. A half-configured live backend must not trap the
    // user behind a lock screen they can never satisfy.
    console.warn('session backend unavailable', e.message || String(e));
    toast('Chain unavailable — open Settings to fix the endpoint', 'err');
  }
  if (app.settings.mode === 'demo' && app.w.balance.total === 0n && !app.w.actions.length) {
    try {
      await app.w.demoFund(8, 200000);
      toast('Demo faucet: 8 coins funded', 'ok');
    } catch (e) { /* faucet is optional */ }
  }
  resetMintDraft();
  if (location.hash) parseHash();
  if (app.view === 'frog') app.frogRecord = app.w.frogBySat(app.frogSat) || null;
  navigate(app.view, { push: false });
}

async function boot() {
  app.screen = 'boot';
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
    app.w = null;
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

function navigate(view, { push = true } = {}) {
  app.view = view;
  closeDrawer();
  if (push) {
    const hash = view === 'frog' ? `#/frog/${app.frogSat}` : `#/${view}`;
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
    if (seq === viewSeq && app.view === 'frog') app.frogRecord = own;
    return;
  }
  const record = await app.w.backend.frogger(Number(sat)).catch(() => null);
  if (seq !== viewSeq || app.view !== 'frog' || Number(app.frogSat) !== Number(sat)) return;
  app.frogRecord = record;
  render();
}

async function ensureViewData(view) {
  if (!app.w) return;
  const seq = ++viewSeq;
  try {
    if (view === 'frog') {
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
  if (view === 'frog' && arg) {
    const sat = Number(arg);
    if (Number.isSafeInteger(sat)) {
      if (app.frogSat !== sat) app.frogRecord = null;
      app.frogSat = sat;
      app.view = 'frog';
    } else {
      app.view = 'wallet';
    }
  } else if (['wallet', 'pond', 'road', 'mint', 'leaders', 'history', 'settings', 'rules'].includes(view)) {
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
  parseHash();
  if (app.view === 'frog') app.frogRecord = app.w.frogBySat(app.frogSat) || null;
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
  document.getElementById('drawer')?.classList.add('open');
  document.getElementById('drawer-backdrop')?.classList.add('open');
}
function closeDrawer() {
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

const handlers = {
  nav(el) { navigate(el.dataset.view); },
  drawer() { openDrawer(); },
  'drawer-close'() { closeDrawer(); },
  back() {
    // A direct link has no HOPPER history to go back to; stay in the app.
    if (history.state && history.state.hopper) history.back();
    else navigate('pond');
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
    app.w = null;
    app.view = 'wallet';
    app.frogSat = null;
    app.frogRecord = null;
    app.leaders = [];
    app.road = [];
    app.screen = 'onboard';
    app.ob = { step: 'welcome', mode: 'create', mnemonic: '', password: '', confirm: '', network: 'regtest', remember: false };
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
        app.w = null;
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
        app.w = null;
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
      app.w = null;
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
      app.w = null;
      app.view = 'wallet';
      app.frogSat = null;
      app.frogRecord = null;
      app.leaders = [];
      app.road = [];
      app.screen = 'onboard';
      app.ob = { step: 'welcome', mode: 'create', mnemonic: '', password: '', confirm: '', network: 'regtest', remember: false };
      app.settings = loadSettings();
      history.replaceState(null, '', location.pathname);
      // Reload closes the IndexedDB connection so the delete can finish.
      setTimeout(() => location.reload(), 60);
    });
  },
  'reveal-words'() {
    openOverlay(screens.wordsModal(app));
  },
  'sheet-receive'() { openOverlay(screens.receiveSheet(app)); },
  'sheet-send'() { openOverlay(screens.sendSheet(app)); },
  'sheet-transfer'(el) {
    const f = app.w.frogBySat(el.dataset.sat);
    if (f) openOverlay(screens.transferSheet(app, f));
  },
  'sheet-cross'(el) {
    const f = app.w.frogBySat(el.dataset.sat);
    if (f) openOverlay(screens.crossSheet(app, f));
  },
  'close-overlay'() { closeOverlay(); },
  copy(el) { copyText(el.dataset.text || ''); },

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
  mint() {
    run('inscribing the frog (commit + reveal)', async () => {
      const seed = app.mintSeed >>> 0;
      const name = app.mintName.slice(0, 38);
      let rotated = false;
      const rotateDraft = () => {
        if (rotated) return;
        rotated = true;
        resetMintDraft();
        updateMintPreview();
      };
      // The wallet calls this as soon as the reveal transaction is broadcast,
      // before its post-broadcast refresh. The fallback covers an alternate
      // wallet path that returns without invoking the hook.
      const built = await app.w.mint({ seed, name, onBroadcast: rotateDraft });
      rotateDraft();
      sound.sfx('mint');
      toast(`Minted ${name || 'frog'} on sat ${sats(built.sat)}`, 'ok');
      navigate('pond');
    });
  },
  prepare(el) {
    const f = app.w.frogBySat(el.dataset.sat);
    if (!f) return;
    run('preparing custody', async () => {
      await app.w.prepare(f);
      toast('Frog is in custody (25,000-sat card)', 'ok');
      openFrog(f.sat);
    });
  },
  'do-cross'(el) {
    const f = app.w.frogBySat(el.dataset.sat);
    if (!f) return;
    const ownerAddr = (document.querySelector('[data-input=cross-owner]')?.value || '').trim();
    const fee = Number(document.querySelector('[data-input=cross-fee]')?.value || app.settings.feeRate);
    run('crossing the road', async () => {
      let newOwnerXonly = null;
      if (ownerAddr) {
        const d = decodeAddress(ownerAddr, app.w.network);
        if (d.type !== 'p2tr') throw new Error('Custody owner must be a P2TR address');
        newOwnerXonly = d.program;
      }
      const built = await app.w.cross(f, { feeRate: fee, newOwnerXonly });
      closeOverlay();
      sound.sfx('cross');
      toast(`Crossing confirmed at H ${sats(app.w.tipHeight)} — settles in 6 blocks`, 'ok');
      navigate('road');
    });
  },
  burn(el) {
    const f = app.w.frogBySat(el.dataset.sat);
    if (!f) return;
    if (!confirm(`Burn ${f.name || 'this frog'}? The state output becomes a fee and the sat is gone forever. This cannot be undone.`)) return;
    run('burning the frog', async () => {
      const built = await app.w.burn(f);
      sound.sfx('error');
      toast(`Burned ${f.name || 'frog'} in ${shortHash(built.txid, 6)}`, 'ok');
      navigate('pond');
    });
  },
  'do-transfer'(el) {
    const f = app.w.frogBySat(el.dataset.sat);
    if (!f) return;
    const addr = (document.querySelector('[data-input=transfer-to]')?.value || '').trim();
    run('transferring the frog', async () => {
      const built = await app.w.transfer(f, addr);
      closeOverlay();
      toast(`Transferred to ${shortHash(addr, 6)}`, 'ok');
      navigate('pond');
    });
  },
  'do-send'() {
    const to = (document.querySelector('[data-input=send-to]')?.value || '').trim();
    const amount = Number(document.querySelector('[data-input=send-amount]')?.value || 0);
    run('sending sats', async () => {
      const built = await app.w.send(to, amount);
      closeOverlay();
      toast(`Sent ${sats(amount)} sats in ${shortHash(built.txid, 6)}`, 'ok');
    });
  },
  'apply-backend'() {
    run('connecting', async () => {
      const q = (k) => document.querySelector(`[data-input=${k}]`)?.value;
      const previous = { ...app.w.settings };
      const next = {
        ...previous,
        mode: q('mode') || 'demo',
        esploraUrl: q('esploraUrl') || '',
        indexerUrl: q('indexerUrl') || '',
        electrumUrl: q('electrumUrl') || '',
      };
      try {
        app.w.settings = next;
        app.settings = next;
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
      toast(`Chain answered: height ${sats(h)}`, 'ok');
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
  'rule-next'() { app.rulePage = Math.min(screens.RULES.length - 1, (app.rulePage || 0) + 1); render(); },
  'rule-prev'() { app.rulePage = Math.max(0, (app.rulePage || 0) - 1); render(); },
};

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

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
  } else if (key === 'volume' && app.w) {
    // Update the live gain while dragging; persist once on `change` so a
    // range drag does not synchronously rewrite localStorage sixty times.
    const volume = Math.max(0, Math.min(1, Number(value)));
    if (!Number.isFinite(volume)) return;
    app.w.settings.volume = volume;
    app.settings.volume = volume;
    sound.setVolume(volume);
  }
});

document.addEventListener('change', (ev) => {
  const key = ev.target.dataset?.input;
  if (!key || !app.w) return;
  const value = ev.target.value;
  if (key === 'fee-rate' || key === 'feeRate') {
    const raw = Number(value);
    if (!Number.isFinite(raw)) { ev.target.value = app.w.settings.feeRate; return; }
    app.w.settings.feeRate = Math.max(1, Math.min(1000, raw));
    app.settings.feeRate = app.w.settings.feeRate;
    ev.target.value = app.w.settings.feeRate;
    saveSettings(app.w.settings);
  } else if (key === 'gap') {
    const raw = Number(value);
    if (!Number.isFinite(raw)) { ev.target.value = app.w.settings.gap; return; }
    app.w.settings.gap = Math.max(5, Math.min(50, Math.trunc(raw)));
    ev.target.value = app.w.settings.gap;
    saveSettings(app.w.settings);
  } else if (key === 'deepScan') {
    app.w.settings.deepScan = value === '1';
    saveSettings(app.w.settings);
  } else if (key === 'mute') {
    app.w.settings.mute = value === '1';
    app.settings.mute = app.w.settings.mute;
    sound.setMute(app.w.settings.mute);
    saveSettings(app.w.settings);
    render();
  } else if (key === 'volume') {
    const volume = Math.max(0, Math.min(1, Number(value)));
    if (!Number.isFinite(volume)) return;
    app.w.settings.volume = volume;
    app.settings.volume = volume;
    sound.setVolume(volume);
    saveSettings(app.w.settings);
    render();
  } else if (['esploraUrl', 'indexerUrl', 'electrumUrl', 'mode'].includes(key)) {
    // Applied explicitly by APPLY so a half-typed URL never disconnects.
  } else if (key === 'mint-name') {
    app.mintName = value;
    updateMintPreview();
  }
});

document.getElementById('overlay')?.addEventListener('click', (ev) => {
  if (ev.target.id === 'overlay' && ev.target.dataset.dismissable !== '0') closeOverlay();
  if (ev.target.closest('[data-action=close-overlay]')) closeOverlay();
});
document.getElementById('drawer-backdrop')?.addEventListener('click', closeDrawer);

// The shell is static; a service worker makes the demo (and the UI over a
// flaky link) work offline. Live chain calls are always network-only.
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('service worker', e.message));
  });
}
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { closeOverlay(); closeDrawer(); }
  if (ev.key === 'Enter' && app.screen === 'lock') {
    const el = document.querySelector('[data-action=unlock]');
    if (el) el.click();
  }
});

window.addEventListener('hopper:refresh', () => {
  if (!app.w || app.busy) return;
  if (!['wallet', 'pond', 'road', 'history', 'frog'].includes(app.view)) return;
  render();
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

boot().catch((e) => {
  console.error(e);
  app.screen = 'onboard';
  render();
  toast(e.message || String(e), 'err');
});
