"""
코스피200 + 코스닥150 (2026-09-21 기준) 종목별로 뉴스 양을 샘플링해서
뉴스 감성 분석에 쓸 수 있는 종목을 고르는 스크립트

흐름
1. pykrx로 구성 종목 목록을 받는다 (실패하면 universe.csv를 직접 준비)
2. 종목마다 샘플 날짜 몇 개만 구글 뉴스 RSS로 검색해 기사 수를 센다
3. 하루 평균 기사 수로 정렬해 저장한다

설치: pip install pykrx requests pandas
실행: python screen_news_volume.py
결과: news_volume_ranking.csv

중간에 끊겨도 다시 실행하면 이미 측정한 종목은 건너뛴다.
"""

import os
import random
import time
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from urllib.parse import quote

import pandas as pd
import requests
from dotenv import load_dotenv

load_dotenv()  # pykrx가 KRX_ID / KRX_PW 환경 변수로 로그인한다

BASE_DATE = "20260921"          # 대회 종목 기준일
SAMPLE_DATES_PER_YEAR = 2       # 연도별 샘플 날짜 수 (2 x 3년 = 종목당 6번 요청)
YEARS = [2023, 2024, 2025]
SLEEP_SEC = 2
MIN_AVG = 10                    # 이 값 이상이면 후보로 표시
UNIVERSE_FILE = "universe.csv"
PROGRESS_FILE = "news_volume_progress.csv"
RESULT_FILE = "news_volume_ranking.csv"
HEADERS = {"User-Agent": "Mozilla/5.0"}


def load_universe():
    """코스피200(1028) + 코스닥150(2203) 구성 종목을 받는다."""
    if os.path.exists(UNIVERSE_FILE) and os.path.getsize(UNIVERSE_FILE) > 10:
        return pd.read_csv(UNIVERSE_FILE, dtype={"code": str})

    from pykrx import stock
    rows = []
    for index_code, market in [("1028", "KOSPI200"), ("2203", "KOSDAQ150")]:
        codes = stock.get_index_portfolio_deposit_file(index_code, BASE_DATE)
        for code in codes:
            rows.append({"code": code,
                         "name": stock.get_market_ticker_name(code),
                         "market": market})
    if not rows:
        raise SystemExit(
            "구성 종목을 받지 못했습니다. pykrx는 KRX 로그인이 필요합니다.\n"
            "KRX_ID / KRX_PW 환경 변수를 설정하거나, "
            f"{UNIVERSE_FILE}(code,name,market)을 직접 준비하세요.")
    df = pd.DataFrame(rows)
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


def count_news(name, day):
    """하루 동안 제목에 종목명이 들어간 기사 수를 센다."""
    query = f"{name} after:{day} before:{day + timedelta(days=1)}"
    url = ("https://news.google.com/rss/search?q=" + quote(query)
           + "&hl=ko&gl=KR&ceid=KR:ko")
    res = requests.get(url, headers=HEADERS, timeout=15)
    res.raise_for_status()
    root = ET.fromstring(res.content)

    titles = set()
    for item in root.iter("item"):
        title = item.findtext("title", "")
        source = item.findtext("source", "")
        if source and title.endswith(f" - {source}"):
            title = title[: -len(f" - {source}")]
        if name in title:
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

    ranking = (pd.read_csv(PROGRESS_FILE, dtype={"code": str})
               .sort_values("avg", ascending=False))
    ranking["candidate"] = (ranking["avg"] >= MIN_AVG) & (ranking["avg_2023"] >= MIN_AVG / 2)
    ranking.to_csv(RESULT_FILE, index=False, encoding="utf-8-sig")

    print(f"\n후보 종목 (평균 {MIN_AVG}건 이상, 2023년 {MIN_AVG / 2}건 이상):")
    print(ranking[ranking["candidate"]][["name", "market", "avg", "avg_2023",
                                         "avg_2024", "avg_2025"]]
          .to_string(index=False))


if __name__ == "__main__":
    main()
