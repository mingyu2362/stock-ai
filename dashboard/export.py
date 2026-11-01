"""대시보드용 JSON 내보내기 → dashboard/public/data/

- today.json        최신 예측 순위(상위 30)와 주문 목록, 전략 설정 (model/predict.py 결과)
- market.json       코스피·코스닥 지수와 공포지수·뉴스 방향 점수 (2025-01 ~)
- performance.json  실전 모의투자 성과 (data/trades/equity.csv, trades.csv 가 있으면)
- universe.json     대회 종목 목록 (실시간 순위에서 대회 종목 표시용)
- backtest.json     (--backtest) 실전 전략과 모델 비교 백테스트. 오래 걸려서 따로 실행

실전 기록 형식 (trade/ 쪽에서 남기는 파일)
- data/trades/equity.csv  date, equity           (그날 장 마감 후 평가금액)
- data/trades/trades.csv  date, code, side, shares, price   (side: buy/sell)

실행: python dashboard/export.py [--backtest]   (프로젝트 루트에서, model/daily.py 뒤에)
"""

import glob
import json
import os
import sys

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "model"))
import config  # noqa: E402

OUT_DIR = os.path.join(ROOT, "dashboard", "public", "data")
PRED_DIR = os.path.join(ROOT, "data", "predictions")
PROC_DIR = os.path.join(ROOT, "data", "processed")
TRADE_DIR = os.path.join(ROOT, "data", "trades")
UNIVERSE_FILE = os.path.join(ROOT, "data", "universe.csv")
MARKET_FILE = os.path.join(ROOT, "data", "raw", "market.csv")
CHART_START = "2025-01-01"
CONTEST = ("2026-10-12", "2026-11-20")
LIVE_START = "2026-11-02"
TOP_ROWS = 30
NOISE_SEEDS = 8        # 백테스트 경로 민감도: 점수에 작은 잡음을 섞어 반복


def write(name, obj):
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(os.path.join(OUT_DIR, name), "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    print(f"  {name}")


def clean(v, digits=4):
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return None
    if isinstance(v, (np.floating, float)):
        return round(float(v), digits)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.bool_,)):
        return bool(v)
    return v


def records(df, digits=4):
    return [{k: clean(v, digits) for k, v in row.items()} for row in df.to_dict("records")]


def universe():
    u = pd.read_csv(UNIVERSE_FILE, dtype={"code": str})
    write("universe.json", {r.code: {"name": r.name, "market": r.market} for r in u.itertuples()})
    return u.set_index("code")


def today(u):
    files = sorted(glob.glob(os.path.join(PRED_DIR, "rank_*.csv")))
    if not files:
        print("  today.json 건너뜀 (model/predict.py 먼저 실행)")
        return
    tag = os.path.basename(files[-1])[5:13]
    day = pd.Timestamp(tag)
    rank = pd.read_csv(files[-1], dtype={"code": str})
    orders = pd.read_csv(os.path.join(PRED_DIR, f"orders_{tag}.csv"), dtype={"code": str})
    meta = json.load(open(os.path.join(ROOT, "data", "models", f"model_{config.LIVE_MODEL}.json"),
                          encoding="utf-8"))

    chart = pd.read_csv(os.path.join(PROC_DIR, "chart_features.csv"), dtype={"code": str},
                        parse_dates=["date"])
    chart = chart[chart["date"] == day].set_index("code")[
        ["ret_1d", "ret_5d", "ret_20d", "rsi_14", "vol_ratio_20", "volat_20"]]
    top = (rank.head(TOP_ROWS).set_index("code").join(chart).join(u[["market"]])
           .reset_index())
    top = top[["rank", "code", "name", "market", "score", "last_close", "buyable",
               "ret_1d", "ret_5d", "ret_20d", "rsi_14", "vol_ratio_20", "volat_20"]]
    orders = orders.join(u[["market"]], on="code")
    write("today.json", {
        "date": tag[:4] + "-" + tag[4:6] + "-" + tag[6:],
        "base_close": str(rank["last_date"].max())[:10],
        "model": meta["model"], "trained_until": meta["trained_until"],
        "strategy": {"top_n": config.TOP_N, "sell_rank": config.SELL_RANK,
                     "stop_loss": config.STOP_LOSS, "min_value_krw": config.MIN_VALUE_KRW},
        "universe_size": int(len(rank)), "buyable": int(rank["buyable"].sum()),
        "top": records(top), "orders": records(orders),
        "ranks": dict(zip(rank["code"], rank["rank"].astype(int))),   # 전체 종목 순위 (종목 상세·계좌 화면용)
    })


def market():
    m = pd.read_csv(MARKET_FILE, parse_dates=["date"]).dropna(subset=["kospi"])
    fear = pd.read_csv(os.path.join(PROC_DIR, "market_fear.csv"), parse_dates=["date"])
    df = m[["date", "kospi", "kosdaq", "us_vix"]].merge(
        fear[["date", "news_fear_idx_3d", "news_dict_3d"]], on="date", how="left")
    cut = fear.set_index("date")["news_fear_idx_3d"][config.TRAIN[0]:config.TRAIN[1]].quantile(0.8)
    df = df[df["date"] >= CHART_START]
    df["date"] = df["date"].dt.strftime("%Y-%m-%d")
    df = df.rename(columns={"news_fear_idx_3d": "fear", "news_dict_3d": "news_dir", "us_vix": "vix"})
    write("market.json", {"fear_high": clean(cut), "contest": CONTEST, "rows": records(df)})


def performance():
    eq_file = os.path.join(TRADE_DIR, "equity.csv")
    if not os.path.exists(eq_file):
        write("performance.json", {"status": "not_started", "start": LIVE_START})
        return
    eq = pd.read_csv(eq_file, parse_dates=["date"]).sort_values("date")
    kospi = pd.read_csv(MARKET_FILE, parse_dates=["date"]).set_index("date")["kospi"].dropna()
    base_k = kospi[kospi.index < eq["date"].iloc[0]].iloc[-1]
    eq["kospi_idx"] = eq["date"].map(kospi) / base_k * 100
    eq["equity_idx"] = eq["equity"] / 100_000_000 * 100
    trades = pd.read_csv(os.path.join(TRADE_DIR, "trades.csv"), dtype={"code": str},
                         parse_dates=["date"]) if os.path.exists(
        os.path.join(TRADE_DIR, "trades.csv")) else pd.DataFrame(
        columns=["date", "code", "side", "shares", "price"])
    names = pd.read_csv(UNIVERSE_FILE, dtype={"code": str}).set_index("code")["name"]
    trades["name"] = trades["code"].map(names)
    trades["amount"] = trades["shares"] * trades["price"]
    eq["date"] = eq["date"].dt.strftime("%Y-%m-%d")
    trades["date"] = trades["date"].dt.strftime("%Y-%m-%d")
    write("performance.json", {
        "status": "live", "start": LIVE_START,
        "equity": records(eq[["date", "equity", "equity_idx", "kospi_idx"]], 2),
        "trades": records(trades.sort_values("date", ascending=False)),
        "traded_total": clean(trades["amount"].sum(), 0),
        "traded_days": int(trades["date"].nunique()),
        "traded_codes": int(trades["code"].nunique()),
    })


def backtest():
    import backtest as bt
    from joblib import Parallel, delayed

    px = bt.load_prices()
    liquid, fear_high = bt.load_context()
    preds = {}
    for name in ["A", "C"]:
        p = pd.read_csv(os.path.join(PRED_DIR, f"model_{name}.csv"), dtype={"code": str},
                        parse_dates=["date"]).merge(liquid, on=["date", "code"], how="left")
        p["liquid"] = p["liquid"].fillna(False).astype(bool)
        preds[name] = p

    # 1. 실전 전략 자산 곡선 vs 비교 기준 (시작 = 100)
    eq, traded, trades = bt.simulate(preds[config.LIVE_MODEL], px, fear_high, config.TOP_N,
                                     config.SELL_RANK, config.STOP_LOSS, config.FEAR_EXPOSURE)
    days = eq.index
    kospi = pd.read_csv(os.path.join(bt.PRICE_DIR, "_index_KOSPI.csv"),
                        parse_dates=["Date"]).set_index("Date")["Close"]
    k = kospi.reindex(days) / kospi[kospi.index < days[0]].iloc[-1] * 100
    op = px["Open"]
    ew = (1 + (op.shift(-1) / op - 1).reindex(days).mean(axis=1).shift(1).fillna(0)).cumprod() * 100
    curve = pd.DataFrame({"date": days.strftime("%Y-%m-%d"), "strategy": eq.values / 1e6,
                          "kospi": k.values, "equal": ew.values})
    m = bt.metrics(eq, traded, trades)

    # 2. 모델·종목 수별 기간 성과 (잡음 반복 중앙값)
    def one(name, n, sr, seed):
        p = preds[name].copy()
        if seed:
            sd = p.groupby("date")["score"].transform("std")
            p["score"] += np.random.default_rng(seed).normal(0, 0.1, len(p)) * sd
        row = {}
        for label, (a, b) in bt.PERIODS.items():
            part = p[(p["date"] >= a) & (p["date"] <= b)]
            e, _, _ = bt.simulate(part, px, fear_high, n, sr, None, 1.0)
            row[label] = (e.iloc[-1] / bt.CAPITAL - 1) * 100
        return {"model": name, "top_n": n, "sell_rank": sr, **row}

    jobs = [(nm, n, sr, s) for nm in ["A", "C"] for n, sr in [(3, 12), (5, 20), (7, 28)]
            for s in range(NOISE_SEEDS)]
    res = pd.DataFrame(Parallel(n_jobs=-1)(delayed(one)(*j) for j in jobs))
    grid = res.groupby(["model", "top_n", "sell_rank"]).median().reset_index()

    bench = []
    for label, (a, b) in bt.PERIODS.items():
        d = [x for x in px["Open"].index if pd.Timestamp(a) <= x <= pd.Timestamp(b)]
        bm = bt.benchmarks(px, d)
        bench.append({"period": label, "kospi": bm["코스피 보유"]["수익률%"],
                      "equal": bm["351종목 같은 비중"]["수익률%"]})

    r15 = (eq / eq.shift(bt.WINDOW) - 1).dropna() * 100
    write("backtest.json", {
        "config": {"model": config.LIVE_MODEL, "top_n": config.TOP_N, "sell_rank": config.SELL_RANK},
        "curve": records(curve, 2),
        "summary": {"return": clean(m["수익률%"], 1), "mdd": clean(m["MDD%"], 1),
                    "sharpe": clean(m["샤프"], 2), "p15_over15": clean((r15 > 15).mean() * 100, 1),
                    "p15_negative": clean((r15 < 0).mean() * 100, 1),
                    "turnover30": clean(m["30일 거래금액(억)"], 1)},
        "periods": list(bt.PERIODS), "grid": records(grid, 1), "bench": records(pd.DataFrame(bench), 1),
        "noise_seeds": NOISE_SEEDS,
    })


def main():
    print(f"대시보드 데이터 → {OUT_DIR}")
    u = universe()
    today(u)
    market()
    performance()
    if "--backtest" in sys.argv:
        backtest()


if __name__ == "__main__":
    main()
