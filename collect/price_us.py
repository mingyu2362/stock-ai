"""
나스닥100 종목 목록과 일별 주가 수집 (collect/price.py 의 미국판)

- 종목 목록: 네이버 증권 나스닥100 구성종목 → data/universe_us.csv
    code(로이터 코드, 예: AAPL.O = 대시보드·네이버 시세용), symbol(티커, 예: AAPL = 시세 파일 이름), name(한글), name_eng, market
  처음 한 번 만들고, --universe 를 주면 다시 받는다 (정기변경 반영). 지금 구성종목 기준이라 과거 성과에 생존 편향이 있다
- 주가: FinanceDataReader(야후) 일봉, 2023-01-01부터. 이미 받은 날짜 다음날부터 이어 받는다
    분할은 반영된 가격(야후 Open·High·Low·Close), 배당은 반영 안 함
- 지수: 나스닥100(^NDX), VIX(^VIX) → _index_NDX.csv, _index_VIX.csv
- 미국 장 마감(뉴욕 16:00) + 30분 전에는 그날을 받지 않는다 (장중 미완성 시세가 저장되지 않게)

저장 위치: data/raw/price_us/{티커}.csv, data/raw/price_us/_index_{NDX,VIX}.csv
실행: python collect/price_us.py [--universe]   (프로젝트 루트에서)
"""

import os
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import FinanceDataReader as fdr
import pandas as pd
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
START = "2023-01-01"
UNIVERSE_FILE = os.path.join(ROOT, "data", "universe_us.csv")
OUT_DIR = os.path.join(ROOT, "data", "raw", "price_us")
SLEEP_SEC = 0.3
INDEXES = {"NDX": "^NDX", "VIX": "^VIX"}
NY = ZoneInfo("America/New_York")
CLOSE_DONE = "16:30"     # 뉴욕 시각
NAVER_NDX = "https://api.stock.naver.com/index/.NDX/enrollStocks?page=1&pageSize=150"


def last_complete_day():
    """종가가 확정된 마지막 미국 거래일(달력 날짜). 주말이면 FDR 이 알아서 빈 결과를 준다."""
    now = datetime.now(NY)
    day = now.date() if now.strftime("%H:%M") >= CLOSE_DONE else now.date() - timedelta(days=1)
    return day.strftime("%Y-%m-%d")


def fetch_universe():
    r = requests.get(NAVER_NDX, headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
    r.raise_for_status()
    rows = [{"code": s["reutersCode"], "symbol": s["symbolCode"], "name": s["stockName"],
             "name_eng": s.get("stockNameEng", ""), "market": "NASDAQ100"} for s in r.json()["stocks"]]
    if len(rows) < 90:
        raise SystemExit(f"나스닥100 구성종목이 {len(rows)}개뿐이에요 (네이버 응답 확인 필요)")
    df = pd.DataFrame(rows).drop_duplicates("code")
    df.to_csv(UNIVERSE_FILE, index=False, encoding="utf-8-sig")
    print(f"나스닥100 구성종목 {len(df)}개 → {UNIVERSE_FILE}")
    return df


def load_universe():
    if not os.path.exists(UNIVERSE_FILE):
        return fetch_universe()
    return pd.read_csv(UNIVERSE_FILE)


def update_one(symbol, path):
    """저장된 마지막 날짜 다음날부터 받아 이어 붙인다. 추가된 행 수를 반환."""
    old, start = None, START
    if os.path.exists(path):
        old = pd.read_csv(path, parse_dates=["Date"])
        if len(old):
            start = (old["Date"].max() + timedelta(days=1)).strftime("%Y-%m-%d")
    end = last_complete_day()
    if start > end:
        return 0
    new = fdr.DataReader(symbol, start, end)
    if new is None or new.empty:
        return 0
    new = new.reset_index().rename(columns={"index": "Date"})
    new = new[[c for c in ["Date", "Open", "High", "Low", "Close", "Volume"] if c in new.columns]]
    new = new[(new["Date"] <= end) & new["Open"].notna() & (new["Open"] > 0)]
    if symbol != "^VIX":
        new = new[new["Volume"] > 0]
    merged = new if old is None else pd.concat([old, new])
    merged = merged.drop_duplicates("Date").sort_values("Date")
    merged.round(4).to_csv(path, index=False)
    return len(new)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    universe = fetch_universe() if "--universe" in sys.argv else load_universe()
    print(f"대상 종목 {len(universe)}개, 저장 위치 {OUT_DIR}, {last_complete_day()} 종가까지")
    failed = []
    for i, row in enumerate(universe.itertuples(), 1):
        try:
            added = update_one(row.symbol, os.path.join(OUT_DIR, f"{row.symbol}.csv"))
            print(f"[{i}/{len(universe)}] {row.symbol:<6} {row.name} +{added}행")
        except Exception as e:  # noqa: BLE001 - 한 종목 실패로 전체가 멈추지 않게
            failed.append((row.symbol, row.name, str(e)))
            print(f"[{i}/{len(universe)}] {row.symbol:<6} 실패: {e}")
        time.sleep(SLEEP_SEC)
    for name, symbol in INDEXES.items():
        try:
            print(f"지수 {name} +{update_one(symbol, os.path.join(OUT_DIR, f'_index_{name}.csv'))}행")
        except Exception as e:  # noqa: BLE001
            failed.append((symbol, name, str(e)))
    print(f"\n완료: 실패 {len(failed)}")
    if failed:
        pd.DataFrame(failed, columns=["symbol", "name", "error"]).to_csv(
            os.path.join(OUT_DIR, "_failed.csv"), index=False, encoding="utf-8-sig")
        if len(failed) > len(universe) // 2:
            raise SystemExit("절반 넘게 실패 → 중단")


if __name__ == "__main__":
    main()
