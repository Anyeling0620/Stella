/* eslint-env serviceworker */
/**
 * Stella IM service worker.
 *
 * Two jobs:
 *   1. Web Push display + click routing.
 *   2. A minimal offline shell so the app still opens on a flaky network
 *      (navigation = network-first with a cached fallback; static assets =
 *      cache-first with background revalidate).
 */
const CACHE = 'stella-shell-v1';
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // never cache API/other origins
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;

  // Navigations: network-first, fall back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // Static assets: cache-first, then revalidate in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'clear-cache') {
    event.waitUntil(caches.delete(CACHE));
  }
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = data.title || 'Stella IM';
  const options = {
    body: data.body || '收到一条新消息',
    tag: data.tag || undefined,
    data: { conversationId: data.conversationId || null },
    icon: '/favicon.svg',
    badge: '/favicon.svg',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const conversationId = event.notification.data && event.notification.data.conversationId;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if ('focus' in client) {
          await client.focus();
          if (conversationId) client.postMessage({ type: 'open-conversation', conversationId });
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow('/');
    })()
  );
});
