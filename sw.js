/* Shop Records service worker — offline-first cache */
const CACHE = 'shop-records-v30';
const ASSETS = [
  '/',
  '/index.html',
  '/style.css',
  '/db.js',
  '/sync.js',
  '/drive.js',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  // jsPDF (cached after first online visit so PDF export works offline too)
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  // Firebase SDK (cached after first online visit so sync works offline-first)
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js',
  // Google sign-in (cached after first online visit for Drive backup)
  'https://accounts.google.com/gsi/client',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // cache local assets strictly; CDN best-effort (may fail offline at install time)
      Promise.allSettled(ASSETS.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res.ok && (e.request.url.startsWith(self.location.origin) ||
            e.request.url.includes('cdnjs.cloudflare.com') ||
            e.request.url.includes('gstatic.com') ||
            e.request.url.includes('accounts.google.com'))) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match('/index.html'));
    })
  );
});