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
