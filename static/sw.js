/* 亮言 · 即時翻譯 — Service Worker (PWA)
   網路優先 (network-first)：線上一律拿最新版，離線才用快取，避免更新被舊快取卡住。 */
const CACHE = 'liang-translate-v11';

self.addEventListener('install', (e) => {
    self.skipWaiting();  // 新版立即接手
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))  // 清掉所有舊快取
    );
    self.clients.claim();
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
    if (e.request.method !== 'GET') return;
    // 網路優先：先抓最新，順便更新快取；沒網路才用快取
    e.respondWith(
        fetch(e.request).then(res => {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
            return res;
        }).catch(() => caches.match(e.request).then(hit => hit || caches.match('/')))
    );
});
