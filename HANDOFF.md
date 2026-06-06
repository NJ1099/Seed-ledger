# Seed · Liquid Ledger — 공개 배포판 HANDOFF

> 다음 세션에서 이어서 작업할 때 가장 먼저 읽어야 하는 문서.

최종 업데이트: 2026-06-06 (라운드 17 — 연기금·외국인 순매수/순매도 상위 종목 judal 스타일 + 10분 자동 갱신)

> ⚠️ **배포 repo 주의**: 이 프로젝트(`E:\AI\Seed-ledger-main`)는 `E:\AI` 모노repo(→ `NJ1099/AI`)의 하위 폴더지만, **Render 배포는 별개 repo `https://github.com/NJ1099/Seed-ledger` 로만** 반영된다. 배포하려면 `E:\seed-ledger-sync`(NJ1099/Seed-ledger 클론)에 변경 파일 복사 후 `git push origin HEAD:main`. `NJ1099/AI` 로 푸시하면 백업만 되고 배포 안 됨.

## 현재 상태 한 줄 요약
Render 에 공개 배포되어 누구나 브라우저 localStorage 로 개인 자산을 기록하고, 서버는 시세·경제캘린더 Top 5 를 자동 수집하며, 텔레그램 봇을 통해 2단계 인증 기반 기기 간 동기화 옵션과 프라이버시 안내를 제공한다. 주식 탭에 8개 경제지표·삼성/SK하이닉스 Hyperliquid 야간선물·국내외 Top 5 등락주·종목 검색·국민연금 매수/매도 표 + 보유 도넛·**연기금/외국인 순매수·순매도 상위 종목(10분 자동 갱신)**·뉴스를 한 화면에 표시.

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

## 최근 라운드에서 한 일

### 라운드 17: 연기금·외국인 순매수/순매도 상위 종목 (judal 스타일) (2026-06-06)

라운드 16 의 `/api/krx-pension-top-stocks` 는 백엔드만 있고 UI 가 없었음. 사용자가 judal.co.kr 처럼 **연기금/외국인 × 순매수/순매도 4개 목록**을 보기 좋게 요청. KRX MDCSTAT02401 한 번 호출로 매수·매도 양쪽을 분리.

1. **[완료] 백엔드 (`server.js`)**
   - `fetchKrxPensionTopStocks(daysBack, market, invstTpCd='6000')` — 투자자코드 파라미터화 (6000=연기금 / 9000=외국인).
   - 신규 `GET /api/krx-investor-flows?investor=pension|foreign&days=N&market=ALL&limit=N` — 한 호출로 `buy`(netBuyVal>0 내림차순) / `sell`(netBuyVal<0 절대값 내림차순, `netSellVal` 포함) 분리 반환. 캐시 `__krx-flows:*` 10분 TTL.
2. **[완료] 프런트 (`app.js`+`index.html`+`styles.css`)**
   - 주식 탭 nps-portfolio 다음에 "연기금·외국인 순매수/순매도" 섹션. 기간 토글 7/30/90. 연기금/외국인 2블록 × 순매수|순매도 2컬럼. rank·종목명(네이버 증권 링크)·금액(`fmtKrwTrillion`, 매수 빨강/매도 파랑).
   - **10분 자동 갱신 + 카운트다운** — 표 위에 "🕒 10분마다 자동 갱신 · 다음 갱신 N분 후" 표시(`#flows-refresh-note`). `FLOWS_REFRESH_MS`=10분, 1분 틱(`state.flowsTicker`)으로 분 단위 카운트다운 후 0분에 `loadKrxInvestorFlows` 자동 호출. 탭 떠나면 쉬고 복귀 시 재개, `stopStockRefresh`에서 정리.
3. **[완료/되돌림]** data.go.kr 3070507 NPS 보유목록 시도는 uddi 필요 + 사용자가 judal 방식으로 선회하여 되돌림.

**검증**: 로컬 4291 라이브 — 연기금/외국인 매수·매도 모두 실데이터 정상 (외국인 순매도 삼성전자 30조 등). `node -c` OK.
**주의**: 프로덕션(Render)은 `KRX_ID`/`KRX_PW` 환경변수 등록돼야 동작. 미등록 시 섹션에 KRX 로그인 안내 표시.
**✅ 2026-06-06 해결**: 사용자가 Render Environment 에 `KRX_ID`/`KRX_PW` 등록 완료 → **프로덕션에서 연기금/외국인 순매수·순매도 정상 출력 확인**. (라운드 15~16 의 "Render 싱가포르 IP 차단" 우려는 기우였음 — IP 차단 아니고 단순 미배포 + env 미등록이 원인이었음.)

### 라운드 16: KRX 3단계 로그인 세션 + 연기금 순매수 상위 종목 + dead code 정리 (2026-06-06)

라운드 14/15 의 KRX endpoint 가 계속 HTTP 400. 원인을 **2025-12 KRX 데이터마켓플레이스 멤버십 전환 → 로그인 필수화** 로 보고, pykrx `auth.py` 의 로그인 플로우를 재구현. 더불어 사용자가 원래 원했던 "**연기금이 무슨 종목을 샀나**" (개별 종목 리스트) endpoint 를 신설. 커밋 `bd16137`.

1. **[완료] KRX 3단계 로그인 세션 (`server.js`)**
   - `buildKrxAuthSession()` — pykrx auth.py 3단계:
     1. `MDCCOMS001.cmd` GET → 초기 JSESSIONID
     2. `login.jsp?site=mdc` GET → iframe 세션 초기화
     3. `MDCCOMS001D1.cmd` POST (`mbrId`/`pw` form) → 실제 로그인
   - 응답 `_error_code`: `CD001` 성공 / `CD011` 중복로그인 → `skipDup:Y` 로 1회 재전송 / `CD010` 비밀번호 변경 필요.
   - `getKrxSession()` + `krxSessionCache` — 50분 TTL 메모리 캐시 (세션 만료 전 갱신).
   - **환경변수 `KRX_ID` / `KRX_PW`**. 미설정 시 `krx.session.no-creds` 경고 + 비인증 세션으로 진행 (로그인 전 조회 가능한 bld 한정).
   - User-Agent Chrome 131 풀 형식.

2. **[완료] 기존 일별 매매 400 원인 제거 (`server.js`)**
   - `fetchKrxPensionTradingSingle` 에서 우리가 임의로 넣었던 `share`/`money`/`csvxls_isNo` 파라미터 제거 (pykrx 가 안 보내는 값 → KRX 400 유발). 세션 쿠키 동봉. 400 시 캐시 무효화 후 1회 재시도.

3. **[완료] 연기금 순매수 상위 종목 endpoint 신설 (`server.js` + `app.js` + `index.html` + `styles.css`)**
   - `fetchKrxPensionTopStocks(daysBack, market)` — `bld = MDCSTAT02401`, `invstTpCd=6000`(연기금). 개별 종목 `ISU_SRT_CD`/`ISU_NM` + 매도/매수/순매수 수량·금액. 순매수 금액 내림차순.
   - `GET /api/krx-pension-top-stocks?days=30&market=ALL|STK|KSQ|KNX&limit=50`. 종목 조회 캐시 TTL 10분.
   - 주식 탭에 "연기금 순매수 상위 종목" 표 추가.

4. **[완료] dead code 정리**
   - `server.js`: 미사용 `safeMerge` 제거.
   - `app.js`/`index.html`/`styles.css`: 미사용 상수·함수·셀렉터 약 96줄 제거.

5. **[완료/세션] `.env.example` + `.env` 에 `KRX_ID`/`KRX_PW` 항목 추가** (이번 세션). 값은 사용자가 직접 입력.

6. **[완료/세션] KRX 로그인 진단 추가 (`server.js`)** — 2026-06-06 세션.
   - `buildKrxAuthSession` / `getKrxSession` 가 `errorCode` 반환·기록 (`krxLastAuth`). `getKrxSession` 이 더 이상 로그인 성패를 버리지 않음.
   - 신규 `GET /api/krx-auth-check` — 강제 로그인 1회 후 `{ hasCreds, authenticated, errorCode, hint }` 반환 (자격증명 값 미노출). `KRX_AUTH_HINT` 코드 매핑 (CD001/CD010/CD011/NO_CREDS/UNKNOWN).
   - `/api/config-status` 에 `krxAuth: { authenticated, errorCode, ts }` 추가 (마지막 시도 결과, 시도 전이면 null).

**검증**: `node -c` syntax OK.

**✅ 로컬 라이브 테스트 PASS (2026-06-06, 이 PC = E:\AI\Seed-ledger-main, port 4290)**
- `/api/krx-auth-check` → `{"authenticated":true,"errorCode":"CD001","hint":"로그인 성공"}` — **자격증명 유효 + 이 PC IP 로 KRX 로그인 성공.**
- `/api/krx-pension-top-stocks?market=STK` → **621 종목 실데이터** (1위 현대모비스, NAVER, 현대차, 삼성전자, 삼성생명).
- `/api/krx-pension-trading?market=STK` → 일별 순매수 정상 반환.
- **결론: 라운드 16 코드·자격증명·KRX 로그인 플로우 전부 정상.** 프로덕션 400 은 코드 문제가 아니라 **(1) Render 미배포 + (2) Render 싱가포르 IP 차단** 둘 중 하나(또는 둘 다).

**✅ 해결됨 (2026-06-06) — Render env 등록 + 라운드 16/17 배포로 프로덕션 KRX 정상 동작.** (아래는 진단 기록 보존용.)

**⚠️ (당시) 미해결 — KRX HTTP 400 지속 (사용자 KRX_ID/KRX_PW 입력 후에도)**
클라이언트 메시지: "KRX 정보데이터시스템(data.krx.co.kr) 이 일시적으로 응답하지 않거나 endpoint 가 변경됐을 수 있습니다." (= `/api/krx-pension-*` 가 `KRX HTTP 400` 반환).

**2026-06-06 세션 라이브 진단 결과 (curl 로 직접 확인):**
- `bd16137`(라운드 16) 은 `origin/main` 에 **push 완료**. 그러나 프로덕션(seed-ledger.onrender.com)의 `/api/krx-pension-top-stocks` 가 **404 Not Found** → **Render 가 아직 라운드 16 을 배포 안 함** (구 커밋 가동 중). Render 대시보드에서 Manual Deploy 또는 autodeploy/빌드 실패 여부 확인 필요.
- 프로덕션 `/api/krx-pension-trading` 은 `{"ok":false,"error":"KRX HTTP 400"}` — 즉 사용자가 본 400 은 **로그인 로직이 없는 구 endpoint** 응답.
- `/api/config-status` 프로덕션: `DART_API_KEY:true, DATA_GO_KR_SERVICE_KEY:true` (Render env 정상). **단 KRX_ID/KRX_PW 는 config-status 에 노출 항목이 아님 → 등록 여부 확인 불가.**
- 로컬 4274 는 `E:\AI\seed\`(구버전 자동시동) 이라 KRX endpoint 자체가 Not Found. 이번 작업본 `E:\AI\Seed-ledger-main` 과 별개.

**→ 사용자가 KRX_ID/KRX_PW 를 넣은 곳은 로컬 `.env` 인데, `.env` 는 Render 에 배포되지 않음.** 프로덕션에 적용하려면 **(1) 라운드 16 을 Render 에 배포 + (2) Render 대시보드 → Environment 에 `KRX_ID`/`KRX_PW` 등록** 두 가지가 모두 필요. 둘 다 해도 아래 (b) IP 차단이면 여전히 400 가능.

원인 후보 (로컬 PASS 로 좁혀진 결과):
- ~~(a) 로그인 성패 미노출~~ → **이번 세션 진단 추가로 해결** (`/api/krx-auth-check`, `config-status.krxAuth`).
- ~~(c) 데이터마켓플레이스 구독/약관 누락~~ → **반증됨** (로컬에서 동일 자격증명으로 MDCSTAT024xx 실데이터 정상 수신).
- ~~(d) 로그인 endpoint/payload 변경~~ → **반증됨** (CD001 로그인 성공).
- **(b) Render 싱가포르 IP 차단 — 유일하게 남은 유력 원인.** 코드/자격증명은 정상인데 프로덕션만 400 → data.krx.co.kr 가 Render 데이터센터 IP 를 차단했을 가능성. 코드 차원 해결 불가.

**다음 세션 절차**:
1. **Render 에 라운드 16 배포** (현재 프로덕션은 `/api/krx-pension-top-stocks` 가 404 = 구 커밋). Render 대시보드 Manual Deploy 또는 autodeploy/빌드 로그 확인.
2. **Render Environment 에 `KRX_ID`/`KRX_PW` 등록** 후 재배포 (로컬 `.env` 는 프로덕션에 안 감).
3. 배포 후 `https://seed-ledger.onrender.com/api/krx-auth-check` 호출 → `authenticated:true` 면 IP 통과(해결), `errorCode:UNKNOWN`/타임아웃이면 **(b) IP 차단 확정**.
4. (b) 확정 시: **KRX 공식 OpenAPI(openapi.krx.co.kr, 별도 키)** 또는 **한국투자증권 KIS API** 로 전환, 혹은 한국 리전 프록시 경유 (라운드 15 후보와 동일).

### 라운드 15: KRX 세션 쿠키 + data.go.kr NPS 포트폴리오 + 진단 정보 강화 (2026-06-05)

라운드 14 의 KRX endpoint 가 production 에서 계속 HTTP 400. 사용자 보고: 연기금 매수/매도 표가 안 보임. DART/goinsider 양쪽 폴백도 실패. data.go.kr 의 "국민연금공단_기금 포트폴리오 현황" OpenAPI 로 보강 결정.

**진단 (라운드 15 시점 production 응답)**:
- `/api/krx-pension-trading` → HTTP 400 (`KRX HTTP 400` 그대로)
- `/api/pension-flows` → DART 미설정 + goinsider HTTP 403 (Cloudflare 가 Render Singapore IP 차단). 라운드 13 때는 통과했었음 — 그 사이 차단됨.
- `/api/config-status` → DART_API_KEY false, DATA_GO_KR_SERVICE_KEY false (사용자 env 미적용 → 사용자가 Render 대시보드 등록 후 true 확인)

1. **[완료] config-status 진단 endpoint (`server.js`)**
   - 신규 `GET /api/config-status` — 키 등록 여부 boolean 만 노출. 민감 키 (NAVER_CLIENT_SECRET / ANTHROPIC_API_KEY / TELEGRAM_BOT_TOKEN) 와 length 는 자동 보안 리뷰 반영해서 응답에서 제외.
   - DART_API_KEY / DATA_GO_KR_SERVICE_KEY 두 가지만 boolean 노출.

2. **[완료] pension-flows 양쪽 실패 진단 강화 (`server.js` + `app.js`)**
   - `handlePensionFlows` 가 `sourceTrace: { dart, goinsider }` 응답에 포함. DART status 코드 + goinsider HTML 응답 크기·tr 개수·6자리 코드 개수·Cloudflare 감지.
   - 클라이언트가 진단 메시지로 "어느 단계가 왜 실패했는지" 화면에 직접 표시.

3. **[완료] KRX JSESSIONID 세션 쿠키 처리 (`server.js`)**
   - 에이전트 분석 결과: pykrx 의 `build_krx_session` 패턴이 필수. 먼저 `https://data.krx.co.kr/contents/MDC/MDI/outerLoader/index.cmd` GET 으로 JSESSIONID 받고 그 쿠키를 POST 의 `Cookie` 헤더에 동봉. 쿠키 없으면 400.
   - 신규 `fetchKrxSessionCookieOnce` + `getKrxSession` (10분 TTL 메모리 캐시).
   - `fetchKrxPensionTradingSingle` 가 호출 전 세션 확보. 400 응답 시 캐시 무효화 후 1회 재시도.
   - User-Agent 도 Chrome 126 풀 형식으로.
   - **production 결과**: 여전히 400 — Render Singapore IP 가 data.krx.co.kr 자체에서 차단된 가능성 큼. 코드 차원 해결 불가. 대안 endpoint 다음 라운드 후보.

4. **[완료] data.go.kr NPS 포트폴리오 endpoint (`server.js` + `app.js` + `index.html` + `styles.css`)**
   - 데이터셋 15106894 (국민연금공단_기금 포트폴리오 현황) 자동변환 OpenAPI.
   - Base URL: `https://api.odcloud.kr/api/15106894/v1/uddi:{uuid}`
   - UUID 는 사용자가 data.go.kr 마이페이지 → API 명세에서 받음 (기본 `365e3f72-e17e-4b10-a6ef-db2587ac3ee0`).
   - 신규 `/api/nps-portfolio?uddi=...&page=N&perPage=N`, TTL 6시간 (월별 데이터).
   - **serviceKey 인코딩 자동 retry**: 사용자가 Encoding 키 (URL-safe %2B/%2F 포함) 또는 Decoding 키 (+/) 중 어느 걸 등록했는지 모르므로 [raw, encodeURIComponent, decodeURIComponent] 순으로 시도. 400 + `code:-3` ("등록되지 않은 서비스") 면 다음 인코딩 자동 시도.
   - UUID 의 콜론(:) 은 `encodeURIComponent` 로 %3A 되면 odcloud 가 거절 → 콜론 보존.
   - 응답 구조 (자산군별 vs 종목별) 를 미리 알 수 없어 **클라이언트가 generic 표** 로 렌더링 — 첫 행의 키를 그대로 컬럼으로, 한국어 필드명 그대로 노출. 상위 50건 표시.
   - 신규 컴포넌트: `.nps-wrap / .nps-table-wrap / .nps-table / .nps-snippet` (에러 메시지의 code 블록).
   - 주식 탭의 4 번째 섹션으로 추가 (KRX 일별 매매 위, 국민연금 5% 변동 위).
   - 새 환경변수: `DATA_GO_KR_SERVICE_KEY` (`.env.example` 등록 완료).

**알려진 미해결**:
- **KRX 400**: Render Singapore IP 차단으로 추정. 세션 쿠키, Referer, User-Agent 모두 pykrx 와 동일하게 맞췄는데도 400. 다음 라운드 후보: (a) KRX 공식 OpenAPI (openapi.krx.co.kr, 별도 키), (b) 한국투자증권 KIS API (계좌+앱키), (c) FinanceDataReader 라이브러리 npm 포트.
- **goinsider 403**: Cloudflare 가 Render IP 차단. 다음 라운드 후보: (a) FnGuide HTML 스크래핑, (b) moneylog21 같은 다른 가공 사이트, (c) DART majorstock 을 corp_code 인덱싱 방식으로 재구성 (라운드 13 직후 에이전트 보고서 권장).
- **DART**: 사용자가 Render env 에 등록했지만 라운드 14/15 시점 `dartConfigured() === false`. DART_API_KEY 등록 자체가 안 됐을 가능성 (Save Changes 누락 또는 변수명 오타). `/api/config-status` 로 확인 가능.
- **NPS 응답 구조**: 등록되지 않은 서비스 에러가 키 인코딩 retry 후에도 계속되면, 사용자가 실제 활용신청한 데이터셋이 15106894 가 아닐 가능성. UUID 또는 데이터셋 ID 변경 필요할 수 있음.

---

## 이전 라운드 (2026-06-04)

### 라운드 14: KRX 연기금 일별 순매수 거래대금 추가 (2026-06-04)

사용자 확인: 라운드 13 의 goinsider 폴백은 정상 작동. 다만 DART/goinsider 둘 다 **5% 이상 보유 분기성 데이터** 라 매일 새로운 변동은 잘 안 잡힘. 사용자가 원래 보고 싶었던 "**일별 매수/매도**" 는 KRX 정보데이터시스템의 투자자별 거래실적이 정답.

**에이전트 보고서 핵심 (라운드 13 직후 회수)**:
- DART D001 의 status 013 ("데이터 없음") 이 사실 정상 — 5% 이상 보유 변동만 잡히므로 분기말 외에는 띄엄띄엄
- pykrx 가 KRX 내부 endpoint 를 스크래핑하는 패턴 검증됨
- 권장 조합: KRX 일별 매매 (풍성한 일별 흐름) + DART/goinsider 5% 보유 도넛 (분기 종합)

**검증된 endpoint (pykrx `core.py` 확인)**:
- `POST https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd`
- `bld = dbms/MDC/STAT/standard/MDCSTAT02203` (전체시장 일별추이 상세)
- 필수 파라미터: `mktId=ALL/STK/KSQ`, `strtDd/endDd` (YYYYMMDD), `askBid=3` (순매수), `trdVolVal=2` (거래대금), `detailView=1`, `inqTpCd=2`, `etf=EF/etn=EN/elw=ES`
- **응답 `output[i].TRDVAL7 = 연기금 순매수 거래대금**`. pykrx 가 검증한 컬럼.

1. **[완료] `httpsPostForm` 헬퍼 신규 (`server.js`)** — `application/x-www-form-urlencoded` body. zero-deps. `httpsPostJson` 과 동일 패턴.

2. **[완료] `fetchKrxPensionTrading(daysBack, market)` (`server.js`)**
   - 위 파라미터로 KRX 호출.
   - 응답 `output[]` 각 행에서 `TRD_DD` + `TRDVAL7` 추출, `{ date, netBuyValue }` 로 정규화.
   - 폴백 키: `trdval7` / `PENSION` 도 시도 (KRX 가 갱신 시 컬럼명 바꿀 위험 대비).
   - 최신순 정렬.

3. **[완료] `handleKrxPensionTrading(req, res)` (`server.js`)**
   - `GET /api/krx-pension-trading?days=N&market=ALL|STK|KSQ`.
   - 캐시 TTL 1시간. 응답 payload 에 `summary: { buyDays, sellDays, netSum }` 계산.
   - `source: 'krx'`, `sourceUrl` 포함.

4. **[완료] 클라이언트 — 신규 섹션 (`index.html` + `app.js` + `styles.css`)**
   - 주식 탭 4 번째 섹션 신설 "연기금 일별 순매수 거래대금 — KRX 시장 전체 (KOSPI+KOSDAQ)" — DART/goinsider 표보다 **위**에 배치 (일별이라 더 현실적인 흐름).
   - 기간 토글 7/30/90일.
   - 요약 카드 3개: 매수 우세 일수 / 매도 우세 일수 / 누적 순매수.
   - **Chart.js 막대 차트** — 일별 순매수 거래대금 (억원 단위). 빨강 = 매수, 파랑 = 매도.
   - 최근 5일 표 (거래일 / 순매수 거래대금 / 방향 라벨).
   - 신규 헬퍼 `fmtKrwTrillion` — 원 단위 → 조/억 자동 단위 + 부호.
   - 신규 함수 `loadKrxPensionTrading / fillKrxPensionTrading / renderKrxPensionChart / setupKrxPensionRange`.
   - 신규 스타일 `.krx-pension-wrap / .krx-pension-chart-wrap / .krx-pension-table`.

5. **[완료] 기존 DART/goinsider 표 라벨 변경 (`index.html`)**
   - 섹션 제목 "국민연금 매수·매도" → "**국민연금 5% 이상 보유 변동** — DART 대량보유 공시 (분기성)" 로 변경. 두 표가 서로 다른 데이터 (일별 vs 분기) 라는 점 명시.

**검증**:
- `node -c server.js / app.js` syntax OK.
- 로컬 서버 4280 부팅 정상. 외부 호출은 회사 프록시 TLS 차단으로 검증 불가 (예상).
- Render 배포 후 사용자 확인 필요: (1) KRX 차트에 일별 막대 표시 (2) 매수/매도 우세 일수 / 누적 순매수 요약 (3) 최근 5일 표.

**알려진 위험 / 후속**:
- **KRX endpoint 가 비공식**이라 KRX 가 `bld` 값 또는 응답 컬럼명을 바꾸면 깨짐. 정규식 대신 컬럼명 폴백 (`TRDVAL7 / trdval7 / PENSION`) 으로 일부 대응. 실패 로그 `krx.http` / `krx.parse` 모니터링.
- pykrx 도 KRX 변경 시 패치 잦음. 깨지면 pykrx 최신 master 의 core.py 다시 참고.
- 일별 데이터지만 장중에는 변동 없음 — 마감 후 KRX 가 batch 업데이트. 캐시 TTL 1시간이 적당.
- 종목별 일별 데이터 (개별종목 `MDCSTAT02303`) 는 추가 후보. 사용자 보유 종목 또는 검색 결과에 mini 차트로 매핑 가능.

---

### 라운드 13: Hyperliquid KRW 환산 메인 표시 + goinsider.kr 국민연금 폴백 (2026-06-04)

사용자 보고: ① Hyperliquid 야간선물 가격을 환율 적용해서 **한화 메인**으로 보여달라 ② DART 연기금 표가 여전히 안 나옴 → 다른 방법으로 매수/매도 데이터 찾아 수정.

**A. Hyperliquid KRW 환산 (`server.js` + `app.js` + `styles.css`)**

1. **[완료] 서버 — USDKRW 동시 fetch + payload 포함**
   - 신규 헬퍼 `getUsdKrwRate()` — `quote-cache.json` 의 `USDKRW` 가 60초 이내면 그대로, 아니면 `fetchYahoo(['KRW=X'])` 즉시 호출. 캐시 갱신까지 같이.
   - `handleNightFutures` 에서 Hyperliquid 호출과 환율 호출을 `Promise.all` 로 병렬 처리. payload 에 `usdKrwRate` 필드 추가.

2. **[완료] 클라이언트 — KRW 메인 + USD 서브**
   - `fillNightFutures(symbols, sources, units, usdKrwRate, diagnostics)` 시그니처 확장.
   - 메인 표기: `26,470원` (Math.round(markPx × usdKrwRate)). 뒤에 작은 글씨로 `· $19.34` 서브.
   - 전일 표기도 KRW 환산 ("전일 25,xxx원").
   - 풋노트: `Hyperliquid xyz:SMSN · ADR 환산 · 환율 1,367원 →` — 어떤 환율을 적용했는지 명시.
   - 신규 헬퍼 `formatKrwInt`, 신규 클래스 `.night-price-sub` (13px, ink-3 색).

**B. goinsider.kr 국민연금 폴백 소스 (`server.js` + `app.js` + `styles.css`)**

원인 분석: 사용자가 Render 환경변수에 DART_API_KEY 를 등록했다고 했지만 표가 안 보임 → 라운드 12-bis 의 status 진단 메시지가 어떤 코드인지 확인이 안 됐고, 가능성: (1) 인증 처리 1-2시간 대기 (010), (2) Render IP 차단 (012), (3) 일일 한도 (020), (4) 단순 데이터 부족 (013). 어느 경우든 **DART 키 외부 의존을 줄이는 대체 소스**가 답.

대안 조사 (WebFetch + WebSearch):
- **goinsider.kr/entity/national-pension** — SSR HTML, 별도 API 키 불필요, 표 8 컬럼 구조 (순번 / 종목명+코드+시장 / 보유금액 / 비중 / 변동 / 지분율 / 보고유형 / 보고일)
- 공공데이터포털 데이터셋은 CSV 파일 다운로드라 부적합
- KIND·KRX 정보데이터시스템은 인증 등록 복잡

3. **[완료] goinsider 파서 (`server.js`)**
   - `GOINSIDER_URL = 'https://goinsider.kr/entity/national-pension/?tab=timeline&timeline_limit=200'`.
   - `fetchGoinsiderPension(daysBack)`:
     - `httpsGetBuffer` 로 UTF-8 HTML 받음. `BROWSER_UA` (Chrome 126) 헤더.
     - `<tr>` 안에 6자리 종목코드가 들어있는 행만 후보 (광고/타이틀 행 배제).
     - `<td>` 들을 strip → 마지막 셀이 `YYYY-MM-DD` 면 보고일, 그 앞이 보고유형/지분율/변동/종목명 순으로 매핑.
     - `parseGoinsiderDelta` — ▲/▼ 또는 ±부호 + 단위 (K/M/B/만/억/조) 인식.
     - `parseGoinsiderName` — "삼성전자 005930 KOSPI" 같은 단일 셀에서 종목명·코드·시장 분리.
     - `daysBack` 컷오프 필터 + 날짜 내림차순.
   - 헬퍼 `stripHtmlTags`, `parseGoinsiderPercent` 신규.

4. **[완료] 자동 폴백 디스패처 (`server.js`)**
   - `handlePensionFlows` 재작성. 503 분기 제거 (DART 키 없어도 200 + goinsider).
   - 쿼리 `source=dart|goinsider|auto` (기본 auto).
   - 동작:
     1. `source≠goinsider && dartConfigured()` 면 DART 시도. 결과가 rows≥1 또는 totalReports≥1 이면 채택.
     2. 그 외 (DART 미설정 / 빈 응답 / 폴백) → goinsider 시도. 결과 rows≥1 이면 채택.
     3. 양쪽 모두 실패면 stale 캐시 또는 친절한 에러.
   - payload 에 `source: 'dart' | 'goinsider'` + `sourceUrl` 포함.
   - 캐시 키 `__pension:{days}:{source}` 로 source 별 분리.

5. **[완료] 클라이언트 source 노출 (`app.js` + `styles.css`)**
   - `loadPensionFlows` — 503 분기 제거 (서버가 항상 200 응답).
   - `fillPensionTable` 상단에 `.pension-source` 표시 — "데이터 출처: goinsider.kr (DART 공시 가공)" 링크.
   - 행의 DART 공시 링크가 없는 경우 (goinsider 행) "—" 표시.

**검증**: `node -c server.js / app.js` 양쪽 syntax OK. 로컬 서버 4279 부팅 정상, 외부 호출은 회사 프록시 TLS 차단으로 모두 실패 (예상대로). Render 배포 후 사용자가 (1) 야간선물 카드에 한화 표시 + USD 서브 (2) 국민연금 표가 DART 또는 goinsider 둘 중 하나로 채워지는지 + 출처 라벨 확인 필요.

**알려진 후속 가능성**:
- goinsider.kr 의 표 마크업 변경 위험. 6자리 코드 + 날짜 토큰 기반 정규식이라 비교적 견고하지만, 모니터링 필요. 실패 로그는 `pension.goinsider.empty`.
- DART 가 정상 복구되면 자동으로 DART 우선 (rows 가 비어있을 때만 폴백).
- 사용자가 `?source=goinsider` 또는 `?source=dart` 로 명시적 강제 선택 가능.

---

### 라운드 12-tri: Hyperliquid universe asset 이름 = ADR 티커 (SMSN/SKHX) 확정 (2026-06-04)

라운드 12-bis 의 prefix 매칭이 실제로는 미스 — `app.hyperliquid.xyz/trade/xyz:SAMSUNG` 의 URL 슬러그는 친숙한 별칭이지만 **universe 의 실제 asset 이름은 `xyz:SMSN` (Samsung ADR 티커) / `xyz:SKHX`**. URL 추측으로 매칭하면 100% 미스.

1. **[완료] HYPERLIQUID_ASSETS 메타데이터 테이블 (`server.js`)**
   - 기존 `HYPERLIQUID_SYMBOLS = ['SAMSUNG', 'SKHYNIX']` 제거.
   - 신규 `HYPERLIQUID_ASSETS` — 각 자산에 `key / universeName / urlSlug / label / unit` 명시.
     - `{ key: 'SAMSUNG', universeName: 'xyz:SMSN', urlSlug: 'xyz:SAMSUNG', label: '삼성전자', unit: 'USD' }`
     - `{ key: 'SKHYNIX', universeName: 'xyz:SKHX', urlSlug: 'xyz:SKHYNIX', label: 'SK하이닉스', unit: 'USD' }`
   - 매칭은 **exact match** (`universe[i].name === asset.universeName`) — prefix/endsWith 추정 제거.
   - 죽은 코드 `fetchHyperliquidPerpDexs` + `matchPerpSymbol` 제거. `perpDexs` 자동 탐색도 불필요 (정답을 알고 있음).
   - 단일 호출: `POST /info { type: 'metaAndAssetCtxs', dex: 'xyz' }` 만 시도.
   - 응답 payload 에 `units` 객체 추가 (`{ SAMSUNG: 'USD', SKHYNIX: 'USD' }`).

2. **[완료] 야간선물 카드 표시 갱신 (`index.html` + `app.js`)**
   - `index.html` 의 `.night-sym` 표기: `xyz:SAMSUNG` → `xyz:SMSN · ADR` (실제 asset 코드 + ADR 라벨).
   - `fillNightFutures` 가 `units` 인자 추가로 받음. 풋노트 포맷: `Hyperliquid {universeName} · USD (ADR 기준) →`.
   - `formatHlPrice` 가 USD '$' prefix + 소수점 1~4자리 (가격대별) 로 변경 — ADR 은 보통 $40~$80 범위.
   - 진단 메시지 재구성: `errors[]` 에 `key + universeName + err: 'not-found-in-universe'` 가 있으면 "universe 에서 xyz:SMSN 미발견 — 자산명 변경 가능성" 표시. HTTP 실패 / 응답 없음 케이스 별도 분기.

**핵심 인사이트**: HIP-3 빌더 DEX 의 URL 슬러그(사용자가 보는 페이지 주소)와 내부 universe asset 이름이 다른 경우가 있다. 라운드 12-bis 에서 prefix 매칭으로 "안전망" 을 짰지만 정답을 모르면 미스. 정답: ADR 티커 (해외 OTC 거래 코드) 를 universe 이름으로 사용.

**검증**: `node -c server.js / app.js` 양쪽 syntax OK. 로컬 호출은 회사 프록시 TLS 차단으로 여전히 불가. Render 배포 후 사용자가 야간선물 카드에 실제 가격 (예: $43.xx) 노출되는지 확인 필요.

**알려진 잔여 후속**:
- ADR 환산이 한국 원장가 ≠ ADR 가격이라 사용자가 원화 야간선물 가격을 기대하면 다를 수 있음. 카드 풋노트 "(ADR 기준)" 명시로 기대치 조정.
- DART 연기금 표 — 라운드 12-bis 의 진단 메시지가 사용자 화면에 나오면 status 코드(010/012/013/020) 확인 후 다음 라운드에서 대안 소스 결정.

---

### 라운드 12-bis: Hyperliquid universe.name 매칭 + DART status 진단 (2026-06-04)

사용자 보고: ① Hyperliquid 가격 반영 안 됨 ② DART_API_KEY 입력했는데도 연기금 표 안 나옴.

**Hyperliquid 원인 (Context7 + Hyperliquid 공식 문서 재확인)**:
HIP-3 빌더 DEX 의 `universe[i].name` 은 **`"{dex}:{symbol}"` prefix 형태** (예: `"xyz:SAMSUNG"`). 라운드 12 코드는 `name === 'SAMSUNG'` exact match 라 100% 미스.

1. **[완료] universe.name prefix 매칭 (`server.js`)**
   - `matchPerpSymbol(name, sym)` — 대소문자 무시 + 정확 일치 OR `endsWith(':SYM')` OR `endsWith('-SYM')`.
   - `fetchHyperliquidPerpDexs()` 신규 — `POST /info { type: 'perpDexs' }` 로 실제 builder DEX 이름 목록 자동 탐색.
   - 시도 순서: 'xyz' (있으면) → 발견된 다른 builder → 메인 DEX. perpDexs 가 빈 응답이어도 fallback 으로 'xyz' + 메인 시도.
   - 응답에 `diagnostics: { builderDexs, triedDexs, errors, universeSamples }` 포함 → 클라이언트가 사용자에게 표시.
   - 매칭 성공 시 `universeName / dex` 도 응답에 포함 → 어느 DEX 에서 가져왔는지 추적 가능.

2. **[완료] Night card 진단 메시지 (`app.js`)**
   - `fillNightFutures(symbols, sources, diagnostics)` — 시그니처 확장.
   - 가격 미발견 시 풋노트에 `Hyperliquid 빌더 DEX [xyz, abc, ...] 에서 미발견 (시도: xyz→abc→main)` 표시.
   - 가격 발견 시 풋노트에 `Hyperliquid 야간선물 (xyz · xyz:SAMSUNG) →` 표시 (어느 DEX 인지 명시).

**DART 원인 (가능성 다중)**:
- 키가 막 발급되어 미인증 (status 010) — DART 측 처리에 1-2시간 걸리는 경우 있음
- Render Environment 에 추가했지만 재배포 안 됨
- 키 길이 검증 (`>= 30`) 통과 못함 (DART 키는 40자, 정상이어야 통과지만 trim 안 했을 때 공백 포함하면 실패 가능)
- 일일 한도 초과 (status 020)
- IP 차단 (status 012) — Render 데이터센터 IP

3. **[완료] DART 키 검증 완화 + status 추적 (`server.js`)**
   - `dartConfigured()`: 키 trim() 후 길이 20자 이상 (40자 키 + 앞뒤 공백 흡수).
   - `dartKey()`: trim() 적용.
   - `DART_STATUS_MSG` 코드별 한국어 사유 매핑 (010/011/012/013/020/021/100/101/800).
   - `fetchDartList()` → `{ list, meta: { lastStatus, lastMessage, httpStatus, dateRange } }` 반환 (구조 변경).
   - `fetchPensionFlows` / `handlePensionFlows` payload 에 `dartMeta` 포함.

4. **[완료] 클라이언트 DART 진단 메시지 (`app.js`)**
   - `fillPensionTable` 빈 결과 분기를 status 별로 세분화:
     - `010/011` → "DART 인증키가 인증되지 않았습니다. 1-2시간 대기 또는 Render 환경변수 재확인."
     - `020/021` → "DART 호출 한도 초과 (일일 1만)"
     - `012` → "IP 차단"
     - `013` → "전체 보고 N건 중 0건 매칭. 기간을 늘려보세요 (90일 권장)"
     - 그 외 → status 코드 + 메시지 노출.
   - **DOM 안전성**: 메시지는 모두 `esc()` escape 적용. 진단 HTML 은 `innerHTML` 사용해도 사용자 입력 없는 정적/escape 된 데이터만 들어가므로 안전.

**검증**: `node -c` 양쪽 syntax OK. 로컬 호출은 회사 프록시 TLS 차단으로 여전히 불가. Render 배포 후 사용자가 실제 응답 확인 필요.

**Render 배포 후 확인 절차 안내**:
1. 사용자가 주식 탭 새로고침 → 야간선물 카드 풋노트에 어떤 메시지 뜨는지 확인.
   - "빌더 DEX [...] 에서 미발견" → DEX 이름 목록 알려주면 다음 라운드에 그 이름으로 명시 추가 가능.
   - "응답 비어있음" → perpDexs 자체가 실패 — Render Logs 의 `hl.perpDexs.http` 확인.
2. 연기금 표 빈 결과 메시지 확인:
   - "인증되지 않았습니다 (010)" → Render env DART_API_KEY 값 재확인.
   - "전체 N건 중 0건 매칭" → 키는 정상, 단순히 데이터 부족 — 90일 토글 시도.

---

### 라운드 12: 연기금 보유 도넛 · Hyperliquid 야간선물 · 뉴스/검색 폴백 강화 · 푸터 정리 (2026-06-04)

사용자 피드백 (한꺼번에): ① DART 연기금 표에 보유량 **원형그래프** 추가 ② 한글 검색 결과를 클릭하면 stock.naver.com 이 "없는 종목"이라 함 → **finance.naver.com** 으로 이동 ③ 주식 관련 **뉴스가 안 나옴** ④ 삼성·SK하이닉스 **Hyperliquid 야간선물**(`xyz:SAMSUNG`, `xyz:SKHYNIX`) 가격 반영 ⑤ 푸터 "POWERED BY 리어카" → "**made by rearcar**" + 텔레그램(`https://t.me/pejirearcar`) + 이메일(`pejirearcar@gmail.com`) 링크.

1. **[완료] 연기금 보유 도넛 (`server.js` + `app.js` + `styles.css`)**
   - 서버: `fetchPensionFlows` 가 rows 외에 `holdings` 배열 추가 반환. 같은 corpName 의 여러 보고가 있으면 가장 최근 rceptDt 의 `holdingQty / holdingRate` 채택. holdingRate 내림차순 정렬.
   - 응답 payload: `{ rows, holdings, totalReports, daysBack, ts }`.
   - 클라이언트: `buildPensionDonutHtml + renderPensionDonut` 신규. Chart.js 4.4 doughnut, 상위 12개 + "기타" 1조각.
   - 도넛 색상 팔레트 15색 (`PENSION_DONUT_COLORS`) — 한국식 빨/파 + 그린/옐로 + 보조색. cutout 65% (중앙에 종목수 표시).
   - 범례: 종목별 swatch + 이름 + `지분율 · 비중` 표기. 종목 클릭 시 finance.naver.com 새 탭. **DOM API 로 구성 (XSS 방지)**.
   - 기간 토글(7/30/90일) 변경 시 `state.charts.pensionDonut.destroy()` 로 누수 방지.
   - 모바일: 240px → 200px, body grid 1열.

2. **[완료] 종목 클릭 URL 을 finance.naver.com 기반으로 교체 (`app.js`)**
   - **원인**: 일부 종목 (우선주·일부 ETF·KOSDAQ 일부) 은 stock.naver.com 의 도메스틱 페이지에 등록 안 됨 → "없는 종목" 표시.
   - **수정**: `buildNaverStockUrl` — 국내 6자리는 `https://finance.naver.com/item/main.naver?code=NNNNNN` 로 (모든 상장 종목 99%+ 등록). 해외는 그대로 stock.naver.com (해외는 finance.naver.com 에 없음). 코드 모르면 `finance.naver.com/search/searchList.naver?query=...` 검색 페이지로.
   - 영향 범위: 검색 결과 dropdown, 급상승/하락 Top 5 mover-row, 연기금 표 종목 클릭, 연기금 도넛 범례 — 모두 동일 헬퍼 사용하므로 한 곳만 수정.

3. **[완료] 한글 검색 finance.naver.com HTML 폴백 (`server.js`)**
   - 기존 4단계 폴백 (master/stock.naver/m.stock/polling/ac.finance/yahoo) 에 4-bis 단계 추가.
   - URL: `https://finance.naver.com/search/searchList.naver?query=...` EUC-KR HTML → `httpsGetBuffer` 로 디코딩.
   - 정규식: `<a href="/item/main.naver?code=NNNNNN">종목명</a>` 패턴 매칭.
   - 결과 KOSPI 기본 (정확한 거래소 정보는 페이지에 없음).

4. **[완료] 뉴스 — 네이버 검색 API 전용 (`server.js`)**
   - **사용자 명시 (라운드 12 후속)**: "뉴스는 네이버뉴스에서 검색 API 이용해서 보여줘" → 다른 매체가 섞이는 걸 차단.
   - **수정**: `fetchStockNews` 가 키 설정 시 네이버 OpenAPI 결과만 사용. 빈 응답이어도 stock.naver/m.stock/finance.naver/Google News 폴백 안 함 → `return []`.
   - **키 미설정 시에만 폴백 체인** 활성화 (stock.naver → m.stock → finance.naver(EUC-KR) → Google News RSS). 첫 배포 시 빈 화면 방지용 안전망.
   - 디폴트 쿼리 `"주식 시황"` → `"코스피"` (한국 경제뉴스 매칭률 ↑).
   - Google News RSS 폴백 코드 자체는 보존 (`fetchGoogleNewsRss`) — `.env` 잊은 첫 사용자를 위한 최후 안전망.

5. **[완료] Hyperliquid 야간선물 (`server.js` + `index.html` + `app.js` + `styles.css`)**
   - 신규 헬퍼 `httpsPostJson(url, body, opts)` — zero-deps, hyperliquid /info RPC 호출용.
   - `fetchHyperliquidPerp()`: 2단계 시도.
     - 1) HIP-3 빌더 DEX: `POST /info { type: 'metaAndAssetCtxs', dex: 'xyz' }`
     - 2) 메인 DEX: `POST /info { type: 'metaAndAssetCtxs' }` (혹시 등록되어 있으면)
   - 응답 구조: `[meta, ctxs]` 에서 `meta.universe[i].name === 'SAMSUNG' | 'SKHYNIX'` 인덱스 매칭 후 `ctxs[i]` 의 `markPx / oraclePx / prevDayPx / openInterest / dayNtlVlm` 추출.
   - 신규 엔드포인트 `GET /api/night-futures` — `{ symbols: { SAMSUNG: {...}, SKHYNIX: {...} }, sources: { SAMSUNG: 'https://app.hyperliquid.xyz/trade/xyz:SAMSUNG', ... }, labels: { SAMSUNG: '삼성전자', SKHYNIX: 'SK하이닉스' } }`.
   - TTL 30초.
   - UI: 주식 탭 경제지표 다음, 종목 검색 위에 `night-grid` (2열 → 모바일 1열). 카드 hover transform + 상단 그린 그라데이션 라인.
   - 표시: 종목명 + `xyz:SYMBOL` 코드 + Mark Price + 24h 변동률 (markPx vs prevDayPx) + "Hyperliquid 야간선물 →" 풋. 카드 자체가 `<a target="_blank">`.
   - `formatHlPrice` 가격대별 소수점: ≥10000 정수, ≥100 소수점 2자리, ≥1 소수점 3자리.
   - **DOM API 로 변동률 영역 구성 (XSS 방지)**.

6. **[완료] 푸터 "made by rearcar" + 연락처 링크 (`index.html` + `styles.css`)**
   - 사이드바 하단 `powered-by` 영역 재구성:
     - 상단: `made by rearcar` (캡스, letter-spacing 0.18em, ink-4 color).
     - 하단 pill 두 개: Telegram (`https://t.me/pejirearcar`, target=_blank) / Email (`mailto:pejirearcar@gmail.com`, mailto 라 target 불필요).
   - 호버 시 accent-soft 배경 + accent 텍스트. 아이콘 ✈ / ✉ (이모지 아님, 단순 텍스트 문자).

**검증**:
- `node -c server.js` / `node -c app.js` 양쪽 syntax OK.
- 로컬 4278 포트 기동 → 서버 startup 정상, dotenv 5개 변수 로드 확인. 외부 호출은 회사 프록시 TLS 차단으로 모두 실패 (라운드 6/7/9/10/11 동일).
- Render 배포 후 사용자 검증 필요:
  - Hyperliquid: `xyz:SAMSUNG / xyz:SKHYNIX` 가 메인 DEX 또는 'xyz' 빌더 DEX 어느 쪽에 있는지 확인. 둘 다 안 잡히면 hyperliquid spot/perp 정확한 endpoint 추가 조사 필요 (응답 로그 `hl.http` / `hl.empty` 체크).
  - 연기금 도넛: holdings 가 비어있으면 (rows 중 holdingQty/holdingRate 둘 다 없음) 도넛 미표시 — 정상 폴백.

**알려진 후속 가능성**:
- Hyperliquid 가 두 시도 모두 빈 응답이면 spot 토큰 가능성 — `{ type: 'spotMetaAndAssetCtxs' }` 추가 시도해야 함 (rows[0].universe[i].tokens 로 base token 매핑 필요해 복잡).
- 뉴스 Google RSS 가 가끔 redirect URL (`news.google.com/rss/articles/...`) 만 주는 경우 — description 내부 `<a href>` 가 없으면 link 그대로 사용 (사용자가 Google News 로 한 번 거쳐 매체로 이동).

---

### 라운드 11: DART 국민연금 매수/매도 표 + 뉴스 콤팩트 (2026-06-04)

사용자 피드백: ① goinsider.kr/entity/national-pension 같은 국민연금 매수/매도 표 ② nabakai 와 똑같은 게 아니라 현재 사이트(Liquid Ledger) 톤에 맞게 ③ 뉴스는 요약 없이 제목+링크만 ④ API 키 평문 노출 금지.

**원천**: goinsider 와 동일한 DART(전자공시시스템) 의 **주식등의 대량보유상황보고서 (D001)** — 5% 이상 보유 기관의 보유 변동 시 의무 공시. 국민연금공단이 매수/매도하면 여기에 잡힘 (다만 즉시 거래 데이터가 아니라 **공시 기반**이라 변동률 1% 이상 또는 신규 5% 진입 시 5영업일 이내 보고).

1. **[완료] `.env.example` 에 DART_API_KEY 추가**
   - 발급: https://opendart.fss.or.kr → 회원가입 → 인증키 신청 (즉시, 무료, 40자).
   - 일일 1만 호출 무료.
   - `NAVER_CLIENT_ID/SECRET` 와는 별개 키.
   - **평문 노출 보호**: 코드 어디서도 `process.env.DART_API_KEY` 값을 로그/응답/UI 에 직접 출력 X. `dartConfigured()` 가 boolean 만 반환. URL 에 들어가는 `crtfc_key` 도 로그 시 path 부분만 남기지 않고 status/page 같은 메타만 기록 (logLine 호출 시 url 인자 사용 안 함).

2. **[완료] `/api/pension-flows?days=N` 신설 (`server.js`)**
   - `fetchDartList(daysBack)` — `opendart.fss.or.kr/api/list.json?pblntf_detail_ty=D001` 으로 최근 N일 대량보유 공시 검색. 5페이지 (최대 500건) 까지. 응답 status 코드 처리 (`013` 데이터 없음, `020/021` 한도 초과).
   - `flr_nm` 가 "국민연금공단" 인 것만 필터.
   - `fetchDartMajorStockByCorp(corpCode)` — 발행회사별 대량보유 보고 받아 `rcept_no` 매칭으로 정확한 변동 수량/비율 추출. corp 별 1회만 호출 (메모리 dedupe).
   - `inferPensionEventType(reportNm, qtyDelta, rateDelta)` — `신규` / `buy` (+변동) / `sell` (-변동) / `hold` / `unknown`.
   - 응답 행: `{ rceptDt, corpName, stockCode, type, holdingQty, changeQty, holdingRate, changeRate, reportResn, dartUrl }`.
   - 캐시 TTL **24시간** (대량보유 보고는 변동 시점이 띄엄띄엄).
   - 키 없으면 `503 + hint` 응답.

3. **[완료] 연기금 표 UI (`index.html`, `styles.css`, `app.js`)**
   - 주식 탭의 뉴스 섹션 **바로 위** 에 신규 섹션 — "국민연금 매수·매도" + 기간 토글 (7일/30일/90일).
   - 표 구조: 접수일 · 종목 · 구분(매수/매도/신규 뱃지) · 변동 수량 · 변동 비율 · 보유 비율 · DART 공시 링크.
   - 상단 요약 카드 3개: 매수·신규 N건 / 매도 N건 / 전체 N건.
   - 종목 클릭 → 네이버 증권 (라운드 9 흐름 재사용), DART 링크 → 공시 원문.
   - 한국식 빨강(매수=`--up`)/파랑(매도=`--down`) + 신규는 accent(파랑).
   - 키 없을 때 UI 친절 안내 (발급 절차 inline link).
   - 모바일: 표 컬럼 일부 hide-sm, 요약 카드 3열 → 1열.

4. **[완료] 뉴스 콤팩트화 (`app.js`, `styles.css`)**
   - 사용자 요청에 따라 **요약 제거** — 제목 + 매체명 + 시간만 표시.
   - `.news-item--compact` 클래스로 패딩·폰트 축소. 더 많은 뉴스를 같은 공간에.
   - 네이버 OpenAPI 가 0차로 동작 중이라 데이터 소스는 그대로 (라운드 10 의 통합 유지).

**평문 노출 점검**: `git diff` 에서 `process.env.DART_API_KEY` 의 사용처를 grep — 헤더/URL 빌더 함수 안에만 등장. 로그·응답·UI 어디에도 키 값 자체가 들어가지 않음. `.env` 는 `.gitignore` 등록되어 GitHub 비공개.

**검증**: 로컬 회사 프록시 TLS 차단으로 직접 호출 불가. `node -c server.js / app.js` syntax OK. Render 배포 후 사용자가 `DART_API_KEY` 등록 → 새로고침 시 활성화 확인 필요.

**`.env` 키 등록 안내 (이번 라운드 신규)**:
- 로컬: `D:\Claude\seed-public\.env` 에 `DART_API_KEY=...` 추가.
- Render: 대시보드 → seed-ledger → Environment → `DART_API_KEY` 추가.

---

### 라운드 11 — 다음 라운드 후보 (Phase 2 남은 항목)

이전 라운드 10 의 후보 4개 중 **연기금** (난이도 ★★☆) 이번에 완료. 남은:

1. **외인·기관·개인 수급 표** (난이도 ★★☆ — 라운드 12 후보)
   - 소스: 네이버 `sise_quant.naver` (외국인 순매수 상위, EUC-KR HTML) 또는 종목별 `frgn.naver`.
   - 신규 엔드포인트 `/api/investor-flows?market=kr&type=foreign|institution|individual`.
   - UI: 연기금 표 옆 또는 위에 "오늘의 외인/기관 순매수 Top 5".

2. **뉴스 AI 요약** (난이도 ★★★ — `ANTHROPIC_API_KEY` 필요)
   - 사용자가 라운드 11 에서 "뉴스는 요약 안 해도 된다" 명시 → **후순위 또는 제외**.

3. **nabakai 스타일 통합 대시보드 레이아웃** (난이도 ★★☆)
   - 현재 사이트 톤 유지하면서 한국장·미국장 카드 그리드 확장.
   - 인기 종목 실시간 가격 + 등락률 (popular-tickers.json 결과 노출).

4. **종목 클릭 시 미니 차트 모달** — 라운드 7 부터 후보. 현재 네이버 증권 새 탭으로 처리 중이라 사용자가 원할 때만.

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
| GET | `/api/stock-news?limit=N` | 경제 뉴스 (실제 링크) | 키 있으면 NaverOpenAPI 전용 / 없으면 stock.naver → m.stock → finance.naver(EUC-KR) → Google News RSS, TTL 5분 |
| GET | `/api/night-futures` | 삼성·SK하이닉스 야간선물 | Hyperliquid HIP-3 `xyz:` builder DEX, TTL 30s |
| GET | `/api/pension-flows?days=N` | 국민연금 5% 이상 보유 변동 (분기성) | DART D001 → goinsider.kr 자동 폴백, TTL 24h |
| GET | `/api/krx-pension-trading?days=N&market=ALL` | 연기금 일별 순매수 거래대금 | KRX `MDCSTAT02203` 비공식 + JSESSIONID 세션 쿠키, TTL 1h. Render IP 차단 의심 |
| GET | `/api/nps-portfolio?uddi=...&page=N&perPage=N` | 국민연금 기금 포트폴리오 | `api.odcloud.kr/api/15106894/v1/uddi:...`, DATA_GO_KR_SERVICE_KEY, TTL 6h |
| GET | `/api/config-status` | 환경변수 등록 여부 진단 | DART/DATA_GO_KR boolean 만 |
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
