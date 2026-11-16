const SHELL_CACHE = 'pragya-shell-v1';

const scopeUrl = new URL('./', self.registration.scope);
const INDEX_URL = new URL('index.html', scopeUrl).toString();
const CORE_SHELL_URLS = [
  scopeUrl.toString(),
  INDEX_URL,
  new URL('manifest.webmanifest', scopeUrl).toString(),
  new URL('lotus.svg', scopeUrl).toString(),
  new URL('icon-192.png', scopeUrl).toString(),
  new URL('icon-512.png', scopeUrl).toString(),
  new URL('apple-touch-icon.png', scopeUrl).toString(),
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(cache => cache.addAll(CORE_SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key.startsWith('pragya-shell-') && key !== SHELL_CACHE)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Hard bypass for all cross-origin requests (Google APIs, OAuth, Fonts, pragya.local media).
  if (url.origin !== self.location.origin) {
    return;
  }

  // Never interfere with Drive image synthetic paths or sw.js updates.
  if (url.pathname.includes('drive-media') || url.pathname.endsWith('/sw.js')) {
    return;
  }

  // Network-first for HTML navigations so fresh builds deploy promptly, with offline fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then(cache => cache.put(INDEX_URL, copy));
          }
          return response;
        })
        .catch(() => caches.match(INDEX_URL).then(hit => hit || Response.error()))
    );
    return;
  }

  // Cache-first with background refresh for same-origin static assets inside app scope.
  if (!url.href.startsWith(scopeUrl.toString())) {
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request)
        .then(response => {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then(cache => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});
