# Seed · Liquid Ledger — 공개 배포판 HANDOFF

> 다음 세션에서 이어서 작업할 때 가장 먼저 읽어야 하는 문서.

최종 업데이트: 2026-04-22

## 현재 상태 한 줄 요약
Render 에 공개 배포되어 누구나 브라우저 localStorage 로 개인 자산을 기록하고, 서버는 시세·경제캘린더 Top 5 를 자동 수집해 공유한다.

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

## 최근 라운드에서 한 일 (2026-04-22)

### 라운드 제목: 경제 캘린더 자동 수집 + 배포 검증

1. **[완료] Toss 내부 API 리버스 엔지니어링** — 토스인베스트 `calendar-*.js` 청크에서 API 경로 추출 → `wts-info-api.tossinvest.com/api/v1/calendar/ai-summary/key-events` 가 인증 없이 접근 가능함을 확인. 응답 구조는 `result.eci.indicators[]` + `result.earnings[]`.
2. **[완료] server.js 자동 수집기 구현** — `refreshEvents()` + `fetchTossKeyEvents()` 추가. 서버 기동 10초 후 첫 수집, 이후 6시간마다 재수집. 미래 일정만 Top 5 추려 `events.json` 덮어쓰기.
3. **[완료] 로컬 테스트 → Render 배포** — 커밋 `bc6e490` 푸시 → Render 자동 재배포 → 프로덕션 `/api/events` 에서 `source: "toss-invest-ai-key-events"` 확인.

## 알려진 제약 / TODO

- **Render Free 플랜 콜드 스타트** — 15분 무요청 시 인스턴스가 잠들고 재기동에 30~60초. 프런트는 첫 방문에서 스피너가 길게 뜰 수 있음.
- **Toss API 의존성** — 비공식 엔드포인트라 스펙 변경 가능. 실패 시 `events.json` 이 그대로 남는 구조이므로 프런트가 빈 목록을 안 보지만, 구버전 데이터가 며칠 이상 정체될 수 있음. 로그 (`data/logs/server.log`) 에서 `events.refresh.*` 이벤트 주기 체크 필요.
- **이벤트 소스 다양화 미구현** — 지금은 토스 단일 소스. Trading Economics · Investing.com 은 스크래핑 난이도 높아 후순위.
- **캘린더 수동 강제 갱신 엔드포인트 없음** — 현재는 재배포해야 즉시 갱신됨. 필요하면 `/api/events/refresh` POST 추가 검토 (단, 공개 DDoS 우려로 비밀키 가드 필요).
- **HANDOFF.md 위치 표** — 본 프로젝트를 글로벌 `C:\Users\40000066\.claude\CLAUDE.md` 와 저장소 `D:\Claude\CLAUDE.md` 양쪽 HANDOFF 표에 추가해야 함.

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
| `server.js:~803-` | `fetchTossKeyEvents` + `refreshEvents` - 자동 수집기 |
| `server.js:499-582` | `handleQuotes` - 시세 프록시 + 캐시 |
| `app.js:245-275` | 개인 이벤트 localStorage 로직 |
| `app.js:278-333` | `apiGet`/`apiPost` - 로컬 vs 네트워크 분기 |
| `data/popular-tickers.json` | 공유 캐시 예열 티커 |

## 백업 위치

- GitHub 원격 저장소 자체가 소스 백업 (`origin main`).
- Render 가 빌드 아티팩트 보관 (최근 10개 배포).
- 로컬 `.bak.*` 파일 없음 (이 프로젝트는 파괴적 변경이 적음).
