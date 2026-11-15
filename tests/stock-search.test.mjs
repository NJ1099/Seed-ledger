// 종목 검색 매처. 네트워크 없이 한글·영문·코드·초성·순위만 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  searchStocks,
  mergeSearchResults,
  normalizeSearchKey,
  normalizeTicker,
  chosungOf,
  isChosungQuery,
} = require('../stockSearch');

const UNIVERSE = [
  { code: '005930', name: '삼성전자', market: 'KOSPI', type: 'stock_kr' },
  { code: '005935', name: '삼성전자우', market: 'KOSPI', type: 'stock_kr' },
  { code: '009150', name: '삼성전기', market: 'KOSPI', type: 'stock_kr' },
  { code: '000660', name: 'SK하이닉스', market: 'KOSPI', type: 'stock_kr' },
  { code: '005380', name: '현대차', market: 'KOSPI', type: 'stock_kr' },
  { code: 'AAPL', name: '애플', market: 'NASDAQ', type: 'stock_us' },
  { code: 'NVDA', name: '엔비디아', market: 'NASDAQ', type: 'stock_us' },
  { code: 'BRK.B', name: '버크셔해서웨이', market: 'NYSE', type: 'stock_us' },
  { code: 'JPM', name: 'JP모건', market: 'NYSE', type: 'stock_us' },
  { code: 'SPY', name: 'SPDR S&P 500', market: 'NYSE', type: 'stock_us' },
  { code: 'TSLA', name: '테슬라', market: 'NASDAQ', type: 'stock_us' },
  { code: 'GOOGL', name: '알파벳', market: 'NASDAQ', type: 'stock_us' },
];

const codes = (q, list = UNIVERSE) => searchStocks(list, q, 10).map((s) => s.code);

test('한글 종목명 완전일치가 비슷한 이름보다 앞선다', () => {
  assert.equal(codes('삼성전자')[0], '005930');
  assert.ok(codes('삼성전자').includes('005935'));
  assert.ok(codes('삼성')[0] === '005930' || codes('삼성').includes('005930'));
});

test('국내 6자리 코드와 미국 티커를 대소문자 없이 찾는다', () => {
  assert.deepEqual(codes('005930'), ['005930']);
  assert.equal(codes('aapl')[0], 'AAPL');
  assert.equal(codes('Nvda')[0], 'NVDA');
});

test('공백과 문장부호를 무시한다', () => {
  assert.equal(codes('삼성 전자')[0], '005930');
  assert.equal(codes('sk 하이닉스')[0], '000660');
  assert.equal(normalizeSearchKey('BRK.B'), normalizeSearchKey('brk b'));
  assert.equal(normalizeSearchKey('S&P 500'), normalizeSearchKey('sp500'));
  assert.equal(codes('brk b')[0], 'BRK.B');
  assert.equal(codes('brkb')[0], 'BRK.B');
  assert.equal(codes('BRK-B')[0], 'BRK.B');
  assert.equal(codes('jp morgan')[0], 'JPM');
});

test('영문 별칭과 한글 별칭이 서로 찾힌다', () => {
  assert.equal(codes('Samsung')[0], '005930');
  assert.equal(codes('samsung electronics')[0], '005930');
  assert.equal(codes('Apple')[0], 'AAPL');
  assert.equal(codes('애플')[0], 'AAPL');
  assert.equal(codes('테슬라')[0], 'TSLA');
  assert.equal(codes('Tesla')[0], 'TSLA');
  assert.equal(codes('현대자동차')[0], '005380');
  assert.equal(codes('구글')[0], 'GOOGL');
  assert.equal(codes('google')[0], 'GOOGL');
});

test('초성 검색은 완전일치가 접두보다 앞선다', () => {
  assert.equal(chosungOf('삼성전자'), 'ㅅㅅㅈㅈ');
  assert.equal(isChosungQuery('ㅅㅅ ㅈㅈ'), true);
  assert.equal(isChosungQuery('삼성'), false);
  assert.equal(codes('ㅅㅅㅈㅈ')[0], '005930');
  assert.equal(codes('ㅅㅅ')[0], '005930');
  assert.ok(codes('ㅎㄷㅊ').includes('005380'));
  assert.equal(codes('ㅂㅋㅅ')[0], 'BRK.B');
});

test('부분 일치보다 접두 일치가 앞선다', () => {
  const list = [
    { code: '035420', name: '네이버웹툰', market: 'KOSPI', type: 'stock_kr' },
    { code: '053580', name: '웹케시', market: 'KOSDAQ', type: 'stock_kr' },
  ];
  const found = searchStocks(list, '웹', 10);
  assert.equal(found[0].code, '053580');
  assert.ok(found[0].score < found.find((s) => s.code === '035420').score);
});

test('빈 검색어와 기호만 있는 검색어는 결과가 없다', () => {
  assert.deepEqual(searchStocks(UNIVERSE, ''), []);
  assert.deepEqual(searchStocks(UNIVERSE, '   '), []);
  assert.deepEqual(searchStocks(UNIVERSE, '...'), []);
  assert.deepEqual(searchStocks(UNIVERSE, '없는종목xyz'), []);
});

test('목록 뒤쪽의 완전일치가 앞쪽 포함 일치에 밀리지 않는다', () => {
  const many = [];
  for (let i = 0; i < 80; i++) {
    many.push({ code: String(100000 + i), name: `전자부품${i}`, market: 'KOSPI', type: 'stock_kr' });
  }
  many.push({ code: '005930', name: '삼성전자', market: 'KOSPI', type: 'stock_kr' });
  assert.equal(searchStocks(many, '삼성전자', 5)[0].code, '005930');
  assert.equal(searchStocks(many, '005930', 5)[0].code, '005930');
});

test('전체 목록을 훑어도 느리지 않다', () => {
  const many = [];
  for (let i = 0; i < 8000; i++) {
    many.push({ code: `X${i}`, name: `종목${i}`, market: 'KOSPI', type: 'stock_kr' });
  }
  many.push({ code: '005930', name: '삼성전자', market: 'KOSPI', type: 'stock_kr' });
  const t0 = Date.now();
  const found = searchStocks(many, '삼성전자', 10);
  const ms = Date.now() - t0;
  assert.equal(found[0].code, '005930');
  assert.ok(ms < 150, `검색이 ${ms}ms — 전체 목록에서 너무 느리다`);
});

test('외부 결과는 강한 로컬 매치 뒤에 붙고 코드는 정규화된다', () => {
  const remote = [
    { code: 'AAPL.O', name: '애플', typeCode: 'NASDAQ', nationCode: 'USA' },
    { code: '0162Z0', name: 'RISE 삼성전자채권', market: 'KOSPI', type: 'stock_kr' },
  ];
  const merged = mergeSearchResults(UNIVERSE, [
    { code: 'AAPL.O', name: '애플', market: 'NASDAQ', type: 'stock_us' },
    { code: 'TSLA', name: '테슬라', market: 'NASDAQ', type: 'stock_us' },
  ], '애플', 10);
  assert.equal(merged[0].code, 'AAPL');
  assert.equal(normalizeTicker('AAPL.O'), 'AAPL');
  assert.equal(normalizeTicker('BRK B'), 'BRK.B');
  assert.ok(merged.some((s) => s.code === 'TSLA'));
  assert.equal(remote[0].code, 'AAPL.O');
});

test('포함 일치만 있는 검색은 외부 API 순서를 먼저 보여 준다', () => {
  const merged = mergeSearchResults(UNIVERSE, [
    { code: '005930', name: '삼성전자', market: 'KOSPI', type: 'stock_kr' },
  ], '전자', 5);
  assert.equal(merged[0].code, '005930');
});
