// PDF 가져오기 파서 — 증권사별 잔고증명서/보유내역 PDF 텍스트를 읽어 계좌 JSON 으로 변환.
// 지원: 토스증권 잔고증명서 (전체), 신한투자증권 IRP/ISA (텍스트 없는 PDF → 에러)
//
// 외부 진입점:
//   parsePdfBuffer(buffer) → { ok, format, accounts, warnings, meta }
//
// 반환되는 accounts 는 server.js validateAccount 를 통과하는 구조 (type, id, label, ...).

const { PDFParse } = require('pdf-parse');

// ---------- 토스증권 해외주식 내부코드 → 실제 티커 매핑 ----------
// Toss 는 상장일 기반 자체 식별자(US<YYYYMMDD>SEQ)를 쓰므로 이름으로 매핑.
const TOSS_US_NAME_TO_TICKER = {
  '애플': 'AAPL',
  '테슬라': 'TSLA',
  '코카콜라': 'KO',
  '엔비디아': 'NVDA',
  '마이크로소프트': 'MSFT',
  '레딧': 'RDDT',
  '구글': 'GOOGL',
  '알파벳': 'GOOGL',
  '알파벳a': 'GOOGL',
  '알파벳c': 'GOOG',
  '아마존': 'AMZN',
  '메타': 'META',
  '메타플랫폼스': 'META',
  'mp머티리얼스': 'MP',
  '버크셔해서웨이b': 'BRK.B',
  '넷플릭스': 'NFLX',
  '팔란티어': 'PLTR',
  '페이스북': 'META',
  '브로드컴': 'AVGO',
  '일라이릴리': 'LLY',
  'jp모건': 'JPM',
  '비자': 'V',
  '마스터카드': 'MA',
  '월마트': 'WMT',
  '존슨앤드존슨': 'JNJ',
};
// ETF/ETN 은 긴 한국어 이름 → 티커 매핑 (부분 일치로 찾음).
const TOSS_US_ETF_PATTERNS = [
  { pat: /프로셰어즈.*비트코인.*선물/i, ticker: 'BITO' },
  { pat: /JP모건.*나스닥.*프리미엄.*인컴/i, ticker: 'JEPQ' },
  { pat: /JP모건.*주식.*프리미엄.*인컴/i, ticker: 'JEPI' },
  { pat: /슈왑.*미국.*배당주.*ETF/i, ticker: 'SCHD' },
  { pat: /네오스.*S&?P.*500.*고배당/i, ticker: 'SPYI' },
  { pat: /네오스.*나스닥.*100.*고배당/i, ticker: 'QQQI' },
  { pat: /ER셰어즈.*창업가/i, ticker: 'ENTR' },
  { pat: /아크.*우주.*혁신/i, ticker: 'ARKX' },
  { pat: /아크.*이노베이션/i, ticker: 'ARKK' },
  { pat: /마이크로섹터.*금광.*3배/i, ticker: 'GDXU' },
  { pat: /SPDR.*S&?P.*500/i, ticker: 'SPY' },
  { pat: /인베스코.*나스닥.*100|QQQ/i, ticker: 'QQQ' },
  { pat: /뱅가드.*토탈.*스톡/i, ticker: 'VTI' },
  { pat: /뱅가드.*S&?P.*500/i, ticker: 'VOO' },
  { pat: /프로셰어즈.*울트라.*S&?P/i, ticker: 'SSO' },
  { pat: /디렉시온.*반도체.*3배/i, ticker: 'SOXL' },
  { pat: /iShares.*20\+.*국채|TLT/i, ticker: 'TLT' },
];

function resolveUsTicker(name, rawCode) {
  const normalized = String(name).toLowerCase().replace(/\s+/g, '');
  if (TOSS_US_NAME_TO_TICKER[normalized]) return TOSS_US_NAME_TO_TICKER[normalized];
  for (const { pat, ticker } of TOSS_US_ETF_PATTERNS) {
    if (pat.test(name)) return ticker;
  }
  // 못 찾으면 원본 코드 그대로 (시세 조회는 실패하지만 보유 수량/평가 저장은 됨).
  return String(rawCode || '').toUpperCase().slice(0, 20);
}

// ---------- 공용 유틸 ----------
function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36).slice(0, 10);
}
function parseNumber(s) {
  if (s == null) return NaN;
  if (typeof s === 'number') return s;
  return Number(String(s).replace(/[,\s$₩]/g, ''));
}
function todayKST() {
  return new Date().toLocaleString('sv', { timeZone: 'Asia/Seoul' }).slice(0, 10);
}

// ---------- 포맷 감지 ----------
function detectFormat(text) {
  if (!text || text.length < 20) return null;
  if (/잔고증명서/.test(text) && (/토스증권/.test(text) || /corp\.tossinvest\.com/.test(text))) {
    return 'toss_balance_cert';
  }
  if (/잔고증명서/.test(text) && /신한투자증권|신한금융투자/.test(text)) {
    return 'shinhan_balance_cert';
  }
  if (/주식잔고/.test(text) && /\d{3}-\d{2}-\d{6}/.test(text)) {
    return 'shinhan_stock_balance';
  }
  if (/금융상품/.test(text) && /IRP|퇴직연금|연금저축/.test(text)) {
    return 'shinhan_financial_product';
  }
  return null;
}

// ---------- 토스 잔고증명서 파서 ----------
function parseTossBalanceCert(text) {
  const warnings = [];
  const accounts = [];

  const acctMatch = text.match(/계좌\s*번호\s+(\d{3}-\d{2}-\d{6})/);
  const dateMatch = text.match(/기준일자\s+(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  const fxMatch = text.match(/\$\s*1\.00\s*=\s*([\d,.]+)/);
  const acctNo = acctMatch ? acctMatch[1] : `unknown-${Date.now()}`;
  const baseDate = dateMatch
    ? `${dateMatch[1]}-${String(dateMatch[2]).padStart(2, '0')}-${String(dateMatch[3]).padStart(2, '0')}`
    : todayKST();
  const fxRate = fxMatch ? parseNumber(fxMatch[1]) : 0;

  // 현금잔고: "원화 원화 미수금 원화 대출금 달러 달러 미수금" 다음 네 숫자.
  let cashKRW = 0;
  const cashHeaderIdx = text.search(/원화\s+원화\s*미수금\s+원화\s*대출금\s+달러\s+달러\s*미수금/);
  if (cashHeaderIdx >= 0) {
    const after = text.slice(cashHeaderIdx, cashHeaderIdx + 400);
    const nums = after.match(/[\d,]+/g) || [];
    // 앞 4 개 중 [원화, 미수금, 대출금, 달러→KRW] 순서.
    const won = parseNumber(nums[0]);
    const dollarKRW = parseNumber(nums[3]);
    if (isFinite(won)) cashKRW += won;
    if (isFinite(dollarKRW)) cashKRW += dollarKRW;
  }

  const holdings = [];

  // 국내 유가증권 섹션 추출 (헤더 뒤 "잔고 구분" 이 있는 실제 테이블만).
  const krSection = sliceTableSection(text, '국내 유가증권', ['해외 유가증권', '해외 파생상품', '총 계좌잔고']);
  if (krSection) {
    // 한 줄 포맷: "일반 <이름> (A<6-7자리>) <qty> <제한> <price> <eval>"
    // 이름에 "(H)" 같은 괄호가 있어도 되도록 .+? 로 허용하고, 코드 괄호는 A?\d{6}... 로 특정.
    const re = /일반\s+(.+?)\s+\((A?\d{6}[A-Z0-9]{0,2})\)\s+([\d,.]+)\s+[\d,.]+\s+([\d,.]+)\s+([\d,.]+)/g;
    let m;
    while ((m = re.exec(krSection)) !== null) {
      const [, name, rawCode, qty, price] = m;
      const code = rawCode.replace(/^A/, '');
      const qtyN = parseNumber(qty);
      const priceN = parseNumber(price);
      if (!code || !isFinite(qtyN) || qtyN <= 0) continue;
      holdings.push({
        assetType: 'stock_kr',
        ticker: code,
        label: String(name).trim().slice(0, 80),
        quantity: qtyN,
        avgCost: 0, // 잔고증명서는 평균단가가 없음
        currency: 'KRW',
        _priceHint: priceN, // 감사용 (저장 안 함)
      });
    }
  }

  // 해외 유가증권 섹션 추출 (멀티라인 가능).
  const usSection = sliceTableSection(text, '해외 유가증권', ['해외 파생상품', '총 계좌잔고', '발급일자']);
  if (usSection) {
    // 레코드는 "일반 " 으로 시작, 다음 "일반 " 또는 섹션 끝까지. 줄바꿈을 공백으로 만든 뒤 매치.
    const flat = usSection.replace(/\s+/g, ' ');
    const re = /일반\s+(.+?)\s+\(([A-Z0-9]+)\)\s+([\d,.]+)\s+[\d,.]+\s+([\d,]+)\s*\(\$\s*([\d,.]+)\)\s+([\d,]+)\s*\(\$\s*([\d,.]+)\)/g;
    let m;
    while ((m = re.exec(flat)) !== null) {
      const [, name, rawCode, qty, , priceUsd] = m;
      const cleanName = String(name).replace(/\s+/g, ' ').trim();
      const qtyN = parseNumber(qty);
      const priceUsdN = parseNumber(priceUsd);
      if (!isFinite(qtyN) || qtyN <= 0) continue;

      const ticker = resolveUsTicker(cleanName, rawCode);
      if (/^US\d{8}\d+$|^NYS\d/.test(ticker)) {
        warnings.push(`해외 종목 티커 미매핑: "${cleanName}" (${rawCode}) — 수동 확인 필요`);
      }
      holdings.push({
        assetType: 'stock_us',
        ticker,
        label: cleanName.slice(0, 80),
        quantity: qtyN,
        avgCost: 0,
        currency: 'USD',
        _priceHint: priceUsdN,
      });
    }
  }

  const dedupeKey = `asset:brokerage:toss:${acctNo}`;
  const acc = {
    id: `acc-brokerage-toss_${acctNo.replace(/-/g, '_')}`,
    type: 'brokerage',
    label: `토스증권 ${acctNo}`,
    institution: '토스증권',
    accountKind: '일반',
    currency: 'KRW',
    manualUpdatedAt: baseDate,
    source: 'pdf_toss_balance',
    dedupeKey,
    holdings: holdings.map(({ _priceHint, ...h }) => h),
  };
  if (cashKRW > 0) acc.cashKRW = Math.round(cashKRW);
  accounts.push(acc);

  return {
    accounts,
    warnings,
    meta: { accountNo: acctNo, baseDate, fxRate, holdings: holdings.length, cashKRW: Math.round(cashKRW) },
  };
}

// ---------- 섹션 잘라내기 ----------
// 일반: 헤더 이후, 다음 섹션 헤더 이전.
function sliceSection(text, start, nextStarts) {
  const i = text.indexOf(start);
  if (i < 0) return '';
  let end = text.length;
  for (const n of nextStarts) {
    const j = text.indexOf(n, i + start.length);
    if (j > 0 && j < end) end = j;
  }
  return text.slice(i + start.length, end);
}
// 테이블 섹션: 헤더가 여러 번 나타날 때 "잔고 구분" 이 바로 뒤따르는 실제 테이블 위치만.
function sliceTableSection(text, start, nextStarts) {
  let i = 0;
  let found = -1;
  while (true) {
    const idx = text.indexOf(start, i);
    if (idx < 0) break;
    const after = text.slice(idx + start.length, idx + start.length + 100);
    if (/잔고\s*구분/.test(after)) { found = idx; break; }
    i = idx + start.length;
  }
  if (found < 0) return '';
  let end = text.length;
  for (const n of nextStarts) {
    const j = text.indexOf(n, found + start.length);
    if (j > 0 && j < end) end = j;
  }
  return text.slice(found + start.length, end);
}

// ---------- 외부 진입점 ----------
async function parsePdfBuffer(buffer, password) {
  let text = '';
  try {
    const parserOpts = { data: buffer };
    if (password) parserOpts.password = password;
    const parser = new PDFParse(parserOpts);
    const r = await parser.getText();
    text = r.text || '';
  } catch (e) {
    const msg = String(e && (e.message || e.name) || e);
    if (/password|encrypt|PasswordException/i.test(msg)) {
      return {
        ok: false,
        error: password
          ? 'PDF 비밀번호가 올바르지 않습니다.'
          : '비밀번호가 필요한 PDF 입니다. 아래 비밀번호 칸에 입력 후 다시 시도하세요.',
        hint: 'password_required',
      };
    }
    return { ok: false, error: `PDF 읽기 실패: ${msg}` };
  }

  // 페이지 구분자 등을 뺀 실제 콘텐츠 길이로 판정.
  const clean = text
    .replace(/--\s*\d+\s*of\s*\d+\s*--/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (!clean || clean.length < 20) {
    return {
      ok: false,
      error: 'PDF 에 추출 가능한 텍스트가 없습니다. "Microsoft: Print To PDF" 로 저장된 파일은 글자가 이미지/벡터로 그려져 읽을 수 없습니다. Chrome 의 "PDF 로 저장" 또는 증권사가 제공하는 원본 PDF 를 사용하세요.',
      hint: 'no_text_layer',
    };
  }

  const format = detectFormat(text);
  if (!format) {
    return {
      ok: false,
      error: '지원하지 않는 PDF 포맷입니다. 현재는 토스증권 잔고증명서만 지원합니다.',
      textPreview: text.slice(0, 300),
    };
  }

  if (format === 'toss_balance_cert') {
    const { accounts, warnings, meta } = parseTossBalanceCert(text);
    return { ok: true, format, accounts, warnings, meta };
  }

  if (format === 'shinhan_balance_cert' || format === 'shinhan_stock_balance' || format === 'shinhan_financial_product') {
    return {
      ok: false,
      error: '신한투자증권 PDF 는 현재 자동 파싱을 지원하지 않습니다 (대부분 텍스트 없는 이미지 PDF). 수동으로 입력해 주세요.',
      hint: 'shinhan_not_supported',
    };
  }

  return { ok: false, error: `알 수 없는 포맷: ${format}` };
}

module.exports = { parsePdfBuffer };
