#!/usr/bin/env node
// 네이버 시가총액 목록으로 data/stock-symbols.json 을 다시 만든다.
// 장외·주말에도 목록이 나오는 주소를 쓴다.
//   node scripts/refresh-stock-symbols.js
//
// 서버는 부팅 때 이 파일을 읽고, 가능하면 같은 주소로 메모리 목록을 갱신한다.
// 이 스크립트는 수동 실행용이다. 배포 중 자동으로 돌지 않는다.

'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const { normalizeTicker } = require('../stockSearch');

const OUT = path.join(__dirname, '..', 'data', 'stock-symbols.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function getJson(url, referer) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Referer': referer, 'Accept': 'application/json' },
      timeout: 12000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} ${url}`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout ' + url)); });
  });
}

async function fetchPages(label, pages, urlFor, referer, mapItem) {
  const out = [];
  for (let page = 1; page <= pages; page++) {
    const url = urlFor(page);
    let j;
    try {
      j = await getJson(url, referer);
    } catch (e) {
      console.warn(`[${label}] page ${page} 실패: ${e.message}`);
      break;
    }
    const items = j.stocks || [];
    if (!Array.isArray(items) || !items.length) break;
    for (const it of items) {
      const row = mapItem(it);
      if (row) out.push(row);
    }
    if (items.length < 100) break;
  }
  console.log(`[${label}] ${out.length}`);
  return out;
}

async function main() {
  const kr = (exchange) => fetchPages(
    exchange,
    exchange === 'KOSPI' ? 5 : 4,
    (page) => `https://m.stock.naver.com/api/stocks/marketValue/${exchange}?page=${page}&pageSize=100`,
    'https://m.stock.naver.com/',
    (it) => {
      const code = normalizeTicker(it.itemCode || it.symbolCode || '');
      const name = String(it.stockName || '').trim();
      if (!code || !name) return null;
      return { code, name, market: exchange, type: 'stock_kr' };
    },
  );
  const us = (exchange, pages) => fetchPages(
    exchange,
    pages,
    (page) => `https://api.stock.naver.com/stock/exchange/${exchange}/marketValue?page=${page}&pageSize=100`,
    'https://stock.naver.com/',
    (it) => {
      const code = normalizeTicker(it.symbolCode || it.itemCode || it.reutersCode || '');
      const name = String(it.stockName || it.stockNameEng || '').trim();
      if (!code || !name) return null;
      const row = { code, name, market: exchange, type: 'stock_us' };
      const eng = String(it.stockNameEng || '').trim();
      if (eng && eng.toLowerCase() !== name.toLowerCase()) row.aliases = [eng];
      return row;
    },
  );

  const groups = await Promise.all([
    kr('KOSPI'),
    kr('KOSDAQ'),
    us('NASDAQ', 3),
    us('NYSE', 2),
  ]);
  const seen = new Set();
  const stocks = [];
  for (const g of groups) {
    for (const s of g) {
      if (seen.has(s.code)) continue;
      seen.add(s.code);
      stocks.push(s);
    }
  }
  if (stocks.length < 400) {
    console.error(`종목이 ${stocks.length}개뿐입니다. 파일을 덮어쓰지 않습니다.`);
    process.exit(1);
  }
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    source: 'naver marketValue (KOSPI/KOSDAQ via m.stock, NASDAQ/NYSE via api.stock)',
    stocks,
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`wrote ${stocks.length} → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
