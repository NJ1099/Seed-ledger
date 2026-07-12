// 증권사 Open API 연동 — 앱키/시크릿으로 접근토큰을 발급받아 잔고를 조회하고
// pdfImport.js 와 동일한 계좌 JSON 구조({ type:'brokerage', holdings:[...] })로 변환한다.
//
// 설계 원칙 (이 앱의 프라이버시 모델 유지):
//   - 무상태 패스스루 프록시. 앱키/시크릿·잔고를 디스크나 DB 에 저장하지 않는다.
//   - 접근토큰만 프로세스 메모리에 TTL 캐시(재배포/재시작 시 휘발). KIS 는 앱키당
//     1분 1회 발급 제한이 있어 캐시가 필수.
//   - 브라우저는 자기 키를 localStorage 에만 두고, 동기화할 때마다 이 프록시로 보낸다.
//
// 외부 진입점:
//   syncBroker({ broker, appKey, appSecret, accountNo, env }) → { ok, format, accounts, warnings, meta }
//     broker : 'toss' | 'kis'
//     env    : 'real' | 'demo'  (kis 만 의미. toss 는 실전 도메인 하나뿐이라 무시)
//
// 반환되는 accounts 는 server.js / 프런트 store 가 기대하는 구조와 동일:
//   { id, type:'brokerage', label, institution, accountKind, currency,
//     manualUpdatedAt, source, dedupeKey, holdings:[{assetType,ticker,label,quantity,avgCost,currency}], cashKRW? }

const https = require('https');
const crypto = require('crypto');

const UA = 'SeedLedger/1.0 (+broker-sync)';

// ---------- zero-dep https 요청 헬퍼 ----------
function httpsRequest(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('잘못된 URL')); }
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { 'user-agent': UA, ...headers },
    };
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('요청 타임아웃')); });
    if (body != null) req.write(body);
    req.end();
  });
}

function jsonOrNull(text) { try { return JSON.parse(text); } catch { return null; } }
function parseNum(s) {
  if (s == null) return NaN;
  if (typeof s === 'number') return s;
  return Number(String(s).replace(/[,\s$₩]/g, ''));
}
function todayKST() {
  return new Date().toLocaleString('sv', { timeZone: 'Asia/Seoul' }).slice(0, 10);
}

// ---------- 접근토큰 메모리 캐시 (영속 저장 없음) ----------
const _tokenCache = new Map(); // hash(broker:env:appKey) -> { token, exp }
function cacheKey(broker, env, appKey) {
  return crypto.createHash('sha256').update(`${broker}:${env}:${appKey}`).digest('hex');
}
function getCachedToken(k) {
  const v = _tokenCache.get(k);
  if (!v) return null;
  if (v.exp > Date.now() + 60 * 1000) return v.token; // 만료 1분 전이면 새로 발급
  _tokenCache.delete(k); // 만료 엔트리 회수 — 메모리 단조 증가 방지
  return null;
}
function setCachedToken(k, token, ttlSec) {
  _tokenCache.set(k, { token, exp: Date.now() + Math.max(60, ttlSec) * 1000 });
}

// ============================================================
// 토스증권 Open API  (https://openapi.tossinvest.com)
//   POST /oauth2/token            (client_credentials, form-urlencoded)
//   GET  /api/v1/accounts         → result[].accountSeq / accountNo
//   GET  /api/v1/holdings         (헤더 X-Tossinvest-Account: accountSeq)
//                                 → result.items[] { symbol, name, marketCountry(KR|US),
//                                    currency(KRW|USD), quantity, averagePurchasePrice, ... }
// ============================================================
const TOSS_BASE = 'https://openapi.tossinvest.com';

async function tossToken(appKey, appSecret) {
  const k = cacheKey('toss', 'real', appKey);
  const cached = getCachedToken(k);
  if (cached) return cached;
  const form = `grant_type=client_credentials&client_id=${encodeURIComponent(appKey)}&client_secret=${encodeURIComponent(appSecret)}`;
  const r = await httpsRequest(`${TOSS_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form,
  });
  const j = jsonOrNull(r.text);
  if (r.status !== 200 || !j || !j.access_token) {
    const msg = (j && (j.error_description || j.error || j.message)) || `HTTP ${r.status}`;
    throw new Error(`토스 접근토큰 발급 실패: ${msg}`);
  }
  setCachedToken(k, j.access_token, (j.expires_in || 600) - 60);
  return j.access_token;
}

async function tossGet(path, token, accountSeq) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  if (accountSeq != null) headers['x-tossinvest-account'] = String(accountSeq);
  const r = await httpsRequest(`${TOSS_BASE}${path}`, { headers });
  const j = jsonOrNull(r.text);
  if (r.status !== 200 || !j) {
    const msg = (j && j.error && (j.error.message || j.error.code)) || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return j.result;
}

async function syncToss(appKey, appSecret) {
  const warnings = [];
  const token = await tossToken(appKey, appSecret);

  const accs = await tossGet('/api/v1/accounts', token);
  const list = Array.isArray(accs) ? accs : [];
  if (!list.length) {
    return { accounts: [], warnings: ['토스증권에서 조회된 계좌가 없습니다. Open API 신청/계좌 상태를 확인하세요.'], meta: {} };
  }

  const accounts = [];
  let totalHoldings = 0;
  for (const a of list) {
    const seq = a.accountSeq;
    const accountNo = a.accountNo || String(seq);
    let items = [];
    try {
      const ov = await tossGet('/api/v1/holdings', token, seq);
      items = (ov && Array.isArray(ov.items)) ? ov.items : [];
    } catch (e) {
      warnings.push(`계좌 ${accountNo} 보유주식 조회 실패: ${e.message}`);
    }
    const holdings = items.map((it) => {
      const isUs = it.marketCountry === 'US';
      return {
        assetType: isUs ? 'stock_us' : 'stock_kr',
        ticker: String(it.symbol || '').trim(),
        label: String(it.name || '').trim().slice(0, 80),
        quantity: parseNum(it.quantity),
        avgCost: parseNum(it.averagePurchasePrice) || 0,
        currency: it.currency || (isUs ? 'USD' : 'KRW'),
      };
    }).filter((h) => h.ticker && isFinite(h.quantity) && h.quantity > 0);
    totalHoldings += holdings.length;

    const digits = String(accountNo).replace(/\D/g, '') || String(seq);
    accounts.push({
      id: `acc-brokerage-toss-api_${digits}`,
      type: 'brokerage',
      label: `토스증권 ${accountNo}`,
      institution: '토스증권',
      accountKind: '일반',
      currency: 'KRW',
      manualUpdatedAt: todayKST(),
      source: 'api_toss',
      dedupeKey: `asset:brokerage:toss-api:${digits}`,
      holdings,
    });
  }
  return { accounts, warnings, meta: { accounts: accounts.length, holdings: totalHoldings } };
}

// ============================================================
// 한국투자증권 KIS Open API
//   실전 https://openapi.koreainvestment.com:9443
//   모의 https://openapivts.koreainvestment.com:29443
//   POST /oauth2/tokenP  (client_credentials, JSON)
//   국내 GET /uapi/domestic-stock/v1/trading/inquire-balance  tr_id TTTC8434R / VTTC8434R
//   해외 GET /uapi/overseas-stock/v1/trading/inquire-balance  tr_id TTTS3012R / VTTS3012R
// ============================================================
const KIS_BASE = {
  real: 'https://openapi.koreainvestment.com:9443',
  demo: 'https://openapivts.koreainvestment.com:29443',
};

function splitKisAccount(accountNo) {
  const digits = String(accountNo || '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  return { cano: digits.slice(0, 8), prdt: digits.slice(8, 10) };
}

async function kisToken(appKey, appSecret, env) {
  const base = KIS_BASE[env] || KIS_BASE.real;
  const k = cacheKey('kis', env, appKey);
  const cached = getCachedToken(k);
  if (cached) return cached;
  const r = await httpsRequest(`${base}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, appsecret: appSecret }),
  });
  const j = jsonOrNull(r.text);
  if (r.status !== 200 || !j || !j.access_token) {
    const blob = JSON.stringify(j || {});
    let msg = (j && (j.error_description || j.msg1 || j.error_code)) || `HTTP ${r.status}`;
    const err = new Error(`한국투자 접근토큰 발급 실패: ${msg}`);
    if (/EGW00133/.test(blob)) {
      err.hint = 'token_ratelimited';
      err.message = '한국투자 접근토큰은 1분에 1회만 발급됩니다. 잠시 후 다시 시도하세요. (EGW00133)';
    }
    throw err;
  }
  // 유효기간 24h. 여유 있게 10분 일찍 만료 처리.
  setCachedToken(k, j.access_token, (j.expires_in || 86400) - 600);
  return j.access_token;
}

function kisHeaders(token, appKey, appSecret, trId) {
  return {
    'content-type': 'application/json; charset=utf-8',
    authorization: `Bearer ${token}`,
    appkey: appKey,
    appsecret: appSecret,
    tr_id: trId,
    custtype: 'P',
  };
}

async function kisDomesticBalance(token, appKey, appSecret, env, cano, prdt) {
  const base = KIS_BASE[env] || KIS_BASE.real;
  const trId = env === 'demo' ? 'VTTC8434R' : 'TTTC8434R';
  const qs = new URLSearchParams({
    CANO: cano, ACNT_PRDT_CD: prdt, AFHR_FLPR_YN: 'N', OFL_YN: '',
    INQR_DVSN: '02', UNPR_DVSN: '01', FUND_STTL_ICLD_YN: 'N',
    FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00', CTX_AREA_FK100: '', CTX_AREA_NK100: '',
  }).toString();
  const r = await httpsRequest(`${base}/uapi/domestic-stock/v1/trading/inquire-balance?${qs}`, {
    headers: kisHeaders(token, appKey, appSecret, trId),
  });
  const j = jsonOrNull(r.text) || {};
  if (r.status !== 200 || (j.rt_cd && j.rt_cd !== '0')) {
    throw new Error((j.msg1 || j.msg_cd || `HTTP ${r.status}`).toString().trim());
  }
  const out1 = Array.isArray(j.output1) ? j.output1 : [];
  const out2 = Array.isArray(j.output2) ? (j.output2[0] || {}) : (j.output2 || {});
  const holdings = out1.map((o) => ({
    assetType: 'stock_kr',
    ticker: String(o.pdno || '').trim(),
    label: String(o.prdt_name || '').trim().slice(0, 80),
    quantity: parseNum(o.hldg_qty),
    avgCost: Math.round((parseNum(o.pchs_avg_pric) || 0) * 10000) / 10000,
    currency: 'KRW',
  })).filter((h) => h.ticker && isFinite(h.quantity) && h.quantity > 0);
  const cashKRW = Math.round(parseNum(out2.dnca_tot_amt) || 0);
  return { holdings, cashKRW };
}

async function kisOverseasBalance(token, appKey, appSecret, env, cano, prdt) {
  const base = KIS_BASE[env] || KIS_BASE.real;
  const trId = env === 'demo' ? 'VTTS3012R' : 'TTTS3012R';
  // 실전 NASD = 미국 전체(NYSE/NASDAQ/AMEX). 필요 시 홍콩/일본 등 거래소를 배열에 추가.
  const markets = [['NASD', 'USD']];
  const holdings = [];
  const warnings = [];
  for (const [excg, crcy] of markets) {
    const qs = new URLSearchParams({
      CANO: cano, ACNT_PRDT_CD: prdt, OVRS_EXCG_CD: excg, TR_CRCY_CD: crcy,
      CTX_AREA_FK200: '', CTX_AREA_NK200: '',
    }).toString();
    const r = await httpsRequest(`${base}/uapi/overseas-stock/v1/trading/inquire-balance?${qs}`, {
      headers: kisHeaders(token, appKey, appSecret, trId),
    });
    const j = jsonOrNull(r.text) || {};
    if (r.status !== 200 || (j.rt_cd && j.rt_cd !== '0')) {
      warnings.push(`해외(${excg}) 조회 실패: ${(j.msg1 || j.msg_cd || `HTTP ${r.status}`).toString().trim()}`);
      continue;
    }
    const out1 = Array.isArray(j.output1) ? j.output1 : [];
    for (const o of out1) {
      const q = parseNum(o.ovrs_cblc_qty);
      if (!isFinite(q) || q <= 0) continue;
      holdings.push({
        assetType: 'stock_us',
        ticker: String(o.ovrs_pdno || '').trim(),
        label: String(o.ovrs_item_name || '').trim().slice(0, 80),
        quantity: q,
        avgCost: parseNum(o.pchs_avg_pric) || 0,
        currency: o.tr_crcy_cd || 'USD',
      });
    }
  }
  return { holdings, warnings };
}

async function syncKis(appKey, appSecret, accountNo, env) {
  const warnings = [];
  const split = splitKisAccount(accountNo);
  if (!split) {
    const e = new Error('한국투자증권 계좌번호 형식이 올바르지 않습니다. 예: 12345678-01 (숫자 10자리).');
    e.hint = 'bad_account';
    throw e;
  }
  const { cano, prdt } = split;
  const token = await kisToken(appKey, appSecret, env);

  let dom = { holdings: [], cashKRW: 0 };
  let ovs = { holdings: [], warnings: [] };
  try { dom = await kisDomesticBalance(token, appKey, appSecret, env, cano, prdt); }
  catch (e) { warnings.push(`국내주식 조회 실패: ${e.message}`); }
  try { ovs = await kisOverseasBalance(token, appKey, appSecret, env, cano, prdt); }
  catch (e) { warnings.push(`해외주식 조회 실패: ${e.message}`); }
  if (ovs.warnings && ovs.warnings.length) warnings.push(...ovs.warnings);

  const holdings = [...dom.holdings, ...ovs.holdings];
  const demo = env === 'demo';
  const acc = {
    id: `acc-brokerage-kis-api_${cano}${prdt}${demo ? '_demo' : ''}`,
    type: 'brokerage',
    label: `한국투자증권 ${cano}-${prdt}${demo ? ' (모의)' : ''}`,
    institution: '한국투자증권',
    accountKind: '일반',
    currency: 'KRW',
    manualUpdatedAt: todayKST(),
    source: demo ? 'api_kis_demo' : 'api_kis',
    dedupeKey: `asset:brokerage:kis-api:${cano}${prdt}${demo ? ':demo' : ''}`,
    holdings,
  };
  if (dom.cashKRW > 0) acc.cashKRW = dom.cashKRW;
  return { accounts: [acc], warnings, meta: { holdings: holdings.length, cashKRW: dom.cashKRW } };
}

// ---------- 외부 진입점 ----------
async function syncBroker({ broker, appKey, appSecret, accountNo, env } = {}) {
  broker = String(broker || '').toLowerCase();
  env = env === 'demo' ? 'demo' : 'real';
  if (!appKey || !appSecret) return { ok: false, error: 'App Key / App Secret 을 입력하세요.' };

  try {
    if (broker === 'toss') {
      const { accounts, warnings, meta } = await syncToss(appKey, appSecret);
      return { ok: true, broker, format: 'api_toss', accounts, warnings, meta };
    }
    if (broker === 'kis') {
      const { accounts, warnings, meta } = await syncKis(appKey, appSecret, accountNo, env);
      return { ok: true, broker, format: env === 'demo' ? 'api_kis_demo' : 'api_kis', accounts, warnings, meta };
    }
    return { ok: false, error: `지원하지 않는 증권사: ${broker}` };
  } catch (e) {
    return { ok: false, error: e.message || String(e), hint: e.hint || null };
  }
}

module.exports = { syncBroker };
