"""시장 지표 수집

- 국내: 코스피·코스닥 지수, 원/달러 환율, 국고채 3년·10년 금리,
        코스피·코스닥 투자자별(외국인·기관·개인) 순매수 금액
- 미국: S&P500, 나스닥, 필라델피아 반도체, VIX, 미국채 10년 금리
- 저장: data/raw/market.csv  (한국 거래일 기준 한 줄)

시점 규칙
- 국내 지표는 해당 거래일 값 (장 마감 후 확정)
- 미국 지표(us_*)는 그 한국 거래일 "이전" 마지막 미국 거래일 값
  → 미국 장은 한국 시간 새벽에 끝나므로 당일 아침 예측에 사용 가능

필요: .env 의 KRX_ID/KRX_PW (pykrx 투자자별 매매·국고채 금리 조회에 KRX 로그인 필요)
실행: python collect/market.py   (프로젝트 루트에서)
"""

import os
import sys
from datetime import date

import pandas as pd
from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
load_dotenv(os.path.join(ROOT, ".env"))  # pykrx는 import 시점에 로그인하므로 먼저 읽는다

import FinanceDataReader as fdr  # noqa: E402
from pykrx import bond, stock  # noqa: E402

import config  # noqa: E402

OUT_FILE = os.path.join(ROOT, "data", "raw", "market.csv")
EOK = 100_000_000  # 순매수 금액은 억원 단위로 저장

# FinanceDataReader 심볼 {컬럼명: (심볼, 사용할 컬럼)}
KR_SERIES = {
    "kospi": ("KS11", "Close"),
    "kosdaq": ("KQ11", "Close"),
    "usdkrw": ("USD/KRW", "Close"),
}
US_SERIES = {
    "us_sp500": ("US500", "Close"),
    "us_nasdaq": ("IXIC", "Close"),
    "us_sox": ("^SOX", "Close"),
    "us_vix": ("^VIX", "Close"),
    "us_10y": ("FRED:DGS10", "DGS10"),
}
BONDS = {"kr_3y": "국고채3년", "kr_10y": "국고채10년"}
FLOW_COLS = {"외국인합계": "foreign", "기관합계": "inst", "개인": "indiv"}


def fdr_close(symbol, col, start, end):
    s = fdr.DataReader(symbol, start, end)[col]
    s.index = pd.to_datetime(s.index).tz_localize(None).normalize()
    return s.dropna()


def investor_flows(start, end):
    """코스피·코스닥 투자자별 순매수 금액 (억원)."""
    frames = []
    for market in ["KOSPI", "KOSDAQ"]:
        df = stock.get_market_trading_value_by_date(start, end, market)
        if df.empty:
            raise RuntimeError(f"{market} 투자자별 매매 조회 실패 (KRX 로그인 확인)")
        df = df[list(FLOW_COLS)].rename(columns=lambda c: f"{market.lower()}_{FLOW_COLS[c]}")
        frames.append(df / EOK)
    return pd.concat(frames, axis=1)


def treasury_yields(start, end):
    """국고채 금리 (%)."""
    out = {}
    for name, kind in BONDS.items():
        df = bond.get_otc_treasury_yields(start, end, kind)
        if df.empty:
            raise RuntimeError(f"{kind} 금리 조회 실패 (KRX 로그인 확인)")
        out[name] = df["수익률"]
    return pd.DataFrame(out)


def main():
    start = config.DATA_START
    end = date.today().isoformat()
    s, e = start.replace("-", ""), end.replace("-", "")

    # 한국 거래일 = 코스피 지수가 있는 날
    kr = pd.DataFrame({name: fdr_close(sym, col, start, end)
                       for name, (sym, col) in KR_SERIES.items()})
    kr = kr[kr["kospi"].notna()]
    kr = kr.join(treasury_yields(s, e)).join(investor_flows(s, e))
    kr["usdkrw"] = kr["usdkrw"].ffill()  # 환율 휴일 차이 보정

    # 미국 지표: 한국 거래일 이전 마지막 값 (같은 날짜 값은 쓰지 않음)
    us_start = (pd.Timestamp(start) - pd.Timedelta(days=10)).date().isoformat()  # 첫 거래일 이전 값 확보
    us = pd.DataFrame({name: fdr_close(sym, col, us_start, end)
                       for name, (sym, col) in US_SERIES.items()}).sort_index()
    us = us.ffill()[us["us_sp500"].notna()]  # 미국 거래일만 (FRED는 휴장일에도 행이 있음)
    us["us_date"] = us.index
    kr.index.name = "date"
    merged = pd.merge_asof(kr.reset_index(), us, left_on="date", right_index=True,
                           allow_exact_matches=False)

    os.makedirs(os.path.dirname(OUT_FILE), exist_ok=True)
    merged.round(4).to_csv(OUT_FILE, index=False, encoding="utf-8-sig")

    print(f"{len(merged)}일 저장 → {OUT_FILE}")
    print(f"기간: {merged['date'].min().date()} ~ {merged['date'].max().date()}")
    missing = merged.isna().sum()
    if missing.any():
        print("빈 값:\n" + missing[missing > 0].to_string())


if __name__ == "__main__":
    main()
