// 종목 검색 매칭.
// 서버의 /api/stock-search 와 테스트가 같이 쓴다. 네트워크를 부르지 않는다.
//
// 순위: 이름·코드·별칭의 완전일치 > 초성 완전일치 > 접두 > 초성 접두 > 포함 > 초성 포함.
// 같은 순위에서는 짧은 이름, 그다음 목록에 들어온 순서(시가총액 순으로 넣으면 대형주가 앞).

'use strict';

const CHOSUNG = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

const SCORE = {
  EXACT: 0,
  CHO_EXACT: 1,
  PREFIX: 2,
  CHO_PREFIX: 3,
  CONTAINS: 4,
  CHO_CONTAINS: 5,
};

// 자주 치는 한글·영문·별칭. 시세 목록에는 한글 이름만 있거나 영문만 있는 종목이 많다.
const ALIAS_BY_CODE = {
  '005930': ['Samsung', 'Samsung Electronics', '삼전'],
  '000660': ['SK Hynix', 'SK하이닉스', 'Hynix', '하이닉스'],
  '373220': ['LG Energy Solution', 'LG에너지솔루션', 'LGES'],
  '207940': ['Samsung Biologics', '삼성바이오로직스'],
  '005380': ['Hyundai', 'Hyundai Motor', '현대자동차', '현대차'],
  '000270': ['Kia', 'Kia Motors', '기아차'],
  '068270': ['Celltrion', '셀트리온'],
  '105560': ['KB Financial', 'KB금융', 'KB금융지주'],
  '055550': ['Shinhan', '신한지주', '신한'],
  '035420': ['Naver', '네이버'],
  '035720': ['Kakao', '카카오'],
  '005935': ['Samsung Electronics Preferred', '삼성전자우'],
  '006400': ['Samsung SDI', '삼성SDI'],
  '051910': ['LG Chem', 'LG화학'],
  '066570': ['LG Electronics', 'LG전자'],
  '003550': ['LG Corp', 'LG'],
  '028260': ['Samsung C&T', '삼성물산'],
  '012450': ['Hanwha Aerospace', '한화에어로스페이스', '한화에어로'],
  '005490': ['POSCO', 'POSCO Holdings', '포스코', '포스코홀딩스'],
  '009150': ['Samsung Electro-Mechanics', '삼성전기'],
  '011070': ['LG Innotek', 'LG이노텍'],
  '196170': ['Alteogen', '알테오젠'],
  '247540': ['EcoPro BM', '에코프로비엠'],
  '086520': ['EcoPro', '에코프로'],
  'AAPL': ['Apple', 'Apple Inc', '애플'],
  'MSFT': ['Microsoft', '마이크로소프트', '마소'],
  'NVDA': ['NVIDIA', '엔비디아'],
  'GOOGL': ['Alphabet', 'Google', '구글', '알파벳'],
  'GOOG': ['Alphabet', 'Google', '구글'],
  'AMZN': ['Amazon', '아마존'],
  'META': ['Meta', 'Meta Platforms', 'Facebook', '메타', '페이스북'],
  'TSLA': ['Tesla', '테슬라'],
  'BRK.B': ['Berkshire', 'Berkshire Hathaway', '버크셔', '버크셔해서웨이'],
  'JPM': ['JPMorgan', 'JP Morgan', 'JPMorgan Chase', '제이피모건'],
  'V': ['Visa', '비자'],
  'JNJ': ['Johnson & Johnson', '존슨앤존슨', '존슨앤드존슨'],
  'WMT': ['Walmart', '월마트'],
  'KO': ['Coca-Cola', 'Coca Cola', '코카콜라', '코크'],
  'NFLX': ['Netflix', '넷플릭스'],
  'AMD': ['Advanced Micro Devices', '에이엠디'],
  'INTC': ['Intel', '인텔'],
  'DIS': ['Disney', 'Walt Disney', '디즈니'],
  'BABA': ['Alibaba', '알리바바'],
  'TSM': ['TSMC', 'Taiwan Semiconductor', '티에스엠씨'],
  'AVGO': ['Broadcom', '브로드컴'],
  'PLTR': ['Palantir', '팔란티어'],
  'LLY': ['Eli Lilly', '일라이릴리'],
  'MA': ['Mastercard', '마스터카드'],
  'PYPL': ['PayPal', '페이팔'],
  'COST': ['Costco', '코스트코'],
  'ORCL': ['Oracle', '오라클'],
  'CRM': ['Salesforce', '세일즈포스'],
  'NKE': ['Nike', '나이키'],
  'SBUX': ['Starbucks', '스타벅스'],
  'QQQ': ['Invesco QQQ', 'Nasdaq 100', '나스닥100'],
  'SPY': ['SPDR S&P 500', 'S&P 500', 'SP500', '에스앤피'],
  'VOO': ['Vanguard S&P 500', 'S&P 500'],
  'SCHD': ['Schwab US Dividend', '슈드'],
  'SOXL': ['Direxion Semiconductor', '소울'],
};

function chosungOf(text) {
  let out = '';
  const s = String(text || '');
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) {
      out += CHOSUNG[Math.floor((code - 0xac00) / 588)];
    }
  }
  return out;
}

function isChosungQuery(q) {
  const compact = String(q || '').replace(/\s+/g, '');
  return compact.length > 0 && /^[ㄱ-ㅎ]+$/.test(compact);
}

// 대소문자, 공백, 흔히 붙는 문장부호를 없앤 비교 키.
function normalizeSearchKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u00a0\u3000]+/g, '')
    .replace(/[.,&'"“”‘’()[\]{}\-_/\\·ㆍ・:+#*!?~`|]/g, '');
}

// 네이버가 주는 코드를 시세 조회에 쓰는 티커로 맞춘다.
// AAPL.O → AAPL, "BRK B" / BRK-B → BRK.B. 국내 6자리·영숫자 코드는 그대로.
function normalizeTicker(code) {
  let c = String(code || '').trim().toUpperCase();
  c = c.replace(/\.(O|K|N|KS|KQ)$/i, '');
  if (/^[A-Z]{1,6}[\s-][A-Z]$/.test(c)) c = c.replace(/[\s-]/, '.');
  return c;
}

function inferStockType(code, market) {
  const m = String(market || '').toUpperCase();
  if (m === 'KOSPI' || m === 'KOSDAQ' || m === 'KONEX' || m === 'KS' || m === 'KQ') return 'stock_kr';
  if (/^\d{6}$/.test(code) || /^\d[0-9A-Z]{5}$/.test(code)) return 'stock_kr';
  return 'stock_us';
}

function indexStock(stock) {
  const code = normalizeTicker(stock && stock.code);
  const name = String((stock && stock.name) || '').trim();
  const aliases = [];
  const pushAlias = (a) => {
    const t = String(a || '').trim();
    if (!t) return;
    if (name && t.toLowerCase() === name.toLowerCase()) return;
    if (code && t.toUpperCase() === code) return;
    if (aliases.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    aliases.push(t);
  };
  if (stock && Array.isArray(stock.aliases)) stock.aliases.forEach(pushAlias);
  if (stock && stock.nameEng) pushAlias(stock.nameEng);
  (ALIAS_BY_CODE[code] || []).forEach(pushAlias);
  return {
    code,
    name,
    market: (stock && stock.market) || '',
    type: (stock && stock.type) || inferStockType(code, stock && stock.market),
    aliases,
    _nName: normalizeSearchKey(name),
    _nCode: normalizeSearchKey(code),
    _nAliases: aliases.map(normalizeSearchKey).filter(Boolean),
    _cho: chosungOf(name),
    _choAliases: aliases.map(chosungOf),
  };
}

function fieldScore(queryNorm, queryCho, chosungMode, norm, cho) {
  let best = Infinity;
  if (!chosungMode && queryNorm && norm) {
    if (norm === queryNorm) best = SCORE.EXACT;
    else if (norm.startsWith(queryNorm)) best = SCORE.PREFIX;
    else if (norm.includes(queryNorm)) best = SCORE.CONTAINS;
  }
  if (chosungMode && queryCho && cho) {
    let choScore = Infinity;
    if (cho === queryCho) choScore = SCORE.CHO_EXACT;
    else if (cho.startsWith(queryCho)) choScore = SCORE.CHO_PREFIX;
    else if (cho.includes(queryCho)) choScore = SCORE.CHO_CONTAINS;
    if (choScore < best) best = choScore;
  }
  return best;
}

function scoreStock(stock, queryNorm, queryCho, chosungMode) {
  let best = fieldScore(queryNorm, queryCho, chosungMode, stock._nCode, '');
  const nameScore = fieldScore(queryNorm, queryCho, chosungMode, stock._nName, stock._cho);
  if (nameScore < best) best = nameScore;
  for (let i = 0; i < stock._nAliases.length; i++) {
    const aliasScore = fieldScore(
      queryNorm,
      queryCho,
      chosungMode,
      stock._nAliases[i],
      stock._choAliases[i] || '',
    );
    if (aliasScore < best) best = aliasScore;
  }
  return best;
}

function searchStocks(stocks, query, limit = 12) {
  const raw = String(query || '').trim();
  if (!raw || !Array.isArray(stocks) || !stocks.length) return [];
  const chosungMode = isChosungQuery(raw);
  const queryNorm = normalizeSearchKey(raw);
  const queryCho = chosungMode ? raw.replace(/\s+/g, '') : '';
  if (!queryNorm && !queryCho) return [];
  const cap = Math.max(1, limit | 0);
  const hits = [];
  for (let i = 0; i < stocks.length; i++) {
    const src = stocks[i];
    if (!src) continue;
    const s = src._nName != null ? src : indexStock(src);
    if (!s.code && !s.name) continue;
    const score = scoreStock(s, queryNorm, queryCho, chosungMode);
    if (score === Infinity) continue;
    hits.push({ s, score, i, len: (s._nName || s._nCode || '').length });
  }
  hits.sort((a, b) => a.score - b.score || a.len - b.len || a.i - b.i);
  return hits.slice(0, cap).map((h) => ({
    code: h.s.code,
    name: h.s.name,
    market: h.s.market,
    type: h.s.type,
    score: h.score,
  }));
}

// 로컬 강매치(완전일치·접두·초성 접두)를 먼저, 이어서 외부 API 가 준 순서, 그다음 포함 매치.
// 외부 결과가 약한 부분일치를 밀어내지 않고, 정확한 종목이 목록 뒤쪽에 있어도 앞으로 온다.
function mergeSearchResults(universe, remote, query, limit = 12) {
  const localHits = searchStocks(universe, query, 40);
  const strong = localHits.filter((h) => h.score <= SCORE.CHO_PREFIX);
  const weak = localHits.filter((h) => h.score > SCORE.CHO_PREFIX);
  const seen = new Set();
  const out = [];
  const push = (item) => {
    if (!item) return;
    const code = normalizeTicker(item.code);
    if (!code || seen.has(code)) return;
    seen.add(code);
    out.push({
      code,
      name: String(item.name || code).trim(),
      market: item.market || '',
      type: item.type || inferStockType(code, item.market),
    });
  };
  for (const h of strong) push(h);
  for (const r of remote || []) push(r);
  for (const h of weak) push(h);
  return out.slice(0, Math.max(1, limit | 0));
}

module.exports = {
  SCORE,
  ALIAS_BY_CODE,
  chosungOf,
  isChosungQuery,
  normalizeSearchKey,
  normalizeTicker,
  inferStockType,
  indexStock,
  searchStocks,
  mergeSearchResults,
};
