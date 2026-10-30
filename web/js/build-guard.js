// Force one clean shell load when a new deploy is available.
//
// Navigation is network-first, but a browser that never fully quits the PWA
// can keep executing the old module graph even after the worker updates.
// This guard runs before main.js, compares the deployed sw.js with this
// build, drops old workers/caches once, and reloads with a cache-busting
// query. It never touches wallet storage.
(() => {
  'use strict';
  const BUILD = 'hopper-v6-44';
  const FLAG = `hopper.build-guard.${BUILD}`;
  globalThis.HOPPER_BUILD = BUILD;
  if (!/^https?:$/.test(location.protocol)) return;
  if (!('serviceWorker' in navigator) || !('caches' in window)) return;

  let reloading = false;
  const restart = async () => {
    if (reloading) return;
    reloading = true;
    try {
      if (sessionStorage.getItem(FLAG) === BUILD) return;
      sessionStorage.setItem(FLAG, BUILD);
    } catch (_) {
      // Private mode can deny storage; the query reload is still safe once.
    }
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) { /* a cache-less browser is not an error */ }
    const url = new URL(location.href);
    url.searchParams.set('build', BUILD);
    location.replace(url.toString());
  };

  (async () => {
    let remote = null;
    try {
      const res = await fetch('./sw.js', { cache: 'no-store' });
      if (res.ok) {
        const found = /VERSION\s*=\s*'([^']+)'/.exec(await res.text());
        remote = found ? found[1] : null;
      }
    } catch (_) {
      // Offline: keep the working cached shell rather than clearing it.
      return;
    }
    if (!remote) return;
    const keys = await caches.keys().catch(() => []);
    if (remote === BUILD && keys.includes(BUILD)) return;
    await restart();
  })().catch(() => { /* never block the app on the guard */ });
})();
