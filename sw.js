/* コース上は電波が届かないことがあるため、完全オフライン動作を前提にする。
   キャッシュ名の末尾を上げると、次回オンライン起動時に全部入れ替わる。 */
const CACHE = 'caddie-v2';

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'clubs.json',
  'manifest.webmanifest',
  'fonts/big-shoulders-display-latin.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // 1つでも失敗すると install ごと落ちるため、個別に入れる
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
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

  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // clubs.json は更新が正なので、まずネットワークを見る
  if (url.pathname.endsWith('clubs.json')) {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : undefined))
    )
  );
});
