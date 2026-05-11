/**
 * sw.js — Service Worker for Sonora PWA
 *
 * Strategy:
 *   - App shell (HTML + JS): Cache-first, update in background
 *   - CDN assets (Font Awesome, Google Fonts): Stale-while-revalidate
 *   - Drive API calls: Network-only (never cache auth-sensitive requests)
 *   - Audio blobs: Stored in IndexedDB by the app; SW is not involved
 */

const CACHE_VERSION = 'sonora-v1';
const SHELL_CACHE   = CACHE_VERSION + '-shell';
const CDN_CACHE     = CACHE_VERSION + '-cdn';

/* App-shell files to pre-cache on install */
// Use relative URLs so they resolve correctly under any subdirectory
const SHELL_URLS = [
  self.registration.scope,            // e.g. https://user.github.io/repo/
  self.registration.scope + 'index.html',
  self.registration.scope + '404.html',
  self.registration.scope + 'js/storage.js',
  self.registration.scope + 'js/player.js',
  self.registration.scope + 'js/drive.js',
  self.registration.scope + 'js/ui.js',
  self.registration.scope + 'js/app.js',
  self.registration.scope + 'manifest.json',
  self.registration.scope + 'icons/icon.svg',
  self.registration.scope + 'sw.js',
];

/* CDN prefixes to cache at runtime */
const CDN_ORIGINS = [
  'https://cdnjs.cloudflare.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
  'https://accounts.google.com/gsi',
];

/* Never cache these */
const SKIP_PATTERNS = [
  'googleapis.com/drive',
  'googleapis.com/upload',
  'googleapis.com/oauth',
  'oauth2/v3',
  'gsi/client',  // GIS auth — must be fresh
];

/* ─── INSTALL: pre-cache app shell ─── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => {
      // Use individual adds so one failure doesn't break everything
      return Promise.allSettled(
        SHELL_URLS.map(url =>
          cache.add(new Request(url, { cache:'reload' })).catch(e => {
            console.warn('[SW] Pre-cache failed for', url, e);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

/* ─── ACTIVATE: delete old caches ─── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== CDN_CACHE)
            .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ─── FETCH ─── */
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Skip non-GET and non-http(s)
  if (event.request.method !== 'GET') return;
  if (!url.startsWith('http')) return;

  // Never cache Drive/auth API calls
  if (SKIP_PATTERNS.some(p => url.includes(p))) return;

  // CDN assets: stale-while-revalidate
  if (CDN_ORIGINS.some(o => url.startsWith(o))) {
    event.respondWith(_staleCDN(event.request));
    return;
  }

  // Same-origin requests (including subdirectory): cache-first with network fallback
  const scope = self.registration.scope;
  if (url.startsWith(scope) || url.startsWith(self.location.origin)) {
    event.respondWith(_cacheFirst(event.request));
    return;
  }
});

/* Cache-first: return cached, fetch+update in background */
async function _cacheFirst(request) {
  const cache  = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    // Update cache in background
    fetch(request).then(res => {
      if (res && res.status === 200) cache.put(request, res.clone());
    }).catch(() => {});
    return cached;
  }
  // Not in cache: fetch and cache
  try {
    const res = await fetch(request);
    if (res && res.status === 200) cache.put(request, res.clone());
    return res;
  } catch {
    // Offline and not cached — return offline fallback for navigation
    if (request.mode === 'navigate') {
      const fallback = await cache.match(self.registration.scope + 'index.html')
                    || await cache.match(self.registration.scope);
      return fallback || new Response('Offline', { status: 503 });
    }
    return new Response('Offline', { status: 503 });
  }
}

/* Stale-while-revalidate for CDN */
async function _staleCDN(request) {
  const cache  = await caches.open(CDN_CACHE);
  const cached = await cache.match(request);

  // Always kick off a background revalidation
  const networkFetch = fetch(request).then(res => {
    if (res && res.status === 200) cache.put(request, res.clone());
    return res;
  }).catch(() => null);

  // BUG FIX: `fetchPromise` is a Promise object (always truthy), so
  // `cached || fetchPromise || new Response(...)` meant the 503 fallback
  // was unreachable dead code.  When both cache and network miss, the old
  // code returned Promise<null> to respondWith, causing a SW error.
  // Fix: return the cached value immediately if available (fire-and-forget
  // revalidation), and only await the network — with a proper 503 fallback
  // — when there is nothing cached.
  if (cached) {
    networkFetch; // fire-and-forget: revalidate in background
    return cached;
  }
  return (await networkFetch) || new Response('', { status: 503 });
}
