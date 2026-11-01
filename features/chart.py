"""차트 피처 (종목별)

입력: data/universe.csv, data/raw/price/{종목코드}.csv, data/raw/price/_index_{KOSPI,KOSDAQ}.csv
      (collect/price.py, 수정주가)
출력: data/processed/chart_features.csv  (date, code 한 줄 = 그 종목의 그날 피처)

시점 규칙: T일 행 = T일 장 시작 전에 알 수 있는 정보만
- 모든 피처는 T-1일 종가(그 종목의 직전 거래일)까지로 계산 → 종목별로 한 줄 아래로 민다
- 거래정지일은 원본에 행이 없음 → 직전 거래일 값이 그대로 쓰임
- 맨 끝에 다음 거래일(코스피 지수 마지막 날의 다음 평일) 행을 붙인다 → 그날 아침 예측용

종목끼리 비교할 수 있게 가격 수준이 아니라 비율로 만든다
- 수익률:      ret_1d/5d/20d/60d, 시장 대비 초과 수익률 rel_ret_5d/20d
- 이동평균:    ma5/20/60 대비 위치(종가/이평 - 1), ma5_20 (5일선/20일선 - 1),
               cross (+1 골든크로스, -1 데드크로스, 0 없음; 그날 5일선이 20일선을 넘은 경우)
- RSI(14):     0~100, 와일더 방식
- MACD:        (12, 26, 9) 값을 종가로 나눔 → 종목끼리 비교 가능
- 볼린저(20,2): bb_pos (0 = 하단, 1 = 상단), bb_width (밴드 폭 / 20일선)
- 거래량:      vol_ratio_5/20 (오늘 거래량 / 최근 n일 평균), log_value_20 (20일 평균 거래대금, 유동성)
- 변동성:      volat_20 (일간 수익률 표준편차), hl_range (고가-저가)/종가, gap (시가/전일 종가 - 1)
- 고점 대비:   high_120_gap (종가 / 120일 최고가 - 1)
상장 후 MIN_HISTORY 거래일 전은 값이 불안정해서 비워 둔다.

실행: python features/chart.py   (프로젝트 루트에서)
"""

import os

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
UNIVERSE_FILE = os.path.join(ROOT, "data", "universe.csv")
PRICE_DIR = os.path.join(ROOT, "data", "raw", "price")
OUT_FILE = os.path.join(ROOT, "data", "processed", "chart_features.csv")

MIN_HISTORY = 60  # 상장 직후 이 거래일 수 미만이면 피처를 비움
INDEX_OF = {"KOSPI200": "KOSPI", "KOSDAQ150": "KOSDAQ"}


def load_price(name):
    return pd.read_csv(os.path.join(PRICE_DIR, f"{name}.csv"),
                       parse_dates=["Date"]).set_index("Date").sort_index()


def rsi(close, n=14):
    diff = close.diff()
    up = diff.clip(lower=0).ewm(alpha=1 / n, min_periods=n).mean()
    down = (-diff.clip(upper=0)).ewm(alpha=1 / n, min_periods=n).mean()
    return 100 - 100 / (1 + up / down.replace(0, np.nan))


def stock_features(p, index_close):
    """T일 종가 기준으로 계산 (호출한 쪽에서 하루 민다)."""
    c, v = p["Close"], p["Volume"]
    f = pd.DataFrame(index=p.index)

    ret = c.pct_change()
    for n in [1, 5, 20, 60]:
        f[f"ret_{n}d"] = c.pct_change(n)
    idx = index_close.reindex(p.index)
    for n in [5, 20]:
        f[f"rel_ret_{n}d"] = f[f"ret_{n}d"] - idx.pct_change(n)

    ma = {n: c.rolling(n).mean() for n in [5, 20, 60]}
    for n in ma:
        f[f"ma{n}_gap"] = c / ma[n] - 1
    above = (ma[5] > ma[20]).astype(int).where(ma[20].notna())
    f["ma5_20"] = ma[5] / ma[20] - 1
    f["cross"] = above.diff()

    f["rsi_14"] = rsi(c)

    ema12, ema26 = c.ewm(span=12, adjust=False).mean(), c.ewm(span=26, adjust=False).mean()
    macd = ema12 - ema26
    signal = macd.ewm(span=9, adjust=False).mean()
    f["macd"] = macd / c
    f["macd_hist"] = (macd - signal) / c

    std20 = c.rolling(20).std()
    lower, upper = ma[20] - 2 * std20, ma[20] + 2 * std20
    f["bb_pos"] = (c - lower) / (upper - lower).replace(0, np.nan)
    f["bb_width"] = (upper - lower) / ma[20]

    for n in [5, 20]:
        f[f"vol_ratio_{n}"] = v / v.rolling(n).mean().replace(0, np.nan)
    f["log_value_20"] = np.log1p((c * v).rolling(20).mean())

    f["volat_20"] = ret.rolling(20).std()
    f["hl_range"] = (p["High"] - p["Low"]) / c
    f["gap"] = p["Open"] / c.shift(1) - 1
    f["high_120_gap"] = c / c.rolling(120, min_periods=MIN_HISTORY).max() - 1

    f.iloc[:MIN_HISTORY] = np.nan
    return f


def main():
    universe = pd.read_csv(UNIVERSE_FILE, dtype={"code": str})
    index_close = {k: load_price(f"_index_{k}")["Close"] for k in set(INDEX_OF.values())}
    next_day = pd.DatetimeIndex([index_close["KOSPI"].index.max() + pd.offsets.BDay(1)])

    parts = []
    for code, market in zip(universe["code"], universe["market"]):
        p = load_price(code)
        f = stock_features(p, index_close[INDEX_OF[market]])
        f = f.reindex(f.index.append(next_day)).shift(1)                 # T-1일 종가까지
        parts.append(f.assign(code=code))
    feats = (pd.concat(parts).rename_axis("date").reset_index()
             .set_index(["date", "code"]).sort_index())

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    feats.round(6).to_csv(OUT_FILE, encoding="utf-8-sig")
    full = feats.dropna()
    print(f"{len(universe)}종목, {len(feats)}행 x {feats.shape[1]}개 피처 저장 → {OUT_FILE}")
    print(f"기간: {feats.index.get_level_values('date').min().date()} ~ "
          f"{feats.index.get_level_values('date').max().date()}")
    print(f"빈 값 없는 행: {len(full)} ({len(full) / len(feats) * 100:.0f}%)")


if __name__ == "__main__":
    main()
