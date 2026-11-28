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

# 뉴스 시점 규칙: D일에 발행된 뉴스는 D+NEWS_LAG_DAYS일 예측부터 사용
# (기사 날짜를 발행 날짜로 맞춘 뒤 1일로 충분, features/market_fear.py load_news 참고)
NEWS_LAG_DAYS = 1

# 모델별 사용 피처 그룹 (시장 피처는 모든 모델 공통)
FEATURE_GROUPS = {
    "A": ["chart", "market"],
    "B": ["news", "market"],
    "C": ["chart", "news", "market"],
    "D": ["chart", "news", "disclosure", "market"],
}

# 매매 전략 "AI 추세" (2026-11-28 재설계, 안정형·공격형 공통, trade/strategy.py)
# 목표: 코스피 대비 안정적인 초과수익, 낙폭 제한 (대회 모드 폐기)
# 근거: model/strategy_lab.py — 후보 6개를 개발 기간(2025-01~2026-06)에서 미리 정한 기준으로 고르고
#   검증 기간(2026-07~11, 코스피 -45%)에 한 번 확인: 안정형 -11% (MDD -15%), 공격형 -16% (MDD -17%)
# - 매수: 종가 > 20일선 > 60일선 종목 중 AI 점수 순. 코스피가 60일선 아래면 새로 사지 않음
# - 매도: 종가가 20일선 아래면 다음 날 아침, 손절선(처음 매수가 - ATR x2, 그 뒤 종가 고점 - ATR x3)은 장중 바로
# - 지표 숫자는 교과서 기본값 그대로 (결과에 맞춰 고르지 않음)
LIVE_MODEL = "A"             # AI 점수 모델 (차트 + 시장)
SLOTS = {"stable": 6, "aggressive": 3}   # 투자 성향별 종목 수 (자리당 총평가 x 0.99 / 종목 수)
STRAT_MA = 20                # 추세·매도 기준 이동평균
STRAT_MA_LONG = 60           # 추세 기준 장기 이동평균
STRAT_ATR_N = 14
STRAT_ATR_INIT = 2.0         # 처음 손절선 = 매수가 - ATR x2
STRAT_ATR_TRAIL = 3.0        # 추적 손절선 = 종가 고점 - ATR x3
STRAT_MARKET_MA = 60         # 코스피가 이 이동평균 아래면 새로 사지 않음
MIN_VALUE_KRW = 3e9          # 20일 평균 거래대금이 이보다 작은 종목은 매수 제외
MAX_ORDER_KRW = 40_000_000   # 종목당 최대 주문 금액 (실전 안전장치)

# 이전 전략 (대회 때 실전, 지금은 model/backtest.py · 대시보드 비교용으로만 씀)
# 안정형: AI 상위 TOP_N 종목, SELL_RANK 위 밖이면 매도 / 공격형: AGGR_* (2026-11-26 수정본)
TOP_N = 3
SELL_RANK = 12
STOP_LOSS = None
FEAR_EXPOSURE = 1.0
AGGR_SLOTS = 2
AGGR_STOP_LOSS = 0.08
AGGR_BREAKEVEN_AT = 0.10
AGGR_TRAIL = 0.08
AGGR_SELL_RANK = 20
AGGR_KNIFE_RET20 = -0.30
AGGR_KNIFE_VOL_PCT = 0.8

# 시장별 데이터 위치 (나스닥100 은 국내와 같은 흐름을 파일만 바꿔 쓴다)
# - kr: 코스피200·코스닥150 (대회 종목)
# - us: 나스닥100. 코드는 네이버 로이터 코드(AAPL.O), 시세 파일은 티커(AAPL.csv). 뉴스·공시 피처 없음 → 모델 A(차트+시장)만
MARKETS = {
    "kr": {"universe": "data/universe.csv", "price_dir": "data/raw/price", "index": "KOSPI",
           "chart": "chart_features.csv", "market": "market_features.csv", "prefix": ""},
    "us": {"universe": "data/universe_us.csv", "price_dir": "data/raw/price_us", "index": "NDX",
           "chart": "chart_features_us.csv", "market": "market_features_us.csv", "prefix": "us_"},
}
US_MODEL = "A"
US_TOP_N = 3                 # 나스닥 추천·백테스트 기본값 (국내와 같은 순위 전략)
US_SELL_RANK = 12
US_MIN_VALUE_USD = 50e6      # 20일 평균 거래대금(달러)이 이보다 작으면 매수 제외 (나스닥100 은 거의 다 통과)
US_COMMISSION = 0.0025       # 해외주식 온라인 수수료 (매수·매도 각각, 대시보드 모의투자와 같음)
US_SELL_TAX = 0.0            # 미국은 거래세 없음 (SEC 수수료는 아주 작아 무시)

# 대회 거래 비용 (BanKIS 모의투자: 수수료 양방향 0.0140527%, 매도 시 세금 0.20%)
COMMISSION = 0.000140527
SELL_TAX = 0.002

# 안전장치: True면 실제 주문 없이 출력만
DRY_RUN = True

# 한투 서버: "paper"(모의투자) / "real"(실전). 환경변수 KIS_ENV 가 있으면 그것을 따른다 (trade/kis_api.py)
# 이번 학기는 모의투자로 진행 → paper 고정. 실전은 KIS_REAL_* 키와 KIS_REAL_ORDER=yes 가 모두 있어야 주문한다
KIS_ENV = "paper"
REAL_MAX_ORDER_KRW = 3_000_000   # 실전 매수 1건 최대 금액 (모의의 MAX_ORDER_KRW 와 별도, 처음엔 작게)

# 뉴스 수집
NEWS_SLEEP_SEC = 2

# 시장 뉴스 검색어 {이름: 검색어}
# 공포 단어(폭락·패닉 등)로 검색하면 점수가 한쪽으로 쏠리므로 중립 키워드만 쓴다.
# (국채·뉴욕증시·주식시장·원달러·기관 순매수 등은 테스트에서 추가 기사가 거의 없어 제외)
MARKET_NEWS_QUERIES = {
    "kospi": "코스피",
    "kosdaq": "코스닥",
    "stock_market": "증시",
    "fx": "환율",
    "rate": "금리",
    "foreign": "외국인",
}
# 제목에 이 단어 중 하나라도 있어야 시장 기사로 본다 ("외국인"만 있는 관광·노동 기사 제외)
MARKET_NEWS_WORDS = ["코스피", "코스닥", "증시", "주가", "주식", "환율", "원·달러", "원달러",
                     "달러", "금리", "국채", "연준", "Fed", "FOMC", "매수", "매도", "순매",
                     "시황", "증권", "상한가", "하한가"]

# 뉴스에서 상장명 대신 쓰는 이름 {상장명: [별칭, ...]}
# 검색어는 "상장명 OR 별칭", 제목에 하나라도 들어가면 관련 기사로 본다.
# "지주"/"홀딩스"로 끝나는 이름은 떼어낸 이름이 자동으로 별칭에 추가된다.
NEWS_ALIASES = {
    "NAVER": ["네이버"],
    "LG에너지솔루션": ["LG엔솔"],
    "삼성바이오로직스": ["삼성바이오"],
    "신한지주": ["신한금융"],
    "KB금융": ["KB금융지주"],
    "SK이노베이션": ["SK이노"],
    "POSCO홀딩스": ["포스코홀딩스", "포스코"],
    "현대차": ["현대자동차"],
    "HD현대중공업": ["현대중공업"],
    "한국전력": ["한전"],
    "삼성화재": ["삼성화재해상"],
    "KT&G": ["케이티앤지"],
    "LG유플러스": ["LGU+", "LG U+"],
    "에코프로비엠": ["에코프로BM"],
}


def news_terms(name):
    """종목명으로 뉴스 검색·필터에 쓸 이름 목록을 만든다."""
    terms = [name] + NEWS_ALIASES.get(name, [])
    for suffix in ("지주", "홀딩스"):
        if name.endswith(suffix) and len(name) > len(suffix) + 1:
            terms.append(name[: -len(suffix)])
    return list(dict.fromkeys(terms))
