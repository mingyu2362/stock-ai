"""프로젝트 설정값을 한 곳에 모아둔다."""

# 대상 종목 (종목 선별 후 확정)  {종목코드: 검색용 종목명}
TICKERS = {
    "005930": "삼성전자",
    # "000660": "SK하이닉스",
}

# 기간 (시간 순서 분할, 무작위 분할 금지)
DATA_START = "2023-01-01"
TRAIN = ("2023-01-01", "2024-12-31")
VALID = ("2025-01-01", "2025-12-31")
TEST = ("2026-01-01", "2026-10-31")

# 뉴스 시점 규칙: D일 뉴스는 D+NEWS_LAG_DAYS일 예측부터 사용 (누수 검증: 1 vs 2)
NEWS_LAG_DAYS = 2

# 모델별 사용 피처 그룹 (시장 피처는 모든 모델 공통)
FEATURE_GROUPS = {
    "A": ["chart", "market"],
    "B": ["news", "market"],
    "C": ["chart", "news", "market"],
    "D": ["chart", "news", "disclosure", "market"],
}

# 매매 규칙
BUY_THRESHOLD = 0.60
SELL_THRESHOLD = 0.40
ROUND_TRIP_COST = 0.003      # 수수료 + 세금 왕복 약 0.3%
MAX_ORDER_KRW = 10_000_000   # 종목당 최대 주문 금액

# 안전장치: True면 실제 주문 없이 출력만
DRY_RUN = True

# 뉴스 수집
NEWS_SLEEP_SEC = 2
