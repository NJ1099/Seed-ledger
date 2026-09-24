// Seed · Liquid Ledger — 서버 계약 · 보안 회귀 테스트
//
// 이 저장소에는 라운드 30 이전까지 테스트가 한 줄도 없었다. 19,000 줄짜리 코드에
// 회귀를 잡을 장치가 없다는 뜻이고, 실제로 라운드 29 에서 `.env` 가 HTTP 200 으로
// 나가던 사고가 **손으로 찔러 보고서야** 발견됐다. 그런 것들을 여기서 붙잡는다.
//
//   node --test tests/          (또는 npm test)
//
// 외부 시세 API 를 때리는 경로는 네트워크 상태에 따라 흔들리므로 '형태'만 본다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4400 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
let child;

const get = (p, opts = {}) => fetch(`${BASE}${p}`, opts);
const postJson = (p, body) => fetch(`${BASE}${p}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // 헬스체크가 살아날 때까지 최대 20초 기다린다.
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const r = await get('/healthz');
      if (r.ok) break;
    } catch { /* 아직 안 떴다 */ }
    if (Date.now() > deadline) throw new Error('서버가 20초 안에 기동하지 않음');
    await new Promise((r) => setTimeout(r, 250));
  }
});

after(() => { try { child?.kill(); } catch { /* 이미 죽음 */ } });

// ── 기동 · 헬스체크 ─────────────────────────────────────────
test('/healthz 가 200 ok 를 준다 (render.yaml 의 healthCheckPath)', async () => {
  const r = await get('/healthz');
  assert.equal(r.status, 200);
  assert.equal((await r.text()).trim(), 'ok');
});

// ── 보안: 정적 서빙 화이트리스트 (라운드 29 회귀 방지) ───────
test('민감 파일이 정적 서빙으로 새지 않는다', async () => {
  // 과거 이 경로들이 200 으로 통째 전송됐다. .env 는 API 키 전량이었다.
  for (const p of ['/.env', '/server.js', '/app.js.map', '/HANDOFF.md', '/package.json', '/render.yaml']) {
    const r = await get(p);
    assert.ok(r.status === 404 || r.status === 403, `${p} 가 ${r.status} — 새고 있다`);
  }
});

test('data/ 폴더는 통째로 막혀 있다', async () => {
  for (const p of ['/data/quote-cache.json', '/data/events.json', '/data/']) {
    const r = await get(p);
    assert.ok(r.status === 403 || r.status === 404, `${p} 가 ${r.status}`);
  }
});

test('경로 탈출이 막혀 있다', async () => {
  for (const p of ['/..%2f.env', '/%2e%2e%2fserver.js', '/index.html/../.env', '/./.env']) {
    const r = await get(p);
    assert.ok(r.status === 404 || r.status === 403, `${p} 가 ${r.status}`);
  }
});

test('화이트리스트에 있는 자산은 정상 서빙된다', async () => {
  for (const p of ['/', '/index.html', '/app.js', '/styles.css']) {
    const r = await get(p);
    assert.equal(r.status, 200, `${p} 가 ${r.status} — 화이트리스트(PUBLIC_FILES)에 빠졌을 수 있다`);
  }
});

// ── 개인 데이터 원칙 ────────────────────────────────────────
test('개인 데이터 엔드포인트는 배포판에서 비활성(410)', async () => {
  // README 의 핵심 약속 — 계좌·거래·스냅샷은 서버로 가지 않는다.
  for (const p of ['/api/accounts', '/api/transactions', '/api/snapshot', '/api/snapshots']) {
    const r = await get(p);
    assert.equal(r.status, 410, `${p} 가 ${r.status} — 서버 저장 경로가 되살아났는지 확인할 것`);
  }
});

// ── 시세 API 계약 ───────────────────────────────────────────
test('/api/quotes 는 GET 을 거부한다', async () => {
  assert.equal((await get('/api/quotes')).status, 405);
});

test('/api/quotes 응답 형태 + 못 구한 티커를 알려 준다', async () => {
  const r = await postJson('/api/quotes', {
    tickers: [
      { ticker: '005930', type: 'stock_kr' },
      { ticker: '존재할리없는티커', type: 'stock_kr' },
      { ticker: '../../etc/passwd', type: 'stock_us' },
    ],
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(typeof j.quotes, 'object');
  assert.ok(Array.isArray(j.missing), 'missing 배열이 없다 — 못 구한 티커가 다시 침묵하고 있다');
  const bad = j.missing.find((m) => m.ticker === '../../etc/passwd');
  assert.ok(bad, '형식이 틀린 티커가 missing 에 없다');
  assert.equal(bad.reason, 'invalid-format');
});

test('/api/quotes 는 과도한 티커 수를 막는다', async () => {
  const tickers = Array.from({ length: 500 }, (_, i) => ({ ticker: `A${i}`, type: 'stock_us' }));
  const r = await postJson('/api/quotes', { tickers });
  assert.equal(r.status, 400);
});

test('/api/quotes 는 깨진 JSON 에 400 을 준다', async () => {
  const r = await fetch(`${BASE}/api/quotes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{ not json',
  });
  assert.equal(r.status, 400);
});

// ── 읽기 전용 공개 API ──────────────────────────────────────
test('공개 조회 API 가 ok 형태로 응답한다', async () => {
  for (const p of ['/api/events', '/api/market-calendar', '/api/config-status', '/api/notices']) {
    const r = await get(p);
    assert.equal(r.status, 200, `${p} 가 ${r.status}`);
    const j = await r.json();
    assert.equal(typeof j, 'object', `${p} 가 JSON 이 아니다`);
  }
});

// ── 발송 계열은 인증 없이 뚫리면 안 된다 ────────────────────
test('발송 엔드포인트는 무인증 요청을 거부한다', async () => {
  // ⚠️ 이 테스트는 절대로 실제 발송을 유발하면 안 된다.
  //    /api/broadcast 는 공개 채널로 나가므로 **무인증 거부만** 확인한다(라운드 25 실발송 사고).
  const r = await postJson('/api/broadcast', {});
  assert.ok([401, 403, 503].includes(r.status), `/api/broadcast 가 ${r.status} — 무인증으로 통과하면 안 된다`);
});

test('/api/news-push-now 는 POST 를 받지 않는다', async () => {
  // ⚠️ 예전에는 이 검사가 위 루프에 섞여 있었고 통과 목록에 405 가 들어 있었다.
  //    이 엔드포인트는 **GET 전용**이라 POST 는 인증과 무관하게 무조건 405 다 —
  //    즉 그 단언은 인증에 대해 **아무것도 지키지 않으면서** 통과하고 있었다.
  //    진짜 인증 검사는 아래 GET 테스트가 한다.
  assert.equal((await postJson('/api/news-push-now', {})).status, 405);
});

test('수동 뉴스 발송은 인증 없이는 절대 발송되지 않는다', async () => {
  // ⚠️ scheduled=1 경로는 **실제 발송**으로 이어지므로 여기서 부르지 않는다.
  //    인증이 붙지 않은 수동 경로만 확인한다 — 예전에는 30초 쿨다운만 있어서
  //    URL 을 아는 사람이 공개 채널로 하루 2,880번까지 발송을 시킬 수 있었다.
  const r = await get('/api/news-push-now');
  assert.notEqual(r.status, 200, '무인증 수동 발송이 통과했다 — 채널 스팸 경로가 열려 있다');
  assert.ok([401, 403, 503].includes(r.status), `예상 밖 상태코드 ${r.status}`);
});

test('scheduled=1 의 시크릿 검사는 fail-closed 다 (소스 단언)', async () => {
  // 예전에는 `if (NEWS_CRON_SECRET && !cronSecretOk(...))` 라 **시크릿이 비면 조건이
  // 거짓이 되어 검사가 통째로 사라졌다.** 프로덕션이 실제로 그 상태였다
  // (2026-09-24 · `/api/config-status` 가 `secretRequired:false`).
  //
  // 🔴 **HTTP 로는 이걸 증명할 수 없다.** 테스트 서버에는 NEWS_BOT_TOKEN 이 없어서
  //    핸들러 맨 앞의 `no-token` 503 이 먼저 반환된다 — fail-open 으로 되돌려도
  //    응답은 똑같이 503 이라 **테스트가 거짓으로 통과한다**(실제로 그렇게 짰다가
  //    되돌려 보기에서 걸렸다). 토큰을 넣고 부르면 이번엔 진짜 발송 위험이 생긴다.
  //    그래서 소스를 직접 본다 — 이 저장소가 ratelimit.test.mjs 에서 쓰는 방식이다.
  const src = readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  const guard = src.indexOf('if (!NEWS_CRON_SECRET)');
  assert.notEqual(guard, -1, 'fail-closed 가드(`if (!NEWS_CRON_SECRET)`)가 사라졌다');

  // ⚠️ `cronSecretOk(req, url)` 로 찾으면 **함수 정의**(파일 앞쪽)가 먼저 잡혀서
  //    정상 코드인데도 "순서가 뒤집혔다"로 실패한다. 호출부 형태로 정확히 찾는다.
  const check = src.indexOf('if (!cronSecretOk(req, url))');
  assert.notEqual(check, -1, 'cronSecretOk 호출부를 찾지 못했다 (형태가 바뀌었는지 확인)');
  assert.ok(guard < check, '가드가 cronSecretOk 검사보다 뒤에 있다 — 순서가 뒤집혔다');

  // 가드가 발송보다 앞에 있어야 한다. 뒤로 가면 시크릿 없이도 발송에 닿는다.
  const send = src.indexOf("sendDailyNews('scheduled-http')");
  assert.notEqual(send, -1, "sendDailyNews('scheduled-http') 호출을 찾지 못했다");
  assert.ok(guard < send, '시크릿 가드가 발송 호출보다 뒤에 있다 — 무인증 발송 경로다');

  // 옛 fail-open 형태가 되살아나지 않았는지.
  // ⚠️ **주석을 먼저 걷어내고 본다.** server.js 의 주석이 옛 형태를 그대로 인용하고
  //    있어서(재발 방지 설명), 원본에 그냥 정규식을 걸면 **주석에 걸려 정상 코드가
  //    실패한다**. 설명을 지우는 게 아니라 검사 쪽을 정확하게 만드는 게 맞다.
  const codeOnly = src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.ok(
    !/if \(NEWS_CRON_SECRET && !cronSecretOk/.test(codeOnly),
    '옛 fail-open 형태(`if (NEWS_CRON_SECRET && !cronSecretOk`)가 되살아났다',
  );
});

// ── 동기화 ─────────────────────────────────────────────────
test('/api/sync/status 는 항상 형태를 지킨다', async () => {
  const r = await get('/api/sync/status');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(typeof j.enabled, 'boolean');
});

test('sync push/pull 은 자격증명 없이 401', async () => {
  for (const p of ['/api/sync/push', '/api/sync/pull']) {
    const r = await postJson(p, {});
    assert.ok(r.status === 401 || r.status === 503, `${p} 가 ${r.status}`);
  }
});

// ── PWA (홈 화면 설치) ──────────────────────────────────────
// 화이트리스트 방식이라 자산을 추가해도 server.js 의 PUBLIC_FILES 에 등록하지 않으면
// 조용히 404 가 난다. 브라우저는 에러를 띄우지 않고 "설치"만 안 되므로 사람이 못 알아챈다.
test('PWA 자산이 전부 서빙된다 (화이트리스트 등록 누락 방지)', async () => {
  const assets = [
    ['/manifest.webmanifest', 'application/manifest+json'],
    ['/sw.js', 'text/javascript'],
    ['/icons/icon-192.png', 'image/png'],
    ['/icons/icon-512.png', 'image/png'],
    ['/icons/icon-maskable-512.png', 'image/png'],
    ['/icons/apple-touch-icon.png', 'image/png'],
  ];
  for (const [p, mime] of assets) {
    const r = await get(p);
    assert.equal(r.status, 200, `${p} 가 ${r.status} — PUBLIC_FILES 에 등록됐는지 확인`);
    assert.ok((r.headers.get('content-type') || '').startsWith(mime), `${p} 의 Content-Type 이 ${r.headers.get('content-type')}`);
  }
});

test('manifest 가 설치 가능한 형태다 (maskable 아이콘 포함)', async () => {
  const r = await get('/manifest.webmanifest');
  const j = await r.json();
  assert.equal(j.display, 'standalone', '전체화면으로 안 뜨면 앱처럼 보이지 않는다');
  assert.equal(j.start_url, '/');
  assert.ok(j.icons.some((i) => i.sizes === '192x192'), '192 아이콘이 있어야 설치 배너가 뜬다');
  assert.ok(j.icons.some((i) => i.sizes === '512x512'), '512 아이콘 필요');
  // maskable 이 없으면 안드로이드에서 흰 사각형 안에 아이콘이 박혀 나온다
  assert.ok(j.icons.some((i) => i.purpose === 'maskable'), 'maskable 아이콘이 빠졌다');
});

test('서비스 워커가 시세 API 를 캐시하지 않는다', async () => {
  const r = await get('/sw.js');
  const src = await r.text();
  // 🔴 낡은 가격을 보여 주는 자산 앱은 고장난 것보다 나쁘다 — 틀린 줄 모르고 판단하게 된다.
  assert.match(src, /pathname\.startsWith\('\/api\/'\)/, 'API 우회 분기가 사라졌다');
  assert.doesNotMatch(src, /cache\.put\(req[\s\S]{0,40}\/api\//, 'API 응답을 캐시하고 있다');
});
