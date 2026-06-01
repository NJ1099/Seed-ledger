# Seed · Liquid Ledger — 공개 배포판 HANDOFF

> 다음 세션에서 이어서 작업할 때 가장 먼저 읽어야 하는 문서.

최종 업데이트: 2026-06-01

## 현재 상태 한 줄 요약
Render 에 공개 배포되어 누구나 브라우저 localStorage 로 개인 자산을 기록하고, 서버는 시세·경제캘린더 Top 5 를 자동 수집하며, 텔레그램 봇을 통해 2단계 인증 기반 기기 간 동기화 옵션과 사용자 대상 프라이버시 안내를 제공한다.

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

## 최근 라운드에서 한 일 (2026-06-01)

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
