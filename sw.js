/* FlowMark service worker — offline-first */
const VERSION = 'flowmark-v13';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // CDN libraries (jsPDF, pdf.js): cache-first, fall back to network and store.
  if (url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(
      caches.open(VERSION).then(async cache => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try { const res = await fetch(req); cache.put(req, res.clone()); return res; }
        catch (err) { return hit || Response.error(); }
      })
    );
    return;
  }

  // Same-origin app shell: cache-first with network update.
  if (url.origin === location.origin) {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy)).catch(() => { });
        return res;
      }).catch(() => caches.match('./index.html')))
    );
  }
});
