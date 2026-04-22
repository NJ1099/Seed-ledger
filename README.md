# Seed · Liquid Ledger — 공개 배포판

현금·저축·예적금·주식·코인·부동산을 한 화면에서 입력/평가하고, 실시간 시세로 자산 변동을
시각화하는 단일 페이지 자산 포트폴리오 대시보드. 이 저장소는 **누구나 자신의 브라우저에서
독립적으로 쓸 수 있는 공개 배포판** 이다.

## 핵심 원칙

- **개인 데이터는 서버로 가지 않는다.** 계좌, 거래, 자산 스냅샷은 전부 브라우저
  `localStorage` 에 저장된다. 다른 사용자의 기기와 완전히 분리된다.
- **서버는 공공 정보만 프록시한다.** 주식·코인·환율 시세와 주요 이벤트 캘린더
  (FOMC · 실적 · CPI 등) 만 서버 쪽에서 캐시·제공한다.
- **브라우저 저장소를 비우면 초기화된다.** 개발자 도구 → Application → Local Storage 에서
  `seed:*` 키를 삭제하면 백지 상태로 돌아간다.

## 로컬 실행

```bash
npm install
npm start            # 기본 포트 4274
# 또는
PORT=4275 npm start  # 포트 지정
```

브라우저에서 `http://localhost:4274/` 로 접속. 최초 접속 시 계좌·거래가 비어 있고,
자산 탭의 `+` 버튼으로 직접 추가하거나 증권사 PDF 를 드래그·드롭해 일괄 등록할 수 있다.

## Render 로 배포

이 저장소 (혹은 `seed-public/` 서브폴더) 를 GitHub 에 올리고 Render 대시보드에서
**New → Blueprint** 로 연결하면 `render.yaml` 이 자동으로 해석된다. 별다른 설정 없이
무료 플랜으로 바로 뜬다.

수동 설정을 원하면:

| 항목 | 값 |
|---|---|
| Environment | Node |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/healthz` |

`PORT` 환경변수는 Render 가 자동 주입하므로 건드리지 않는다.

## 데이터 아키텍처

```
┌──────────────────────┐       ┌──────────────────────┐
│  브라우저 (사용자)    │       │  Render 서버         │
│                      │       │                      │
│  localStorage        │       │  data/quote-cache    │
│   ├ seed:accounts    │       │  data/events.json    │
│   ├ seed:transactions│       │  data/popular-tick.. │
│   ├ seed:snapshots   │       │                      │
│   └ seed:events:per..│       │  /api/quotes  ────┐  │
│                      │  ──→  │  /api/events (GET)│  │
│                      │       │  /api/history     │  │
│                      │       │  /api/import-pdf  │  │
│                      │       └───────────────────┼──┘
│                                                  │
│                      Upbit · Naver · Yahoo ←─────┘
└──────────────────────┘
```

- 자산 탭의 `+` 로 추가한 계좌 → `seed:accounts` 키에 저장.
- 거래 탭의 `+` 로 추가한 거래 → `seed:transactions` 키.
- 매일 자동으로 잡히는 스냅샷 → `seed:snapshots` 키 (날짜별 객체).
- 이벤트 탭: 서버의 공유 이벤트 + 사용자가 추가한 개인 이벤트(`seed:events:personal`) 가
  합쳐져 표시된다.

## 보안·프라이버시 요약

- 서버는 쓰기 가능한 사용자 데이터 엔드포인트 (`/api/accounts`, `/api/transactions`,
  `/api/snapshot`) 를 전부 차단했다. 호출하면 `410 Gone` 으로 응답한다.
- `/api/events` 는 GET 전용. POST/PUT/DELETE 는 `403` 으로 거부.
- `/api/import-pdf` 는 PDF 를 메모리에서만 파싱하고 디스크에 저장하지 않는다.
- `data/` 폴더 자체는 URL 로 직접 서빙되지 않는다. 전용 API 만 통한다.

## 파일 구조

```
seed-public/
├── index.html              SPA 쉘
├── app.js                  전체 프런트엔드 로직 + localStorage 스토어
├── styles.css              "Liquid Ledger" 디자인 토큰
├── pdfImport.js            서버 측 PDF 파서 (토스증권 등)
├── server.js               Node HTTP 서버 (시세·이벤트 프록시)
├── package.json            의존성: pdf-parse 하나
├── render.yaml             Render Blueprint
├── design/
│   ├── philosophy.md       디자인 철학 문서
│   └── poster.pdf          A3 포스터
└── data/
    ├── events.json         공유 이벤트 목록 (관리자가 직접 편집)
    ├── quote-cache.json    시세 TTL 캐시 (자동 생성)
    └── popular-tickers.json  자동 폴러 대상 목록 (자동 생성)
```

## 주요 이벤트 (공유 캘린더) 관리

서버가 **토스증권 공개 AI 캘린더 API** 에서 "이번 주 핵심 이벤트" 상위 5개를
6시간 주기로 자동 수집해 `data/events.json` 에 덮어쓴다. 서버 기동 후 10초 안에
첫 번째 수집이 실행된다.

- 소스: `https://wts-info-api.tossinvest.com/api/v1/calendar/ai-summary/key-events`
- 선정 기준: 토스증권이 큐레이션해 내보내는 경제지표 + 주요 실적 발표 중 **미래 일정만** 추린 Top 5
- 실패 시: 기존 `events.json` 을 그대로 두고 다음 주기에 재시도 (프런트가 빈 목록을 보지 않도록 보수적 처리)

사용자가 앱에서 개별로 추가한 이벤트는 브라우저 `localStorage` 에만 남고,
서버 이벤트와 합쳐서 표시된다.

## 라이선스

사적 용도 기준으로 개발된 프로젝트. 배포·수정·상업적 이용 시 별도 고지 필요 없음.
