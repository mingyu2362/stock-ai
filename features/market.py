"""시장 피처 (모든 모델 공통)

입력: data/raw/market.csv (collect/market.py), data/processed/market_fear.csv (features/market_fear.py)
출력: data/processed/market_features.csv  (한국 거래일별 한 줄)

시점 규칙: T일 행 = T일 장 시작 전(아침)에 알 수 있는 정보만
- 국내 지표(지수·환율·금리·수급): T-1일 종가까지 → 계산 후 한 줄 아래로 민다
- 미국 지표: market.csv 에 이미 "T 이전 마지막 미국 거래일" 값으로 저장됨 → 그대로
- 뉴스: market_fear.csv 에 이미 config.NEWS_LAG_DAYS 적용됨 → 그대로

수급(순매수 금액)은 시장 규모에 따라 크기가 달라지므로 최근 60거래일 기준 z-점수로 바꾼다.
실행: python features/market.py   (프로젝트 루트에서)
"""

import os

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARKET_FILE = os.path.join(ROOT, "data", "raw", "market.csv")
FEAR_FILE = os.path.join(ROOT, "data", "processed", "market_fear.csv")
OUT_FILE = os.path.join(ROOT, "data", "processed", "market_features.csv")

Z_WINDOW = 60
# 검증에서 쓸모가 확인된 뉴스 피처 (방향 예측력은 없고 변동성과 관련)
NEWS_COLS = ["news_fear_3d", "news_fb_3d", "news_dict_3d", "news_count_ratio"]


def zscore(s, window=Z_WINDOW):
    mean = s.rolling(window, min_periods=20).mean()
    std = s.rolling(window, min_periods=20).std()
    return (s - mean) / std.replace(0, np.nan)


def korean_features(m):
    """T일 종가 기준으로 계산 (호출한 쪽에서 하루 민다)."""
    f = pd.DataFrame(index=m.index)
    for idx in ["kospi", "kosdaq"]:
        ret = m[idx].pct_change()
        f[f"{idx}_ret_1d"] = ret
        f[f"{idx}_ret_5d"] = m[idx].pct_change(5)
        f[f"{idx}_ret_20d"] = m[idx].pct_change(20)
        f[f"{idx}_vol_20d"] = ret.rolling(20).std()
        f[f"{idx}_ma20_gap"] = m[idx] / m[idx].rolling(20).mean() - 1

    f["usdkrw_chg_1d"] = m["usdkrw"].pct_change()
    f["usdkrw_chg_5d"] = m["usdkrw"].pct_change(5)
    f["kr_3y_chg_5d"] = m["kr_3y"].diff(5)            # %p
    f["kr_spread_10y_3y"] = m["kr_10y"] - m["kr_3y"]  # 장단기 금리차

    for mkt in ["kospi", "kosdaq"]:
        for who in ["foreign", "inst"]:
            col = f"{mkt}_{who}"
            f[f"{col}_z_1d"] = zscore(m[col])
            f[f"{col}_z_5d"] = zscore(m[col].rolling(5).sum())
    return f


def us_features(m):
    """미국 거래일 기준 변화율을 계산해 한국 거래일에 붙인다 (미국 휴장일 0% 방지)."""
    cols = ["us_sp500", "us_nasdaq", "us_sox", "us_vix", "us_10y"]
    us = m.drop_duplicates("us_date").set_index("us_date")[cols]
    chg = pd.DataFrame({
        "us_sp500_ret": us["us_sp500"].pct_change(),
        "us_nasdaq_ret": us["us_nasdaq"].pct_change(),
        "us_sox_ret": us["us_sox"].pct_change(),
        "us_vix": us["us_vix"],
        "us_vix_chg": us["us_vix"].pct_change(),
        "us_10y_chg": us["us_10y"].diff(),
    })
    return chg.reindex(m["us_date"]).set_axis(m.index)


def main():
    m = pd.read_csv(MARKET_FILE, parse_dates=["date", "us_date"]).set_index("date")
    fear = pd.read_csv(FEAR_FILE, parse_dates=["date"]).set_index("date")

    feats = (korean_features(m).shift(1)          # T-1일 종가까지
             .join(us_features(m))
             .join(fear[NEWS_COLS]))

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    feats.round(6).to_csv(OUT_FILE, encoding="utf-8-sig")
    print(f"{len(feats)}일 x {feats.shape[1]}개 피처 저장 → {OUT_FILE}")
    print(f"기간: {feats.index.min().date()} ~ {feats.index.max().date()}")
    full = feats.dropna()
    print(f"빈 값 없는 첫 날: {full.index.min().date()} ({len(full)}일)")


if __name__ == "__main__":
    main()
