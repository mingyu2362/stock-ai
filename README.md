# 차트·뉴스·공시 융합 AI 주가 예측 및 모의투자 자동매매 시스템

2026-2 인공지능서비스개발 II 팀 프로젝트

> 차트 기술지표, 뉴스 감성, 기업 공시를 함께 학습한 AI가 다음 거래일 주가 방향을 예측하고,
> 판단 근거를 설명하며, 백테스트와 한국투자증권 모의투자로 성과를 검증한다.

**연구 질문**: 거래 비용과 데이터 누수를 통제해도, 뉴스·공시 정보는 차트만 쓴 예측보다 나은가?

## 폴더 구조

| 폴더 | 역할 |
| --- | --- |
| `collect/` | 주가·뉴스·공시·시장 지표 수집 |
| `features/` | 차트 지표, 감성 점수, 공시 피처 |
| `model/` | 모델 A~D 학습, 백테스트, SHAP |
| `trade/` | 한국투자증권 모의투자 API, 매일 실행 흐름 |
| `dashboard/` | 웹 대시보드 (React + Vite, Vercel 배포). `export.py` 가 화면용 JSON 생성 |
| `notebooks/` | 실험용 노트북 |
| `data/` | raw(원본), processed(피처), predictions(예측), trades(거래 기록) |
| `config.py` | 대상 종목, 기간, 매매 기준 등 설정 |

## 시작하기

```bash
git clone <저장소 주소>
cd stock-ai
pip install -r requirements.txt
cp .env.example .env    # 윈도우: copy .env.example .env
# .env 에 API 키 입력
```

## 대시보드 (dashboard/)

```bash
python dashboard/export.py --backtest   # 화면용 JSON → dashboard/public/data/ (--backtest 는 가끔만)
cd dashboard
npm install
npm run dev                             # http://localhost:5173
```

- 화면: 오늘의 추천·주문 / 계좌 현황 / 실전 성과 / 시장·공포지수 / 실시간 순위(네이버 증권) / 백테스트·연구, 종목 이름을 누르면 종목 상세(캔들 차트, `api/stock.js`)
- 매일 `python model/daily.py` 가 마지막에 `export.py` 를 실행 → `dashboard/public/data` 를 커밋·푸시하면 Vercel 이 자동 배포
- Vercel 설정: 저장소 연결 후 **Root Directory = `dashboard`** (빌드 명령·출력 폴더는 `vercel.json`)
- 실시간 순위는 `dashboard/api/naver.js` 서버리스 함수가 네이버 증권에서 받아 전달 (공식 API 아님)
- 계좌 현황은 사용자가 자기 한투 모의투자 앱 키를 입력해 자기 계좌만 조회 (키는 그 사람 브라우저에만 저장, `dashboard/api/account.js` 는 저장 없이 잔고 조회만 중계, 주문 기능 없음). Vercel 에 KIS 키를 넣을 필요 없음
- 실전 성과는 `data/trades/equity.csv`(date, equity), `data/trades/trades.csv`(date, code, side, shares, price) 가 있으면 표시

## 실전 매매 (trade/)

| 언제 | 명령 | 하는 일 |
|---|---|---|
| 거래일 06:40 ~ 08:00 시작 | `python -m trade.run_daily --live` | 잔고 → 수집·예측(월요일은 재학습) → 08:30 동시호가 매도(시장가) → 09:00 직후 매수(현재가 +1% 지정가, 1분 안에 안 되면 다시). 08:30 뒤에 시작하면 그 시각 가격으로 바로 매매 |
| 15:40 이후 | `python -m trade.run_daily --close` | 오늘 체결 → `data/trades/trades.csv`, 총평가 → `equity.csv`, 대시보드 데이터 갱신 |
| 시험 | `python -m trade.run_daily --test` | 아무 때나 주문 없이 수집·예측부터 다시 돌려 주문 목록 출력 (오늘 기록은 안 건드림) |
| 시험 | `python -m trade.run_daily --day 20261102` | 그날 주문 목록으로 주문 없이 출력만 (DRY RUN) |

- `--live` 가 없고 `config.DRY_RUN=True` 이면 주문하지 않는다. 같은 날 매수까지 끝낸 기록(`data/trades/log_날짜.json`)이 있으면 다시 주문하지 않는다
- 실제 주문은 GitHub Actions 에서만 한다. PC 에서 `--live` 로 돌리면 거부되고, Actions 아침 실행이 실패한 날에만 `--live --allow-local` 로 직접 주문
- 시장가 매수는 한투가 상한가 근처 가격으로 현금을 잡아 두어 3종목을 다 살 수 없다 → 매수는 지정가
- 자동 실행: `.github/workflows/daily.yml` (아침 06:40·07:10·07:40, 마감 후 16:00·16:30). 저장소 Secrets 에 한투 키, Variables 에 `LIVE_TRADING=true` 를 넣어야 실제 주문
  - GitHub 예약 실행은 몇 시간 늦거나 빠질 수 있다. 시작 시각이 한국 06:00~12:00 이면 아침, 15:40 뒤면 마감 후, 그 밖이면 건너뜀
  - 아침에 안 돌았으면 Actions 탭 → Run workflow (step `morning`, live 체크)로 직접 실행. 시험은 step `test`

### 투자 성향 (안정형 / 공격형)

대시보드 계좌 현황의 버튼(팀 비밀번호)으로 바꾼다 → 저장소 `data/strategy/mode.json` 이 바뀌고 다음 매매부터 적용.

| | 안정형 | 공격형 |
|---|---|---|
| 보유 | AI 1~3위 1/3씩 | 1종목에 전액 |
| 매도 | 12위 밖으로 밀리면 다음 날 아침 | 순위와 상관없이 장중 손절선 이하에서 바로 (시장가) |
| 손절선 | 없음 | 매수가 -12%, 고점이 +10% 에 닿은 뒤로는 고점 -8% (추적 익절) |
| 다시 사기 | 매일 아침 | 판 다음 날 아침 AI 1위 |

- 공격형 보유 상태(매수가·고점·손절선): `data/strategy/aggressive.json` (매매 프로그램만 씀), 규칙 값은 `config.py` 의 `AGGR_*`
- 장중 감시: `python -m trade.monitor --live` (`.github/workflows/monitor.yml`, 09:00~15:20 1분마다). 외부 예약이 장 시작 무렵 `workflow_dispatch` 로 실행 (방법은 monitor.yml 맨 위)
- 버튼용 환경 변수 (Vercel, 개발 중에는 `dashboard/.env.local`): `GITHUB_TOKEN` (이 저장소 Contents 읽기·쓰기만 준 fine-grained 토큰), `MODE_PASSWORD` (팀 비밀번호)

## 키 관리 규칙

- 키는 `.env` 에만 저장하고 **절대 커밋하지 않는다**
- GitHub Actions 용 키는 **Settings → Secrets and variables → Actions** 에 등록
- 실수로 노출되면 즉시 재발급

## 데이터 출처

| 데이터 | 출처 |
| --- | --- |
| 주가 | FinanceDataReader, pykrx |
| 뉴스 | Google News RSS (하루 단위 날짜 지정) |
| 공시 | OpenDART |
| 매매 | 한국투자증권 Open API (모의투자) |

## 일정

| Sprint | 기간 | 목표 |
| --- | --- | --- |
| SP1 | ~10/21 | 기획서 발표, 데이터 수집 검증 |
| SP2 | ~11/18 | 모델 A~D, 백테스트, 대시보드 배포, 모의투자 시작 |
| 학술제 | 11/24 | 비교 실험 결과 출품 |
| SP3 | ~12/9 | 모델 개선, 실전 성과 분석, 최종 발표 |

## 팀

| 이름 | 역할 |
| --- | --- |
| (이름) | 모델·연구 |
| (이름) | 데이터·서비스 |
