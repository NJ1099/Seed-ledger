/* SEED — Liquid Ledger. 단일 SPA. Chart.js 사용.
   공개 배포판: 사용자별 계좌/거래/스냅샷은 모두 브라우저 localStorage 에 저장.
   공유 API: /api/quotes, /api/events (GET), /api/history, /api/import-pdf.
*/
(function () {
'use strict';

// ---------- 상태 ----------
const state = {
  tab: 'assets',
  accounts: [],
  transactions: [],
  quotes: {},           // { ticker: {priceKRW|priceUSD|rate, ts, source, ...} }
  exchangeRate: null,   // { rate, ts }
  snapshots: [],
  events: [],
  totalsByType: {},
  totalKRW: 0,
  lastSnapshotTotal: null,   // 어제 스냅샷으로 Δ 계산
  txFilter: 'all',
  txSearch: '',
  txSelectedDate: null,        // 'YYYY-MM-DD' 혹은 null (선택 없음 = 전체)
  calMonth: null,              // 'YYYY-MM' — 달력 표시 중인 월
  graphRange: 30,
  charts: {},
  editingTxId: null,
  txSelected: new Set(),
  txPageShown: 30,       // 리스트 표시 개수 (더보기로 +30 씩 증가)
};

const API = {
  accounts: '/api/accounts',
  tx: '/api/transactions',
  quotes: '/api/quotes',
  snapshot: '/api/snapshot',
  snapshots: '/api/snapshots',
  events: '/api/events',
  history: '/api/history',
};

// ---------- 유틸 ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
function fmtKRW(n) {
  if (n == null || !isFinite(n)) return '—';
  return '₩ ' + Math.round(n).toLocaleString('ko-KR');
}
function fmtKRWShort(n) {
  if (n == null || !isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e8) return '₩ ' + (n / 1e8).toFixed(a >= 1e10 ? 0 : 2) + '억';
  if (a >= 1e4) return '₩ ' + (n / 1e4).toFixed(a >= 1e6 ? 0 : 1) + '만';
  return '₩ ' + Math.round(n).toLocaleString('ko-KR');
}
function fmtPct(n, digits = 2) {
  if (n == null || !isFinite(n)) return '';
  return (n >= 0 ? '+' : '') + n.toFixed(digits) + '%';
}
function todayKST() {
  return new Date().toLocaleString('sv', { timeZone: 'Asia/Seoul' }).slice(0, 10);
}
function nowKSTDisplay() {
  return new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'long', timeStyle: 'short' });
}
function genId(prefix, ...parts) {
  const r = Math.random().toString(36).slice(2, 8);
  return [prefix, ...parts, r].filter(Boolean).join('-');
}

// ============================================================
// localStorage 기반 클라이언트 사이드 스토어 (공개 배포판 전용)
// ============================================================
// 개인 자산/거래/스냅샷은 브라우저에만 저장 → 다른 사용자와 섞이지 않는다.
// 기존 코드베이스가 /api/... 를 호출하던 것을 apiGet/apiPost 에서 가로채
// 동일한 응답 형태(ok + payload)로 돌려줘 상위 로직은 수정 없이 동작.

const LS_KEYS = {
  accounts: 'seed:accounts',
  tx: 'seed:transactions',
  snapshots: 'seed:snapshots',       // { [date]: snapshot }
  eventsPersonal: 'seed:events:personal',
};

function lsReadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}
function lsWriteJSON(key, obj) {
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) {
    console.warn('[localStorage] 저장 실패 — 용량 초과 가능성:', e);
    throw new Error('localStorage 저장 실패 (' + e.message + ')');
  }
}

function lsGetAccounts() {
  return lsReadJSON(LS_KEYS.accounts, { version: 1, updatedAt: '', accounts: [] });
}
function lsSetAccounts(data) {
  data.version = 1;
  data.updatedAt = new Date().toISOString();
  lsWriteJSON(LS_KEYS.accounts, data);
}
function lsGetTx() {
  return lsReadJSON(LS_KEYS.tx, { version: 1, updatedAt: '', transactions: [] });
}
function lsSetTx(data) {
  data.version = 1;
  data.updatedAt = new Date().toISOString();
  lsWriteJSON(LS_KEYS.tx, data);
}
function lsGetSnapshots() {
  return lsReadJSON(LS_KEYS.snapshots, {});
}
function lsSetSnapshots(map) {
  lsWriteJSON(LS_KEYS.snapshots, map);
}
function lsGetPersonalEvents() {
  return lsReadJSON(LS_KEYS.eventsPersonal, []);
}
function lsSetPersonalEvents(arr) {
  lsWriteJSON(LS_KEYS.eventsPersonal, arr);
}

function safeMergeObj(base, patch) {
  const out = (base && typeof base === 'object') ? { ...base } : {};
  for (const k of Object.keys(patch || {})) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = patch[k];
  }
  return out;
}

// 로컬에서 계좌 CRUD 를 서버 응답 포맷으로 흉내낸다.
function localAccountsOp(body) {
  const data = lsGetAccounts();
  if (!Array.isArray(data.accounts)) data.accounts = [];
  const { op, account, id, accounts } = body || {};

  if (op === 'create') {
    if (!account) throw new Error('account missing');
    if (data.accounts.some(x => x.id === account.id)) throw new Error('duplicate id');
    data.accounts.push(account);
  } else if (op === 'update') {
    if (!account) throw new Error('account missing');
    const i = data.accounts.findIndex(x => x.id === account.id);
    if (i < 0) throw new Error('not found');
    data.accounts[i] = safeMergeObj(data.accounts[i], account);
  } else if (op === 'delete') {
    data.accounts = data.accounts.filter(x => x.id !== id);
  } else if (op === 'bulk_create') {
    if (!Array.isArray(accounts)) throw new Error('accounts must be array');
    const existingIds = new Set(data.accounts.map(x => x.id));
    const existingKeys = new Set(data.accounts.map(x => x.dedupeKey).filter(Boolean));
    let added = 0, skipped = 0;
    for (const a of accounts) {
      if (existingIds.has(a.id)) { skipped++; continue; }
      if (a.dedupeKey && existingKeys.has(a.dedupeKey)) { skipped++; continue; }
      data.accounts.push(a);
      existingIds.add(a.id);
      if (a.dedupeKey) existingKeys.add(a.dedupeKey);
      added++;
    }
    lsSetAccounts(data);
    return { ok: true, added, skipped, ...data };
  } else {
    throw new Error('invalid op');
  }
  lsSetAccounts(data);
  return { ok: true, ...data };
}

function localTxOp(body) {
  const data = lsGetTx();
  if (!Array.isArray(data.transactions)) data.transactions = [];
  const { op, transaction, id, transactions } = body || {};

  if (op === 'create') {
    if (!transaction) throw new Error('tx missing');
    if (data.transactions.some(x => x.id === transaction.id)) throw new Error('duplicate id');
    data.transactions.push(transaction);
  } else if (op === 'update') {
    if (!transaction) throw new Error('tx missing');
    const i = data.transactions.findIndex(x => x.id === transaction.id);
    if (i < 0) throw new Error('not found');
    data.transactions[i] = safeMergeObj(data.transactions[i], transaction);
  } else if (op === 'delete') {
    data.transactions = data.transactions.filter(x => x.id !== id);
  } else if (op === 'bulk_create') {
    if (!Array.isArray(transactions)) throw new Error('transactions must be array');
    const existingIds = new Set(data.transactions.map(x => x.id));
    const existingKeys = new Set(data.transactions.map(x => x.dedupeKey).filter(Boolean));
    let added = 0, skipped = 0;
    for (const t of transactions) {
      if (existingIds.has(t.id)) { skipped++; continue; }
      if (t.dedupeKey && existingKeys.has(t.dedupeKey)) { skipped++; continue; }
      data.transactions.push(t);
      existingIds.add(t.id);
      if (t.dedupeKey) existingKeys.add(t.dedupeKey);
      added++;
    }
    lsSetTx(data);
    return { ok: true, added, skipped, ...data };
  } else {
    throw new Error('invalid op');
  }
  lsSetTx(data);
  return { ok: true, ...data };
}

function localSnapshotSave(body) {
  const { date, totalKRW, breakdown, quotesUsed } = body || {};
  const d = (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) ? date : todayKST();
  if (typeof totalKRW !== 'number' || !isFinite(totalKRW)) throw new Error('invalid totalKRW');
  const snap = {
    date: d,
    capturedAt: new Date().toISOString(),
    totalKRW: Math.round(totalKRW),
    breakdown: safeMergeObj({}, breakdown || {}),
    quotesUsed: safeMergeObj({}, quotesUsed || {}),
  };
  const map = lsGetSnapshots();
  map[d] = snap;
  lsSetSnapshots(map);
  return { ok: true, snapshot: snap };
}

function localSnapshotsList(qs) {
  // qs: URLSearchParams 인스턴스
  const map = lsGetSnapshots();
  const from = qs?.get?.('from') || '';
  const to = qs?.get?.('to') || '';
  const keys = Object.keys(map).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  const out = [];
  for (const k of keys) {
    if (from && k < from) continue;
    if (to && k > to) continue;
    out.push(map[k]);
  }
  return { ok: true, snapshots: out };
}

function localEventsMerged(serverEvents) {
  // 서버가 제공하는 공유 이벤트 + 사용자 개인 이벤트(localStorage) 합쳐서 반환.
  const personal = lsGetPersonalEvents();
  const marked = personal.map(e => ({ ...e, personal: true }));
  return [...(serverEvents || []), ...marked];
}

function localEventsOp(body) {
  const personal = lsGetPersonalEvents();
  const { op, event, id } = body || {};
  if (op === 'create') {
    if (!event) throw new Error('event missing');
    if (personal.some(x => x.id === event.id)) throw new Error('duplicate id');
    personal.push({ ...event, personal: true });
  } else if (op === 'update') {
    if (!event) throw new Error('event missing');
    const i = personal.findIndex(x => x.id === event.id);
    if (i < 0) throw new Error('personal event 만 수정 가능합니다');
    personal[i] = safeMergeObj(personal[i], event);
  } else if (op === 'delete') {
    const before = personal.length;
    const after = personal.filter(x => x.id !== id);
    if (after.length === before) throw new Error('personal event 만 삭제 가능합니다');
    lsSetPersonalEvents(after);
    return { ok: true, events: after };
  } else {
    throw new Error('invalid op');
  }
  lsSetPersonalEvents(personal);
  return { ok: true, events: personal };
}

// fetch 래퍼 — localStorage 라우팅 포함
async function apiGet(url) {
  const u = new URL(url, window.location.origin);
  const p = u.pathname;

  if (p === '/api/accounts') return lsGetAccounts();
  if (p === '/api/transactions') return lsGetTx();
  if (p === '/api/snapshots') return localSnapshotsList(u.searchParams);

  if (p === '/api/events') {
    // 서버의 공유 이벤트를 가져오되, 실패해도 개인 이벤트는 보여준다.
    let serverEvents = [];
    try {
      const r = await fetch(url);
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j.events)) serverEvents = j.events;
      }
    } catch {}
    const merged = localEventsMerged(serverEvents);
    return { ok: true, version: 2, events: merged };
  }

  // 그 외는 일반 네트워크
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' ' + r.status);
  return r.json();
}

async function apiPost(url, body) {
  const u = new URL(url, window.location.origin);
  const p = u.pathname;

  try {
    let result;
    if (p === '/api/accounts')      result = localAccountsOp(body);
    else if (p === '/api/transactions') result = localTxOp(body);
    else if (p === '/api/snapshot')     result = localSnapshotSave(body);
    else if (p === '/api/events')       result = localEventsOp(body);
    if (result !== undefined) {
      // 사용자 데이터 변경 → 디바운스 백업 예약
      try { notifyDataChanged && notifyDataChanged(); } catch {}
      return result;
    }
  } catch (e) {
    throw new Error(e.message || String(e));
  }

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || ('POST ' + url + ' ' + r.status));
  return j;
}

// ---------- 타입 메타 ----------
const TYPE_LABEL = {
  cash: '현금', savings: '저축', deposit: '예/적금',
  stock_kr: '국내 주식', stock_us: '해외 주식',
  crypto: '암호화폐', brokerage: '증권 계좌',
  realestate: '부동산', custom: '기타',
};
const TYPE_ORDER = ['cash','savings','deposit','stock_kr','stock_us','crypto','brokerage','realestate','custom'];

const CAT_LABEL = {
  // 지출
  card: '카드', cash: '현금', rent: '월세', utility: '공과금',
  subscription: '구독', other: '기타',
  // 저축 기여
  savings: '저축',
  // 자금 이동
  transfer: '자금 이동',
  // 수입
  salary: '월급',
  parttime: '아르바이트',
  bonus: '보너스 / 인센티브',
  interest: '이자 / 배당',
  crypto_income: '코인',
  stock_income: '주식',
  realestate_income: '부동산',
  recurring_income: '고정 수입',
  refund: '환급 / 리펀드',
  other_income: '기타 수입',
};
const CAT_COLOR = {
  // 지출
  card: '#3182F6', cash: '#8B95A1', rent: '#F04452',
  utility: '#0AC17B', subscription: '#F7BE2E', other: '#B0B8C1',
  // 저축 / 이동
  savings: '#7E5BEF', transfer: '#64748B',
  // 수입 — 녹색·청색·골드 계열로 시각 구분
  salary: '#0AC17B',
  parttime: '#34D399',
  bonus: '#F59E0B',
  interest: '#06B6D4',
  crypto_income: '#A855F7',
  stock_income: '#3B82F6',
  realestate_income: '#84CC16',
  recurring_income: '#14B8A6',
  refund: '#FBBF24',
  other_income: '#94A3B8',
};

// 유형별로 보여줄 카테고리 — type 변경 시 카테고리 드롭다운이 이 목록으로 재구성됨.
// 사용자 커스텀 카테고리는 어떤 유형에서도 선택 가능하도록 모든 유형 목록 끝에 합쳐진다.
const TYPE_CATS = {
  expense:              ['card', 'cash', 'rent', 'utility', 'subscription', 'other'],
  income:               ['salary', 'parttime', 'bonus', 'interest', 'crypto_income', 'stock_income', 'realestate_income', 'recurring_income', 'refund', 'other_income'],
  savings_contribution: ['savings'],
  transfer:             ['transfer'],
};

// 사용자 커스텀 카테고리 — localStorage 에 저장. 기본 카테고리 외에 자유 추가 가능.
function getCustomCats() {
  try { return JSON.parse(localStorage.getItem('seed:customCats') || '[]'); }
  catch { return []; }
}
function saveCustomCats(list) {
  localStorage.setItem('seed:customCats', JSON.stringify([...new Set(list)]));
}
function addCustomCat(name) {
  const clean = String(name || '').trim();
  if (!clean || !/^[A-Za-z0-9가-힣_\- /]{1,30}$/.test(clean)) return false;
  const list = getCustomCats();
  if (!list.includes(clean) && !CAT_LABEL[clean]) {
    list.push(clean);
    saveCustomCats(list);
  }
  return true;
}
// 기본 + 커스텀 + 거래에서 나온 카테고리 모두 포함한 목록
function allCategories() {
  const set = new Set(Object.keys(CAT_LABEL));
  for (const c of getCustomCats()) set.add(c);
  for (const t of state.transactions) if (t.category) set.add(t.category);
  return [...set];
}
// 레이블/색상 조회 — 커스텀이면 키 그대로 / 해시 기반 파스텔 색
function catLabel(key) { return CAT_LABEL[key] || key; }
function catColor(key) {
  if (CAT_COLOR[key]) return CAT_COLOR[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) & 0xffff;
  return `hsl(${h % 360}, 55%, 58%)`;
}

// 기관 상수 — 주요 시중·인터넷 은행 + 증권사
const BANKS = [
  'KB국민','신한','우리','하나','NH농협','IBK기업',
  'SC제일','씨티','수협','부산','대구','광주','경남','전북','제주',
  '카카오뱅크','토스뱅크','케이뱅크',
  '새마을금고','신협','우체국',
];
const BROKERS = [
  '미래에셋증권','삼성증권','한국투자증권','NH투자증권','키움증권',
  '신한투자증권','KB증권','하나증권','대신증권','유안타증권','유진투자증권',
  '메리츠증권','DB금융투자','토스증권','카카오페이증권',
];
const BANK_PRODUCTS = ['예금','적금','파킹통장','수시입출','CMA','대출'];
const BROKER_ACCOUNT_KINDS = ['일반','ISA','연금저축','IRP','청년도약'];

// CSV 가져오기 프리셋 — 은행 8 / 카드 6 / 마이데이터 통합 앱 4.
// 컬럼 자동 추정은 `autoMapColumns` 가 헤더명으로 추론. 프리셋은 인코딩·날짜포맷·카테고리 힌트만 제공.
const CSV_PRESETS = {
  // --- 마이데이터 통합 앱 (여러 카드사·은행이 한 파일로 모여 있음) ---
  banksalad:  { kind: 'aggregator', label: '뱅크샐러드',            encoding: 'utf-8', defaultCat: 'other' },
  tossmoney:  { kind: 'aggregator', label: '토스 가계부 / 소비내역', encoding: 'utf-8', defaultCat: 'other' },
  kakaopay:   { kind: 'aggregator', label: '카카오페이 이용내역',    encoding: 'utf-8', defaultCat: 'card'  },
  payco:      { kind: 'aggregator', label: 'PAYCO 이용내역',         encoding: 'utf-8', defaultCat: 'card'  },
  // --- 은행 ---
  shinhan:   { kind: 'bank', label: '신한은행',     encoding: 'euc-kr', defaultCat: 'cash' },
  kakaobank: { kind: 'bank', label: '카카오뱅크',   encoding: 'utf-8',  defaultCat: 'cash' },
  toss:      { kind: 'bank', label: '토스뱅크',     encoding: 'utf-8',  defaultCat: 'cash' },
  kbbank:    { kind: 'bank', label: 'KB국민은행',   encoding: 'euc-kr', defaultCat: 'cash' },
  nhbank:    { kind: 'bank', label: 'NH농협은행',   encoding: 'euc-kr', defaultCat: 'cash' },
  woori:     { kind: 'bank', label: '우리은행',     encoding: 'euc-kr', defaultCat: 'cash' },
  scfirst:   { kind: 'bank', label: 'SC제일은행',   encoding: 'euc-kr', defaultCat: 'cash' },
  welcome:   { kind: 'bank', label: '웰컴저축은행', encoding: 'euc-kr', defaultCat: 'cash' },
  // --- 카드 ---
  samsungcard: { kind: 'card', label: '삼성카드', encoding: 'euc-kr', defaultCat: 'card' },
  hyundaicard: { kind: 'card', label: '현대카드', encoding: 'euc-kr', defaultCat: 'card' },
  bccard:      { kind: 'card', label: 'BC카드',   encoding: 'euc-kr', defaultCat: 'card' },
  kbcard:      { kind: 'card', label: 'KB국민카드', encoding: 'euc-kr', defaultCat: 'card' },
  lottecard:   { kind: 'card', label: '롯데카드', encoding: 'euc-kr', defaultCat: 'card' },
  shinhancard: { kind: 'card', label: '신한카드', encoding: 'euc-kr', defaultCat: 'card' },
};

// 헤더 키워드 힌트 (한글/영문 혼용). 점수 합산으로 가장 높은 열 선택.
// 마이데이터 앱(뱅크샐러드/토스/카카오페이)은 컬럼 이름이 제각각이라 상세히.
const HEADER_HINTS = {
  date:     ['날짜','거래일','거래일자','이용일','이용일자','승인일','승인일자','매출일자','date','사용일','결제일','결제일시','거래일시','사용일시'],
  desc:     ['내용','적요','거래내용','사용처','가맹점','가맹점명','적요내용','이용내역','이용하신곳','상호','description','memo','거래처','이용처','메모','설명'],
  amount:   ['금액','이용금액','사용금액','거래금액','승인금액','합계','amount','결제금액','지출금액'],
  out:      ['출금','출금액','사용','지출','출금금액','withdrawal','debit','지출액','사용액'],
  in:       ['입금','입금액','수입','수령','withdraw','입금금액','credit','deposit','수입액'],
  txType:   ['타입','구분','거래구분','종류','수입/지출','수입지출','type'],
  category: ['대분류','카테고리','분류','소분류','category'],
  method:   ['결제수단','수단','사용수단','계좌','payment method'],
};

// 마이데이터 앱(뱅크샐러드 등)의 "대분류" 한글 → 우리 앱의 category 로 매핑.
// 매칭되지 않으면 preset.defaultCat 사용.
const CSV_CAT_MAP = {
  // 카드 / 카드성 일반 지출
  '식사': 'card', '식비': 'card', '음식': 'card', '외식': 'card',
  '카페/간식': 'card', '카페': 'card', '간식': 'card',
  '교통': 'card', '대중교통': 'card', '택시': 'card',
  '자동차': 'card', '주유': 'card', '자동차관리': 'card',
  '문화/여가': 'card', '여가': 'card', '문화': 'card', '취미': 'card',
  '의료/건강': 'card', '의료': 'card', '건강': 'card', '병원': 'card',
  '의복/미용': 'card', '의류': 'card', '미용': 'card',
  '쇼핑': 'card', '생활': 'card', '생활용품': 'card',
  '경조/선물': 'card', '경조사': 'card', '선물': 'card',
  '교육': 'card', '자녀': 'card', '여행/숙박': 'card', '여행': 'card',
  '반려동물': 'card', '펫': 'card',
  // 주거·통신
  '주거/통신': 'utility', '주거': 'utility', '통신': 'utility',
  '공과금': 'utility', '관리비': 'utility', '전기': 'utility', '가스': 'utility',
  '월세': 'rent', '임대': 'rent',
  // 구독
  '구독': 'subscription', '정기결제': 'subscription',
  // 현금
  '현금': 'cash', 'ATM': 'cash',
  // 저축·투자
  '저축': 'savings', '적금': 'savings', '예금': 'savings',
  '투자': 'savings',
  // 이체·자금이동
  '이체': 'transfer', '송금': 'transfer', '카드대금': 'transfer',
  '금융수입': 'other', '수수료': 'other',
  '미분류': 'other', '기타': 'other',
};
function normalizeCategoryCell(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // 1차: 정확 일치
  if (CSV_CAT_MAP[s]) return CSV_CAT_MAP[s];
  // 2차: 부분 일치 (대분류가 "카페/간식" 같이 슬래시 포함이라 부분검사)
  for (const key of Object.keys(CSV_CAT_MAP)) {
    if (s.includes(key)) return CSV_CAT_MAP[key];
  }
  return null;
}
function normalizeTxTypeCell(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (/지출|expense|결제|출금/.test(s)) return 'expense';
  if (/수입|income|입금|급여/.test(s)) return 'income';
  if (/이체|송금|transfer/.test(s)) return 'transfer';
  return null;
}

// ----- 자산(계좌) 가져오기 프리셋 / 힌트 -----
// kind: stocks_kr | stocks_us | crypto | bank
const ASSET_PRESETS = {
  // 국내 주식 (증권사 보유종목)
  'sec_samsung_kr':    { kind: 'stocks_kr', label: '삼성증권 · 국내주식',   institution: '삼성증권',     encoding: 'euc-kr' },
  'sec_kiwoom_kr':     { kind: 'stocks_kr', label: '키움증권 · 국내주식',   institution: '키움증권',     encoding: 'euc-kr' },
  'sec_miraeasset_kr': { kind: 'stocks_kr', label: '미래에셋 · 국내주식',   institution: '미래에셋증권', encoding: 'euc-kr' },
  'sec_kbsec_kr':      { kind: 'stocks_kr', label: 'KB증권 · 국내주식',    institution: 'KB증권',       encoding: 'euc-kr' },
  'sec_nh_kr':         { kind: 'stocks_kr', label: 'NH투자 · 국내주식',    institution: 'NH투자증권',   encoding: 'euc-kr' },
  'sec_shinhan_kr':    { kind: 'stocks_kr', label: '신한투자 · 국내주식',  institution: '신한투자증권', encoding: 'euc-kr' },
  'sec_koreainv_kr':   { kind: 'stocks_kr', label: '한국투자 · 국내주식',  institution: '한국투자증권', encoding: 'euc-kr' },
  'sec_toss_kr':       { kind: 'stocks_kr', label: '토스증권 · 국내주식',  institution: '토스증권',     encoding: 'utf-8'  },
  // 해외 주식
  'sec_samsung_us':    { kind: 'stocks_us', label: '삼성증권 · 해외주식',   institution: '삼성증권',     encoding: 'euc-kr' },
  'sec_kiwoom_us':     { kind: 'stocks_us', label: '키움증권 · 해외주식',   institution: '키움증권',     encoding: 'euc-kr' },
  'sec_miraeasset_us': { kind: 'stocks_us', label: '미래에셋 · 해외주식',   institution: '미래에셋증권', encoding: 'euc-kr' },
  'sec_kbsec_us':      { kind: 'stocks_us', label: 'KB증권 · 해외주식',    institution: 'KB증권',       encoding: 'euc-kr' },
  'sec_nh_us':         { kind: 'stocks_us', label: 'NH투자 · 해외주식',    institution: 'NH투자증권',   encoding: 'euc-kr' },
  'sec_shinhan_us':    { kind: 'stocks_us', label: '신한투자 · 해외주식',  institution: '신한투자증권', encoding: 'euc-kr' },
  'sec_koreainv_us':   { kind: 'stocks_us', label: '한국투자 · 해외주식',  institution: '한국투자증권', encoding: 'euc-kr' },
  'sec_toss_us':       { kind: 'stocks_us', label: '토스증권 · 해외주식',  institution: '토스증권',     encoding: 'utf-8'  },
  // 암호화폐 (거래소 보유현황)
  'ex_upbit':    { kind: 'crypto', label: '업비트',       institution: '업비트',     currency: 'KRW', encoding: 'utf-8' },
  'ex_bithumb':  { kind: 'crypto', label: '빗썸',         institution: '빗썸',       currency: 'KRW', encoding: 'utf-8' },
  'ex_coinone':  { kind: 'crypto', label: '코인원',       institution: '코인원',     currency: 'KRW', encoding: 'utf-8' },
  'ex_korbit':   { kind: 'crypto', label: '코빗',         institution: '코빗',       currency: 'KRW', encoding: 'utf-8' },
  'ex_binance':  { kind: 'crypto', label: '바이낸스',     institution: '바이낸스',   currency: 'USD', encoding: 'utf-8' },
  'ex_coinbase': { kind: 'crypto', label: '코인베이스',   institution: '코인베이스', currency: 'USD', encoding: 'utf-8' },
  // 은행 잔액
  'bank_shinhan_bal':   { kind: 'bank', label: '신한은행 · 잔액목록',     institution: '신한은행',     encoding: 'euc-kr' },
  'bank_kakaobank_bal': { kind: 'bank', label: '카카오뱅크 · 잔액목록',   institution: '카카오뱅크',   encoding: 'utf-8'  },
  'bank_toss_bal':      { kind: 'bank', label: '토스뱅크 · 잔액목록',     institution: '토스뱅크',     encoding: 'utf-8'  },
  'bank_kb_bal':        { kind: 'bank', label: 'KB국민은행 · 잔액목록',   institution: 'KB국민은행',   encoding: 'euc-kr' },
  'bank_nh_bal':        { kind: 'bank', label: 'NH농협 · 잔액목록',       institution: 'NH농협은행',   encoding: 'euc-kr' },
  'bank_woori_bal':     { kind: 'bank', label: '우리은행 · 잔액목록',     institution: '우리은행',     encoding: 'euc-kr' },
  'bank_sc_bal':        { kind: 'bank', label: 'SC제일은행 · 잔액목록',   institution: 'SC제일은행',   encoding: 'euc-kr' },
  'bank_welcome_bal':   { kind: 'bank', label: '웰컴저축은행 · 잔액목록', institution: '웰컴저축은행', encoding: 'euc-kr' },
};

const ASSET_HEADER_HINTS = {
  // 공통
  stocks: {
    ticker:   ['종목코드','티커','symbol','code','종목번호','종목id'],
    name:     ['종목명','종목','이름','name','상품명'],
    quantity: ['수량','보유수량','잔고수량','잔고','체결수량','보유주수','shares','quantity'],
    avgCost:  ['평균단가','매입단가','평단','평균매입단가','매입평단','매입평균','매입가','avg','average'],
    currentPrice: ['현재가','시장가','종가','price','현재가격'],
    value:    ['평가금액','평가가치','평가','valuation','market value'],
  },
  crypto: {
    ticker:   ['코인','심볼','symbol','종목','자산','asset','currency','통화','코인명','자산명','화폐','화폐종류','종목명','상품','상품명'],
    quantity: ['수량','보유수량','잔고','balance','available','quantity','보유'],
    avgCost:  ['매수평균가','평균단가','매수가','평단','매수평균','avg','average'],
    value:    ['평가금액','평가','valuation','value','환산금액'],
  },
  bank: {
    label:    ['상품명','계좌명','상품','별칭','alias','name','계좌별칭','통장명'],
    account:  ['계좌번호','account','accountno','번호','계좌'],
    balance:  ['잔액','현재잔액','balance','원금','예수금','현재금액','잔금','원화잔액'],
    rate:     ['금리','이자율','이율','rate','연이율','이자'],
    maturity: ['만기','만기일','만기일자','maturity'],
    product:  ['상품종류','종류','type','구분','유형','카테고리','계좌종류'],
  },
};

function scoreAssetHeader(h, kind, field) {
  const n = normHeader(h);
  const list = ASSET_HEADER_HINTS[kind]?.[field];
  if (!list) return 0;
  let best = 0;
  for (const k of list) {
    const kk = k.toLowerCase();
    if (n === kk) best = Math.max(best, 3);
    else if (n.includes(kk)) best = Math.max(best, 2);
  }
  return best;
}

function autoMapAssetColumns(headers, kind) {
  // stocks_kr/stocks_us 는 'stocks' 힌트집합 공유
  const hintKind = kind === 'stocks_kr' || kind === 'stocks_us' ? 'stocks' : kind;
  const fields = Object.keys(ASSET_HEADER_HINTS[hintKind] || {});
  const m = {};
  for (const f of fields) {
    let bestIdx = -1, bestScore = 0;
    for (let i = 0; i < headers.length; i++) {
      const s = scoreAssetHeader(headers[i], hintKind, f);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    m[f] = bestIdx;
  }
  return m;
}

function normHeader(s) {
  return String(s || '').replace(/\s+/g,'').replace(/["'()\[\]]/g,'').toLowerCase();
}

function scoreHeader(h, kind) {
  const n = normHeader(h);
  let best = 0;
  for (const k of HEADER_HINTS[kind]) {
    if (n === k.toLowerCase()) best = Math.max(best, 3);
    else if (n.includes(k.toLowerCase())) best = Math.max(best, 2);
  }
  return best;
}

function autoMapColumns(headers) {
  const m = { date: -1, desc: -1, amount: -1, out: -1, in: -1 };
  for (const kind of Object.keys(m)) {
    let bestIdx = -1, bestScore = 0;
    for (let i = 0; i < headers.length; i++) {
      const s = scoreHeader(headers[i], kind);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    m[kind] = bestIdx;
  }
  return m;
}

// CSV 파서 (따옴표·이스케이프 처리)
function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => String(x || '').trim().length));
}

// 파일을 인코딩 판별해 텍스트로 읽기 (UTF-8 BOM / EUC-KR 폴백)
async function readCsvFile(file, hintEncoding) {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // UTF-8 BOM
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    return new TextDecoder('utf-8').decode(bytes.slice(3));
  }
  // 힌트가 euc-kr 이면 먼저 시도
  const tryOrder = hintEncoding === 'euc-kr' ? ['euc-kr', 'utf-8'] : ['utf-8', 'euc-kr'];
  for (const enc of tryOrder) {
    try {
      const dec = new TextDecoder(enc, { fatal: false });
      const txt = dec.decode(bytes);
      // 한글이 깨졌는지 간단 휴리스틱: 물음표/꺾은괄호·꺾쇠 비율
      const bad = (txt.match(/[\uFFFD]/g) || []).length;
      if (bad < txt.length * 0.02) return txt;
    } catch {}
  }
  // 최후수단
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

// "2026.04.17" / "2026-04-17" / "2026/04/17" / "20260417" → "YYYY-MM-DD"
function parseDateString(s) {
  const str = String(s || '').trim();
  if (!str) return null;
  // 날짜+시간일 수 있음 — 앞 10~11자만 추출
  const m = str.match(/(\d{4})[.\-\/년\s]*(\d{1,2})[.\-\/월\s]*(\d{1,2})/);
  if (m) {
    const y = m[1], mo = m[2].padStart(2,'0'), d = m[3].padStart(2,'0');
    return `${y}-${mo}-${d}`;
  }
  const c = str.match(/^(\d{8})$/);
  if (c) return `${c[1].slice(0,4)}-${c[1].slice(4,6)}-${c[1].slice(6,8)}`;
  return null;
}

function parseAmountString(s) {
  if (s == null) return NaN;
  const str = String(s).replace(/[,₩\s]/g, '').trim();
  if (!str) return NaN;
  const n = Number(str);
  return isFinite(n) ? n : NaN;
}

// XLSX/XLS 지원 — 필요 시 SheetJS CDN 레이지 로드.
let _xlsxPromise = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (_xlsxPromise) return _xlsxPromise;
  _xlsxPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { _xlsxPromise = null; reject(new Error('XLSX 라이브러리 로드 실패 (인터넷 확인)')); };
    document.head.appendChild(s);
  });
  return _xlsxPromise;
}

// PDF 지원 — pdf.js CDN 레이지 로드 (text-PDF 만 동작, 스캔 이미지는 미지원).
let _pdfjsPromise = null;
function loadPdfjs() {
  if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if (_pdfjsPromise) return _pdfjsPromise;
  _pdfjsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
    s.onload = () => {
      try {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
        resolve(window.pdfjsLib);
      } catch (e) { reject(e); }
    };
    s.onerror = () => { _pdfjsPromise = null; reject(new Error('PDF 라이브러리 로드 실패 (인터넷 확인)')); };
    document.head.appendChild(s);
  });
  return _pdfjsPromise;
}

// PDF → 2D 배열. 텍스트 항목의 y 좌표로 행을, x 좌표 간격으로 셀을 재구성.
// password 인자는 암호화된 PDF 용 (pdf.js 가 내장 지원).
async function readPdfFile(file, password) {
  const pdfjsLib = await loadPdfjs();
  const buf = await file.arrayBuffer();
  const docTask = pdfjsLib.getDocument({ data: buf, password: password || undefined });
  let pdf;
  try {
    pdf = await docTask.promise;
  } catch (e) {
    // pdf.js 는 비밀번호 누락/오류 시 PasswordException 발생.
    const msg = String(e && (e.message || e.name) || e);
    if (/password/i.test(msg) || e?.name === 'PasswordException') {
      const err = new Error(password ? '비밀번호가 올바르지 않습니다.' : '비밀번호가 필요한 PDF 입니다.');
      err.needsPassword = true;
      throw err;
    }
    throw e;
  }
  const allRows = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const byY = new Map();
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y).push({ x: it.transform[4], s: it.str, w: it.width || 0 });
    }
    const ys = Array.from(byY.keys()).sort((a, b) => b - a); // 위→아래
    for (const y of ys) {
      const items = byY.get(y).sort((a, b) => a.x - b.x);
      const cells = [];
      let cur = '', lastEnd = -Infinity;
      for (const it of items) {
        const gap = it.x - lastEnd;
        if (cur && gap > 12) {
          cells.push(cur.trim());
          cur = it.s;
        } else {
          cur = cur ? cur + ' ' + it.s : it.s;
        }
        lastEnd = it.x + it.w;
      }
      if (cur) cells.push(cur.trim());
      if (cells.some(c => c.length)) allRows.push(cells);
    }
  }
  return allRows;
}

// CSV/XLS/XLSX/PDF 파일을 2D 배열로 읽음. password 는 암호화된 파일용 (선택).
async function readSheetFile(file, hintEncoding, password) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.pdf')) {
    return await readPdfFile(file, password);
  }
  if (name.endsWith('.zip')) {
    // 현재 번들에는 ZIP 암호 해제 라이브러리가 없음 — 사용자에게 명확히 안내.
    const err = new Error('암호 걸린 ZIP 은 현재 지원하지 않습니다. 압축을 풀어 CSV/엑셀 파일을 직접 올려주세요.');
    err.needsPassword = false;
    throw err;
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const XLSX = await loadXlsx();
    const buf = await file.arrayBuffer();
    try {
      const wb = XLSX.read(new Uint8Array(buf), { type: 'array', password: password || undefined });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      if (!sheet) throw new Error('빈 워크북');
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
      return rows.filter(r => r.some(x => String(x || '').trim().length));
    } catch (e) {
      const msg = String(e && (e.message || e.name) || e).toLowerCase();
      // SheetJS 는 encryption 감지 시 다양한 메시지를 던짐.
      if (/password|encrypt|protected|crypto/i.test(msg)) {
        const err = new Error(
          password
            ? '엑셀 비밀번호가 올바르지 않거나, 이 암호 방식(AES-256 등)은 내장 디코더에서 지원하지 않습니다. 엑셀에서 "파일 → 정보 → 통합 문서 보호 → 암호 제거" 후 다시 올려주세요.'
            : '비밀번호가 설정된 엑셀 파일입니다. 아래 비밀번호 칸에 입력 후 다시 시도하세요.'
        );
        err.needsPassword = true;
        throw err;
      }
      throw e;
    }
  }
  const text = await readCsvFile(file, hintEncoding);
  return parseCSV(text);
}

// 암호화폐 거래소 — 국내(KRW 호가) vs 해외(USD 호가)
const CRYPTO_EXCHANGES = [
  { name: '업비트',     currency: 'KRW' },
  { name: '빗썸',       currency: 'KRW' },
  { name: '코인원',     currency: 'KRW' },
  { name: '코빗',       currency: 'KRW' },
  { name: '바이낸스',   currency: 'USD' },
  { name: '코인베이스', currency: 'USD' },
  { name: '크라켄',     currency: 'USD' },
  { name: 'OKX',        currency: 'USD' },
  { name: '바이비트',   currency: 'USD' },
  { name: '기타 지갑',  currency: 'USD' },
];

function cryptoCurrency(a) {
  if (a.currency === 'USD' || a.currency === 'KRW') return a.currency;
  if (typeof a.ticker === 'string' && a.ticker.startsWith('KRW-')) return 'KRW';
  if (typeof a.ticker === 'string' && a.ticker.endsWith('-USD')) return 'USD';
  const ex = CRYPTO_EXCHANGES.find(e => e.name === a.institution);
  return ex?.currency || 'KRW';
}

function cryptoQuoteKey(a) {
  const t = String(a.ticker || '').trim().toUpperCase();
  if (!t) return null;
  if (t.startsWith('KRW-')) return t;
  if (t.endsWith('-USD')) return t;
  return cryptoCurrency(a) === 'USD' ? `${t}-USD` : `KRW-${t}`;
}

// 자산 유형별 팔레트 (도넛/스택 그래프 공통).
// 사용자 요청 팔레트: 현금=파랑, 예적금·저축=녹색, 국내주식=노랑, 해외주식=빨강, 암호화폐=보라, 부동산=회색.
const TYPE_COLOR = {
  cash:       '#3182F6',
  savings:    '#0AC17B',
  deposit:    '#0AC17B',
  stock_kr:   '#F7BE2E',
  stock_us:   '#F04452',
  crypto:     '#7E5BEF',
  brokerage:  '#1B64DA',
  realestate: '#8B95A1',
  custom:     '#B0B8C1',
};

// ---------- 로드 ----------
async function loadAll() {
  const [acc, tx, snaps, evs] = await Promise.all([
    apiGet(API.accounts).catch(() => ({ accounts: [] })),
    apiGet(API.tx).catch(() => ({ transactions: [] })),
    apiGet(API.snapshots).catch(() => ({ snapshots: [] })),
    apiGet(API.events).catch(() => ({ events: [] })),
  ]);
  state.accounts = acc.accounts || [];
  state.transactions = tx.transactions || [];
  state.snapshots = snaps.snapshots || [];
  state.events = evs.events || [];
  const sorted = state.snapshots.slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const yday = sorted.length >= 2 ? sorted[sorted.length - 2] : null;
  state.lastSnapshotTotal = yday?.totalKRW ?? null;
}

// 상단 지수 스트립에 표시할 고정 목록. 한국어 짧은 이름과 단위.
const MARKET_INDICES = [
  { key: 'KOSPI',    label: '코스피',   unit: 'pt' },
  { key: 'KOSDAQ',   label: '코스닥',   unit: 'pt' },
  { key: 'NASDAQ',   label: '나스닥',   unit: 'pt' },
  { key: 'SP500',    label: 'S&P500',   unit: 'pt' },
  { key: 'NIKKEI',   label: '니케이',   unit: 'pt' },
  { key: 'USDKRW',   label: '원/달러',  unit: 'krw' },
  { key: 'GOLD',     label: '금',       unit: 'usd' },
  { key: 'WTI',      label: 'WTI',      unit: 'usd' },
];

// ---------- 시세 ----------
// 15초 폴링 중 계좌 편집/삭제가 동시에 일어나면 오래된 응답이 최신 state 를 덮어쓸
// 수 있다. 매 호출마다 시퀀스 번호를 증가시키고 응답 적용 전에 최신인지 확인.
let _quoteSeq = 0;
async function refreshQuotes() {
  const mySeq = ++_quoteSeq;
  const tickers = [];
  const seen = new Set();
  const push = (assetType, ticker, currency, institution) => {
    if (!ticker) return;
    if (!['stock_kr','stock_us','crypto'].includes(assetType)) return;
    const tk = assetType === 'crypto'
      ? cryptoQuoteKey({ ticker, currency, institution })
      : ticker;
    if (!tk) return;
    const key = assetType + ':' + tk;
    if (seen.has(key)) return;
    seen.add(key);
    tickers.push({ type: assetType, ticker: tk });
    // 크립토는 KRW↔USD 양방향 시세를 함께 요청.
    //   - KRW-X 요청 → X-USD 도 같이 (업비트 미상장 코인 fallback)
    //   - X-USD 요청 → KRW-X 도 같이 (Yahoo 가 동명이코인을 잘못 잡는 경우 업비트가 더 정확)
    if (assetType === 'crypto') {
      if (tk.startsWith('KRW-')) {
        const bare = tk.slice(4);
        const usdKey = `crypto:${bare}-USD`;
        if (bare && !seen.has(usdKey)) {
          seen.add(usdKey);
          tickers.push({ type: 'crypto', ticker: `${bare}-USD` });
        }
      } else if (tk.endsWith('-USD')) {
        const bare = tk.slice(0, -4);
        const krwKey = `crypto:KRW-${bare}`;
        if (bare && !seen.has(krwKey)) {
          seen.add(krwKey);
          tickers.push({ type: 'crypto', ticker: `KRW-${bare}` });
        }
      }
    }
  };
  for (const a of state.accounts) {
    if (['stock_kr','stock_us','crypto'].includes(a.type)) {
      push(a.type, a.ticker, a.currency, a.institution);
    } else if (a.type === 'brokerage' && Array.isArray(a.holdings)) {
      for (const h of a.holdings) push(h.assetType, h.ticker, h.currency, a.institution);
    }
  }
  // 시장 지수 + 비트코인 은 자산 유무와 상관없이 항상 조회.
  for (const idx of MARKET_INDICES) tickers.push({ type: 'index', ticker: idx.key });
  tickers.push({ type: 'crypto', ticker: 'BTC-USD' });
  if (!tickers.length) {
    state.quotes = {};
    state.exchangeRate = null;
    renderTickerStrip();
    return;
  }
  try {
    const r = await apiPost(API.quotes, { tickers });
    // 내가 요청한 뒤 더 최신 refreshQuotes 가 시작됐다면 stale 응답 무시.
    if (mySeq !== _quoteSeq) return;
    state.quotes = r.quotes || {};
    state.exchangeRate = r.exchangeRate || null;
    renderTickerStrip(r.cacheUpdatedAt);
    renderAssets();
    renderTotals();
    renderDashboard();
  } catch (e) {
    console.warn('quotes fail', e);
  }
}

function renderTickerStrip(updatedAt) {
  $('#ts-date').textContent = nowKSTDisplay();
  const q = state.quotes;
  const parts = [];
  // 사용자가 입력한 티커 위주로 실시간 가격 표시
  const seenKeys = new Set();
  const ownTickers = [];
  const addTicker = (type, ticker, label, currency, institution) => {
    if (!ticker || !['stock_kr','stock_us','crypto'].includes(type)) return;
    const key = type === 'crypto' ? cryptoQuoteKey({ ticker, currency, institution }) : ticker;
    if (!key || seenKeys.has(type + ':' + key)) return;
    seenKeys.add(type + ':' + key);
    ownTickers.push({ key, type, label, ticker });
  };
  for (const a of state.accounts) {
    if (ownTickers.length >= 8) break;
    if (['stock_kr','stock_us','crypto'].includes(a.type)) {
      addTicker(a.type, a.ticker, a.label, a.currency, a.institution);
    } else if (a.type === 'brokerage' && Array.isArray(a.holdings)) {
      for (const h of a.holdings) {
        if (ownTickers.length >= 8) break;
        addTicker(h.assetType, h.ticker, h.label || h.ticker, h.currency, a.institution);
      }
    }
  }
  for (const t of ownTickers) {
    const entry = q[t.key];
    if (!entry) continue;
    const short = t.type === 'crypto'
      ? String(t.ticker).toUpperCase().replace(/^KRW-/, '').replace(/-USD$/, '')
      : (t.label && t.label.length <= 6 ? t.label : t.ticker);
    if (t.type === 'stock_us' && entry.price != null) {
      parts.push(`${esc(short)} $${entry.price.toFixed(2)}`);
    } else if (t.type === 'crypto' && t.key.endsWith('-USD') && entry.price != null) {
      parts.push(`${esc(short)} $${entry.price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
    } else if (entry.priceKRW != null) {
      parts.push(`${esc(short)} ₩${Math.round(entry.priceKRW).toLocaleString('ko-KR')}`);
    }
  }

  // 시장 지수: 가격 + 전일비 %. 상승=cinnabar, 하락=steel 로 표시.
  const idxParts = [];
  for (const idx of MARKET_INDICES) {
    const entry = q[idx.key];
    if (!entry) continue;
    const price = entry.price != null ? entry.price : entry.rate;
    if (price == null) continue;
    let priceStr;
    if (idx.unit === 'krw') priceStr = '₩' + Math.round(price).toLocaleString('ko-KR');
    else if (idx.unit === 'usd') priceStr = '$' + price.toLocaleString('en-US', { maximumFractionDigits: 2 });
    else priceStr = price.toLocaleString('en-US', { maximumFractionDigits: 2 });
    const pct = entry.changePct;
    const pctHTML = pct != null
      ? ` <span class="ts-pct ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>`
      : '';
    idxParts.push(`<span class="ts-idx"><b>${esc(idx.label)}</b> ${priceStr}${pctHTML}</span>`);
  }
  // 비트코인도 지수 줄에 함께.
  const btc = q['BTC-USD'];
  if (btc?.price != null) {
    const pctHTML = btc.previousClose
      ? (() => {
          const pct = ((btc.price - btc.previousClose) / btc.previousClose) * 100;
          return ` <span class="ts-pct ${pct >= 0 ? 'up' : 'down'}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>`;
        })()
      : '';
    idxParts.push(`<span class="ts-idx"><b>비트코인</b> $${Math.round(btc.price).toLocaleString('en-US')}${pctHTML}</span>`);
  }

  const tsQuote = document.getElementById('ts-quote');
  const tsIndex = document.getElementById('ts-index');
  tsQuote.textContent = parts.length ? parts.join('  ·  ') : '수동 자산만 등록됨';
  if (tsIndex) tsIndex.innerHTML = idxParts.length ? idxParts.join('  ·  ') : '';
  if (updatedAt) $('#foot-sync').textContent = 'sync ' + updatedAt.replace('T', ' ').slice(0, 19);
}

// 한 종목(holding 또는 계좌) 시세 → 평가 계산 결과
// spec: { assetType, ticker, quantity, avgCost?, currency? }
function evalHoldingSpec(spec) {
  const out = { valueKRW: 0, priceKRW: null, priceUSD: null, cost: null, pl: null, plPct: null };
  const qty = Number(spec.quantity || 0);
  if (spec.assetType === 'stock_kr') {
    const q = state.quotes[spec.ticker];
    if (q?.priceKRW != null) {
      out.priceKRW = q.priceKRW;
      out.valueKRW = qty * q.priceKRW;
      if (spec.avgCost) {
        out.cost = qty * Number(spec.avgCost);
        out.pl = out.valueKRW - out.cost;
        out.plPct = out.cost > 0 ? (out.pl / out.cost) * 100 : null;
      }
    }
  } else if (spec.assetType === 'stock_us') {
    const q = state.quotes[spec.ticker];
    const fx = state.exchangeRate?.rate;
    if (q?.price != null && fx) {
      out.priceUSD = q.price;
      out.priceKRW = q.price * fx;
      out.valueKRW = qty * q.price * fx;
      if (spec.avgCost) {
        out.cost = qty * Number(spec.avgCost) * fx;
        out.pl = out.valueKRW - out.cost;
        out.plPct = out.cost > 0 ? (out.pl / out.cost) * 100 : null;
      }
    }
  } else if (spec.assetType === 'crypto') {
    const virt = { ticker: spec.ticker, currency: spec.currency, institution: spec.institution };
    const key = cryptoQuoteKey(virt);
    const q = key ? state.quotes[key] : null;
    const currency = cryptoCurrency(virt);
    const fx = state.exchangeRate?.rate;
    if (currency === 'USD') {
      // 1순위: 업비트 KRW 시세가 있으면 그것을 기준으로 사용 (Yahoo 티커 혼선 방지 — MNT/SUI/APT 등).
      const bare = String(spec.ticker || '').toUpperCase().replace(/^KRW-/, '').replace(/-USD$/, '');
      const krwQ = bare ? state.quotes[`KRW-${bare}`] : null;
      if (krwQ?.priceKRW != null && fx) {
        out.priceKRW = krwQ.priceKRW;
        out.priceUSD = krwQ.priceKRW / fx;
        out.valueKRW = qty * krwQ.priceKRW;
        if (spec.avgCost) {
          // USD 거래소이므로 avgCost 는 USD 단위 → 환율로 원화 환산.
          out.cost = qty * Number(spec.avgCost) * fx;
          out.pl = out.valueKRW - out.cost;
          out.plPct = out.cost > 0 ? (out.pl / out.cost) * 100 : null;
        }
      } else if (q?.price != null && fx) {
        // 2순위: Yahoo X-USD.
        out.priceUSD = q.price;
        out.priceKRW = q.price * fx;
        out.valueKRW = qty * q.price * fx;
        if (spec.avgCost) {
          out.cost = qty * Number(spec.avgCost) * fx;
          out.pl = out.valueKRW - out.cost;
          out.plPct = out.cost > 0 ? (out.pl / out.cost) * 100 : null;
        }
      }
    } else if (q?.priceKRW != null) {
      out.priceKRW = q.priceKRW;
      out.valueKRW = qty * q.priceKRW;
      if (spec.avgCost) {
        out.cost = qty * Number(spec.avgCost);
        out.pl = out.valueKRW - out.cost;
        out.plPct = out.cost > 0 ? (out.pl / out.cost) * 100 : null;
      }
    } else {
      // KRW 기준인데 업비트에 없는 마켓(USDT/USDC/MNT/AGI 등) → USD 시세로 fallback.
      const bare = String(spec.ticker || '').toUpperCase().replace(/^KRW-/, '').replace(/-USD$/, '');
      const usdQ = bare ? state.quotes[`${bare}-USD`] : null;
      if (usdQ?.price != null && fx) {
        out.priceUSD = usdQ.price;
        out.priceKRW = usdQ.price * fx;
        out.valueKRW = qty * usdQ.price * fx;
        if (spec.avgCost) {
          // KRW 거래소면 avgCost 도 KRW 로 입력됐다고 가정.
          out.cost = qty * Number(spec.avgCost);
          out.pl = out.valueKRW - out.cost;
          out.plPct = out.cost > 0 ? (out.pl / out.cost) * 100 : null;
        }
      }
    }
  } else if (spec.assetType === 'fund' || spec.assetType === 'bond' || spec.assetType === 'custom') {
    // 비상장/수동가 종목 — manualPriceKRW 가 있으면 그것을 현재가로 사용.
    const manual = Number(spec.manualPriceKRW || 0);
    if (manual > 0) {
      out.priceKRW = manual;
      out.valueKRW = qty * manual;
      if (spec.avgCost) {
        out.cost = qty * Number(spec.avgCost);
        out.pl = out.valueKRW - out.cost;
        out.plPct = out.cost > 0 ? (out.pl / out.cost) * 100 : null;
      }
    } else if (spec.avgCost) {
      // 수동가 미입력 — avgCost 를 현재가로 간주 (손익 0).
      out.priceKRW = Number(spec.avgCost);
      out.valueKRW = qty * Number(spec.avgCost);
      out.cost = out.valueKRW;
    }
  }
  return out;
}

// ---------- 계좌 평가금액 계산 ----------
function evalAccount(a) {
  // KRW 단일 값 반환 (+ 보조 필드 { priceKRW, priceUSD, valueKRW, cost, pl })
  const out = { valueKRW: 0, priceKRW: null, priceUSD: null, cost: null, pl: null, plPct: null, stale: false };
  switch (a.type) {
    case 'cash':
    case 'savings':
    case 'deposit':
      out.valueKRW = Number(a.amountKRW || 0);
      break;
    case 'realestate':
      out.valueKRW = Number(a.amountKRW || 0);
      // 6개월 이상 묵은 부동산은 stale
      if (a.manualUpdatedAt) {
        const mu = new Date(a.manualUpdatedAt + 'T00:00:00+09:00');
        const days = (Date.now() - mu.getTime()) / 86400000;
        out.stale = days > 180;
      }
      break;
    case 'stock_kr':
    case 'stock_us':
    case 'crypto': {
      const r = evalHoldingSpec({
        assetType: a.type, ticker: a.ticker,
        quantity: a.quantity, avgCost: a.avgCost,
        currency: a.currency, institution: a.institution,
      });
      Object.assign(out, r);
      break;
    }
    case 'brokerage': {
      const cash = Number(a.cashKRW || 0);
      let val = cash, cost = 0, hasCost = false;
      const holdings = Array.isArray(a.holdings) ? a.holdings : [];
      for (const h of holdings) {
        const r = evalHoldingSpec({
          assetType: h.assetType, ticker: h.ticker,
          quantity: h.quantity, avgCost: h.avgCost,
          manualPriceKRW: h.manualPriceKRW,
          currency: h.currency, institution: a.institution,
        });
        val += r.valueKRW || 0;
        if (r.cost != null) { cost += r.cost; hasCost = true; }
      }
      out.valueKRW = val;
      if (hasCost) {
        out.cost = cost;
        out.pl = (val - cash) - cost;
        out.plPct = cost > 0 ? (out.pl / cost) * 100 : null;
      }
      break;
    }
    case 'custom': {
      // 연금·펀드 등 — 평가금액(amountKRW) + 선택적으로 원금(principalKRW).
      // 원금이 있으면 손익·수익률을 계산한다.
      out.valueKRW = Number(a.amountKRW || 0);
      const principal = Number(a.principalKRW || 0);
      if (principal > 0) {
        out.cost = principal;
        out.pl = out.valueKRW - principal;
        out.plPct = (out.pl / principal) * 100;
      }
      break;
    }
  }
  return out;
}

// ---------- 자산 렌더 ----------
function sortAccountsForCard(type, list) {
  // 예/적금: 만기일 오름차순 (가까운 순). 만기 없으면 뒤로.
  if (type === 'deposit') {
    return list.slice().sort((a, b) => {
      const ma = a.maturityDate || '9999-99-99';
      const mb = b.maturityDate || '9999-99-99';
      return ma < mb ? -1 : ma > mb ? 1 : 0;
    });
  }
  // 은행 (수시입출/파킹/대출 등): 금액 내림차순
  if (type === 'savings') {
    return list.slice().sort((a, b) => (b.amountKRW || 0) - (a.amountKRW || 0));
  }
  // 주식/코인: 평가금액 내림차순
  if (['stock_kr','stock_us','crypto'].includes(type)) {
    return list.slice().sort((a, b) => evalAccount(b).valueKRW - evalAccount(a).valueKRW);
  }
  return list;
}

function renderAssets() {
  const grid = $('#eq-grid');
  const byType = {};
  for (const t of TYPE_ORDER) byType[t] = [];
  for (const a of state.accounts) (byType[a.type] || (byType[a.type] = [])).push(a);

  state.totalsByType = {};
  state.totalKRW = 0;

  const blocks = [];
  for (const type of TYPE_ORDER) {
    // custom(연금·펀드)은 brokerage(증권 계좌) 카드에 합쳐서 렌더.
    if (type === 'custom') continue;
    let rawList = (byType[type] || []).slice();
    if (type === 'brokerage' && (byType.custom || []).length) {
      rawList = rawList.concat(byType.custom);
    }
    if (!rawList.length) continue;
    const list = sortAccountsForCard(type, rawList);
    let sum = 0, sumPl = 0, sumCost = 0, hasPl = false;
    const lines = list.map(a => {
      const ev = evalAccount(a);
      sum += ev.valueKRW;
      if (ev.pl != null) { sumPl += ev.pl; hasPl = true; }
      if (ev.cost != null) sumCost += ev.cost;
      return { a, ev };
    });
    state.totalsByType[type] = sum;
    state.totalKRW += sum;

    // 단일 계좌 → HTML 라인 (암호화폐 그룹의 child 는 indent 플래그로 들여쓰기).
    const renderAccLine = ({ a, ev }, indent = false) => {
      const subs = [];
      if (a.institution) subs.push(esc(a.institution));
      if (a.accountKind && a.accountKind !== '일반') subs.push(esc(a.accountKind));
      if (a.product && a.type !== 'deposit') subs.push(esc(a.product));
      if (a.type === 'brokerage') {
        const n = Array.isArray(a.holdings) ? a.holdings.length : 0;
        subs.push(`${n}개 종목`);
        if (a.cashKRW) subs.push(`예수금 ₩${Math.round(a.cashKRW).toLocaleString('ko-KR')}`);
      }
      if (a.type === 'custom' && a.principalKRW) {
        subs.push(`원금 ₩${Math.round(a.principalKRW).toLocaleString('ko-KR')}`);
      }
      // 암호화폐 그룹 child 는 "기관명 (수량)" 만 간단히 표시하고 티커는 헤더에서.
      if (!indent && a.ticker) subs.push(`${esc(a.ticker)}${a.quantity ? ' · ' + fmtQty(a.quantity) : ''}`);
      if (indent && a.quantity) subs.push(`${fmtQty(a.quantity)}개`);
      if (a.type === 'deposit' && a.maturityDate) {
        const days = Math.ceil((new Date(a.maturityDate + 'T00:00:00+09:00').getTime() - Date.now()) / 86400000);
        const tag = days < 0 ? '만기경과' : days <= 30 ? `D-${days}` : `만기 ${a.maturityDate}`;
        subs.push(`${tag}${a.interestRate ? ' · ' + a.interestRate + '%' : ''}`);
        if (a.monthlyDeposit) subs.push(`월 ₩${Math.round(a.monthlyDeposit).toLocaleString('ko-KR')}`);
      }
      if (ev.priceKRW && !a.maturityDate) {
        subs.push(`@ ₩${Math.round(ev.priceKRW).toLocaleString('ko-KR')}`);
      }
      const subHTML = subs.length ? `<span class="sub">${subs.join(' · ')}</span>` : '';

      const plStr = ev.pl != null
        ? `<span class="pl ${ev.pl >= 0 ? 'up' : 'down'}">${ev.pl >= 0 ? '+' : ''}${Math.round(ev.pl).toLocaleString('ko-KR')}${ev.plPct != null ? ' · ' + fmtPct(ev.plPct, 1) : ''}</span>`
        : `<span class="pl"></span>`;
      // 적금 계산 가능(시작일+만기일+월적립금)한 경우 "예상 ₩…" 배지 추가.
      let estBadge = '';
      if (a.type === 'deposit' && a.startDate && a.maturityDate && a.monthlyDeposit) {
        const est = calcDepositMaturity(a);
        if (est) {
          estBadge = `<button type="button" class="est-badge" data-estimate="${a.id}" title="만기 수령액 세부내역">예상 ${fmtKRWShort(est.maturity)}</button>`;
        }
      }
      const labelText = indent ? esc(a.institution || a.label) : esc(a.label);
      return `
        <div class="acc-line${ev.stale ? ' stale' : ''}${indent ? ' acc-child' : ''}" data-id="${a.id}">
          <div class="lbl" title="${esc(a.label)}">
            ${labelText}
            ${subHTML}
            ${estBadge}
          </div>
          <div class="val">${fmtKRW(ev.valueKRW)}</div>
          ${plStr}
          <button class="del" data-del="${a.id}" title="삭제">×</button>
        </div>`;
    };

    // 암호화폐: 같은 티커끼리 그룹핑 (수량·평가·원가·손익 합산). 1개 거래소뿐이면 단독 라인으로.
    let linesHTML;
    if (type === 'crypto') {
      const groupsMap = new Map();
      for (const item of lines) {
        const key = String(item.a.ticker || '?').toUpperCase();
        if (!groupsMap.has(key)) groupsMap.set(key, []);
        groupsMap.get(key).push(item);
      }
      const groups = [...groupsMap.entries()].map(([ticker, items]) => {
        const t = { qty: 0, valueKRW: 0, cost: 0, hasCost: false, priceKRW: null, priceUSD: null };
        for (const { a, ev } of items) {
          t.qty += Number(a.quantity || 0);
          t.valueKRW += ev.valueKRW || 0;
          if (ev.cost != null) { t.cost += ev.cost; t.hasCost = true; }
          if (ev.priceKRW) t.priceKRW = ev.priceKRW;
          if (ev.priceUSD) t.priceUSD = ev.priceUSD;
        }
        if (t.hasCost) {
          t.pl = t.valueKRW - t.cost;
          t.plPct = t.cost > 0 ? (t.pl / t.cost) * 100 : null;
        }
        return { ticker, items, total: t };
      }).sort((x, y) => y.total.valueKRW - x.total.valueKRW);

      const parts = [];
      for (const g of groups) {
        if (g.items.length === 1) {
          parts.push(renderAccLine(g.items[0], false));
          continue;
        }
        // 그룹 헤더 라인
        const t = g.total;
        const exchangeList = g.items.map(({ a }) => `${esc(a.institution || '?')} ${fmtQty(a.quantity)}`).join(' · ');
        const avgKRW = t.hasCost && t.qty > 0 ? t.cost / t.qty : null;
        const headSubs = [`${g.items.length}개 거래소`, `합계 ${fmtQty(t.qty)}개`];
        if (t.priceKRW) headSubs.push(`@ ₩${Math.round(t.priceKRW).toLocaleString('ko-KR')}`);
        if (avgKRW) headSubs.push(`평단 ₩${Math.round(avgKRW).toLocaleString('ko-KR')}`);
        const headSub = `<span class="sub">${headSubs.join(' · ')}<br>${exchangeList}</span>`;
        const headPl = t.pl != null
          ? `<span class="pl ${t.pl >= 0 ? 'up' : 'down'}">${t.pl >= 0 ? '+' : ''}${Math.round(t.pl).toLocaleString('ko-KR')}${t.plPct != null ? ' · ' + fmtPct(t.plPct, 1) : ''}</span>`
          : `<span class="pl"></span>`;
        parts.push(`
          <div class="acc-line acc-group" data-ticker="${esc(g.ticker)}">
            <div class="lbl"><b>${esc(g.ticker)}</b>${headSub}</div>
            <div class="val">${fmtKRW(t.valueKRW)}</div>
            ${headPl}
            <span class="del-placeholder"></span>
          </div>`);
        for (const item of g.items) parts.push(renderAccLine(item, true));
      }
      linesHTML = parts.join('');
    } else {
      linesHTML = lines.map(item => renderAccLine(item, false)).join('');
    }

    // 카드 헤더 합계 손익: 하나라도 pl 이 계산되면 표시.
    const sumPlPct = hasPl && sumCost > 0 ? (sumPl / sumCost) * 100 : null;
    const sumPlHTML = hasPl
      ? `<span class="eq-pl ${sumPl >= 0 ? 'up' : 'down'}">${sumPl >= 0 ? '+' : ''}${fmtKRWShort(sumPl)}${sumPlPct != null ? ' · ' + fmtPct(sumPlPct, 1) : ''}</span>`
      : '';

    // 긴 카드(특히 암호화폐)는 기본 접힘 + "전체 보기" 토글.
    const lineCount = (linesHTML.match(/class="acc-line/g) || []).length;
    const collapseThreshold = type === 'crypto' ? 8 : 20;
    const needsCollapse = lineCount > collapseThreshold;
    const collapsedClass = needsCollapse ? ' eq-lines--collapsed' : '';
    const expandBtn = needsCollapse
      ? `<button type="button" class="eq-expand-btn" data-toggle-expand>＋ 전체 보기 (${lineCount})</button>`
      : '';

    blocks.push(`
      <div class="eq-card" data-type="${type}">
        <h3>${TYPE_LABEL[type]}</h3>
        <div class="eq-sum">${fmtKRW(sum)}${sumPlHTML}<span class="eq-count">${list.length}건</span></div>
        <div class="eq-lines${collapsedClass}">${linesHTML}</div>
        ${expandBtn}
      </div>`);
  }
  grid.innerHTML = blocks.join('') || emptyAssets();
}

function emptyAssets() {
  return `<div class="eq-card" style="grid-column:1/-1; text-align:center; padding:60px;">
    <h3 style="color:var(--accent); text-transform:none; font-size:16px;">첫 계좌를 추가해보세요</h3>
    <p style="color:var(--ink-3); font-size:13px;">
      현금 · 은행 · 예적금 · 주식 · 코인 · 부동산 — 현금화 가능한 모든 자산.
    </p>
  </div>`;
}

// ---------- 적금 만기 예상 계산 (단리 적금 공식) ----------
// 정기적금 단리: 총이자 = 월적립금 × N(N+1)/2 × (연리/12) + 시작원금 × 연리 × (N/12)
// 여기서 N 은 납입 개월수. 세후이자 = 이자 × (1 - 세율).
function calcDepositMaturity(a) {
  const start = a.startDate;
  const mat = a.maturityDate;
  if (!start || !mat) return null;
  const s = new Date(start + 'T00:00:00+09:00').getTime();
  const m = new Date(mat + 'T00:00:00+09:00').getTime();
  if (!isFinite(s) || !isFinite(m) || m <= s) return null;
  const months = Math.max(1, Math.round((m - s) / (30.4375 * 86400000)));
  const monthly = Number(a.monthlyDeposit || 0);
  const seed = Number(a.amountKRW || 0);
  const rate = Number(a.interestRate || 0) / 100;
  const tax = Number(a.taxRate != null ? a.taxRate : 15.4) / 100;
  const principal = seed + monthly * months;
  const interestRecurring = monthly * (months * (months + 1) / 2) * (rate / 12);
  const interestSeed = seed * rate * (months / 12);
  const interest = interestRecurring + interestSeed;
  const afterTax = interest * (1 - tax);
  return { months, principal, interest, afterTax, taxAmt: interest - afterTax, maturity: principal + afterTax };
}

// 카드 라인/모달에서 호출 — 계산 결과를 한국어로 예쁘게 표시.
window._showDepositEstimate = (id) => {
  const a = state.accounts.find(x => x.id === id);
  if (!a) return;
  const r = calcDepositMaturity(a);
  if (!r) {
    alert('시작일과 만기일이 모두 입력되어 있어야 예상금액을 계산할 수 있습니다.');
    return;
  }
  const fmt = (n) => '₩ ' + Math.round(n).toLocaleString('ko-KR');
  const msg = [
    `${a.label}`,
    `납입 기간: ${r.months}개월`,
    `원금 합계: ${fmt(r.principal)}`,
    `세전 이자: ${fmt(r.interest)}`,
    `세금(${(a.taxRate != null ? a.taxRate : 15.4)}%): −${fmt(r.taxAmt)}`,
    `세후 이자: ${fmt(r.afterTax)}`,
    `─────────────`,
    `만기 수령액: ${fmt(r.maturity)}`,
  ].join('\n');
  alert(msg);
};

function fmtQty(q) {
  const n = Number(q);
  if (!isFinite(n)) return '';
  if (Math.abs(n) < 1) return n.toFixed(6).replace(/\.?0+$/, '');
  if (n % 1 === 0) return n.toLocaleString('ko-KR');
  return n.toFixed(4).replace(/\.?0+$/, '');
}

function renderTotals() {
  $('#total-krw').textContent = fmtKRW(state.totalKRW);
  if (state.lastSnapshotTotal != null) {
    const delta = state.totalKRW - state.lastSnapshotTotal;
    const pct = state.lastSnapshotTotal ? (delta / state.lastSnapshotTotal) * 100 : 0;
    const el = $('#total-delta');
    el.textContent = (delta >= 0 ? '▲ ' : '▼ ') + fmtKRWShort(Math.abs(delta)) + '  ' + fmtPct(pct);
    el.classList.toggle('up', delta >= 0);
    el.classList.toggle('down', delta < 0);
  } else {
    $('#total-delta').innerHTML = '&nbsp;';
  }
}

// ---------- 대시보드 ----------
function renderDashboard() {
  const tt = state.totalsByType || {};
  const total = state.totalKRW || 0;
  const realestate = tt.realestate || 0;
  const financial = total - realestate;
  const invest = (tt.stock_kr || 0) + (tt.stock_us || 0) + (tt.crypto || 0) + (tt.brokerage || 0);

  // 평가 손익 합계
  let pl = 0, hasPL = false;
  for (const a of state.accounts) {
    const ev = evalAccount(a);
    if (ev.pl != null) { pl += ev.pl; hasPL = true; }
  }

  // 이번 달 지출 (저축 기여 제외)
  const mo = todayKST().slice(0, 7);
  const spend = state.transactions
    .filter(t => t.date.startsWith(mo) && t.type === 'expense')
    .reduce((s, t) => s + t.amountKRW, 0);

  $('#dk-financial').textContent = fmtKRW(financial);
  $('#dk-financial-sub').textContent = total ? `전체 ${(financial/total*100).toFixed(1)}%` : '부동산 제외';
  $('#dk-invest').textContent = fmtKRW(invest);
  $('#dk-invest-sub').textContent = total ? `전체 ${(invest/total*100).toFixed(1)}%` : '주식·코인';
  const plEl = $('#dk-pl');
  if (hasPL) {
    plEl.textContent = (pl >= 0 ? '+' : '') + fmtKRW(pl).replace('₩ ', '₩');
    plEl.classList.toggle('up', pl >= 0);
    plEl.classList.toggle('down', pl < 0);
  } else {
    plEl.textContent = '—';
  }
  $('#dk-pl-sub').textContent = '주식·코인 종합';
  $('#dk-spend').textContent = fmtKRW(spend);
  $('#dk-spend-sub').textContent = mo + ' 지출';

  renderAllocationDonut();
  renderPortfolioTable();
  renderMiniSpark();
  renderEvents();
}

function renderAllocationDonut() {
  const canvas = document.getElementById('alloc-donut');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2;
  const rOuter = Math.min(W, H) / 2 - 8;
  const rInner = rOuter - 22;

  const data = [];
  for (const type of TYPE_ORDER) {
    const v = state.totalsByType[type];
    if (v && v > 0) data.push({ type, v });
  }
  const total = data.reduce((s, d) => s + d.v, 0);
  if (!total) {
    ctx.fillStyle = '#a6aab2';
    ctx.font = '11px "EB Garamond", serif';
    ctx.textAlign = 'center';
    ctx.fillText('데이터 없음', cx, cy);
    return;
  }
  let start = -Math.PI / 2;
  for (const d of data) {
    const ang = (d.v / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, rOuter, start, start + ang);
    ctx.arc(cx, cy, rInner, start + ang, start, true);
    ctx.closePath();
    ctx.fillStyle = TYPE_COLOR[d.type] || '#888';
    ctx.fill();
    start += ang;
  }
  // 중앙 총합
  ctx.fillStyle = '#1a1d22';
  ctx.font = '500 15px "Inter Tight", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(fmtKRWShort(total), cx, cy - 4);
  ctx.fillStyle = '#6f7480';
  ctx.font = 'italic 11px "EB Garamond", serif';
  ctx.fillText('total', cx, cy + 12);

  // 레전드
  const leg = document.getElementById('alloc-legend');
  leg.innerHTML = data.map(d => `
    <div class="al-row">
      <span class="al-dot" style="background:${TYPE_COLOR[d.type]}"></span>
      <span class="al-lbl">${TYPE_LABEL[d.type]}</span>
      <span class="al-val">${(d.v/total*100).toFixed(1)}%</span>
    </div>`).join('');
}

function renderPortfolioTable() {
  const el = document.getElementById('pf-table');
  if (!el) return;
  const standalone = state.accounts.filter(a => ['stock_kr','stock_us','crypto'].includes(a.type));
  const brokerages = state.accounts.filter(a => a.type === 'brokerage');
  if (!standalone.length && !brokerages.length) {
    el.innerHTML = '<div class="pf-empty">주식/코인 계좌를 추가하면 실시간 시세가 여기 표시됩니다.</div>';
    return;
  }

  const standaloneRows = standalone.map(a => ({ a, ev: evalAccount(a) }));
  const brokerageEv = brokerages.map(a => ({ a, ev: evalAccount(a) }));
  const total = standaloneRows.reduce((s, r) => s + r.ev.valueKRW, 0)
              + brokerageEv.reduce((s, r) => s + r.ev.valueKRW, 0) || 1;

  const renderHoldingRow = (spec, label, valueKRW, ev, indent) => {
    const pct = (valueKRW / total * 100).toFixed(1);
    const isUsd = spec.assetType === 'stock_us' || (spec.assetType === 'crypto' && ev.priceUSD != null);
    const priceStr = isUsd
      ? (ev.priceUSD != null ? `$${ev.priceUSD.toFixed(2)}` : '—')
      : (ev.priceKRW != null ? '₩' + Math.round(ev.priceKRW).toLocaleString('ko-KR') : '—');
    const plCls = ev.pl == null ? '' : ev.pl >= 0 ? 'up' : 'down';
    const plText = ev.pl == null ? '—'
      : `${ev.pl >= 0 ? '+' : ''}${fmtKRWShort(ev.pl)}${ev.plPct != null ? ' · ' + fmtPct(ev.plPct, 1) : ''}`;
    const qtyStr = spec.quantity != null ? fmtQty(spec.quantity) : '';
    // USD 자산은 평단 $ · 현재가 $ 로 표기. 평가금액·손익은 KRW 환산 (pf-val / pf-pl 열).
    const avgStr = spec.avgCost && Number(spec.avgCost) > 0
      ? (isUsd ? `평단 $${Number(spec.avgCost).toFixed(2)}` : `평단 ₩${Math.round(spec.avgCost).toLocaleString('ko-KR')}`)
      : '';
    // 비상장/custom 종목이고 avgCost=0 이면 "평단 입력 필요" 경고 배지 추가.
    const needsAvg = ['custom', 'fund', 'bond'].includes(spec.assetType)
                  && (!spec.avgCost || Number(spec.avgCost) === 0)
                  && (!spec.manualPriceKRW || Number(spec.manualPriceKRW) === 0);
    const warnBadge = needsAvg
      ? `<span class="pf-warn" title="평단 또는 현재가를 입력하면 수량×평단으로 합산됩니다">⚠ 평단 입력 필요</span>`
      : '';
    const subLeft = [esc(spec.ticker || ''), qtyStr && `${qtyStr}주`, priceStr, avgStr].filter(Boolean).join(' · ');
    // 시세 조회 가능한 종목은 클릭 시 차트 모달 오픈.
    const chartable = ['stock_kr', 'stock_us', 'crypto'].includes(spec.assetType) && spec.ticker;
    const rowAttrs = chartable
      ? ` class="pf-row${indent ? ' pf-sub-row' : ''} pf-clickable" data-chart-type="${esc(spec.assetType)}" data-chart-ticker="${esc(spec.ticker)}" data-chart-label="${esc(label)}"`
      : ` class="pf-row${indent ? ' pf-sub-row' : ''}"`;
    return `
      <div${rowAttrs}>
        <div class="pf-name">${esc(label)}${warnBadge}<span class="pf-sub">${subLeft}</span></div>
        <div class="pf-val">${fmtKRWShort(valueKRW)}</div>
        <div class="pf-pct">${pct}%</div>
        <div class="pf-pl ${plCls}">${plText}</div>
      </div>`;
  };

  const parts = [];

  // 증권 계좌: 그룹 헤더 + holdings 펼침
  brokerageEv.sort((x, y) => y.ev.valueKRW - x.ev.valueKRW).forEach(({ a, ev }) => {
    const pct = (ev.valueKRW / total * 100).toFixed(1);
    const plCls = ev.pl == null ? '' : ev.pl >= 0 ? 'up' : 'down';
    const plText = ev.pl == null ? '—'
      : `${ev.pl >= 0 ? '+' : ''}${fmtKRWShort(ev.pl)}${ev.plPct != null ? ' · ' + fmtPct(ev.plPct, 1) : ''}`;
    const accSub = [a.institution, a.accountKind && a.accountKind !== '일반' ? a.accountKind : null, `${(a.holdings||[]).length}개 종목`]
      .filter(Boolean).join(' · ');
    parts.push(`
      <div class="pf-row pf-group-row">
        <div class="pf-name">${esc(a.label)}<span class="pf-sub">${esc(accSub)}</span></div>
        <div class="pf-val">${fmtKRWShort(ev.valueKRW)}</div>
        <div class="pf-pct">${pct}%</div>
        <div class="pf-pl ${plCls}">${plText}</div>
      </div>`);
    const hs = (a.holdings || []).map(h => ({ h, ev: evalHoldingSpec({
      assetType: h.assetType, ticker: h.ticker, quantity: h.quantity,
      avgCost: h.avgCost, currency: h.currency, institution: a.institution,
    }) })).sort((x, y) => y.ev.valueKRW - x.ev.valueKRW);
    for (const { h, ev: hev } of hs) {
      parts.push(renderHoldingRow(h, h.label || h.ticker, hev.valueKRW, hev, true));
    }
    if (a.cashKRW) {
      parts.push(`
        <div class="pf-row pf-sub-row">
          <div class="pf-name">예수금<span class="pf-sub">현금성</span></div>
          <div class="pf-val">${fmtKRWShort(a.cashKRW)}</div>
          <div class="pf-pct">${(a.cashKRW / total * 100).toFixed(1)}%</div>
          <div class="pf-pl">—</div>
        </div>`);
    }
  });

  // 단독 종목 계좌 — 암호화폐는 같은 티커끼리 그룹핑.
  const cryptoRows = standaloneRows.filter(({ a }) => a.type === 'crypto');
  const otherRows  = standaloneRows.filter(({ a }) => a.type !== 'crypto');

  // 비-암호화폐는 기존 방식대로
  otherRows.sort((x, y) => y.ev.valueKRW - x.ev.valueKRW).forEach(({ a, ev }) => {
    parts.push(renderHoldingRow(
      { assetType: a.type, ticker: a.ticker, quantity: a.quantity, avgCost: a.avgCost },
      a.label, ev.valueKRW, ev, false
    ));
  });

  // 암호화폐: 티커별 그룹핑
  const cryptoMap = new Map();
  for (const item of cryptoRows) {
    const key = String(item.a.ticker || '?').toUpperCase();
    if (!cryptoMap.has(key)) cryptoMap.set(key, []);
    cryptoMap.get(key).push(item);
  }
  const cryptoGroups = [...cryptoMap.entries()].map(([ticker, items]) => {
    const t = { qty: 0, valueKRW: 0, cost: 0, hasCost: false, priceKRW: null, priceUSD: null };
    for (const { a, ev } of items) {
      t.qty += Number(a.quantity || 0);
      t.valueKRW += ev.valueKRW || 0;
      if (ev.cost != null) { t.cost += ev.cost; t.hasCost = true; }
      if (ev.priceKRW) t.priceKRW = ev.priceKRW;
      if (ev.priceUSD) t.priceUSD = ev.priceUSD;
    }
    if (t.hasCost) {
      t.pl = t.valueKRW - t.cost;
      t.plPct = t.cost > 0 ? (t.pl / t.cost) * 100 : null;
    }
    return { ticker, items, total: t };
  }).sort((x, y) => y.total.valueKRW - x.total.valueKRW);

  for (const g of cryptoGroups) {
    if (g.items.length === 1) {
      const { a, ev } = g.items[0];
      parts.push(renderHoldingRow(
        { assetType: a.type, ticker: a.ticker, quantity: a.quantity, avgCost: a.avgCost },
        a.label, ev.valueKRW, ev, false
      ));
      continue;
    }
    // 그룹 헤더: 티커 + 합계
    const t = g.total;
    const pct = (t.valueKRW / total * 100).toFixed(1);
    const plCls = t.pl == null ? '' : t.pl >= 0 ? 'up' : 'down';
    const plText = t.pl == null ? '—'
      : `${t.pl >= 0 ? '+' : ''}${fmtKRWShort(t.pl)}${t.plPct != null ? ' · ' + fmtPct(t.plPct, 1) : ''}`;
    const exList = g.items.map(({ a }) => `${esc(a.institution || '?')} ${fmtQty(a.quantity)}`).join(' · ');
    parts.push(`
      <div class="pf-row pf-group-row">
        <div class="pf-name">${esc(g.ticker)}<span class="pf-sub">${g.items.length}개 거래소 · 합계 ${fmtQty(t.qty)}개 · ${exList}</span></div>
        <div class="pf-val">${fmtKRWShort(t.valueKRW)}</div>
        <div class="pf-pct">${pct}%</div>
        <div class="pf-pl ${plCls}">${plText}</div>
      </div>`);
    for (const { a, ev } of g.items) {
      parts.push(renderHoldingRow(
        { assetType: a.type, ticker: a.ticker, quantity: a.quantity, avgCost: a.avgCost },
        a.institution || a.label, ev.valueKRW, ev, true
      ));
    }
  }

  el.innerHTML = parts.join('');
}

// ---------- 주요 이벤트 캘린더 ----------
const EV_IMPORTANCE_LABEL = { critical: '최상', high: '상', mid: '중', low: '하' };
const EV_IMPORTANCE_ORDER = { critical: 0, high: 1, mid: 2, low: 3 };
const EV_CATEGORY_LABEL = { economic: '경제지표', earnings: '실적' };

// category 가 없는 구 이벤트를 tag/title 로 추정 (서버 GET 에서 이미 주입하지만 2중 방어).
function inferEventCategory(e) {
  if (e.category === 'economic' || e.category === 'earnings') return e.category;
  if (typeof e.tag === 'string' && /실적|earnings/i.test(e.tag)) return 'earnings';
  if (typeof e.title === 'string' && /실적|earnings|분기|Q[1-4]/i.test(e.title)) return 'earnings';
  return 'economic';
}

function renderEvents() {
  const list = document.getElementById('ev-list');
  if (!list) return;
  // 오늘 이후 14일 + 최근 2일 범위
  const today = todayKST();
  const endD = new Date(today + 'T00:00:00+09:00');
  endD.setDate(endD.getDate() + 14);
  const endStr = endD.toLocaleString('sv', { timeZone: 'Asia/Seoul' }).slice(0, 10);
  const fromD = new Date(today + 'T00:00:00+09:00');
  fromD.setDate(fromD.getDate() - 2);
  const fromStr = fromD.toLocaleString('sv', { timeZone: 'Asia/Seoul' }).slice(0, 10);

  const events = (state.events || [])
    .filter(e => e.date >= fromStr && e.date <= endStr)
    .sort((a, b) => a.date === b.date
      ? (EV_IMPORTANCE_ORDER[a.importance] ?? 9) - (EV_IMPORTANCE_ORDER[b.importance] ?? 9)
      : (a.date < b.date ? -1 : 1)
    );

  if (!events.length) {
    list.innerHTML = `<div class="ev-empty">등록된 이벤트가 없습니다. 우측 <b>＋ 추가</b> 버튼으로 추가하세요.</div>`;
    return;
  }

  const economic = [];
  const earnings = [];
  for (const e of events) {
    (inferEventCategory(e) === 'earnings' ? earnings : economic).push(e);
  }

  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const todayD = new Date(today + 'T00:00:00+09:00');
  const renderRow = (e) => {
    const d = new Date(e.date + 'T00:00:00+09:00');
    const dow = DOW[d.getDay()];
    const isPast = e.date < today;
    const isToday = e.date === today;
    const daysDiff = Math.round((d - todayD) / 86400000);
    // 사이드바 폭 절감: 2026-04-22 대신 04/22 형태. 오늘/내일/어제는 라벨화.
    let when = e.date.slice(5).replace('-', '/') + `(${dow})`;
    if (isToday) when = `오늘(${dow})`;
    else if (daysDiff === 1) when = `내일(${dow})`;
    else if (daysDiff === -1) when = `어제(${dow})`;
    else if (daysDiff > 0 && daysDiff <= 7) when += ` D-${daysDiff}`;
    return `
      <div class="ev-row ev-imp-${e.importance}${isPast ? ' ev-past' : ''}${isToday ? ' ev-today' : ''}" data-id="${e.id}">
        <span class="ev-date">${when}</span>
        ${e.tag ? `<span class="ev-tag">${esc(e.tag)}</span>` : '<span></span>'}
        <span class="ev-title">${esc(e.title)}</span>
        <span class="ev-imp ev-imp-badge-${e.importance}">${EV_IMPORTANCE_LABEL[e.importance] || e.importance}</span>
        <button class="ev-del" data-evdel="${e.id}" title="삭제">×</button>
      </div>`;
  };
  const renderSection = (label, rows) => {
    if (!rows.length) return '';
    return `<div class="ev-section-title">${label} <span class="ev-section-count">${rows.length}</span></div>`
      + rows.map(renderRow).join('');
  };

  // 가로 스트립 모드 (대시보드 최상단)는 섹션 구분 없이 날짜순 단일 흐름으로 출력.
  const isStrip = list.parentElement && list.parentElement.classList.contains('events-strip');
  if (isStrip) {
    list.innerHTML = events.map(renderRow).join('');
  } else {
    list.innerHTML = renderSection('📊 경제지표', economic) + renderSection('💼 실적', earnings);
  }
}

function setupEvents() {
  const addBtn = document.getElementById('ev-add-btn');
  const form = document.getElementById('ev-addform');
  const saveBtn = document.getElementById('ev-save-btn');
  const cancelBtn = document.getElementById('ev-cancel-btn');
  const dateIn = document.getElementById('ev-new-date');
  const titleIn = document.getElementById('ev-new-title');
  const catIn = document.getElementById('ev-new-category');
  const impIn = document.getElementById('ev-new-importance');
  const tagIn = document.getElementById('ev-new-tag');
  const list = document.getElementById('ev-list');
  if (!addBtn || !form) return;

  const resetForm = () => {
    form.classList.add('hidden');
    dateIn.value = todayKST();
    titleIn.value = '';
    if (catIn) catIn.value = 'economic';
    impIn.value = 'high';
    tagIn.value = '';
  };
  addBtn.addEventListener('click', () => {
    dateIn.value = dateIn.value || todayKST();
    form.classList.toggle('hidden');
    if (!form.classList.contains('hidden')) titleIn.focus();
  });
  cancelBtn.addEventListener('click', resetForm);

  saveBtn.addEventListener('click', async () => {
    const date = dateIn.value;
    const title = titleIn.value.trim();
    const category = (catIn && catIn.value) || 'economic';
    const importance = impIn.value;
    const tag = tagIn.value.trim();
    if (!date || !title) { alert('날짜와 제목을 입력하세요.'); return; }
    const ev = {
      id: 'ev-' + date.replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 8),
      date, title, category, importance, tag, note: '',
    };
    try {
      const r = await apiPost(API.events, { op: 'create', event: ev });
      state.events = r.events || [];
      resetForm();
      renderEvents();
    } catch (e) { alert('이벤트 추가 실패: ' + e.message); }
  });

  list.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-evdel]');
    if (!del) return;
    const id = del.getAttribute('data-evdel');
    const ev = state.events.find(x => x.id === id);
    if (!ev || !confirm(`'${ev.title}' 이벤트를 삭제할까요?`)) return;
    try {
      const r = await apiPost(API.events, { op: 'delete', id });
      state.events = r.events || [];
      renderEvents();
    } catch (ex) { alert('삭제 실패: ' + ex.message); }
  });
}

// 스파크라인 hover/drag 상태 (대시보드 총자산 차트 전용).
const sparkState = {
  hoverIdx: -1,
  dragStart: -1,
  dragEnd: -1,
  recent: [],
};

function renderMiniSpark() {
  const c = document.getElementById('mini-spark');
  if (!c) return;
  const ctx = c.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth || 280;
  const H = 110;
  c.style.width = W + 'px';
  c.style.height = H + 'px';
  if (c.width !== W * dpr || c.height !== H * dpr) {
    c.width = W * dpr;
    c.height = H * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  }
  ctx.clearRect(0, 0, W, H);

  const all = state.snapshots.slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const recent = all.filter(s => s.date >= cutoff);
  sparkState.recent = recent;
  const stat = document.getElementById('dt-stat');
  if (recent.length < 2) {
    ctx.fillStyle = '#a6aab2';
    ctx.font = 'italic 11px "EB Garamond", serif';
    ctx.textAlign = 'center';
    ctx.fillText('스냅샷이 누적되면 표시됩니다', W / 2, H / 2);
    if (stat) stat.textContent = '—';
    return;
  }
  const vals = recent.map(s => s.totalKRW);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const rng = hi - lo || 1;
  const pad = 6;
  const xAt = (i) => pad + (i / (recent.length - 1)) * (W - pad * 2);
  const yAt = (v) => pad + (1 - (v - lo) / rng) * (H - pad * 2);

  // 드래그 영역 하이라이트
  if (sparkState.dragStart >= 0 && sparkState.dragEnd >= 0 && sparkState.dragStart !== sparkState.dragEnd) {
    const a = Math.min(sparkState.dragStart, sparkState.dragEnd);
    const b = Math.max(sparkState.dragStart, sparkState.dragEnd);
    ctx.fillStyle = 'rgba(49, 130, 246, 0.14)';
    ctx.fillRect(xAt(a), pad, xAt(b) - xAt(a), H - pad * 2);
  }

  ctx.strokeStyle = TYPE_COLOR.stock_kr;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  recent.forEach((s, i) => {
    const x = xAt(i), y = yAt(s.totalKRW);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  // 마지막 점
  const lastX = xAt(recent.length - 1), lastY = yAt(vals[vals.length - 1]);
  ctx.fillStyle = TYPE_COLOR.stock_kr;
  ctx.beginPath(); ctx.arc(lastX, lastY, 3, 0, Math.PI * 2); ctx.fill();

  // Hover crosshair + point
  if (sparkState.hoverIdx >= 0 && sparkState.hoverIdx < recent.length) {
    const s = recent[sparkState.hoverIdx];
    const x = xAt(sparkState.hoverIdx), y = yAt(s.totalKRW);
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.5)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, pad); ctx.lineTo(x, H - pad); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = TYPE_COLOR.stock_kr;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  const first = vals[0], last = vals[vals.length - 1];
  const delta = last - first;
  const pct = first ? (delta / first * 100) : 0;
  if (stat && sparkState.hoverIdx < 0) {
    const cls = delta >= 0 ? 'dt-up' : 'dt-down';
    stat.innerHTML = `<span class="${cls}">${delta >= 0 ? '▲' : '▼'} ${fmtKRWShort(Math.abs(delta))} · ${fmtPct(pct)}</span>`;
  }
}

// 스파크라인 마우스 핸들러 (hover + drag).
function setupMiniSpark() {
  const c = document.getElementById('mini-spark');
  const tip = document.getElementById('spark-tooltip');
  if (!c) return;

  const pickIdx = (e) => {
    const r = sparkState.recent;
    if (!r.length) return -1;
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pad = 6;
    const W = rect.width;
    const ratio = (x - pad) / Math.max(1, W - pad * 2);
    return Math.max(0, Math.min(r.length - 1, Math.round(ratio * (r.length - 1))));
  };

  c.addEventListener('mousemove', (e) => {
    const idx = pickIdx(e);
    if (idx < 0) return;
    sparkState.hoverIdx = idx;
    if (sparkState.dragStart >= 0) sparkState.dragEnd = idx;
    renderMiniSpark();

    // 툴팁 + 하단 stat 갱신
    const r = sparkState.recent;
    const s = r[idx];
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const stat = document.getElementById('dt-stat');
    if (sparkState.dragStart >= 0 && sparkState.dragStart !== sparkState.dragEnd) {
      const a = Math.min(sparkState.dragStart, sparkState.dragEnd);
      const b = Math.max(sparkState.dragStart, sparkState.dragEnd);
      const vA = r[a].totalKRW, vB = r[b].totalKRW;
      const diff = vB - vA;
      const pct = vA ? (diff / vA * 100) : 0;
      const cls = diff >= 0 ? 'dt-up' : 'dt-down';
      if (stat) stat.innerHTML = `<span class="${cls}">${r[a].date} → ${r[b].date} · ${diff >= 0 ? '+' : ''}${fmtKRWShort(diff)} (${fmtPct(pct)})</span>`;
    } else {
      if (stat) stat.innerHTML = `<b>${s.date}</b> · ${fmtKRW(s.totalKRW)}`;
    }
    if (tip) {
      tip.innerHTML = `<b>${esc(s.date)}</b><br>${fmtKRW(s.totalKRW)}`;
      tip.style.left = (x + 12) + 'px';
      tip.style.top = '8px';
      tip.classList.remove('hidden');
    }
  });
  c.addEventListener('mousedown', () => {
    if (sparkState.hoverIdx < 0) return;
    sparkState.dragStart = sparkState.hoverIdx;
    sparkState.dragEnd = sparkState.hoverIdx;
  });
  c.addEventListener('mouseup', () => {
    if (sparkState.dragStart === sparkState.dragEnd) {
      sparkState.dragStart = -1;
      sparkState.dragEnd = -1;
      renderMiniSpark();
    }
  });
  c.addEventListener('mouseleave', () => {
    sparkState.hoverIdx = -1;
    if (tip) tip.classList.add('hidden');
    renderMiniSpark();
  });
}

// ---------- 자산 폼 ----------
function populateInstitutionOptions(type, current) {
  const sel = document.querySelector('#acc-form [name="institution"]');
  if (!sel) return;
  let list;
  if (type === 'savings' || type === 'deposit') list = BANKS;
  else if (type === 'stock_kr' || type === 'stock_us' || type === 'brokerage') list = BROKERS;
  else if (type === 'crypto') list = CRYPTO_EXCHANGES.map(e => e.name);
  else if (type === 'custom') list = [...BANKS, ...BROKERS]; // 연금·펀드는 은행/증권사 모두 발생 가능
  else list = [];
  const extras = current && !list.includes(current) ? [current] : [];
  sel.innerHTML = ['<option value="">선택하세요</option>', ...[...list, ...extras].map(n => `<option value="${esc(n)}">${esc(n)}</option>`)].join('');
  if (current) sel.value = current;
}

function setupAccForm() {
  const form = $('#acc-form');
  const typeSel = form.elements.type;
  const submitBtn = document.getElementById('acc-submit');
  const cancelBtn = document.getElementById('acc-cancel');
  const heRows = document.getElementById('he-rows');
  const heAddBtn = document.getElementById('he-add');
  state.editingAccountId = null;

  // --- holdings editor ---
  // 종목 유형에 따른 평단 입력 통화 힌트
  const avgHintFor = (at) => at === 'stock_us' ? '평단 $' : at === 'crypto' ? '평단' : '평단 ₩';
  const addHoldingRow = (h = {}) => {
    const row = document.createElement('div');
    row.className = 'he-row';
    const at = h.assetType || 'stock_kr';
    // 비상장(custom) 은 수동 현재가(manualPriceKRW) 를 별도 저장. UI 에서는 avgCost 옆에 작은 입력으로 보여줌.
    const isCustom = at === 'custom' || at === 'fund' || at === 'bond';
    row.innerHTML = `
      <select class="he-at">
        <option value="stock_kr"${at === 'stock_kr' ? ' selected' : ''}>국내주식</option>
        <option value="stock_us"${at === 'stock_us' ? ' selected' : ''}>해외주식</option>
        <option value="crypto"${at === 'crypto' ? ' selected' : ''}>코인</option>
        <option value="fund"${at === 'fund' ? ' selected' : ''}>펀드/ETF</option>
        <option value="bond"${at === 'bond' ? ' selected' : ''}>채권</option>
        <option value="custom"${at === 'custom' ? ' selected' : ''}>비상장/기타</option>
      </select>
      <input class="he-tk" placeholder="005930" value="${esc(h.ticker || '')}" maxlength="20" />
      <input class="he-nm" placeholder="종목명 (선택)" value="${esc(h.label || '')}" maxlength="60" />
      <input class="he-qt" type="number" step="any" min="0" placeholder="수량" value="${h.quantity != null ? h.quantity : ''}" />
      <div class="he-av-wrap">
        <input class="he-av" type="number" step="any" min="0" placeholder="${avgHintFor(at)}" value="${h.avgCost != null ? h.avgCost : ''}" />
        <input class="he-mp" type="number" step="any" min="0" placeholder="현재가 ₩" value="${h.manualPriceKRW != null ? h.manualPriceKRW : ''}" title="비상장 종목의 수동 현재가 (선택). 시세가 없을 때만 사용." ${isCustom ? '' : 'hidden'} />
      </div>
      <button type="button" class="he-del" title="삭제">×</button>
    `;
    heRows.appendChild(row);
  };
  const clearHoldings = () => { heRows.innerHTML = ''; };
  const collectHoldings = () => {
    const out = [];
    heRows.querySelectorAll('.he-row').forEach(row => {
      const assetType = row.querySelector('.he-at').value;
      let ticker = row.querySelector('.he-tk').value.trim();
      const label = row.querySelector('.he-nm').value.trim();
      const qty = Number(row.querySelector('.he-qt').value);
      const avg = row.querySelector('.he-av').value.trim();
      const manual = row.querySelector('.he-mp')?.value.trim() || '';
      if (!ticker || !isFinite(qty) || qty <= 0) return;
      if (assetType === 'stock_us') ticker = ticker.toUpperCase();
      if (assetType === 'crypto') ticker = ticker.toUpperCase().replace(/^KRW-/, '').replace(/-USD$/, '');
      const h = { assetType, ticker, quantity: qty };
      if (label) h.label = label.slice(0, 60);
      if (avg) { const a = Number(avg); if (isFinite(a) && a >= 0) h.avgCost = a; }
      if (manual) { const m = Number(manual); if (isFinite(m) && m > 0) h.manualPriceKRW = m; }
      if (assetType === 'stock_us') h.currency = 'USD';
      out.push(h);
    });
    return out;
  };
  heAddBtn.addEventListener('click', () => addHoldingRow());
  heRows.addEventListener('change', (e) => {
    const sel = e.target.closest('.he-at');
    if (!sel) return;
    // 종목 유형 바뀌면 평단 placeholder 통화 힌트 + 수동 현재가 필드 토글.
    const row = sel.closest('.he-row');
    const avgInput = row.querySelector('.he-av');
    const manualInput = row.querySelector('.he-mp');
    const isCustom = ['custom', 'fund', 'bond'].includes(sel.value);
    if (avgInput) avgInput.placeholder = avgHintFor(sel.value);
    if (manualInput) {
      if (isCustom) manualInput.removeAttribute('hidden');
      else { manualInput.setAttribute('hidden', ''); manualInput.value = ''; }
    }
  });
  heRows.addEventListener('click', (e) => {
    if (e.target.closest('.he-del')) e.target.closest('.he-row').remove();
  });

  // 단일 종목 유형(stock_us / stock_kr / crypto 해외거래소)의 평단 placeholder 갱신.
  const updateAvgPlaceholder = () => {
    const avgInput = form.elements.avgCost;
    if (!avgInput) return;
    const t = typeSel.value;
    if (t === 'stock_us') { avgInput.placeholder = '평균 단가 ($)'; return; }
    if (t === 'stock_kr') { avgInput.placeholder = '평균 단가 (₩)'; return; }
    if (t === 'crypto') {
      const instName = form.elements.institution?.value || '';
      const ex = CRYPTO_EXCHANGES.find(e => e.name === instName);
      avgInput.placeholder = ex?.currency === 'USD' ? '평균 단가 ($)' : '평균 단가 (₩)';
      return;
    }
    avgInput.placeholder = '0';
  };

  const applyTypeClass = (preserveInst) => {
    form.className = 'acc-form t-' + typeSel.value;
    populateInstitutionOptions(typeSel.value, preserveInst || '');
    updateAvgPlaceholder();
  };
  applyTypeClass();
  typeSel.addEventListener('change', () => {
    applyTypeClass();
    // brokerage 전환 시 기본 holdings 1줄 제공
    if (typeSel.value === 'brokerage' && !heRows.children.length) addHoldingRow();
  });
  // 암호화폐 거래소가 바뀌면 평단 단위 힌트도 함께 갱신.
  form.elements.institution?.addEventListener('change', updateAvgPlaceholder);

  const resetToCreate = () => {
    state.editingAccountId = null;
    form.reset();
    clearHoldings();
    applyTypeClass();
    submitBtn.textContent = '추가';
    cancelBtn.hidden = true;
    document.querySelectorAll('#eq-grid .acc-line.editing').forEach(el => el.classList.remove('editing'));
  };

  cancelBtn.addEventListener('click', resetToCreate);

  // 편집 시작 — 기존 계좌 클릭 시 폼으로 값 채우고 수정 모드 전환
  window._startEditAccount = (id) => {
    const a = state.accounts.find(x => x.id === id);
    if (!a) return;
    state.editingAccountId = id;
    clearHoldings();
    // type 은 import 로 생성된 deposit 도 은행 폼을 재사용
    const formType = a.type === 'deposit' ? 'savings' : a.type;
    typeSel.value = formType;
    applyTypeClass(a.institution || '');
    form.elements.label.value = a.label || '';
    if (form.elements.product) form.elements.product.value = a.product || (a.type === 'deposit' ? '예금' : '수시입출');
    if (form.elements.accountKind) form.elements.accountKind.value = a.accountKind || '일반';
    form.elements.amountKRW.value = a.amountKRW != null ? a.amountKRW : '';
    if (form.elements.principalKRW) form.elements.principalKRW.value = a.principalKRW != null ? a.principalKRW : '';
    if (form.elements.cashKRW) form.elements.cashKRW.value = a.cashKRW != null ? a.cashKRW : '';
    form.elements.ticker.value = a.ticker || '';
    form.elements.quantity.value = a.quantity != null ? a.quantity : '';
    form.elements.avgCost.value = a.avgCost != null ? a.avgCost : '';
    form.elements.interestRate.value = a.interestRate != null ? a.interestRate : '';
    form.elements.maturityDate.value = a.maturityDate || '';
    if (form.elements.startDate) form.elements.startDate.value = a.startDate || '';
    if (form.elements.monthlyDeposit) form.elements.monthlyDeposit.value = a.monthlyDeposit != null ? a.monthlyDeposit : '';
    if (form.elements.taxRate) form.elements.taxRate.value = a.taxRate != null ? a.taxRate : '';
    if (a.type === 'brokerage' && Array.isArray(a.holdings)) {
      a.holdings.forEach(h => addHoldingRow(h));
      if (!a.holdings.length) addHoldingRow();
    }
    submitBtn.textContent = '수정 저장';
    cancelBtn.hidden = false;
    document.querySelectorAll('#eq-grid .acc-line.editing').forEach(el => el.classList.remove('editing'));
    document.querySelector(`#eq-grid .acc-line[data-id="${id}"]`)?.classList.add('editing');
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const type = fd.get('type');
    const institution = String(fd.get('institution') || '').trim();
    const product = String(fd.get('product') || '').trim();
    const accountKind = String(fd.get('accountKind') || '').trim();
    let label = String(fd.get('label') || '').trim();

    const numOrNull = (v) => {
      const s = String(v || '').trim();
      if (!s) return null;
      const n = Number(s);
      return isFinite(n) ? n : null;
    };

    // 라벨 자동 생성
    if (!label) {
      if (type === 'savings')        label = [institution, product].filter(Boolean).join(' ') || '은행 계좌';
      else if (type === 'cash')      label = '현금';
      else if (type === 'realestate') label = '부동산';
      else if (type === 'crypto') {
        const base = String(fd.get('ticker') || '').trim().toUpperCase().replace(/^KRW-/, '').replace(/-USD$/, '') || '코인';
        label = [institution, base].filter(Boolean).join(' ');
      }
      else if (type === 'stock_kr' || type === 'stock_us') label = String(fd.get('ticker') || '주식');
      else if (type === 'brokerage') label = [institution, accountKind && accountKind !== '일반' ? accountKind : null].filter(Boolean).join(' ') || '증권 계좌';
      else if (type === 'custom')    label = [institution, accountKind && accountKind !== '일반' ? accountKind : null].filter(Boolean).join(' ') || '연금·기타';
    }

    // 최종 타입 결정 — 은행 폼에서 product 가 예금/적금 이면 type=deposit (만기 관리용 카드로 이동)
    let finalType = type;
    if (type === 'savings' && (product === '예금' || product === '적금')) finalType = 'deposit';

    const account = {
      id: genId('acc', finalType.replace('_','-')),
      type: finalType,
      label,
    };
    if (institution)  account.institution = institution;
    if (product && type === 'savings') account.product = product;
    if (accountKind && (type === 'stock_kr' || type === 'stock_us' || type === 'brokerage' || type === 'custom')) account.accountKind = accountKind;

    if (['cash','savings','deposit','realestate'].includes(finalType)) {
      const amt = numOrNull(fd.get('amountKRW'));
      if (amt == null) return alert('금액을 입력하세요.');
      account.amountKRW = amt;
    }
    if (finalType === 'custom') {
      const amt = numOrNull(fd.get('amountKRW'));
      if (amt == null) return alert('평가금액을 입력하세요.');
      account.amountKRW = amt;
      const principal = numOrNull(fd.get('principalKRW'));
      if (principal != null && principal >= 0) account.principalKRW = principal;
      if (accountKind) account.accountKind = accountKind;
    }
    if (finalType === 'deposit' || (finalType === 'savings' && product === '파킹통장')) {
      if (fd.get('maturityDate')) account.maturityDate = String(fd.get('maturityDate'));
      const rate = numOrNull(fd.get('interestRate'));
      if (rate != null) account.interestRate = rate;
    }
    // 적금·예금 전용: 시작일 / 월 적립금 / 세율
    if (finalType === 'deposit') {
      if (fd.get('startDate'))       account.startDate = String(fd.get('startDate'));
      const md = numOrNull(fd.get('monthlyDeposit'));
      if (md != null && md >= 0)     account.monthlyDeposit = md;
      const tr = numOrNull(fd.get('taxRate'));
      if (tr != null && tr >= 0)     account.taxRate = tr;
    }
    if (['stock_kr','stock_us','crypto'].includes(finalType)) {
      let tk = String(fd.get('ticker') || '').trim();
      const qty = numOrNull(fd.get('quantity'));
      const avg = numOrNull(fd.get('avgCost'));
      if (!tk) return alert('티커/종목코드를 입력하세요.');
      if (qty == null) return alert('수량을 입력하세요.');
      if (finalType === 'crypto') {
        // 거래소 기반으로 KRW/USD 판정 + 라벨에서 KRW-/-USD 접두/접미사 제거
        tk = tk.toUpperCase().replace(/^KRW-/, '').replace(/-USD$/, '');
        const ex = CRYPTO_EXCHANGES.find(e => e.name === institution);
        account.currency = ex?.currency || 'KRW';
      }
      account.ticker = tk;
      account.quantity = qty;
      if (avg != null) account.avgCost = avg;
      if (finalType === 'stock_us') account.currency = 'USD';
    }
    if (finalType === 'realestate') account.manualUpdatedAt = todayKST();
    if (finalType === 'brokerage') {
      const holdings = collectHoldings();
      if (!holdings.length) return alert('최소 1개 이상의 종목을 입력하세요.');
      account.holdings = holdings;
      const cash = numOrNull(fd.get('cashKRW'));
      if (cash != null && cash > 0) account.cashKRW = cash;
    }

    try {
      let r;
      if (state.editingAccountId) {
        // 기존 id·dedupeKey·source 는 보존해서 update
        const existing = state.accounts.find(x => x.id === state.editingAccountId);
        account.id = state.editingAccountId;
        if (existing?.source) account.source = existing.source;
        if (existing?.dedupeKey) account.dedupeKey = existing.dedupeKey;
        r = await apiPost(API.accounts, { op: 'update', account });
      } else {
        r = await apiPost(API.accounts, { op: 'create', account });
      }
      state.accounts = r.accounts || [];
      // "계속 추가" 모드(편집 아닐 때만): 유형·기관·상품 유지하고 종목/금액 필드만 초기화.
      const keepMode = !state.editingAccountId && document.getElementById('acc-keep-mode')?.checked;
      if (keepMode) {
        for (const name of ['label', 'amountKRW', 'principalKRW', 'ticker', 'quantity', 'avgCost', 'interestRate', 'maturityDate']) {
          if (form.elements[name]) form.elements[name].value = '';
        }
        // brokerage 는 holdings 편집기가 있어 "계속 추가" 개념이 맞지 않음 → 일반 리셋.
        if (finalType === 'brokerage') resetToCreate();
        // 입력 포커스: 주식·코인은 티커, 나머지는 금액 필드
        const focusEl = ['stock_kr', 'stock_us', 'crypto'].includes(finalType)
          ? form.elements.ticker
          : form.elements.amountKRW;
        focusEl?.focus();
      } else {
        resetToCreate();
      }
      await refreshQuotes();
      await autoSnapshot();
      renderAll();
    } catch (e) {
      alert((state.editingAccountId ? '수정 실패: ' : '추가 실패: ') + e.message);
    }
  });

  // 위임: 예상 배지 / × 삭제 / 확장 / 라인 클릭 → 편집
  $('#eq-grid').addEventListener('click', async (e) => {
    const estBtn = e.target.closest('[data-estimate]');
    if (estBtn) {
      e.stopPropagation();
      window._showDepositEstimate(estBtn.getAttribute('data-estimate'));
      return;
    }
    const expandBtn = e.target.closest('[data-toggle-expand]');
    if (expandBtn) {
      const linesEl = expandBtn.previousElementSibling;
      if (linesEl && linesEl.classList.contains('eq-lines')) {
        const collapsed = linesEl.classList.toggle('eq-lines--collapsed');
        const n = linesEl.querySelectorAll('.acc-line').length;
        expandBtn.textContent = collapsed ? `＋ 전체 보기 (${n})` : '− 접기';
      }
      return;
    }
    const delBtn = e.target.closest('[data-del]');
    if (delBtn) {
      const id = delBtn.getAttribute('data-del');
      const a = state.accounts.find(x => x.id === id);
      if (!a) return;
      if (!confirm(`'${a.label}' 계좌를 삭제할까요?`)) return;
      try {
        const r = await apiPost(API.accounts, { op: 'delete', id });
        state.accounts = r.accounts || [];
        if (state.editingAccountId === id) resetToCreate();
        await refreshQuotes();
        await autoSnapshot();
        renderAll();
      } catch (ex) {
        alert('삭제 실패: ' + ex.message);
      }
      return;
    }
    const line = e.target.closest('.acc-line');
    if (line && !e.target.closest('button')) {
      const id = line.getAttribute('data-id');
      if (id) window._startEditAccount(id);
    }
  });
}

// 자산 변동 시 오늘 스냅샷 자동 갱신 (같은 날짜는 덮어씀)
async function autoSnapshot() {
  if (!state.totalKRW || !isFinite(state.totalKRW)) return;
  const breakdown = state.totalsByType || {};
  const quotesUsed = {};
  for (const a of state.accounts) {
    if (!a.ticker) continue;
    const q = state.quotes[a.ticker];
    if (q) quotesUsed[a.ticker] = q.priceKRW ?? q.price ?? null;
  }
  if (state.exchangeRate?.rate) quotesUsed['USDKRW'] = state.exchangeRate.rate;
  try {
    await apiPost(API.snapshot, {
      date: todayKST(),
      totalKRW: state.totalKRW,
      breakdown,
      quotesUsed,
    });
    const snaps = await apiGet(API.snapshots).catch(() => ({ snapshots: [] }));
    state.snapshots = snaps.snapshots || [];
    const sorted = state.snapshots.slice().sort((a, b) => a.date < b.date ? -1 : 1);
    state.lastSnapshotTotal = sorted.length >= 2 ? sorted[sorted.length - 2].totalKRW : null;
  } catch (e) {
    console.warn('autoSnapshot fail', e);
  }
}

// 모든 영역 재렌더 (CRUD 후 단일 호출)
function renderAll() {
  renderAssets();
  renderTotals();
  renderDashboard();
  renderSpend();
  if (state.tab === 'graph') renderGraph();
}

// ---------- 소비 렌더 ----------
function monthKey(d) { return d.slice(0, 7); }
function weekStartKST(dateStr) {
  // ISO 기준 월요일 시작. KST 날짜 문자열 'YYYY-MM-DD' 입력.
  const d = new Date(dateStr + 'T00:00:00+09:00');
  const dow = d.getDay(); // 0=Sun
  const diff = dow === 0 ? -6 : 1 - dow; // move back to Monday
  d.setDate(d.getDate() + diff);
  return d.toLocaleString('sv', { timeZone: 'Asia/Seoul' }).slice(0, 10);
}

function renderSpend() {
  const today = todayKST();
  const thisMonth = today.slice(0, 7);
  const thisYear = today.slice(0, 4);
  if (!state.calMonth) state.calMonth = thisMonth;

  const all = state.transactions;
  const isExp = t => t.type === 'expense';
  const isFixed = t => t.recurring && t.recurring.interval === 'monthly';
  const sum = (arr) => arr.reduce((s, t) => s + t.amountKRW, 0);

  // ---------- 기간별 KPI ----------
  const thisMonthTxs = all.filter(t => monthKey(t.date) === thisMonth);
  // "최근 7일" — 오늘 포함 뒤로 6일. 월요일 시작 기준은 사용자가 월요일이면 0원 나오는 함정.
  const weekStartD = new Date(today + 'T00:00:00+09:00');
  weekStartD.setDate(weekStartD.getDate() - 6);
  const thisWeekStart = weekStartD.toLocaleString('sv', { timeZone: 'Asia/Seoul' }).slice(0, 10);
  const todayTxs    = all.filter(t => t.date === today);
  const weekTxs     = all.filter(t => t.date >= thisWeekStart && t.date <= today);
  const yearTxs     = all.filter(t => t.date.startsWith(thisYear));
  // 전월
  const prev = new Date(thisMonth + '-01T00:00:00+09:00');
  prev.setMonth(prev.getMonth() - 1);
  const prevMonth = prev.toLocaleString('sv', { timeZone: 'Asia/Seoul' }).slice(0, 7);
  const prevMonthTxs = all.filter(t => monthKey(t.date) === prevMonth);

  const spTotal   = sum(thisMonthTxs.filter(isExp));
  const spPrev    = sum(prevMonthTxs.filter(isExp));
  const spToday   = sum(todayTxs.filter(isExp));
  const spWeek    = sum(weekTxs.filter(isExp));
  const spYear    = sum(yearTxs.filter(isExp));
  const spFixed   = sum(thisMonthTxs.filter(t => isExp(t) && isFixed(t)));
  const spVar     = spTotal - spFixed;
  const spSave    = sum(thisMonthTxs.filter(t => t.type === 'savings_contribution'));
  const spIncome  = sum(thisMonthTxs.filter(t => t.type === 'income'));

  $('#sp-today').textContent = fmtKRW(spToday);
  $('#sp-week').textContent  = fmtKRW(spWeek);
  $('#sp-total').textContent = fmtKRW(spTotal);
  $('#sp-year').textContent  = fmtKRW(spYear);
  $('#sp-fixed').textContent = fmtKRW(spFixed);
  $('#sp-var').textContent   = fmtKRW(spVar);
  $('#sp-save').textContent  = fmtKRW(spSave);
  $('#sp-income').textContent = fmtKRW(spIncome);

  // 전월·일평균 등 서브
  $('#sp-today-sub').textContent = `${todayTxs.filter(isExp).length}건`;
  $('#sp-week-sub').textContent = `일 평균 ${fmtKRWShort(spWeek / 7)}`;
  const deltaPct = spPrev > 0 ? ((spTotal - spPrev) / spPrev) * 100 : null;
  $('#sp-total-sub').innerHTML = spPrev > 0
    ? `전월 ${fmtKRWShort(spPrev)} <span class="${(spTotal - spPrev) >= 0 ? 'delta-up' : 'delta-down'}">${(spTotal - spPrev) >= 0 ? '+' : ''}${deltaPct.toFixed(0)}%</span>`
    : '';
  const monthsElapsed = new Date().getMonth() + 1;
  $('#sp-year-sub').textContent = monthsElapsed > 0 ? `월 평균 ${fmtKRWShort(spYear / monthsElapsed)}` : '';

  // ---------- 필터 칩 재구성 (동적 카테고리) ----------
  const filterBar = document.getElementById('tx-filters');
  if (filterBar) {
    const cats = allCategories();
    const active = state.txFilter;
    filterBar.innerHTML = [
      `<button class="chip${active === 'all' ? ' active' : ''}" data-cat="all">전체</button>`,
      ...cats.map(c => `<button class="chip${active === c ? ' active' : ''}" data-cat="${esc(c)}">${esc(catLabel(c))}</button>`),
    ].join('');
  }

  // ---------- 달력 ----------
  renderCalendar();

  // ---------- 일별 추이 그래프 ----------
  renderTrendChart();

  // ---------- 도넛 (이번 달 카테고리별 지출) ----------
  const byCat = {};
  for (const t of thisMonthTxs.filter(isExp)) byCat[t.category] = (byCat[t.category] || 0) + t.amountKRW;
  drawDonut(byCat);

  // ---------- 리스트 ----------
  const filter = state.txFilter;
  const search = (state.txSearch || '').trim().toLowerCase();
  const rows = state.transactions
    .slice()
    .sort((a, b) => a.date < b.date ? 1 : (a.date > b.date ? -1 : 0))
    .filter(t => filter === 'all' || t.category === filter)
    .filter(t => !state.txSelectedDate || t.date === state.txSelectedDate)
    .filter(t => {
      if (!search) return true;
      return (t.label || '').toLowerCase().includes(search)
          || (t.category || '').toLowerCase().includes(search)
          || (CAT_LABEL[t.category] || '').toLowerCase().includes(search)
          || String(t.amountKRW).includes(search);
    });

  // 현재 보고 있는 범위 표시
  const scopeBits = [];
  if (state.txSelectedDate) scopeBits.push(`📅 ${state.txSelectedDate} 선택`);
  if (filter !== 'all') scopeBits.push(`카테고리: ${CAT_LABEL[filter] || filter}`);
  if (search) scopeBits.push(`검색: "${esc(search)}"`);
  if (scopeBits.length) scopeBits.push(`<button type="button" class="btn-ghost btn-xs" id="tx-scope-clear">필터 초기화</button>`);
  const scopeEl = $('#tx-scope');
  if (scopeEl) scopeEl.innerHTML = scopeBits.join(' · ');

  const list = $('#tx-list');
  // 선택 가능한 ID 집합 - 화면에 없는 선택은 제거.
  const visibleIds = new Set(rows.map(t => t.id));
  for (const id of state.txSelected) if (!visibleIds.has(id)) state.txSelected.delete(id);

  // 페이지네이션 — txPageShown 까지만 렌더, 초과분은 "더보기" 버튼으로.
  const pageSize = 30;
  const totalRows = rows.length;
  // 필터 바뀌어서 기존 shown 이 지나치게 크면 축소.
  if (state.txPageShown < pageSize) state.txPageShown = pageSize;
  const shown = Math.min(state.txPageShown, totalRows);
  const visibleRows = rows.slice(0, shown);

  const bulkBar = `
    <div class="tx-bulk-bar">
      <label class="tx-checkall">
        <input type="checkbox" id="tx-check-all" ${state.txSelected.size && state.txSelected.size === visibleRows.length ? 'checked' : ''}/>
        <span>전체 선택</span>
      </label>
      <span class="tx-bulk-count">${state.txSelected.size ? `${state.txSelected.size}건 선택됨` : `${totalRows}건 중 ${shown}건 표시`}</span>
      <button type="button" class="btn-danger" id="tx-bulk-del" ${state.txSelected.size ? '' : 'disabled'}>선택 삭제</button>
    </div>`;
  const moreBar = shown < totalRows
    ? `<button type="button" class="tx-more" id="tx-more">＋ ${Math.min(pageSize, totalRows - shown)}건 더보기 (${totalRows - shown}건 남음)</button>`
    : '';
  if (!rows.length) {
    list.innerHTML = bulkBar + `<div class="tx-empty">거래가 없습니다.</div>`;
  } else {
    list.innerHTML = bulkBar + visibleRows.map(t => {
      const editing = state.editingTxId === t.id ? ' editing' : '';
      const checked = state.txSelected.has(t.id) ? 'checked' : '';
      return `
      <div class="tx-row ${t.type === 'income' ? 'income' : ''}${t.type === 'transfer' ? ' transfer' : ''}${editing}" data-id="${t.id}">
        <label class="tx-check" title="선택">
          <input type="checkbox" data-txcheck="${t.id}" ${checked} />
        </label>
        <span class="tx-date">${t.date}</span>
        <span class="tx-cat cat-${t.category}" style="${CAT_COLOR[t.category] ? '' : `background:${catColor(t.category)}20;color:${catColor(t.category)}`}">${esc(catLabel(t.category))}</span>
        <span class="tx-lbl">${esc(t.label)}${t.recurring ? ' <span class="recur-mark">↻</span>' : ''}</span>
        <span class="tx-amt">${t.amountKRW.toLocaleString('ko-KR')} 원</span>
        <button class="tx-edit" data-txedit="${t.id}" title="편집">✎</button>
        <button class="del" data-txdel="${t.id}" title="삭제">×</button>
      </div>
    `;
    }).join('') + moreBar;
  }
}

// ---------- 달력 ----------
function renderCalendar() {
  const grid = document.getElementById('cal-grid');
  const title = document.getElementById('cal-title');
  if (!grid || !title) return;

  const monthKeyStr = state.calMonth || todayKST().slice(0, 7);
  const [y, m] = monthKeyStr.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  // 해당 월 1일의 요일 (일요일=0)
  const startDow = first.getUTCDay();

  // 월 지출 집계 (일자별)
  const byDay = {};
  for (const t of state.transactions) {
    if (!t.date.startsWith(monthKeyStr)) continue;
    if (t.type !== 'expense') continue;
    byDay[t.date] = (byDay[t.date] || 0) + t.amountKRW;
  }
  const monthTotal = Object.values(byDay).reduce((s, v) => s + v, 0);
  title.innerHTML = `${y}년 ${m}월 <span class="cal-month-sum">${fmtKRWShort(monthTotal)}</span>`;

  const today = todayKST();
  const selected = state.txSelectedDate;
  const cells = [];
  // 앞 공백 (저번 달 날짜는 빈 셀로 표시)
  for (let i = 0; i < startDow; i++) cells.push(`<div class="cal-cell cal-empty"></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const amt = byDay[dateStr] || 0;
    const classes = ['cal-cell'];
    if (dateStr === today) classes.push('cal-today');
    if (dateStr === selected) classes.push('cal-selected');
    if (amt > 0) classes.push('cal-has-spend');
    // 지출 강도 (heatmap 3단계)
    if (amt > 0 && monthTotal > 0) {
      const ratio = amt / (monthTotal / daysInMonth); // 일평균 대비
      if (ratio >= 2) classes.push('cal-heat-3');
      else if (ratio >= 1) classes.push('cal-heat-2');
      else classes.push('cal-heat-1');
    }
    cells.push(`
      <div class="${classes.join(' ')}" data-date="${dateStr}">
        <span class="cal-dnum">${d}</span>
        ${amt > 0 ? `<span class="cal-dsum">${fmtKRWShort(amt)}</span>` : ''}
      </div>`);
  }
  grid.innerHTML = cells.join('');
}

// ---------- 일별 지출 추이 그래프 (이번 달 막대차트) ----------
function renderTrendChart() {
  const canvas = document.getElementById('trend-chart');
  const monthLabel = document.getElementById('trend-month');
  if (!canvas) return;
  const parent = canvas.parentElement;
  // DPR 대응 + 폭 맞춤
  const w = parent.clientWidth - 40; // padding
  const h = 180;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const mo = state.calMonth || todayKST().slice(0, 7);
  const [y, m] = mo.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const byDay = new Array(daysInMonth).fill(0);
  const byDayInc = new Array(daysInMonth).fill(0);
  for (const t of state.transactions) {
    if (!t.date.startsWith(mo)) continue;
    const dayIdx = parseInt(t.date.slice(8, 10), 10) - 1;
    if (dayIdx < 0 || dayIdx >= daysInMonth) continue;
    if (t.type === 'expense') byDay[dayIdx] += t.amountKRW;
    else if (t.type === 'income') byDayInc[dayIdx] += t.amountKRW;
  }
  const maxVal = Math.max(1, ...byDay, ...byDayInc);
  const total = byDay.reduce((s, v) => s + v, 0);
  const totalInc = byDayInc.reduce((s, v) => s + v, 0);
  if (monthLabel) {
    monthLabel.innerHTML = `${y}년 ${m}월 · 지출 <b>${fmtKRWShort(total)}</b>${totalInc > 0 ? ` · 수입 <b class="delta-down">${fmtKRWShort(totalInc)}</b>` : ''}`;
  }

  // 축/그리드
  const padL = 40, padR = 10, padT = 10, padB = 26;
  const chartW = w - padL - padR;
  const chartH = h - padT - padB;
  const barW = chartW / daysInMonth;

  // Y 그리드 (4단계)
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gy = padT + chartH - (chartH * i / 4);
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(padL + chartW, gy);
    ctx.stroke();
    const val = (maxVal * i / 4);
    ctx.fillText(fmtKRWShort(val), padL - 5, gy + 3);
  }

  // 오늘 세로선
  const today = todayKST();
  if (today.startsWith(mo)) {
    const todayIdx = parseInt(today.slice(8, 10), 10) - 1;
    const tx = padL + todayIdx * barW + barW / 2;
    ctx.strokeStyle = 'rgba(49, 130, 246, 0.25)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(tx, padT);
    ctx.lineTo(tx, padT + chartH);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 지출 막대
  for (let i = 0; i < daysInMonth; i++) {
    const v = byDay[i];
    if (v <= 0) continue;
    const bh = (v / maxVal) * chartH;
    const bx = padL + i * barW + 1;
    const by = padT + chartH - bh;
    ctx.fillStyle = '#F04452';
    ctx.fillRect(bx, by, Math.max(2, barW - 2), bh);
  }
  // 수입 막대 (겹치기 — 반투명 파랑)
  for (let i = 0; i < daysInMonth; i++) {
    const v = byDayInc[i];
    if (v <= 0) continue;
    const bh = (v / maxVal) * chartH;
    const bx = padL + i * barW + 1;
    const by = padT + chartH - bh;
    ctx.fillStyle = 'rgba(37, 99, 235, 0.55)';
    ctx.fillRect(bx, by, Math.max(2, barW - 2), bh);
  }

  // X축 라벨 (5, 10, 15, 20, 25, 말일)
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'center';
  const ticks = [1, 5, 10, 15, 20, 25, daysInMonth];
  for (const d of ticks) {
    const dx = padL + (d - 1) * barW + barW / 2;
    ctx.fillText(String(d), dx, h - padB + 14);
  }
}

function drawDonut(byCat) {
  const canvas = $('#donut');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const entries = Object.entries(byCat).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  const cx = W / 2, cy = H / 2;
  const rO = Math.min(W, H) / 2 - 8;
  const rI = rO - 32;

  if (!total) {
    ctx.strokeStyle = '#E6E1D3';
    ctx.lineWidth = 22;
    ctx.beginPath(); ctx.arc(cx, cy, (rO + rI) / 2, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#a6aab2';
    ctx.font = 'italic 14px "EB Garamond", serif';
    ctx.textAlign = 'center';
    ctx.fillText('이번 달 지출 없음', cx, cy + 4);
    return;
  }

  let a = -Math.PI / 2;
  for (const [cat, v] of entries) {
    const frac = v / total;
    const a2 = a + frac * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, rO, a, a2);
    ctx.closePath();
    ctx.fillStyle = catColor(cat);
    ctx.fill();
    a = a2;
  }
  // 도넛 홀
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); ctx.arc(cx, cy, rI, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  // 중앙 라벨
  ctx.fillStyle = '#111418';
  ctx.font = '500 18px "Inter Tight", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(fmtKRWShort(total), cx, cy - 2);
  ctx.font = 'italic 11px "EB Garamond", serif';
  ctx.fillStyle = '#6f7480';
  ctx.fillText('총 지출', cx, cy + 16);

  const legend = $('#donut-legend');
  legend.innerHTML = entries
    .sort((a, b) => b[1] - a[1])
    .map(([cat, v]) => `
      <div class="row">
        <span class="dot" style="background:${catColor(cat)}"></span>
        <span>${esc(catLabel(cat))}</span>
        <span>${v.toLocaleString('ko-KR')} 원 · ${(v / total * 100).toFixed(1)}%</span>
      </div>`).join('');
}

function setupTxForm() {
  const form = $('#tx-form');
  const submitBtn = form.querySelector('button[type="submit"]');
  const origSubmitText = submitBtn ? submitBtn.textContent : '추가';
  form.elements.date.value = todayKST();

  // 카테고리 드롭다운을 type 별 목록으로 동적 교체. + 새 카테고리 추가 옵션.
  // 유형이 바뀌면 적합한 카테고리만 표시 (예: 수입 → 월급/아르바이트/코인 등).
  const catSel = form.elements.category;
  const typeSel = form.elements.type;
  const refreshCatOptions = (selected) => {
    const type = typeSel.value || 'expense';
    const baseCats = TYPE_CATS[type] || TYPE_CATS.expense;
    const customCats = getCustomCats();
    // 거래 내역에서 발견된 카테고리 중 표준에도 커스텀에도 없는 것 (이전 버전 데이터 호환)
    const legacy = [];
    for (const t of state.transactions) {
      if (t.type !== type) continue;
      const c = t.category;
      if (c && !baseCats.includes(c) && !customCats.includes(c) && !legacy.includes(c)) legacy.push(c);
    }
    const cats = [...baseCats, ...customCats, ...legacy];
    const cur = selected || catSel.value;
    catSel.innerHTML = [
      ...cats.map(c => `<option value="${esc(c)}">${esc(catLabel(c))}</option>`),
      `<option value="__new__" style="font-style:italic">＋ 새 카테고리 추가...</option>`,
    ].join('');
    // 현재 값 보존 — 새 type 의 목록에 있으면 유지, 없으면 첫 옵션
    catSel.value = cats.includes(cur) ? cur : (cats[0] || '');
  };
  refreshCatOptions();
  typeSel.addEventListener('change', () => refreshCatOptions());
  catSel.addEventListener('change', () => {
    if (catSel.value !== '__new__') return;
    const name = prompt('새 카테고리 이름 (한글/영문/숫자/공백, 최대 30자):');
    if (name && addCustomCat(name)) {
      refreshCatOptions(name.trim());
      // 필터 칩에도 즉시 반영
      renderSpend();
    } else {
      refreshCatOptions();
      if (name) alert('카테고리 형식이 올바르지 않습니다.');
    }
  });

  const resetFormToCreate = () => {
    state.editingTxId = null;
    form.reset();
    form.elements.date.value = todayKST();
    if (submitBtn) submitBtn.textContent = origSubmitText;
  };

  window._startEditTx = (id) => {
    const t = state.transactions.find(x => x.id === id);
    if (!t) return;
    state.editingTxId = id;
    form.elements.date.value = t.date;
    // type 을 먼저 설정하고 카테고리 옵션을 그 type 에 맞게 갱신한 뒤, 저장된 카테고리 값을 적용
    form.elements.type.value = t.type;
    refreshCatOptions(t.category);
    form.elements.amountKRW.value = t.amountKRW;
    form.elements.label.value = t.label || '';
    if (form.elements.recurring) form.elements.recurring.checked = !!t.recurring;
    if (submitBtn) submitBtn.textContent = '수정 저장';
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    renderSpend();
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const dateStr = String(fd.get('date'));
    const tx = {
      date: dateStr,
      type: String(fd.get('type')),
      category: String(fd.get('category')),
      amountKRW: Number(fd.get('amountKRW')),
      label: String(fd.get('label') || '').trim(),
      recurring: fd.get('recurring') ? { interval: 'monthly', dayOfMonth: Number(dateStr.slice(8, 10)) } : null,
    };
    try {
      let r;
      if (state.editingTxId) {
        const existing = state.transactions.find(x => x.id === state.editingTxId);
        tx.id = state.editingTxId;
        if (existing?.source) tx.source = existing.source;
        if (existing?.dedupeKey) tx.dedupeKey = existing.dedupeKey;
        r = await apiPost(API.tx, { op: 'update', transaction: tx });
      } else {
        tx.id = genId('tx', dateStr.replace(/-/g, ''));
        r = await apiPost(API.tx, { op: 'create', transaction: tx });
      }
      state.transactions = r.transactions || [];
      resetFormToCreate();
      renderSpend();
    } catch (e) {
      alert((state.editingTxId ? '수정' : '추가') + ' 실패: ' + e.message);
    }
  });

  $('#tx-filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b) return;
    $$('#tx-filters .chip').forEach(c => c.classList.remove('active'));
    b.classList.add('active');
    state.txFilter = b.getAttribute('data-cat');
    state.txPageShown = 30;
    renderSpend();
  });

  // 일괄 재분류 버튼 — 기존 거래를 현재 규칙(isLikelyTransfer + isBrokerageTransfer)으로 다시 분류.
  const reclassifyBtn = document.getElementById('tx-reclassify');
  if (reclassifyBtn) {
    reclassifyBtn.addEventListener('click', async () => {
      // 재분류 대상 수집
      const toUpdate = [];
      for (const t of state.transactions) {
        const desc = t.label || '';
        let newType = t.type, newCat = t.category;
        if (isLikelyTransfer(desc)) {
          newType = 'transfer';
          newCat = isBrokerageTransfer(desc) ? 'cash' : 'transfer';
        }
        if (newType !== t.type || newCat !== t.category) {
          toUpdate.push({ ...t, type: newType, category: newCat });
        }
      }
      if (!toUpdate.length) return alert('재분류할 항목이 없습니다. (이미 최신 규칙으로 분류됨)');
      if (!confirm(`${toUpdate.length}건을 재분류합니다.\n(증권사·거래소 이체는 "현금"으로, 나머지 내 계좌 이체는 "자금 이동"으로)\n\n계속하시겠어요?`)) return;

      reclassifyBtn.disabled = true;
      reclassifyBtn.textContent = '재분류 중...';
      try {
        // 병렬 update. 너무 많으면 10건씩 청크.
        const chunkSize = 20;
        for (let i = 0; i < toUpdate.length; i += chunkSize) {
          const chunk = toUpdate.slice(i, i + chunkSize);
          await Promise.allSettled(chunk.map(t => apiPost(API.tx, { op: 'update', transaction: t })));
          reclassifyBtn.textContent = `재분류 중... ${Math.min(i + chunkSize, toUpdate.length)}/${toUpdate.length}`;
        }
        const fresh = await apiGet(API.tx);
        state.transactions = fresh.transactions || [];
        renderSpend();
        alert(`${toUpdate.length}건 재분류 완료.`);
      } catch (ex) {
        alert('재분류 중 오류: ' + ex.message);
      } finally {
        reclassifyBtn.disabled = false;
        reclassifyBtn.textContent = '🔄 자금이동 재분류';
      }
    });
  }

  // 검색창 (debounce)
  const searchEl = document.getElementById('tx-search');
  if (searchEl) {
    let sDeb;
    searchEl.addEventListener('input', () => {
      clearTimeout(sDeb);
      sDeb = setTimeout(() => {
        state.txSearch = searchEl.value;
        state.txPageShown = 30;
        renderSpend();
      }, 200);
    });
  }

  // 달력: 월 이동 / 날짜 선택 / 오늘 버튼
  const calGrid = document.getElementById('cal-grid');
  if (calGrid) {
    calGrid.addEventListener('click', (e) => {
      const cell = e.target.closest('[data-date]');
      if (!cell) return;
      const d = cell.getAttribute('data-date');
      state.txSelectedDate = state.txSelectedDate === d ? null : d;
      state.txPageShown = 30;
      renderSpend();
    });
  }
  const calPrev = document.getElementById('cal-prev');
  const calNext = document.getElementById('cal-next');
  const calToday = document.getElementById('cal-today');
  const shiftMonth = (delta) => {
    const [y, m] = (state.calMonth || todayKST().slice(0, 7)).split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    state.calMonth = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    state.txSelectedDate = null;
    renderSpend();
  };
  if (calPrev) calPrev.addEventListener('click', () => shiftMonth(-1));
  if (calNext) calNext.addEventListener('click', () => shiftMonth(1));
  if (calToday) calToday.addEventListener('click', () => {
    const now = todayKST();
    state.calMonth = now.slice(0, 7);
    state.txSelectedDate = now;
    renderSpend();
  });

  // 필터 초기화
  document.addEventListener('click', (e) => {
    if (e.target.id === 'tx-scope-clear') {
      state.txSelectedDate = null;
      state.txSearch = '';
      state.txFilter = 'all';
      if (searchEl) searchEl.value = '';
      $$('#tx-filters .chip').forEach(c => c.classList.toggle('active', c.getAttribute('data-cat') === 'all'));
      renderSpend();
    }
  });

  $('#tx-list').addEventListener('change', (e) => {
    // 개별 체크박스
    const single = e.target.closest('[data-txcheck]');
    if (single) {
      const id = single.getAttribute('data-txcheck');
      if (single.checked) state.txSelected.add(id);
      else state.txSelected.delete(id);
      // 헤더 카운트·버튼 상태만 갱신 (재렌더는 비효율적이지만 코드 단순성 우선)
      renderSpend();
      return;
    }
    // 전체 선택
    if (e.target.id === 'tx-check-all') {
      const rows = $$('#tx-list [data-txcheck]');
      if (e.target.checked) {
        for (const c of rows) state.txSelected.add(c.getAttribute('data-txcheck'));
      } else {
        state.txSelected.clear();
      }
      renderSpend();
    }
  });

  $('#tx-list').addEventListener('click', async (e) => {
    // 더보기
    if (e.target.id === 'tx-more') {
      state.txPageShown += 30;
      renderSpend();
      return;
    }
    // 일괄 삭제
    if (e.target.id === 'tx-bulk-del') {
      const ids = [...state.txSelected];
      if (!ids.length) return;
      if (!confirm(`${ids.length}건을 삭제할까요? 되돌릴 수 없습니다.`)) return;
      e.target.disabled = true;
      e.target.textContent = '삭제 중...';
      try {
        // 서버 bulk_delete 엔드포인트가 없으므로 개별 호출 (속도 위해 병렬).
        // 병렬 응답 순서는 DB 반영 순서를 보장하지 않으므로, 전부 끝난 뒤 서버에서 재조회해
        // 상태 불일치를 원천 차단한다.
        await Promise.allSettled(
          ids.map(id => apiPost(API.tx, { op: 'delete', id }))
        );
        const fresh = await apiGet(API.tx);
        state.transactions = fresh.transactions || [];
        state.txSelected.clear();
        renderSpend();
      } catch (ex) {
        alert('일괄 삭제 실패: ' + ex.message);
      }
      return;
    }
    // 편집 버튼
    const editBtn = e.target.closest('[data-txedit]');
    if (editBtn) {
      window._startEditTx(editBtn.getAttribute('data-txedit'));
      return;
    }
    // 개별 삭제
    const delBtn = e.target.closest('[data-txdel]');
    if (delBtn) {
      const id = delBtn.getAttribute('data-txdel');
      const t = state.transactions.find(x => x.id === id);
      if (!t) return;
      if (!confirm(`'${t.label}' 거래를 삭제할까요?`)) return;
      try {
        const r = await apiPost(API.tx, { op: 'delete', id });
        state.transactions = r.transactions || [];
        if (state.editingTxId === id) resetFormToCreate();
        state.txSelected.delete(id);
        renderSpend();
      } catch (ex) {
        alert('삭제 실패: ' + ex.message);
      }
    }
  });
}

// ---------- 그래프 ----------
function setupGraph() {
  $('#range-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (!b) return;
    $$('#range-chips .chip').forEach(c => c.classList.remove('active'));
    b.classList.add('active');
    const r = b.getAttribute('data-range');
    state.graphRange = r === 'all' ? 'all' : Number(r);
    renderGraph();
  });
  $('#graph-snap-now').addEventListener('click', takeSnapshot);
}

function renderGraph() {
  const snaps = state.snapshots.slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const empty = $('#graph-empty');
  if (snaps.length < 3) {
    empty.classList.remove('hidden');
    if (state.charts.total) { state.charts.total.destroy(); state.charts.total = null; }
    if (state.charts.stack) { state.charts.stack.destroy(); state.charts.stack = null; }
    $('#graph-stats').innerHTML = '';
    return;
  }
  empty.classList.add('hidden');

  // 기간 필터
  let filtered = snaps;
  if (state.graphRange !== 'all') {
    const d0 = new Date();
    d0.setDate(d0.getDate() - state.graphRange);
    const cutoff = d0.toISOString().slice(0, 10);
    filtered = snaps.filter(s => s.date >= cutoff);
    if (filtered.length < 2) filtered = snaps.slice(-Math.max(3, state.graphRange));
  }
  const labels = filtered.map(s => s.date);
  const totals = filtered.map(s => s.totalKRW);

  // 라인 차트
  const ctx1 = $('#chart-total').getContext('2d');
  if (state.charts.total) state.charts.total.destroy();
  state.charts.total = new Chart(ctx1, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: '총자산 (₩)',
        data: totals,
        borderColor: '#1F3A5F',
        backgroundColor: 'rgba(31,58,95,0.08)',
        borderWidth: 1.5,
        fill: true,
        tension: 0.25,
        pointRadius: 0,
        pointHoverRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (c) => fmtKRW(c.parsed.y),
          },
        },
      },
      scales: {
        x: { grid: { color: '#EAE5D8' }, ticks: { color: '#6f7480', font: { size: 10 } } },
        y: {
          grid: { color: '#EAE5D8' },
          ticks: {
            color: '#6f7480', font: { size: 10 },
            callback: (v) => fmtKRWShort(v),
          },
        },
      },
    },
  });

  // 스택 영역
  const ctx2 = $('#chart-stack').getContext('2d');
  if (state.charts.stack) state.charts.stack.destroy();
  const stackColors = {
    cash: '#a6aab2', savings: '#6f7480', deposit: '#2c4f7a',
    stock_kr: '#1F3A5F', stock_us: '#3E6B3E', crypto: '#D4A017', realestate: '#B83227',
  };
  const stackDatasets = TYPE_ORDER
    .filter(t => filtered.some(s => (s.breakdown?.[t] || 0) > 0))
    .map(t => ({
      label: TYPE_LABEL[t],
      data: filtered.map(s => s.breakdown?.[t] || 0),
      backgroundColor: stackColors[t] || '#a6aab2',
      borderWidth: 0,
      fill: true,
    }));
  state.charts.stack = new Chart(ctx2, {
    type: 'line',
    data: { labels, datasets: stackDatasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { position: 'bottom', labels: { font: { size: 11 }, boxWidth: 10 } } },
      scales: {
        x: { stacked: true, grid: { color: '#EAE5D8' }, ticks: { color: '#6f7480', font: { size: 10 } } },
        y: {
          stacked: true,
          grid: { color: '#EAE5D8' },
          ticks: { color: '#6f7480', font: { size: 10 }, callback: (v) => fmtKRWShort(v) },
        },
      },
      elements: { line: { tension: 0.2, borderWidth: 0 }, point: { radius: 0 } },
    },
  });

  // 통계
  const max = Math.max(...totals);
  const min = Math.min(...totals);
  const avg = totals.reduce((s, v) => s + v, 0) / totals.length;
  const variance = totals.reduce((s, v) => s + (v - avg) ** 2, 0) / totals.length;
  const stdev = Math.sqrt(variance);

  let cagrStr = '—';
  if (state.graphRange === 365 && totals.length >= 2 && totals[0] > 0) {
    const span = (new Date(labels[labels.length - 1]) - new Date(labels[0])) / 86400000;
    const years = span / 365;
    if (years > 0) {
      const cagr = (Math.pow(totals[totals.length - 1] / totals[0], 1 / years) - 1) * 100;
      cagrStr = fmtPct(cagr, 2);
    }
  }

  $('#graph-stats').innerHTML = `
    <div class="gs"><span class="lab">최고</span><span class="v">${fmtKRWShort(max)}</span></div>
    <div class="gs"><span class="lab">최저</span><span class="v">${fmtKRWShort(min)}</span></div>
    <div class="gs"><span class="lab">평균</span><span class="v">${fmtKRWShort(avg)}</span></div>
    <div class="gs"><span class="lab">${state.graphRange === 365 ? 'CAGR' : '변동성(σ)'}</span><span class="v">${state.graphRange === 365 ? cagrStr : fmtKRWShort(stdev)}</span></div>
  `;
}

// ---------- 스냅샷 ----------
async function takeSnapshot() {
  const breakdown = state.totalsByType || {};
  const total = state.totalKRW;
  if (!total) { alert('자산이 비어있습니다.'); return; }
  const quotesUsed = {};
  for (const a of state.accounts) {
    if (!a.ticker) continue;
    const q = state.quotes[a.ticker];
    if (q) quotesUsed[a.ticker] = q.priceKRW ?? q.price ?? null;
  }
  if (state.exchangeRate?.rate) quotesUsed['USDKRW'] = state.exchangeRate.rate;

  try {
    const r = await apiPost(API.snapshot, {
      date: todayKST(),
      totalKRW: total,
      breakdown,
      quotesUsed,
    });
    // 스냅샷 목록 갱신
    const snaps = await apiGet(API.snapshots).catch(() => ({ snapshots: [] }));
    state.snapshots = snaps.snapshots || [];
    const sorted = state.snapshots.slice().sort((a, b) => a.date < b.date ? -1 : 1);
    state.lastSnapshotTotal = sorted.length >= 2 ? sorted[sorted.length - 2].totalKRW : null;
    renderTotals();
    if (state.tab === 'graph') renderGraph();
    alert(`오늘 스냅샷 저장됨: ${fmtKRW(r.snapshot.totalKRW)}`);
  } catch (e) {
    alert('스냅샷 실패: ' + e.message);
  }
}

// ---------- 탭 ----------
function setupTabs() {
  $$('.tab').forEach(t => {
    t.addEventListener('click', () => {
      const name = t.getAttribute('data-tab');
      state.tab = name;
      $$('.tab').forEach(x => x.classList.toggle('active', x === t));
      $$('.panel').forEach(p => p.classList.add('hidden'));
      $('#panel-' + name).classList.remove('hidden');
      if (name === 'spend') renderSpend();
      if (name === 'graph') renderGraph();
    });
  });
  $('#snap-btn').addEventListener('click', takeSnapshot);
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (ch) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));
}

// ---------- CSV 가져오기 ----------
const csvState = {
  rows: [],          // parseCSV 결과
  headers: [],       // rows[0]
  dataStart: 1,      // 데이터 시작 행 인덱스
  mapping: null,     // { date, desc, amount, out, in }
  preset: null,      // CSV_PRESETS[key]
  presetKey: '',
};

function setupCsvImport() {
  const openBtn = document.getElementById('csv-open');
  const modal = document.getElementById('csv-modal');
  const closeBtn = document.getElementById('csv-close');
  const presetSel = document.getElementById('csv-preset');
  const fileInput = document.getElementById('csv-file');
  const passwordInput = document.getElementById('csv-password');
  const importBtn = document.getElementById('csv-import');
  const stage1 = document.getElementById('csv-stage-file');
  const stage2 = document.getElementById('csv-stage-preview');
  const err = document.getElementById('csv-err');

  // 프리셋 드롭다운 주입 — 마이데이터 통합 앱 그룹을 최상단에 배치.
  const aggOpts  = Object.entries(CSV_PRESETS).filter(([, v]) => v.kind === 'aggregator');
  const bankOpts = Object.entries(CSV_PRESETS).filter(([, v]) => v.kind === 'bank');
  const cardOpts = Object.entries(CSV_PRESETS).filter(([, v]) => v.kind === 'card');
  const optHtml = (opts) => opts.map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  presetSel.innerHTML = [
    '<option value="">기관을 선택하세요</option>',
    '<optgroup label="마이데이터 통합 (여러 카드·은행 일괄)">' + optHtml(aggOpts) + '</optgroup>',
    '<optgroup label="은행">' + optHtml(bankOpts) + '</optgroup>',
    '<optgroup label="카드">' + optHtml(cardOpts) + '</optgroup>',
  ].join('');

  const resetModal = () => {
    csvState.rows = [];
    csvState.headers = [];
    csvState.mapping = null;
    csvState.preset = null;
    csvState.presetKey = '';
    fileInput.value = '';
    presetSel.value = '';
    if (passwordInput) passwordInput.value = '';
    stage1.classList.remove('hidden');
    stage2.classList.add('hidden');
    err.textContent = '';
  };

  openBtn.addEventListener('click', () => {
    resetModal();
    modal.classList.remove('hidden');
  });
  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  // 파일 선택 처리 — 비밀번호 지원. 암호 파일이면 에러 후 비밀번호 입력 시 "비밀번호 변경" 이벤트로 자동 재시도.
  const doParseFile = async (file, preset, presetKey) => {
    const password = passwordInput?.value || '';
    try {
      // CSV/XLS/XLSX/PDF 공통 로더. preset.encoding 은 CSV 일 때만 의미.
      const rows = await readSheetFile(file, preset.encoding, password);
      if (rows.length < 2) throw new Error('빈 파일 또는 데이터 부족');

      // 헤더 자동 탐지 — 행 중에서 HEADER_HINTS 스코어 합이 가장 높은 행
      let bestRow = 0, bestScore = -1;
      for (let i = 0; i < Math.min(rows.length, 15); i++) {
        const r = rows[i];
        let s = 0;
        for (const cell of r) {
          for (const kind of Object.keys(HEADER_HINTS)) s += scoreHeader(cell, kind);
        }
        if (s > bestScore) { bestScore = s; bestRow = i; }
      }
      csvState.rows = rows;
      csvState.headers = rows[bestRow];
      csvState.dataStart = bestRow + 1;
      csvState.mapping = autoMapColumns(csvState.headers);
      csvState.preset = preset;
      csvState.presetKey = presetKey;

      renderCsvPreview();
      stage1.classList.add('hidden');
      stage2.classList.remove('hidden');
      return true;
    } catch (ex) {
      err.textContent = ex.message;
      if (ex.needsPassword && passwordInput) {
        passwordInput.focus();
      } else {
        fileInput.value = '';
      }
      return false;
    }
  };

  fileInput.addEventListener('change', async (e) => {
    err.textContent = '';
    const file = e.target.files[0];
    if (!file) return;
    const presetKey = presetSel.value;
    if (!presetKey) { err.textContent = '먼저 기관을 선택하세요.'; fileInput.value = ''; return; }
    const preset = CSV_PRESETS[presetKey];
    await doParseFile(file, preset, presetKey);
  });

  // 비밀번호 입력/수정 시 자동 재시도 (파일이 이미 선택된 경우).
  if (passwordInput) {
    let debounce;
    passwordInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const file = fileInput.files[0];
        if (!file) return;
        const presetKey = presetSel.value;
        if (!presetKey) return;
        err.textContent = '';
        await doParseFile(file, CSV_PRESETS[presetKey], presetKey);
      }, 400);
    });
  }

  // 매핑 재지정 — 셀렉트 변경 시
  stage2.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-map]');
    if (!sel) return;
    const field = sel.getAttribute('data-map');
    const idx = Number(sel.value);
    csvState.mapping[field] = isFinite(idx) ? idx : -1;
    renderCsvPreview();
  });

  importBtn.addEventListener('click', async () => {
    const countEl = document.getElementById('csv-count');
    try {
      const txs = buildTransactionsFromCsv();
      if (!txs.length) throw new Error('불러올 거래가 없습니다.');
      importBtn.disabled = true;
      importBtn.textContent = '불러오는 중…';
      const r = await apiPost(API.tx, { op: 'bulk_create', transactions: txs });
      state.transactions = r.transactions || [];
      modal.classList.add('hidden');
      alert(`${r.added}건 추가 · ${r.skipped}건 중복 스킵.`);
      renderSpend();
    } catch (ex) {
      if (countEl) countEl.innerHTML = `<span style="color:var(--cinnabar)">오류: ${esc(ex.message)}</span>`;
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = '이 내용으로 불러오기';
    }
  });
}

function renderCsvPreview() {
  const headers = csvState.headers;
  const dataRows = csvState.rows.slice(csvState.dataStart, csvState.dataStart + 10);
  const m = csvState.mapping;

  // 매핑 셀렉트
  //   파일의 어떤 컬럼을 거래의 어떤 필드로 쓸지 선택.
  //   보통 자동 감지가 정확하므로 아래 안내 + 기본값만 확인하면 됨.
  const mapBox = document.getElementById('csv-mapping');
  const options = ['<option value="-1">— 없음 —</option>']
    .concat(headers.map((h, i) => `<option value="${i}">${i + 1}. ${esc(String(h || '').slice(0, 30))}</option>`));
  const withSelected = (key) => options
    .map(o => o.replace(`value="${m[key]}"`, `value="${m[key]}" selected`))
    .join('');
  mapBox.innerHTML = `
    <div class="cmap-help">
      📌 <b>파일의 어떤 열을 거래의 어떤 정보로 사용할지 지정합니다.</b>
      자동으로 잘 맞춰졌다면 그대로 두고, 잘못 잡혔을 때만 바꾸세요.
      금액이 <em>한 열</em>(음수=지출, 양수=수입)이면 <b>"금액"</b>만, <em>두 열</em>(출금/입금 분리)이면 <b>"출금"·"입금"</b>만 선택.
    </div>
    <div class="cmap" title="거래 발생일 컬럼">
      <label>📅 날짜</label>
      <select data-map="date">${withSelected('date')}</select>
    </div>
    <div class="cmap" title="가맹점명 / 거래 적요 컬럼">
      <label>📝 내용 (가맹점·적요)</label>
      <select data-map="desc">${withSelected('desc')}</select>
    </div>
    <div class="cmap" title="한 열에 +/- 로 지출·수입이 모두 들어있을 때 선택">
      <label>💰 금액 <span class="cmap-sub">(한 열에 +/- 표기)</span></label>
      <select data-map="amount">${withSelected('amount')}</select>
    </div>
    <div class="cmap" title="출금 전용 컬럼 (은행 거래내역처럼 출금·입금이 분리된 경우)">
      <label>➖ 출금 <span class="cmap-sub">(분리된 경우)</span></label>
      <select data-map="out">${withSelected('out')}</select>
    </div>
    <div class="cmap" title="입금 전용 컬럼">
      <label>➕ 입금 <span class="cmap-sub">(분리된 경우)</span></label>
      <select data-map="in">${withSelected('in')}</select>
    </div>
    <div class="cmap" title="거래 유형(지출/수입/이체)이 기록된 컬럼 — 마이데이터 앱 대부분 제공">
      <label>🏷️ 타입 <span class="cmap-sub">(지출/수입/이체)</span></label>
      <select data-map="txType">${withSelected('txType')}</select>
    </div>
    <div class="cmap" title="대분류(식사/교통/카페간식 등) 컬럼 — 있으면 자동 카테고리 분류">
      <label>🗂️ 대분류 <span class="cmap-sub">(자동 카테고리)</span></label>
      <select data-map="category">${withSelected('category')}</select>
    </div>
  `;

  // 미리보기 테이블
  const table = document.getElementById('csv-preview');
  const hdrRow = headers.map((h, i) => {
    const tags = [];
    if (i === m.date) tags.push('<span class="ctag ct-date">날짜</span>');
    if (i === m.desc) tags.push('<span class="ctag ct-desc">내용</span>');
    if (i === m.amount) tags.push('<span class="ctag ct-amt">금액</span>');
    if (i === m.out) tags.push('<span class="ctag ct-out">출금</span>');
    if (i === m.in) tags.push('<span class="ctag ct-in">입금</span>');
    return `<th>${esc(String(h || ''))}${tags.join(' ')}</th>`;
  }).join('');
  const bodyRows = dataRows.map(r =>
    '<tr>' + headers.map((_, i) => `<td>${esc(String(r[i] ?? '').slice(0, 60))}</td>`).join('') + '</tr>'
  ).join('');
  table.innerHTML = `<thead><tr>${hdrRow}</tr></thead><tbody>${bodyRows}</tbody>`;

  // 요약
  try {
    const preview = buildTransactionsFromCsv();
    document.getElementById('csv-count').textContent =
      `${preview.length}건 준비 · 기관: ${csvState.preset.label} · 기본 카테고리: ${CAT_LABEL[csvState.preset.defaultCat]}`;
  } catch (ex) {
    document.getElementById('csv-count').textContent = '매핑 확인 중: ' + ex.message;
  }
}

function buildTransactionsFromCsv() {
  const m = csvState.mapping;
  if (!m) throw new Error('파일을 먼저 선택하세요.');
  if (m.date < 0) throw new Error('날짜 열을 선택해 주세요.');
  if (m.amount < 0 && m.out < 0 && m.in < 0) throw new Error('금액 열(또는 출금/입금)을 선택해 주세요.');

  const preset = csvState.preset;
  const out = [];
  const rawRows = csvState.rows.slice(csvState.dataStart);
  for (let i = 0; i < rawRows.length; i++) {
    const r = rawRows[i];
    const dateStr = parseDateString(r[m.date]);
    if (!dateStr) continue;

    // 금액 및 유형 판정
    let amt, type;
    if (m.out >= 0 || m.in >= 0) {
      const outAmt = parseAmountString(r[m.out]) || 0;
      const inAmt  = parseAmountString(r[m.in])  || 0;
      if (outAmt > 0 && inAmt === 0) { amt = outAmt; type = 'expense'; }
      else if (inAmt > 0 && outAmt === 0) { amt = inAmt; type = 'income'; }
      else if (outAmt > 0) { amt = outAmt; type = 'expense'; }
      else if (inAmt > 0) { amt = inAmt; type = 'income'; }
      else continue;
    } else {
      const raw = parseAmountString(r[m.amount]);
      if (!isFinite(raw) || raw === 0) continue;
      amt = Math.abs(raw);
      // 카드 CSV / 마이데이터 통합 앱: 이용금액이 부호 없이 양수로 오므로 지출로 판정.
      //   다만 수입 키워드(급여/환불/이자/입금 등)가 descr 에 있으면 수입으로 재분류.
      // 은행 단일 금액 열이면 음수=출금, 양수=입금.
      const rawDesc = m.desc >= 0 ? String(r[m.desc] || '') : '';
      if (preset.kind === 'card' || preset.kind === 'aggregator') {
        type = 'expense';
        if (preset.kind === 'aggregator' && /급여|환불|이자|배당|입금|수입|이체\s*(받|입)|refund|salary/i.test(rawDesc)) {
          type = 'income';
        }
        if (raw < 0) type = 'income'; // 마이데이터 일부 앱은 지출은 양수 저장이지만 수입을 음수로 표기
      } else {
        type = raw < 0 ? 'expense' : 'income';
      }
    }

    const desc = m.desc >= 0 ? String(r[m.desc] || '').trim() : '';
    const label = (desc || preset.label).slice(0, 100) || preset.label;

    // "타입" 컬럼이 있으면 그 값을 우선 적용 (지출/이체/수입 등).
    if (m.txType >= 0) {
      const t = normalizeTxTypeCell(r[m.txType]);
      if (t) type = t;
    }

    // "대분류(카테고리)" 컬럼이 있으면 그 값으로 카테고리 자동 분류.
    let category;
    if (m.category >= 0) {
      const cat = normalizeCategoryCell(r[m.category]);
      if (cat) category = cat;
    }

    // 내 계좌 간 이체면 수입·지출이 아닌 'transfer' 로 재분류.
    if (isLikelyTransfer(desc)) type = 'transfer';

    // 카테고리 최종 결정: 대분류 매핑 > 타입별 기본값.
    if (!category) {
      category = type === 'transfer'
        ? 'transfer'
        : (type === 'expense' ? preset.defaultCat : 'other');
    }
    // 이체 카테고리 분기:
    //   - 증권사·거래소로 가는 이체 → 'cash' (투자용 현금 이동)
    //   - 그 외 내 계좌 간 이체 → 'transfer'
    if (type === 'transfer') {
      category = isBrokerageTransfer(desc) ? 'cash' : 'transfer';
    }

    const dedupeKey = `${preset.kind}:${csvState.presetKey}:${dateStr}:${amt}:${desc.slice(0, 60)}`;
    const id = 'tx-' + dateStr.replace(/-/g, '') + '-' + shortHash(dedupeKey);

    out.push({
      id,
      date: dateStr,
      type,
      category,
      amountKRW: Math.round(amt),
      label,
      recurring: null,
      source: csvState.presetKey,
      dedupeKey,
    });
  }
  return out;
}

// 내 계좌끼리의 이체 감지용 키워드 목록.
//   - 사용자가 등록한 state.accounts 의 institution / label / product
//   - 하드코딩된 은행·증권사·페이 단어 (별도 등록 전에도 보편적으로 잡히도록)
//   - 선택적으로 사용자 실명 (PII — 별도 필드에 등록된 경우만)
function myTransferKeywords() {
  const set = new Set();
  const add = (s) => {
    if (!s) return;
    const clean = String(s).trim();
    if (clean.length >= 2 && clean.length <= 20) set.add(clean);
  };
  for (const a of state.accounts || []) {
    add(a.institution);
    add(a.label);
    add(a.product);
    if (a.ticker && ['stock_kr','stock_us','crypto'].includes(a.type)) add(a.institution);
  }
  // 보편적인 은행·카드·페이 이름 — 등록 전이어도 이체로 잡히도록.
  const builtins = [
    '카카오뱅크','토스뱅크','신한','국민','KB','하나','우리','농협','NH','SC','씨티','IBK','기업',
    '새마을','신협','우체국','수협','부산','대구','광주','전북','경남','제주','웰컴','OK저축','SBI',
    '토스증권','삼성증권','신한투자','미래에셋','한국투자','KB증권','NH투자','키움',
    '카카오페이','토스페이','네이버페이','페이코','삼성페이',
    '업비트','빗썸','코인원','코빗','바이낸스',
  ];
  for (const b of builtins) set.add(b);
  return [...set];
}

// 거래 설명(적요)이 내 계좌 간 이체로 보이는지 판정.
function isLikelyTransfer(desc) {
  const s = String(desc || '').trim();
  if (!s) return false;
  // 증권·거래소 키워드가 있으면 '이체' 단어 없어도 이체로 판정 (예: "토스증권권기웅").
  if (isBrokerageTransfer(s)) return true;
  // 일반 은행 이체는 "이체/송금/transfer" 단어 + 내 계좌 키워드 모두 필요.
  if (!/이체|송금|transfer/i.test(s)) return false;
  const keywords = myTransferKeywords();
  for (const k of keywords) {
    if (s.includes(k)) return true;
  }
  return false;
}

// 증권사/암호화폐 거래소로 들어가는 이체 판정 (→ 카테고리를 'cash' 로 분류).
const BROKERAGE_KEYWORDS = [
  '토스증권','삼성증권','신한투자','미래에셋','한국투자','KB증권','NH투자','키움증권','한투',
  '업비트','빗썸','코인원','코빗','바이낸스','코인베이스','크라켄','OKX','바이비트',
];
function isBrokerageTransfer(desc) {
  const s = String(desc || '');
  for (const k of BROKERAGE_KEYWORDS) {
    if (s.includes(k)) return true;
  }
  return false;
}

// 짧은 해시 (djb2 변형) — 서버 id 정규식에 맞는 영숫자만 생성
function shortHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36).slice(0, 10);
}

// ---------- 자산 CSV/XLS/PDF 가져오기 ----------
const assetState = {
  rows: [],
  headers: [],
  dataStart: 1,
  mapping: null,     // kind 별 필드맵
  preset: null,
  presetKey: '',
  fileName: '',
  pdfAccounts: null, // PDF 모드 시 서버가 파싱해 돌려준 계좌 배열
  pdfMeta: null,
};

function setupAssetImport() {
  const openBtn = document.getElementById('asset-import-open');
  const modal = document.getElementById('asset-modal');
  const closeBtn = document.getElementById('asset-close');
  const presetSel = document.getElementById('asset-preset');
  const fileInput = document.getElementById('asset-file');
  const passwordInput = document.getElementById('asset-password');
  const importBtn = document.getElementById('asset-import');
  const stage1 = document.getElementById('asset-stage-file');
  const stage2 = document.getElementById('asset-stage-preview');
  const err = document.getElementById('asset-err');

  // 프리셋 드롭다운 주입 — 4개 그룹
  const groups = [
    ['국내 주식 (증권사)', 'stocks_kr'],
    ['해외 주식 (증권사)', 'stocks_us'],
    ['암호화폐 (거래소)',  'crypto'],
    ['은행 계좌 잔액',      'bank'],
  ];
  presetSel.innerHTML = [
    '<option value="">기관을 선택하세요</option>',
    ...groups.map(([title, kind]) => {
      const opts = Object.entries(ASSET_PRESETS)
        .filter(([, v]) => v.kind === kind)
        .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
        .join('');
      return `<optgroup label="${title}">${opts}</optgroup>`;
    }),
  ].join('');

  const resetModal = () => {
    assetState.rows = [];
    assetState.headers = [];
    assetState.mapping = null;
    assetState.preset = null;
    assetState.presetKey = '';
    assetState.fileName = '';
    assetState.pdfAccounts = null;
    assetState.pdfMeta = null;
    fileInput.value = '';
    presetSel.value = '';
    if (passwordInput) passwordInput.value = '';
    stage1.classList.remove('hidden');
    stage2.classList.add('hidden');
    err.textContent = '';
  };

  openBtn.addEventListener('click', () => { resetModal(); modal.classList.remove('hidden'); });
  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  // 시트 파일 파싱 (비밀번호 지원). 성공 시 true.
  const doParseAsset = async (file, preset) => {
    const password = passwordInput?.value || '';
    try {
      const rows = await readSheetFile(file, preset.encoding, password);
      if (rows.length < 2) throw new Error('빈 시트 또는 데이터 부족');
      return rows;
    } catch (ex) {
      err.textContent = ex.message;
      if (ex.needsPassword && passwordInput) passwordInput.focus();
      else fileInput.value = '';
      return null;
    }
  };

  fileInput.addEventListener('change', async (e) => {
    err.textContent = '';
    const file = e.target.files[0];
    if (!file) return;
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';

    // PDF: 서버가 포맷 자동 감지·파싱. 기관 선택 불필요.
    if (isPdf) {
      try {
        await loadPdfImport(file, passwordInput?.value || '');
        stage1.classList.add('hidden');
        stage2.classList.remove('hidden');
      } catch (ex) {
        err.textContent = ex.message;
        if (ex.needsPassword && passwordInput) passwordInput.focus();
        else fileInput.value = '';
      }
      return;
    }

    const presetKey = presetSel.value;
    if (!presetKey) { err.textContent = '먼저 기관을 선택하세요 (PDF 는 선택 불필요).'; fileInput.value = ''; return; }
    const preset = ASSET_PRESETS[presetKey];
    try {
      const rows = await doParseAsset(file, preset);
      if (!rows) return;

      // 헤더 자동 탐지 — kind 힌트 기준 최고점 행
      const hintKind = preset.kind === 'stocks_kr' || preset.kind === 'stocks_us' ? 'stocks' : preset.kind;
      const fields = Object.keys(ASSET_HEADER_HINTS[hintKind] || {});
      let bestRow = 0, bestScore = -1;
      for (let i = 0; i < Math.min(rows.length, 20); i++) {
        let s = 0;
        for (const cell of rows[i]) {
          for (const f of fields) s += scoreAssetHeader(cell, hintKind, f);
        }
        if (s > bestScore) { bestScore = s; bestRow = i; }
      }
      assetState.rows = rows;
      assetState.headers = rows[bestRow];
      assetState.dataStart = bestRow + 1;
      assetState.mapping = autoMapAssetColumns(assetState.headers, preset.kind);
      assetState.preset = preset;
      assetState.presetKey = presetKey;
      assetState.fileName = file.name;

      renderAssetPreview();
      stage1.classList.add('hidden');
      stage2.classList.remove('hidden');
    } catch (ex) {
      err.textContent = '파일을 읽는 중 오류: ' + ex.message;
      fileInput.value = '';
    }
  });

  // 비밀번호 입력/수정 시 자동 재시도 (파일이 이미 선택된 경우).
  if (passwordInput) {
    let debounce;
    passwordInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const file = fileInput.files[0];
        if (!file) return;
        err.textContent = '';
        const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
        if (isPdf) {
          try {
            await loadPdfImport(file, passwordInput.value || '');
            stage1.classList.add('hidden');
            stage2.classList.remove('hidden');
          } catch (ex) {
            err.textContent = ex.message;
          }
          return;
        }
        const presetKey = presetSel.value;
        if (!presetKey) return;
        const preset = ASSET_PRESETS[presetKey];
        // 파일 change 이벤트와 동일 경로를 타도록 input change 한번 발화시키는 대신 직접 호출.
        fileInput.dispatchEvent(new Event('change'));
      }, 400);
    });
  }

  stage2.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-amap]');
    if (!sel) return;
    const field = sel.getAttribute('data-amap');
    const idx = Number(sel.value);
    assetState.mapping[field] = isFinite(idx) ? idx : -1;
    renderAssetPreview();
  });

  importBtn.addEventListener('click', async () => {
    const countEl = document.getElementById('asset-count');
    try {
      const accounts = assetState.pdfAccounts
        ? assetState.pdfAccounts
        : buildAccountsFromCsv();
      if (!accounts.length) throw new Error('불러올 계좌가 없습니다.');
      importBtn.disabled = true;
      importBtn.textContent = '불러오는 중…';
      const r = await apiPost(API.accounts, { op: 'bulk_create', accounts });
      state.accounts = r.accounts || [];
      modal.classList.add('hidden');
      alert(`${r.added}건 추가 · ${r.skipped}건 중복 스킵.`);
      renderAssets();
      renderTotals();
      renderDashboard();
      refreshQuotes();
    } catch (ex) {
      if (countEl) countEl.innerHTML = `<span style="color:var(--cinnabar)">오류: ${esc(ex.message)}</span>`;
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = '이 내용으로 불러오기';
    }
  });
}

// PDF 를 서버로 업로드해 파싱. password 가 필요한 PDF 면 헤더로 전달.
// 성공 시 assetState.pdfAccounts 채우고 미리보기 렌더.
async function loadPdfImport(file, password) {
  const buf = await file.arrayBuffer();
  const headers = { 'Content-Type': 'application/pdf' };
  if (password) headers['X-Pdf-Password'] = password;
  const r = await fetch('/api/import-pdf', {
    method: 'POST',
    headers,
    body: buf,
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) {
    const msg = j.error || 'PDF 파싱 실패';
    const err = new Error(msg);
    if (j.hint === 'password_required' || /password|비밀번호/i.test(msg)) err.needsPassword = true;
    throw err;
  }
  assetState.pdfAccounts = j.accounts || [];
  assetState.pdfMeta = { format: j.format, meta: j.meta || {}, warnings: j.warnings || [] };
  assetState.fileName = file.name;
  renderPdfPreview();
}

function renderPdfPreview() {
  const accs = assetState.pdfAccounts || [];
  const meta = assetState.pdfMeta || {};
  const mapBox = document.getElementById('asset-mapping');
  const table = document.getElementById('asset-preview');
  const countEl = document.getElementById('asset-count');

  const fmtLabel = {
    toss_balance_cert: '토스증권 잔고증명서',
    shinhan_stock_balance: '신한투자증권 주식잔고',
    shinhan_financial_product: '신한투자증권 금융상품',
  }[meta.format] || meta.format || 'PDF';

  const metaBits = [];
  if (meta.meta?.accountNo)  metaBits.push(`계좌 ${esc(meta.meta.accountNo)}`);
  if (meta.meta?.baseDate)   metaBits.push(`기준일 ${esc(meta.meta.baseDate)}`);
  if (meta.meta?.fxRate)     metaBits.push(`환율 $1 = ₩${meta.meta.fxRate.toLocaleString('ko-KR')}`);
  if (meta.meta?.cashKRW)    metaBits.push(`현금 ₩${meta.meta.cashKRW.toLocaleString('ko-KR')}`);

  mapBox.innerHTML = `
    <div style="padding:8px 0">
      <strong>${esc(fmtLabel)}</strong>
      <span style="color:var(--muted);margin-left:8px">${metaBits.join(' · ')}</span>
      ${(meta.warnings || []).length ? `<div style="color:var(--cinnabar);margin-top:4px">⚠ ${meta.warnings.map(esc).join(' · ')}</div>` : ''}
    </div>
  `;

  // 각 계좌의 보유종목을 하나의 테이블로 펼쳐 보여줌.
  const rows = [];
  for (const a of accs) {
    if (a.cashKRW) {
      rows.push(`<tr><td>${esc(a.label)}</td><td>현금</td><td>—</td><td>—</td><td>₩${a.cashKRW.toLocaleString('ko-KR')}</td></tr>`);
    }
    for (const h of a.holdings || []) {
      const q = Number(h.quantity).toLocaleString('ko-KR', { maximumFractionDigits: 8 });
      rows.push(`<tr><td>${esc(a.label)}</td><td>${esc(h.assetType)}</td><td>${esc(h.ticker)}</td><td>${esc(h.label || '')}</td><td>${q}</td></tr>`);
    }
    if (a.amountKRW) {
      rows.push(`<tr><td>${esc(a.label)}</td><td>${esc(a.type)}</td><td>—</td><td>—</td><td>₩${a.amountKRW.toLocaleString('ko-KR')}</td></tr>`);
    }
  }
  table.innerHTML = `
    <thead><tr>
      <th>계좌</th><th>자산유형</th><th>티커</th><th>이름</th><th>수량/금액</th>
    </tr></thead>
    <tbody>${rows.join('') || '<tr><td colspan="5" style="color:var(--muted)">보유 종목이 없습니다.</td></tr>'}</tbody>
  `;

  const totalHoldings = accs.reduce((s, a) => s + (a.holdings?.length || 0), 0);
  countEl.textContent = `${accs.length}개 계좌 · ${totalHoldings}개 종목 준비 · ${esc(assetState.fileName || '')}`;
}

function renderAssetPreview() {
  const headers = assetState.headers;
  const dataRows = assetState.rows.slice(assetState.dataStart, assetState.dataStart + 10);
  const m = assetState.mapping;
  const kind = assetState.preset.kind;

  // kind 별 필드 라벨
  const fieldLabels = {
    stocks_kr: { ticker:'종목코드', name:'종목명', quantity:'수량', avgCost:'평균단가' },
    stocks_us: { ticker:'티커', name:'종목명', quantity:'수량', avgCost:'평균단가(USD)' },
    crypto:    { ticker:'코인심볼', quantity:'보유수량', avgCost:'매수평균가' },
    bank:      { label:'상품/계좌명', balance:'잔액', rate:'금리(%)', maturity:'만기일', product:'상품종류' },
  };
  const labels = fieldLabels[kind] || {};
  const fields = Object.keys(labels);

  const options = ['<option value="-1">— 없음 —</option>']
    .concat(headers.map((h, i) => `<option value="${i}">${i + 1}. ${esc(String(h || '').slice(0, 30))}</option>`));

  const mapBox = document.getElementById('asset-mapping');
  mapBox.innerHTML = fields.map((f) => `
    <div class="cmap">
      <label>${labels[f]}</label>
      <select data-amap="${f}">${options.map(o => o.replace(`value="${m[f]}"`, `value="${m[f]}" selected`)).join('')}</select>
    </div>
  `).join('');

  const tagMap = {
    ticker:'ct-desc', name:'ct-desc', quantity:'ct-amt', avgCost:'ct-amt',
    label:'ct-desc', balance:'ct-amt', rate:'ct-date', maturity:'ct-date', product:'ct-out',
  };
  const table = document.getElementById('asset-preview');
  const hdrRow = headers.map((h, i) => {
    const tags = [];
    for (const f of fields) {
      if (i === m[f]) tags.push(`<span class="ctag ${tagMap[f] || 'ct-desc'}">${labels[f]}</span>`);
    }
    return `<th>${esc(String(h || ''))}${tags.join(' ')}</th>`;
  }).join('');
  const bodyRows = dataRows.map(r =>
    '<tr>' + headers.map((_, i) => `<td>${esc(String(r[i] ?? '').slice(0, 60))}</td>`).join('') + '</tr>'
  ).join('');
  table.innerHTML = `<thead><tr>${hdrRow}</tr></thead><tbody>${bodyRows}</tbody>`;

  try {
    const preview = buildAccountsFromCsv();
    document.getElementById('asset-count').textContent =
      `${preview.length}건 준비 · 기관: ${assetState.preset.label}`;
  } catch (ex) {
    document.getElementById('asset-count').textContent = '매핑 확인 중: ' + ex.message;
  }
}

const ASSET_KIND_TO_TYPE = {
  stocks_kr: 'stock_kr',
  stocks_us: 'stock_us',
  crypto:    'crypto',
  bank:      'savings', // 상품 문자열로 deposit 승격 가능
};

function buildAccountsFromCsv() {
  const m = assetState.mapping;
  const preset = assetState.preset;
  if (!m || !preset) throw new Error('파일을 먼저 선택하세요.');

  const rawRows = assetState.rows.slice(assetState.dataStart);
  const out = [];
  const seenKeys = new Set();

  if (preset.kind === 'stocks_kr' || preset.kind === 'stocks_us') {
    if (m.quantity < 0) throw new Error('수량 열을 선택해 주세요.');
    if (m.ticker < 0 && m.name < 0) throw new Error('종목코드 또는 종목명 열을 선택해 주세요.');
  } else if (preset.kind === 'crypto') {
    if (m.ticker < 0) throw new Error('코인심볼 열을 선택해 주세요.');
    if (m.quantity < 0) throw new Error('보유수량 열을 선택해 주세요.');
  } else if (preset.kind === 'bank') {
    if (m.label < 0) throw new Error('상품/계좌명 열을 선택해 주세요.');
    if (m.balance < 0) throw new Error('잔액 열을 선택해 주세요.');
  }

  for (let i = 0; i < rawRows.length; i++) {
    const r = rawRows[i];
    let acc = null;

    if (preset.kind === 'stocks_kr' || preset.kind === 'stocks_us') {
      let ticker = m.ticker >= 0 ? String(r[m.ticker] ?? '').trim() : '';
      const name = m.name >= 0 ? String(r[m.name] ?? '').trim() : '';
      const qty = parseAmountString(m.quantity >= 0 ? r[m.quantity] : '');
      const avg = parseAmountString(m.avgCost >= 0 ? r[m.avgCost] : '');

      if (preset.kind === 'stocks_kr') {
        // 6자리 숫자 코드 추출
        const rawPool = `${ticker} ${name}`;
        const hit = rawPool.match(/\b\d{6}\b/);
        ticker = hit ? hit[0] : ticker.replace(/\D/g, '');
        if (!/^\d{6}$/.test(ticker)) continue;
      } else {
        ticker = ticker.toUpperCase().replace(/[^A-Z.\-]/g, '');
        if (!ticker || ticker.length > 10) continue;
      }
      if (!isFinite(qty) || qty <= 0) continue;

      const type = ASSET_KIND_TO_TYPE[preset.kind];
      const label = (name || ticker).slice(0, 80);
      const dedupeKey = `asset:${type}:${ticker}:${preset.institution}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      acc = {
        id: `acc-${type}-${shortHash(dedupeKey)}`,
        type, label, ticker,
        quantity: qty,
        avgCost: isFinite(avg) && avg > 0 ? avg : 0,
        institution: preset.institution,
        currency: preset.kind === 'stocks_us' ? 'USD' : 'KRW',
        source: assetState.presetKey,
        dedupeKey,
      };
    } else if (preset.kind === 'crypto') {
      let sym = String(r[m.ticker] ?? '').trim().toUpperCase();
      // KRW-BTC, BTC/KRW, BTC-USD 같은 표기 정규화
      sym = sym.replace(/^(KRW|USDT|USD)[-_/ ]+/, '').replace(/[-_/ ]+(KRW|USDT|USD)$/, '');
      sym = sym.replace(/[^A-Z0-9]/g, '');
      if (!sym || ['KRW','USD','USDT','TOTAL','합계','원화'].includes(sym)) continue;

      const qty = parseAmountString(r[m.quantity]);
      const avg = m.avgCost >= 0 ? parseAmountString(r[m.avgCost]) : NaN;
      if (!isFinite(qty) || qty <= 0) continue;

      const ticker = preset.currency === 'USD' ? `${sym}-USD` : `KRW-${sym}`;
      const dedupeKey = `asset:crypto:${ticker}:${preset.institution}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      acc = {
        id: `acc-crypto-${shortHash(dedupeKey)}`,
        type: 'crypto',
        label: sym.slice(0, 20),
        ticker,
        quantity: qty,
        avgCost: isFinite(avg) && avg > 0 ? avg : 0,
        institution: preset.institution,
        currency: preset.currency,
        source: assetState.presetKey,
        dedupeKey,
      };
    } else if (preset.kind === 'bank') {
      const label = String(r[m.label] ?? '').trim();
      const bal = parseAmountString(r[m.balance]);
      if (!label || !isFinite(bal)) continue;

      const rate = m.rate >= 0 ? parseAmountString(r[m.rate]) : NaN;
      const mat = m.maturity >= 0 ? parseDateString(r[m.maturity]) : null;
      const prodText = m.product >= 0 ? String(r[m.product] ?? '') : '';
      const pool = `${prodText} ${label}`;

      let type = 'savings', product = '수시입출';
      if (/정기예금|예금/i.test(pool)) { type = 'deposit'; product = '예금'; }
      else if (/적금/i.test(pool))      { type = 'deposit'; product = '적금'; }
      else if (/파킹|세이프박스|모으기/i.test(pool)) { product = '파킹통장'; }
      else if (/CMA/i.test(pool))       { product = 'CMA'; }
      else if (/대출|loan/i.test(pool)) { product = '대출'; }

      const dedupeKey = `asset:bank:${preset.institution}:${label}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);
      acc = {
        id: `acc-${type}-${shortHash(dedupeKey)}`,
        type,
        label: label.slice(0, 80),
        amountKRW: Math.round(bal),
        institution: preset.institution,
        product,
        source: assetState.presetKey,
        dedupeKey,
      };
      if (isFinite(rate) && rate > 0 && rate < 100) acc.interestRate = rate;
      if (mat) acc.maturityDate = mat;
    }

    if (acc) out.push(acc);
  }
  return out;
}

// ---------- 폴링 스케줄 ----------
function schedulePolling() {
  const tick = async () => {
    await refreshQuotes();
  };
  tick();
  setInterval(tick, 15_000);
}

// ---------- 진입 ----------
// ============================================================================
// 기기 간 동기화 (Telegram 봇 기반)
// ----------------------------------------------------------------------------
// 1) 페어링: 사용자가 텔레그램에서 봇 시작 → 서버가 chatId 확인 → cred 발급 → localStorage
// 2) 백업: localStorage 전체 → POST /api/sync/push (Bearer cred) → 서버가 텔레그램 채팅에 JSON 핀
// 3) 복원: POST /api/sync/pull → 서버가 핀된 메시지 다운로드 → 클라가 localStorage 덮어쓰기
// ============================================================================

const SYNC_LS_CRED = 'seed:sync:cred';
const SYNC_LS_META = 'seed:sync:meta';   // { chatId, userName, lastPushAt, lastPushBytes }
const SYNC_DEBOUNCE_MS = 6000;

const syncState = {
  enabled: false,
  bot: null,
  pairCode: null,
  pairExpiresAt: 0,
  pairTimer: null,
  pairCheckTimer: null,
  confirmTimer: null,
  pushDebounce: null,
  pushing: false,
  pulling: false,
};

function syncReadCred() {
  try { return localStorage.getItem(SYNC_LS_CRED) || null; } catch { return null; }
}
function syncWriteCred(cred) {
  try { if (cred) localStorage.setItem(SYNC_LS_CRED, cred); else localStorage.removeItem(SYNC_LS_CRED); } catch {}
}
function syncReadMeta() {
  try { return JSON.parse(localStorage.getItem(SYNC_LS_META) || '{}'); } catch { return {}; }
}
function syncWriteMeta(m) {
  try { localStorage.setItem(SYNC_LS_META, JSON.stringify(m || {})); } catch {}
}

function snapshotForSync() {
  // 사용자별 데이터 전체 (localStorage 의 seed:* 키들). 시세/봇 cred 는 제외.
  const out = {};
  for (const k of Object.keys(LS_KEYS)) {
    const lsKey = LS_KEYS[k];
    try {
      const raw = localStorage.getItem(lsKey);
      if (raw != null) out[lsKey] = JSON.parse(raw);
    } catch {}
  }
  return out;
}

function restoreFromSyncPayload(payload) {
  if (!payload || typeof payload !== 'object') throw new Error('invalid payload');
  const known = new Set(Object.values(LS_KEYS));
  let n = 0;
  for (const [key, value] of Object.entries(payload)) {
    if (!known.has(key)) continue;   // 알 수 없는 키는 무시 (보안)
    try {
      localStorage.setItem(key, JSON.stringify(value));
      n++;
    } catch {}
  }
  return n;
}

async function syncFetchStatus() {
  try {
    const r = await fetch('/api/sync/status');
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function syncInitPair() {
  const r = await fetch('/api/sync/init', { method: 'POST' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error || `init failed (${r.status})`);
  return j;
}

async function syncCheckPair(code) {
  const r = await fetch('/api/sync/check?code=' + encodeURIComponent(code));
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 404) throw new Error(j.error || `check failed (${r.status})`);
  return { status: r.status, ...j };
}

async function syncConfirmPair(code, confirm) {
  const r = await fetch('/api/sync/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, confirm }),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

async function syncPushNow() {
  const cred = syncReadCred();
  if (!cred) throw new Error('not paired');
  if (syncState.pushing) return null;
  syncState.pushing = true;
  updateSyncBtn();
  try {
    const snap = snapshotForSync();
    const r = await fetch('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cred },
      body: JSON.stringify(snap),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      if (r.status === 401) syncWriteCred(null);
      throw new Error(j.error || `push failed (${r.status})`);
    }
    const meta = syncReadMeta();
    meta.lastPushAt = j.savedAt;
    meta.lastPushBytes = j.bytes;
    syncWriteMeta(meta);
    return j;
  } finally {
    syncState.pushing = false;
    updateSyncBtn();
  }
}

async function syncPullNow() {
  const cred = syncReadCred();
  if (!cred) throw new Error('not paired');
  if (syncState.pulling) return null;
  syncState.pulling = true;
  updateSyncBtn();
  try {
    const r = await fetch('/api/sync/pull', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + cred },
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      if (r.status === 401) syncWriteCred(null);
      throw new Error(j.error || `pull failed (${r.status})`);
    }
    const n = restoreFromSyncPayload(j.payload);
    return { ...j, restoredKeys: n };
  } finally {
    syncState.pulling = false;
    updateSyncBtn();
  }
}

async function syncDisconnectNow() {
  const cred = syncReadCred();
  if (cred) {
    try {
      await fetch('/api/sync/disconnect', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + cred },
      });
    } catch {}
  }
  syncWriteCred(null);
  syncWriteMeta({});
  updateSyncBtn();
}

function schedulePushDebounced() {
  if (!syncReadCred()) return;
  if (syncState.pushDebounce) clearTimeout(syncState.pushDebounce);
  syncState.pushDebounce = setTimeout(() => {
    syncPushNow().catch((e) => {
      console.warn('[sync] auto-push failed', e);
    });
  }, SYNC_DEBOUNCE_MS);
}

// localStorage 변경 후 호출. apiPost wrapping 으로 자동 트리거.
function notifyDataChanged() {
  schedulePushDebounced();
}

function updateSyncBtn() {
  const btn = document.getElementById('sync-btn');
  const ico = document.getElementById('sync-ico');
  const lab = document.getElementById('sync-lab');
  if (!btn) return;
  btn.classList.remove('is-on', 'is-syncing');
  if (!syncState.enabled) {
    lab.textContent = '동기화 비활성';
    ico.textContent = '☁';
    return;
  }
  const cred = syncReadCred();
  if (cred) {
    btn.classList.add('is-on');
    if (syncState.pushing || syncState.pulling) {
      btn.classList.add('is-syncing');
      lab.textContent = syncState.pushing ? '백업 중…' : '복원 중…';
      ico.textContent = '↻';
    } else {
      const meta = syncReadMeta();
      lab.textContent = '동기화됨';
      if (meta.lastPushAt) {
        const t = String(meta.lastPushAt).slice(11, 16);
        lab.textContent = '동기화 ' + t;
      }
      ico.textContent = '✓';
    }
  } else {
    lab.textContent = '기기 동기화';
    ico.textContent = '☁';
  }
}

function showSyncStage(name) {
  for (const id of ['disabled', 'idle', 'pairing', 'confirming', 'active']) {
    const el = document.getElementById('sync-stage-' + id);
    if (el) el.classList.toggle('hidden', id !== name);
  }
}

// 페어링 2단계: 4자리 확인 코드 입력 화면으로 전환 + 5분 카운트다운 시작
function enterConfirmStage(expiresInSec) {
  showSyncStage('confirming');
  const input = document.getElementById('sync-confirm-input');
  const errEl = document.getElementById('sync-confirm-error');
  const expEl = document.getElementById('sync-confirm-expires');
  if (input) { input.value = ''; setTimeout(() => input.focus(), 50); }
  if (errEl) errEl.textContent = '';

  if (syncState.confirmTimer) clearInterval(syncState.confirmTimer);
  let remaining = Math.max(60, expiresInSec || 300);
  const tick = () => {
    if (remaining <= 0) {
      clearInterval(syncState.confirmTimer);
      syncState.confirmTimer = null;
      // idle 로 복귀
      if (errEl) errEl.textContent = '';
      showSyncStage('idle');
      return;
    }
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    if (expEl) expEl.textContent = `${m}분 ${String(s).padStart(2, '0')}초 안에 완료해주세요`;
    remaining--;
  };
  tick();
  syncState.confirmTimer = setInterval(tick, 1000);
}

async function submitConfirmCode() {
  const input = document.getElementById('sync-confirm-input');
  const errEl = document.getElementById('sync-confirm-error');
  const submitBtn = document.getElementById('sync-confirm-submit');
  const v = (input?.value || '').trim();
  if (!/^\d{4}$/.test(v)) {
    if (errEl) errEl.textContent = '4자리 숫자를 입력해주세요';
    return;
  }
  if (!syncState.pairCode) {
    if (errEl) errEl.textContent = '페어링 세션이 만료됐습니다. 처음부터 다시 시작해주세요.';
    return;
  }
  if (submitBtn) submitBtn.disabled = true;
  try {
    const r = await syncConfirmPair(syncState.pairCode, v);
    if (r.ok && r.cred) {
      // 성공 → 활성 단계
      if (syncState.confirmTimer) clearInterval(syncState.confirmTimer);
      syncState.confirmTimer = null;
      syncState.pairCode = null;
      syncWriteCred(r.cred);
      syncWriteMeta({ chatId: r.chatId, userName: r.userName, pairedAt: new Date().toISOString() });
      showSyncStage('active');
      renderSyncActiveStage();
      updateSyncBtn();
      await tryFirstSyncAction();
      return;
    }
    // 실패 분기
    if (r.error === 'wrong-code') {
      if (errEl) errEl.textContent = `잘못된 코드. 남은 시도 ${r.remainingAttempts ?? '?'}회`;
      if (input) { input.value = ''; input.focus(); }
    } else if (r.error === 'too-many-attempts' || r.status === 429) {
      if (syncState.confirmTimer) clearInterval(syncState.confirmTimer);
      syncState.confirmTimer = null;
      syncState.pairCode = null;
      if (errEl) errEl.textContent = '시도 3회 초과로 폐기됐습니다. 처음부터 다시 시작해주세요.';
      setTimeout(() => showSyncStage('idle'), 2000);
    } else if (r.error === 'confirm-expired' || r.status === 410 || r.status === 404) {
      if (syncState.confirmTimer) clearInterval(syncState.confirmTimer);
      syncState.confirmTimer = null;
      syncState.pairCode = null;
      if (errEl) errEl.textContent = '확인 단계 만료. 처음부터 다시 시작해주세요.';
      setTimeout(() => showSyncStage('idle'), 2000);
    } else {
      if (errEl) errEl.textContent = `오류: ${r.error || r.status}`;
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function openSyncModal() {
  const modal = document.getElementById('sync-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  if (!syncState.enabled) { showSyncStage('disabled'); return; }
  if (syncReadCred()) renderSyncActiveStage();
  else showSyncStage('idle');
}
function closeSyncModal() {
  const modal = document.getElementById('sync-modal');
  if (modal) modal.classList.add('hidden');
  // 페어링 진행 중이었다면 정리 (confirm 단계 포함)
  if (syncState.pairTimer) { clearInterval(syncState.pairTimer); syncState.pairTimer = null; }
  if (syncState.pairCheckTimer) { clearInterval(syncState.pairCheckTimer); syncState.pairCheckTimer = null; }
  if (syncState.confirmTimer) { clearInterval(syncState.confirmTimer); syncState.confirmTimer = null; }
  syncState.pairCode = null;
}

function renderSyncActiveStage() {
  showSyncStage('active');
  const meta = syncReadMeta();
  const nameEl = document.getElementById('sync-active-name');
  const metaEl = document.getElementById('sync-active-meta');
  nameEl.textContent = meta.userName ? `${meta.userName}님 — 텔레그램 연동됨` : '텔레그램 연동됨';
  let metaText = '';
  if (meta.chatId) metaText += `chat: ${meta.chatId}`;
  if (meta.lastPushAt) metaText += `${metaText ? ' · ' : ''}마지막 백업 ${meta.lastPushAt}`;
  if (meta.lastPushBytes) metaText += `${metaText ? ' · ' : ''}${meta.lastPushBytes.toLocaleString('en-US')} bytes`;
  metaEl.textContent = metaText || '아직 백업 없음';
  document.getElementById('sync-action-status').textContent = '';
}

async function startPairingFlow() {
  showSyncStage('pairing');
  document.getElementById('sync-pair-status').textContent = '⏳ 코드 발급 중…';
  document.getElementById('sync-pair-status').className = 'sync-pair-status';
  try {
    const init = await syncInitPair();
    syncState.pairCode = init.code;
    syncState.pairExpiresAt = Date.now() + (init.expiresInSec * 1000);
    document.getElementById('sync-pair-code').textContent = init.code;
    const link = document.getElementById('sync-deeplink');
    link.href = init.deepLink;
    link.textContent = `텔레그램에서 @${init.bot} 열기 →`;
    document.getElementById('sync-pair-status').textContent = '⏳ 텔레그램에서 봇이 시작되기를 기다리는 중…';

    if (syncState.pairTimer) clearInterval(syncState.pairTimer);
    syncState.pairTimer = setInterval(() => {
      const left = Math.max(0, syncState.pairExpiresAt - Date.now());
      const m = Math.floor(left / 60000);
      const s = Math.floor((left % 60000) / 1000);
      document.getElementById('sync-pair-expires').textContent =
        left > 0 ? `${m}분 ${String(s).padStart(2, '0')}초 안에 완료` : '⏰ 만료됨 — 다시 시작해주세요';
      if (left <= 0) {
        clearInterval(syncState.pairTimer);
        syncState.pairTimer = null;
        if (syncState.pairCheckTimer) clearInterval(syncState.pairCheckTimer);
        syncState.pairCheckTimer = null;
      }
    }, 1000);

    if (syncState.pairCheckTimer) clearInterval(syncState.pairCheckTimer);
    syncState.pairCheckTimer = setInterval(async () => {
      if (!syncState.pairCode) return;
      try {
        const r = await syncCheckPair(syncState.pairCode);
        if (r.awaitingConfirm) {
          // 텔레그램에서 /start 가 수신됐고, 봇이 이미 4자리 코드를 그 채팅에 보냄.
          // 이제 사용자가 4자리 코드를 입력하길 기다림 → 폴링은 정지하고 확인 단계로 전환.
          clearInterval(syncState.pairCheckTimer);
          syncState.pairCheckTimer = null;
          if (syncState.pairTimer) clearInterval(syncState.pairTimer);
          syncState.pairTimer = null;
          enterConfirmStage(r.confirmExpiresInSec || 300);
        } else if (r.paired && r.cred) {
          // (백워드 호환) 구버전 페어 — confirmCode 없이 즉시 발급
          clearInterval(syncState.pairCheckTimer);
          syncState.pairCheckTimer = null;
          if (syncState.pairTimer) clearInterval(syncState.pairTimer);
          syncState.pairTimer = null;
          syncWriteCred(r.cred);
          syncWriteMeta({ chatId: r.chatId, userName: r.userName, pairedAt: new Date().toISOString() });
          showSyncStage('active');
          renderSyncActiveStage();
          updateSyncBtn();
          await tryFirstSyncAction();
        } else if (r.status === 404) {
          // 만료
          clearInterval(syncState.pairCheckTimer);
          syncState.pairCheckTimer = null;
          document.getElementById('sync-pair-status').textContent = '⏰ 코드 만료. 다시 시도해주세요.';
          document.getElementById('sync-pair-status').className = 'sync-pair-status err';
        }
      } catch (e) { /* swallow */ }
    }, 2500);
  } catch (e) {
    document.getElementById('sync-pair-status').textContent = '오류: ' + (e.message || e);
    document.getElementById('sync-pair-status').className = 'sync-pair-status err';
  }
}

async function tryFirstSyncAction() {
  // 새로 페어링했을 때 자동 결정:
  //  - 텔레그램에 핀된 백업이 있으면, 사용자에게 "복원할까?" 묻기
  //  - 없으면 자동으로 첫 백업 시도
  const status = document.getElementById('sync-action-status');
  status.textContent = '☁ 텔레그램 채팅 확인 중…';
  status.className = 'sync-action-status';
  try {
    const result = await syncPullNow();
    if (result && result.payload) {
      const localCount = (() => {
        const a = lsGetAccounts(); const t = lsGetTx(); const s = lsGetSnapshots();
        return (a.accounts?.length || 0) + (t.transactions?.length || 0) + Object.keys(s).length;
      })();
      const ok = localCount === 0
        || confirm(`텔레그램에 백업이 있습니다 (${result.savedAt || ''}). 이 기기의 현재 데이터를 그 백업으로 덮어쓸까요?\n\n로컬 데이터: ${localCount}건\n취소하시면 로컬 데이터를 유지하고 다음 백업 때 텔레그램이 갱신됩니다.`);
      if (ok) {
        // restoreFromSyncPayload 는 syncPullNow 안에서 이미 적용됨. 화면 리로드.
        await loadAll();
        renderAssets(); renderSpend(); renderTotals(); renderDashboard();
        status.textContent = `✓ ${result.savedAt || ''} 백업 복원됨 (${result.bytes.toLocaleString('en-US')} bytes)`;
        status.className = 'sync-action-status ok';
      } else {
        // 사용자가 거절 → 로컬 그대로 두고, 즉시 push 로 텔레그램 백업 갱신
        await syncPushNow();
        status.textContent = '✓ 로컬 데이터를 텔레그램에 새로 백업했습니다';
        status.className = 'sync-action-status ok';
      }
    }
  } catch (e) {
    if (String(e).includes('no-backup') || String(e).includes('no-document')) {
      // 첫 페어링이고 백업 없음 → 즉시 push
      try {
        const j = await syncPushNow();
        status.textContent = `✓ 첫 백업 완료 (${j.bytes.toLocaleString('en-US')} bytes)`;
        status.className = 'sync-action-status ok';
      } catch (e2) {
        status.textContent = '백업 실패: ' + (e2.message || e2);
        status.className = 'sync-action-status err';
      }
    } else {
      status.textContent = '복원 실패: ' + (e.message || e);
      status.className = 'sync-action-status err';
    }
  }
  renderSyncActiveStage();
  updateSyncBtn();
}

// ============================================================================
// 프라이버시 안내 모달 + 첫 방문 환영 배너
// ============================================================================
const WELCOME_DISMISSED_KEY = 'seed:welcome:dismissed';

function openPrivacyModal() {
  const modal = document.getElementById('privacy-modal');
  if (modal) modal.classList.remove('hidden');
}
function closePrivacyModal() {
  const modal = document.getElementById('privacy-modal');
  if (modal) modal.classList.add('hidden');
}

function setupPrivacyModal() {
  document.getElementById('open-privacy')?.addEventListener('click', openPrivacyModal);
  document.getElementById('privacy-close')?.addEventListener('click', closePrivacyModal);
  document.getElementById('privacy-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'privacy-modal') closePrivacyModal();
  });
  // ESC 로도 닫기
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const m = document.getElementById('privacy-modal');
      if (m && !m.classList.contains('hidden')) closePrivacyModal();
    }
  });
}

function setupWelcomeBanner() {
  const banner = document.getElementById('welcome-banner');
  if (!banner) return;
  const dismissed = (() => { try { return !!localStorage.getItem(WELCOME_DISMISSED_KEY); } catch { return false; } })();
  const accountsEmpty = (lsGetAccounts().accounts || []).length === 0;
  const txEmpty = (lsGetTx().transactions || []).length === 0;
  // 첫 방문 = dismiss 안 함 + 계좌/거래 모두 0건
  const showBanner = !dismissed && accountsEmpty && txEmpty;
  banner.classList.toggle('hidden', !showBanner);

  document.getElementById('welcome-open-privacy')?.addEventListener('click', openPrivacyModal);
  document.getElementById('welcome-dismiss')?.addEventListener('click', () => {
    try { localStorage.setItem(WELCOME_DISMISSED_KEY, '1'); } catch {}
    banner.classList.add('hidden');
  });
}

async function setupSync() {
  // 서버 동기화 활성 여부 조회
  const status = await syncFetchStatus();
  syncState.enabled = !!(status && status.enabled);
  syncState.bot = status?.bot || null;
  updateSyncBtn();

  document.getElementById('sync-btn')?.addEventListener('click', openSyncModal);
  document.getElementById('sync-close')?.addEventListener('click', closeSyncModal);
  document.getElementById('sync-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'sync-modal') closeSyncModal();
  });
  document.getElementById('sync-pair-start')?.addEventListener('click', startPairingFlow);
  document.getElementById('sync-pair-cancel')?.addEventListener('click', () => {
    if (syncState.pairCheckTimer) clearInterval(syncState.pairCheckTimer);
    syncState.pairCheckTimer = null;
    if (syncState.pairTimer) clearInterval(syncState.pairTimer);
    syncState.pairTimer = null;
    syncState.pairCode = null;
    showSyncStage('idle');
  });
  // 4자리 확인 단계 버튼
  document.getElementById('sync-confirm-submit')?.addEventListener('click', submitConfirmCode);
  document.getElementById('sync-confirm-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitConfirmCode(); }
  });
  document.getElementById('sync-confirm-input')?.addEventListener('input', (e) => {
    // 숫자만 허용 + 4자리에 도달하면 자동 제출
    const v = e.target.value.replace(/\D/g, '').slice(0, 4);
    if (v !== e.target.value) e.target.value = v;
    if (v.length === 4) submitConfirmCode();
  });
  document.getElementById('sync-confirm-cancel')?.addEventListener('click', () => {
    if (syncState.confirmTimer) clearInterval(syncState.confirmTimer);
    syncState.confirmTimer = null;
    syncState.pairCode = null;
    showSyncStage('idle');
  });
  document.getElementById('sync-push-now')?.addEventListener('click', async () => {
    const status = document.getElementById('sync-action-status');
    status.textContent = '백업 중…'; status.className = 'sync-action-status';
    try {
      const j = await syncPushNow();
      status.textContent = `✓ 백업 완료 (${j.bytes.toLocaleString('en-US')} bytes, ${j.savedAt})`;
      status.className = 'sync-action-status ok';
      renderSyncActiveStage();
    } catch (e) {
      status.textContent = '실패: ' + (e.message || e);
      status.className = 'sync-action-status err';
    }
  });
  document.getElementById('sync-pull-now')?.addEventListener('click', async () => {
    const status = document.getElementById('sync-action-status');
    if (!confirm('텔레그램에 핀된 최신 백업으로 이 기기 데이터를 덮어씁니다. 진행할까요?')) return;
    status.textContent = '복원 중…'; status.className = 'sync-action-status';
    try {
      const j = await syncPullNow();
      await loadAll();
      renderAssets(); renderSpend(); renderTotals(); renderDashboard();
      status.textContent = `✓ ${j.savedAt} 복원 (${j.bytes.toLocaleString('en-US')} bytes)`;
      status.className = 'sync-action-status ok';
    } catch (e) {
      status.textContent = '실패: ' + (e.message || e);
      status.className = 'sync-action-status err';
    }
  });
  document.getElementById('sync-disconnect')?.addEventListener('click', async () => {
    if (!confirm('이 기기의 동기화 자격을 폐기할까요? (텔레그램 채팅의 백업 파일은 그대로 남습니다)')) return;
    await syncDisconnectNow();
    closeSyncModal();
  });
}

async function boot() {
  setupTabs();
  setupAccForm();
  setupTxForm();
  setupCsvImport();
  setupAssetImport();
  setupGraph();
  setupEvents();
  setupHistoryChart();
  setupMiniSpark();
  // 대시보드 포트폴리오 행 클릭 → 차트 모달 오픈 (크립토는 업비트 KRW 우선, 없으면 Yahoo X-USD).
  document.addEventListener('click', (e) => {
    const row = e.target.closest('[data-chart-ticker]');
    if (!row) return;
    let type = row.getAttribute('data-chart-type');
    let ticker = row.getAttribute('data-chart-ticker');
    const label = row.getAttribute('data-chart-label') || ticker;
    // 크립토는 거래소 currency 기반으로 ticker 보정 → KRW-BTC or BTC-USD
    if (type === 'crypto' && !/^KRW-|-USD$/.test(ticker)) {
      // 기본 KRW 거래소로 시도 (가장 흔함)
      ticker = `KRW-${ticker.toUpperCase()}`;
    }
    window._openHistoryChart(type, ticker, label);
  });
  await loadAll();
  renderAssets();
  renderSpend();
  renderTotals();
  renderDashboard();
  renderTickerStrip();
  schedulePolling();
  setupSync();
  setupPrivacyModal();
  setupWelcomeBanner();
}

// ---------- 종목 Historical 차트 모달 ----------
const chartState = {
  type: null,
  ticker: null,
  label: null,
  range: '1mo',
  points: [],       // [{ t, c }, ...]  t=ms, c=close
  currency: 'KRW',
  hoverIdx: -1,
  dragStart: -1,
  dragEnd: -1,
};

function setupHistoryChart() {
  const modal = document.getElementById('chart-modal');
  const closeBtn = document.getElementById('chart-close');
  const ranges = document.getElementById('chart-ranges');
  const canvas = document.getElementById('history-chart');
  if (!modal || !canvas) return;

  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  ranges.addEventListener('click', (e) => {
    const b = e.target.closest('[data-range]');
    if (!b) return;
    $$('#chart-ranges .chip').forEach(c => c.classList.remove('active'));
    b.classList.add('active');
    chartState.range = b.getAttribute('data-range');
    loadAndRenderHistory();
  });

  // 마우스 이벤트 (hover + 드래그 범위 선택)
  canvas.addEventListener('mousemove', onChartMove);
  canvas.addEventListener('mousedown', onChartDown);
  canvas.addEventListener('mouseup', onChartUp);
  canvas.addEventListener('mouseleave', () => {
    chartState.hoverIdx = -1;
    document.getElementById('chart-tooltip').classList.add('hidden');
    drawHistoryChart();
  });
}

window._openHistoryChart = async (type, ticker, label) => {
  // 지수/티커 유효성 체크
  if (!type || !ticker) return;
  chartState.type = type;
  chartState.ticker = ticker;
  chartState.label = label || ticker;
  chartState.range = '1mo';
  chartState.points = [];
  chartState.hoverIdx = -1;
  chartState.dragStart = -1;
  chartState.dragEnd = -1;

  // range 칩 초기화
  $$('#chart-ranges .chip').forEach(c => c.classList.toggle('active', c.getAttribute('data-range') === '1mo'));

  document.getElementById('chart-title').textContent = `${label || ticker} · ${ticker}`;
  document.getElementById('chart-meta').textContent = '로딩중…';
  document.getElementById('chart-modal').classList.remove('hidden');
  await loadAndRenderHistory();
};

async function loadAndRenderHistory() {
  const { type, ticker, range } = chartState;
  try {
    const r = await apiGet(`${API.history}?type=${encodeURIComponent(type)}&ticker=${encodeURIComponent(ticker)}&range=${range}`);
    if (!r.ok) {
      document.getElementById('chart-meta').textContent = '데이터 없음: ' + (r.error || '알 수 없음');
      chartState.points = [];
      drawHistoryChart();
      return;
    }
    chartState.points = r.points || [];
    chartState.currency = r.currency || 'USD';
    updateChartMeta();
    drawHistoryChart();
  } catch (e) {
    document.getElementById('chart-meta').textContent = '오류: ' + e.message;
  }
}

function updateChartMeta() {
  const p = chartState.points;
  const metaEl = document.getElementById('chart-meta');
  if (!p.length) { metaEl.textContent = '—'; return; }
  const first = p[0].c, last = p[p.length - 1].c;
  const change = last - first;
  const pct = first !== 0 ? (change / first) * 100 : 0;
  const isUSD = chartState.currency === 'USD';
  const fmtPrice = (v) => isUSD ? '$' + v.toFixed(2) : '₩' + Math.round(v).toLocaleString('ko-KR');
  const cls = change >= 0 ? 'delta-up' : 'delta-down';
  metaEl.innerHTML = `현재 ${fmtPrice(last)} · 기간 시작 ${fmtPrice(first)} · <span class="${cls}">${change >= 0 ? '+' : ''}${fmtPrice(change)} (${change >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span> · ${p.length}개 포인트`;
}

function drawHistoryChart() {
  const canvas = document.getElementById('history-chart');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  const W = wrap.clientWidth - 4;
  const H = 340;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const pts = chartState.points;
  if (!pts.length) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '13px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('이 범위에 데이터가 없습니다.', W / 2, H / 2);
    return;
  }

  const padL = 54, padR = 10, padT = 16, padB = 26;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const prices = pts.map(p => p.c);
  const minP = Math.min(...prices);
  const maxP = Math.max(...prices);
  const padP = (maxP - minP) * 0.06 || maxP * 0.01 || 1;
  const lo = minP - padP;
  const hi = maxP + padP;
  const ts = pts.map(p => p.t);
  const tMin = ts[0];
  const tMax = ts[ts.length - 1];
  const tSpan = Math.max(1, tMax - tMin);

  const xAt = (t) => padL + ((t - tMin) / tSpan) * chartW;
  const yAt = (v) => padT + (1 - (v - lo) / (hi - lo)) * chartH;

  // Y 그리드
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.2)';
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  const isUSD = chartState.currency === 'USD';
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i / 4);
    const y = yAt(v);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + chartW, y);
    ctx.stroke();
    const label = isUSD ? '$' + v.toFixed(2) : '₩' + Math.round(v).toLocaleString('ko-KR');
    ctx.fillText(label, padL - 6, y + 3);
  }

  // 드래그 선택 영역 (파란 반투명)
  if (chartState.dragStart >= 0 && chartState.dragEnd >= 0 && chartState.dragStart !== chartState.dragEnd) {
    const a = Math.min(chartState.dragStart, chartState.dragEnd);
    const b = Math.max(chartState.dragStart, chartState.dragEnd);
    ctx.fillStyle = 'rgba(49, 130, 246, 0.14)';
    ctx.fillRect(xAt(pts[a].t), padT, xAt(pts[b].t) - xAt(pts[a].t), chartH);
  }

  // 라인
  const first = pts[0].c, last = pts[pts.length - 1].c;
  const up = last >= first;
  const lineColor = up ? '#F04452' : '#2563eb';
  // Area fill
  const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
  grad.addColorStop(0, up ? 'rgba(240, 68, 82, 0.22)' : 'rgba(37, 99, 235, 0.22)');
  grad.addColorStop(1, up ? 'rgba(240, 68, 82, 0.02)' : 'rgba(37, 99, 235, 0.02)');
  ctx.beginPath();
  ctx.moveTo(xAt(pts[0].t), padT + chartH);
  for (const p of pts) ctx.lineTo(xAt(p.t), yAt(p.c));
  ctx.lineTo(xAt(pts[pts.length - 1].t), padT + chartH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  for (let i = 0; i < pts.length; i++) {
    const x = xAt(pts[i].t), y = yAt(pts[i].c);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // X축 라벨 (4~5개) — 범위에 따라 포맷 다르게
  ctx.textAlign = 'center';
  ctx.fillStyle = '#94a3b8';
  const numLabels = 5;
  const shortRange = chartState.range === '1d' || chartState.range === '1w';
  for (let i = 0; i < numLabels; i++) {
    const t = tMin + (tSpan * i / (numLabels - 1));
    const d = new Date(t);
    let label;
    if (chartState.range === '1d') {
      label = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    } else if (shortRange) {
      label = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}시`;
    } else {
      label = `${d.getMonth() + 1}/${d.getDate()}`;
    }
    ctx.fillText(label, padL + chartW * i / (numLabels - 1), padT + chartH + 16);
  }

  // Hover crosshair + point
  if (chartState.hoverIdx >= 0 && chartState.hoverIdx < pts.length) {
    const p = pts[chartState.hoverIdx];
    const x = xAt(p.t), y = yAt(p.c);
    ctx.strokeStyle = 'rgba(100, 116, 139, 0.5)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + chartH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = lineColor;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function onChartMove(e) {
  const pts = chartState.points;
  if (!pts.length) return;
  const canvas = e.currentTarget;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const padL = 54, padR = 10;
  const chartW = rect.width - padL - padR;
  if (x < padL || x > padL + chartW) return;
  const ratio = (x - padL) / chartW;
  const idx = Math.max(0, Math.min(pts.length - 1, Math.round(ratio * (pts.length - 1))));
  chartState.hoverIdx = idx;
  if (chartState.dragStart >= 0) chartState.dragEnd = idx;

  // 툴팁 갱신
  const tip = document.getElementById('chart-tooltip');
  const p = pts[idx];
  const d = new Date(p.t);
  const isUSD = chartState.currency === 'USD';
  const priceStr = isUSD ? '$' + p.c.toFixed(2) : '₩' + Math.round(p.c).toLocaleString('ko-KR');
  const datePart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const timePart = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const shortRange = chartState.range === '1d' || chartState.range === '1w';
  const dateStr = shortRange ? `${datePart} ${timePart}` : datePart;
  let dragInfo = '';
  if (chartState.dragStart >= 0 && chartState.dragStart !== chartState.dragEnd) {
    const a = Math.min(chartState.dragStart, chartState.dragEnd);
    const b = Math.max(chartState.dragStart, chartState.dragEnd);
    const pA = pts[a].c, pB = pts[b].c;
    const diff = pB - pA;
    const pct = pA !== 0 ? (diff / pA) * 100 : 0;
    const cls = diff >= 0 ? 'delta-up' : 'delta-down';
    dragInfo = `<br><span class="${cls}">범위 ${diff >= 0 ? '+' : ''}${pct.toFixed(2)}% · ${b - a + 1}개 포인트</span>`;
  }
  tip.innerHTML = `<b>${esc(dateStr)}</b><br>${priceStr}${dragInfo}`;
  tip.style.left = (x + 12) + 'px';
  tip.style.top = (e.clientY - rect.top - 10) + 'px';
  tip.classList.remove('hidden');

  drawHistoryChart();
}
function onChartDown(e) {
  if (chartState.hoverIdx < 0) return;
  chartState.dragStart = chartState.hoverIdx;
  chartState.dragEnd = chartState.hoverIdx;
}
function onChartUp() {
  // 드래그 끝난 후에도 선택은 유지 (다시 눌러야 해제). 클릭만 한 경우 해제.
  if (chartState.dragStart === chartState.dragEnd) {
    chartState.dragStart = -1;
    chartState.dragEnd = -1;
    drawHistoryChart();
  }
}

window.addEventListener('DOMContentLoaded', boot);
})();
