// Force one clean shell load when a new deploy is available.
//
// GitHub Pages serves scripts with `Cache-Control: max-age=600`. A reload
// during a deploy can therefore rebuild the app from a mix of old and new
// modules, and a module that imports an export the other half no longer
// has fails at link time — the page keeps its CSS but renders nothing.
//
// So: when the deployed worker's VERSION is not the cache this page was
// built from, register the new worker and let it take control (its fetch
// handler revalidates every script), then reload under it. If service
// workers are unavailable, refresh the browser's HTTP cache for the whole
// shell first. Either way the reloaded page is coherent.
//
// HOPPER_REPAIR is the manual version of the same recovery, for the boot
// watchdog in index.html.
(() => {
  'use strict';
  const BUILD = 'hopper-v7-3-6';
  const FLAG = `hopper.build-guard.${BUILD}`;
  globalThis.HOPPER_BUILD = BUILD;
  if (!/^https?:$/.test(location.protocol)) return;

  const reloadWithBuild = () => {
    const url = new URL(location.href);
    url.searchParams.set('build', BUILD);
    location.replace(url.toString());
  };

  // Read the precache list straight from the deployed worker, so this file
  // never has to keep a second copy of it in step.
  const shellList = async () => {
    try {
      const res = await fetch('./sw.js', { cache: 'no-store' });
      if (!res.ok) return null;
      const text = await res.text();
      const block = /const SHELL = \[([\s\S]*?)\];/.exec(text);
      if (!block) return null;
      return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    } catch {
      return null;
    }
  };

  // Revalidate every shell file through the browser's HTTP cache. This is
  // the fallback when no service worker can take over.
  const refreshShell = async () => {
    const list = await shellList();
    if (!list || !list.length) return;
    await Promise.all(list.map((u) => fetch(u, { cache: 'reload' }).catch(() => null)));
  };

  const wipe = async () => {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
    } catch { /* service workers may be unavailable */ }
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => false)));
    } catch { /* storage may be denied */ }
  };

  let repairing = false;
  globalThis.HOPPER_REPAIR = async () => {
    if (repairing) return;
    repairing = true;
    await wipe();
    await refreshShell();
    const url = new URL(location.href);
    url.searchParams.set('build', BUILD);
    url.searchParams.set('repair', String(Date.now()));
    location.replace(url.toString());
  };

  const restart = async () => {
    try {
      if (sessionStorage.getItem(FLAG) === BUILD) return;
      sessionStorage.setItem(FLAG, BUILD);
    } catch { /* private mode can deny storage */ }

    let controlled = false;
    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
        controlled = await new Promise((resolve) => {
          const timer = setTimeout(async () => {
            const keys = await caches.keys().catch(() => []);
            resolve(keys.includes(BUILD));
          }, 4000);
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            clearTimeout(timer);
            resolve(true);
          }, { once: true });
        });
      } catch { /* fall back to the HTTP-cache refresh below */ }
    }
    if (!controlled) await refreshShell();
    reloadWithBuild();
  };

  (async () => {
    let remote = null;
    try {
      const res = await fetch('./sw.js', { cache: 'no-store' });
      if (res.ok) {
        const found = /VERSION\s*=\s*'([^']+)'/.exec(await res.text());
        remote = found ? found[1] : null;
      }
    } catch {
      // Offline: keep the working cached shell rather than clearing it.
      return;
    }
    if (!remote) return;
    const keys = await caches.keys().catch(() => []);
    if (remote === BUILD && keys.includes(BUILD)) return;
    await restart();
  })().catch(() => { /* never block the app on the guard */ });
})();
