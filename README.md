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

- 화면: 오늘의 추천·주문 / 실전 성과 / 시장·공포지수 / 실시간 순위(네이버 증권) / 백테스트·연구
- 매일 `python model/daily.py` 가 마지막에 `export.py` 를 실행 → `dashboard/public/data` 를 커밋·푸시하면 Vercel 이 자동 배포
- Vercel 설정: 저장소 연결 후 **Root Directory = `dashboard`** (빌드 명령·출력 폴더는 `vercel.json`)
- 실시간 순위는 `dashboard/api/naver.js` 서버리스 함수가 네이버 증권에서 받아 전달 (공식 API 아님)
- 계좌 현황은 사용자가 자기 한투 모의투자 앱 키를 입력해 자기 계좌만 조회 (키는 그 사람 브라우저에만 저장, `dashboard/api/account.js` 는 저장 없이 잔고 조회만 중계, 주문 기능 없음). Vercel 에 KIS 키를 넣을 필요 없음
- 실전 성과는 `data/trades/equity.csv`(date, equity), `data/trades/trades.csv`(date, code, side, shares, price) 가 있으면 표시

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
