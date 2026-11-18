// Pragya service worker.
// B3.1: the two placeholders below are replaced at build time by the `pragyaSwPrecache()`
// Vite plugin (scripts/swPrecache.mjs). Unbuilt, this file stays valid JS and falls back
// to the core shell list.
const PRECACHE = self.__PRAGYA_PRECACHE__ || [];
const BUILD_ID = '__PRAGYA_BUILD_ID__';
const SHELL_PREFIX = 'pragya-shell-';
const SHELL_CACHE = SHELL_PREFIX + BUILD_ID;

const scopeUrl = new URL('./', self.registration.scope);
const INDEX_URL = new URL('index.html', scopeUrl).toString();
const ASSETS_PREFIX = new URL('assets/', scopeUrl).toString();
const FONTS_PREFIX = new URL('fonts/', scopeUrl).toString();
const CORE_SHELL_FILES = [
  'index.html',
  'manifest.webmanifest',
  'lotus.svg',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'fonts/InterVariable.woff2',
  'fonts/InterVariable-Italic.woff2',
];
// Precache URLs are scope-relative, so one build works under both './' and '/pragya/'.
const PRECACHE_URLS = Array.from(
  new Set(
    [scopeUrl.toString()].concat(
      (PRECACHE.length ? PRECACHE : CORE_SHELL_FILES).map(file =>
        new URL(file, scopeUrl).toString()
      )
    )
  )
);

// B3.2 / ux_spec D.2: tiny inline offline page — no external assets.
const OFFLINE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>You're offline · Pragya</title><style>" +
  'html,body{margin:0;height:100%;background:#0B0C0F;color:#EDEEF1;' +
  'font-family:Inter,ui-sans-serif,system-ui,sans-serif}' +
  'body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}' +
  'main{background:#131418;border-radius:14px;padding:28px;max-width:420px;text-align:center}' +
  'h1{font-size:20px;margin:0 0 12px}p{color:#9DA0A8;line-height:1.5;margin:0 0 20px}' +
  'button{font:inherit;background:#EDEEF1;color:#0B0C0F;border:0;border-radius:14px;' +
  'padding:10px 20px;cursor:pointer}</style></head><body>' +
  '<main data-testid="sw-offline-page"><h1>You\'re offline</h1>' +
  "<p>Pragya will open as soon as you're back online. Your notes are safe in your Google account.</p>" +
  '<button type="button" onclick="location.reload()">Try Again</button></main></body></html>';

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function putInShell(request, response) {
  if (response && response.ok && response.type === 'basic') {
    const copy = response.clone();
    caches
      .open(SHELL_CACHE)
      .then(cache => cache.put(request, copy))
      .catch(() => {});
  }
  return response;
}

function isShellNavigationUrl(url) {
  const href = url.href.split('#')[0].split('?')[0];
  return href === scopeUrl.toString() || href === INDEX_URL;
}

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // R1#2: bypass the HTTP cache so a fresh worker never precaches a stale
      // index.html (e.g. GitHub Pages max-age=600 right after a deploy).
      .then(cache => cache.addAll(PRECACHE_URLS.map(u => new Request(u, { cache: 'reload' }))))
      // skipWaiting + evicting the previous shell on activate is safe only because the app
      // has no code-splitting: a running tab already holds all of its JS. If React.lazy /
      // dynamic import() is ever added, keep the previous shell until no old clients remain.
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
            .filter(key => key.startsWith(SHELL_PREFIX) && key !== SHELL_CACHE)
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

  // Hard bypass for all cross-origin requests (Google APIs, OAuth, pragya.local media).
  if (url.origin !== self.location.origin) {
    return;
  }

  // Never interfere with Drive image synthetic paths or sw.js updates.
  if (url.pathname.includes('drive-media') || url.pathname.endsWith('/sw.js')) {
    return;
  }

  // Network-first for HTML navigations so fresh builds deploy promptly, then the cached
  // shell, then the inline offline page. Never resolves to undefined.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          // R1#3: only the app shell itself (scope root / index.html, served as HTML)
          // may become the offline index; never a manifest, icon or other page.
          const type = (response && response.headers && response.headers.get('content-type')) || '';
          if (response && response.ok && isShellNavigationUrl(url) && type.includes('text/html')) {
            const copy = response.clone();
            caches
              .open(SHELL_CACHE)
              .then(cache => cache.put(INDEX_URL, copy))
              .catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(INDEX_URL).then(hit => hit || offlineResponse()))
        .catch(() => offlineResponse())
    );
    return;
  }

  // Only same-origin requests inside the app scope are handled below.
  if (!url.href.startsWith(scopeUrl.toString())) {
    return;
  }

  // Hashed build assets and self-hosted fonts (versioned via BUILD_ID): cache-first, then network.
  if (url.href.startsWith(ASSETS_PREFIX) || url.href.startsWith(FONTS_PREFIX)) {
    event.respondWith(
      caches
        .match(request)
        .then(hit => hit || fetch(request).then(response => putInShell(request, response)))
        .catch(() => Response.error())
    );
    return;
  }

  // Other static files: stale-while-revalidate.
  event.respondWith(
    caches
      .match(request)
      .then(cached => {
        const networkFetch = fetch(request)
          .then(response => putInShell(request, response))
          .catch(() => cached || Response.error());
        return cached || networkFetch;
      })
      .catch(() => Response.error())
  );
});
