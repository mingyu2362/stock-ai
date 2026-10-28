"""
350개 종목(코스피200 + 코스닥150) 일별 주가 수집

- 처음 실행: 2023-01-01부터 오늘까지 종목별로 전부 받는다.
- 다시 실행: 이미 받은 날짜 다음날부터 새 데이터만 이어 받는다. (매일 자동 실행용)
- 시장 지수(코스피, 코스닥)도 함께 받는다.

저장 위치: data/raw/price/{종목코드}.csv, data/raw/price/_index_{지수}.csv
종목 목록: data/universe.csv  (code, name, market 열)

설치: pip install finance-datareader pandas
실행: python collect/price.py   (프로젝트 맨 위 폴더에서)
"""

import os
import sys
import time
from datetime import date, timedelta

import FinanceDataReader as fdr
import pandas as pd

START = "2023-01-01"
UNIVERSE_FILE = "data/universe.csv"
OUT_DIR = "data/raw/price"
SLEEP_SEC = 0.3                          # 요청 간격
INDEXES = {"KOSPI": "KS11", "KOSDAQ": "KQ11"}


def load_universe():
    for path in [UNIVERSE_FILE, "universe.csv"]:
        if os.path.exists(path):
            df = pd.read_csv(path, dtype={"code": str})
            df["code"] = df["code"].str.zfill(6)
            return df
    sys.exit("종목 목록(data/universe.csv)이 없습니다. 종목 선별 때 만든 universe.csv를 data/ 폴더로 옮겨주세요.")


def update_one(symbol, path):
    """저장된 마지막 날짜 다음날부터 받아서 이어 붙인다. 추가된 행 수를 반환."""
    old = None
    start = START
    if os.path.exists(path):
        old = pd.read_csv(path, parse_dates=["Date"])
        if len(old):
            start = (old["Date"].max() + timedelta(days=1)).strftime("%Y-%m-%d")

    today = date.today().strftime("%Y-%m-%d")
    if start > today:
        return 0

    new = fdr.DataReader(symbol, start, today)
    if new is None or new.empty:
        return 0

    new = new.reset_index().rename(columns={"index": "Date"})
    keep = [c for c in ["Date", "Open", "High", "Low", "Close", "Volume", "Change"] if c in new.columns]
    new = new[keep]
    new = new[new["Volume"] > 0]          # 거래 없는 날(거래정지 등) 제외

    merged = new if old is None else pd.concat([old, new])
    merged = merged.drop_duplicates("Date").sort_values("Date")
    merged.to_csv(path, index=False)
    return len(new)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    universe = load_universe()
    print(f"대상 종목 {len(universe)}개, 저장 위치 {OUT_DIR}")

    failed = []
    for i, row in enumerate(universe.itertuples(), 1):
        path = os.path.join(OUT_DIR, f"{row.code}.csv")
        try:
            added = update_one(row.code, path)
            print(f"[{i}/{len(universe)}] {row.code} {row.name:<12} +{added}행")
        except Exception as e:
            failed.append((row.code, row.name, str(e)))
            print(f"[{i}/{len(universe)}] {row.code} {row.name:<12} 실패: {e}")
        time.sleep(SLEEP_SEC)

    for name, symbol in INDEXES.items():
        path = os.path.join(OUT_DIR, f"_index_{name}.csv")
        try:
            print(f"지수 {name} +{update_one(symbol, path)}행")
        except Exception as e:
            failed.append((symbol, name, str(e)))

    print(f"\n완료: 성공 {len(universe) + len(INDEXES) - len(failed)} / 실패 {len(failed)}")
    if failed:
        pd.DataFrame(failed, columns=["code", "name", "error"]).to_csv(
            os.path.join(OUT_DIR, "_failed.csv"), index=False, encoding="utf-8-sig")
        print("실패 목록: data/raw/price/_failed.csv (다시 실행하면 실패한 종목만 이어서 받음)")


if __name__ == "__main__":
    main()