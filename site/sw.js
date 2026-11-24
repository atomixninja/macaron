// Macaron's service worker: the site works offline once opened.
// The page and its files: from the cache, refreshed in the background. The library: from the network
// when there is one, else the last copy. Clips never change (named after their text), so the cache is enough.
const SHELL = 'macaron-shell-1';
const DATA = 'macaron-data-1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'fonts/cormorant-garamond.woff2', 'fonts/cormorant-garamond-italic.woff',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== SHELL && k !== DATA).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname.includes('/data/clips/')) {
    e.respondWith(caches.open(DATA).then(async cache => {
      const hit = await cache.match(url.pathname);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) cache.put(url.pathname, res.clone());
      return res;
    }));
  } else if (url.pathname.endsWith('/data/library.enc')) {
    e.respondWith(caches.open(DATA).then(async cache => {
      try {
        const res = await fetch(e.request, { cache: 'no-cache' });
        if (res.ok) cache.put(url.pathname, res.clone());
        return res;
      } catch {
        return (await cache.match(url.pathname)) ?? Response.error();
      }
    }));
  } else {
    e.respondWith(caches.open(SHELL).then(async cache => {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => null);
      return hit ?? (await fresh) ?? Response.error();
    }));
  }
});
