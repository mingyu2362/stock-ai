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

# 매매 규칙
BUY_THRESHOLD = 0.60
SELL_THRESHOLD = 0.40
ROUND_TRIP_COST = 0.003      # 수수료 + 세금 왕복 약 0.3%
MAX_ORDER_KRW = 10_000_000   # 종목당 최대 주문 금액

# 안전장치: True면 실제 주문 없이 출력만
DRY_RUN = True

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
