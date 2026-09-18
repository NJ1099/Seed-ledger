// app.js 안의 순수 로직 테스트.
//
// app.js 는 통짜 IIFE(8,000줄)라 import 할 수 있는 export 가 없다. 리팩터링은 위험이 크므로,
// 여기서는 **소스에서 해당 함수만 잘라내 평가**한다. 함수 시그니처가 바뀌면 이 테스트가 먼저 깨진다.
// (장기적으로는 계산 로직을 별도 모듈로 빼는 것이 맞다 — HANDOFF 백로그 참조.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SRC = readFileSync(path.join(ROOT, 'app.js'), 'utf8');

/** app.js 에서 `function 이름(` 부터 짝이 맞는 닫는 중괄호까지 잘라낸다. */
function extractFn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `app.js 에서 ${name} 을 찾지 못했다 (이름이 바뀌었는지 확인)`);
  let depth = 0, i = SRC.indexOf('{', start);
  const open = i;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  return SRC.slice(start, i + 1);
}

const loadFn = (name, deps = '') =>
  new Function(`${deps}\n${extractFn(name)}\nreturn ${name};`)();

// ── pruneSnapshots ─────────────────────────────────────────
const pruneSnapshots = loadFn('pruneSnapshots', 'const SNAPSHOT_DAILY_DAYS = 365;');

const ymd = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => ymd(new Date(Date.now() - n * 86400000));

test('최근 1년 스냅샷은 하나도 지우지 않는다', () => {
  const map = {};
  for (let i = 0; i < 360; i += 1) map[daysAgo(i)] = { date: daysAgo(i), totalKRW: 100 };
  const before = Object.keys(map).length;
  const removed = pruneSnapshots(map);
  assert.equal(removed, 0);
  assert.equal(Object.keys(map).length, before);
});

test('1년이 지난 구간은 달마다 한 건만 남긴다', () => {
  const map = {};
  // 400~800일 전까지 매일 기록 → 전부 1년 초과 구간
  for (let i = 400; i < 800; i += 1) map[daysAgo(i)] = { date: daysAgo(i), totalKRW: i };
  const total = Object.keys(map).length;
  const removed = pruneSnapshots(map);
  const left = Object.keys(map);

  assert.ok(removed > 0, '오래된 구간이 전혀 압축되지 않았다');
  assert.equal(total, removed + left.length, '지운 개수와 남은 개수의 합이 안 맞는다');

  const months = left.map((k) => k.slice(0, 7));
  assert.equal(new Set(months).size, months.length, '같은 달에 두 건 이상 남았다');
});

test('압축 뒤에도 각 달의 마지막 기록이 남는다', () => {
  const map = {
    '2020-03-01': { date: '2020-03-01', totalKRW: 1 },
    '2020-03-15': { date: '2020-03-15', totalKRW: 2 },
    '2020-03-31': { date: '2020-03-31', totalKRW: 3 },
    '2020-04-02': { date: '2020-04-02', totalKRW: 4 },
  };
  pruneSnapshots(map);
  assert.deepEqual(Object.keys(map).sort(), ['2020-03-31', '2020-04-02']);
  assert.equal(map['2020-03-31'].totalKRW, 3);
});

test('날짜 형식이 아닌 키는 건드리지 않는다', () => {
  const map = { 'not-a-date': { x: 1 }, '2019-01-01': { date: '2019-01-01' }, '2019-01-02': { date: '2019-01-02' } };
  pruneSnapshots(map);
  assert.ok('not-a-date' in map, '알 수 없는 키를 지워 버렸다');
});

test('빈 맵에도 안전하다', () => {
  const map = {};
  assert.equal(pruneSnapshots(map), 0);
});

// ── safeMergeObj — 프로토타입 오염 방어 ────────────────────
const safeMergeObj = loadFn('safeMergeObj');

test('safeMergeObj 는 프로토타입 오염을 막는다', () => {
  const out = safeMergeObj({}, JSON.parse('{"__proto__":{"polluted":true},"ok":1}'));
  assert.equal(out.ok, 1);
  assert.equal({}.polluted, undefined, '프로토타입이 오염됐다');
});

// ── 예수금(cashKRW) 삭제 회귀 ────────────────────────────────────────
// 라운드 22 가 "새 결과에 예수금이 없으면 옛 값을 지운다"고 고쳤다고 적어 뒀지만,
// 실제로는 동작하지 않았다 — `delete upd.cashKRW` 를 보내도 저장 쪽 safeMergeObj 가
// **합집합 병합**이라 patch 에 없는 키를 건드리지 않기 때문이다.
// 그래서 옛 예수금이 영원히 남고 **자산 총액이 계속 부풀려졌다.** 사용자는 알 수 없다.
// 테스트가 없어서 4개 라운드 동안 아무도 몰랐다. 이제 소스에서 직접 검사한다.
//
// ⚠️ 주석을 먼저 걷어내고 검사한다. 위 설명에도 `delete upd.cashKRW` 라는 글자가 있어서
//    걷어내지 않으면 "아직 delete 를 쓰고 있다"고 잘못 걸린다.
const SRC_NO_COMMENTS = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('예수금: 계좌 갱신은 null 을 "삭제"로 처리한다', () => {
  const i = SRC_NO_COMMENTS.indexOf('data.accounts[i] = ');
  assert.notEqual(i, -1, '계좌 update 분기를 찾지 못했다');
  const around = SRC_NO_COMMENTS.slice(Math.max(0, i - 700), i + 200);
  assert.match(
    around,
    /=== null\)\s*delete/,
    '계좌 갱신에 null → 삭제 처리가 없다. 이게 없으면 예수금을 지워도 옛 값이 남아 자산이 부풀려진다',
  );
});

test('예수금: 재가져오기·재동기화는 delete 가 아니라 null 을 보낸다', () => {
  assert.doesNotMatch(
    SRC_NO_COMMENTS,
    /delete\s+\w+\.cashKRW/,
    'delete 로 보내면 합집합 병합에서 무시된다. `x.cashKRW = null` 로 보낼 것',
  );
  const nulls = SRC_NO_COMMENTS.match(/\.cashKRW\s*=\s*null/g) || [];
  assert.ok(
    nulls.length >= 2,
    `null 삭제 신호가 ${nulls.length}곳뿐이다 — PDF 재가져오기와 증권사 재동기화 두 곳 모두 필요하다`,
  );
});
