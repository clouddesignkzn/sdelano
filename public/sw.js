/* Сделано · service worker: сайт открывается и работает без интернета.
 *  - страница: сначала сеть (свежая версия), при офлайне из кэша;
 *  - статика: из кэша с фоновым обновлением (stale-while-revalidate).
 * Обрабатываются только GET-запросы к своему origin.
 */
const VERSION = '2.0.0';
const CACHE = `sdelano-${VERSION}`;

const PRECACHE = [
  './',
  './favicon.svg',
  './manifest.webmanifest',
  './assets/css/app.css',
  './assets/js/app.js',
  './assets/js/store.js',
  './assets/js/theme-init.js',
  './assets/fonts/inter-regular.woff',
  './assets/fonts/inter-medium.woff',
  './assets/fonts/inter-semibold.woff',
  './assets/fonts/inter-display-semibold.woff',
  './assets/fonts/accent-italic.woff',
  './assets/icons/icon-192.png',
  './assets/icons/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('sdelano-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const cacheable = (response) => response && response.ok && response.type === 'basic';

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (cacheable(response)) await cache.put('./', response.clone());
    return response;
  } catch {
    return (await cache.match('./')) || Response.error();
  }
}

async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request, { ignoreSearch: true });
  const update = fetch(event.request)
    .then((response) => {
      if (cacheable(response)) cache.put(event.request, response.clone());
      return response;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(update);
    return cached;
  }
  return (await update) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/health')) return; // проверки состояния всегда идут в сеть
  if (request.mode === 'navigate') {
    if (url.pathname === new URL('./', self.registration.scope).pathname) event.respondWith(networkFirst(request));
    return; // остальные адреса отдаёт сервер (в том числе 404)
  }
  event.respondWith(staleWhileRevalidate(event));
});
