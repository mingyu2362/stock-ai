"""
코스피200 + 코스닥150 (2026-09-21 기준) 종목별로 뉴스 양을 샘플링해서
뉴스 감성 분석에 쓸 수 있는 종목을 고르는 스크립트

흐름
1. 구성 종목 목록을 받는다
   - 환경변수 KRX_ID/KRX_PW가 있으면 pykrx로 실제 지수 구성 종목
   - 없으면 FinanceDataReader 시가총액 상위(코스피 200 + 코스닥 150)로 근사
     (최근 pykrx는 KRX 로그인이 있어야 지수 구성 종목 조회가 됨)
2. 종목마다 샘플 날짜 몇 개만 구글 뉴스 RSS로 검색해 기사 수를 센다
3. 하루 평균 기사 수로 정렬해 저장한다

설치: pip install requests pandas finance-datareader pykrx
실행: python collect/screen_news_volume.py   (프로젝트 루트에서)
종목 목록: data/universe.csv
결과: data/screening/news_volume_ranking.csv

중간에 끊겨도 다시 실행하면 이미 측정한 종목은 건너뛴다.
"""

import os
import random
import re
import sys
import time
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from urllib.parse import quote

import pandas as pd
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import config  # noqa: E402  (종목 별칭 NEWS_ALIASES)

BASE_DATE = "20260921"          # 구성 종목 기준일 (pykrx 사용 시)
SAMPLE_DATES_PER_YEAR = 2       # 연도별 샘플 날짜 수 (2 x 3년 = 종목당 6번 요청)
YEARS = [2023, 2024, 2025]
SLEEP_SEC = 2
MIN_AVG = 10                    # 이 값 이상이면 후보로 표시
DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
OUT_DIR = os.path.join(DATA_DIR, "screening")
UNIVERSE_FILE = os.path.join(DATA_DIR, "universe.csv")   # price.py, disclosure.py와 같은 목록
PROGRESS_FILE = os.path.join(OUT_DIR, "news_volume_progress.csv")
RESULT_FILE = os.path.join(OUT_DIR, "news_volume_ranking.csv")
HEADERS = {"User-Agent": "Mozilla/5.0"}


def universe_from_pykrx():
    """코스피200(1028) + 코스닥150(2203) 실제 구성 종목 (KRX 로그인 필요)."""
    from pykrx import stock
    rows = []
    for index_code, market in [("1028", "KOSPI200"), ("2203", "KOSDAQ150")]:
        codes = stock.get_index_portfolio_deposit_file(index_code, BASE_DATE)
        for code in codes:
            rows.append({"code": code,
                         "name": stock.get_market_ticker_name(code),
                         "market": market})
    return pd.DataFrame(rows)


def universe_from_fdr():
    """시가총액 상위 코스피 200 + 코스닥 150 (우선주·스팩 제외)로 근사한다."""
    import FinanceDataReader as fdr
    frames = []
    for listing, market, n in [("KOSPI", "KOSPI200", 200), ("KOSDAQ", "KOSDAQ150", 150)]:
        df = fdr.StockListing(listing)
        df = df[df["Code"].str.endswith("0") & ~df["Name"].str.contains("스팩")]
        df = df.sort_values("Marcap", ascending=False).head(n)
        frames.append(pd.DataFrame({"code": df["Code"], "name": df["Name"],
                                    "market": market}))
    return pd.concat(frames, ignore_index=True)


def load_universe():
    """구성 종목 목록을 받아 저장한다. 이미 받아둔 파일이 있으면 재사용."""
    if os.path.exists(UNIVERSE_FILE):
        df = pd.read_csv(UNIVERSE_FILE, dtype={"code": str})
        if len(df):
            return df

    from dotenv import load_dotenv
    load_dotenv()

    df = pd.DataFrame()
    if os.environ.get("KRX_ID") and os.environ.get("KRX_PW"):
        try:
            df = universe_from_pykrx()
        except Exception as e:
            print(f"pykrx 실패 ({e}) → FinanceDataReader로 대체")
    if df.empty:
        df = universe_from_fdr()
        print("시가총액 상위 종목으로 근사한 목록을 사용합니다.")
    if df.empty:
        raise SystemExit("구성 종목을 받지 못했습니다. 네트워크를 확인하세요.")

    os.makedirs(DATA_DIR, exist_ok=True)
    df.to_csv(UNIVERSE_FILE, index=False, encoding="utf-8-sig")
    print(f"구성 종목 {len(df)}개 저장 → {UNIVERSE_FILE}")
    return df


def sample_dates():
    """모든 종목에 같은 샘플 날짜를 써서 공정하게 비교한다."""
    random.seed(7)
    picked = []
    for year in YEARS:
        days = [date(year, 1, 1) + timedelta(days=i) for i in range(365)]
        weekdays = [d for d in days if d.year == year and d.weekday() < 5]
        picked += random.sample(weekdays, SAMPLE_DATES_PER_YEAR)
    return sorted(picked)


def term_pattern(term):
    """제목에서 종목명을 찾는 정규식.

    SK·LG처럼 짧은 영문 이름은 "SK하이닉스" 같은 계열사 기사까지 걸리므로
    바로 뒤에 조사나 기호만 오는 경우만 인정한다.
    """
    if term.isascii() and len(term) <= 3:
        return re.compile(rf"(?<![A-Za-z0-9]){re.escape(term)}"
                          rf"(?=$|[^0-9A-Za-z가-힣]|[은는이가을를의와과도에로㈜])")
    return re.compile(re.escape(term))


def count_news(name, day):
    """하루 동안 제목에 종목명(또는 별칭)이 들어간 기사 수를 센다."""
    terms = config.news_terms(name)
    keyword = " OR ".join(f'"{t}"' for t in terms)
    query = f"{keyword} after:{day} before:{day + timedelta(days=1)}"
    url = ("https://news.google.com/rss/search?q=" + quote(query)
           + "&hl=ko&gl=KR&ceid=KR:ko")
    res = requests.get(url, headers=HEADERS, timeout=15)
    res.raise_for_status()
    root = ET.fromstring(res.content)

    patterns = [term_pattern(t) for t in terms]
    titles = set()
    for item in root.iter("item"):
        title = item.findtext("title", "")
        source = item.findtext("source", "")
        if source and title.endswith(f" - {source}"):
            title = title[: -len(f" - {source}")]
        if any(p.search(title) for p in patterns):
            titles.add("".join(ch for ch in title if ch.isalnum()))
    return len(titles)


def main():
    universe = load_universe()
    dates = sample_dates()
    print(f"샘플 날짜: {[str(d) for d in dates]}")

    done = set()
    if os.path.exists(PROGRESS_FILE):
        done = set(pd.read_csv(PROGRESS_FILE, dtype={"code": str})["code"])
        print(f"이미 측정한 종목 {len(done)}개는 건너뜀")

    todo = universe[~universe["code"].isin(done)]
    for i, row in enumerate(todo.itertuples(), 1):
        counts, errors = {}, 0
        for d in dates:
            try:
                counts[d.year] = counts.get(d.year, []) + [count_news(row.name, d)]
            except Exception:
                errors += 1
            time.sleep(SLEEP_SEC)

        all_counts = [c for v in counts.values() for c in v]
        result = {
            "code": row.code, "name": row.name, "market": row.market,
            "avg": round(sum(all_counts) / len(all_counts), 1) if all_counts else 0,
            "min": min(all_counts) if all_counts else 0,
            "errors": errors,
        }
        for y in YEARS:
            ys = counts.get(y, [])
            result[f"avg_{y}"] = round(sum(ys) / len(ys), 1) if ys else None

        pd.DataFrame([result]).to_csv(
            PROGRESS_FILE, mode="a", index=False, encoding="utf-8-sig",
            header=not os.path.exists(PROGRESS_FILE))
        print(f"[{i}/{len(todo)}] {row.name:<12} 평균 {result['avg']:5.1f}  "
              f"2023 {result['avg_2023']}  오류 {errors}")

    # 거래 가능 종목(universe)에 있는 것만 남긴다. 목록을 교체해도 측정값은 재사용
    progress = (pd.read_csv(PROGRESS_FILE, dtype={"code": str})
                .drop(columns=["name", "market"]).drop_duplicates("code", keep="last"))
    ranking = (universe.merge(progress, on="code")
               .sort_values("avg", ascending=False))
    ranking["candidate"] = (ranking["avg"] >= MIN_AVG) & (ranking["avg_2023"] >= MIN_AVG / 2)
    ranking.to_csv(RESULT_FILE, index=False, encoding="utf-8-sig")

    print(f"\n후보 종목 (평균 {MIN_AVG}건 이상, 2023년 {MIN_AVG / 2}건 이상):")
    print(ranking[ranking["candidate"]][["name", "market", "avg", "avg_2023",
                                         "avg_2024", "avg_2025"]]
          .to_string(index=False))


if __name__ == "__main__":
    main()
