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
  const NEWS_TRIGGER_GRACE_MIN = 420;
  ${extractFn('prevDate')}
  ${extractFn('triggerSlot')}
  return triggerSlot;
`)();

const DAY = '2026-09-12';
const at = (hour, minute, date = DAY) => triggerSlot({ hour, minute, date });

test('🔴 유예가 GitHub Actions 의 **실측** 지연을 덮는다', () => {
  // 🔴 이 숫자들은 추측이 아니라 `gh run list` 로 본 실제 실행 시각이다(20회).
  //    인계 문서의 "100~150분"을 믿고 240분으로 잡았다가, 실측하니
  //    **최소 209 · 평균 267 · 최대 356분**이었다. 240 이면 트리거가 전부 창 밖으로
  //    떨어져 일일 뉴스가 조용히 끊긴다 — 응답이 200 이라 GHA 는 계속 초록불이다.
  assert.deepEqual(at(9, 30).slot, { hour: 9, minute: 30 }, '정시 트리거가 거부됐다');

  // 아침 slot 실측 도착 구간 (KST 13:50~14:04 = 260~274분)
  assert.deepEqual(at(13, 50).slot, { hour: 9, minute: 30 }, '실측 지연 260분이 거부됐다');
  assert.deepEqual(at(14, 4).slot, { hour: 9, minute: 30 }, '실측 지연 274분이 거부됐다');

  // 저녁 slot 실측 도착 구간 (KST 21:29~23:56 = 209~356분)
  assert.deepEqual(at(21, 29).slot, { hour: 18, minute: 0 }, '실측 최소 지연 209분이 거부됐다');
  assert.deepEqual(at(23, 56).slot, { hour: 18, minute: 0 }, '실측 최대 지연 356분이 거부됐다');
});

test('🔴 자정을 넘겨 도착해도 전날 slot 으로 받는다', () => {
  // 실측 최대가 23:56(356분)이었다 — 자정까지 4분 남았다. 즉 실제로 일어날 수 있다.
  // 날짜만 보고 버리면 그날 저녁 뉴스가 조용히 사라진다.
  const r = at(0, 30, '2026-09-13');
  assert.deepEqual(r.slot, { hour: 18, minute: 0 }, '자정 넘긴 트리거를 버렸다 — 저녁 뉴스가 사라진다');
  assert.equal(r.date, '2026-09-12', '키 날짜가 오늘이면 어제분이 오늘 키를 먹는다');
});

test('엉뚱한 시간대에는 발송하지 않는다 — adhoc 경로는 없앴다', () => {
  // 유예(420분) 밖. 03:00 은 전날 18:00 에서 540분이라 여기서 걸러진다.
  for (const [h, m] of [[3, 0], [6, 0], [8, 0], [9, 29]]) {
    assert.equal(at(h, m), null, `${h}:${m} 에 발송이 허용된다`);
  }
});

test('지연된 트리거는 **가장 최근** slot 으로 묶인다', () => {
  // 저녁 트리거(22:25)가 아침 slot 으로 잡히면 저녁분이 아침 키를 먹어
  // 그날 저녁 뉴스가 통째로 사라진다.
  assert.deepEqual(at(22, 25).slot, { hour: 18, minute: 0 });
  assert.deepEqual(at(15, 0).slot, { hour: 9, minute: 30 });
});

test('하루에 인정되는 slot 은 2개뿐이다 (예전엔 시간마다 새 키라 24개였다)', () => {
  // 상한을 지키는 것은 유예 창이 아니라 **slot 키**다. 창을 넓혀도 이 수는 안 변해야 한다.
  const byDate = new Map();
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 5) {
      const r = at(h, m);
      if (!r) continue;
      const set = byDate.get(r.date) ?? new Set();
      set.add(`${r.slot.hour}:${r.slot.minute}`);
      byDate.set(r.date, set);
    }
  }
  // 자정 직후에는 **전날** slot 을 받으므로 날짜가 둘 나올 수 있다.
  // 중요한 것은 "날짜마다 2개 이하"다 — 그래야 하루 2회가 유지된다.
  for (const [date, set] of byDate) {
    assert.ok(set.size <= 2, `${date} 에 slot 이 ${set.size}개 — 발송 상한이 늘어났다`);
  }
  assert.deepEqual([...(byDate.get(DAY) ?? [])].sort(), ['18:0', '9:30'],
    '그날 자체의 slot 두 개가 다 살아 있어야 한다');
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

// ── ⑥ 2026-09-22 감사에서 나온 것들 ──────────────────────────
//
// 이 절이 고정하는 것은 **"주석의 단언"이 아니라 실제 코드**다. 라운드 34 의
// `stock-detail` 주석은 "이 파일의 다른 외부 호출 엔드포인트에는 다 붙어 있다"라고
// 적혀 있었는데 사실이 아니었고(그 한 곳만 고쳐져 있었다), 그 문장이 다음 점검을
// 통과시키는 근거가 됐다. 그래서 목록을 테스트로 옮긴다.

const APP_SRC = readFileSync(path.join(ROOT, 'app.js'), 'utf8');

/** server.js 에서 `async function 이름(` 부터 다음 최상위 함수 전까지 잘라낸다. */
function extractHandler(name) {
  const start = SERVER_SRC.indexOf(`async function ${name}(`);
  assert.ok(start > 0, `server.js 에서 ${name} 을 찾지 못했다 (이름이 바뀌었는지 확인)`);
  const next = SERVER_SRC.indexOf('\nasync function ', start + 1);
  return SERVER_SRC.slice(start, next > 0 ? next : undefined);
}

test('🔴 외부를 부르는 조회 엔드포인트에는 전부 속도 제한이 있다', () => {
  // 전부 인증이 없고, 한 요청이 외부 API 호출 1~400건이 된다. 두들겨 맞으면
  // 아웃바운드 IP 가 차단되어 **검색·뉴스·급등락까지 같이 죽는다**(같은 IP 를 쓴다).
  const handlers = [
    'handleQuotes',        // 티커 200개 × 소스별 1~2회 = 최대 400건
    'handleHistory',       // 캐시가 없어 매 호출이 곧 야후·업비트 호출
    'handleStockSearch',   // 캐시 키가 `__search:{q}` — 검색어를 바꾸면 캐시 우회
    'handleStockNews',     // 캐시 키가 `__news:{q}` — 같은 우회 경로
    'handleStockDetail',   // 라운드 34 에 이 한 곳만 고쳐졌다
    'handlePensionFlows',  // 회사마다 majorstock 1회 + DART 일일 1만 호출 한도
    'handleNpsPortfolio',  // 요청마다 운영자 서비스키로 data.go.kr 호출
  ];
  const missing = handlers.filter((name) => !/rateLimited\(/.test(extractHandler(name)));
  assert.deepEqual(missing, [],
    `속도 제한이 빠진 핸들러: ${missing.join(', ')} — 무인증으로 외부 쿼터를 태울 수 있다`);
});

test('속도 제한 한도가 정상 사용 여유를 남긴다', () => {
  // 화면은 15초마다 /api/quotes 를 부른다(= 분당 4회). 한도가 그보다 넉넉해야
  // 정상 사용자가 차단되지 않는다. 남용 차단과 정상 사용은 이 여유로 갈린다.
  const m = /rateLimited\('quotes',\s*clientIp\(req\),\s*(\d+)\)/.exec(SERVER_SRC);
  assert.ok(m, "quotes 의 rateLimited 호출을 찾지 못했다");
  assert.ok(Number(m[1]) >= 20, `quotes 한도가 ${m[1]}/분 — 화면 폴링(4/분)의 여유가 부족하다`);
});

test('🔴 pension-flows 의 source 는 화이트리스트다', () => {
  // 임의 문자열이 통과하면 `!== 'goinsider'` 와 `!== 'dart'` 가 **둘 다 참**이어서
  // DART 파이프라인과 goinsider 폴백이 매번 함께 돌고, 그 값이 캐시 키에 들어가
  // `?source=a1`, `?source=a2` … 로 24시간 캐시를 100% 우회할 수 있었다.
  const body = extractHandler('handlePensionFlows');
  assert.match(body, /PENSION_SOURCES\s*=\s*\[/, 'source 화이트리스트가 사라졌다');
  assert.match(body, /PENSION_SOURCES\.includes\(/, '화이트리스트를 검사하지 않는다');
});

test('nps-portfolio 의 uddi 는 형식을 검사한다', () => {
  // uddi 는 data.go.kr **URL 경로에 그대로** 들어간다. 검증이 없으면 캐시 키가 무한히
  // 늘고 요청마다 운영자 키로 호출이 나간다(키 형식별 최대 3회 재시도).
  const body = extractHandler('handleNpsPortfolio');
  assert.match(body, /\^uddi:\[0-9a-f\]\{8\}/, 'uddi 형식 검사가 사라졌다');
});

test('🔴 텔레그램 HTML escape 가 따옴표까지 덮는다', () => {
  // 결과가 `<a href="...">` **속성값**으로 들어간다. `"` 를 안 막으면 외부 뉴스 URL
  // 하나 때문에 태그가 깨져 sendMessage 가 실패하고, **그 회차 일일 뉴스가 통째로
  // 안 나간다**(로그에만 남고, 캐시 TTL 동안 재시도도 같은 이유로 실패한다).
  const fn = new Function(`${extractFn('tgEscapeHtml')} return tgEscapeHtml;`)();
  assert.equal(fn('a"b'), 'a&quot;b', '따옴표가 escape 되지 않는다 — href 속성이 깨진다');
  assert.equal(fn('<&>'), '&lt;&amp;&gt;');
  // 실제 사용 자리가 속성값이라는 것도 고정한다(텍스트 노드로 바뀌면 이 검사의 의미가 달라진다).
  assert.match(SERVER_SRC, /href="\$\{tgEscapeHtml\(/, 'href 에 escape 를 통과하지 않은 값이 들어간다');
});

test('history 의 500 응답이 내부 에러 메시지를 노출하지 않는다', () => {
  const body = extractHandler('handleHistory');
  assert.ok(!/reply\(res,\s*500,\s*\{\s*ok:\s*false,\s*error:\s*e\.message\s*\}\)/.test(body),
    'e.message 를 그대로 내보낸다 — 내부 경로가 노출된다(전역 catch 는 로그로만 보낸다)');
});

// ── 동기화 첫 복원 — 데이터 유실 방지 ────────────────────────
test('🔴 첫 페어링은 물어보기 **전에** 로컬을 덮어쓰지 않는다', () => {
  // 예전에는 `syncPullNow()` 가 복원까지 해 버린 뒤에 "덮어쓸까요?"를 물었다. 그래서
  //  ① 프롬프트의 "로컬 데이터: N건" 이 사실은 **원격 백업의 건수**였고
  //  ② "취소"를 누르면 그 덮어써진 데이터를 다시 백업해 **원래 장부를 되돌릴 수 없었다.**
  const start = APP_SRC.indexOf('async function tryFirstSyncAction');
  assert.ok(start > 0, 'tryFirstSyncAction 을 찾지 못했다');
  const next = APP_SRC.indexOf('\nasync function ', start + 1);
  const body = APP_SRC.slice(start, next > 0 ? next : undefined);

  assert.match(body, /syncPullNow\(\{\s*apply:\s*false\s*\}\)/,
    '받아오기가 복원까지 해 버린다 — 물어보기 전에 로컬이 사라진다');

  // 로컬 건수를 pull 보다 **먼저** 세는지 — 순서가 이 버그의 핵심이었다.
  const iCount = body.indexOf('const localCount');
  const iPull = body.indexOf('syncPullNow(');
  assert.ok(iCount > 0 && iPull > 0, '로컬 건수 계산 또는 pull 호출을 찾지 못했다');
  assert.ok(iCount < iPull,
    '로컬 건수를 pull 뒤에 센다 — 그 숫자는 원격 데이터의 건수가 된다');

  // 확인을 받은 뒤에 실제로 복원하는지.
  assert.match(body, /restoreFromSyncPayload\(result\.payload\)/,
    '확인 후 복원하는 호출이 없다 — 복원이 아예 안 된다');
});

test('syncPullNow 의 기본값은 복원까지 한다 (기존 호출부가 깨지지 않는다)', () => {
  // 수동 「복원」 버튼은 인자 없이 부른다. 기본값이 false 로 바뀌면 그 버튼이 조용히 죽는다.
  assert.match(APP_SRC, /async function syncPullNow\(\{\s*apply\s*=\s*true\s*\}\s*=\s*\{\}\)/,
    'syncPullNow 의 apply 기본값이 true 가 아니다 — 수동 복원 버튼이 아무 일도 하지 않게 된다');
});

test('🔴 연동 해제가 서버 응답을 확인한다', () => {
  // 서버는 폐기 기록에 실패하면 일부러 502 를 준다("끊었다고 믿는데 cred 는 살아 있다").
  // 예전 클라이언트는 그 응답을 통째로 버려서 라운드 32 의 폐기 기능이 무력화됐다.
  const start = APP_SRC.indexOf('async function syncDisconnectNow');
  assert.ok(start > 0, 'syncDisconnectNow 를 찾지 못했다');
  const next = APP_SRC.indexOf('\nasync function ', start + 1);
  const body = APP_SRC.slice(start, next > 0 ? next : undefined);

  assert.match(body, /const r = await fetch\(/, '응답을 변수로 받지 않는다 — 결과를 볼 수 없다');
  assert.match(body, /!r\.ok/, '응답 상태를 검사하지 않는다 — 502 가 성공으로 처리된다');
  assert.match(body, /return \{ revoked, error \}/, '폐기 실패를 호출부에 알리지 않는다');

  // 호출부가 그 결과로 사용자에게 알리는지.
  assert.match(APP_SRC, /const \{ revoked, error \} = await syncDisconnectNow\(\)/,
    '호출부가 해제 결과를 받지 않는다');
  assert.match(APP_SRC, /if \(!revoked\)/, '폐기 실패를 사용자에게 알리지 않는다');
});
