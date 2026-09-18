// 서비스 워커 — 홈 화면에 설치했을 때 앱처럼 뜨고, 껐다 켜도 즉시 열리게 한다.
//
// 🔴 원칙 하나: 시세·이벤트 같은 API 응답은 절대 캐시하지 않는다.
//    낡은 가격을 보여 주는 자산 앱은 고장난 것보다 나쁘다 — 틀린 줄 모르고 판단하게 된다.
//    캐시하는 것은 앱 껍데기(HTML·CSS·JS·아이콘)뿐이다.
//
// 🔴 원칙 둘: 개인 데이터는 여전히 localStorage 에만 있다. 서비스 워커는 그것을 건드리지 않는다.

// 앱 껍데기를 고칠 때마다 이 숫자를 올린다. 안 올리면 사용자가 옛 화면에 갇힌다.
const VERSION = 'v1';
const SHELL = 'seed-shell-' + VERSION;

const SHELL_FILES = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // 하나라도 실패하면 addAll 은 통째로 실패한다. 개별로 담아 한 파일 때문에 전부 죽지 않게 한다.
    await Promise.all(SHELL_FILES.map(async (u) => {
      try { await cache.add(new Request(u, { cache: 'reload' })); } catch (_) { /* 이 파일만 건너뛴다 */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // 옛 버전 캐시를 지운다. 안 지우면 저장 용량이 계속 쌓인다.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('seed-shell-') && k !== SHELL).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 외부 CDN·API 는 건드리지 않는다

  // 🔴 API 는 항상 네트워크. 실패해도 캐시로 되돌리지 않는다 — 낡은 시세를 주느니 실패가 낫다.
  if (url.pathname.startsWith('/api/')) return;

  // 앱 껍데기: 네트워크 우선, 실패하면 캐시(= 오프라인에서도 열린다).
  // 캐시 우선으로 하면 배포해도 사용자가 옛 화면을 계속 본다.
  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const cache = await caches.open(SHELL);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (_) {
      const hit = await caches.match(req);
      if (hit) return hit;
      // 화면 전환 요청인데 캐시도 없으면 최소한 첫 화면이라도 준다
      if (req.mode === 'navigate') {
        const shell = await caches.match('/index.html');
        if (shell) return shell;
      }
      throw _;
    }
  })());
});
