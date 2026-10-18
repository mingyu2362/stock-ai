"""시장 뉴스 수집 (Google News RSS) — 시장 공포/심리 지표용

- config.MARKET_NEWS_QUERIES 의 중립 키워드(코스피, 코스닥, 증시, 환율, 금리, 외국인)로
  하루 단위(after/before) 검색. 주말 뉴스도 다음 거래일 심리에 반영되도록 모든 날짜 수집
- 전처리: 언론사 접미사 제거, (날짜, 검색어) 안에서 제목 중복 제거,
          제목에 config.MARKET_NEWS_WORDS 중 하나라도 있는 기사만
          (검색어끼리 겹치는 기사는 피처 계산 때 날짜 단위로 한 번 더 중복 제거)
- 저장: data/raw/news/market_{연도}.csv  (연도별로 나눠 100MB 제한 회피)
        data/raw/news/market_progress.csv  (날짜·검색어별 진행 기록, 끊기면 이어서 받기)
- 주의: 과거 기사 발행 시각이 부정확 → 시점 규칙은 config.NEWS_LAG_DAYS 사용
- 한 번 검색에 최대 100건 정도만 오고, 오래된 날짜일수록 색인된 기사가 적음
  (2023년 하루 40~80건, 2026년은 검색어마다 100건 상한) → 기사 "개수"보다 "비율"로 쓸 것

실행: python collect/market_news.py [--start 2023-01-01] [--end 2026-10-17]
      (프로젝트 루트에서, 기본 기간은 config.DATA_START ~ 어제)
"""

import argparse
import os
import sys
import time
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from email.utils import parsedate_to_datetime
from urllib.parse import quote

import pandas as pd
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import config  # noqa: E402

OUT_DIR = os.path.join(ROOT, "data", "raw", "news")
PROGRESS_FILE = os.path.join(OUT_DIR, "market_progress.csv")
HEADERS = {"User-Agent": "Mozilla/5.0"}
RETRIES = 3              # 요청 실패 시 재시도 횟수 (대기 시간은 점점 늘림)
MAX_FAIL_STREAK = 10     # 연속 실패가 이만큼이면 차단으로 보고 중단


def fetch(query, day):
    """하루 동안의 검색 결과 (제목, 언론사, 발행시각)."""
    q = f"{query} after:{day} before:{day + timedelta(days=1)}"
    url = ("https://news.google.com/rss/search?q=" + quote(q)
           + "&hl=ko&gl=KR&ceid=KR:ko")
    res = requests.get(url, headers=HEADERS, timeout=15)
    res.raise_for_status()

    items = []
    for item in ET.fromstring(res.content).iter("item"):
        title = item.findtext("title", "")
        source = item.findtext("source", "")
        if source and title.endswith(f" - {source}"):
            title = title[: -len(f" - {source}")]
        pub = item.findtext("pubDate", "")
        pub_kst = (parsedate_to_datetime(pub).astimezone(pd.Timestamp.now(tz="Asia/Seoul").tz)
                   if pub else None)
        items.append({"title": title.strip(), "source": source, "pub_kst": pub_kst})
    return items


def fetch_with_retry(query, day):
    for attempt in range(RETRIES):
        try:
            return fetch(query, day)
        except Exception:
            if attempt == RETRIES - 1:
                raise
            time.sleep(30 * (attempt + 1))


def clean(items):
    """제목 중복 제거 + 시장 단어가 제목에 있는 기사만."""
    seen, rows = set(), []
    for it in items:
        norm = "".join(ch for ch in it["title"] if ch.isalnum())
        if norm in seen or not any(w in it["title"] for w in config.MARKET_NEWS_WORDS):
            continue
        seen.add(norm)
        rows.append(it)
    return rows


def load_done():
    if not os.path.exists(PROGRESS_FILE):
        return set()
    p = pd.read_csv(PROGRESS_FILE)
    p = p[p["status"] == "ok"]
    return set(zip(p["date"], p["query"]))


def append_csv(path, rows):
    pd.DataFrame(rows).to_csv(path, mode="a", index=False, encoding="utf-8-sig",
                              header=not os.path.exists(path))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", default=config.DATA_START)
    parser.add_argument("--end", default=(date.today() - timedelta(days=1)).isoformat())
    args = parser.parse_args()

    start, end = date.fromisoformat(args.start), date.fromisoformat(args.end)
    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    done = load_done()
    todo = [(d, name) for d in days for name in config.MARKET_NEWS_QUERIES
            if (d.isoformat(), name) not in done]
    os.makedirs(OUT_DIR, exist_ok=True)
    print(f"{start} ~ {end}, {len(days)}일 x 검색어 {len(config.MARKET_NEWS_QUERIES)}개"
          f" → 남은 요청 {len(todo)}건 (약 {len(todo) * (config.NEWS_SLEEP_SEC + 1) / 3600:.1f}시간)")

    fail_streak = 0
    for i, (day, name) in enumerate(todo, 1):
        query = config.MARKET_NEWS_QUERIES[name]
        try:
            items = fetch_with_retry(query, day)
            rows = clean(items)
            status, fail_streak = "ok", 0
        except Exception as e:
            items, rows = [], []
            status, fail_streak = f"error: {type(e).__name__}", fail_streak + 1

        if rows:
            append_csv(os.path.join(OUT_DIR, f"market_{day.year}.csv"),
                       [{"date": day, "query": name, **r} for r in rows])
        append_csv(PROGRESS_FILE, [{"date": day, "query": name, "status": status,
                                    "raw": len(items), "kept": len(rows)}])

        if i % 60 == 0 or status != "ok":
            print(f"[{i}/{len(todo)}] {day} {name:<12} raw={len(items):3d} "
                  f"kept={len(rows):3d} {status}", flush=True)
        if fail_streak >= MAX_FAIL_STREAK:
            raise SystemExit(f"연속 {fail_streak}건 실패 → 차단으로 보고 중단. "
                             "잠시 후 다시 실행하면 이어서 받습니다.")
        time.sleep(config.NEWS_SLEEP_SEC)

    print("완료")


if __name__ == "__main__":
    main()
