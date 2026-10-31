// Force one clean shell load when a new deploy is available.
//
// GitHub Pages serves scripts with `Cache-Control: max-age=600`. A reload
// during a deploy can therefore rebuild the app from a mix of old and new
// modules, and a module that imports an export the other half no longer
// has fails at link time — the page keeps its CSS but renders nothing.
//
// So: compare the deployed worker's VERSION with the code that is actually
// running. If this page is already the deployed build, register the worker
// and let it fill a complete cache in the background — never reload it.
// If the page is stale, register the new worker, wait until every shell file
// is really in its cache, then reload once under it. The one-shot flag
// survives that reload, so a failed install cannot become a reload loop.
//
// HOPPER_REPAIR is the manual version of the same recovery, for the boot
// watchdog in index.html.
(() => {
  'use strict';
  const BUILD = 'hopper-v7-3-18';
  globalThis.HOPPER_BUILD = BUILD;
  if (!/^https?:$/.test(location.protocol)) return;

  const INTRO_SKIP = 'hopper.introSkip';
  const flagFor = (version) => `hopper.build-guard.${version}`;
  const absolute = (u) => new URL(u, location.href).href;

  const readRemote = async () => {
    try {
      const res = await fetch('./sw.js', { cache: 'no-store' });
      if (!res.ok) return null;
      const text = await res.text();
      const version = /VERSION\s*=\s*'([^']+)'/.exec(text)?.[1] || null;
      const block = /const SHELL = \[([\s\S]*?)\];/.exec(text);
      const shell = block
        ? [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
        : [];
      return version ? { version, shell } : null;
    } catch {
      // Offline: keep the working cached shell rather than clearing it.
      return null;
    }
  };

  // A cache is ready only when every shell path is present and readable.
  // `caches.has(version)` is true as soon as the install opens the cache,
  // which used to make the guard reload halfway through the download.
  const cacheComplete = async (version, shell) => {
    if (!version || !shell?.length) return false;
    try {
      const cache = await caches.open(version);
      for (const u of shell) {
        if (!(await cache.match(absolute(u)))) return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  const waitForCache = async (version, shell, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await cacheComplete(version, shell)) return true;
      if (Date.now() >= end) return false;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };

  const registerWorker = async () => {
    if (!('serviceWorker' in navigator)) return null;
    try {
      return await navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
    } catch {
      return null;
    }
  };

  // Revalidate every shell file through the browser's HTTP cache. This is
  // the fallback when no service worker can take over.
  const refreshShell = async (shell) => {
    if (!shell?.length) return;
    await Promise.all(shell.map((u) => fetch(absolute(u), { cache: 'reload' }).catch(() => null)));
  };

  const markIntroSkip = () => {
    try { sessionStorage.setItem(INTRO_SKIP, '1'); } catch { /* storage may be denied */ }
  };

  const reloadWithBuild = (version) => {
    markIntroSkip();
    const url = new URL(location.href);
    url.searchParams.set('build', version);
    // The query is a second one-shot flag. It survives the reload even when
    // sessionStorage is denied, so private mode cannot become a reload loop.
    url.searchParams.set('guard', '1');
    location.replace(url.toString());
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
    const remote = await readRemote();
    await wipe();
    await refreshShell(remote?.shell || []);
    markIntroSkip();
    const url = new URL(location.href);
    url.searchParams.set('build', BUILD);
    url.searchParams.set('guard', '1');
    url.searchParams.set('repair', String(Date.now()));
    location.replace(url.toString());
  };

  const restart = async (remote, shell, urlTried = false) => {
    let tried = urlTried;
    try {
      tried = tried || sessionStorage.getItem(flagFor(remote)) === '1';
      sessionStorage.setItem(flagFor(remote), '1');
    } catch { /* private mode can deny storage */ }

    // Honour the one-shot flag before the cache check. A complete cache can
    // coexist with a stale page (HTTP cache, an edge node still serving the
    // previous build); reloading that page again is the loop, not the fix.
    if (tried) {
      await registerWorker();
      return;
    }

    if (await cacheComplete(remote, shell)) {
      reloadWithBuild(remote);
      return;
    }

    await registerWorker();
    if (await waitForCache(remote, shell, 8000)) {
      reloadWithBuild(remote);
      return;
    }

    // The worker did not finish the cache in time (blocked storage, flaky
    // line). Revalidate the HTTP shell once and reload; the flag above keeps
    // that from becoming another attempt in this tab.
    await refreshShell(shell);
    reloadWithBuild(remote);
  };

  (async () => {
    const remote = await readRemote();
    if (!remote) return;
    const here = new URL(location.href);
    const urlTried = here.searchParams.get('guard') === '1';

    if (remote.version === BUILD) {
      // This page already runs the deployed code. A successful update reload
      // can drop its attempt marker; the build query stays for the splash
      // skipper if the old guard wrote it.
      if (urlTried) {
        const now = new URL(location.href);
        if (now.searchParams.has('guard')) {
          now.searchParams.delete('guard');
          history.replaceState(null, '', now.toString());
        }
      }
      // Fill the cache in the background; a reload here would only replay
      // the boot screen.
      if (!(await cacheComplete(BUILD, remote.shell))) registerWorker();
      return;
    }

    // The running shell is from a different deploy. Make it coherent once.
    await restart(remote.version, remote.shell, urlTried);
  })().catch(() => { /* never block the app on the guard */ });
})();
