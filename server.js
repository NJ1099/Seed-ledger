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

// .env 파일 직접 파싱 — zero-deps 정책상 dotenv 패키지 안 씀.
// 기존 process.env 값을 덮어쓰지 않으므로 Render 환경변수가 항상 우선.
function loadDotEnv() {
  const envFile = path.join(root, '.env');
  if (!fs.existsSync(envFile)) return;
  try {
    const raw = fs.readFileSync(envFile, 'utf8').replace(/^﻿/, '');
    let count = 0;
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const [, k, vRaw] = m;
      if (process.env[k] != null && process.env[k] !== '') continue; // 기존 env 우선
      let v = vRaw.trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[k] = v;
      count++;
    }
    if (count) console.log(`[dotenv] .env 에서 ${count}개 환경변수 로드`);
  } catch (e) {
    console.warn('[dotenv] .env 파싱 실패:', e.message);
  }
}
loadDotEnv();

const portArg = process.argv.find(a => /^\d+$/.test(a));
const port = parseInt(process.env.PORT || portArg || '4274', 10);

const DATA_DIR = path.join(root, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const QUOTE_CACHE_FILE = path.join(DATA_DIR, 'quote-cache.json');
const POPULAR_TICKERS_FILE = path.join(DATA_DIR, 'popular-tickers.json');
const STOCK_MASTER_FILE = path.join(DATA_DIR, 'stock-master.json');
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

// POST + JSON body — hyperliquid /info 같은 RPC 스타일 엔드포인트용.
// application/x-www-form-urlencoded POST. KRX 정보데이터시스템 endpoint 가 form-urlencoded 만 받음.
function httpsPostForm(url, formObj, { timeoutMs = 10_000, headers = {} } = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const payload = Buffer.from(
        Object.entries(formObj).map(([k, v]) =>
          encodeURIComponent(k) + '=' + encodeURIComponent(v == null ? '' : String(v))
        ).join('&'),
        'utf8'
      );
      const opts = {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Content-Length': payload.length,
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
      req.write(payload);
      req.end();
    } catch (e) {
      resolve({ ok: false, status: 0, body: '', error: String(e) });
    }
  });
}

function httpsPostJson(url, body, { timeoutMs = 8000, headers = {} } = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const opts = {
        method: 'POST',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          'User-Agent': 'Mozilla/5.0 (seed-ledger/1.0)',
          'Accept': 'application/json',
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
      req.write(payload);
      req.end();
    } catch (e) {
      resolve({ ok: false, status: 0, body: '', error: String(e) });
    }
  });
}

// 원본 바이트로 받아 charset 자동 디코딩 (네이버 finance.naver.com 같은 EUC-KR 페이지용).
// Node 18+ 의 TextDecoder 가 'euc-kr' 라벨을 지원 (ICU full data 빌드).
// 디코딩 실패 시 utf-8 폴백.
function httpsGetBuffer(url, { timeoutMs = 6000, headers = {} } = {}) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const opts = {
        method: 'GET',
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (seed-ledger/1.0)',
          'Accept': 'text/html,application/xhtml+xml,*/*',
          ...headers,
        },
        timeout: timeoutMs,
      };
      const req = https.request(opts, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const buf = Buffer.concat(chunks);
          const ct = String(r.headers['content-type'] || '');
          let charset = (ct.match(/charset=([^;]+)/i) || [, ''])[1].trim().toLowerCase();
          if (!charset && buf.length) {
            // HTML <meta charset> 추정 (처음 1KB)
            const head = buf.slice(0, 1024).toString('latin1');
            const m = head.match(/charset=([\w-]+)/i);
            if (m) charset = m[1].toLowerCase();
          }
          let body = '';
          try {
            const td = new TextDecoder(charset || 'utf-8', { fatal: false });
            body = td.decode(buf);
          } catch {
            body = buf.toString('utf8');
          }
          resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, body, charset: charset || 'utf-8' });
        });
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
  VIX: '^VIX',
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

// ============ STOCK TAB APIS ============
// /api/indices, /api/stock-movers, /api/stock-search, /api/stock-news
// quote-cache.json 의 quotes 객체에 prefixed key (__indices, __movers_kr, __search:..., __news) 로 캐싱.

const STOCK_TAB_TTL = {
  indices: 60_000,
  movers: 60_000,
  search: 60_000,
  news: 300_000,
};

const STOCK_INDICES = [
  { key: 'SPX',    label: 'S&P 500',       symbol: '^GSPC', currency: 'USD' },
  { key: 'NDX',    label: 'NASDAQ',        symbol: '^IXIC', currency: 'USD' },
  { key: 'KOSPI',  label: 'KOSPI',         symbol: '^KS11', currency: 'KRW' },
  { key: 'KOSDAQ', label: 'KOSDAQ',        symbol: '^KQ11', currency: 'KRW' },
  { key: 'VIX',    label: 'VIX (공포지수)', symbol: '^VIX',  currency: 'USD' },
  { key: 'USDKRW', label: '원/달러',        symbol: 'KRW=X', currency: 'KRW' },
  { key: 'WTI',    label: 'WTI 원유',       symbol: 'CL=F',  currency: 'USD' },
  { key: 'GOLD',   label: '금 (Oz)',        symbol: 'GC=F',  currency: 'USD' },
];

function readStockCache() {
  return readJSON(QUOTE_CACHE_FILE, { updatedAt: '', quotes: {} });
}
function writeStockCacheKey(key, payload) {
  const cache = readStockCache();
  cache.quotes[key] = { _ts: Date.now(), payload };
  cache.updatedAt = nowKST();
  try { writeJSON(QUOTE_CACHE_FILE, cache); } catch (e) {
    logLine('warn', 'stock.cache.write', { key, err: String(e) });
  }
}
function getStockCacheEntry(key, ttl) {
  const cache = readStockCache();
  const entry = cache.quotes[key];
  if (!entry || !entry._ts || !entry.payload) return { entry: null, stale: true };
  const stale = (Date.now() - entry._ts) > ttl;
  return { entry, stale };
}

async function handleIndices(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'GET only' });
  const cacheKey = '__indices';
  const { entry, stale } = getStockCacheEntry(cacheKey, STOCK_TAB_TTL.indices);
  if (entry && !stale) {
    return reply(res, 200, { ok: true, ...entry.payload, cached: true });
  }
  const symbols = STOCK_INDICES.map(i => i.symbol);
  const yahoo = await fetchYahoo(symbols);
  const indices = STOCK_INDICES.map(meta => {
    const y = yahoo[meta.symbol];
    if (!y) {
      return {
        key: meta.key, label: meta.label, symbol: meta.symbol, currency: meta.currency,
        price: null, previousClose: null, change: null, changePct: null,
        ts: null, source: 'unavailable',
      };
    }
    const price = y.price;
    const prev = y.previousClose;
    const change = (prev != null && price != null) ? (price - prev) : null;
    const changePct = (prev && prev !== 0 && price != null) ? ((price - prev) / prev) * 100 : null;
    return {
      key: meta.key, label: meta.label, symbol: meta.symbol,
      price, previousClose: prev, change, changePct,
      currency: y.currency || meta.currency,
      ts: y.ts, source: 'yahoo', name: y.name || null,
    };
  });
  const okCount = indices.filter(i => i.price != null).length;
  const payload = { indices, ts: nowKST() };
  if (okCount > 0) {
    writeStockCacheKey(cacheKey, payload);
    logLine('info', 'indices.ok', { count: okCount });
  } else {
    logLine('warn', 'indices.fail', { reason: 'all-symbols-failed' });
    if (entry) return reply(res, 200, { ok: true, ...entry.payload, cached: true, stale: true });
  }
  reply(res, 200, { ok: true, ...payload });
}

// 시장별 거래소 코드 — stock.naver.com 페이지가 사용하는 API 와 동일한 식별자.
// 국내: KOSPI + KOSDAQ. 해외: NASDAQ + NYSE.
const MARKET_EXCHANGES = {
  kr: ['KOSPI', 'KOSDAQ'],
  us: ['NASDAQ', 'NYSE'],
};

function normalizeMoverItem(it, exchange) {
  if (!it) return null;
  const code = it.itemCode || it.code || it.symbolCode || it.cd || null;
  const name = it.stockName || it.stockNameEng || it.name || it.nm || null;
  if (!code || !name) return null;
  const price = parseKRNumber(it.closePrice ?? it.nv ?? it.tradePrice);
  const compare = it.compareToPreviousClosePrice ?? it.compareToPreviousPrice ?? it.cv;
  const change = parseKRNumber(typeof compare === 'object' ? compare?.text : compare);
  const pctRaw = it.fluctuationsRatio ?? it.changeRate ?? it.fluctuationRate ?? it.cr;
  const changePct = parseKRNumber(typeof pctRaw === 'object' ? pctRaw?.text : pctRaw);
  const volume = parseKRNumber(it.accumulatedTradingVolume ?? it.accTradeVolume ?? it.aq);
  const sign = it.compareToPreviousPriceType || it.signType || (typeof compare === 'object' ? compare?.signType : null);
  // 일부 응답은 절대값만 주므로 signType 으로 음/양 보정
  const isDown = sign === '5' || sign === '4' || sign === 'DOWN';
  return {
    code: String(code),
    name: String(name).trim(),
    market: exchange,
    price: isFinite(price) ? price : null,
    change: isFinite(change) ? (isDown && change > 0 ? -change : change) : null,
    changePct: isFinite(changePct) ? (isDown && changePct > 0 ? -changePct : changePct) : null,
    volume: isFinite(volume) ? volume : null,
  };
}

async function fetchExchangeMovers(exchange, direction) {
  // direction: 'up' (급상승) | 'down' (급하락)
  // 1차: api.stock.naver.com 정식 API (UTF-8 JSON)
  const url1 = `https://api.stock.naver.com/stock/exchange/${exchange}/${direction}?page=1&pageSize=20`;
  const r1 = await httpsGet(url1, { headers: { 'Referer': 'https://stock.naver.com/' } });
  if (r1.ok) {
    try {
      const j = JSON.parse(r1.body);
      const items = j?.stocks || j?.items || j?.result?.stocks || j?.list || [];
      if (Array.isArray(items) && items.length) {
        const out = items.map(it => normalizeMoverItem(it, exchange)).filter(Boolean);
        if (out.length) return out;
      }
    } catch (e) {
      logLine('warn', 'movers.parse.stock', { exchange, direction, err: String(e) });
    }
  } else {
    logLine('warn', 'movers.http.stock', { exchange, direction, status: r1.status, err: r1.error || null });
  }

  // 2차: m.stock.naver.com 모바일 API (UTF-8 JSON)
  const url2 = `https://m.stock.naver.com/api/stocks/${direction}/${exchange}?page=1&pageSize=20`;
  const r2 = await httpsGet(url2, { headers: { 'Referer': 'https://m.stock.naver.com/' } });
  if (r2.ok) {
    try {
      const j = JSON.parse(r2.body);
      const items = j?.stocks || j?.items || j?.result || j?.list || [];
      if (Array.isArray(items) && items.length) {
        const out = items.map(it => normalizeMoverItem(it, exchange)).filter(Boolean);
        if (out.length) return out;
      }
    } catch (e) {
      logLine('warn', 'movers.parse.m', { exchange, direction, err: String(e) });
    }
  } else {
    logLine('warn', 'movers.http.m', { exchange, direction, status: r2.status, err: r2.error || null });
  }

  return [];
}

async function fetchNaverHtmlMovers(direction) {
  // 마지막 안전망 — EUC-KR HTML 페이지를 디코딩해서 스크래핑.
  // 국내 시장만 지원 (finance.naver.com 은 한국 시장 전용).
  const url = direction === 'up'
    ? 'https://finance.naver.com/sise/sise_rise.naver'
    : 'https://finance.naver.com/sise/sise_fall.naver';
  const r = await httpsGetBuffer(url, { headers: { 'Referer': 'https://finance.naver.com/' } });
  if (!r.ok) return [];
  try {
    const html = r.body;
    const rows = [];
    const rowRe = /<a href="\/item\/main\.naver\?code=(\d{6})"[^>]*class="tltle"[^>]*>([^<]+)<\/a>([\s\S]*?)<\/tr>/g;
    let m;
    while ((m = rowRe.exec(html)) && rows.length < 10) {
      const code = m[1];
      const name = m[2].trim();
      const tail = m[3];
      const nums = [...tail.matchAll(/<td class="number"[^>]*>([\s\S]*?)<\/td>/g)]
        .map(x => x[1].replace(/<[^>]+>/g, '').replace(/[,\s%]/g, '').trim());
      const price = parseFloat(nums[0]) || null;
      let change = parseFloat(nums[1]) || null;
      let changePct = parseFloat(nums[2]) || null;
      const volume = parseFloat(nums[3]) || null;
      if (direction === 'down' && changePct != null && changePct > 0) changePct = -changePct;
      if (direction === 'down' && change != null && change > 0) change = -change;
      rows.push({ code, name, market: 'KOSPI', price, change, changePct, volume });
    }
    return rows;
  } catch (e) {
    logLine('warn', 'movers.parse.html', { direction, err: String(e) });
    return [];
  }
}

async function fetchMoversForMarket(market, direction) {
  const exchanges = MARKET_EXCHANGES[market] || [];
  // 거래소별 동시 호출 → 결과 병합 → changePct 기준 정렬 → Top 5.
  const results = await Promise.all(exchanges.map(ex => fetchExchangeMovers(ex, direction)));
  const merged = results.flat();
  if (merged.length === 0 && market === 'kr') {
    // 정식 API 가 모두 실패하면 EUC-KR HTML 디코딩으로 폴백 (국내만).
    const html = await fetchNaverHtmlMovers(direction);
    if (html.length) return html.slice(0, 5);
  }
  // 정렬: 상승은 changePct 내림차순, 하락은 오름차순.
  merged.sort((a, b) => {
    const ax = a.changePct == null ? -Infinity : a.changePct;
    const bx = b.changePct == null ? -Infinity : b.changePct;
    return direction === 'up' ? bx - ax : ax - bx;
  });
  return merged.slice(0, 5);
}

async function handleStockMovers(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'GET only' });
  const url = new URL(req.url, 'http://x');
  const market = (url.searchParams.get('market') || 'kr').toLowerCase();
  if (!MARKET_EXCHANGES[market]) {
    return reply(res, 400, { ok: false, error: 'invalid market (kr|us)' });
  }
  const cacheKey = `__movers_${market}`;
  const { entry, stale } = getStockCacheEntry(cacheKey, STOCK_TAB_TTL.movers);
  if (entry && !stale) {
    return reply(res, 200, { ok: true, ...entry.payload, cached: true });
  }
  const [gainers, losers] = await Promise.all([
    fetchMoversForMarket(market, 'up'),
    fetchMoversForMarket(market, 'down'),
  ]);
  const payload = { market, gainers, losers, ts: nowKST() };
  const hasData = gainers.length + losers.length > 0;
  if (hasData) {
    writeStockCacheKey(cacheKey, payload);
    logLine('info', 'movers.ok', { market, gainers: gainers.length, losers: losers.length });
  } else {
    logLine('warn', 'movers.fail', { market });
    if (entry) return reply(res, 200, { ok: true, ...entry.payload, cached: true, stale: true });
  }
  reply(res, 200, { ok: true, ...payload });
}

// ============ 종목 마스터 ============
// Render 같은 데이터센터 IP 가 매 요청마다 네이버 검색에 차단당해도
// 부팅 시 1회 시도는 종종 성공한다. 그걸로 시총 상위 종목 마스터를 만들어
// 메모리에 보관하고, 검색 시 한글 부분일치로 즉시 응답한다.
const STOCK_MASTER = { stocks: [], updatedAt: null, loaded: false };

const STOCK_MASTER_SEED = [
  // 시드 데이터 — 부팅 시 fetch 실패해도 최소한의 한글 검색을 보장.
  // 한국 대표주 (시총 + 거래량 상위)
  { code: '005930', name: '삼성전자',     market: 'KOSPI',  type: 'stock_kr' },
  { code: '000660', name: 'SK하이닉스',    market: 'KOSPI',  type: 'stock_kr' },
  { code: '373220', name: 'LG에너지솔루션', market: 'KOSPI',  type: 'stock_kr' },
  { code: '207940', name: '삼성바이오로직스', market: 'KOSPI', type: 'stock_kr' },
  { code: '005380', name: '현대차',        market: 'KOSPI',  type: 'stock_kr' },
  { code: '005935', name: '삼성전자우',     market: 'KOSPI',  type: 'stock_kr' },
  { code: '000270', name: '기아',          market: 'KOSPI',  type: 'stock_kr' },
  { code: '068270', name: '셀트리온',       market: 'KOSPI',  type: 'stock_kr' },
  { code: '105560', name: 'KB금융',        market: 'KOSPI',  type: 'stock_kr' },
  { code: '055550', name: '신한지주',       market: 'KOSPI',  type: 'stock_kr' },
  { code: '012450', name: '한화에어로스페이스', market: 'KOSPI', type: 'stock_kr' },
  { code: '329180', name: 'HD현대중공업',   market: 'KOSPI',  type: 'stock_kr' },
  { code: '035420', name: 'NAVER',         market: 'KOSPI',  type: 'stock_kr' },
  { code: '035720', name: '카카오',         market: 'KOSPI',  type: 'stock_kr' },
  { code: '003550', name: 'LG',           market: 'KOSPI',  type: 'stock_kr' },
  { code: '051910', name: 'LG화학',        market: 'KOSPI',  type: 'stock_kr' },
  { code: '006400', name: '삼성SDI',       market: 'KOSPI',  type: 'stock_kr' },
  { code: '028260', name: '삼성물산',       market: 'KOSPI',  type: 'stock_kr' },
  { code: '066570', name: 'LG전자',        market: 'KOSPI',  type: 'stock_kr' },
  { code: '015760', name: '한국전력',       market: 'KOSPI',  type: 'stock_kr' },
  { code: '034730', name: 'SK',           market: 'KOSPI',  type: 'stock_kr' },
  { code: '017670', name: 'SK텔레콤',      market: 'KOSPI',  type: 'stock_kr' },
  { code: '030200', name: 'KT',           market: 'KOSPI',  type: 'stock_kr' },
  { code: '003670', name: '포스코퓨처엠',    market: 'KOSPI',  type: 'stock_kr' },
  { code: '009540', name: 'HD한국조선해양',  market: 'KOSPI',  type: 'stock_kr' },
  { code: '011200', name: 'HMM',          market: 'KOSPI',  type: 'stock_kr' },
  { code: '009830', name: '한화솔루션',     market: 'KOSPI',  type: 'stock_kr' },
  { code: '011170', name: '롯데케미칼',     market: 'KOSPI',  type: 'stock_kr' },
  { code: '096770', name: 'SK이노베이션',   market: 'KOSPI',  type: 'stock_kr' },
  { code: '316140', name: '우리금융지주',    market: 'KOSPI',  type: 'stock_kr' },
  // KOSDAQ 인기주
  { code: '247540', name: '에코프로비엠',    market: 'KOSDAQ', type: 'stock_kr' },
  { code: '086520', name: '에코프로',       market: 'KOSDAQ', type: 'stock_kr' },
  { code: '091990', name: '셀트리온헬스케어', market: 'KOSDAQ', type: 'stock_kr' },
  { code: '196170', name: '알테오젠',       market: 'KOSDAQ', type: 'stock_kr' },
  { code: '028300', name: 'HLB',           market: 'KOSDAQ', type: 'stock_kr' },
  { code: '263750', name: '펄어비스',       market: 'KOSDAQ', type: 'stock_kr' },
  { code: '293490', name: '카카오게임즈',    market: 'KOSDAQ', type: 'stock_kr' },
  { code: '041510', name: 'SM',           market: 'KOSDAQ', type: 'stock_kr' },
  { code: '035900', name: 'JYP Ent.',     market: 'KOSDAQ', type: 'stock_kr' },
  { code: '215000', name: '골프존',         market: 'KOSDAQ', type: 'stock_kr' },
  // 미국 인기주
  { code: 'AAPL',  name: 'Apple',          market: 'NASDAQ', type: 'stock_us' },
  { code: 'MSFT',  name: 'Microsoft',      market: 'NASDAQ', type: 'stock_us' },
  { code: 'NVDA',  name: 'NVIDIA',         market: 'NASDAQ', type: 'stock_us' },
  { code: 'GOOGL', name: 'Alphabet (Google)', market: 'NASDAQ', type: 'stock_us' },
  { code: 'AMZN',  name: 'Amazon',         market: 'NASDAQ', type: 'stock_us' },
  { code: 'META',  name: 'Meta Platforms', market: 'NASDAQ', type: 'stock_us' },
  { code: 'TSLA',  name: 'Tesla',          market: 'NASDAQ', type: 'stock_us' },
  { code: 'BRK.B', name: 'Berkshire Hathaway', market: 'NYSE', type: 'stock_us' },
  { code: 'JPM',   name: 'JPMorgan Chase', market: 'NYSE',   type: 'stock_us' },
  { code: 'V',     name: 'Visa',           market: 'NYSE',   type: 'stock_us' },
  { code: 'JNJ',   name: 'Johnson & Johnson', market: 'NYSE', type: 'stock_us' },
  { code: 'WMT',   name: 'Walmart',        market: 'NYSE',   type: 'stock_us' },
  { code: 'XOM',   name: 'Exxon Mobil',    market: 'NYSE',   type: 'stock_us' },
  { code: 'BAC',   name: 'Bank of America', market: 'NYSE',  type: 'stock_us' },
  { code: 'KO',    name: 'Coca-Cola',      market: 'NYSE',   type: 'stock_us' },
  { code: 'NFLX',  name: 'Netflix',        market: 'NASDAQ', type: 'stock_us' },
  { code: 'AMD',   name: 'AMD',            market: 'NASDAQ', type: 'stock_us' },
  { code: 'INTC',  name: 'Intel',          market: 'NASDAQ', type: 'stock_us' },
  { code: 'PYPL',  name: 'PayPal',         market: 'NASDAQ', type: 'stock_us' },
  { code: 'DIS',   name: 'Disney',         market: 'NYSE',   type: 'stock_us' },
  { code: 'BABA',  name: 'Alibaba',        market: 'NYSE',   type: 'stock_us' },
  { code: 'TSM',   name: 'TSMC (Taiwan Semi)', market: 'NYSE', type: 'stock_us' },
];

async function fetchExchangeMaster(exchange) {
  // stock.naver.com 의 시총 정렬 API 로 거래소별 상위 종목을 수집한다.
  const url = `https://api.stock.naver.com/stock/exchange/${exchange}/marketValue?page=1&pageSize=500`;
  const r = await httpsGet(url, {
    headers: { 'Referer': 'https://stock.naver.com/', 'User-Agent': BROWSER_UA },
  });
  if (!r.ok) {
    logLine('warn', 'master.http', { exchange, status: r.status });
    return [];
  }
  try {
    const j = JSON.parse(r.body);
    const items = j?.stocks || j?.items || j?.result?.stocks || j?.list || [];
    if (!Array.isArray(items)) return [];
    const out = [];
    for (const it of items) {
      const code = it.itemCode || it.code || it.reutersCode || it.symbolCode || null;
      const name = it.stockName || it.itemName || it.name || null;
      if (!code || !name) continue;
      out.push({
        code: String(code),
        name: String(name).trim(),
        market: exchange,
        type: /^\d{6}$/.test(code) ? 'stock_kr' : 'stock_us',
      });
    }
    return out;
  } catch (e) {
    logLine('warn', 'master.parse', { exchange, err: String(e) });
    return [];
  }
}

async function buildStockMaster() {
  // 부팅 시 + 매일 1회 호출. 실패해도 시드 데이터로 검색은 계속 동작.
  const cached = readJSON(STOCK_MASTER_FILE, null);
  if (cached && Array.isArray(cached.stocks) && cached.stocks.length > 100) {
    STOCK_MASTER.stocks = cached.stocks;
    STOCK_MASTER.updatedAt = cached.updatedAt;
    STOCK_MASTER.loaded = true;
    logLine('info', 'master.cached', { count: cached.stocks.length });
  } else {
    STOCK_MASTER.stocks = [...STOCK_MASTER_SEED];
    STOCK_MASTER.loaded = true;
    logLine('info', 'master.seed', { count: STOCK_MASTER_SEED.length });
  }
  // 그 다음 backgrond fetch 로 최신화 시도. 실패해도 무방.
  const exchanges = ['KOSPI', 'KOSDAQ', 'NASDAQ', 'NYSE'];
  const results = await Promise.all(exchanges.map(fetchExchangeMaster));
  const fetched = results.flat();
  if (fetched.length > 100) {
    // 시드 + fetched 병합 (dedupe by type+code)
    const seen = new Set();
    const merged = [];
    for (const s of [...fetched, ...STOCK_MASTER_SEED]) {
      const key = `${s.type}:${s.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(s);
    }
    STOCK_MASTER.stocks = merged;
    STOCK_MASTER.updatedAt = nowKST();
    STOCK_MASTER.loaded = true;
    try { writeJSON(STOCK_MASTER_FILE, { stocks: merged, updatedAt: STOCK_MASTER.updatedAt }); } catch {}
    logLine('info', 'master.refresh.ok', { count: merged.length, fetched: fetched.length });
  } else {
    logLine('warn', 'master.refresh.fail', { fetched: fetched.length });
  }
}

function searchInMaster(q) {
  // 한글 + 영문 + 코드 부분일치. 정확한 prefix 매치를 우선 정렬.
  if (!STOCK_MASTER.loaded) return [];
  const lowered = q.toLowerCase().trim();
  if (!lowered) return [];
  const out = [];
  for (const s of STOCK_MASTER.stocks) {
    const nameLow = s.name.toLowerCase();
    const codeLow = s.code.toLowerCase();
    let score = -1;
    if (nameLow === lowered || codeLow === lowered) score = 0;
    else if (nameLow.startsWith(lowered) || codeLow.startsWith(lowered)) score = 1;
    else if (nameLow.includes(lowered) || codeLow.includes(lowered)) score = 2;
    if (score >= 0) out.push({ ...s, _score: score });
    if (out.length >= 50) break;
  }
  out.sort((a, b) => a._score - b._score);
  return out.slice(0, 10).map(({ _score, ...rest }) => rest);
}

function searchTypeFromNationCode(nation) {
  // stock.naver.com API: nation code (KOR / USA / 빈문자) + stockExchangeType (KOSPI/KOSDAQ/NASDAQ/NYSE...)
  if (!nation) return null;
  const n = String(nation).toUpperCase();
  if (n === 'KOR' || n === 'KR') return 'stock_kr';
  if (n === 'USA' || n === 'US') return 'stock_us';
  return null;
}

// 한글 자동완성용 — 네이버가 단순 UA 를 가끔 거부하므로 진짜 브라우저 UA 로 호출.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchStockSearch(q) {
  const results = [];
  const seen = new Set();
  const push = (item) => {
    if (!item || !item.code) return;
    const key = `${item.type || ''}:${item.code}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(item);
  };

  // 0차: 메모리 종목 마스터 부분일치 검색 — 한글 + 영문 즉시 매치.
  // 부팅 시 1회 fetch 한 데이터 또는 시드. Render IP 차단 영향 없음.
  for (const it of searchInMaster(q)) push(it);

  // 1차: stock.naver.com 통합검색 (한글 + 영문 + 코드 모두 지원)
  // stock.naver.com/search/{q} 페이지가 호출하는 백엔드. 파라미터 이름이 시기별로
  // keyword / searchText 둘 다 쓰이므로 양쪽 모두 시도.
  const stockSearchUrls = [
    `https://api.stock.naver.com/search/total?keyword=${encodeURIComponent(q)}`,
    `https://api.stock.naver.com/search/total?searchText=${encodeURIComponent(q)}`,
    `https://api.stock.naver.com/search?keyword=${encodeURIComponent(q)}`,
  ];
  for (const url of stockSearchUrls) {
    const r = await httpsGet(url, {
      headers: { 'Referer': 'https://stock.naver.com/', 'User-Agent': BROWSER_UA },
    });
    if (!r.ok) {
      logLine('warn', 'search.http.stock', { url, status: r.status, err: r.error || null });
      continue;
    }
    try {
      const j = JSON.parse(r.body);
      const groups = [];
      if (Array.isArray(j?.searchResult?.stock?.items)) groups.push(...j.searchResult.stock.items);
      if (Array.isArray(j?.searchResult?.stocks)) groups.push(...j.searchResult.stocks);
      if (Array.isArray(j?.stock?.items)) groups.push(...j.stock.items);
      if (Array.isArray(j?.stocks)) groups.push(...j.stocks);
      if (Array.isArray(j?.result?.stocks)) groups.push(...j.result.stocks);
      if (Array.isArray(j?.result?.items)) groups.push(...j.result.items);
      if (Array.isArray(j?.items)) groups.push(...j.items);
      let added = 0;
      for (const it of groups) {
        if (!it) continue;
        const code = it.itemCode || it.code || it.reutersCode || it.symbol || null;
        const name = it.stockName || it.itemName || it.name || it.nameEng || null;
        if (!code || !name) continue;
        const nation = it.nationCode || it.nation || '';
        const exchange = it.stockExchangeType?.code || it.stockExchangeType
          || it.exchangeType || it.market || '';
        const type = searchTypeFromNationCode(nation)
          || (/^\d{6}$/.test(code) ? 'stock_kr' : 'stock_us');
        push({ code: String(code), name: String(name).trim(), market: String(exchange || nation || ''), type });
        added++;
      }
      if (added > 0) {
        logLine('info', 'search.ok.stock', { url, added });
        break;
      }
    } catch (e) {
      logLine('warn', 'search.parse.stock', { url, err: String(e) });
    }
  }

  // 2차: m.stock.naver.com 자동완성 (모바일)
  if (results.length < 5) {
    const url2 = `https://m.stock.naver.com/front-api/v1/search/autoComplete?query=${encodeURIComponent(q)}&target=stock,index,marketIndicator`;
    const r2 = await httpsGet(url2, {
      headers: { 'Referer': 'https://m.stock.naver.com/', 'User-Agent': BROWSER_UA },
    });
    if (r2.ok) {
      try {
        const j = JSON.parse(r2.body);
        const items = j?.result?.items || j?.items || j?.result || [];
        if (Array.isArray(items)) {
          for (const it of items) {
            const code = it.cd || it.itemCode || it.code || null;
            const name = it.nm || it.stockName || it.name || null;
            if (!code || !name) continue;
            const nation = it.nationCode || it.nation || '';
            const exchange = it.stockExchangeType?.code || it.stockExchangeType || it.exchange || '';
            const type = searchTypeFromNationCode(nation)
              || (/^\d{6}$/.test(code) ? 'stock_kr' : 'stock_us');
            push({ code: String(code), name: String(name).trim(), market: String(exchange || nation || ''), type });
          }
        }
      } catch (e) {
        logLine('warn', 'search.parse.m', { q, err: String(e) });
      }
    } else {
      logLine('warn', 'search.http.m', { q, status: r2.status, err: r2.error || null });
    }
  }

  // 3차: polling.finance.naver.com 종목명 검색 (한국 종목만, 한글 검증된 endpoint)
  if (results.length < 5) {
    const url3p = `https://polling.finance.naver.com/api/sise/etcStockNameSearch.nhn?searchText=${encodeURIComponent(q)}&suggestionLimit=10`;
    const r3p = await httpsGet(url3p, {
      headers: { 'Referer': 'https://finance.naver.com/', 'User-Agent': BROWSER_UA },
    });
    if (r3p.ok) {
      try {
        const j = JSON.parse(r3p.body);
        const items = j?.result?.items || j?.items || [];
        if (Array.isArray(items)) {
          for (const it of items) {
            const code = it.cd || it.code || it.itemCode || null;
            const name = it.nm || it.name || it.stockName || null;
            if (code && /^\d{6}$/.test(code) && name) {
              push({ code, name: String(name).trim(), market: it.mt || 'KOSPI', type: 'stock_kr' });
            }
          }
        }
      } catch (e) {
        logLine('warn', 'search.parse.polling', { q, err: String(e) });
      }
    }
  }

  // 4차: 네이버 금융 자동완성 (구 API — 한국 종목만, 브라우저 UA + r_enc 명시)
  if (results.length < 5) {
    const url3 = `https://ac.finance.naver.com/ac?q=${encodeURIComponent(q)}&q_enc=UTF-8&st=111&frm=stock&r_lt=111&r_format=json&r_enc=UTF-8`;
    const r3 = await httpsGet(url3, {
      headers: { 'Referer': 'https://finance.naver.com/', 'User-Agent': BROWSER_UA },
    });
    if (r3.ok) {
      try {
        const j = JSON.parse(r3.body);
        const groups = j?.items || [];
        for (const grp of groups) {
          if (!Array.isArray(grp)) continue;
          for (const it of grp) {
            if (!Array.isArray(it) || it.length < 2) continue;
            const name = it[0]?.[0] || '';
            const code = it[1]?.[0] || '';
            const market = it[2]?.[0] || it[3]?.[0] || 'KOSPI';
            if (code && /^\d{6}$/.test(code) && name) {
              push({ code, name, market, type: 'stock_kr' });
            }
          }
        }
      } catch (e) {
        logLine('warn', 'search.parse.acfinance', { q, err: String(e) });
      }
    } else {
      logLine('warn', 'search.http.acfinance', { q, status: r3.status, err: r3.error || null });
    }
  }

  // 4-bis차: finance.naver.com 검색 페이지 HTML 스크래핑 (EUC-KR).
  // 사용자 요청: 다른 채널이 종목 못 찾을 때 finance.naver.com 의 통합 검색 결과로 폴백.
  // 결과 페이지 구조: <a href="/item/main.naver?code=NNNNNN">종목명</a>
  if (results.filter(r => r.type === 'stock_kr').length < 3) {
    const url4b = `https://finance.naver.com/search/searchList.naver?query=${encodeURIComponent(q)}`;
    const r4b = await httpsGetBuffer(url4b, {
      headers: { 'Referer': 'https://finance.naver.com/', 'User-Agent': BROWSER_UA },
      timeoutMs: 8000,
    });
    if (r4b.ok) {
      try {
        const html = r4b.body;
        // 두 패턴 모두 시도: 일반 검색 결과 + 상단 추천 종목.
        const re = /<a\s+href="\/item\/main\.naver\?code=(\d{6})"[^>]*>([^<]+)<\/a>/g;
        let mm;
        let added = 0;
        while ((mm = re.exec(html)) && added < 10) {
          const code = mm[1];
          const name = stripTags(mm[2]).trim();
          if (!name) continue;
          // KOSPI/KOSDAQ 구분 정보는 페이지에 없을 수 있어서 기본 KOSPI.
          push({ code, name, market: 'KOSPI', type: 'stock_kr' });
          added++;
        }
        if (added) logLine('info', 'search.ok.finance', { q, added });
      } catch (e) {
        logLine('warn', 'search.parse.finance', { q, err: String(e) });
      }
    } else {
      logLine('warn', 'search.http.finance', { q, status: r4b.status, err: r4b.error || null });
    }
  }

  // 4차: Yahoo Finance search (해외 보강)
  if (results.length < 8) {
    const url4 = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`;
    const r4 = await httpsGet(url4);
    if (r4.ok) {
      try {
        const j = JSON.parse(r4.body);
        const quotes = j?.quotes || [];
        for (const it of quotes) {
          if (!it.symbol) continue;
          if (it.quoteType !== 'EQUITY' && it.quoteType !== 'ETF') continue;
          const ksMatch = /^(\d{6})\.(KS|KQ)$/.exec(it.symbol);
          if (ksMatch) {
            push({
              code: ksMatch[1],
              name: it.shortname || it.longname || ksMatch[1],
              market: ksMatch[2] === 'KS' ? 'KOSPI' : 'KOSDAQ',
              type: 'stock_kr',
            });
          } else if (/^[A-Z][A-Z.0-9-]*$/.test(it.symbol)) {
            push({
              code: it.symbol,
              name: it.shortname || it.longname || it.symbol,
              market: it.exchDisp || it.exchange || 'US',
              type: 'stock_us',
            });
          }
        }
      } catch (e) {
        logLine('warn', 'search.parse.yahoo', { q, err: String(e) });
      }
    }
  }
  return results.slice(0, 10);
}

async function handleStockSearch(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'GET only' });
  const url = new URL(req.url, 'http://x');
  const q = (url.searchParams.get('q') || '').trim();
  if (!q || q.length < 1 || q.length > 30) {
    return reply(res, 400, { ok: false, error: 'invalid q (1-30 chars)' });
  }
  const cacheKey = `__search:${q.toLowerCase()}`;
  const { entry, stale } = getStockCacheEntry(cacheKey, STOCK_TAB_TTL.search);
  if (entry && !stale) {
    return reply(res, 200, { ok: true, q, ...entry.payload, cached: true });
  }
  const results = await fetchStockSearch(q);
  const payload = { results };
  if (results.length) writeStockCacheKey(cacheKey, payload);
  else if (entry) return reply(res, 200, { ok: true, q, ...entry.payload, cached: true, stale: true });
  reply(res, 200, { ok: true, q, ...payload });
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

function normalizeNewsItem(it) {
  if (!it) return null;
  const officeId = it.officeId || it.pressId || it.media || '';
  const articleId = it.articleId || it.aid || it.id || '';
  let url = it.linkUrl || it.url || it.officeUrl || '';
  if (!url && officeId && articleId) {
    url = `https://n.news.naver.com/mnews/article/${officeId}/${articleId}`;
  }
  // 상대 URL 보정
  if (url && url.startsWith('/')) url = `https://stock.naver.com${url}`;
  const title = stripTags(it.title || it.subject || it.headline);
  if (!title || !url) return null;
  return {
    title,
    summary: stripTags(it.body || it.summary || it.content || it.subContent || '').slice(0, 200),
    source: stripTags(it.officeName || it.press || it.source || ''),
    url,
    publishedAt: it.datetime || it.publishedAt || it.serviceDate || it.regDateTime || it.regTime || '',
    image: it.imageUrl || it.thumbnailUrl || it.thumb || null,
  };
}

// 네이버 OpenAPI 뉴스 검색 — NAVER_CLIENT_ID/SECRET 가 있을 때만 동작.
// 일일 25,000 요청 무료. query 기반 검색이라 종목/키워드별 뉴스 제공 가능.
// 응답 포맷: { items: [{ title, link, originallink, description, pubDate }] }
async function fetchNaverOpenApiNews(query, limit) {
  const cid = process.env.NAVER_CLIENT_ID;
  const csec = process.env.NAVER_CLIENT_SECRET;
  if (!cid || !csec) return null; // 키 없으면 폴백으로 진입
  const display = Math.max(1, Math.min(50, limit));
  // sort=date 최신순. query 가 비면 '코스피' 로 디폴트 (한국 경제뉴스 거의 모두에 매칭).
  const q = (query && query.trim()) || '코스피';
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(q)}&display=${display}&sort=date`;
  const r = await httpsGet(url, {
    headers: {
      'X-Naver-Client-Id': cid,
      'X-Naver-Client-Secret': csec,
      'Referer': 'https://developers.naver.com/',
    },
    timeoutMs: 8000,
  });
  if (!r.ok) {
    logLine('warn', 'news.openapi.http', { status: r.status, err: r.error || null });
    return [];
  }
  try {
    const j = JSON.parse(r.body);
    const items = Array.isArray(j?.items) ? j.items : [];
    const out = items.slice(0, limit).map(it => {
      const title = stripTags(it.title || '');
      // 원문 URL 우선. originallink 가 비면 link (네이버 캐시) 사용.
      const url = safeNewsUrl(it.originallink || it.link || '');
      if (!title || !url) return null;
      // pubDate 예: "Wed, 04 Jun 2026 09:30:00 +0900"
      let publishedAt = it.pubDate || '';
      try { if (publishedAt) publishedAt = new Date(publishedAt).toISOString(); } catch {}
      return {
        title,
        summary: stripTags(it.description || '').slice(0, 200),
        source: extractSourceFromUrl(it.originallink || it.link || ''),
        url,
        publishedAt,
        image: null,
      };
    }).filter(Boolean);
    if (out.length) {
      logLine('info', 'news.openapi.ok', { count: out.length, query: q });
      return out;
    }
  } catch (e) {
    logLine('warn', 'news.openapi.parse', { err: String(e) });
  }
  return [];
}

function safeNewsUrl(u) {
  if (typeof u !== 'string') return '';
  const s = u.trim();
  return /^https?:\/\//i.test(s) ? s : '';
}
function extractSourceFromUrl(u) {
  try {
    const host = new URL(u).hostname;
    // www. 제거 + 한국 주요 매체 매핑
    const h = host.replace(/^www\./, '').toLowerCase();
    const map = {
      'hankyung.com': '한국경제', 'mk.co.kr': '매일경제', 'mt.co.kr': '머니투데이',
      'sedaily.com': '서울경제', 'edaily.co.kr': '이데일리', 'chosun.com': '조선일보',
      'donga.com': '동아일보', 'joongang.co.kr': '중앙일보', 'yna.co.kr': '연합뉴스',
      'news1.kr': '뉴스1', 'newsis.com': '뉴시스', 'fnnews.com': '파이낸셜뉴스',
      'biz.heraldcorp.com': '헤럴드경제', 'heraldcorp.com': '헤럴드경제',
      'asiae.co.kr': '아시아경제', 'thebell.co.kr': '더벨',
    };
    if (map[h]) return map[h];
    // {sub}.{main}.co.kr 의 경우 main.co.kr 로 다시 시도
    const trimmed = h.replace(/^[^.]+\./, '');
    if (map[trimmed]) return map[trimmed];
    return h;
  } catch { return ''; }
}

// Google News RSS — 최종 폴백. 키 불필요, Render IP 차단 사례 없음.
// 응답: RSS 2.0 XML. <description> 안에 원문 매체 링크가 <a href="..."> 로 들어가 있음.
async function fetchGoogleNewsRss(query, limit) {
  const q = (query && query.trim()) || '코스피 OR 코스닥 OR 주식시황';
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;
  const r = await httpsGet(url, {
    headers: { 'Referer': 'https://news.google.com/', 'User-Agent': BROWSER_UA, 'Accept': 'application/rss+xml, application/xml, */*' },
    timeoutMs: 8000,
  });
  if (!r.ok) {
    logLine('warn', 'news.gnews.http', { status: r.status, err: r.error || null });
    return [];
  }
  try {
    const xml = r.body;
    const out = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = itemRe.exec(xml)) && out.length < limit) {
      const inner = m[1];
      const titleMatch = inner.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
      const linkMatch = inner.match(/<link>([\s\S]*?)<\/link>/);
      const pubMatch = inner.match(/<pubDate>([^<]+)<\/pubDate>/);
      const srcMatch = inner.match(/<source[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/source>/);
      const descMatch = inner.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/);
      const title = stripTags(titleMatch ? titleMatch[1] : '');
      const link = (linkMatch ? linkMatch[1] : '').trim();
      let originalUrl = '';
      if (descMatch) {
        const hrefMatch = descMatch[1].match(/<a\s+href="([^"]+)"/i);
        if (hrefMatch) originalUrl = hrefMatch[1].trim();
      }
      let publishedAt = '';
      if (pubMatch) {
        try { publishedAt = new Date(pubMatch[1].trim()).toISOString(); } catch {}
      }
      const finalUrl = safeNewsUrl(originalUrl) || safeNewsUrl(link);
      if (!title || !finalUrl) continue;
      out.push({
        title,
        summary: '',
        source: srcMatch ? stripTags(srcMatch[1]) : (extractSourceFromUrl(finalUrl) || 'Google News'),
        url: finalUrl,
        publishedAt,
        image: null,
      });
    }
    if (out.length) {
      logLine('info', 'news.gnews.ok', { count: out.length, query: q });
    }
    return out;
  } catch (e) {
    logLine('warn', 'news.gnews.parse', { err: String(e) });
    return [];
  }
}

async function fetchStockNews(limit, query) {
  // 네이버 검색 API 전용 — 사용자 명시 선호 (라운드 12-bis).
  // 키 있을 때는 OpenAPI 결과만 사용한다 (빈 응답이어도 다른 매체로 폴백하지 않음).
  // 다른 매체가 섞여 들어오는 걸 막기 위함.
  if (process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET) {
    const out = await fetchNaverOpenApiNews(query, limit);
    return Array.isArray(out) ? out : [];
  }

  // 키 미설정 시에만 폴백 체인 활성화.
  // 1차: api.stock.naver.com — stock.naver.com/news 페이지가 사용하는 정식 API.
  const candidates = [
    `https://api.stock.naver.com/news/main?pageSize=${limit}&page=1`,
    `https://api.stock.naver.com/news/homeNews?pageSize=${limit}&page=1`,
    `https://api.stock.naver.com/news?pageSize=${limit}&page=1`,
  ];
  for (const url of candidates) {
    const r = await httpsGet(url, { headers: { 'Referer': 'https://stock.naver.com/' }, timeoutMs: 8000 });
    if (!r.ok) {
      logLine('warn', 'news.http.stock', { url, status: r.status, err: r.error || null });
      continue;
    }
    try {
      const j = JSON.parse(r.body);
      const items = j?.newsList || j?.items || j?.result?.list || j?.news || j?.list || [];
      if (Array.isArray(items) && items.length) {
        const out = items.slice(0, limit).map(normalizeNewsItem).filter(Boolean);
        if (out.length) return out;
      }
    } catch (e) {
      logLine('warn', 'news.parse.stock', { url, err: String(e) });
    }
  }

  // 2차: m.stock.naver.com 모바일 뉴스 API
  const mUrl = `https://m.stock.naver.com/api/news/news/category/HOME?pageSize=${limit}`;
  const r2 = await httpsGet(mUrl, { headers: { 'Referer': 'https://m.stock.naver.com/' }, timeoutMs: 8000 });
  if (r2.ok) {
    try {
      const j = JSON.parse(r2.body);
      const items = j?.items || j?.newsList || j?.result || j?.news || [];
      if (Array.isArray(items) && items.length) {
        const out = items.slice(0, limit).map(normalizeNewsItem).filter(Boolean);
        if (out.length) return out;
      }
    } catch (e) {
      logLine('warn', 'news.parse.m', { err: String(e) });
    }
  }

  // 3차: EUC-KR HTML 폴백 (finance.naver.com)
  const r3 = await httpsGetBuffer('https://finance.naver.com/news/mainnews.naver', {
    headers: { 'Referer': 'https://finance.naver.com/' }, timeoutMs: 8000,
  });
  if (r3.ok) {
    try {
      const html = r3.body;
      const items = [];
      const itemRe = /<dt class="articleSubject">\s*<a href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<dd class="articleSummary">([\s\S]*?)<\/dd>/g;
      let m;
      while ((m = itemRe.exec(html)) && items.length < limit) {
        let url = m[1].trim();
        if (url.startsWith('/')) url = `https://finance.naver.com${url}`;
        const title = stripTags(m[2]);
        const inner = m[3];
        const wdateMatch = inner.match(/<span class="wdate">([^<]+)<\/span>/);
        const pressMatch = inner.match(/<span class="press">([^<]+)<\/span>/);
        const summary = stripTags(inner).slice(0, 200);
        items.push({
          title,
          summary,
          source: pressMatch ? stripTags(pressMatch[1]) : '네이버 금융',
          url,
          publishedAt: wdateMatch ? stripTags(wdateMatch[1]) : '',
          image: null,
        });
      }
      if (items.length) return items;
    } catch (e) {
      logLine('warn', 'news.parse.html', { err: String(e) });
    }
  }

  // 4차 (최종): Google News RSS — 키 불필요, 매우 안정적인 폴백.
  // 1-3차가 모두 빈 응답이거나 차단되는 환경(Render 등)에서도 동작.
  const gout = await fetchGoogleNewsRss(query, limit);
  if (gout && gout.length) return gout;

  return [];
}

async function handleStockNews(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'GET only' });
  const url = new URL(req.url, 'http://x');
  let limit = parseInt(url.searchParams.get('limit') || '10', 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 10;
  if (limit > 30) limit = 30;
  const query = (url.searchParams.get('q') || '').trim().slice(0, 80);
  const cacheKey = query ? `__news:${query.toLowerCase()}` : '__news';
  const { entry, stale } = getStockCacheEntry(cacheKey, STOCK_TAB_TTL.news);
  if (entry && !stale) {
    return reply(res, 200, { ok: true, ...entry.payload, cached: true });
  }
  const news = await fetchStockNews(limit, query);
  const payload = { news, query, ts: nowKST() };
  if (news.length) {
    writeStockCacheKey(cacheKey, payload);
    logLine('info', 'news.ok', { count: news.length, query });
  } else {
    logLine('warn', 'news.fail', { query });
    if (entry) return reply(res, 200, { ok: true, ...entry.payload, cached: true, stale: true });
  }
  reply(res, 200, { ok: true, ...payload });
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

// ============================================================================
// DART OpenAPI — 국민연금 매수/매도 표
// ----------------------------------------------------------------------------
// goinsider.kr 와 동일한 원리: 전자공시시스템의 "주식등의 대량보유상황보고서
// (D001)" 를 검색해 제출자(flr_nm)가 국민연금공단인 것만 추려, 각 건마다
// majorstock API 로 변동수량·변동비율을 보강한다. DART_API_KEY 가 없으면
// 비활성 상태로 503 응답. 키는 process.env 에서만 읽고 로그·응답에 노출 X.
// ----------------------------------------------------------------------------

const PENSION_FLR_NAME = '국민연금공단';
const STOCK_TAB_TTL_PENSION = 24 * 60 * 60 * 1000; // 24h

function dartConfigured() {
  // DART 인증키는 40자 영숫자. 너무 엄격한 길이 검증으로 정상 키가 false 처리되는 걸 방지.
  const k = (process.env.DART_API_KEY || '').trim();
  return Boolean(k && k.length >= 20);
}
function dartKey() { return (process.env.DART_API_KEY || '').trim(); }

// DART status 코드 → 한국어 사유 (응답 메시지 보강용)
const DART_STATUS_MSG = {
  '000': '정상',
  '010': '등록되지 않은 인증키 (발급 직후라면 1-2시간 대기 후 재시도)',
  '011': '사용할 수 없는 인증키',
  '012': '접근할 수 없는 IP',
  '013': '조회된 데이터가 없음 (최근 기간 내 국민연금 대량보유 보고 0건)',
  '020': '요청 제한 초과 (일일 1만 호출)',
  '021': '조회 가능한 회사 개수 초과',
  '100': '부적절한 파라미터',
  '101': '부적절한 접근',
  '800': 'DART 점검 시간',
};
function dartStatusMessage(code) {
  return DART_STATUS_MSG[String(code || '')] || `알 수 없는 코드 (${code})`;
}

function dartListUrl({ bgnDe, endDe, pageNo, pageCount = 100 }) {
  const key = dartKey();
  return `https://opendart.fss.or.kr/api/list.json?crtfc_key=${key}&bgn_de=${bgnDe}&end_de=${endDe}&pblntf_detail_ty=D001&page_count=${pageCount}&page_no=${pageNo}`;
}
function dartMajorStockUrl(corpCode) {
  return `https://opendart.fss.or.kr/api/majorstock.json?crtfc_key=${dartKey()}&corp_code=${encodeURIComponent(corpCode)}`;
}
function dartReportUrl(rceptNo) {
  return `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(rceptNo)}`;
}
function ymdFromKST(daysAgo = 0) {
  const d = new Date(Date.now() - daysAgo * 86400_000);
  const k = d.toLocaleString('sv', { timeZone: 'Asia/Seoul' }).slice(0, 10);
  return k.replace(/-/g, '');
}
function parseDartDate(s) {
  if (!s || s.length !== 8) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}
function parseDartSignedNumber(s) {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').trim();
  if (!t || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

async function fetchDartList(daysBack) {
  const bgnDe = ymdFromKST(daysBack);
  const endDe = ymdFromKST(0);
  const all = [];
  const meta = { lastStatus: null, lastMessage: '', httpStatus: null, dateRange: { bgnDe, endDe } };
  // 최대 5페이지(500건) 까지만 조회 — 대량보유보고는 하루 평균 ~30건이라 충분.
  for (let page = 1; page <= 5; page++) {
    const r = await httpsGet(dartListUrl({ bgnDe, endDe, pageNo: page }), { timeoutMs: 8000 });
    meta.httpStatus = r.status;
    if (!r.ok) {
      logLine('warn', 'dart.list.http', { page, status: r.status, err: r.error || null });
      meta.lastMessage = `HTTP ${r.status}`;
      break;
    }
    try {
      const j = JSON.parse(r.body);
      meta.lastStatus = j.status || '000';
      meta.lastMessage = j.message || dartStatusMessage(meta.lastStatus);
      if (j.status && j.status !== '000') {
        logLine('warn', 'dart.list.status', { page, status: j.status, message: j.message || '' });
        break; // 013 / 020 / 021 / 010 등 모두 중단
      }
      const list = Array.isArray(j.list) ? j.list : [];
      all.push(...list);
      if (list.length < 100) break; // 마지막 페이지
    } catch (e) {
      logLine('warn', 'dart.list.parse', { page, err: String(e) });
      meta.lastMessage = '응답 파싱 실패';
      break;
    }
  }
  return { list: all, meta };
}

async function fetchDartMajorStockByCorp(corpCode) {
  const r = await httpsGet(dartMajorStockUrl(corpCode), { timeoutMs: 8000 });
  if (!r.ok) {
    logLine('warn', 'dart.major.http', { corpCode, status: r.status });
    return [];
  }
  try {
    const j = JSON.parse(r.body);
    if (j.status && j.status !== '000') {
      if (j.status !== '013') {
        logLine('warn', 'dart.major.status', { corpCode, status: j.status });
      }
      return [];
    }
    return Array.isArray(j.list) ? j.list : [];
  } catch (e) {
    logLine('warn', 'dart.major.parse', { corpCode, err: String(e) });
    return [];
  }
}

function inferPensionEventType(reportNm, qtyDelta, rateDelta) {
  // 보고 사유 + 변동량으로 매수/매도/신규 구분.
  const nm = String(reportNm || '');
  if (/신규/.test(nm)) return 'new';
  if (qtyDelta != null) return qtyDelta > 0 ? 'buy' : qtyDelta < 0 ? 'sell' : 'hold';
  if (rateDelta != null) return rateDelta > 0 ? 'buy' : rateDelta < 0 ? 'sell' : 'hold';
  return 'unknown';
}

async function fetchPensionFlows(daysBack) {
  if (!dartConfigured()) {
    return { ok: false, reason: 'DART_API_KEY 미설정' };
  }
  const { list, meta: dartMeta } = await fetchDartList(daysBack);
  // 제출자 = 국민연금공단 인 것만 필터.
  const pensionReports = list.filter(it => String(it.flr_nm || '').includes(PENSION_FLR_NAME));
  if (!pensionReports.length) {
    return { ok: true, rows: [], totalReports: list.length, daysBack, dartMeta };
  }
  // 같은 발행회사(corp_code) 의 majorstock 응답을 한 번씩만 받아 캐시(이번 호출 한정).
  const corpCache = new Map();
  const rows = [];
  for (const r of pensionReports) {
    const corpCode = r.corp_code;
    if (!corpCode) continue;
    if (!corpCache.has(corpCode)) {
      corpCache.set(corpCode, await fetchDartMajorStockByCorp(corpCode));
    }
    const majorList = corpCache.get(corpCode);
    // rcept_no 매칭으로 정확한 한 보고를 찾기.
    const match = majorList.find(m => m.rcept_no === r.rcept_no)
      || majorList.find(m => String(m.repror || '').includes(PENSION_FLR_NAME)
          && m.rcept_dt === r.rcept_dt)
      || null;
    const qty = match ? parseDartSignedNumber(match.stkqy) : null;
    const qtyDelta = match ? parseDartSignedNumber(match.stkqy_irds) : null;
    const rate = match ? parseDartSignedNumber(match.stkrt) : null;
    const rateDelta = match ? parseDartSignedNumber(match.stkrt_irds) : null;
    const type = inferPensionEventType(r.report_nm, qtyDelta, rateDelta);
    rows.push({
      rceptNo: r.rcept_no,
      rceptDt: parseDartDate(r.rcept_dt),
      corpName: r.corp_name || '',
      stockCode: r.stock_code || '',
      reportNm: r.report_nm || '',
      type,
      holdingQty: qty,
      changeQty: qtyDelta,
      holdingRate: rate,
      changeRate: rateDelta,
      reportResn: match?.report_resn || '',
      dartUrl: dartReportUrl(r.rcept_no),
    });
  }
  // 최신 보고 우선.
  rows.sort((a, b) => (b.rceptDt || '').localeCompare(a.rceptDt || ''));

  // 종목별 최신 보유 정보 → 도넛 차트용 holdings 배열.
  // 같은 corpName 의 여러 보고가 있으면 가장 최근 rceptDt 의 값을 채택.
  // holdingQty / holdingRate 가 둘 다 없는 종목은 제외.
  const byCorp = new Map();
  for (const r of rows) {
    if (!r.corpName) continue;
    const key = r.corpName;
    const prev = byCorp.get(key);
    const isNewer = !prev || (r.rceptDt || '').localeCompare(prev.rceptDt || '') > 0;
    if (isNewer && (r.holdingQty != null || r.holdingRate != null)) {
      byCorp.set(key, {
        corpName: r.corpName,
        stockCode: r.stockCode,
        holdingQty: r.holdingQty,
        holdingRate: r.holdingRate,
        rceptDt: r.rceptDt,
      });
    }
  }
  const holdings = Array.from(byCorp.values())
    .sort((a, b) => (b.holdingRate || 0) - (a.holdingRate || 0));

  return { ok: true, rows, holdings, totalReports: list.length, daysBack, dartMeta };
}

// ----------------------------------------------------------------------------
// 폴백 소스: goinsider.kr/entity/national-pension
// DART 가 비활성/인증대기/IP차단/빈 응답인 경우 자동으로 사용.
// 페이지가 SSR HTML 이라 별도 API 키 불필요. 표는 8 컬럼 <tr> 구조:
//   [순번 | 종목명+코드+시장 | 보유금액 | 비중 | 변동 | 지분율 | 보고유형 | 보고일]
// ----------------------------------------------------------------------------

const GOINSIDER_URL = 'https://goinsider.kr/entity/national-pension/?tab=timeline&timeline_limit=200';

function stripHtmlTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

// "▲ +1.3M주" / "▼ -59.9M" / "1,234,567주" 등의 변동 텍스트를 부호 + 수량으로 분리.
function parseGoinsiderDelta(text) {
  const t = String(text || '').trim();
  if (!t) return { sign: 0, qty: null, raw: '' };
  const up = /▲|\+/.test(t);
  const down = /▼|\-/.test(t);
  // 숫자 + 단위 (K/M/B/만/억/조). 한국식 우선.
  const m = t.replace(/[▲▼\s주]/g, '').match(/^([+\-]?[\d,.]+)([KMB만억조]?)/i);
  if (!m) return { sign: up ? 1 : down ? -1 : 0, qty: null, raw: t };
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return { sign: up ? 1 : down ? -1 : 0, qty: null, raw: t };
  const unit = m[2] || '';
  const mult = ({
    'K': 1e3, 'M': 1e6, 'B': 1e9,
    '만': 1e4, '억': 1e8, '조': 1e12,
  })[unit] || 1;
  n = Math.abs(n) * mult;
  const sign = up ? 1 : down ? -1 : (m[1].startsWith('-') ? -1 : 1);
  return { sign, qty: sign * n, raw: t };
}

function parseGoinsiderPercent(text) {
  const m = String(text || '').replace(/,/g, '').match(/[+\-]?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// "삼성전자 005930 KOSPI" → { corpName, stockCode, market }.
// goinsider 의 <a> 텍스트는 공백 분리. 6자리 숫자가 종목코드, 마지막 토큰이 시장.
function parseGoinsiderName(text) {
  const t = String(text || '').trim();
  const codeM = t.match(/\b(\d{6})\b/);
  const stockCode = codeM ? codeM[1] : '';
  let market = '';
  const marketM = t.match(/\b(KOSPI|KOSDAQ|KONEX)\b/i);
  if (marketM) market = marketM[1].toUpperCase();
  const corpName = t
    .replace(stockCode, '')
    .replace(/\b(KOSPI|KOSDAQ|KONEX)\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { corpName, stockCode, market };
}

async function fetchGoinsiderPension(daysBack) {
  const r = await httpsGetBuffer(GOINSIDER_URL, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
    timeoutMs: 10_000,
  });
  if (!r.ok) {
    logLine('warn', 'goinsider.http', { status: r.status, err: r.error || null });
    return { ok: false, reason: `goinsider HTTP ${r.status}`, rows: [], debug: { httpStatus: r.status, err: r.error || null } };
  }
  const html = r.body;

  // 진단 — 응답 구조 추적용. Cloudflare challenge 가 떴는지 등.
  const debug = {
    bodyLength: html.length,
    trCount: (html.match(/<tr\b/g) || []).length,
    tableCount: (html.match(/<table\b/g) || []).length,
    code6Count: (html.match(/\b\d{6}\b/g) || []).length,
    hasCloudflare: /cloudflare|Just a moment|cf-browser-verification/i.test(html),
    snippet: html.slice(0, 300).replace(/\s+/g, ' '),
  };

  // <tr> 들 중 6자리 종목코드가 들어있는 것만 후보로 잡는다.
  const rows = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const inner = m[1];
    if (!/\b\d{6}\b/.test(inner)) continue;
    const tdRe = /<td\b[^>]*>([\s\S]*?)<\/td>/g;
    const cells = [];
    let mm;
    while ((mm = tdRe.exec(inner)) !== null) cells.push(stripHtmlTags(mm[1]));
    if (cells.length < 7) continue;
    // 표가 [순번, 종목명, 보유금액, 비중, 변동, 지분율, 보고유형, 보고일] 8칸 기준.
    // 다만 페이지 마크업이 살짝 바뀔 수 있어 마지막 칸을 날짜로 가정.
    const lastCell = cells[cells.length - 1] || '';
    const dateM = lastCell.match(/(\d{4})[-./](\d{2})[-./](\d{2})/);
    const rceptDt = dateM ? `${dateM[1]}-${dateM[2]}-${dateM[3]}` : '';
    if (!rceptDt) continue;
    const reportNm = cells[cells.length - 2] || '';
    const holdingPctRaw = cells[cells.length - 3];
    const changeRaw = cells[cells.length - 4];
    const nameCell = cells.find(c => /\b\d{6}\b/.test(c)) || cells[1] || '';
    const { corpName, stockCode, market } = parseGoinsiderName(nameCell);
    if (!corpName || !stockCode) continue;
    const { sign, qty } = parseGoinsiderDelta(changeRaw);
    const holdingRate = parseGoinsiderPercent(holdingPctRaw);
    const type = /신규/.test(reportNm) ? 'new'
      : sign > 0 ? 'buy'
      : sign < 0 ? 'sell'
      : 'hold';
    rows.push({
      rceptNo: '',
      rceptDt,
      corpName,
      stockCode,
      market,
      reportNm,
      type,
      holdingQty: null,
      changeQty: qty,
      holdingRate,
      changeRate: null,
      reportResn: '',
      dartUrl: '', // goinsider 행에는 개별 rcept_no 가 없어서 미연결.
    });
  }
  // 날짜 필터.
  const cutoff = new Date(Date.now() - daysBack * 86400_000).toISOString().slice(0, 10);
  const filtered = rows.filter(r => (r.rceptDt || '') >= cutoff);
  filtered.sort((a, b) => (b.rceptDt || '').localeCompare(a.rceptDt || ''));
  // holdings: 종목별 최신 지분율로 도넛 채우기.
  const byCorp = new Map();
  for (const r of filtered) {
    if (!r.corpName || r.holdingRate == null) continue;
    const prev = byCorp.get(r.corpName);
    if (!prev || (r.rceptDt || '').localeCompare(prev.rceptDt || '') > 0) {
      byCorp.set(r.corpName, {
        corpName: r.corpName,
        stockCode: r.stockCode,
        holdingQty: null,
        holdingRate: r.holdingRate,
        rceptDt: r.rceptDt,
      });
    }
  }
  const holdings = Array.from(byCorp.values()).sort((a, b) => (b.holdingRate || 0) - (a.holdingRate || 0));
  debug.matchedRows = rows.length;
  debug.filteredRows = filtered.length;
  return { ok: true, rows: filtered, holdings, totalReports: filtered.length, debug };
}

async function handlePensionFlows(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'GET only' });
  const url = new URL(req.url, 'http://x');
  let daysBack = parseInt(url.searchParams.get('days') || '30', 10);
  if (!Number.isFinite(daysBack) || daysBack < 1) daysBack = 30;
  if (daysBack > 180) daysBack = 180;
  const sourceParam = url.searchParams.get('source') || 'auto'; // 'dart' | 'goinsider' | 'auto'

  const cacheKey = `__pension:${daysBack}:${sourceParam}`;
  const { entry, stale } = getStockCacheEntry(cacheKey, STOCK_TAB_TTL_PENSION);
  if (entry && !stale) {
    return reply(res, 200, { ok: true, ...entry.payload, cached: true });
  }

  let payload = null;
  let usedSource = null;
  // 진단 — 두 소스 모두 실패했을 때 사용자에게 정확히 어디서 실패했는지 보여주기 위함.
  const sourceTrace = { dart: null, goinsider: null };

  // 1) DART 시도 — 키 있고 source≠goinsider 일 때.
  if (sourceParam !== 'goinsider' && dartConfigured()) {
    const dartResult = await fetchPensionFlows(daysBack);
    sourceTrace.dart = {
      tried: true,
      ok: !!dartResult.ok,
      rows: dartResult.rows?.length || 0,
      totalReports: dartResult.totalReports || 0,
      status: dartResult.dartMeta?.lastStatus || null,
      message: dartResult.dartMeta?.lastMessage || dartResult.reason || '',
    };
    if (dartResult.ok && (dartResult.rows.length || dartResult.totalReports > 0)) {
      usedSource = 'dart';
      payload = {
        rows: dartResult.rows,
        holdings: dartResult.holdings || [],
        totalReports: dartResult.totalReports,
        daysBack,
        source: 'dart',
        dartMeta: dartResult.dartMeta || null,
        ts: nowKST(),
      };
    } else {
      logLine('info', 'pension.dart-fallback', {
        reason: dartResult.reason || 'empty',
        dartStatus: dartResult.dartMeta?.lastStatus || null,
      });
    }
  } else if (!dartConfigured()) {
    sourceTrace.dart = { tried: false, reason: 'DART_API_KEY 미설정' };
  }

  // 2) DART 실패/빈 결과/키 없음 → goinsider 폴백.
  if (!payload && sourceParam !== 'dart') {
    const giResult = await fetchGoinsiderPension(daysBack);
    sourceTrace.goinsider = {
      tried: true,
      ok: !!giResult.ok,
      rows: giResult.rows?.length || 0,
      reason: giResult.reason || (giResult.rows?.length ? 'ok' : 'no-rows-after-filter'),
      debug: giResult.debug || null,
    };
    if (giResult.ok && giResult.rows.length) {
      usedSource = 'goinsider';
      payload = {
        rows: giResult.rows,
        holdings: giResult.holdings || [],
        totalReports: giResult.totalReports,
        daysBack,
        source: 'goinsider',
        sourceUrl: 'https://goinsider.kr/entity/national-pension',
        ts: nowKST(),
      };
    } else {
      logLine('warn', 'pension.goinsider.empty', {
        reason: giResult.reason || 'no-rows',
        debug: giResult.debug || null,
      });
    }
  }

  if (!payload) {
    if (entry) return reply(res, 200, { ok: true, ...entry.payload, cached: true, stale: true });
    // 양쪽 다 실패 — 진단 정보를 사용자에게 보여주기 위해 sourceTrace 포함.
    return reply(res, 200, {
      ok: false,
      error: '국민연금 데이터를 가져오지 못했습니다.',
      sourceTrace,
      rows: [], holdings: [], source: null, daysBack,
    });
  }

  writeStockCacheKey(cacheKey, payload);
  logLine('info', 'pension.ok', { source: usedSource, count: payload.rows.length });
  reply(res, 200, { ok: true, ...payload });
}

// ============================================================================
// Hyperliquid — 삼성·SK하이닉스 야간선물 (HIP-3 RWA perp)
// ----------------------------------------------------------------------------
// app.hyperliquid.xyz/trade/xyz:SAMSUNG, :SKHYNIX 의 mark price 를 받아온다.
// HIP-3 빌더 DEX 형식: { type:'metaAndAssetCtxs', dex:'xyz' }.
// 메인 DEX 에도 있을 수 있어 둘 다 시도. universe[i].name 매칭 후 ctxs[i] 가격.
// 키 불필요. TTL 30초.
// ----------------------------------------------------------------------------

const HYPERLIQUID_API = 'https://api.hyperliquid.xyz/info';
const HYPERLIQUID_TTL = 30_000;
const HYPERLIQUID_BUILDER = 'xyz';
const USDKRW_FX_TTL = 60_000;

// USDKRW 환율 — autoPoll 또는 /api/quotes 가 캐시에 채워둔 값을 우선.
// 60초 이내면 그대로 쓰고, 오래됐으면 KRW=X 만 즉시 fetch.
async function getUsdKrwRate() {
  const cache = readJSON(QUOTE_CACHE_FILE, { updatedAt: '', quotes: {} });
  const entry = cache.quotes['USDKRW'];
  const fresh = entry && entry.ts && (Date.now() - new Date(entry.ts).getTime() < USDKRW_FX_TTL);
  if (fresh && Number.isFinite(Number(entry.rate))) return Number(entry.rate);
  try {
    const yh = await fetchYahoo(['KRW=X']);
    const v = yh['KRW=X'];
    if (v && Number.isFinite(Number(v.price))) {
      cache.quotes['USDKRW'] = {
        rate: v.price,
        previousClose: v.previousClose,
        changePct: v.previousClose ? ((v.price - v.previousClose) / v.previousClose) * 100 : null,
        ts: v.ts,
        source: 'yahoo',
      };
      cache.updatedAt = nowKST();
      writeJSON(QUOTE_CACHE_FILE, cache);
      return Number(v.price);
    }
  } catch (e) {
    logLine('warn', 'fx.usdkrw.fail', { err: String(e && e.message || e) });
  }
  return entry && Number.isFinite(Number(entry.rate)) ? Number(entry.rate) : null;
}
// URL 슬러그(사용자 페이지) ≠ universe asset 이름 (Hyperliquid 내부).
// 라운드 12-tri 확정: SAMSUNG → SMSN (Samsung ADR 티커), SKHYNIX → SKHX.
// app.hyperliquid.xyz 가 URL 에는 친숙한 별칭을 쓰지만 실제 perp 이름은 ADR 티커.
const HYPERLIQUID_ASSETS = [
  { key: 'SAMSUNG', universeName: 'xyz:SMSN', urlSlug: 'xyz:SAMSUNG', label: '삼성전자',  unit: 'USD' },
  { key: 'SKHYNIX', universeName: 'xyz:SKHX', urlSlug: 'xyz:SKHYNIX', label: 'SK하이닉스', unit: 'USD' },
];

async function fetchHyperliquidPerp() {
  const aggregated = {};
  const diagnostics = { triedDexs: [], errors: [] };

  // 1) HIP-3 'xyz' builder DEX 의 metaAndAssetCtxs — 라운드 12-tri 의 검증된 정답.
  const body = { type: 'metaAndAssetCtxs', dex: HYPERLIQUID_BUILDER };
  diagnostics.triedDexs.push(HYPERLIQUID_BUILDER);
  const r = await httpsPostJson(HYPERLIQUID_API, body, {
    headers: { 'Referer': 'https://app.hyperliquid.xyz/' },
    timeoutMs: 8000,
  });
  if (!r.ok) {
    logLine('warn', 'hl.http', { dex: HYPERLIQUID_BUILDER, status: r.status, err: r.error || null });
    diagnostics.errors.push({ dex: HYPERLIQUID_BUILDER, status: r.status });
    return { symbols: aggregated, diagnostics };
  }
  try {
    const j = JSON.parse(r.body);
    if (!Array.isArray(j) || j.length < 2) {
      diagnostics.errors.push({ dex: HYPERLIQUID_BUILDER, err: 'unexpected response shape' });
      return { symbols: aggregated, diagnostics };
    }
    const universe = Array.isArray(j[0]?.universe) ? j[0].universe : [];
    const ctxs = Array.isArray(j[1]) ? j[1] : [];
    diagnostics.universeSize = universe.length;
    for (const asset of HYPERLIQUID_ASSETS) {
      // exact match on universeName (예: 'xyz:SMSN').
      const idx = universe.findIndex(u => String(u?.name || '') === asset.universeName);
      if (idx < 0 || !ctxs[idx]) {
        diagnostics.errors.push({ key: asset.key, universeName: asset.universeName, err: 'not-found-in-universe' });
        continue;
      }
      const c = ctxs[idx];
      const markPx = Number(c.markPx);
      const prevDayPx = Number(c.prevDayPx);
      aggregated[asset.key] = {
        markPx: Number.isFinite(markPx) ? markPx : null,
        oraclePx: c.oraclePx != null ? Number(c.oraclePx) : null,
        prevDayPx: Number.isFinite(prevDayPx) ? prevDayPx : null,
        midPx: c.midPx != null ? Number(c.midPx) : null,
        funding: c.funding != null ? Number(c.funding) : null,
        openInterest: c.openInterest != null ? Number(c.openInterest) : null,
        dayNtlVlm: c.dayNtlVlm != null ? Number(c.dayNtlVlm) : null,
        universeName: asset.universeName,
        unit: asset.unit,
        dex: HYPERLIQUID_BUILDER,
      };
    }
  } catch (e) {
    logLine('warn', 'hl.parse', { dex: HYPERLIQUID_BUILDER, err: String(e) });
    diagnostics.errors.push({ dex: HYPERLIQUID_BUILDER, parseErr: String(e) });
  }
  return { symbols: aggregated, diagnostics };
}

async function handleNightFutures(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'GET only' });
  const cacheKey = '__hl_night';
  const { entry, stale } = getStockCacheEntry(cacheKey, HYPERLIQUID_TTL);
  if (entry && !stale) {
    return reply(res, 200, { ok: true, ...entry.payload, cached: true });
  }
  // Hyperliquid 가격 + USDKRW 환율 병렬 호출. 환율은 KRW 메인 표시용.
  const [result, usdKrwRate] = await Promise.all([
    fetchHyperliquidPerp(),
    getUsdKrwRate(),
  ]);
  const symbols = result.symbols || {};
  const sources = {};
  const labels = {};
  const units = {};
  for (const a of HYPERLIQUID_ASSETS) {
    sources[a.key] = `https://app.hyperliquid.xyz/trade/${a.urlSlug}`;
    labels[a.key] = a.label;
    units[a.key] = a.unit;
  }
  const payload = {
    symbols, sources, labels, units,
    usdKrwRate,
    diagnostics: result.diagnostics || null,
    ts: nowKST(),
  };
  if (Object.keys(symbols).length) {
    writeStockCacheKey(cacheKey, payload);
    logLine('info', 'hl.ok', { found: Object.keys(symbols), dexs: Object.values(symbols).map(s => s.dex) });
  } else {
    logLine('warn', 'hl.empty', { triedDexs: result.diagnostics?.triedDexs || [] });
    if (entry) return reply(res, 200, { ok: true, ...entry.payload, cached: true, stale: true });
  }
  reply(res, 200, { ok: true, ...payload });
}

// ============================================================================
// KRX 정보데이터시스템 — 연기금 일별 매매 (시장 전체)
// ----------------------------------------------------------------------------
// pykrx 의 투자자별_거래실적_전체시장_일별추이_상세 패턴.
//   POST https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd
//   bld = dbms/MDC/STAT/standard/MDCSTAT02203
//   detailView=1 → 응답에 TRDVAL7 (연기금) 컬럼 노출.
// 인증 불필요. 비공식 endpoint 라 KRX 가 변경 가능 — 실패 로그 모니터링 필요.
// ----------------------------------------------------------------------------

const KRX_API = 'https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd';
const KRX_LOADER_URL = 'https://data.krx.co.kr/contents/MDC/MDI/outerLoader/index.cmd';
const KRX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const KRX_PENSION_TTL = 60 * 60 * 1000; // 1h
const KRX_SESSION_TTL = 10 * 60 * 1000; // 10분

// 세션 쿠키 캐시. pykrx 의 build_krx_session 패턴 — 먼저 outerLoader 페이지 GET 으로
// JSESSIONID 받아두고 POST 요청에 Cookie 헤더로 동봉해야 KRX 가 400 안 줌.
let krxSessionCache = null; // { cookie: 'JSESSIONID=...', expiresAt: ms }

function fetchKrxSessionCookieOnce() {
  return new Promise((resolve) => {
    try {
      const u = new URL(KRX_LOADER_URL);
      const opts = {
        method: 'GET',
        hostname: u.hostname,
        path: u.pathname,
        headers: {
          'User-Agent': KRX_UA,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        },
        timeout: 8000,
      };
      const req = https.request(opts, (r) => {
        const setCookie = r.headers['set-cookie'] || [];
        let cookieStr = '';
        for (const c of setCookie) {
          const m = String(c).match(/JSESSIONID=([^;]+)/i);
          if (m) { cookieStr = `JSESSIONID=${m[1]}`; break; }
        }
        r.on('data', () => {}); // body 버림
        r.on('end', () => resolve({ ok: !!cookieStr, cookie: cookieStr, status: r.statusCode || 0 }));
      });
      req.on('error', (e) => resolve({ ok: false, cookie: '', status: 0, error: String(e) }));
      req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch {} });
      req.end();
    } catch (e) {
      resolve({ ok: false, cookie: '', status: 0, error: String(e) });
    }
  });
}

async function getKrxSession() {
  if (krxSessionCache && krxSessionCache.expiresAt > Date.now()) return krxSessionCache.cookie;
  const r = await fetchKrxSessionCookieOnce();
  if (r.ok && r.cookie) {
    krxSessionCache = { cookie: r.cookie, expiresAt: Date.now() + KRX_SESSION_TTL };
    logLine('info', 'krx.session.ok', { cookieLen: r.cookie.length });
    return r.cookie;
  }
  logLine('warn', 'krx.session.fail', { status: r.status, err: r.error || null });
  return '';
}

function ymdNoDash(d) {
  // KST 기준 YYYYMMDD.
  const k = d.toLocaleString('sv', { timeZone: 'Asia/Seoul' }).slice(0, 10);
  return k.replace(/-/g, '');
}

function parseKrxNumber(s) {
  if (s == null) return null;
  const t = String(s).replace(/,/g, '').trim();
  if (!t || t === '-') return 0;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// pykrx core.py 의 투자자별_거래실적_전체시장_일별추이_상세.fetch 가 보내는 파라미터.
// 우리가 임의로 추가한 share/money/csvxls_isNo 가 KRX 400 의 원인이라 제거.
async function fetchKrxPensionTradingSingle(daysBack, market) {
  const endDt = new Date();
  const strtDt = new Date(Date.now() - daysBack * 86400_000);
  const form = {
    bld: 'dbms/MDC/STAT/standard/MDCSTAT02203',
    locale: 'ko_KR',
    strtDd: ymdNoDash(strtDt),
    endDd: ymdNoDash(endDt),
    mktId: market,
    etf: 'EF',
    etn: 'EN',
    elw: 'ES',
    inqTpCd: '2',
    trdVolVal: '2',  // 거래대금
    askBid: '3',     // 순매수
    detailView: '1',
  };
  // pykrx 가 보내는 정확한 Referer + JSESSIONID Cookie. 쿠키 없으면 400.
  const cookie = await getKrxSession();
  const r = await httpsPostForm(KRX_API, form, {
    headers: {
      'Referer': KRX_LOADER_URL,
      'User-Agent': KRX_UA,
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://data.krx.co.kr',
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      ...(cookie ? { 'Cookie': cookie } : {}),
    },
    timeoutMs: 12_000,
  });
  // 400 이면 세션 만료 가능성 — 캐시 무효화 후 한 번 더 시도.
  if (r.status === 400 && cookie) {
    krxSessionCache = null;
    const cookie2 = await getKrxSession();
    if (cookie2 && cookie2 !== cookie) {
      const r2 = await httpsPostForm(KRX_API, form, {
        headers: {
          'Referer': KRX_LOADER_URL,
          'User-Agent': KRX_UA,
          'X-Requested-With': 'XMLHttpRequest',
          'Origin': 'https://data.krx.co.kr',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
          'Cookie': cookie2,
        },
        timeoutMs: 12_000,
      });
      Object.assign(r, r2);
    }
  }
  if (!r.ok) {
    const snippet = (r.body || '').slice(0, 200);
    logLine('warn', 'krx.http', { market, status: r.status, snippet, err: r.error || null });
    return { ok: false, status: r.status, reason: `KRX HTTP ${r.status}`, rows: [] };
  }
  try {
    const j = JSON.parse(r.body);
    const output = Array.isArray(j.output) ? j.output : [];
    const rows = output.map(rec => {
      const dateStr = rec.TRD_DD || rec.trdDd || '';
      const dateNorm = dateStr.includes('/') ? dateStr.replace(/\//g, '-')
        : dateStr.includes('-') ? dateStr
          : dateStr.length === 8 ? `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`
          : dateStr;
      const netBuy = parseKrxNumber(rec.TRDVAL7 ?? rec.trdval7 ?? rec.PENSION ?? null);
      return { date: dateNorm, netBuyValue: netBuy };
    }).filter(r => r.date && r.netBuyValue != null);
    rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    return { ok: true, rows };
  } catch (e) {
    logLine('warn', 'krx.parse', { market, err: String(e) });
    return { ok: false, reason: 'KRX 응답 파싱 실패', rows: [] };
  }
}

// market: 'STK' (KOSPI) / 'KSQ' (KOSDAQ) / 'ALL' (둘 다 합산).
async function fetchKrxPensionTrading(daysBack, market = 'ALL') {
  if (market !== 'ALL') return fetchKrxPensionTradingSingle(daysBack, market);
  // ALL = STK + KSQ. KRX 가 'ALL' 을 안 받으면 따로 호출해서 합산.
  const direct = await fetchKrxPensionTradingSingle(daysBack, 'ALL');
  if (direct.ok && direct.rows.length) return direct;
  const [kospi, kosdaq] = await Promise.all([
    fetchKrxPensionTradingSingle(daysBack, 'STK'),
    fetchKrxPensionTradingSingle(daysBack, 'KSQ'),
  ]);
  if (!kospi.ok && !kosdaq.ok) {
    return { ok: false, reason: kospi.reason || kosdaq.reason || 'KRX 호출 실패', rows: [] };
  }
  // 같은 날짜끼리 합산.
  const byDate = new Map();
  for (const row of (kospi.rows || [])) byDate.set(row.date, (byDate.get(row.date) || 0) + (row.netBuyValue || 0));
  for (const row of (kosdaq.rows || [])) byDate.set(row.date, (byDate.get(row.date) || 0) + (row.netBuyValue || 0));
  const rows = Array.from(byDate.entries())
    .map(([date, netBuyValue]) => ({ date, netBuyValue }))
    .sort((a, b) => b.date.localeCompare(a.date));
  return { ok: true, rows };
}

async function handleKrxPensionTrading(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'GET only' });
  const url = new URL(req.url, 'http://x');
  let daysBack = parseInt(url.searchParams.get('days') || '30', 10);
  if (!Number.isFinite(daysBack) || daysBack < 1) daysBack = 30;
  if (daysBack > 180) daysBack = 180;
  const market = (url.searchParams.get('market') || 'ALL').toUpperCase();
  const validMarket = ['STK', 'KSQ', 'ALL'].includes(market) ? market : 'ALL';

  const cacheKey = `__krx-pension:${daysBack}:${validMarket}`;
  const { entry, stale } = getStockCacheEntry(cacheKey, KRX_PENSION_TTL);
  if (entry && !stale) {
    return reply(res, 200, { ok: true, ...entry.payload, cached: true });
  }
  const result = await fetchKrxPensionTrading(daysBack, validMarket);
  if (!result.ok || !result.rows.length) {
    if (entry) return reply(res, 200, { ok: true, ...entry.payload, cached: true, stale: true });
    return reply(res, 200, {
      ok: false,
      error: result.reason || 'KRX 응답 없음',
      rows: [],
      daysBack,
      market: validMarket,
    });
  }
  // 통계 — 매수 우세 일수 / 매도 우세 일수 / 누적 순매수.
  let buyDays = 0, sellDays = 0, netSum = 0;
  for (const r of result.rows) {
    if (r.netBuyValue > 0) buyDays++;
    else if (r.netBuyValue < 0) sellDays++;
    netSum += r.netBuyValue;
  }
  const payload = {
    rows: result.rows,
    daysBack,
    market: validMarket,
    summary: { buyDays, sellDays, netSum },
    source: 'krx',
    sourceUrl: 'https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201020201',
    ts: nowKST(),
  };
  writeStockCacheKey(cacheKey, payload);
  logLine('info', 'krx.ok', { market: validMarket, days: daysBack, rowsCount: result.rows.length });
  reply(res, 200, { ok: true, ...payload });
}

// ============================================================================
// 국민연금공단 기금 포트폴리오 (data.go.kr 자동변환 OpenAPI)
// ----------------------------------------------------------------------------
// 데이터셋 15106894 — 월별 자산군별/세부 포트폴리오 현황.
// 호출: GET https://api.odcloud.kr/api/15106894/v1/uddi:{uuid}
//        ?page=1&perPage=100&returnType=JSON&serviceKey=<DATA_GO_KR_SERVICE_KEY>
// 인증: serviceKey (Encoding 키 — URL-safe %2B/%2F 포함). data.go.kr 마이페이지 발급.
// ----------------------------------------------------------------------------

const NPS_PORTFOLIO_BASE = 'https://api.odcloud.kr/api/15106894/v1';
const NPS_PORTFOLIO_DEFAULT_UDDI = 'uddi:365e3f72-e17e-4b10-a6ef-db2587ac3ee0';
const NPS_PORTFOLIO_TTL = 6 * 60 * 60 * 1000; // 6h (월별 데이터라 길게)

function dataGoKrKey() { return (process.env.DATA_GO_KR_SERVICE_KEY || '').trim(); }
function dataGoKrConfigured() { return dataGoKrKey().length >= 30; }

async function fetchNpsPortfolio({ uddi, page = 1, perPage = 100 } = {}) {
  if (!dataGoKrConfigured()) {
    return { ok: false, reason: 'DATA_GO_KR_SERVICE_KEY 미설정' };
  }
  const u = uddi || NPS_PORTFOLIO_DEFAULT_UDDI;
  // serviceKey 가 이미 URL-encoded 인 경우가 많아 그대로 두기 (Encoding 키).
  const url = `${NPS_PORTFOLIO_BASE}/${encodeURIComponent(u)}`
    + `?page=${page}&perPage=${perPage}&returnType=JSON&serviceKey=${dataGoKrKey()}`;
  const r = await httpsGet(url, {
    headers: { 'Accept': 'application/json' },
    timeoutMs: 12_000,
  });
  if (!r.ok) {
    const snippet = (r.body || '').slice(0, 200);
    logLine('warn', 'nps.http', { status: r.status, snippet, err: r.error || null });
    return { ok: false, reason: `data.go.kr HTTP ${r.status}`, status: r.status, snippet };
  }
  try {
    const j = JSON.parse(r.body);
    const data = Array.isArray(j.data) ? j.data : [];
    return {
      ok: true,
      data,
      currentCount: j.currentCount ?? data.length,
      matchCount: j.matchCount ?? null,
      totalCount: j.totalCount ?? null,
      page: j.page ?? page,
      perPage: j.perPage ?? perPage,
    };
  } catch (e) {
    logLine('warn', 'nps.parse', { err: String(e) });
    return { ok: false, reason: 'data.go.kr 응답 파싱 실패' };
  }
}

async function handleNpsPortfolio(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'GET only' });
  if (!dataGoKrConfigured()) {
    return reply(res, 200, {
      ok: false,
      error: 'DATA_GO_KR_SERVICE_KEY 환경변수가 설정되지 않았습니다.',
      hint: 'Render Environment 메뉴에서 등록 후 자동 재배포 완료까지 1-2분.',
    });
  }
  const url = new URL(req.url, 'http://x');
  const uddi = url.searchParams.get('uddi') || NPS_PORTFOLIO_DEFAULT_UDDI;
  const page = parseInt(url.searchParams.get('page') || '1', 10) || 1;
  const perPage = Math.min(parseInt(url.searchParams.get('perPage') || '100', 10) || 100, 1000);

  const cacheKey = `__nps:${uddi}:${page}:${perPage}`;
  const { entry, stale } = getStockCacheEntry(cacheKey, NPS_PORTFOLIO_TTL);
  if (entry && !stale) {
    return reply(res, 200, { ok: true, ...entry.payload, cached: true });
  }
  const result = await fetchNpsPortfolio({ uddi, page, perPage });
  if (!result.ok) {
    if (entry) return reply(res, 200, { ok: true, ...entry.payload, cached: true, stale: true });
    return reply(res, 200, {
      ok: false,
      error: result.reason || 'data.go.kr 호출 실패',
      status: result.status || null,
      snippet: result.snippet || null,
    });
  }
  const payload = {
    data: result.data,
    currentCount: result.currentCount,
    matchCount: result.matchCount,
    totalCount: result.totalCount,
    page: result.page,
    perPage: result.perPage,
    uddi,
    source: 'data.go.kr',
    sourceUrl: 'https://www.data.go.kr/data/15106894/fileData.do',
    ts: nowKST(),
  };
  writeStockCacheKey(cacheKey, payload);
  logLine('info', 'nps.ok', { rows: result.data.length, totalCount: result.totalCount });
  reply(res, 200, { ok: true, ...payload });
}

// 사용자가 새 환경변수 등록 후 활성 여부를 확인할 수 있도록 boolean 만 노출.
// 민감 키(NAVER_CLIENT_SECRET / ANTHROPIC_API_KEY / TELEGRAM_BOT_TOKEN) 는 응답에서 제외.
// 길이 노출도 형식 추측 단서가 되므로 제거. 이 endpoint 는 셋업 확인 후 제거 가능.
async function handleConfigStatus(req, res) {
  if (req.method !== 'GET') return reply(res, 405, { ok: false, error: 'GET only' });
  reply(res, 200, {
    ok: true,
    keys: {
      DART_API_KEY:           dartConfigured(),
      DATA_GO_KR_SERVICE_KEY: !!(process.env.DATA_GO_KR_SERVICE_KEY || '').trim(),
    },
    ts: nowKST(),
  });
}

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

    // 주식 탭
    if (urlPath === '/api/indices')       return await handleIndices(req, res);
    if (urlPath === '/api/stock-movers')  return await handleStockMovers(req, res);
    if (urlPath === '/api/stock-search')  return await handleStockSearch(req, res);
    if (urlPath === '/api/stock-news')    return await handleStockNews(req, res);
    if (urlPath === '/api/pension-flows') return await handlePensionFlows(req, res);
    if (urlPath === '/api/krx-pension-trading') return await handleKrxPensionTrading(req, res);
    if (urlPath === '/api/nps-portfolio') return await handleNpsPortfolio(req, res);
    if (urlPath === '/api/night-futures') return await handleNightFutures(req, res);
    if (urlPath === '/api/config-status') return await handleConfigStatus(req, res);

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

// 종목 마스터 — 부팅 직후 + 매일 1회 갱신.
setTimeout(buildStockMaster, 3_000);
setInterval(buildStockMaster, 24 * 60 * 60 * 1000);

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
