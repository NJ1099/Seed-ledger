// Seed (Liquid Ledger) — 공개 배포판 서버
//
// 이 서버는 누구에게나 공개되는 인스턴스에서 돌아간다.
// 사용자별 자산/거래/스냅샷은 모두 브라우저 localStorage 에 저장되고,
// 이 서버는 "공유 가능한 공개 데이터" 만 프록시·캐시한다:
//   - 주식·코인·지수·환율 시세 (Upbit / Naver / Yahoo)
//   - 주요 이벤트 캘린더 (경제지표·실적) — 읽기 전용 공유 목록
//   - 과거 가격 시계열 (sparkline/chart 용)
//   - PDF 증권계좌 파싱 (업로드된 PDF 는 메모리에서만 처리, 저장 안 함)
//
// 사용법:
//   node server.js [port]
//   Render 환경에서는 process.env.PORT 가 자동 주입됨.
//
// 보안 주의:
//   - 쓰기 가능한 사용자 데이터 엔드포인트(/api/accounts, /api/transactions, /api/snapshot)는 없음.
//   - /api/events 도 POST/PUT/DELETE 차단 (읽기 전용). 관리자가 직접 파일을 갱신하면 반영됨.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// pdfImport 는 pdfjs-dist + @napi-rs/canvas 를 쓰므로 호스트에 네이티브 의존이 필요.
// 실패해도 나머지 기능은 살리기 위해 try-require.
let parsePdfBuffer = null;
try {
  ({ parsePdfBuffer } = require('./pdfImport'));
} catch (e) {
  console.warn('[pdfImport] 비활성화:', e.message);
}

const root = __dirname;
const portArg = process.argv.find(a => /^\d+$/.test(a));
const port = parseInt(process.env.PORT || portArg || '4274', 10);

const DATA_DIR = path.join(root, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const QUOTE_CACHE_FILE = path.join(DATA_DIR, 'quote-cache.json');
const POPULAR_TICKERS_FILE = path.join(DATA_DIR, 'popular-tickers.json');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const SERVER_LOG = path.join(LOG_DIR, 'server.log');

for (const d of [DATA_DIR, LOG_DIR]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch {}
}
if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, JSON.stringify({ version: 2, updatedAt: '', events: [] }, null, 2));
if (!fs.existsSync(QUOTE_CACHE_FILE)) fs.writeFileSync(QUOTE_CACHE_FILE, JSON.stringify({ updatedAt: '', quotes: {} }, null, 2));
if (!fs.existsSync(POPULAR_TICKERS_FILE)) {
  // 최초 기동 시 기본 인기 티커 목록 — 공유 캐시를 예열해둬서 첫 방문자가 빠르게 표시받도록.
  const defaults = {
    comment: '자동 폴러가 이 목록의 시세를 주기적으로 캐시한다. 관리자가 항목을 자유롭게 수정 가능.',
    tickers: [
      // 한국 지수
      { type: 'index', ticker: 'KOSPI' },
      { type: 'index', ticker: 'KOSDAQ' },
      // 해외 지수
      { type: 'index', ticker: 'SP500' },
      { type: 'index', ticker: 'NASDAQ' },
      { type: 'index', ticker: 'NIKKEI' },
      // 원자재
      { type: 'index', ticker: 'GOLD' },
      { type: 'index', ticker: 'WTI' },
      // 환율
      { type: 'index', ticker: 'USDKRW' },
      // 미국 대형주
      { type: 'stock_us', ticker: 'AAPL' },
      { type: 'stock_us', ticker: 'MSFT' },
      { type: 'stock_us', ticker: 'NVDA' },
      { type: 'stock_us', ticker: 'TSLA' },
      // 한국 대표주
      { type: 'stock_kr', ticker: '005930' }, // 삼성전자
      // 주요 코인 (KRW / USD 양쪽)
      { type: 'crypto', ticker: 'KRW-BTC' },
      { type: 'crypto', ticker: 'BTC-USD' },
      { type: 'crypto', ticker: 'KRW-ETH' },
      { type: 'crypto', ticker: 'ETH-USD' },
      { type: 'crypto', ticker: 'KRW-SOL' },
      { type: 'crypto', ticker: 'SOL-USD' },
      { type: 'crypto', ticker: 'KRW-DOGE' },
      { type: 'crypto', ticker: 'DOGE-USD' },
      { type: 'crypto', ticker: 'KRW-USDT' },
      { type: 'crypto', ticker: 'KRW-USDC' },
    ],
  };
  fs.writeFileSync(POPULAR_TICKERS_FILE, JSON.stringify(defaults, null, 2));
}

const LOG_MAX_BYTES = 5 * 1024 * 1024;
function logLine(level, event, detail) {
  const line = JSON.stringify({ ts: nowKST(), level, event, ...detail }) + '\n';
  try {
    if (fs.existsSync(SERVER_LOG) && fs.statSync(SERVER_LOG).size > LOG_MAX_BYTES) {
      const rotated = SERVER_LOG + '.1';
      try { if (fs.existsSync(rotated)) fs.unlinkSync(rotated); } catch {}
      try { fs.renameSync(SERVER_LOG, rotated); } catch {}
    }
    fs.appendFileSync(SERVER_LOG, line);
  } catch {}
  if (level === 'error') console.error(`[${event}]`, detail);
  else console.log(`[${event}]`, detail);
}

function nowKST() {
  const d = new Date();
  const s = d.toLocaleString('sv', { timeZone: 'Asia/Seoul' }).replace(' ', 'T');
  return s + '+09:00';
}

// ---------- 보안 가드 ----------
const SAFE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_TICKER_RE = /^[A-Za-z0-9.^_=-]{1,20}$/;

// ---------- 이벤트 스키마 (읽기 전용이지만 응답 정규화용) ----------
function inferCategory(e) {
  if (typeof e.tag === 'string' && /실적|earnings/i.test(e.tag)) return 'earnings';
  if (typeof e.title === 'string' && /실적|earnings|분기|Q[1-4]/i.test(e.title)) return 'earnings';
  return 'economic';
}

function safeMerge(base, patch) {
  const out = base && typeof base === 'object' ? { ...base } : {};
  for (const k of Object.keys(patch || {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = patch[k];
  }
  return out;
}

function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (e) {
    try { fs.copyFileSync(file, `${file}.corrupt-${Date.now()}.bak`); } catch {}
    logLine('error', 'readJSON.fail', { file, err: String(e) });
    return fallback;
  }
}
function writeJSON(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

async function readBody(req, maxBytes = 2 * 1024 * 1024) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      chunks.push(c);
      size += c.length;
      if (size > maxBytes) {
        aborted = true;
        try { req.destroy(); } catch {}
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (e) => { if (!aborted) reject(e); });
  });
}

async function readBodyBytes(req, maxBytes = 20 * 1024 * 1024) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      chunks.push(c);
      size += c.length;
      if (size > maxBytes) {
        aborted = true;
        try { req.destroy(); } catch {}
        reject(new Error('body too large'));
      }
    });
    req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    req.on('error', (e) => { if (!aborted) reject(e); });
  });
}
function reply(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    // 동일 도메인 인스턴스이므로 CORS 는 기본 off. 필요 시 주석 해제.
    // 'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(obj));
}

function httpsGet(url, { timeoutMs = 6000, headers = {} } = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const opts = {
        method: 'GET',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (seed-ledger/1.0)',
          'Accept': 'application/json, text/plain, */*',
          ...headers,
        },
        timeout: timeoutMs,
      };
      const req = https.request(opts, (r) => {
        let data = '';
        r.on('data', (c) => { data += c.toString('utf8'); });
        r.on('end', () => resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, body: data }));
      });
      req.on('error', (e) => resolve({ ok: false, status: 0, body: '', error: String(e) }));
      req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch {} });
      req.end();
    } catch (e) {
      resolve({ ok: false, status: 0, body: '', error: String(e) });
    }
  });
}

// ---------- 시세 소스 ----------
async function fetchUpbit(tickers) {
  if (!tickers.length) return {};
  const url = `https://api.upbit.com/v1/ticker?markets=${tickers.map(encodeURIComponent).join(',')}`;
  const r = await httpsGet(url);
  if (r.ok) {
    try {
      const arr = JSON.parse(r.body);
      if (Array.isArray(arr) && arr.length) {
        const out = {};
        for (const it of arr) {
          out[it.market] = { priceKRW: it.trade_price, ts: nowKST(), source: 'upbit', change24h: it.signed_change_rate };
        }
        if (Object.keys(out).length === tickers.length) {
          logLine('info', 'upbit.ok', { count: Object.keys(out).length, via: 'batch' });
          return out;
        }
      }
    } catch (e) {
      logLine('warn', 'upbit.parse', { err: String(e) });
    }
  }
  const out = {};
  await Promise.all(tickers.map(async (m) => {
    const u = `https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(m)}`;
    const rr = await httpsGet(u);
    if (!rr.ok) {
      logLine('warn', 'upbit.http.single', { market: m, status: rr.status });
      return;
    }
    try {
      const arr = JSON.parse(rr.body);
      if (Array.isArray(arr) && arr[0]?.trade_price) {
        out[m] = {
          priceKRW: arr[0].trade_price, ts: nowKST(),
          source: 'upbit', change24h: arr[0].signed_change_rate,
        };
      }
    } catch (e) {
      logLine('warn', 'upbit.parse.single', { market: m, err: String(e) });
    }
  }));
  logLine('info', 'upbit.ok', { count: Object.keys(out).length, via: 'fallback' });
  return out;
}

function parseKRNumber(v) {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  return Number(String(v).replace(/,/g, '').trim());
}
async function fetchNaver(codes) {
  const out = {};
  await Promise.all(codes.map(async (code) => {
    const url1 = `https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`;
    const r1 = await httpsGet(url1, { headers: { 'Referer': 'https://finance.naver.com/' } });
    if (r1.ok) {
      try {
        const j = JSON.parse(r1.body);
        const d = j?.datas?.[0];
        const priceRaw = d?.nv ?? d?.closePrice ?? d?.tradePrice ?? d?.currentPrice;
        const price = parseKRNumber(priceRaw);
        if (d && isFinite(price) && price > 0) {
          out[code] = {
            priceKRW: price,
            ts: nowKST(),
            source: 'naver-polling',
            change: d.cr != null ? parseKRNumber(d.cr) : null,
            name: d.nm || d.stockName || null,
          };
          return;
        }
      } catch (e) {
        logLine('warn', 'naver.polling.parse', { code, err: String(e) });
      }
    } else {
      logLine('warn', 'naver.polling.http', { code, status: r1.status, err: r1.error || null });
    }
    const url2 = `https://m.stock.naver.com/api/stock/${code}/basic`;
    const r2 = await httpsGet(url2, { headers: { 'Referer': 'https://m.stock.naver.com/' } });
    if (r2.ok) {
      try {
        const j = JSON.parse(r2.body);
        const price = parseKRNumber(j?.closePrice);
        if (isFinite(price) && price > 0) {
          out[code] = {
            priceKRW: price,
            ts: nowKST(),
            source: 'naver-m',
            change: j.compareToPreviousPrice?.text || null,
            name: j.stockName || null,
          };
          return;
        }
      } catch (e) {
        logLine('warn', 'naver.m.parse', { code, err: String(e) });
      }
    }
  }));
  return out;
}

async function fetchYahooHistory(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
  const r = await httpsGet(url, { timeoutMs: 8000 });
  if (!r.ok) {
    return { ok: false, error: `yahoo http ${r.status}`, source: 'yahoo' };
  }
  try {
    const j = JSON.parse(r.body);
    const res = j?.chart?.result?.[0];
    if (!res) return { ok: false, error: 'no result' };
    const ts = res.timestamp || [];
    const closes = res.indicators?.quote?.[0]?.close || [];
    const points = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || !isFinite(c)) continue;
      points.push({ t: ts[i] * 1000, c });
    }
    return {
      ok: true,
      points,
      currency: res.meta?.currency || 'USD',
      prevClose: res.meta?.chartPreviousClose ?? null,
      source: 'yahoo',
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function fetchUpbitHistory(market, interval, range) {
  let endpoint;
  let count = 200;
  if (interval === '1d' || interval === 'day') {
    endpoint = `https://api.upbit.com/v1/candles/days?market=${encodeURIComponent(market)}&count=${count}`;
  } else if (interval === '1h' || interval === '60m') {
    endpoint = `https://api.upbit.com/v1/candles/minutes/60?market=${encodeURIComponent(market)}&count=${count}`;
  } else {
    endpoint = `https://api.upbit.com/v1/candles/minutes/5?market=${encodeURIComponent(market)}&count=${count}`;
  }
  const r = await httpsGet(endpoint, { timeoutMs: 8000 });
  if (!r.ok) return { ok: false, error: `upbit http ${r.status}`, source: 'upbit' };
  try {
    const arr = JSON.parse(r.body);
    if (!Array.isArray(arr)) return { ok: false, error: 'not array' };
    const points = arr
      .map(it => ({ t: new Date(it.candle_date_time_utc + 'Z').getTime(), c: it.trade_price }))
      .sort((a, b) => a.t - b.t);
    return { ok: true, points, currency: 'KRW', source: 'upbit' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function fetchNaverHistory(code, range) {
  const sym = /^\d{6}$/.test(code) ? `${code}.KS` : code;
  const out = await fetchYahooHistory(sym, range.days > 180 ? '1d' : '1d', range.yahooRange);
  if (out.ok && out.points.length) return { ...out, source: 'yahoo-ks' };
  if (/^\d{6}$/.test(code)) {
    const out2 = await fetchYahooHistory(`${code}.KQ`, '1d', range.yahooRange);
    if (out2.ok && out2.points.length) return { ...out2, source: 'yahoo-kq' };
  }
  return out;
}

async function handleHistory(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'GET only' });
  const url = new URL(req.url, 'http://x');
  const type = url.searchParams.get('type') || '';
  const ticker = url.searchParams.get('ticker') || '';
  const range = url.searchParams.get('range') || '1mo';
  if (!ticker || !/^[A-Za-z0-9._\-^]+$/.test(ticker) || ticker.length > 20) {
    return reply(res, 400, { ok: false, error: 'invalid ticker' });
  }
  const rangeMap = {
    '1d':  { yahooRange: '1d',   yahooInterval: '5m',  days: 1   },
    '1w':  { yahooRange: '5d',   yahooInterval: '30m', days: 7   },
    '1mo': { yahooRange: '1mo',  yahooInterval: '1d',  days: 30  },
    '3mo': { yahooRange: '3mo',  yahooInterval: '1d',  days: 90  },
    '6mo': { yahooRange: '6mo',  yahooInterval: '1d',  days: 180 },
    '1y':  { yahooRange: '1y',   yahooInterval: '1d',  days: 365 },
    '5y':  { yahooRange: '5y',   yahooInterval: '1wk', days: 1825 },
  };
  const rg = rangeMap[range] || rangeMap['1mo'];

  let result;
  try {
    if (type === 'stock_us') {
      result = await fetchYahooHistory(ticker.toUpperCase(), rg.yahooInterval, rg.yahooRange);
    } else if (type === 'stock_kr') {
      result = await fetchNaverHistory(ticker, rg);
    } else if (type === 'crypto') {
      if (ticker.startsWith('KRW-')) {
        const upInterval = rg.days <= 1 ? '5m' : (rg.days <= 7 ? '1h' : '1d');
        result = await fetchUpbitHistory(ticker, upInterval, rg);
        if (!result.ok || !result.points.length) {
          const bare = ticker.replace(/^KRW-/, '');
          const yh = await fetchYahooHistory(`${bare}-USD`, rg.yahooInterval, rg.yahooRange);
          if (yh.ok) result = { ...yh, source: 'yahoo-crypto-fallback' };
        }
      } else if (ticker.endsWith('-USD')) {
        result = await fetchYahooHistory(ticker, rg.yahooInterval, rg.yahooRange);
      } else {
        result = { ok: false, error: 'unknown crypto ticker format' };
      }
    } else if (type === 'index') {
      const sym = INDEX_SYMBOL_MAP[ticker] || ticker;
      result = await fetchYahooHistory(sym, rg.yahooInterval, rg.yahooRange);
    } else {
      return reply(res, 400, { ok: false, error: 'invalid type' });
    }
  } catch (e) {
    return reply(res, 500, { ok: false, error: e.message });
  }
  if (!result || !result.ok) {
    return reply(res, 200, { ok: false, error: result?.error || 'no data', ticker, type });
  }
  reply(res, 200, {
    ok: true,
    ticker, type, range,
    currency: result.currency || 'USD',
    source: result.source || 'yahoo',
    points: result.points || [],
  });
}

async function fetchYahoo(symbols) {
  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
    const r = await httpsGet(url);
    if (!r.ok) {
      logLine('warn', 'yahoo.http', { sym, status: r.status, err: r.error || null });
      return;
    }
    try {
      const j = JSON.parse(r.body);
      const result = j?.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta) return;
      const price = meta.regularMarketPrice ?? meta.chartPreviousClose;
      if (price == null) return;
      out[sym] = {
        price,
        currency: meta.currency || 'USD',
        ts: nowKST(),
        source: 'yahoo',
        previousClose: meta.chartPreviousClose ?? null,
        name: meta.longName || meta.shortName || null,
      };
    } catch (e) {
      logLine('warn', 'yahoo.parse', { sym, err: String(e) });
    }
  }));
  return out;
}

const INDEX_SYMBOL_MAP = {
  KOSPI: '^KS11',
  KOSDAQ: '^KQ11',
  NASDAQ: '^IXIC',
  SP500: '^GSPC',
  DOW: '^DJI',
  NIKKEI: '^N225',
  HANGSENG: '^HSI',
  SHANGHAI: '000001.SS',
  RUSSELL: '^RUT',
  GOLD: 'GC=F',
  WTI: 'CL=F',
  USDKRW: 'KRW=X',
};

async function handleQuotes(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
  let body;
  try { body = JSON.parse((await readBody(req)) || '{}'); }
  catch { return reply(res, 400, { ok: false, error: 'invalid json' }); }
  const tickers = Array.isArray(body.tickers) ? body.tickers : [];
  // 공개 인스턴스 남용 방지 — 한 요청당 티커 제한.
  if (tickers.length > 200) return reply(res, 400, { ok: false, error: 'too many tickers (max 200)' });

  const isUsdCrypto = (t) => t?.type === 'crypto' && typeof t.ticker === 'string' && t.ticker.endsWith('-USD');
  const needFx = tickers.some(t => t?.type === 'stock_us' || isUsdCrypto(t));

  const cache = readJSON(QUOTE_CACHE_FILE, { updatedAt: '', quotes: {} });
  const TTL = { crypto: 10_000, stock_kr: 30_000, stock_us: 60_000, fx: 60_000, index: 60_000 };
  const now = Date.now();
  const freshEnough = (entry, ttl) => entry && entry.ts && (now - new Date(entry.ts).getTime() < ttl);

  const needUpbit = [];
  const needNaver = [];
  const needYahoo = [];
  const indexYahooToAlias = {};
  for (const t of tickers) {
    if (!t || typeof t.ticker !== 'string') continue;
    const tk = t.ticker;
    if (!SAFE_TICKER_RE.test(tk)) continue;
    if (t.type === 'crypto') {
      if (tk.startsWith('KRW-')) {
        if (!freshEnough(cache.quotes[tk], TTL.crypto)) needUpbit.push(tk);
      } else if (tk.endsWith('-USD')) {
        if (!freshEnough(cache.quotes[tk], TTL.crypto)) needYahoo.push(tk);
      }
    } else if (t.type === 'stock_kr' && !freshEnough(cache.quotes[tk], TTL.stock_kr)) needNaver.push(tk);
    else if (t.type === 'stock_us' && !freshEnough(cache.quotes[tk], TTL.stock_us)) needYahoo.push(tk);
    else if (t.type === 'index') {
      const sym = INDEX_SYMBOL_MAP[tk] || tk;
      indexYahooToAlias[sym] = tk;
      if (!freshEnough(cache.quotes[tk], TTL.index)) needYahoo.push(sym);
    }
  }
  if (needFx && !freshEnough(cache.quotes['USDKRW'], TTL.fx)) needYahoo.push('KRW=X');

  const [upbitRes, naverRes, yahooRes] = await Promise.all([
    needUpbit.length ? fetchUpbit(needUpbit) : Promise.resolve({}),
    needNaver.length ? fetchNaver(needNaver) : Promise.resolve({}),
    needYahoo.length ? fetchYahoo(needYahoo) : Promise.resolve({}),
  ]);

  for (const [k, v] of Object.entries(upbitRes)) cache.quotes[k] = v;
  for (const [k, v] of Object.entries(naverRes)) cache.quotes[k] = v;
  for (const [k, v] of Object.entries(yahooRes)) {
    if (k === 'KRW=X') {
      cache.quotes['USDKRW'] = {
        rate: v.price,
        previousClose: v.previousClose,
        changePct: v.previousClose ? ((v.price - v.previousClose) / v.previousClose) * 100 : null,
        ts: v.ts,
        source: 'yahoo',
      };
      if (indexYahooToAlias[k]) cache.quotes[indexYahooToAlias[k]] = cache.quotes['USDKRW'];
    } else if (indexYahooToAlias[k]) {
      cache.quotes[indexYahooToAlias[k]] = {
        price: v.price,
        previousClose: v.previousClose,
        changePct: v.previousClose ? ((v.price - v.previousClose) / v.previousClose) * 100 : null,
        currency: v.currency,
        ts: v.ts,
        source: 'yahoo-index',
        name: v.name,
      };
    } else {
      cache.quotes[k] = v;
    }
  }
  cache.updatedAt = nowKST();
  writeJSON(QUOTE_CACHE_FILE, cache);

  const out = {};
  for (const t of tickers) {
    if (!t || typeof t.ticker !== 'string') continue;
    if (cache.quotes[t.ticker]) out[t.ticker] = cache.quotes[t.ticker];
  }
  const fx = cache.quotes['USDKRW'] || null;
  reply(res, 200, { ok: true, quotes: out, exchangeRate: fx, cacheUpdatedAt: cache.updatedAt });
}

async function handleImportPdf(req, res) {
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'POST only' });
  if (!parsePdfBuffer) {
    return reply(res, 503, { ok: false, error: 'PDF 파서가 이 서버에서 비활성 상태입니다.' });
  }
  let buffer;
  try {
    buffer = await readBodyBytes(req);
  } catch (e) {
    return reply(res, 413, { ok: false, error: e.message });
  }
  if (!buffer || buffer.length < 100) {
    return reply(res, 400, { ok: false, error: '빈 요청 본문' });
  }
  const magic = buffer.slice(0, 5).toString('latin1');
  if (!magic.startsWith('%PDF-')) {
    return reply(res, 400, { ok: false, error: 'PDF 파일이 아닙니다 (헤더 불일치)' });
  }
  const password = typeof req.headers['x-pdf-password'] === 'string' ? req.headers['x-pdf-password'] : '';
  try {
    const result = await parsePdfBuffer(buffer, password);
    if (!result.ok) {
      logLine('warn', 'pdf.parse.fail', { error: result.error, hint: result.hint || null });
      return reply(res, 200, result);
    }
    logLine('info', 'pdf.parse.ok', {
      format: result.format,
      accounts: (result.accounts || []).length,
      warnings: (result.warnings || []).length,
    });
    reply(res, 200, result);
  } catch (e) {
    logLine('error', 'pdf.parse.exception', { err: String(e) });
    reply(res, 500, { ok: false, error: `서버 오류: ${e.message}` });
  }
}

async function handleEvents(req, res) {
  if (req.method !== 'GET') {
    return reply(res, 403, { ok: false, error: 'public deployment: events are read-only' });
  }
  const data = readJSON(EVENTS_FILE, { version: 2, events: [] });
  if (Array.isArray(data.events)) {
    for (const e of data.events) {
      if (e && e.category == null) e.category = inferCategory(e);
    }
  }
  return reply(res, 200, { ok: true, ...data });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.pdf':  'application/pdf',
  '.woff2':'font/woff2',
};

const server = http.createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

    // 헬스체크 — Render 는 / 를 보내고 200 이면 OK 로 판정.
    if (urlPath === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    if (urlPath === '/api/quotes')        return await handleQuotes(req, res);
    if (urlPath === '/api/events')        return await handleEvents(req, res);
    if (urlPath === '/api/history')       return await handleHistory(req, res);
    if (urlPath === '/api/import-pdf')    return await handleImportPdf(req, res);

    // 기기 간 동기화 (텔레그램 봇 기반)
    if (urlPath === '/api/sync/status')      return await handleSyncStatus(req, res);
    if (urlPath === '/api/sync/init')        return await handleSyncInit(req, res);
    if (urlPath === '/api/sync/check')       return await handleSyncCheck(req, res);
    if (urlPath === '/api/sync/confirm')     return await handleSyncConfirm(req, res);
    if (urlPath === '/api/sync/push')        return await handleSyncPush(req, res);
    if (urlPath === '/api/sync/pull')        return await handleSyncPull(req, res);
    if (urlPath === '/api/sync/disconnect')  return await handleSyncDisconnect(req, res);

    // 공개 배포판에서 차단되는 쓰기 엔드포인트 — 클라이언트가 실수로 호출해도 안전하게 반환.
    if (urlPath === '/api/accounts' ||
        urlPath === '/api/transactions' ||
        urlPath === '/api/snapshot' ||
        urlPath === '/api/snapshots') {
      return reply(res, 410, {
        ok: false,
        error: 'disabled-on-public',
        hint: '이 엔드포인트는 배포판에서 비활성. 개인 데이터는 브라우저 localStorage 에 저장됩니다.',
      });
    }

    // 정적 파일: data/ 폴더는 서빙 금지 (quote-cache, events 같은 민감한 원본 노출 방지).
    // data 내용은 전용 API 를 통해서만 접근 가능.
    if (/^\/data(\/|$)/.test(urlPath)) {
      res.writeHead(403); return res.end('Forbidden');
    }

    const target = path.normalize(path.join(root, urlPath === '/' ? '/index.html' : urlPath));
    if (!target.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
    if (!fs.existsSync(target))   { res.writeHead(404); return res.end('Not Found'); }

    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      const idx = path.join(target, 'index.html');
      if (fs.existsSync(idx)) {
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        return res.end(fs.readFileSync(idx));
      }
      res.writeHead(404); return res.end('Not Found');
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(target).pipe(res);
  } catch (err) {
    res.writeHead(500);
    res.end('Server Error: ' + err.message);
  }
});

// 공개 배포판은 외부 IP 에 바인딩해야 함 (Render 는 0.0.0.0 필수).
server.listen(port, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   Seed (Liquid Ledger) — Public Edition   ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║   Listening on port ${String(port).padEnd(20, ' ')}║`);
  console.log('  ║   개인 데이터는 브라우저 localStorage      ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  데이터 폴더: ${DATA_DIR}`);
  console.log('');
});

process.on('unhandledRejection', (err) => {
  logLine('error', 'unhandledRejection', { err: String(err && err.stack || err) });
});
process.on('uncaughtException', (err) => {
  logLine('error', 'uncaughtException', { err: String(err && err.stack || err) });
});

// ---------- 백그라운드 시세 자동 폴링 (공유 캐시 예열) ----------
// 공개 인스턴스에서는 사용자별 티커를 알 수 없으므로, data/popular-tickers.json 목록의 시세를
// 주기적으로 캐시해둔다. 첫 방문자도 즉시 시세를 볼 수 있도록 캐시를 뜨겁게 유지하는 게 목적.
const AUTO_POLL_MS = 120_000; // 2분 간격

async function autoPollQuotes() {
  try {
    const cfg = readJSON(POPULAR_TICKERS_FILE, { tickers: [] });
    const tickers = Array.isArray(cfg.tickers) ? cfg.tickers : [];
    if (!tickers.length) return;
    const cache = readJSON(QUOTE_CACHE_FILE, { updatedAt: '', quotes: {} });
    const TTL = { crypto: 10_000, stock_kr: 30_000, stock_us: 60_000, fx: 60_000, index: 60_000 };
    const now = Date.now();
    const freshEnough = (e, ttl) => e && e.ts && (now - new Date(e.ts).getTime() < ttl);
    const needUpbit = [], needNaver = [], needYahoo = [];
    const indexYahooToAlias = {};
    let needFx = false;
    for (const t of tickers) {
      const tk = t.ticker;
      if (!tk || !SAFE_TICKER_RE.test(tk)) continue;
      if (t.type === 'crypto') {
        if (tk.startsWith('KRW-')) {
          if (!freshEnough(cache.quotes[tk], TTL.crypto)) needUpbit.push(tk);
        } else if (tk.endsWith('-USD')) {
          if (!freshEnough(cache.quotes[tk], TTL.crypto)) needYahoo.push(tk);
        }
      } else if (t.type === 'stock_kr' && !freshEnough(cache.quotes[tk], TTL.stock_kr)) needNaver.push(tk);
      else if (t.type === 'stock_us') {
        needFx = true;
        if (!freshEnough(cache.quotes[tk], TTL.stock_us)) needYahoo.push(tk);
      } else if (t.type === 'index') {
        const sym = INDEX_SYMBOL_MAP[tk] || tk;
        indexYahooToAlias[sym] = tk;
        if (!freshEnough(cache.quotes[tk], TTL.index)) needYahoo.push(sym);
      }
    }
    if (needFx && !freshEnough(cache.quotes['USDKRW'], TTL.fx)) needYahoo.push('KRW=X');
    if (!needUpbit.length && !needNaver.length && !needYahoo.length) return;

    const [up, nv, yh] = await Promise.all([
      needUpbit.length ? fetchUpbit(needUpbit) : Promise.resolve({}),
      needNaver.length ? fetchNaver(needNaver) : Promise.resolve({}),
      needYahoo.length ? fetchYahoo(needYahoo) : Promise.resolve({}),
    ]);
    for (const [k, v] of Object.entries(up)) cache.quotes[k] = v;
    for (const [k, v] of Object.entries(nv)) cache.quotes[k] = v;
    for (const [k, v] of Object.entries(yh)) {
      if (k === 'KRW=X') {
        cache.quotes['USDKRW'] = {
          rate: v.price, previousClose: v.previousClose,
          changePct: v.previousClose ? ((v.price - v.previousClose) / v.previousClose) * 100 : null,
          ts: v.ts, source: 'yahoo',
        };
      } else if (indexYahooToAlias[k]) {
        cache.quotes[indexYahooToAlias[k]] = {
          price: v.price,
          previousClose: v.previousClose,
          changePct: v.previousClose ? ((v.price - v.previousClose) / v.previousClose) * 100 : null,
          currency: v.currency,
          ts: v.ts,
          source: 'yahoo-index',
          name: v.name,
        };
      } else {
        cache.quotes[k] = v;
      }
    }
    cache.updatedAt = nowKST();
    writeJSON(QUOTE_CACHE_FILE, cache);
    logLine('info', 'autopoll.ok', {
      upbit: Object.keys(up).length,
      naver: Object.keys(nv).length,
      yahoo: Object.keys(yh).length,
    });
  } catch (e) {
    logLine('error', 'autopoll.fail', { err: String(e && e.stack || e) });
  }
}

setTimeout(autoPollQuotes, 5_000);
setInterval(autoPollQuotes, AUTO_POLL_MS);

// ---------- 경제 캘린더 자동 수집 (토스증권 공개 API) ----------
// 토스증권이 토스인베스트 캘린더 페이지에서 공개로 노출하는 "이번 주 핵심 이벤트"
// AI 큐레이션 엔드포인트를 그대로 사용한다. 이미 토스 측에서 중요도 높은 항목만
// 선별되어 있어서 앞의 Top 5 만 추려 events.json 에 덮어쓴다.
//
//   GET https://wts-info-api.tossinvest.com/api/v1/calendar/ai-summary/key-events
//     → result.eci.indicators[]  경제지표 (한국어 title 포함)
//     → result.earnings[]        실적 발표 (한국어 회사명 포함)
//
// 실패하면 기존 events.json 은 그대로 둔다 (프런트가 빈 목록을 보지 않도록 보수적 처리).
const TOSS_CALENDAR_URL = 'https://wts-info-api.tossinvest.com/api/v1/calendar/ai-summary/key-events';
const EVENTS_REFRESH_MS = 6 * 60 * 60 * 1000; // 6시간
const EVENTS_TOP_N = 5;

function todayKST() {
  return nowKST().slice(0, 10);
}

function slugifyRic(ric) {
  return String(ric || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 14) || 'evt';
}

async function fetchTossKeyEvents() {
  const r = await httpsGet(TOSS_CALENDAR_URL, {
    timeoutMs: 8000,
    headers: {
      'Referer': 'https://www.tossinvest.com/calendar',
      'Origin':  'https://www.tossinvest.com',
    },
  });
  if (!r.ok) {
    logLine('warn', 'toss.calendar.http', { status: r.status });
    return null;
  }
  let j;
  try { j = JSON.parse(r.body); }
  catch (e) { logLine('warn', 'toss.calendar.parse', { err: String(e) }); return null; }

  const events = [];

  // 경제지표
  const indicators = Array.isArray(j?.result?.eci?.indicators) ? j.result.eci.indicators : [];
  for (const i of indicators) {
    if (!i || !i.eciActDt || !i.title) continue;
    const date = String(i.eciActDt).slice(0, 10);
    if (!SAFE_DATE_RE.test(date)) continue;
    const timeHHMM = /^\d{2}:\d{2}/.test(i.actValNs || '') ? String(i.actValNs).slice(0, 5) : '';
    const country = String(i.ric || '').slice(0, 2).toUpperCase();
    const tag = /^[A-Z]{2}$/.test(country) ? country : '지표';
    let unitSuffix = '';
    if (i.displayUnit) unitSuffix = i.displayUnit;
    else if (i.unit === 'Percent') unitSuffix = '%';
    const hist = (i.historical != null) ? `이전 ${i.historical}${unitSuffix ? ' ' + unitSuffix : ''}`.trim() : '';
    events.push({
      id: `ev-${date.replace(/-/g, '')}-${slugifyRic(i.ric)}`,
      date,
      title: timeHHMM ? `${i.title} (${timeHHMM} KST)` : i.title,
      category: 'economic',
      importance: 'high',
      tag,
      note: hist,
    });
  }

  // 실적 발표
  const earnings = Array.isArray(j?.result?.earnings) ? j.result.earnings : [];
  for (const e of earnings) {
    if (!e || !e.announceDateTime || !e.companyName) continue;
    const date = String(e.announceDateTime).slice(0, 10);
    if (!SAFE_DATE_RE.test(date)) continue;
    const ms = String(e.announceMarketStatus || '');
    const marketCountry = ms.split('_')[0] === 'KR' ? 'kr' : 'us';
    const statusText = e.announceMarketStatusText ? ` (${e.announceMarketStatusText})` : '';
    const code = String(e.companyCode || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toLowerCase();
    const noteBits = [];
    if (e.operatingProfitEstDisplay) noteBits.push(`영업이익 예상 ${e.operatingProfitEstDisplay}`);
    if (e.salesEstDisplay) noteBits.push(`매출 예상 ${e.salesEstDisplay}`);
    events.push({
      id: `ev-${date.replace(/-/g, '')}-${marketCountry}${code || 'co'}`,
      date,
      title: `${e.companyName} 실적 발표${statusText}`,
      category: 'earnings',
      importance: 'critical',
      tag: '실적',
      note: noteBits.join(' · '),
    });
  }

  return events;
}

async function refreshEvents() {
  try {
    const fresh = await fetchTossKeyEvents();
    if (!fresh || !fresh.length) {
      logLine('warn', 'events.refresh.empty');
      return;
    }
    const today = todayKST();
    const upcoming = fresh
      .filter(e => e.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, EVENTS_TOP_N);

    if (!upcoming.length) {
      logLine('warn', 'events.refresh.no-upcoming', { total: fresh.length });
      return;
    }

    writeJSON(EVENTS_FILE, {
      version: 2,
      updatedAt: nowKST(),
      source: 'toss-invest-ai-key-events',
      events: upcoming,
    });
    logLine('info', 'events.refresh.ok', { count: upcoming.length, first: upcoming[0].date, last: upcoming[upcoming.length - 1].date });
  } catch (e) {
    logLine('error', 'events.refresh.fail', { err: String(e && e.stack || e) });
  }
}

setTimeout(refreshEvents, 10_000);
setInterval(refreshEvents, EVENTS_REFRESH_MS);

// ============================================================================
// 기기 간 동기화 (Telegram 봇을 클라우드 저장소로)
// ----------------------------------------------------------------------------
// 사용자가 텔레그램에서 봇과 채팅을 시작 → 봇이 사용자의 채팅에 자산 데이터를
// JSON 파일로 보내고 핀(고정) → 다른 기기에서 같은 텔레그램 계정으로 페어링하면
// 핀된 메시지를 다시 받아 복원. Render 무료 플랜의 휘발성 디스크 문제를 피해서
// 서버는 stateless 로 동작. 사용자 데이터는 자기 텔레그램 클라우드에만 보관.
// ============================================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const SYNC_ENABLED = !!TELEGRAM_BOT_TOKEN;
let TELEGRAM_BOT_USERNAME = '';   // 부팅 시 getMe 로 채움
const SYNC_SECRET = SYNC_ENABLED
  ? crypto.createHash('sha256').update(TELEGRAM_BOT_TOKEN + ':seed-sync-v1').digest('hex')
  : null;

const SYNC_PAIR_TTL_MS = 8 * 60 * 1000;     // 1단계: 6자리 코드 만료 (텔레그램에서 /start 누르기 전까지)
const SYNC_CONFIRM_TTL_MS = 5 * 60 * 1000;  // 2단계: 4자리 확인 만료 (텔레그램에서 /start 누른 뒤부터)
const SYNC_CONFIRM_MAX_ATTEMPTS = 3;        // 4자리 오답 허용 횟수
const SYNC_POLL_TTL_MS = 8 * 60 * 1000;     // 페어링 폴링 워커 수명
const SYNC_MAX_BODY = 4 * 1024 * 1024;      // 4MB (텔레그램 sendDocument 한도 50MB 와는 별개로 클라가 보내는 JSON 한도)

const pendingPairs = new Map();             // code -> { createdAt, chatId? , userName? }
let syncPollerActive = false;
let syncPollerOffset = 0;

function tgPostJson(method, body) {
  return new Promise((resolve, reject) => {
    if (!SYNC_ENABLED) return reject(new Error('TELEGRAM_BOT_TOKEN not set'));
    const json = Buffer.from(JSON.stringify(body || {}));
    const opts = {
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': json.length },
      timeout: 30_000,
    };
    const r = https.request(opts, (resp) => {
      let buf = '';
      resp.on('data', (c) => { buf += c.toString('utf8'); });
      resp.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j.ok) resolve(j.result);
          else reject(new Error(`telegram ${method}: ${j.description || resp.statusCode}`));
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { try { r.destroy(new Error('telegram timeout')); } catch {} });
    r.write(json); r.end();
  });
}

function tgPostMultipart(method, fields, fileField, fileName, fileBuffer, contentType) {
  return new Promise((resolve, reject) => {
    if (!SYNC_ENABLED) return reject(new Error('TELEGRAM_BOT_TOKEN not set'));
    const boundary = '----seed' + crypto.randomBytes(8).toString('hex');
    const parts = [];
    for (const [k, v] of Object.entries(fields || {})) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(v)}\r\n`,
        'utf8'));
    }
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      'utf8'));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
    const body = Buffer.concat(parts);
    const opts = {
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${TELEGRAM_BOT_TOKEN}/${method}`,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      timeout: 60_000,
    };
    const r = https.request(opts, (resp) => {
      let buf = '';
      resp.on('data', (c) => { buf += c.toString('utf8'); });
      resp.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j.ok) resolve(j.result);
          else reject(new Error(`telegram ${method}: ${j.description || resp.statusCode}`));
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => { try { r.destroy(new Error('telegram timeout')); } catch {} });
    r.write(body); r.end();
  });
}

function tgDownloadFile(filePath) {
  return new Promise((resolve, reject) => {
    const opts = {
      method: 'GET',
      hostname: 'api.telegram.org',
      path: `/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`,
      timeout: 30_000,
    };
    const r = https.request(opts, (resp) => {
      if (resp.statusCode !== 200) {
        reject(new Error('download status ' + resp.statusCode));
        resp.resume(); return;
      }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve(Buffer.concat(chunks)));
    });
    r.on('error', reject);
    r.on('timeout', () => { try { r.destroy(new Error('download timeout')); } catch {} });
    r.end();
  });
}

function signCred(chatId) {
  const sig = crypto.createHmac('sha256', SYNC_SECRET).update(String(chatId)).digest('hex').slice(0, 32);
  return `${chatId}:${sig}`;
}
function verifyCred(s) {
  if (!s || typeof s !== 'string' || !s.includes(':')) return null;
  const idx = s.lastIndexOf(':');
  const chatId = s.slice(0, idx);
  const sig = s.slice(idx + 1);
  if (!/^-?\d{1,20}$/.test(chatId)) return null;
  const expected = crypto.createHmac('sha256', SYNC_SECRET).update(chatId).digest('hex').slice(0, 32);
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch { return null; }
  return chatId;
}

function newPairCode() {
  for (let i = 0; i < 20; i++) {
    const c = String(Math.floor(100000 + Math.random() * 900000));
    if (!pendingPairs.has(c)) return c;
  }
  return null;
}

function gcPendingPairs() {
  const now = Date.now();
  for (const [k, v] of pendingPairs) {
    if (v.confirmCreatedAt) {
      // 2단계 (4자리 확인 대기) 만료
      if (now - v.confirmCreatedAt > SYNC_CONFIRM_TTL_MS) pendingPairs.delete(k);
    } else {
      // 1단계 (6자리 코드 발급, /start 대기) 만료
      if (now - v.createdAt > SYNC_PAIR_TTL_MS) pendingPairs.delete(k);
    }
  }
}

async function startPairingPoller() {
  if (syncPollerActive) return;
  syncPollerActive = true;
  const stopAt = Date.now() + SYNC_POLL_TTL_MS;
  logLine('info', 'tg.poll.start');
  try {
    while (syncPollerActive && Date.now() < stopAt && pendingPairs.size > 0) {
      try {
        const updates = await tgPostJson('getUpdates', {
          offset: syncPollerOffset || undefined,
          timeout: 25,
          allowed_updates: ['message'],
        });
        for (const u of (updates || [])) {
          if (u.update_id >= syncPollerOffset) syncPollerOffset = u.update_id + 1;
          const msg = u.message;
          if (!msg || !msg.text || !msg.chat) continue;
          const m = /^\/start\s+link_(\d{6})\b/.exec(msg.text);
          if (!m) continue;
          const code = m[1];
          const pair = pendingPairs.get(code);
          if (!pair) {
            // 만료/잘못된 코드
            try {
              await tgPostJson('sendMessage', {
                chat_id: msg.chat.id,
                text: '⚠️ 페어링 코드가 만료됐거나 유효하지 않습니다. 앱에서 새 코드를 받아주세요.',
              });
            } catch {}
            continue;
          }
          pair.chatId = String(msg.chat.id);
          pair.userName = msg.from?.first_name || msg.chat?.first_name || '';
          pair.pairedAt = Date.now();
          // 2단계: 4자리 확인 코드 발급 (어깨너머 도용 차단)
          pair.confirmCode = String(1000 + Math.floor(Math.random() * 9000));
          pair.confirmCreatedAt = Date.now();
          pair.confirmAttempts = 0;
          pendingPairs.set(code, pair);
          try {
            await tgPostJson('sendMessage', {
              chat_id: msg.chat.id,
              text: `🔐 Seed Ledger 페어링 확인 코드\n\n*${pair.confirmCode}*\n\n앱에 이 4자리를 5분 안에 입력해주세요. 본인이 시작한 페어링이 아니라면 그냥 무시하시면 자동으로 폐기됩니다.`,
              parse_mode: 'Markdown',
            });
          } catch (e) {
            logLine('warn', 'tg.pair.confirm-send-fail', { err: String(e) });
            // 메시지 못 보낸 경우 페어링 폐기 (사용자가 4자리 못 받음 → 입력 불가)
            pendingPairs.delete(code);
            continue;
          }
          logLine('info', 'tg.pair.confirm-sent', { code, chatId: pair.chatId });
        }
        gcPendingPairs();
      } catch (e) {
        logLine('warn', 'tg.poll.iter', { err: String(e) });
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  } finally {
    syncPollerActive = false;
    logLine('info', 'tg.poll.stop', { remaining: pendingPairs.size });
  }
}

async function bootTelegram() {
  if (!SYNC_ENABLED) {
    logLine('info', 'sync.disabled', { reason: 'TELEGRAM_BOT_TOKEN env var not set' });
    return;
  }
  try {
    const me = await tgPostJson('getMe', {});
    TELEGRAM_BOT_USERNAME = me.username || '';
    // 다른 인스턴스가 webhook 을 걸어둔 적 있다면 폴링이 막혀서 충돌. 보장 차원에서 webhook 해제.
    try { await tgPostJson('deleteWebhook', { drop_pending_updates: false }); } catch {}
    logLine('info', 'sync.enabled', { bot: TELEGRAM_BOT_USERNAME });
  } catch (e) {
    logLine('error', 'sync.boot.fail', { err: String(e) });
  }
}
setTimeout(bootTelegram, 2000);

// ---------- /api/sync/* 핸들러 ----------

async function handleSyncStatus(req, res) {
  return reply(res, 200, {
    ok: true,
    enabled: SYNC_ENABLED,
    bot: TELEGRAM_BOT_USERNAME || null,
  });
}

async function handleSyncInit(req, res) {
  if (!SYNC_ENABLED) return reply(res, 503, { ok: false, error: 'sync-disabled', hint: '서버에 TELEGRAM_BOT_TOKEN 이 설정되지 않음.' });
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method' });
  if (!TELEGRAM_BOT_USERNAME) {
    try { await bootTelegram(); } catch {}
    if (!TELEGRAM_BOT_USERNAME) return reply(res, 503, { ok: false, error: 'bot-not-ready' });
  }
  gcPendingPairs();
  const code = newPairCode();
  if (!code) return reply(res, 503, { ok: false, error: 'too-many-pending' });
  pendingPairs.set(code, { createdAt: Date.now() });
  startPairingPoller().catch(() => {});
  return reply(res, 200, {
    ok: true,
    code,
    bot: TELEGRAM_BOT_USERNAME,
    deepLink: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=link_${code}`,
    expiresInSec: Math.floor(SYNC_PAIR_TTL_MS / 1000),
  });
}

async function handleSyncCheck(req, res) {
  if (!SYNC_ENABLED) return reply(res, 503, { ok: false, error: 'sync-disabled' });
  const url = new URL(req.url, 'http://localhost');
  const code = url.searchParams.get('code') || '';
  if (!/^\d{6}$/.test(code)) return reply(res, 400, { ok: false, error: 'bad-code' });
  gcPendingPairs();
  const pair = pendingPairs.get(code);
  if (!pair) return reply(res, 404, { ok: false, error: 'expired' });
  if (!pair.chatId) {
    // 1단계 대기 — 텔레그램에서 /start 아직 안 누름
    return reply(res, 200, { ok: true, paired: false });
  }
  if (pair.confirmCode) {
    // 2단계 진입 — 텔레그램으로 4자리 코드 갔고, 사용자 입력 대기 중
    const elapsed = Date.now() - (pair.confirmCreatedAt || 0);
    return reply(res, 200, {
      ok: true,
      paired: false,
      awaitingConfirm: true,
      confirmExpiresInSec: Math.max(0, Math.floor((SYNC_CONFIRM_TTL_MS - elapsed) / 1000)),
    });
  }
  // 백워드 호환: confirmCode 없이 chatId 만 세팅된 경우 (구버전 페어 — 기능적으로 폐기)
  pendingPairs.delete(code);
  return reply(res, 200, {
    ok: true,
    paired: true,
    cred: signCred(pair.chatId),
    chatId: pair.chatId,
    userName: pair.userName || '',
  });
}

// 4자리 확인 코드 검증 → 일치 시 cred 발급, 불일치 시 시도 카운터 증가, 3회 초과 시 폐기.
async function handleSyncConfirm(req, res) {
  if (!SYNC_ENABLED) return reply(res, 503, { ok: false, error: 'sync-disabled' });
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method' });
  let body;
  try { body = await readBody(req, 1024); }
  catch { return reply(res, 400, { ok: false, error: 'bad-body' }); }
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { return reply(res, 400, { ok: false, error: 'bad-json' }); }
  const code = String(parsed.code || '');
  const confirm = String(parsed.confirm || '');
  if (!/^\d{6}$/.test(code)) return reply(res, 400, { ok: false, error: 'bad-code' });
  if (!/^\d{4}$/.test(confirm)) return reply(res, 400, { ok: false, error: 'bad-confirm-format' });

  gcPendingPairs();
  const pair = pendingPairs.get(code);
  if (!pair || !pair.confirmCode) {
    return reply(res, 404, { ok: false, error: 'no-pending-confirm' });
  }
  // 만료 (gc 가 잡지 못한 경계 케이스)
  if (Date.now() - pair.confirmCreatedAt > SYNC_CONFIRM_TTL_MS) {
    pendingPairs.delete(code);
    return reply(res, 410, { ok: false, error: 'confirm-expired' });
  }
  pair.confirmAttempts = (pair.confirmAttempts || 0) + 1;

  // 일치
  if (confirm === pair.confirmCode) {
    pendingPairs.delete(code);
    const cred = signCred(pair.chatId);
    // 텔레그램에 완료 알림 (실패해도 cred 는 발급)
    tgPostJson('sendMessage', {
      chat_id: pair.chatId,
      text: `✅ Seed Ledger 연동 완료, ${pair.userName || '사용자'}님.\n앞으로 자산 데이터가 이 채팅에 JSON 파일로 안전하게 백업됩니다.`,
    }).catch((e) => logLine('warn', 'tg.confirm.replyfail', { err: String(e) }));
    logLine('info', 'tg.confirm.ok', { code, chatId: pair.chatId, attempts: pair.confirmAttempts });
    return reply(res, 200, {
      ok: true,
      paired: true,
      cred,
      chatId: pair.chatId,
      userName: pair.userName || '',
    });
  }

  // 불일치
  if (pair.confirmAttempts >= SYNC_CONFIRM_MAX_ATTEMPTS) {
    pendingPairs.delete(code);
    tgPostJson('sendMessage', {
      chat_id: pair.chatId,
      text: '⚠️ Seed Ledger 페어링 시도 3회를 초과해 폐기됐습니다. 앱에서 다시 시작해주세요.',
    }).catch(() => {});
    logLine('warn', 'tg.confirm.too-many', { code, chatId: pair.chatId });
    return reply(res, 429, { ok: false, error: 'too-many-attempts' });
  }
  pendingPairs.set(code, pair);
  return reply(res, 200, {
    ok: false,
    error: 'wrong-code',
    remainingAttempts: SYNC_CONFIRM_MAX_ATTEMPTS - pair.confirmAttempts,
  });
}

function getCredFromHeaders(req) {
  const h = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : null;
}

async function handleSyncPush(req, res) {
  if (!SYNC_ENABLED) return reply(res, 503, { ok: false, error: 'sync-disabled' });
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method' });
  const cred = getCredFromHeaders(req);
  const chatId = verifyCred(cred);
  if (!chatId) return reply(res, 401, { ok: false, error: 'bad-cred' });
  let body;
  try { body = await readBody(req, SYNC_MAX_BODY); }
  catch (e) { return reply(res, 413, { ok: false, error: 'too-large' }); }
  let parsed;
  try { parsed = JSON.parse(body); }
  catch { return reply(res, 400, { ok: false, error: 'bad-json' }); }
  // 클라가 보내는 payload 는 그대로 받아서 텔레그램에 다시 JSON 으로 업로드.
  // 무결성 + 시점 메타데이터 추가.
  const payload = {
    schema: 'seed-ledger/v1',
    savedAt: nowKST(),
    payload: parsed,
  };
  const fileBuf = Buffer.from(JSON.stringify(payload), 'utf8');
  const stamp = nowKST().replace(/[^0-9]/g, '').slice(0, 14); // YYYYMMDDHHMMSS
  const filename = `seed-state-${stamp}.json`;
  try {
    const sent = await tgPostMultipart('sendDocument',
      {
        chat_id: chatId,
        caption: `📦 Seed Ledger 자산 백업\n저장 시각: ${payload.savedAt}\n바이트: ${fileBuf.length.toLocaleString('en-US')}`,
        disable_notification: 'true',
      },
      'document', filename, fileBuf, 'application/json',
    );
    // 핀: 가장 최근 백업을 채팅 상단에 고정. 텔레그램은 1회 1핀(직전 핀 자동 해제)이 되므로 unpin 호출 불필요.
    try {
      await tgPostJson('pinChatMessage', {
        chat_id: chatId,
        message_id: sent.message_id,
        disable_notification: true,
      });
    } catch (e) {
      logLine('warn', 'tg.pin.fail', { err: String(e) });
    }
    return reply(res, 200, {
      ok: true,
      messageId: sent.message_id,
      bytes: fileBuf.length,
      savedAt: payload.savedAt,
    });
  } catch (e) {
    logLine('error', 'tg.push.fail', { err: String(e) });
    return reply(res, 502, { ok: false, error: 'telegram-push-failed', detail: String(e.message || e) });
  }
}

async function handleSyncPull(req, res) {
  if (!SYNC_ENABLED) return reply(res, 503, { ok: false, error: 'sync-disabled' });
  if (req.method !== 'POST' && req.method !== 'GET') return reply(res, 405, { ok: false, error: 'method' });
  const cred = getCredFromHeaders(req);
  const chatId = verifyCred(cred);
  if (!chatId) return reply(res, 401, { ok: false, error: 'bad-cred' });
  try {
    const chat = await tgPostJson('getChat', { chat_id: chatId });
    const pinned = chat && chat.pinned_message;
    if (!pinned) return reply(res, 404, { ok: false, error: 'no-backup' });
    const doc = pinned.document;
    if (!doc || !doc.file_id) return reply(res, 404, { ok: false, error: 'no-document' });
    const fileInfo = await tgPostJson('getFile', { file_id: doc.file_id });
    const buf = await tgDownloadFile(fileInfo.file_path);
    let parsed;
    try { parsed = JSON.parse(buf.toString('utf8')); }
    catch (e) { return reply(res, 502, { ok: false, error: 'corrupt-backup' }); }
    return reply(res, 200, {
      ok: true,
      savedAt: parsed.savedAt || null,
      schema: parsed.schema || null,
      payload: parsed.payload != null ? parsed.payload : parsed,
      bytes: buf.length,
    });
  } catch (e) {
    logLine('error', 'tg.pull.fail', { err: String(e) });
    return reply(res, 502, { ok: false, error: 'telegram-pull-failed', detail: String(e.message || e) });
  }
}

async function handleSyncDisconnect(req, res) {
  // 서버 측에는 사용자별 영구 상태가 없으므로, 사실상 클라이언트가 cred 를 폐기하는 것으로 끝.
  // 다만 텔레그램 채팅에서 핀을 해제하는 편의 동작은 제공.
  if (!SYNC_ENABLED) return reply(res, 503, { ok: false, error: 'sync-disabled' });
  if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method' });
  const cred = getCredFromHeaders(req);
  const chatId = verifyCred(cred);
  if (!chatId) return reply(res, 401, { ok: false, error: 'bad-cred' });
  try {
    await tgPostJson('unpinAllChatMessages', { chat_id: chatId }).catch(() => {});
    await tgPostJson('sendMessage', {
      chat_id: chatId,
      text: '🔌 Seed Ledger 연동을 이 기기에서 해제했습니다. 다른 기기에서 다시 페어링하시면 그때까지의 백업이 그대로 복원됩니다.',
    }).catch(() => {});
  } catch {}
  return reply(res, 200, { ok: true });
}
