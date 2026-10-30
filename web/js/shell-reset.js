// Recover from a stale app shell.
//
// A service worker is cache-first for scripts, so a browser that still has
// an old worker can keep serving the old sound.js/main.js even after the
// page is reloaded. Navigation is network-first, which means this file does
// arrive; if the cache this shell expects is absent, drop the old worker and
// reload once. The new shell then fetches every script from the network and
// installs its own cache.
//
// Keep EXPECTED in step with VERSION in sw.js. The session flag makes this
// a one-shot: if the new worker cannot install (offline, missing asset) the
// page still loads from the network instead of reloading forever.
(() => {
  'use strict';
  const EXPECTED = 'hopper-v6-45';
  const FLAG = 'hopper.shell-reset';
  if (!('serviceWorker' in navigator) || !('caches' in window)) return;

  try {
    if (sessionStorage.getItem(FLAG) === EXPECTED) return;
  } catch (_) {
    // Storage can be denied; the absence of a flag is not fatal because the
    // online check below still guards the usual offline case.
  }

  const recover = async () => {
    if (!navigator.onLine) return;
    if (typeof navigator.serviceWorker.getRegistrations !== 'function') return;
    const keys = await caches.keys();
    if (keys.includes(EXPECTED)) return;
    const regs = await navigator.serviceWorker.getRegistrations();
    if (!regs.length) return;
    try { sessionStorage.setItem(FLAG, EXPECTED); } catch (_) { /* private mode */ }
    await Promise.all(regs.map((r) => r.unregister()));
    location.reload();
  };

  recover().catch(() => { /* a cache-less browser is not an error */ });
})();
