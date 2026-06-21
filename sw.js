'use strict';

const CACHE_VERSION = 'musicbox-v1.1.0';
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/variables.css',
  './css/base.css',
  './css/layout.css',
  './css/components.css',
  './css/player.css',
  './css/editor.css',
  './css/log.css',
  './css/settings.css',
  './css/responsive.css',
  './js/utils.js',
  './js/state.js',
  './js/storage.js',
  './js/metadata.js',
  './js/virtual-scroll.js',
  './js/equalizer.js',
  './js/audio.js',
  './js/player.js',
  './js/editor.js',
  './js/log.js',
  './js/settings.js',
  './js/main.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/sortablejs@1.15.0/Sortable.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jsmediatags/3.9.5/jsmediatags.min.js',
  'https://cdn.jsdelivr.net/npm/lucide@0.475.0/dist/umd/lucide.min.js',
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(PRECACHE);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw e;
  }
}

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Third-party scripts/assets: try network, fall back to cache if possible.
  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh) {
        const cache = await caches.open(CACHE_VERSION);
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (e) {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req);
      if (cached) return cached;
      throw e;
    }
  })());
});
