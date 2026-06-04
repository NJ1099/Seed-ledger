# Seed · Liquid Ledger — 공개 배포판 HANDOFF

> 다음 세션에서 이어서 작업할 때 가장 먼저 읽어야 하는 문서.

최종 업데이트: 2026-06-04 (라운드 10 — 종목 마스터·.env·네이버 OpenAPI 뉴스)

## 현재 상태 한 줄 요약
Render 에 공개 배포되어 누구나 브라우저 localStorage 로 개인 자산을 기록하고, 서버는 시세·경제캘린더 Top 5 를 자동 수집하며, 텔레그램 봇을 통해 2단계 인증 기반 기기 간 동기화 옵션과 프라이버시 안내를 제공한다. 신규 "주식" 탭으로 8개 경제지표 대시보드·국내 Top 5 등락주·종목 검색·실제 링크 경제 뉴스를 한 화면에 표시.

## 라이브 URL / 저장소

| 항목 | 값 |
|---|---|
| 프로덕션 | https://seed-ledger.onrender.com |
| GitHub | https://github.com/NJ1099/Seed-ledger |
| Render 서비스 | seed-ledger (Free, Singapore region) |
| 로컬 포트 | 4274 (기본) / 4275 (launch.json `seed-public`) |

## 지금 동작하는 것

- **localStorage 격리** — 계좌·거래·스냅샷·개인 이벤트는 전부 브라우저에만 저장. 다른 사용자와 완전히 분리.
- **공유 시세 캐시** — `data/popular-tickers.json` 목록을 서버가 2분 주기로 미리 폴링해 첫 방문자도 즉시 시세를 본다 (Upbit + Naver + Yahoo 프록시).
- **주요 이벤트 자동 수집 Top 5** — 토스증권 공개 AI 캘린더 API 에서 "이번 주 핵심 이벤트" 를 6시간 주기로 수집, `data/events.json` 덮어쓰기.
  - 소스: `https://wts-info-api.tossinvest.com/api/v1/calendar/ai-summary/key-events`
  - 경제지표 + 주요 실적 발표 혼합, 한국어 제목 그대로 보존
  - 실패 시 기존 파일 유지 (보수적 처리)
- **쓰기 차단** — `/api/accounts`, `/api/transactions`, `/api/snapshot`, `/api/snapshots` 는 모두 `410 Gone`. `/api/events` 는 GET 만 허용 (`403`).
- **PDF 임포트** — 메모리에서만 처리. 디스크에 저장 안 됨.

## 최근 라운드에서 한 일 (2026-06-04)

### 라운드 10: 종목 마스터·.env·네이버 OpenAPI 뉴스 (2026-06-04)

사용자 피드백: 한글 검색이 라운드 9 보강 후에도 영어로만 됨. 네이버 뉴스 API 도 이용. nabakai.com 스타일 풀 대시보드 (수급·연기금·AI요약) 도 요구. → **Phase 1 (검색·환경변수·뉴스)** 만 이번 라운드, **Phase 2 (수급·연기금·AI요약·대시보드 확장)** 는 다음 라운드 후보로 정리.

**원인 추정 (한글 검색 실패)**: Render 의 데이터센터 IP 가 네이버 검색 endpoint 들에서 거의 매번 차단 — Yahoo Finance 만 응답하니 영어 검색만 통함. 매 요청 차단을 우회하려면 (1) 부팅 시점 한 번에 종목 마스터를 받아오거나 (2) OpenAPI 키 기반 인증으로 호출하는 두 방법.

1. **[완료] 정적 종목 마스터 (`server.js`)**
   - 부팅 시 `buildStockMaster()` 가 KOSPI/KOSDAQ/NASDAQ/NYSE 각각 `api.stock.naver.com/stock/exchange/{ex}/marketValue?pageSize=500` 호출 → 시드 데이터와 dedupe 병합 → `data/stock-master.json` 캐시 (gitignore).
   - 매일 1회 (`24h`) 자동 재시도. fetch 가 모두 실패해도 **시드 60개** (한국 30 + KOSDAQ 10 + 미국 20) 로 기본 한글 검색 보장.
   - `searchInMaster(q)` — 한글/영문/코드 부분일치 검색. exact match 0점, prefix 1점, substring 2점 정렬 → 상위 10개. 검색 함수의 **0차 (최우선)** 로 동작.
   - 결과: Render IP 차단 영향 없이 항상 한글 검색 동작.

2. **[완료] `.env` 셋업 (`server.js` + `.env.example`)**
   - **zero-deps 정책** 유지 — dotenv 패키지 안 씀. `loadDotEnv()` 내장 파서가 `KEY=VALUE` 라인 직접 파싱, 따옴표/주석 처리, 기존 `process.env` 값 우선.
   - 부팅 첫 줄에서 호출.
   - `.env.example` 신규 — 주석 가이드 포함:
     - `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` (뉴스 검색)
     - `ANTHROPIC_API_KEY` (다음 라운드 AI 요약 — 선택)
     - `TELEGRAM_BOT_TOKEN` (기기 동기화 — 기존)
     - `PORT` (선택)
   - `.gitignore` 에 `.env` / `.env.local` 이미 등록 → 키가 git 에 올라갈 위험 없음.
   - `data/stock-master.json` 도 .gitignore 추가 (런타임 캐시).

3. **[완료] 네이버 뉴스 검색 OpenAPI 통합 (`server.js`)**
   - `fetchNaverOpenApiNews(query, limit)` — `openapi.naver.com/v1/search/news.json` 호출. `X-Naver-Client-Id/Secret` 헤더 인증. 일일 25,000 요청 무료.
   - **키가 있을 때 `fetchStockNews` 의 0차 (최우선)** 로 동작. 키 없거나 응답 0건이면 기존 stock.naver.com → m.stock → EUC-KR HTML 폴백.
   - `/api/stock-news?q={검색어}` — query 파라미터 추가. 종목별·키워드별 뉴스 필터 가능. 빈 `q` 면 `"주식 시황"` 기본 키워드 사용.
   - 캐시 키 `__news:{q}` 로 query 별 분리 (TTL 5분).
   - 응답 정규화: `originallink` 우선 (원문 URL), `pubDate` 를 ISO 변환, `extractSourceFromUrl()` 로 hostname → 한국 매체명 (한국경제/매일경제/이데일리 등 15+ 매핑).

**검증**: 로컬 회사 프록시 TLS 차단으로 직접 호출은 여전히 불가. `node -c server.js` syntax OK. Render 배포 + 사용자가 `.env` 또는 Render 환경변수에 `NAVER_CLIENT_ID/SECRET` 등록 후 검증 필요.

**`.env` 위치 안내**:
- 로컬: `D:\Claude\seed-public\.env` (만들기: `.env.example` 복사). 서버 부팅 시 자동 로드.
- Render: 대시보드 → seed-ledger 서비스 → Environment → Add Environment Variable. `.env` 파일은 git ignore 이라 배포 안 됨.

---

### 라운드 10 — 다음 라운드 후보 (Phase 2): nabakai.com 스타일 풀 대시보드

사용자가 요청한 **수급·연기금·AI요약·통합 대시보드** 는 작업 규모가 커서 별도 라운드로 분리. 우선순위 순:

1. **외인·기관·개인 수급 표** (난이도 ★★☆)
   - 소스 후보: 네이버 `https://finance.naver.com/sise/sise_quant.naver` (외국인 순매수 상위) / `sise_quant_dn.naver` (순매도) HTML 스크래핑 (EUC-KR — `httpsGetBuffer` 재사용 가능).
   - 또는 종목별 페이지 `https://finance.naver.com/item/frgn.naver?code=005930` 의 최근 N일 매매 내역.
   - 신규 엔드포인트: `GET /api/investor-flows?market=kr&type=foreign|institution|individual&direction=buy|sell`.
   - UI: 주식 탭에 신규 "투자자별 수급 Top 5" 섹션 추가.

2. **연기금 매수·매도 목록** (난이도 ★★☆)
   - 소스 후보: KRX 정보데이터시스템 OpenAPI (인증 필요) / 네이버 `pension` 또는 `agency` 매매 페이지.
   - "지난 N일간 누가 무엇을 얼마나" 형태 표. 종목 클릭 → 네이버 증권 (라운드 9 흐름 재사용).
   - 신규 엔드포인트: `GET /api/pension-flows?days=5`.

3. **뉴스 AI 요약** (난이도 ★★★ — Anthropic Claude API 키 필요)
   - `.env` 에 `ANTHROPIC_API_KEY` 등록 후 활성화.
   - 신규 엔드포인트: `POST /api/news-summary { newsItems: [...] }` → Claude 4.7 또는 Haiku 4.5 로 한국어 3-5줄 요약.
   - TTL 캐시 (URL 해시 기반).
   - 비용 제어: 일일 호출 cap (예: 100회) + 사용자별 rate limit.

4. **nabakai.com 스타일 통합 대시보드 레이아웃** (난이도 ★★☆)
   - 한국장·미국장 카드 그리드 통합 (개장/장중/마감 상태 표시).
   - 인기 종목 실시간 가격 + 등락률 (기존 popular-tickers.json 폴링 결과 노출).
   - "오늘의 이슈" 패널 — AI 요약 + 주요 종목 자동 매칭.
   - 모바일 최적화 (현재 768px 폴백 외 추가 폴리시).

5. **종목 클릭 시 미니 차트 모달** (난이도 ★★☆ — 라운드 7 에서도 후보)
   - 현재는 네이버 증권 새 탭 (라운드 9). 사용자가 원하면 그대로 둘 수 있음.
   - 대안: 모달 안에 Chart.js 로 1주 · 1개월 차트 + 수급 미니 표.

### 라운드 9: 주식 탭 UX — 사이드바 순서·한글 검색·네이버 증권 종목 페이지 링크 (2026-06-04)

사용자 피드백: ① 주식 탭을 대시보드 바로 밑으로 이동 ② 한글로도 종목 검색 가능 ③ 검색 결과 + Top 5 클릭 시 네이버 증권 종목 페이지가 새 탭으로 열리도록.

1. **[완료] 사이드바 탭 순서 변경** (`index.html`)
   - 기존: 대시보드 → 소비 → 그래프 → 주식.
   - 변경: 대시보드 → **주식** → 소비 → 그래프.

2. **[완료] 한글 검색 보강** (`server.js`)
   - **원인 추정**: 라운드 8 의 `api.stock.naver.com/search/total?keyword=...` 가 한글에 빈 응답을 자주 반환 (파라미터 이름·UA 차단 의심). `ac.finance.naver.com` 폴백도 단순 UA (`seed-ledger/1.0`) 라 거부됐을 가능성.
   - **수정**:
     - `BROWSER_UA` 상수 추가 — 실제 Chrome 126 User-Agent. 모든 네이버 검색 호출에 적용.
     - 1차 stock.naver.com 통합검색을 **세 URL 변형** 동시 시도: `keyword`, `searchText`, `/search` (파라미터 이름 시기별 변동 대응). 첫 성공 시 즉시 사용.
     - 응답 파싱 그룹 후보 6개로 확장 (`searchResult.stock.items`, `searchResult.stocks`, `result.stocks`, `result.items`, `stocks`, `items`).
     - **3차에 `polling.finance.naver.com/api/sise/etcStockNameSearch.nhn?searchText={한글}` 추가** — 네이버 금융 데스크탑이 사용하는 한글 검증된 종목명 검색 endpoint.
     - 4차 `ac.finance.naver.com` 호출 시 `q_enc=UTF-8` + `r_enc=UTF-8` 명시 + 브라우저 UA.
     - 로그 강화: 성공 시 `search.ok.stock` + 어느 URL 인지 / 실패 시 `search.http.*` + status 기록.

3. **[완료] 검색 결과 + Top 5 클릭 → 네이버 증권 새 탭** (`app.js`, `styles.css`)
   - 신규 헬퍼 `buildNaverStockUrl(item)`:
     - 국내 6자리: `https://stock.naver.com/domestic/stock/{code}/total`
     - 해외 NASDAQ: `/worldstock/stock/{code}.O/total`
     - 해외 NYSE: `/worldstock/stock/{code}.K/total`
     - 해외 AMEX: `/worldstock/stock/{code}.A/total`
     - 거래소 모름: `/worldstock/stock/{code}.O/total` (대부분 redirect 됨)
     - 코드 없음: `/search?query={name}` 폴백
   - 검색 dropdown `.search-result-item` 을 `<div>` → `<a target="_blank">` 로 변경. href 는 buildNaverStockUrl 출력 + `safeHttpUrl()` 가드.
   - Top 5 `.mover-row` 도 `<a target="_blank">` 로 변경.
   - styles.css 에 두 클래스 모두 `text-decoration: none; color: inherit;` 추가 (anchor 파란 밑줄 방지).
   - 안 쓰이게 된 `showSearchDetail()` (alert 상세) 제거.

**검증**: 로컬 회사 프록시 TLS 차단으로 직접 호출은 여전히 불가. `node -c server.js` / `node -c app.js` syntax OK. Render 배포 후 사용자 검증 필요.

**다음 라운드 후보** (사용자가 명시한 작업):
- **네이버 뉴스 검색 API 연동** — 현재 `/api/stock-news` 는 `api.stock.naver.com/news/{main,homeNews,news}` 의 정적 헤드라인. 네이버 검색 API (`https://openapi.naver.com/v1/search/news.json`) 의 query 기반 검색으로 교체하면 사용자가 관심 종목 키워드로 뉴스 필터링 가능. 환경변수 `NAVER_CLIENT_ID` / `NAVER_CLIENT_SECRET` 필요 (Render env var 등록).

### 라운드 8: 주식 탭 데이터 소스 stock.naver.com 전환 + 한글 깨짐 수정 (2026-06-03)

사용자 피드백: ① Top 5 한글 깨짐 ② 종목 검색 안 됨 ③ stock.naver.com (국내 `/market/stock/kr`, 미장 `/market/stock/usa`, 뉴스 `/news`) 의 API 로 교체.

**원인 분석**:
- 한글 깨짐 = 라운드 7 의 1차 JSON (`m.stock.naver.com/api/stocks/{dir}/0`) 가 `0` 이라는 잘못된 거래소 코드로 빈 응답 → 2차 폴백 `finance.naver.com/sise/sise_rise.naver` HTML 로 떨어졌는데, 그 페이지가 **EUC-KR 인코딩**인데 `httpsGet` 의 `c.toString('utf8')` 로 디코드해서 종목명이 mojibake.
- 검색 안 됨 = `ac.finance.naver.com/ac` 응답 구조 파싱이 nested array 의 첫 그룹 하나만 보고 있어 결과 누락. 또 stock.naver.com 검색 API 자체를 안 쓰고 있었음.

**해결**:
1. **[완료] EUC-KR 디코드 헬퍼** (`server.js`) — `httpsGetBuffer` 신설. 원본 바이트 받아 `Content-Type charset` 또는 HTML `<meta charset>` 추정 → Node 18+ 내장 `TextDecoder('euc-kr')` 로 디코딩. 디코드 실패 시 utf-8 폴백.
2. **[완료] Movers (`/api/stock-movers`) 재작성**:
   - `MARKET_EXCHANGES = { kr: ['KOSPI','KOSDAQ'], us: ['NASDAQ','NYSE'] }` 도입.
   - 1차: `api.stock.naver.com/stock/exchange/{exchange}/{up|down}` — stock.naver.com 페이지가 사용하는 정식 API (UTF-8 JSON).
   - 2차: `m.stock.naver.com/api/stocks/{up|down}/{exchange}` (모바일 폴백).
   - 3차: EUC-KR HTML 스크래핑 (`httpsGetBuffer` 사용, 국내만).
   - 두 거래소 결과 병합 → `changePct` 절대값 정렬 → Top 5.
   - 응답 정규화 (`normalizeMoverItem`): `itemCode/code/cd`, `stockName/name/nm`, `closePrice/nv`, `compareToPreviousClosePrice/cv`, `fluctuationsRatio/cr`, `signType` 음수 보정 등 stock.naver.com 의 여러 필드 명세 견고하게 대응.
   - **미국 시장 (`market=us`) 도 활성화** — NASDAQ + NYSE 거래소 동시 조회.
3. **[완료] Search (`/api/stock-search`) 4단계 폴백**:
   - 1차: `api.stock.naver.com/search/total` — stock.naver.com 통합검색.
   - 2차: `m.stock.naver.com/front-api/v1/search/autoComplete` — 모바일 자동완성.
   - 3차: `ac.finance.naver.com/ac` — 구 API. 파싱 수정 (전체 group 순회).
   - 4차: Yahoo Finance search — 해외 보강.
   - `searchTypeFromNationCode` 로 KOR/USA → stock_kr/stock_us 자동 매핑.
   - 모든 단계 결과를 `seen` Set 으로 dedupe (type+code 기준), 최대 10개.
4. **[완료] News (`/api/stock-news`) stock.naver.com API 전환**:
   - 1차: `api.stock.naver.com/news/main` / `/news/homeNews` / `/news` — 세 후보 endpoint 순회.
   - 2차: `m.stock.naver.com/api/news/news/category/HOME` 폴백.
   - 3차: EUC-KR HTML 폴백 (`httpsGetBuffer`).
   - `normalizeNewsItem` 에서 `officeId + articleId` 조합 시 `https://n.news.naver.com/mnews/article/{officeId}/{articleId}` URL 자동 생성.
5. **[완료] 클라이언트 검색 UX 강화** (`app.js` + `styles.css`):
   - 검색 결과 dropdown 의 각 row 에 **가격 컬럼** 추가 (`.sri-price`).
   - 결과 도착 즉시 `fillSearchPrices()` 가 모든 종목 ticker 를 모아 **`/api/quotes` 1회 batch 호출** → 각 row 에 현재가 + ▲/▼ 변동률 (한국식 빨강/파랑) 채움.
   - `cssEsc()` 로 querySelector data-attribute 값 escape.
   - 결과 클릭 시 alert 상세 (기존) 유지.

**검증**: 로컬 회사 프록시 TLS 차단으로 직접 호출은 불가. `node -c server.js / app.js` 양쪽 syntax OK. 프로덕션 Render Linux 에서 동작 확인 필요.

**알려진 후속 작업**:
- stock.naver.com API 응답 스키마는 비공식이라 시기별 변동 가능. 운영 중 movers/search/news 가 빈 응답이면 server.log 의 `.parse.stock` / `.http.stock` 이벤트 확인 후 normalizer 보강.
- `__search:` cache key 가 q별로 누적됨 — 사용량 폭증 시 LRU 또는 cap 필요 (라운드 7 동일).

### 라운드 7: 주식 탭 신설 — 경제지표·Top5·검색·뉴스 (2026-06-03)

사용자 요청: GitHub `NJ1099/Seed-ledger` 자산관리 시스템에 주식 탭 추가. 8개 경제지표 대시보드 (4×2), 급상승·급하락 Top 5, 종목 검색, 실제 링크 경제 뉴스.

1. **[완료] 서버 — 4개 신규 엔드포인트** (`server.js`)
   - `GET /api/indices` — Yahoo Finance 8개 심볼 (`^GSPC, ^IXIC, ^KS11, ^KQ11, ^VIX, KRW=X, CL=F, GC=F`) 병렬 호출. `STOCK_INDICES` 메타 + `fetchYahoo` 재사용. TTL 60s.
   - `GET /api/stock-movers?market=kr|us` — 1차 `m.stock.naver.com/api/stocks/{up|down}/0` JSON, 2차 `finance.naver.com/sise/sise_{rise|fall}.naver` HTML 정규식 스크래핑. `us` 는 placeholder (note 필드).
   - `GET /api/stock-search?q=...` — 1차 `ac.finance.naver.com/ac` (국내), 2차 `query1.finance.yahoo.com/v1/finance/search` (해외). 결과 병합 최대 10개. q별 TTL 60s.
   - `GET /api/stock-news?limit=10` — 1차 `m.stock.naver.com/api/news/home/topNews` JSON, 2차 `finance.naver.com/news/mainnews.naver` HTML 스크래핑. TTL 5분.
   - 모든 응답: `{ok:true, ...payload, cached?, stale?}`. 외부 실패 시 stale 캐시 → 빈 데이터 + 200 폴백.
   - 캐시 격리: `quote-cache.json` 의 `quotes` 객체에 prefixed key (`__indices`, `__movers_kr`, `__search:삼성`, `__news`) 저장.
   - `INDEX_SYMBOL_MAP` 에 `VIX: '^VIX'` 추가.
   - 라우팅 dispatcher 에 4줄 추가 (line 660-665).

2. **[완료] 프런트 마크업** (`index.html`)
   - sidenav 에 `<button class="tab" data-tab="stock">📰 주식</button>` 추가.
   - `panel-graph` 다음에 `panel-stock` 섹션: header + 4 section (indices-grid / stock-search / movers-grid + market-toggle / news-list). placeholder 카드 8개 미리 마크업.

3. **[완료] 디자인 토큰 활용 스타일** (`styles.css` 끝, `/* STOCK TAB */` 섹션 +303줄)
   - `.indices-grid` (`repeat(4, 1fr)` → 768px 에서 2열), `.index-card` (surface + border + shadow-sm, hover 강조).
   - `.stock-search input` (focus 시 accent ring), `.stock-search-results` (absolute dropdown + shadow-lg + max-height 360px).
   - `.market-toggle` pill 토글, `.movers-grid` 2열 (모바일 1열), `.movers-head--up/--down` (up/down 배경+텍스트 색상), `.mover-row` 그리드 4열.
   - `.news-item` 카드 링크, hover transform/shadow, `-webkit-line-clamp:2` 로 요약 2줄 클램프.
   - 한국식 상승=빨강(`--up #F04452`), 하락=파랑(`--down #3182F6`) 유지.

4. **[완료] 프런트 로직** (`app.js`)
   - `state` 에 `stockMarket: 'kr'`, `stockRefreshTimer`, `stockSearchDebounce` 추가.
   - `setupTabs()` 에 `if (name === 'stock') renderStock(); else stopStockRefresh();` 추가. 함수 끝에 `setupStockSearch(); setupMarketToggle();` 초기화.
   - 파일 끝 IIFE 직전에 `// STOCK TAB` 섹션 (+247줄): `renderStock`, `loadIndices/fillIndicesGrid`, `loadMovers/fillMovers/fillMoverList`, `setupMarketToggle`, `setupStockSearch/runStockSearch/showSearchDetail`, `loadNews/fillNews`, 헬퍼 (`formatIndexPrice`, `formatIndexChange`, `stockTimeAgo`, `stockApiGet`, `safeHttpUrl`).
   - 5분 setInterval 자동 새로고침. 다른 탭으로 이동 시 `stopStockRefresh()` 로 타이머 정리.
   - 검색 디바운스 250ms, 외부 클릭 시 dropdown 닫힘.
   - 종목 클릭 시 `/api/quotes` 로 현재가 1회 조회 → `alert` 으로 종목명·코드·시장·가격 표시 (차후 확장 여지).

5. **[완료] XSS 가드**
   - 모든 동적 HTML 삽입은 기존 `esc()` 헬퍼 (`&<>"'` escape) 적용.
   - 뉴스 `<a href>` 는 `safeHttpUrl()` 로 `https?://` 시작 URL 만 허용 (`javascript:` / `data:` 스킴 차단).
   - PostToolUse 보안 훅 경고 처리 완료.

검증:
- `node -c server.js` / `node -c app.js` 둘 다 syntax OK.
- 로컬 서버(4276 포트) → 4개 엔드포인트 모두 `ok:true` + 200 응답. 단, 회사 MITM 프록시 TLS 차단 (`self-signed certificate in certificate chain`) 으로 Yahoo·Naver 호출이 모두 실패해 실제 데이터는 0건. **Render Linux 프로덕션에서는 정상 동작 예상** (라운드 6 동일 환경 조건).
- `/`, `/styles.css`, `/app.js` 모두 200, HTML 에 `data-tab="stock"` 1개 확인.

알려진 후속 작업 (이번 라운드 범위 밖):
- US Top 5 (`market=us`) 는 placeholder. Yahoo screener API 또는 Finviz/MarketWatch 스크래핑 후순위.
- 종목 클릭 시 상세 화면 (현재는 alert). 향후 미니 차트 모달 등 확장 가능.
- 검색 캐시 (`__search:*` key) 가 q별로 누적됨 — 사용량 폭증 시 LRU 또는 cap 필요.

### 라운드 6: 경제 캘린더 baseline 동기화 (2026-06-01)

1. **[완료] `data/events.json` 프로덕션 응답으로 동기화** — 커밋된 시드 파일이 2026-04-30 stale 상태였음. Render 재배포 직후 첫 자동 갱신(서버 기동 10초 후) 전까지 stale 데이터가 노출되는 짧은 창을 제거. 현재 시드: 6/1 ISM 제조업 PMI · 6/2 JOLTs · 6/3 ISM 서비스업 PMI + ADP · 6/4 신규 실업수당. (커밋 `ce11a37`)
2. **[참고] 6/5 NFP 비농업 고용보고서**는 Toss API Top 5 절단으로 누락 — 6/2 이후 자동 갱신 사이클에서 자연 반영 예상. 임의 추가는 prev/consensus 값 신뢰성 문제로 보류.
3. **[참고] 로컬 TLS 이슈** — Windows 환경에서 schannel 의 CRYPT_E_NO_REVOCATION_CHECK 로 curl/Node-https 가 Render·Toss API 호출 시 self-signed 체인 오류 (회사 MITM 프록시가 외부 도메인의 인증서를 자체 CA 로 재발급하는 환경 추정). 프로덕션 서버는 Linux 라 정상. 로컬에서 API 디버깅이 필요하면 **회사 프록시 루트 CA 를 OS/Node 신뢰 저장소에 추가**해 해결 (TLS 검증을 끄는 우회는 MITM 노출이라 사용 금지).

### 라운드 5: 그래프 기간/툴팁 + 암호화폐 휠 스크롤 (2026-06-01)

1. **[완료] 그래프 1주일 chip 추가** — `range-chips` 첫 칩으로 7-day 기간 추가. 14개 이하 라벨이면 모든 날짜 표시 (`autoSkip: labels.length > 14`).
2. **[완료] 잔고 차트 hover 툴팁 강화** — 날짜를 header 로, 본문에 `총자산: ₩금액` + `전일 대비: ±X.X% (±₩...)` + `시작 대비: ±X.X% (±₩...)` 3 줄.
3. **[완료] 스택 차트 hover 툴팁 강화** — `interaction: { mode: 'index', intersect: false }` 로 한 날짜의 모든 자산을 한 번에. 각 라인: `자산명: ₩금액 (X.X%)`. footer: `합계: ₩...`. 0인 자산은 라인 숨김.
4. **[완료] 암호화폐 카드 휠 스크롤** — `.eq-lines--collapsed` 의 `mask-image` + `overflow:hidden` 을 `overflow-y:auto` + inset shadow 로 교체. 360px 안에서 휠로 모든 종목 접근 가능 (이전엔 mask 가 스크롤 자체를 차단). 편집 시 가려진 라인은 `scrollIntoView({ block: 'nearest' })` 로 컨테이너 내에서 자동 정렬. `.editing/.selected` 클래스를 `renderAccLine` 에서 `state.editingAccountId` 비교로 재렌더 후에도 유지.

검증: 로컬 서버 + 브라우저에서 (1) 1주 chip (2) 두 차트 툴팁 (3) ETH 편집 후 스크롤 가시성 모두 사용자 확인 완료.

(커밋 `507232c`)

### 라운드 4: PDF 파서 확장 + 카드 PDF 갱신 + 그래프 일자별 표 + 암호화폐 UX 수정

1. **[완료] 신한투자증권 주식잔고 PDF 파서 추가** — `pdfImport.js` 에 `parseShinhanStockBalance` 신규. "주식잔고" + "조회정보" + "잔고내역" + "보유비중" 헤더 시 ISA/IRP/일반 상품 추론, 6자리 영숫자 코드(`0180V0` 등) 지원, 평균단가 보존. 비표준 코드 워닝.
2. **[완료] 토스 파서 견고성 보강** — 국내 섹션 `flat` 처리(줄바꿈 흡수), 라운드힐 메모리 ETF → RMEM 매핑 추가. 토스 PDF 18종목(국내 5 + 해외 13) 모두 정확 추출 확인.
3. **[완료] 잔고 카드 클릭 → PDF로 갱신** — `.acc-line` 클릭 시 상단 액션 바(`#asset-action-bar`) 표시. "PDF로 잔고 갱신" 버튼 → PDF 파싱 → institution 매칭 + brokerage 타입 매칭 → 계좌번호 일부 일치 우선 → 사용자 확인 → `op:'update'` 로 holdings/cashKRW 만 교체 (id·dedupeKey·label 보존). 미매칭 시 한국어 에러.
4. **[완료] 그래프 일자별 수치 + 변화량 표** — Chart.js 의존성 없는 `point-value-overlay` 플러그인으로 차트 포인트에 잔고 라벨 직접 표시(데이터 갯수 기반 stride, 첫·마지막·최고·최저 항상). 차트 하단에 `.graph-table` 추가: 날짜 / 총자산 / 일간변화 / 누적변화 / 시세메모, 최신 행 강조, sticky thead.
5. **[완료] 암호화폐 카드 UX 수정** — `state.expandedCardTypes` Set 으로 펼침 상태 보존 → 시세 폴링 재렌더에도 안 접힘 (자동 접힘 회귀 해결). collapseThreshold 8→12. crypto 그룹 자식(indent) 라인에서 `labelText`를 `a.label || a.institution` 로 변경 → 사용자가 입력한 라벨이 메인으로, institution 은 부정보(`subs` push)에 자연스럽게 노출.

검증:
- `node -e "..."` 로 두 PDF 파싱 결과 검증 — 신한 7종목/토스 18종목 + 환산 cashKRW 757,287 정확.
- 로컬 서버(`node server.js 4276`) → `/api/import-pdf` 두 PDF 모두 `ok:true` 응답.
- `setupAssetActionBar` 가 `setupAssetImport` 직후 초기화에 추가됨.

신규/수정 클래스 (styles.css 끝부분 `/* ============ GRAPH TABLE & SELECT MODE ============ */`):
- `.graph-table-wrap`, `.graph-table-head`, `.graph-table`, `.tnum.up/.down/.flat`, `.gt-latest`, `.gt-memo`, `.gt-title`, `.gt-sub`
- `.acc-line.selected`, `.asset-action-bar`(`.hidden`/`.aab-info`/`.aab-actions`), `.btn-replace-pdf`, `.btn-cancel-select`

### 라운드 3: 프라이버시 정책 명시 + 페어링 4자리 확인 강화

1. **[완료] 페어링 2단계화 (서버)** — `startPairingPoller` 가 텔레그램 `/start link_XXXXXX` 수신 시 4자리 확인 코드 (1000~9999) 발급해 봇이 사용자 채팅에 전송. `pendingPairs` 엔트리에 `confirmCode`, `confirmCreatedAt`, `confirmAttempts` 추가. 신규 엔드포인트 `/api/sync/confirm` 이 4자리 검증 (5분 TTL, 시도 3회 제한). `handleSyncCheck` 는 confirm 단계 진입 시 `awaitingConfirm: true` 반환 (cred 발급 안 함).
2. **[완료] 클라 confirm 단계 UI** — `sync-stage-confirming` 모달 단계 추가 (4자리 input + 카운트다운 + 오류 영역). `submitConfirmCode` 가 `wrong-code` / `too-many-attempts` / `confirm-expired` 분기 처리. 4자리 입력 시 자동 제출. `setupSync` 에 confirm 버튼 핸들러 등록.
3. **[완료] 프라이버시 모달 + 환영 배너** — 푸터 "프라이버시 안내" 링크 → `#privacy-modal` (4섹션 `<details>` 구조: 저장 위치 / 서버가 보는 것 / 텔레그램 격리 / 폐기 절차). 자산 탭 최상단에 첫 방문 환영 배너 (`localStorage.seed:welcome:dismissed` + 계좌·거래 0건일 때만). 동기화 모달 미연결/활성 카피도 격리 보장 명시 추가.
4. **[완료] 로컬 검증** — 봇 토큰 없이 부팅 시 `/api/sync/confirm` 도 `503 sync-disabled` 반환 확인.
5. **[대기] 운영자 봇 토큰 등록 후** 실제 페어링 + 4자리 확인 전체 플로우 사용자 검증.

### 라운드 2: Telegram 봇 기반 기기 간 동기화 (2026-04-22)

1. **[완료] 아키텍처 결정** — Render 무료 플랜 디스크 휘발성 문제 회피 위해 텔레그램 클라우드를 저장소로 사용. 봇이 사용자 채팅에 JSON 파일을 sendDocument + pinChatMessage 로 저장 → 다른 기기는 `getChat.pinned_message` 로 회수. 서버는 stateless.
2. **[완료] 서버 측 구현** — `server.js` 에 `tgPostJson` / `tgPostMultipart` / `tgDownloadFile` 헬퍼와 HMAC cred 서명 (`SYNC_SECRET = sha256(BOT_TOKEN + ':seed-sync-v1')`). 페어링 폴링 (`getUpdates`) 은 활성 코드가 있을 때만 8분 간 활성화. 6개 엔드포인트: `/api/sync/{status,init,check,push,pull,disconnect}`.
3. **[완료] 프론트 UI** — 사이드바에 `☁ 기기 동기화` 버튼 + 모달 4단계 (비활성 / 미연결 / 페어링 중 / 연결됨). localStorage 변경 시 6초 디바운스 자동 백업, 새 페어링 시 텔레그램 핀 백업이 있으면 자동 복원 제안.
4. **[완료] 비활성 모드 검증** — `TELEGRAM_BOT_TOKEN` 없을 때 `/api/sync/status` 가 `enabled: false` 반환, init/push 는 `503 sync-disabled` 거부. UI 는 "동기화 비활성" 표시.
5. **[대기] 운영자 봇 설정** — 사용자가 @BotFather 에서 봇 만들고 `TELEGRAM_BOT_TOKEN` 을 Render env var 에 등록해야 실제 동작. README 에 절차 명시.

### 라운드 1: 경제 캘린더 자동 수집 + 배포 검증 (2026-04-22)

1. **[완료] Toss 내부 API 리버스 엔지니어링** — 토스인베스트 `calendar-*.js` 청크에서 API 경로 추출 → `wts-info-api.tossinvest.com/api/v1/calendar/ai-summary/key-events` 가 인증 없이 접근 가능함을 확인. 응답 구조는 `result.eci.indicators[]` + `result.earnings[]`.
2. **[완료] server.js 자동 수집기 구현** — `refreshEvents()` + `fetchTossKeyEvents()` 추가. 서버 기동 10초 후 첫 수집, 이후 6시간마다 재수집. 미래 일정만 Top 5 추려 `events.json` 덮어쓰기.
3. **[완료] 로컬 테스트 → Render 배포** — 커밋 `bc6e490` 푸시 → Render 자동 재배포 → 프로덕션 `/api/events` 에서 `source: "toss-invest-ai-key-events"` 확인.

## 알려진 제약 / TODO

- **Render Free 플랜 콜드 스타트** — 15분 무요청 시 인스턴스가 잠들고 재기동에 30~60초. 프런트는 첫 방문에서 스피너가 길게 뜰 수 있음. 페어링 도중 콜드 스타트가 시작되면 `getUpdates` 폴링이 일시적으로 정지 — 사용자가 이미 봇에 메시지를 보냈다면 서버가 깨어나는 즉시 다음 폴링 사이클에서 잡힘 (대부분 60초 이내).
- **Telegram 페어링 폴링 충돌 위험** — 현재 1개 인스턴스 전제. 만약 미래에 multi-instance 로 가면 `getUpdates` offset 경합 발생. webhook 으로 전환하든가 sticky session 필요.
- **Toss API 의존성** — 비공식 엔드포인트라 스펙 변경 가능. 실패 시 `events.json` 이 그대로 남는 구조이므로 프런트가 빈 목록을 안 보지만, 구버전 데이터가 며칠 이상 정체될 수 있음. 로그 (`data/logs/server.log`) 에서 `events.refresh.*` 이벤트 주기 체크 필요.
- **이벤트 소스 다양화 미구현** — 지금은 토스 단일 소스. Trading Economics · Investing.com 은 스크래핑 난이도 높아 후순위.
- **캘린더 수동 강제 갱신 엔드포인트 없음** — 현재는 재배포해야 즉시 갱신됨. 필요하면 `/api/events/refresh` POST 추가 검토 (단, 공개 DDoS 우려로 비밀키 가드 필요).

## 파일 구조

```
seed-public/
├── index.html                 SPA 쉘 (자산·거래·그래프·이벤트 탭)
├── app.js                     프런트엔드 + localStorage 라우팅
├── styles.css                 Liquid Ledger 디자인 토큰
├── pdfImport.js               증권사 PDF 파서 (메모리 처리)
├── server.js                  Node HTTP 서버 + 모든 프록시 + 이벤트 자동 수집
├── package.json               의존성: pdf-parse
├── render.yaml                Render Blueprint
├── README.md                  배포 가이드 + 아키텍처
├── .gitignore                 node_modules, quote-cache, logs 제외
├── design/
│   ├── philosophy.md
│   └── poster.pdf
└── data/
    ├── events.json            Toss 에서 수집한 Top 5 (자동 갱신)
    ├── popular-tickers.json   공유 시세 자동 폴링 대상
    ├── quote-cache.json       시세 TTL 캐시 (런타임 생성, gitignore)
    └── logs/server.log        JSONL 로그 (런타임 생성, gitignore)
```

## 주요 API 엔드포인트

| 메서드 | 경로 | 역할 | 비고 |
|---|---|---|---|
| GET | `/healthz` | Render 헬스체크 | 200 "ok" |
| POST | `/api/quotes` | 시세 프록시 (Upbit + Naver + Yahoo) | 캐시 TTL: crypto 10s / stock_kr 30s / stock_us+fx+index 60s |
| GET | `/api/events` | 공유 캘린더 Top 5 | 자동 수집, 읽기 전용 |
| GET | `/api/history` | 과거 가격 시계열 | sparkline/chart 용 |
| POST | `/api/import-pdf` | 증권사 PDF 파싱 | 메모리에서만 처리 |
| GET | `/api/indices` | 8개 경제지표 (SPX/NDX/KOSPI/KOSDAQ/VIX/USDKRW/WTI/GOLD) | Yahoo 호출, TTL 60s |
| GET | `/api/stock-movers?market=kr\|us` | 급상승·급하락 Top 5 | Naver mobile+HTML, TTL 60s |
| GET | `/api/stock-search?q=...` | 종목 검색 자동완성 | Naver ac + Yahoo search, TTL 60s |
| GET | `/api/stock-news?limit=N` | 경제 뉴스 (실제 링크) | Naver mobile+HTML, TTL 5분 |
| GET | `/api/sync/status` | 동기화 활성 여부 + 봇 username | `TELEGRAM_BOT_TOKEN` 유무 |
| POST | `/api/sync/init` | 페어링 코드 발급 + getUpdates 폴링 시작 | 8분 TTL |
| GET | `/api/sync/check?code=X` | 페어링 진행 상태 폴링 | `awaitingConfirm` / `paired` 분기 |
| POST | `/api/sync/confirm` | 4자리 확인 코드 검증 후 cred 발급 | 5분 TTL, 시도 3회 제한 |
| POST | `/api/sync/push` | localStorage 스냅샷을 봇이 텔레그램 채팅에 핀 | Bearer cred |
| POST | `/api/sync/pull` | 텔레그램 채팅의 핀 메시지에서 백업 회수 | Bearer cred |
| POST | `/api/sync/disconnect` | 핀 해제 + 알림 메시지 | Bearer cred |
| * | `/api/accounts` `/api/transactions` `/api/snapshot` `/api/snapshots` | 410 Gone | localStorage 로 라우팅하라 |
| GET | `/data/*` | 403 Forbidden | 원본 JSON 노출 금지 |

## 다음에 시작할 때 체크리스트

1. 이 파일 먼저 읽기
2. `README.md` 의 아키텍처 다이어그램 참조
3. Render 대시보드에서 최근 배포 로그 확인 (https://dashboard.render.com → seed-ledger → Logs)
4. 필요 시 `node server.js 4275` 로 로컬 기동 → `http://localhost:4275/api/events` 로 수집 결과 확인
5. 작업 끝나면 이 HANDOFF.md 에 "최근 라운드에서 한 일" 섹션 추가 + 날짜 갱신

## 주요 파일 (빠른 참조)

| 파일 | 역할 |
|------|------|
| `server.js:620-631` | `handleEvents` - GET 전용 응답 |
| `server.js:~803-925` | `fetchTossKeyEvents` + `refreshEvents` - 자동 수집기 |
| `server.js:499-582` | `handleQuotes` - 시세 프록시 + 캐시 |
| `server.js:~930-` | Telegram 동기화 모듈 (`tgPostJson`, `signCred`, `handleSync*`) |
| `app.js:245-275` | 개인 이벤트 localStorage 로직 |
| `app.js:278-333` | `apiGet`/`apiPost` - 로컬 vs 네트워크 분기 |
| `app.js:~4090-` | `setupSync` + 페어링/백업/복원 로직 |
| `data/popular-tickers.json` | 공유 캐시 예열 티커 |

## 백업 위치

- GitHub 원격 저장소 자체가 소스 백업 (`origin main`).
- Render 가 빌드 아티팩트 보관 (최근 10개 배포).
- 로컬 `.bak.*` 파일 없음 (이 프로젝트는 파괴적 변경이 적음).
