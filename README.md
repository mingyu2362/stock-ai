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
| `dashboard/` | Streamlit 대시보드 |
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
