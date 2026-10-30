#!/usr/bin/env node
// Headless end-to-end smoke: onboarding → wallet → mint → prepare → cross.
// Requires Chromium with --remote-debugging-port=9222 and a static server.
//
//   python3 -m http.server 8130 &
//   chromium --headless=new --no-sandbox --remote-debugging-port=9222 ...
//   node tests/e2e.mjs http://127.0.0.1:8130

const base = process.argv[2] || 'http://127.0.0.1:8130';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
const errors = [];
const logs = [];

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push(`${msg.params.type}: ${text}`);
    if (msg.params.type === 'error') errors.push(text);
  }
};

await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const res = await call('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result.value;
}

async function waitFor(expr, timeout = 12000, what = expr) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(`Boolean(${expr})`)) return;
    await sleep(120);
  }
  const body = await evaluate('document.body.innerText.slice(0,1200)');
  throw new Error(`timeout waiting for ${what}\n--- page ---\n${body}`);
}

const click = (action) => evaluate(`document.querySelector('[data-action="${action}"]').click()`);

// A real touch swipe over the rules card, through Chromium's input pipe.
async function swipeRules(dx, dy = 0) {
  const point = await evaluate(`(() => {
    const r = document.querySelector('.rules-card').getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: Math.max(20, Math.min(innerHeight - 20, r.top + r.height / 2)),
    };
  })()`);
  const start = { ...point, id: 1, radiusX: 1, radiusY: 1, force: 1 };
  const mid = { ...start, x: point.x + dx * 0.55, y: point.y + dy * 0.55 };
  const end = { ...start, x: point.x + dx, y: point.y + dy };
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
  await sleep(40);
  await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [mid] });
  await sleep(40);
  await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [end] });
  await sleep(40);
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(220);
}

// The ported FROGGER GUI opens with the boot splash and (on a first visit)
// the eight-page rules walkthrough. Programmatic taps still reach the page
// behind the splash, but the shell is not in the DOM during the rules, so
// both are dismissed before any screen assertions run.
async function skipTour() {
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const intro = await evaluate('document.querySelector("#intro") && !document.querySelector("#intro").hidden');
    if (intro) {
      await evaluate('document.querySelector("#intro").click()');
      await sleep(250);
    }
    if (await evaluate('!!document.querySelector(".rules-screen")')) {
      await evaluate('document.querySelector("[data-action=rule-skip]").click()');
      await sleep(250);
    }
    if (await evaluate('!!document.querySelector(".topbar")')) return;
    await sleep(150);
  }
  throw new Error('tour did not finish');
}
const fill = (input, value) => evaluate(`(() => {
  const el = document.querySelector('[data-input="${input}"]');
  el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

await call('Runtime.enable');
await call('Log.enable');
await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', {
  width: 360, height: 780, deviceScaleFactor: 2, mobile: true,
});
await call('Page.navigate', { url: base });
await waitFor('document.querySelector("[data-action=ob-create]")', 15000, 'onboarding');

const title = await evaluate('document.title');
console.log('title:', title);

// The app starts on the public mainnet defaults. The demo flow below is a
// deliberate test override so this run never touches Bitcoin.
const defaults = await evaluate(`import('./js/wallet/wallet.js').then((m) => ({
  mode: m.DEFAULT_SETTINGS.mode,
  esplora: m.DEFAULT_SETTINGS.esploraUrl,
  indexer: m.DEFAULT_SETTINGS.indexerUrl,
  ord: m.DEFAULT_SETTINGS.ordUrl,
}))`);
console.log('app defaults:', defaults);
if (defaults.mode !== 'live') errors.push(`default mode is not live: ${JSON.stringify(defaults)}`);
if (defaults.esplora !== '' || defaults.indexer !== '' || defaults.ord !== '') {
  errors.push(`default backends should be empty fields: ${JSON.stringify(defaults)}`);
}
await evaluate(`localStorage.setItem('hopper.settings.v1', JSON.stringify({ mode: 'demo' })); true`);
await call('Page.reload', { ignoreCache: true });
await waitFor('document.querySelector("[data-action=ob-create]")', 15000, 'onboarding after demo override');

// 1. Create wallet.
await click('ob-create');
await waitFor('document.querySelector(".words")');
const words = await evaluate('[...document.querySelectorAll(".words span")].map(x=>x.textContent.replace(/^\\d+/,"")).join(" ")');
if (words.trim().split(/\s+/).length !== 12) throw new Error('no 12-word mnemonic');
console.log('mnemonic:', words);
await click('ob-words-done');
await waitFor('document.querySelector("[data-input=ob-password]")');
await fill('ob-password', 'hopper-demo-1');
await fill('ob-confirm', 'hopper-demo-1');
const defaultNetwork = await evaluate(`document.querySelector('[data-input=ob-network]')?.value`);
console.log('default onboarding network:', defaultNetwork);
if (defaultNetwork !== 'mainnet') errors.push(`onboarding did not default to mainnet: ${defaultNetwork}`);
await evaluate(`(() => { const s=document.querySelector('[data-input=ob-network]'); s.value='regtest'; s.dispatchEvent(new Event('input',{bubbles:true})); s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
await click('ob-finish');
await waitFor('document.querySelector(".topbar") || document.querySelector(".rules-screen")', 30000, 'wallet shell');
await skipTour();
await waitFor('document.querySelector(".balance") || document.querySelector("[data-action=sheet-send]")', 30000, 'wallet rendered');
await sleep(600);
const balance = await evaluate('document.querySelector(".balance")?.innerText');
console.log('wallet:', balance?.replace(/\n/g, ' | '));

// 1a. RECEIVE is the egui window: BITCOIN | HOPPERS tabs, a warning band,
// and a scannable QR with real ink (not a placeholder).
let autoReceive = '';
await click('sheet-receive');
await waitFor('document.querySelector(".receive-tabs")', 5000, 'receive window');
{
  const first = await evaluate(`(() => {
    const c = document.querySelector('canvas[data-qr]');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 60 && d[i + 1] < 60) dark++;
    return {
      warning: document.querySelector('.receive-warning')?.textContent.trim(),
      tabs: [...document.querySelectorAll('.receive-tab')].map((b) => b.textContent.trim()),
      address: document.querySelector('.receive-address')?.textContent.trim(),
      dark,
      sheet: (() => { const r = document.querySelector('.overlay .sheet').getBoundingClientRect(); return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) }; })(),
    };
  })()`);
  console.log('receive:', first);
  if (!first.warning.includes("DON'T SEND HOPPERS")) errors.push('receive: missing the bitcoin warning');
  if (first.tabs.join(',') !== 'BITCOIN,HOPPERS') errors.push(`receive: tabs ${JSON.stringify(first.tabs)}`);
  if (first.dark < 1000) errors.push(`receive: QR has no ink (${first.dark})`);
  await evaluate(`document.querySelector('[data-action=receive-tab][data-tab=ord]').click()`);
  await sleep(250);
  const ord = await evaluate(`({
    warning: document.querySelector('.receive-warning')?.textContent.trim(),
    address: document.querySelector('.receive-address')?.textContent.trim(),
    hasNew: Boolean(document.querySelector('[data-action=new-receive]')),
    sheet: (() => { const r = document.querySelector('.overlay .sheet').getBoundingClientRect(); return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) }; })(),
  })`);
  if (first.sheet.h !== ord.sheet.h || first.sheet.y !== ord.sheet.y) {
    errors.push(`receive: the window resized on tab switch ${JSON.stringify({ btc: first.sheet, ord: ord.sheet })}`);
  }
  if (!ord.warning.includes('ONLY SEND HOPPERS')) errors.push('receive: missing the hoppers warning');
  if (ord.hasNew) errors.push('receive: the fixed hoppers tab must not offer NEW ADDRESS');
  if (ord.address === first.address) errors.push('receive: the two tabs show the same address');
  await evaluate(`document.querySelector('[data-action=receive-tab][data-tab=btc]').click()`);
  await sleep(200);
  const before = await evaluate(`document.querySelector('.receive-address').textContent.trim()`);

  // A payment to the open BITCOIN tab retires that address. The sheet must
  // repaint with the next one without a manual NEW ADDRESS tap. The faucet
  // lives in SETTINGS, but navigating leaves the sheet mounted; the refresh
  // that sees the coins is the same one the background scan performs.
  await evaluate(`document.querySelector('[data-action=nav][data-view=settings]').click()`);
  await sleep(250);
  await click('faucet');
  await waitFor(
    `document.querySelector('.overlay .receive-tabs') && document.querySelector('.overlay .receive-address')?.textContent.trim() !== ${JSON.stringify(before)}`,
    30000, 'receive sheet auto-rotation after payment',
  );
  const auto = await evaluate(`({
    address: document.querySelector('.overlay .receive-address')?.textContent.trim(),
    tab: document.querySelector('.overlay .receive-tab.on')?.textContent.trim(),
    note: document.querySelector('.overlay .receive-note')?.textContent.trim(),
  })`);
  console.log('receive auto-rotation:', { from: before.slice(0, 12), to: auto.address.slice(0, 12), tab: auto.tab });
  autoReceive = auto.address;
  if (!auto.address || auto.address === before) errors.push('receive: paid address did not auto-rotate');
  if (auto.tab !== 'BITCOIN' || !/rotates after it is paid/.test(auto.note)) {
    errors.push(`receive: auto-rotation lost the bitcoin tab ${JSON.stringify(auto)}`);
  }
  await click('close-overlay');
  await sleep(150);
  await evaluate(`document.querySelector('[data-action=nav][data-view=wallet]').click()`);
  await sleep(150);
  await click('sheet-receive');
  await waitFor('document.querySelector(".receive-tabs")', 5000, 'receive window after auto-rotation');

  const afterAuto = await evaluate(`document.querySelector('.receive-address').textContent.trim()`);
  await click('new-receive');
  await sleep(250);
  const after = await evaluate(`document.querySelector('.receive-address').textContent.trim()`);
  if (!after || after === afterAuto) errors.push('receive: NEW ADDRESS did not rotate');
  await click('close-overlay');
  await sleep(150);
}

// 1a-bis. A normal send is two steps: PREVIEW TRANSACTION, then approval.
// Cancel must leave no pending row; approve must broadcast exactly what the
// preview showed. The fee field is manually set so this test does not depend
// on mempool.space being reachable.
await sleep(150);
// Keep the fee test deterministic while still exercising the real fetch and
// DOM-refresh path. CORS on mempool.space is verified separately.
await evaluate(`(() => {
  const real = window.fetch.bind(window);
  window.fetch = async (url, opts) => String(url).includes('mempool.space/api/v1/fees/precise')
    ? new Response(JSON.stringify({ fastestFee: 3.2, halfHourFee: 2.1, economyFee: 0.4 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
    : real(url, opts);
  return true;
})()`);
await click('sheet-send');
await waitFor('document.querySelector("[data-input=send-fee]")', 5000, 'send fee field');
await waitFor('document.querySelectorAll(".fee-choice").length === 3', 10000, 'fee recommendations');
const feeButtons = await evaluate(`({
  labels: [...document.querySelectorAll('.fee-choice')].map((b) => b.innerText.replace(/\\n/g, ' ')),
  fastest: document.querySelector('.fee-choice[data-rate="3.2"] b')?.textContent,
  field: document.querySelector('[data-input=send-fee]')?.value,
})`);
console.log('fee choices:', feeButtons);
if (!feeButtons.labels.some((x) => /FAST/.test(x) && /3.2 sat\/vB/.test(x))
  || !feeButtons.labels.some((x) => /MEDIUM/.test(x) && /2.1 sat\/vB/.test(x))
  || !feeButtons.labels.some((x) => /SLOW/.test(x) && /0.4 sat\/vB/.test(x))) {
  errors.push(`fee choices missing recommendations: ${JSON.stringify(feeButtons)}`);
}
await evaluate(`document.querySelector('.fee-choice[data-rate="3.2"]').click()`);
const chosenFee = await evaluate(`document.querySelector('[data-input=send-fee]')?.value`);
if (chosenFee !== '3.2') errors.push(`Fast did not fill the fee field: ${JSON.stringify(chosenFee)}`);
const feeFit = await evaluate(`(() => {
  const sheet = document.querySelector('.overlay .sheet');
  const presets = document.querySelector('.fee-presets');
  return sheet && presets
    ? { sw: sheet.scrollWidth, cw: sheet.clientWidth, psw: presets.scrollWidth, pcw: presets.clientWidth }
    : null;
})()`);
if (!feeFit || feeFit.sw > feeFit.cw + 1 || feeFit.psw > feeFit.pcw + 1) {
  errors.push(`fee picker overflows: ${JSON.stringify(feeFit)}`);
}
await fill('send-to', autoReceive);
await fill('send-amount', '12345');
await fill('send-fee', '2');
await click('preview-send');
await waitFor(`document.querySelector('.overlay')?.innerText.includes('REVIEW TRANSACTION')`, 15000, 'send preview');
const sendPreview = await evaluate(`(() => {
  const t = document.querySelector('.overlay')?.innerText || '';
  return {
    text: t,
    hasCancel: Boolean(document.querySelector('.overlay [data-action=abort-preview]')),
    hasApprove: Boolean(document.querySelector('.overlay [data-action=do-approve-tx]')),
    direct: Boolean(document.querySelector('.overlay [data-action=do-send]')),
  };
})()`);
console.log('send preview:', sendPreview.text.replace(/\n/g, ' | ').slice(0, 340));
if (!sendPreview.text.includes('Destination address') || !sendPreview.text.includes('Destination amount')
  || !sendPreview.text.includes('Change address') || !sendPreview.text.includes('Change amount')
  || !sendPreview.text.includes('Fee rate') || !sendPreview.text.includes('Actual fee')
  || !sendPreview.text.includes('12,345 sats')) {
  errors.push(`send preview is incomplete: ${JSON.stringify(sendPreview.text.slice(0, 500))}`);
}
if (!sendPreview.hasCancel || !sendPreview.hasApprove || sendPreview.direct) {
  errors.push(`send preview actions: ${JSON.stringify(sendPreview)}`);
}
const sendPreviewFit = await evaluate(`(() => {
  const m = document.querySelector('.overlay .modal');
  return m ? { sw: m.scrollWidth, cw: m.clientWidth } : null;
})()`);
if (!sendPreviewFit || sendPreviewFit.sw > sendPreviewFit.cw + 1) {
  errors.push(`send preview overflows: ${JSON.stringify(sendPreviewFit)}`);
}
await click('abort-preview');
await waitFor('document.getElementById("overlay").hidden', 5000, 'cancelled preview closed');
const cancelled = await evaluate(`document.querySelector('#toasts')?.innerText || ''`);
if (!/transaction cancelled/i.test(cancelled)) errors.push(`cancel toast missing: ${JSON.stringify(cancelled)}`);

await click('sheet-send');
await waitFor('document.querySelector("[data-input=send-fee]")', 5000, 'send fee field after cancel');
await fill('send-to', autoReceive);
await fill('send-amount', '12345');
await fill('send-fee', '2');
await click('preview-send');
await waitFor(`document.querySelector('.overlay')?.innerText.includes('Actual fee')`, 15000, 'send preview again');
await waitFor('document.getElementById("busy")?.hidden !== false', 5000, 'send approval ready');
await click('do-approve-tx');
await waitFor(`document.querySelector('#toasts')?.innerText.includes('Sent 12,345 sats')`, 30000, 'sent toast');
console.log('send approval: broadcast');
await waitFor('document.getElementById("overlay").hidden', 10000, 'send overlay closed');

// 1b. Every screen must fit the phone width.
for (const v of ['wallet', 'pond', 'road', 'mint', 'leaders', 'history', 'settings']) {
  await evaluate(`document.querySelector('[data-action=nav][data-view=${v}]').click()`);
  await sleep(180);
  const m = await evaluate(`(() => {
    const iw = innerWidth;
    const bad = [...document.querySelectorAll('#app *')].filter((el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const cs = getComputedStyle(el);
      if (cs.overflowX === 'hidden' || cs.overflowX === 'auto' || cs.overflowX === 'scroll') return false;
      return r.right > iw + 1 || r.left < -1;
    }).slice(0, 4).map((el) => el.tagName + '.' + [...el.classList].join('.'));
    return { iw, sw: document.documentElement.scrollWidth, bad };
  })()`);
  if (m.sw > m.iw + 1 || m.bad.length) {
    const d = await evaluate(`(() => {
      const cw = document.documentElement.clientWidth;
      const rows = [...document.querySelectorAll('#app *')].map((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { t: el.tagName, c: String(el.className || '').slice(0, 40), right: Math.round(r.right),
          w: Math.round(r.width), sw: el.scrollWidth, cw: el.clientWidth, ov: cs.overflowX, pos: cs.position };
      });
      return {
        innerWidth, clientWidth: cw, body: document.body.scrollWidth,
        wide: rows.filter((x) => x.right > cw + 1).slice(0, 8),
        scroll: rows.filter((x) => x.sw > x.cw + 1 && x.ov === 'visible').slice(0, 8),
      };
    })()`);
    errors.push(`layout ${v}: width ${m.sw}/${m.iw} ${JSON.stringify(m.bad)} diag ${JSON.stringify(d)}`);
  }
  console.log('view', v, m.sw <= m.iw + 1 && !m.bad.length ? 'fits' : `OVERFLOW ${JSON.stringify(m)}`);
}

// 1c. PWA shell.
await sleep(1200);
const sw = await evaluate(`navigator.serviceWorker ? navigator.serviceWorker.getRegistration().then((r) => Boolean(r)) : false`);
const manifest = await evaluate(`fetch('manifest.webmanifest').then((r) => r.ok && r.json()).then((m) => m.short_name).catch(() => null)`);
const cache = await evaluate(`caches.keys().then(async (keys) => {
  let n = 0;
  for (const k of keys) n += (await (await caches.open(k)).keys()).length;
  return { keys, n };
})`);
console.log('pwa:', { serviceWorker: sw, manifest, cache });
if (!sw || manifest !== 'HOPPER' || !cache.n) errors.push(`pwa shell: ${JSON.stringify({ sw, manifest, cache })}`);

// The tab mark and the in-app brand mark are the same crisp pixel frog.
const mark = await evaluate(`Promise.all([
  fetch('icons/favicon.svg').then((r) => r.text()),
  Promise.resolve(document.querySelector('.brand .frog-mark')?.outerHTML || ''),
  Promise.resolve(document.querySelector('link[rel=icon][type="image/svg+xml"]')?.getAttribute('href') || ''),
])`);
const [faviconSvg, brandMark, faviconHref] = mark;
console.log('favicon:', { href: faviconHref, svg: faviconSvg.length, brand: brandMark.slice(0, 60) });
if (faviconHref !== 'icons/favicon.svg') errors.push(`favicon link: ${faviconHref}`);
if (!faviconSvg.includes('shape-rendering="crispEdges"') || !faviconSvg.includes('#f0c83c')) {
  errors.push('favicon.svg is not the pixel HOPPER mark');
}
if (!brandMark.includes('viewBox="0 0 16 16"') || !brandMark.includes('shape-rendering="crispEdges"')) {
  errors.push('topbar frog mark is not the pixel mark');
}

// The app typeface is Pixelify Sans everywhere, not just on the rules.
await evaluate('document.fonts.ready.then(() => true)');
const appFonts = await evaluate(`(() => {
  const family = (sel) => getComputedStyle(document.querySelector(sel)).fontFamily;
  return {
    body: family('body'),
    button: family('button'),
    select: family('select'),
    loaded: document.fonts.check('13px "Pixelify Sans"'),
  };
})()`);
console.log('app fonts:', appFonts);
if (!appFonts.loaded || Object.values(appFonts).some((v) => typeof v === 'string' && !/Pixelify Sans/.test(v))) {
  errors.push(`app fonts: ${JSON.stringify(appFonts)}`);
}

// Numerals use the Silkscreen digit face; letters must stay Pixelify.
await evaluate('document.fonts.ready.then(() => true)');
const digitFont = await evaluate(`(async () => {
  await document.fonts.load('13px "Hopper Digits"', '0123456789');
  await document.fonts.load('700 13px "Hopper Digits"', '0123456789');
  const ctx = document.createElement('canvas').getContext('2d');
  const width = (font, text) => { ctx.font = font; return ctx.measureText(text).width; };
  return {
    loaded: document.fonts.check('13px "Hopper Digits"', '0123456789'),
    digits: width('13px "Hopper Digits", "Pixelify Sans"', '52871'),
    pixelDigits: width('13px "Pixelify Sans"', '52871'),
    letters: width('13px "Hopper Digits", "Pixelify Sans"', 'HOPPER'),
    pixelLetters: width('13px "Pixelify Sans"', 'HOPPER'),
    family: getComputedStyle(document.body).fontFamily,
    variant: getComputedStyle(document.body).fontVariantNumeric,
  };
})()`);
console.log('digit font:', digitFont);
if (!digitFont.loaded || digitFont.digits === digitFont.pixelDigits) {
  errors.push(`digit font did not load: ${JSON.stringify(digitFont)}`);
}
if (digitFont.letters !== digitFont.pixelLetters) errors.push(`digit face changed letters: ${JSON.stringify(digitFont)}`);
if (!/Hopper Digits/.test(digitFont.family) || digitFont.variant !== 'tabular-nums') {
  errors.push(`digit font stack: ${JSON.stringify(digitFont)}`);
}

// READ THE RULES is a drawer entry above SETTINGS now; REPLAY THE INTRO
// stays in Settings.
await evaluate(`document.querySelector('[data-action=nav][data-view=settings]').click()`);
await sleep(250);
const settingsRules = await evaluate(`({
  read: Boolean(document.querySelector('#app [data-action=open-rules]')),
  replay: Boolean(document.querySelector('#app [data-action=replay-intro]')),
  ord: document.querySelector('#app [data-input=ordUrl]')?.getAttribute('placeholder') || '',
  esplora: document.querySelector('#app [data-input=esploraUrl]')?.getAttribute('placeholder') || '',
  esploraValue: document.querySelector('#app [data-input=esploraUrl]')?.value ?? null,
  indexerValue: document.querySelector('#app [data-input=indexerUrl]')?.value ?? null,
  mode: document.querySelector('#app [data-input=mode]')?.value ?? null,
  testSound: Boolean(document.querySelector('#app [data-action=test-sound]')),
  demoButtons: [...document.querySelectorAll('#app [data-action=faucet], #app [data-action=mine], #app [data-action=reset-demo]')]
    .map((b) => b.textContent.trim()),
})`);
if (settingsRules.read) errors.push('settings still has READ THE RULES');
if (!settingsRules.replay) errors.push('settings lost REPLAY THE INTRO');
if (!/ordinals\.com/.test(settingsRules.ord)) errors.push(`settings lost the ORD endpoint: ${JSON.stringify(settingsRules)}`);
if (!/blockstream\.info\/api/.test(settingsRules.esplora)) errors.push(`settings lost the Esplora default: ${JSON.stringify(settingsRules)}`);
if (settingsRules.esploraValue !== '') errors.push(`Esplora field is not empty by default: ${JSON.stringify(settingsRules)}`);
if (settingsRules.indexerValue !== '') errors.push(`Indexer field is not empty by default: ${JSON.stringify(settingsRules)}`);
if (settingsRules.mode !== 'demo') errors.push(`e2e demo override did not apply: ${JSON.stringify(settingsRules)}`);
if (settingsRules.testSound) errors.push('settings still has TEST SOUND');
if (!['FAUCET', 'MINE 1', 'MINE 6', 'RESET DEMO'].every((label) => settingsRules.demoButtons.includes(label))) {
  errors.push(`demo settings lost its chain controls: ${JSON.stringify(settingsRules.demoButtons)}`);
}
await evaluate(`document.querySelector('[data-action=drawer]').click()`);
await sleep(200);
const menu = await evaluate(`[...document.querySelectorAll('#drawer .nav button')].map((b) => b.textContent.trim())`);
console.log('drawer menu:', menu);
const drawerTestSound = await evaluate(`document.querySelectorAll('#drawer [data-action=test-sound]').length`);
if (drawerTestSound) errors.push(`drawer still has TEST SOUND: ${drawerTestSound}`);
if (menu.at(-1) !== '⚙ SETTINGS' || menu.at(-2) !== '📖 READ THE RULES') {
  errors.push(`drawer rules placement: ${JSON.stringify(menu)}`);
}
const pondIcon = await evaluate(`(() => {
  const b = document.querySelector('#drawer .nav button[data-view=pond]');
  const s = b?.querySelector('svg');
  return {
    cls: s?.getAttribute('class') || '',
    viewBox: s?.getAttribute('viewBox') || '',
    w: s?.getAttribute('width') || '',
    crisp: s?.getAttribute('shape-rendering') || '',
    html: s?.outerHTML || '',
    frog: Boolean(b?.querySelector('.frog-mark')),
  };
})()`);
console.log('pond icon:', { cls: pondIcon.cls, viewBox: pondIcon.viewBox, w: pondIcon.w, crisp: pondIcon.crisp, frog: pondIcon.frog });
if (pondIcon.cls !== 'pond-mark' || pondIcon.viewBox !== '0 0 14 14' || pondIcon.w !== '14' || pondIcon.crisp !== 'crispEdges') {
  errors.push(`pond icon: ${JSON.stringify(pondIcon)}`);
}
if (pondIcon.frog || !pondIcon.html.includes('#3a7d89') || !pondIcon.html.includes('#68b270')) {
  errors.push('pond icon: still the frog mark, or missing water/pad colours');
}
await evaluate(`document.querySelector('#drawer [data-action=open-rules]').click()`);
await waitFor('document.querySelector(".rules-screen")', 5000, 'rules walkthrough');
{
  await evaluate('document.fonts.ready.then(() => true)');
  const rf = await evaluate(`(() => {
    const card = document.querySelector('.rules-card');
    const cs = getComputedStyle(card);
    return {
      family: cs.fontFamily,
      size: parseFloat(cs.fontSize),
      loaded: document.fonts.check('17px "Pixelify Sans"'),
    };
  })()`);
  console.log('rules font:', rf);
  if (!rf.loaded || !/Pixelify Sans/.test(rf.family) || rf.size < 16) {
    errors.push(`rules font: ${JSON.stringify(rf)}`);
  }
  const m = await evaluate(`({ iw: innerWidth, sw: document.documentElement.scrollWidth })`);
  if (m.sw > m.iw + 1) errors.push(`layout rules: width ${m.sw}/${m.iw}`);
}
// The rules pages are a deck: swipe left for the next page, right for the
// previous one. A vertical swipe must stay a scroll, not turn the page.
await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
const rulePage = () => evaluate(`document.querySelector('.rules-page-kicker')?.textContent.trim() || ''`);
const rule0 = await rulePage();
await swipeRules(-90);
const rule1 = await rulePage();
await swipeRules(90);
const rule2 = await rulePage();
await swipeRules(0, 120);
const rule3 = await rulePage();
console.log('rules swipe:', { rule0, rule1, rule2, vertical: rule3 });
if (rule0 !== '1 / 8' || rule1 !== '2 / 8' || rule2 !== '1 / 8' || rule3 !== '1 / 8') {
  errors.push(`rules swipe: ${JSON.stringify({ rule0, rule1, rule2, rule3 })}`);
}
await call('Emulation.setTouchEmulationEnabled', { enabled: false });
await evaluate(`document.querySelector('[data-action=rule-skip]').click()`);
await sleep(200);

// The route change, not a data refresh, resets scroll. The WALLET page is
// deliberately a short centered block (FROGGER's balance hero), so the
// scrollable page for this test is SETTINGS.
await evaluate(`document.querySelector('[data-action=nav][data-view=settings]').click()`);
await sleep(300);
const scanPanel = await evaluate(`({
  text: document.querySelector('[data-scan-panel]')?.innerText || '',
  hasRescan: Boolean(document.querySelector('[data-action=rescan]')),
  hasExtend: Boolean(document.querySelector('[data-action=extend-gap]')),
})`);
console.log('scan policy:', scanPanel.text.replace(/\n/g, ' | '));
if (!scanPanel.hasRescan || !scanPanel.hasExtend || !/SCAN|Scan window/i.test(scanPanel.text)) {
  errors.push(`settings: scan policy is incomplete ${JSON.stringify(scanPanel)}`);
}
// The seed is behind a warning gate. It must not be in the DOM until the
// explicit approval button is pressed.
await evaluate(`document.querySelector('[data-action=reveal-words]').click()`);
await sleep(150);
const seedGate = await evaluate(`({
  words: document.querySelectorAll('.overlay .words span').length,
  approve: Boolean(document.querySelector('.overlay [data-action=reveal-words-approved]')),
  text: document.querySelector('.overlay')?.innerText || '',
})`);
console.log('seed warning:', { words: seedGate.words, approve: seedGate.approve });
if (seedGate.words !== 0 || !seedGate.approve || !/ANYONE WHO SEES/i.test(seedGate.text)) {
  errors.push(`settings: seed warning gate is incomplete ${JSON.stringify({ words: seedGate.words, approve: seedGate.approve })}`);
}
const seedFit = await evaluate(`(() => {
  const m = document.querySelector('.overlay .modal');
  return m ? { sw: m.scrollWidth, cw: m.clientWidth } : null;
})()`);
if (!seedFit || seedFit.sw > seedFit.cw + 1) errors.push(`seed warning overflows horizontally: ${JSON.stringify(seedFit)}`);
await evaluate(`document.querySelector('.overlay [data-action=reveal-words-approved]').click()`);
await sleep(150);
const revealedWords = await evaluate(`document.querySelectorAll('.overlay .words span').length`);
if (revealedWords !== 12) errors.push(`settings: approval did not reveal 12 words (${revealedWords})`);
await click('close-overlay');
await sleep(100);

await click('rescan');
await sleep(150);
await click('rescan');
await sleep(900);
const rescanned = await evaluate(`document.querySelector('[data-scan-line]')?.textContent || ''`);
console.log('rescan:', rescanned.trim().replace(/\s+/g, ' '));
if (!/rescan (complete|stopped|failed)|synced at/i.test(rescanned)) {
  errors.push(`settings: RESCAN produced no result line (${JSON.stringify(rescanned)})`);
}
await evaluate('window.scrollTo(0, document.body.scrollHeight)');
await sleep(120);
const scrolled = await evaluate('window.scrollY');
await evaluate(`document.querySelector('[data-action=nav][data-view=pond]').click()`);
await sleep(250);
const top = await evaluate('window.scrollY');
if (scrolled < 100) errors.push(`scroll test did not scroll (${scrolled})`);
if (top > 1) errors.push(`route did not reset scroll (${top})`);
console.log('scroll: route starts at top');

// 2. Mint view: the seed is wallet-assigned, dice-rerollable, never typed;
// the name starts blank.
await evaluate(`document.querySelector('[data-action=nav][data-view=mint]').click()`);
await waitFor('document.querySelector("[data-action=preview-mint]")');
const mintButtonLabel = await evaluate(`document.querySelector('[data-action=preview-mint]')?.textContent.trim()`);
console.log('mint button:', mintButtonLabel);
if (mintButtonLabel !== 'MINT!') errors.push(`mint button label changed: ${JSON.stringify(mintButtonLabel)}`);
const draft = await evaluate(`({
  seed: document.querySelector('[data-seed-label]')?.textContent || '',
  name: document.querySelector('[data-input=mint-name]')?.value,
  hasDice: Boolean(document.querySelector('[data-action=random-seed]')),
})`);
console.log('mint draft:', draft);
if (!draft.seed) errors.push('mint: seed label is missing');
if (!draft.hasDice) errors.push('mint: dice button is missing');
if (draft.name !== '') errors.push(`mint: default name is not blank (${JSON.stringify(draft.name)})`);
await click('random-seed');
await sleep(100);
const rolled = await evaluate(`({
  seed: document.querySelector('[data-seed-label]')?.textContent || '',
  name: document.querySelector('[data-input=mint-name]')?.value,
})`);
console.log('diced mint draft:', rolled);
if (rolled.seed === draft.seed) errors.push('mint: dice did not change the seed');
if (rolled.name !== '') errors.push('mint: dice changed the name');
await fill('mint-name', 'Test Hopper');
await sleep(300);

// MINT! is still the button, but it now opens the same review boundary as a
// send. Build the commit/reveal pair, show both transactions, and do not
// broadcast until approval.
await click('preview-mint');
await waitFor(`document.querySelector('.overlay')?.innerText.includes('REVIEW MINT')`, 40000, 'mint preview');
await waitFor('document.getElementById("busy")?.hidden !== false', 5000, 'mint preview build finished');
const mintPreview = await evaluate(`(() => {
  const overlay = document.querySelector('.overlay');
  const text = overlay?.innerText || '';
  const modal = overlay?.querySelector('.modal, .sheet');
  return {
    text,
    cancel: Boolean(overlay?.querySelector('[data-action=abort-preview]')),
    approve: Boolean(overlay?.querySelector('[data-action=do-approve-tx]')),
    sw: modal?.scrollWidth || 0,
    cw: modal?.clientWidth || 0,
  };
})()`);
console.log('mint preview:', mintPreview.text.replace(/\n/g, ' | ').slice(0, 420));
if (!mintPreview.text.includes('Commit txid')
  || !mintPreview.text.includes('Reveal txid')
  || !mintPreview.text.includes('Commit fee')
  || !mintPreview.text.includes('Reveal fee')
  || !mintPreview.text.includes('Total actual fee')
  || !mintPreview.text.includes('2 transactions')
  || !mintPreview.text.includes('APPROVING BROADCASTS BOTH TRANSACTIONS')
  || !mintPreview.cancel || !mintPreview.approve) {
  errors.push(`mint preview is incomplete: ${JSON.stringify(mintPreview.text.slice(0, 700))}`);
}
if (mintPreview.sw > mintPreview.cw + 1) {
  errors.push(`mint preview overflows: ${JSON.stringify({ sw: mintPreview.sw, cw: mintPreview.cw })}`);
}
await click('abort-preview');
await waitFor('document.getElementById("overlay").hidden', 5000, 'mint preview cancelled');
const preservedDraft = await evaluate(`({
  seed: document.querySelector('[data-seed-label]')?.textContent || '',
  name: document.querySelector('[data-input=mint-name]')?.value,
})`);
if (preservedDraft.seed !== rolled.seed || preservedDraft.name !== 'Test Hopper') {
  errors.push(`mint cancel changed the draft: ${JSON.stringify({ rolled, preservedDraft })}`);
}
console.log('mint cancel: draft preserved');

await click('preview-mint');
await waitFor(`document.querySelector('.overlay')?.innerText.includes('REVIEW MINT')`, 40000, 'mint preview again');
await waitFor('document.getElementById("busy")?.hidden !== false', 5000, 'mint approval ready');
await click('do-approve-tx');
await waitFor('location.hash === "#/pond"', 40000, 'approved mint to navigate to pond');
await waitFor('document.querySelectorAll(".pond-item").length > 0', 20000, 'minted frog card');
const pond = await evaluate('document.querySelector("#app")?.innerText');
console.log('pond:', pond?.replace(/\n/g, ' | '));
if (logs.some((l) => /mint worker unavailable/i.test(l))) errors.push('mint worker fell back to the main thread');

// History is a wallet ledger, not a chain-wide event dump: the initial
// faucet deposit and the Hopper output must be visible beside the MINT row.
await evaluate(`document.querySelector('[data-action=nav][data-view=history]').click()`);
await sleep(250);
const historyText = await evaluate('document.querySelector("#app")?.innerText || ""');
console.log('history:', historyText.replace(/\n/g, ' | ').slice(0, 500));
if (!/HOPPER ARRIVED/.test(historyText)) errors.push('history: missing the Hopper arrival');
if (!/\+200,000 sats/.test(historyText)) errors.push('history: missing the initial wallet deposit');
if (!/MINT/.test(historyText)) errors.push('history: missing the mint action');
if (!/CHANGE/.test(historyText)) errors.push('history: missing the internal change row');
if (historyText.indexOf('MINT') < historyText.indexOf('HOPPER ARRIVED')) {
  errors.push('history: the mint is shown above its arrival in a newest-first feed');
}
if (/\bPip\b|\bBogart\b/.test(historyText)) errors.push('history: global NPC mints are still visible');
const historyKinds = await evaluate(`[...document.querySelectorAll('#app .card-row .kind')]
  .map((el) => el.textContent.trim())`);
console.log('history order:', historyKinds.slice(0, 6).join(' > '));
if (historyKinds[0] !== 'HOPPER ARRIVED'
  || historyKinds[1] !== 'CHANGE'
  || historyKinds[2] !== 'MINT') {
  errors.push(`history order: ${historyKinds.slice(0, 4).join(' > ')}`);
}

// Shortened identifiers copy their full values. The clipboard permission is
// granted to the local test origin so the assertion reads what the wallet
// actually wrote, not a mocked return value.
await call('Browser.grantPermissions', {
  permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  origin: new URL(base).origin,
});
const copyTargets = await evaluate(`(() => {
  const tx = document.querySelector('.tx-top [data-action="copy"]');
  const address = [...document.querySelectorAll('.tx-detail [data-action="copy"]')]
    .find((b) => /^bcrt1/.test(b.dataset.text || ''));
  return {
    txid: tx?.dataset.text || '',
    txidShown: tx?.textContent || '',
    txidLabel: tx?.dataset.copyLabel || '',
    txidTag: tx?.tagName || '',
    txidType: tx?.getAttribute('type') || '',
    address: address?.dataset.text || '',
    addressShown: address?.textContent || '',
    addressLabel: address?.dataset.copyLabel || '',
    addressTag: address?.tagName || '',
    overflow: [...document.querySelectorAll('.card-row')].some((card) => {
      const edge = card.getBoundingClientRect().right + 3;
      return [...card.querySelectorAll('.tx-copy')]
        .some((b) => b.getBoundingClientRect().right > edge);
    }),
  };
})()`);
if (!/^[0-9a-f]{64}$/.test(copyTargets.txid)) errors.push('history copy: missing full txid');
if (!/^bcrt1/.test(copyTargets.address)) errors.push('history copy: missing full address');
if (!/^[0-9a-f]{10}…[0-9a-f]{6}$/.test(copyTargets.txidShown)) errors.push('history copy: txid is not shortened');
if (!/^bcrt1.+…$/.test(copyTargets.addressShown)) errors.push('history copy: address is not shortened');
if (copyTargets.txidLabel !== 'txid copied') errors.push('history copy: wrong txid toast label');
if (copyTargets.addressLabel !== 'address copied') errors.push('history copy: wrong address toast label');
if (copyTargets.txidTag !== 'BUTTON' || copyTargets.addressTag !== 'BUTTON') {
  errors.push('history copy: copy controls are not keyboard buttons');
}
if (copyTargets.txidType !== 'button') errors.push('history copy: txid button has no type=button');
if (copyTargets.overflow) errors.push('history copy: a copy control overflows its card');
await evaluate(`document.querySelector('.tx-top [data-action="copy"]').click()`);
await sleep(220);
const txClip = await evaluate('navigator.clipboard.readText()');
if (txClip !== copyTargets.txid) errors.push(`history copy: txid clipboard ${JSON.stringify(txClip)}`);
const txToast = await evaluate('document.querySelector("#toasts")?.innerText || ""');
if (!/txid copied/.test(txToast)) errors.push('history copy: no txid confirmation');
await evaluate(`[...document.querySelectorAll('.tx-detail [data-action="copy"]')]
  .find((b) => /^bcrt1/.test(b.dataset.text || '')).click()`);
await sleep(220);
const addressClip = await evaluate('navigator.clipboard.readText()');
if (addressClip !== copyTargets.address) errors.push(`history copy: address clipboard ${JSON.stringify(addressClip)}`);
const addressToast = await evaluate('document.querySelector("#toasts")?.innerText || ""');
if (!/address copied/.test(addressToast)) errors.push('history copy: no address confirmation');
console.log('history copy:', JSON.stringify({ txid: copyTargets.txidShown, address: copyTargets.addressShown }));

// The diagnostic copies the public grouping inputs, never the seed. It is
// the evidence needed when a mint still refuses to keep its three rows
// together on a device we cannot inspect directly.
const hasDebug = await evaluate(`!!document.querySelector('[data-action=copy-history-debug]')`);
if (!hasDebug) errors.push('history debug: button missing');
await evaluate(`document.querySelector('[data-action=copy-history-debug]').click()`);
await sleep(260);
const debugText = await evaluate('navigator.clipboard.readText()');
let debugData = null;
try { debugData = JSON.parse(debugText); } catch (_) { /* reported below */ }
if (!debugData) errors.push('history debug: clipboard is not JSON');
else {
  if (!debugData.build) errors.push('history debug: no build');
  if (!Array.isArray(debugData.rows) || !debugData.rows.length) errors.push('history debug: no grouped rows');
  if (!debugData.rows?.every((r) => typeof r.mintKey === 'string')) errors.push('history debug: row without group key');
  if (/seed|mnemonic|private/i.test(debugText)) errors.push('history debug: contains private material');
  if (debugData.computed?.slice(0, 3).join('|') !== 'MINT|CHANGE|HOPPER ARRIVED') {
    errors.push(`history debug: computed ${debugData.computed?.slice(0, 3).join(' > ')}`);
  }
  if (debugData.dom?.slice(0, 3).join('|') !== 'MINT|CHANGE|HOPPER ARRIVED') {
    errors.push(`history debug: painted ${debugData.dom?.slice(0, 3).join(' > ')}`);
  }
  console.log('history debug:', JSON.stringify({
    build: debugData.build, rows: debugData.rows.length,
    painted: debugData.dom?.slice(0, 3),
  }));
}

await evaluate(`document.querySelector('[data-action=nav][data-view=pond]').click()`);
await waitFor('document.querySelectorAll(".pond-item").length > 0', 15000, 'pond after history check');

// The pond card offers SEND and TRAVEL TO ROAD side by side.
const pondActions = await evaluate(`(() => {
  const item = document.querySelector('.pond-item');
  const buttons = [...item.querySelectorAll('.pf-actions .btn')];
  const r = buttons.map((b) => b.getBoundingClientRect());
  return {
    labels: buttons.map((b) => b.textContent.trim()),
    sameRow: r.length === 2 && Math.abs(r[0].top - r[1].top) < 1,
    fits: r.length === 2 && r[1].right <= item.getBoundingClientRect().right + 1,
  };
})()`);
console.log('pond actions:', pondActions);
if (pondActions.labels.join('|') !== 'SEND|TRAVEL TO ROAD' || !pondActions.sameRow || !pondActions.fits) {
  errors.push(`pond travel button: ${JSON.stringify(pondActions)}`);
}

// Sending a Hopper has the same preview boundary. Cancel here so the game
// flow below still owns the frog.
await evaluate(`document.querySelector('.pond-item [data-action=sheet-transfer]').click()`);
await waitFor('document.querySelector("[data-input=transfer-fee]")', 5000, 'Hopper transfer sheet');
await fill('transfer-to', autoReceive);
await fill('transfer-fee', '2');
await click('preview-transfer');
await waitFor(`document.querySelector('.overlay')?.innerText.includes('SEND HOPPER')`, 15000, 'Hopper transfer preview');
await waitFor('document.getElementById("busy")?.hidden !== false', 5000, 'Hopper preview build finished');
const hopperPreviewUi = await evaluate(`(() => {
  const t = document.querySelector('.overlay')?.innerText || '';
  return {
    text: t,
    cancel: Boolean(document.querySelector('.overlay [data-action=abort-preview]')),
    approve: Boolean(document.querySelector('.overlay [data-action=do-approve-tx]')),
  };
})()`);
console.log('Hopper preview:', hopperPreviewUi.text.replace(/\n/g, ' | ').slice(0, 300));
if (!hopperPreviewUi.text.includes('Destination address')
  || !hopperPreviewUi.text.includes('Destination amount')
  || !hopperPreviewUi.text.includes('Change address')
  || !hopperPreviewUi.text.includes('Actual fee')
  || !hopperPreviewUi.text.includes('one output')
  || !hopperPreviewUi.cancel || !hopperPreviewUi.approve) {
  errors.push(`Hopper preview is incomplete: ${JSON.stringify(hopperPreviewUi.text.slice(0, 500))}`);
}
const hopperPreviewFit = await evaluate(`(() => {
  const m = document.querySelector('.overlay .modal');
  return m ? { sw: m.scrollWidth, cw: m.clientWidth } : null;
})()`);
if (!hopperPreviewFit || hopperPreviewFit.sw > hopperPreviewFit.cw + 1) {
  errors.push(`Hopper preview overflows: ${JSON.stringify(hopperPreviewFit)}`);
}
await click('abort-preview');
await waitFor('document.getElementById("overlay").hidden', 5000, 'Hopper preview cancelled');

// The wallet shrinks the pond to a small generic preview. It is one link,
// not the full grid, and it opens The Pond.
await evaluate(`document.querySelector('[data-action=nav][data-view=wallet]').click()`);
await waitFor('document.querySelector("[data-send-pond]")', 10000, 'wallet pond preview');
const sendPond = await evaluate(`(() => {
  const b = document.querySelector('[data-send-pond]');
  const cv = b?.querySelector('canvas');
  const r = cv?.getBoundingClientRect();
  return {
    text: (b?.innerText || '').trim(),
    w: r?.width || 0,
    h: r?.height || 0,
    items: document.querySelectorAll('#app .pond-item').length,
  };
})()`);
console.log('wallet pond:', sendPond);
if (sendPond.text !== 'SEND HOPPERS FROM THE POND') errors.push(`wallet pond label: ${JSON.stringify(sendPond.text)}`);
if (!(sendPond.w >= 140 && sendPond.w <= 220 && Math.abs(sendPond.w - sendPond.h) < 2)) {
  errors.push(`wallet pond size: ${JSON.stringify(sendPond)}`);
}
if (sendPond.items !== 0) errors.push(`wallet still shows the full pond grid (${sendPond.items} items)`);
await evaluate(`document.querySelector('[data-send-pond]').click()`);
await waitFor('location.hash === "#/pond"', 10000, 'wallet pond opens The Pond');

// A broadcast mint must replace the seed and clear the next draft.
await evaluate(`document.querySelector('[data-action=nav][data-view=mint]').click()`);
await waitFor('document.querySelector("[data-input=mint-name]")', 10000, 'mint draft after broadcast');
const nextDraft = await evaluate(`({
  seed: document.querySelector('[data-seed-label]')?.textContent || '',
  name: document.querySelector('[data-input=mint-name]')?.value,
})`);
console.log('next mint draft:', nextDraft);
if (nextDraft.seed === rolled.seed) errors.push('mint: seed was not rotated after broadcast');
if (nextDraft.name !== '') errors.push(`mint: name was not cleared after broadcast (${JSON.stringify(nextDraft.name)})`);
await evaluate(`document.querySelector('[data-action=nav][data-view=pond]').click()`);
await waitFor('document.querySelector(".pond-item")', 15000, 'pond after mint draft check');

// 3. Open the frog. Travel To Road must explain the staging transaction
// and wait for approval before anything is broadcast.
await evaluate(`document.querySelector('.pond-item [data-action=open-frog]').click()`);
await waitFor('document.querySelector("[data-action=travel-to-road]")', 15000, 'travel button');
const detailTravel = await evaluate(`document.querySelector('[data-action=travel-to-road]').textContent.trim()`);
if (detailTravel !== 'TRAVEL TO ROAD') errors.push(`detail travel label: ${JSON.stringify(detailTravel)}`);
const detailHistory = await evaluate(`document.querySelector('.detail-info [data-action=bio]')?.textContent.trim()`);
console.log('frog history label:', detailHistory);
if (detailHistory !== '📜 HISTORY') errors.push(`detail history label: ${JSON.stringify(detailHistory)}`);
console.log('frog detail:', (await evaluate('document.querySelector(".detail-head")?.innerText')).replace(/\n/g, ' | '));

// The pips are one dot per required hop, not a five-dot cap. A newly
// minted frog is 0 of the current target, and the row must fit.
const detailPips = await evaluate(`(() => {
  const p = document.querySelector('.detail-info .pips');
  const targetDt = [...document.querySelectorAll('.detail-info .stat-grid dt')]
    .find((dt) => dt.textContent.trim() === 'Next hop target');
  const target = targetDt?.nextElementSibling?.textContent || '';
  const dots = [...(p?.querySelectorAll('.pip-dots i') || [])];
  return {
    dots: dots.length,
    on: dots.filter((d) => d.classList.contains('on')).length,
    label: p?.querySelector('b')?.textContent.trim() || '',
    aria: p?.getAttribute('aria-label') || '',
    target,
    right: p ? Math.round(p.getBoundingClientRect().right) : 0,
    innerWidth: document.documentElement.clientWidth,
  };
})()`);
console.log('detail pips:', detailPips);
const pipTarget = Number.parseInt(detailPips.target, 10);
if (!pipTarget) errors.push(`pips: no target on the detail page (${JSON.stringify(detailPips)})`);
else {
  if (detailPips.dots !== pipTarget) errors.push(`pips: ${detailPips.dots} dots for target ${pipTarget}`);
  if (detailPips.on !== 0) errors.push(`pips: new frog starts with ${detailPips.on} filled`);
  if (detailPips.label !== `×0 / ${pipTarget}`) errors.push(`pips: label ${JSON.stringify(detailPips.label)}`);
  if (detailPips.aria !== `0 of ${pipTarget} crossings complete`) errors.push(`pips: aria ${JSON.stringify(detailPips.aria)}`);
  if (detailPips.right > detailPips.innerWidth + 1) errors.push(`pips: row overflows (${JSON.stringify(detailPips)})`);
}

// There must be no burn action anywhere in the app, no burn builder in the
// wallet module, and no BURN control on an owned Hopper's detail page.
const burnSurface = await evaluate(`(async () => {
  const actions = await import('./js/wallet/actions.js');
  return {
    builder: typeof actions.buildBurn,
    buttons: document.querySelectorAll('[data-action=burn]').length,
    detail: document.querySelector('.detail-info')?.innerText || '',
  };
})()`);
console.log('burn surface:', burnSurface);
if (burnSurface.builder !== 'undefined') errors.push('wallet still exports buildBurn');
if (burnSurface.buttons !== 0) errors.push(`burn controls in the app: ${burnSurface.buttons}`);
if (/\bBURN\b/.test(burnSurface.detail)) errors.push('frog detail still offers BURN');

// A high-target frog must still wrap inside a 320px pond column rather
// than shrinking beyond legibility or pushing the page sideways.
const bigPips = await evaluate(`(async () => {
  const { pips } = await import('./js/ui/dom.js');
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:136px';
  host.innerHTML = pips(55, 100);
  document.body.appendChild(host);
  const p = host.querySelector('.pips');
  const dots = [...p.querySelectorAll('.pip-dots i')];
  const out = {
    dots: dots.length,
    on: dots.filter((d) => d.classList.contains('on')).length,
    label: p.querySelector('b').textContent.trim(),
    w: Math.round(p.getBoundingClientRect().width),
    sw: p.scrollWidth,
    cw: p.clientWidth,
  };
  host.remove();
  return out;
})()`);
console.log('100-hop pips:', bigPips);
if (bigPips.dots !== 100 || bigPips.on !== 55 || bigPips.label !== '×55 / 100') {
  errors.push(`100-hop pips: ${JSON.stringify(bigPips)}`);
}
if (bigPips.sw > bigPips.cw + 1) errors.push(`100-hop pips overflow: ${JSON.stringify(bigPips)}`);
await click('travel-to-road');
await waitFor('document.querySelector(".overlay [data-action=travel-approved]")', 5000, 'travel warning');
const travelWarn = await evaluate(`document.querySelector('.overlay').innerText`);
if (!/tapscript/i.test(travelWarn) || !/normal spends/i.test(travelWarn) || !/not a crossing/i.test(travelWarn)) {
  errors.push(`travel warning copy: ${JSON.stringify(travelWarn.slice(0, 500))}`);
}
if (!/APPROVE/i.test(travelWarn)) errors.push('travel warning has no approval action');
const travelFit = await evaluate(`(() => {
  const m = document.querySelector('.overlay .modal');
  return m ? { sw: m.scrollWidth, cw: m.clientWidth } : null;
})()`);
if (!travelFit || travelFit.sw > travelFit.cw + 1) errors.push(`travel warning overflows horizontally: ${JSON.stringify(travelFit)}`);
await evaluate(`document.querySelector('.overlay [data-action=travel-approved]').click()`);
await waitFor('location.hash === "#/road"', 30000, 'road after travel approval');
await waitFor('document.querySelector("[data-action=sheet-cross]")', 30000, 'cross button after travel');

// 4. Cross.
await evaluate(`document.querySelector('[data-action=sheet-cross]').click()`);
await waitFor('document.querySelector("[data-action=do-cross]")');
const crossOwnerHint = await evaluate(`document.querySelector('[data-input=cross-owner]')?.placeholder || ''`);
console.log('cross owner hint:', crossOwnerHint);
if (crossOwnerHint !== 'leave empty to keep in this wallet') {
  errors.push(`cross owner placeholder: ${JSON.stringify(crossOwnerHint)}`);
}
await evaluate(`document.querySelector('[data-action=do-cross]').click()`);
await waitFor('location.hash === "#/road"', 30000, 'road after cross');
await sleep(500);
const road = await evaluate('document.body.innerText');
console.log('road:', road.split('\n').filter(Boolean).slice(0, 12).join(' | '));

// 5. Mine 6 and settle.
await evaluate(`document.querySelector('[data-action=mine][data-n="6"]').click()`);
await sleep(2500);
const after = await evaluate('document.body.innerText');
console.log('after settle:', after.split('\n').filter(Boolean).slice(0, 10).join(' | '));

// 5b. Route changes and history must not show a previous frog's record.
// A crossing can kill (25% at the genesis target): the living pond then
// shows nothing and the frog lives on the graveyard's road.
await evaluate(`document.querySelector('[data-action=nav][data-view=pond]').click()`);
await sleep(400);
const alive = await evaluate('!!document.querySelector(".pond-item")');
if (alive) {
  await waitFor('document.querySelector(".pond-item")', 15000, 'pond after settle');
  await evaluate(`document.querySelector('.pond-item [data-action=open-frog]').click()`);
  await waitFor('location.hash.startsWith("#/frog/")', 15000, 'frog route');
} else {
  await waitFor('document.querySelector(".pond-road")', 15000, 'graveyard road');
  await evaluate(`document.querySelector('.pond-road').click()`);
  await waitFor('document.querySelector(".overlay [data-action=bio]")', 15000, 'graveyard hopper');
  await evaluate(`document.querySelector('.overlay [data-action=bio]').click()`);
  await waitFor('location.hash.startsWith("#/bio/")', 15000, 'bio route for the dead hopper');
  await sleep(250);
}
const entryHash = await evaluate('location.hash');
await evaluate('history.back()');
await waitFor('location.hash === "#/pond"', 15000, 'back to pond');
await evaluate('history.forward()');
await waitFor(`location.hash === ${JSON.stringify(entryHash)}`, 15000, 'forward to frog');
await waitFor('document.querySelector(".detail-name")?.textContent === "Test Hopper"', 15000, 'frog record after forward');
console.log('history: frog detail survives back/forward');

await evaluate(`document.querySelector('[data-action=nav][data-view=leaders]').click()`);
await waitFor('document.querySelectorAll(".leader-row[data-sat]").length > 1', 15000, 'leaderboard rows');
const stranger = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.leader-row[data-sat]')].find((r) => !/Test Hopper/.test(r.innerText));
  if (!row) return null;
  return { sat: Number(row.dataset.sat), name: row.querySelector('.name')?.textContent?.replace('YOU', '').trim() || '' };
})()`);
if (!stranger) {
  errors.push('routing: no public frog available to test stale record');
} else {
  await evaluate(`location.hash = '#/frog/${stranger.sat}'`);
  await waitFor(`document.querySelector('.detail-name')?.textContent === ${JSON.stringify(stranger.name)}`, 15000, 'public frog detail');
  console.log('route: direct frog hash shows', stranger.name);
  await evaluate(`document.querySelector('[data-action=nav][data-view=wallet]').click()`);
  await waitFor('location.hash === "#/wallet"', 15000, 'wallet route after public frog');
}

// 6. Lock semantics: no silent auto-unlock, then opt-in remember.
await call('Page.reload', { ignoreCache: true });
await waitFor('document.querySelector("[data-input=lock-password]")', 15000, 'lock after reload');
console.log('lock: reload asks for the password');
await fill('lock-password', 'hopper-demo-1');
await click('unlock');
await waitFor('document.querySelector(".topbar") || document.querySelector(".rules-screen")', 30000, 'unlock');
await skipTour();
await call('Page.reload', { ignoreCache: true });
await waitFor('document.querySelector("[data-input=lock-password]")', 15000, 'lock after opt-out reload');
console.log('lock: password-only unlock is not remembered');
await fill('lock-password', 'hopper-demo-1');
await evaluate(`document.querySelector('[data-input=lock-remember]').checked = true`);
await click('unlock');
await waitFor('document.querySelector(".topbar") || document.querySelector(".rules-screen")', 30000, 'unlock remembered');
await skipTour();
await call('Page.reload', { ignoreCache: true });
await waitFor('document.querySelector(".topbar") || document.querySelector(".rules-screen")', 30000, 'auto unlock');
await skipTour();
console.log('lock: remembered KEK auto-unlocks');

// Persist a screenshot path for inspection.
await call('Page.captureScreenshot', { format: 'png' }).then(async (shot) => {
  const fs = await import('node:fs');
  fs.writeFileSync('.shots/e2e-final.png', Buffer.from(shot.data, 'base64'));
});
await evaluate('window.__hopperErrors = true');

const problems = errors.filter((e) => !/favicon|AudioContext|autoplay/i.test(e));
console.log(errors.length ? `console errors: ${JSON.stringify(errors.slice(0, 6))}` : 'console errors: none');
console.log('e2e: ok');
if (problems.length) {
  console.error('PROBLEMS', problems);
  process.exit(1);
}
ws.close();
