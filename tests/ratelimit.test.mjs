// Seed · Liquid Ledger — 속도 제한 · 페어링 우회 회귀 테스트
//
// 2026-08-30 감사에서 나온 것들을 고정한다.
//
//  ① rate limit 이 X-Forwarded-For 위조로 뚫렸다.
//     예전 구현은 헤더의 **맨 앞** 값을 IP 로 썼는데, 이 헤더는 클라이언트가 직접 써서
//     보낼 수 있고 프록시는 앞쪽 값을 지우지 않는다. 요청마다 다른 값을 넣는 것만으로
//     IP 기반 제한이 통째로 사라졌다. 증권사 앱키·시크릿이 지나가는 엔드포인트였다.
//  ② /api/sync/* 와 /api/import-pdf 에는 제한이 아예 없었다.
//  ③ /api/sync/check 에 4자리 확인을 건너뛰고 cred 를 바로 내주는 분기가 남아 있었다.
//     6자리만 맞히면 계정이 넘어가는 경로라 제거했다.
//
// 이 파일은 자체 서버 인스턴스를 띄운다 — 동기화 경로를 켜려면 TELEGRAM_BOT_TOKEN 이
// 필요한데(SYNC_ENABLED), smoke 테스트는 토큰이 없는 상태를 검증하므로 섞으면 안 된다.
// 토큰은 형식만 맞는 가짜다. /api/sync/check 는 텔레그램을 부르지 않으므로 무해하다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
let child;
let serverLog = '';   // 띄운 서버가 찍은 것 — 스케줄러가 떴는지 여기서 본다

const get = (p, opts = {}) => fetch(`${BASE}${p}`, opts);

before(async () => {
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'test',
      // 형식만 맞는 가짜 토큰. getMe 는 실패하지만 SYNC_ENABLED 가 켜져 라우트가 살아난다.
      TELEGRAM_BOT_TOKEN: '123456789:TEST-ONLY-NOT-A-REAL-TOKEN-000000000',
      // 프록시가 없는 환경이므로 XFF 를 믿지 않는 것이 기본값이다. 명시해 의도를 고정한다.
      TRUSTED_PROXY_HOPS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { serverLog += c.toString('utf8'); });
  child.stderr.on('data', (c) => { serverLog += c.toString('utf8'); });
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

// 존재하지 않는 6자리를 조회한다. 텔레그램 호출이 없고 404(expired) 가 정상 응답이다.
const checkOnce = (headers = {}) => get('/api/sync/check?code=000000', { headers });

// ── ① XFF 위조로 제한을 우회할 수 없다 ──────────────────────
test('X-Forwarded-For 를 매 요청 바꿔도 속도 제한을 우회하지 못한다', async () => {
  let sawLimit = false;
  // 한도는 분당 40. 60회를 서로 다른 위조 IP 로 때린다 — 예전 구현이면 전부 통과했다.
  for (let i = 0; i < 60; i++) {
    const r = await checkOnce({ 'X-Forwarded-For': `203.0.113.${i % 254 + 1}` });
    if (r.status === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit, 'XFF 를 바꿔 가며 60회를 보냈는데 한 번도 429 가 나오지 않았다 — 제한이 우회된다');
});

test('429 응답은 Retry-After 헤더와 JSON 형태를 지킨다', async () => {
  // 앞 테스트에서 이미 한도를 넘겼으므로 다음 요청은 429 여야 한다.
  const r = await checkOnce();
  assert.equal(r.status, 429);
  const retryAfter = Number(r.headers.get('retry-after'));
  assert.ok(Number.isFinite(retryAfter) && retryAfter > 0, `Retry-After 가 ${r.headers.get('retry-after')}`);
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.ok(typeof j.retryAfterSec === 'number' && j.retryAfterSec > 0);
});

// ── ② 제한이 실제로 걸린다 (정상 사용 여유 포함) ─────────────
test('클라이언트 폴링 주기(2.5초)로는 한도에 닿지 않는다', () => {
  // app.js 의 pairCheckTimer 가 2500ms 간격 = 분당 24회. 한도 40 은 그보다 커야 한다.
  const app = readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const m = /pairCheckTimer\s*=\s*setInterval\([\s\S]*?\},\s*(\d+)\);/.exec(app);
  assert.ok(m, 'app.js 에서 페어링 폴링 주기를 찾지 못했다 — 한도 계산의 근거가 사라졌다');
  const perMinute = 60_000 / Number(m[1]);
  assert.ok(perMinute < 40, `폴링이 분당 ${perMinute}회라 한도 40 에 닿는다 — 정상 사용이 차단된다`);
});

// ── ③ 확인 코드를 건너뛰는 경로가 없다 ──────────────────────
test('/api/sync/check 는 어떤 경우에도 cred 를 발급하지 않는다', () => {
  // HTTP 로는 내부 상태(chatId 만 있고 confirmCode 가 없는 페어)를 만들 수 없어 소스로 검사한다.
  // 이 함수 안에서 signCred 를 부르는 순간 4자리 확인을 건너뛰는 경로가 생긴다.
  const src = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const start = src.indexOf('async function handleSyncCheck');
  assert.ok(start > 0, 'handleSyncCheck 를 찾지 못했다');
  const next = src.indexOf('\nasync function ', start + 1);
  const body = src.slice(start, next > 0 ? next : undefined);
  assert.ok(!/signCred\s*\(/.test(body),
    'handleSyncCheck 안에서 signCred 를 부른다 — 4자리 확인을 건너뛰고 cred 가 나가는 경로다');
});

test('cred 발급은 확인 코드를 검사하는 handleSyncConfirm 에서만 일어난다', () => {
  const src = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  // 정의부(function signCred)를 뺀 호출 지점을 센다.
  const calls = [...src.matchAll(/signCred\s*\(/g)]
    .filter((m) => !/function\s+signCred\s*\($/.test(src.slice(0, m.index + m[0].length)));
  assert.equal(calls.length, 1, `signCred 호출이 ${calls.length}곳이다 — 발급 경로는 하나여야 한다`);
  const idx = calls[0].index;
  const fnStart = src.lastIndexOf('async function ', idx);
  const fnName = /async function (\w+)/.exec(src.slice(fnStart))[1];
  assert.equal(fnName, 'handleSyncConfirm', `cred 가 ${fnName} 에서 발급된다`);
});

// ── ④ 무거운 엔드포인트의 본문 상한 ─────────────────────────
test('PDF 업로드 상한이 기본값(20MB)보다 낮게 묶여 있다', () => {
  const src = readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const m = /const PDF_MAX_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(src);
  assert.ok(m, 'PDF_MAX_BYTES 상수를 찾지 못했다');
  assert.ok(Number(m[1]) <= 10, `PDF 상한이 ${m[1]}MB — 인증 없는 CPU 소모 경로라 10MB 이하로 유지할 것`);
  assert.ok(/readBodyBytes\(req,\s*PDF_MAX_BYTES\)/.test(src),
    'handleImportPdf 가 상한을 넘기지 않고 readBodyBytes 를 부른다 — 기본 20MB 가 적용된다');
});

// ── ⑤ 2026-09-12 점검에서 나온 것들 ──────────────────────────
//
// 🔴 **이 파일에서 `/api/news-push-now?scheduled=1` 을 절대 부르지 말 것.**
//    .env 에 진짜 뉴스 봇 토큰·채팅ID 가 있으면 그 호출은 **공개 채널로 실제 발송**된다.
//    아래는 전부 순수 로직 추출 + 소스 검사 + 인증 거부만 본다.

const SERVER_SRC = readFileSync(path.join(ROOT, 'server.js'), 'utf8');

/** server.js 에서 `function 이름(` 부터 짝이 맞는 닫는 중괄호까지 잘라낸다(logic.test.mjs 와 같은 방식). */
function extractFn(name) {
  const start = SERVER_SRC.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `server.js 에서 ${name} 을 찾지 못했다 (이름이 바뀌었는지 확인)`);
  let depth = 0, i = SERVER_SRC.indexOf('{', start);
  for (; i < SERVER_SRC.length; i++) {
    if (SERVER_SRC[i] === '{') depth++;
    else if (SERVER_SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  return SERVER_SRC.slice(start, i + 1);
}

test('🔴 테스트에서는 뉴스 발송 스케줄러가 뜨지 않는다', () => {
  // 이 테스트의 서버는 .env 를 읽으므로 진짜 뉴스 토큰·채팅ID 를 갖고 뜬다.
  // 예전 코드는 그 상태에서 setInterval 을 걸었고, KST 09:30~09:34 / 18:00~18:04 에
  // `npm test` 를 돌리는 것만으로 **공개 채널에 진짜 뉴스가 나갔다.**
  assert.ok(!/newspush\.enabled/.test(serverLog),
    '테스트 서버가 발송 스케줄러를 띄웠다 — npm test 가 실제 발송을 일으킬 수 있다');
  assert.match(SERVER_SRC, /NODE_ENV\s*!==\s*'test'/, '스케줄러의 테스트 가드가 사라졌다');
});

// 유예 창 — 순수 함수라 시계를 건드리지 않고 검사할 수 있다.
const triggerSlot = new Function(`
  const NEWS_PUSH_SLOTS_KST = [{ hour: 9, minute: 30 }, { hour: 18, minute: 0 }];
  const NEWS_TRIGGER_GRACE_MIN = 240;
  ${extractFn('triggerSlot')}
  return triggerSlot;
`)();

test('🔴 외부 트리거 유예가 GitHub Actions 지연(100~150분)을 덮는다', () => {
  const at = (hour, minute) => triggerSlot({ hour, minute });
  assert.deepEqual(at(9, 30), { hour: 9, minute: 30 }, '정시 트리거가 거부됐다');
  // 🔴 이 저장소에서 반복 실측된 사실이다. 유예를 조이면 일일 뉴스가 통째로 끊긴다.
  assert.ok(at(11, 10), 'GHA 100분 지연이 거부됐다 — 뉴스가 끊긴다');
  assert.ok(at(12, 0), 'GHA 150분 지연이 거부됐다 — 뉴스가 끊긴다');
  assert.deepEqual(at(19, 40), { hour: 18, minute: 0 });
});

test('엉뚱한 시간대에는 발송하지 않는다 — adhoc 경로는 없앴다', () => {
  for (const [h, m] of [[3, 0], [15, 0], [23, 59], [8, 0]]) {
    assert.equal(triggerSlot({ hour: h, minute: m }), null, `${h}:${m} 에 발송이 허용된다`);
  }
});

test('하루에 인정되는 slot 은 2개뿐이다 (예전엔 시간마다 새 키라 24개였다)', () => {
  const keys = new Set();
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 5) {
      const s = triggerSlot({ hour: h, minute: m });
      if (s) keys.add(`${s.hour}:${s.minute}`);
    }
  }
  assert.equal(keys.size, 2, `하루 slot 이 ${keys.size}개 — 발송 상한이 늘어났다`);
});

// cred — 서명·만료. 폐기는 저장소를 읽어야 해서 여기서는 형식만 본다.
const cred = new Function('crypto', `
  const SYNC_SECRET = 'test-secret-for-cred-checks';
  const CRED_VERSION = 'v2';
  const CRED_TTL_MS = 180 * 24 * 60 * 60 * 1000;
  ${extractFn('credSig')}
  ${extractFn('signCred')}
  ${extractFn('verifyCred')}
  return { signCred, verifyCred };
`)(crypto);

test('🔴 cred 에 만료가 있고, 무기한이던 v1 형식은 거부한다', () => {
  const good = cred.signCred('12345');
  assert.equal(cred.verifyCred(good).chatId, '12345');

  // v1 은 `<chatId>:<서명>` — 발급시각도 버전도 없어 한 번 새면 영구 유효였다
  assert.equal(cred.verifyCred(`12345:${'a'.repeat(32)}`), null, 'v1 cred 가 아직 통과한다');

  const expired = cred.signCred('12345', Date.now() - 181 * 24 * 60 * 60 * 1000);
  assert.equal(cred.verifyCred(expired), null, '만료된 cred 가 통과한다');
});

test('서명이 발급시각까지 덮는다 — 시각만 바꿔치기하면 안 통한다', () => {
  // 서명이 chatId 만 덮으면, 만료를 붙여도 공격자가 시각을 최신으로 바꿔 영구 연장할 수 있다.
  const good = cred.signCred('12345', Date.now() - 200 * 24 * 60 * 60 * 1000);
  const sig = good.split(':')[3];
  assert.equal(cred.verifyCred(`v2:12345:${Date.now()}:${sig}`), null,
    '발급시각을 바꿔치기한 cred 가 통과한다 — 만료가 무력화된다');
  assert.equal(cred.verifyCred(`v2:12345:${Date.now()}:${'b'.repeat(32)}`), null);
});

test('v1 cred 로는 동기화가 안 된다 (401 → 앱이 cred 를 지우고 재페어링한다)', async () => {
  const r = await fetch(`${BASE}/api/sync/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer 12345:${'a'.repeat(32)}` },
    body: '{}',
  });
  assert.equal(r.status, 401);
});

test('해제(disconnect)가 서버에 폐기를 기록한다', () => {
  // 예전에는 "클라이언트가 cred 를 지우는 것"이 전부라, 이미 새어 나간 cred 는 그대로 살아 있었다.
  const start = SERVER_SRC.indexOf('async function handleSyncDisconnect');
  assert.ok(start > 0, 'handleSyncDisconnect 를 찾지 못했다');
  const next = SERVER_SRC.indexOf('\nasync function ', start + 1);
  const body = SERVER_SRC.slice(start, next > 0 ? next : undefined);
  assert.match(body, /revokeCredsFor\(/, '해제가 폐기를 기록하지 않는다 — 새어 나간 cred 가 계속 먹힌다');
});
