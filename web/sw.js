// HOPPER app shell. The demo chain is local; live mode is network-only.
const VERSION = 'hopper-v6-5';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'js/main.js',
  'js/sound.js',
  'js/core/art.js',
  'js/core/envelope.js',
  'js/core/fold.js',
  'js/core/fold_source.js',
  'js/core/fold_source_v1.js',
  'js/core/hex.js',
  'js/core/inscription.js',
  'js/core/mintdoc.js',
  'js/core/params.js',
  'js/core/png.js',
  'js/core/satmath.js',
  'js/core/settle.js',
  'js/core/v6.js',
  'js/mock/chain.js',
  'js/ui/dom.js',
  'js/ui/screens.js',
  'js/wallet/actions.js',
  'js/wallet/addresses.js',
  'js/wallet/backend.js',
  'js/wallet/keys.js',
  'js/wallet/storage.js',
  'js/wallet/tx.js',
  'js/wallet/txparse.js',
  'js/wallet/vault.js',
  'js/wallet/wallet.js',
  'js/vendor/bitcoin-lib.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never intercept chain/indexer traffic or cross-origin calls.
  if (url.origin !== self.location.origin) return;
  if (/\/(v1|api)\//.test(url.pathname)) return;
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put('index.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('index.html')),
    );
    return;
  }
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    })),
  );
});
