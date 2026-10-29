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
await evaluate(`(() => { const s=document.querySelector('[data-input=ob-network]'); s.value='regtest'; s.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
await click('ob-finish');
await waitFor('document.querySelector(".topbar") || document.querySelector(".rules-screen")', 30000, 'wallet shell');
await skipTour();
await waitFor('document.querySelector(".balance") || document.querySelector("[data-action=sheet-send]")', 30000, 'wallet rendered');
await sleep(600);
const balance = await evaluate('document.querySelector(".balance")?.innerText');
console.log('wallet:', balance?.replace(/\n/g, ' | '));

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

// The rules walkthrough is a settings entry (the egui app has no drawer
// item for it either): open it, check it fits, and close it.
await evaluate(`location.hash='#/settings'`);
await sleep(200);
await evaluate(`document.querySelector('[data-action=open-rules]').click()`);
await waitFor('document.querySelector(".rules-screen")', 5000, 'rules walkthrough');
{
  const m = await evaluate(`({ iw: innerWidth, sw: document.documentElement.scrollWidth })`);
  if (m.sw > m.iw + 1) errors.push(`layout rules: width ${m.sw}/${m.iw}`);
}
await evaluate(`document.querySelector('[data-action=rule-skip]').click()`);
await sleep(200);

// The route change, not a data refresh, resets scroll. The WALLET page is
// deliberately a short centered block (FROGGER's balance hero), so the
// scrollable page for this test is SETTINGS.
await evaluate(`document.querySelector('[data-action=nav][data-view=settings]').click()`);
await sleep(300);
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
await waitFor('document.querySelector("[data-action=mint]")');
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
await click('mint');
await waitFor('location.hash === "#/pond"', 40000, 'mint to navigate to pond');
await waitFor('document.querySelectorAll(".pond-item").length > 0', 20000, 'minted frog card');
const pond = await evaluate('document.querySelector("#app")?.innerText');
console.log('pond:', pond?.replace(/\n/g, ' | '));
if (logs.some((l) => /mint worker unavailable/i.test(l))) errors.push('mint worker fell back to the main thread');

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

// 3. Open frog, prepare custody.
await evaluate(`document.querySelector('.pond-item [data-action=open-frog]').click()`);
await waitFor('document.querySelector("[data-action=prepare]")', 15000, 'prepare button');
await click('prepare');
await waitFor('document.querySelector("[data-action=sheet-cross]")', 30000, 'cross button after prepare');
console.log('frog detail:', (await evaluate('document.querySelector(".detail-head")?.innerText')).replace(/\n/g, ' | '));

// 4. Cross.
await evaluate(`document.querySelector('[data-action=sheet-cross]').click()`);
await waitFor('document.querySelector("[data-action=do-cross]")');
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
