// Service worker: guarda os arquivos do aplicativo para abrir sem conexão.
// Dados do plantão ficam no IndexedDB e não passam pelo service worker.
const VERSION = '2.1.0';
const CACHE = `plantao-control-${VERSION}`;
const ASSETS = [
  './', 'index.html', 'manifest.webmanifest',
  'css/styles.css',
  'js/app.js', 'js/sectors.js', 'js/validation.js', 'js/storage.js', 'js/report.js', 'js/export.js', 'js/ui.js', 'js/formconfig.js', 'form-config.json',
  'fonts/plus-jakarta-sans-latin.woff2',
  'icons/favicon.svg', 'icons/favicon.ico', 'icons/favicon-32.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('plantao-control-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

// Rede primeiro (para receber atualizações); cache como reserva sem conexão.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
