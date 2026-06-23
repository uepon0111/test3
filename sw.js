'use strict';

/* ============================================================
   SERVICE WORKER  —  PWA インストール対応・アプリシェルのオフラインキャッシュ
   音声ファイル本体は IndexedDB に保存されるためここではキャッシュしない。
   ============================================================ */

const CACHE_VERSION = 'musicbox-v2';
const APP_SHELL = [
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
  './js/equalizer.js',
  './js/audio.js',
  './js/virtual-scroll.js',
  './js/player.js',
  './js/editor.js',
  './js/log.js',
  './js/settings.js',
  './js/main.js',
  './assets/icons/icon-32.png',
  './assets/icons/icon-180.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-512-maskable.png',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部リクエスト（CDN の lucide 等）は素通し

  // アプリシェル: キャッシュ優先・裏で更新（stale-while-revalidate）
  event.respondWith(
    caches.match(req).then(cached => {
      const fetchPromise = fetch(req).then(networkRes => {
        if (networkRes && networkRes.ok) {
          const clone = networkRes.clone();
          caches.open(CACHE_VERSION).then(cache => cache.put(req, clone));
        }
        return networkRes;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
