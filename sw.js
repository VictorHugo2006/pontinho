/* Service Worker do Pontinho — cache para uso offline.
   Ao atualizar arquivos, suba o número da versão (mantenha igual ao ?v= do index.html). */
const CACHE = 'pontinho-v53';
const ASSETS = [
  './',
  './index.html',
  './styles.css?v=53',
  './firebase-config.js?v=53',
  './app.js?v=53',
  './online.js?v=53',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // HTML (navegação): network-first — sempre pega o index novo do servidor;
  // só usa o cache se estiver offline. Evita ficar preso numa versão antiga.
  const aceita = req.headers.get('accept') || '';
  const isHTML = req.mode === 'navigate' || aceita.includes('text/html');
  if (isHTML) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((c) => c || caches.match('./index.html')))
    );
    return;
  }

  // Demais arquivos (versionados por ?v=): cache-first.
  e.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match('./index.html'))
    )
  );
});
