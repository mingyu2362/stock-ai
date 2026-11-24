"""나스닥100 시장 피처 (features/market.py 의 미국판, 모든 종목 공통)

입력: data/raw/price_us/_index_NDX.csv, _index_VIX.csv (collect/price_us.py)
출력: data/processed/market_features_us.csv  (date 한 줄 = 그날 장 시작 전에 알 수 있는 시장 상태)

시점 규칙: chart.py 와 같다. T일 행 = T-1일(직전 미국 거래일) 종가까지로 계산 → 한 줄 아래로 민다.
맨 끝에 다음 거래일 행을 붙인다 (그날 예측용)

- ndx_ret_1d/5d/20d, ndx_vol_20d (일간 수익률 표준편차), ndx_ma20_gap
- us_vix (VIX 수준), us_vix_chg (VIX 1일 변화)

실행: python features/market_us.py   (프로젝트 루트에서)
"""

import os

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PRICE_DIR = os.path.join(ROOT, "data", "raw", "price_us")
OUT_FILE = os.path.join(ROOT, "data", "processed", "market_features_us.csv")


def load(name):
    return pd.read_csv(os.path.join(PRICE_DIR, f"_index_{name}.csv"),
                       parse_dates=["Date"]).set_index("Date").sort_index()["Close"]


def main():
    ndx, vix = load("NDX"), load("VIX")
    f = pd.DataFrame(index=ndx.index)
    for n in [1, 5, 20]:
        f[f"ndx_ret_{n}d"] = ndx.pct_change(n)
    f["ndx_vol_20d"] = ndx.pct_change().rolling(20).std()
    f["ndx_ma20_gap"] = ndx / ndx.rolling(20).mean() - 1
    v = vix.reindex(ndx.index).ffill()
    f["us_vix"] = v
    f["us_vix_chg"] = v.diff()

    next_day = pd.DatetimeIndex([ndx.index.max() + pd.offsets.BDay(1)])
    f = f.reindex(f.index.append(next_day)).shift(1).rename_axis("date")
    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    f.round(6).to_csv(OUT_FILE)
    print(f"나스닥 시장 피처 {f.shape[1]}개, {f.index.min().date()} ~ {f.index.max().date()} → {OUT_FILE}")


if __name__ == "__main__":
    main()
