"""
구글 뉴스 RSS로 과거 날짜 뉴스를 받을 수 있는지 테스트하는 스크립트

확인하는 것
1. 날짜마다 기사가 몇 건 나오는지
2. 2023년 같은 과거 날짜도 충분히 나오는지
3. 중복 제거, 종목명 필터 후 몇 건이 남는지
4. 연속 요청해도 막히지 않는지

설치: pip install requests pandas
실행: python test_google_news_rss.py
"""

import random
import time
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import quote

import pandas as pd
import requests

KEYWORD = "삼성전자"
YEARS = [2023, 2024, 2025]
DATES_PER_YEAR = 10
SLEEP_SEC = 2  # 요청 간격 (차단 방지)
HEADERS = {"User-Agent": "Mozilla/5.0"}


def random_weekdays(year, n, seed=42):
    """해당 연도의 평일 중 n개를 무작위로 고른다."""
    random.seed(seed + year)
    days = []
    d = date(year, 1, 1)
    while d.year == year:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    return sorted(random.sample(days, n))


def fetch_news(keyword, day):
    """특정 하루의 구글 뉴스 RSS를 받아 기사 목록을 반환한다."""
    next_day = day + timedelta(days=1)
    query = f"{keyword} after:{day} before:{next_day}"
    url = (
        "https://news.google.com/rss/search?q="
        + quote(query)
        + "&hl=ko&gl=KR&ceid=KR:ko"
    )
    res = requests.get(url, headers=HEADERS, timeout=15)
    res.raise_for_status()

    root = ET.fromstring(res.content)
    items = []
    for item in root.iter("item"):
        title = item.findtext("title", "")
        source = item.findtext("source", "")
        pub = item.findtext("pubDate", "")
        # 제목 끝의 " - 언론사" 제거
        if source and title.endswith(f" - {source}"):
            title = title[: -len(f" - {source}")]
        # 발행 시각을 한국 시간으로 변환
        pub_kst = None
        if pub:
            pub_kst = parsedate_to_datetime(pub).astimezone(
                pd.Timestamp.now(tz="Asia/Seoul").tz
            )
        items.append({"date": day, "title": title.strip(),
                      "source": source, "pub_kst": pub_kst})
    return items


def normalize(title):
    """중복 판단용으로 공백과 특수문자를 제거한다."""
    return "".join(ch for ch in title if ch.isalnum())


def main():
    all_rows = []
    summary = []

    for year in YEARS:
        for day in random_weekdays(year, DATES_PER_YEAR):
            try:
                items = fetch_news(KEYWORD, day)
                status = "ok"
            except Exception as e:  # 차단, 네트워크 오류 등
                items = []
                status = f"error: {e}"

            df = pd.DataFrame(items)
            raw = len(df)
            if raw:
                df["norm"] = df["title"].map(normalize)
                dedup = df.drop_duplicates("norm")
                filtered = dedup[dedup["title"].str.contains(KEYWORD)]
                after_close = (filtered["pub_kst"].dt.hour * 60
                               + filtered["pub_kst"].dt.minute >= 15 * 60 + 30).sum()
                all_rows.append(filtered.drop(columns="norm"))
            else:
                dedup = filtered = df
                after_close = 0

            summary.append({
                "year": year, "date": day, "status": status,
                "raw": raw, "dedup": len(dedup),
                "with_keyword": len(filtered),
                "after_close": int(after_close),
            })
            print(f"{day}  raw={raw:3d}  dedup={len(dedup):3d}  "
                  f"keyword={len(filtered):3d}  {status}")
            time.sleep(SLEEP_SEC)

    summary_df = pd.DataFrame(summary)
    summary_df.to_csv("rss_test_summary.csv", index=False, encoding="utf-8-sig")
    if all_rows:
        pd.concat(all_rows).to_csv("rss_test_articles.csv", index=False,
                                   encoding="utf-8-sig")

    print("\n=== 연도별 평균 ===")
    print(summary_df.groupby("year")[["raw", "dedup", "with_keyword"]]
          .mean().round(1))
    errors = (summary_df["status"] != "ok").sum()
    print(f"\n요청 실패: {errors}건 / 전체 {len(summary_df)}건")


if __name__ == "__main__":
    main()
