// HOPPER app shell. The demo chain is local; live mode is network-only.
const VERSION = 'hopper-v6-39';
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'fonts/pixelify-sans-latin.woff2',
  'fonts/silkscreen-digits-400.woff2',
  'fonts/silkscreen-digits-700.woff2',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon.svg',
  'icons/favicon-32.png',
  'js/main.js',
  'js/shell-reset.js',
  'js/sound.js',
  'music.mid',
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
  'js/ui/theme.js',
  'js/ui/frog-mark.js',
  'js/ui/qr.js',
  'js/ui/tour.js',
  'js/wallet/actions.js',
  'js/wallet/fees.js',
  'js/wallet/rbf.js',
  'js/wallet/addresses.js',
  'js/wallet/backend.js',
  'js/wallet/keys.js',
  'js/wallet/localmint.js',
  'js/wallet/mint-client.js',
  'js/wallet/mint-worker.js',
  'js/wallet/storage.js',
  'js/wallet/tx.js',
  'js/wallet/txparse.js',
  'js/wallet/vault.js',
  'js/wallet/wallet.js',
  'js/vendor/bitcoin-lib.js',
  'js/vendor/qr.js',
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
  // Code is network-first: a pulled fix must be the code that runs on the
  // next online reload, not the copy a previous worker cached. Images, the
  // score and fonts stay cache-first (they are content, not behaviour).
  if (/\/js\/.*\.js$/.test(url.pathname) || /\/css\/.*\.css$/.test(url.pathname)) {
    event.respondWith(
      fetch(req, { cache: 'no-cache' }).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || Response.error())),
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
