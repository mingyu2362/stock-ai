"""실전 예측: 다음 거래일 종목 순위와 주문 목록

매일 장 시작 전(또는 전날 장 마감 후) 실행한다.
1. 피처 표의 맨 끝 날짜(다음 거래일) 행으로 351종목 점수를 매기고 순위를 낸다
   (data/models/ 의 config.LIVE_MODEL 모델, 시작값별 점수 평균)
2. 보유 종목과 비교해 주문을 정한다: trade/strategy.py plan() ("AI 추세", 지금 투자 성향의 종목 수)
   - 매도: 종가가 20일선 아래, 또는 손절선 아래 마감
   - 매수: 시장 필터(코스피 >= 60일선)를 통과하면 빈 자리만큼, 종가 > 20일선 > 60일선 종목 중 AI 점수 순
           20일 평균 거래대금 config.MIN_VALUE_KRW 미만, 최근 시세가 없는(거래정지) 종목은 제외
   - 수량: 총평가 x 0.99 / 종목 수 를 전일 종가로 나눈 주식 수 (config.MAX_ORDER_KRW 상한)
   여기서는 주문 목록만 만든다. 보유 상태(positions.json)는 trade/run_daily.py 가 실제 주문 뒤에 저장한다

입력: data/processed/ 피처, data/models/, data/trades/holdings.csv (선택: code, shares[, avg_price] 열)
출력: data/predictions/rank_{날짜}.csv   전 종목 순위
      data/predictions/orders_{날짜}.csv 주문 목록 (action, code, name, shares, ref_price, amount, rank, reason, atr)
나스닥100 (--market us): 순위만 낸다 (팀 자동매매는 국내만) → data/predictions/us_rank_{날짜}.csv
  날짜는 미국 거래일. 대시보드 AI 추천·모의투자에서 참고용으로 보여 준다

실행: python model/predict.py [--cash 100000000] [--holdings data/trades/holdings.csv]
      python model/predict.py --market us
      (프로젝트 루트에서. trade/run_daily.py 에서는 decide() 를 직접 불러 써도 된다)
"""

import argparse
import json
import os
import sys

import numpy as np
import pandas as pd
from xgboost import XGBRegressor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import config  # noqa: E402
from model.train import MODEL_DIR, PRED_DIR, load_features, load_universe, market_paths  # noqa: E402
from trade import strategy  # noqa: E402

HOLDINGS_FILE = os.path.join(ROOT, "data", "trades", "holdings.csv")
CASH_BUFFER = 0.99


def last_closes(market="kr"):
    """종목별 마지막 종가와 그 날짜."""
    price_dir = market_paths(market)["price_dir"]
    rows = []
    for code, fname in zip(*load_universe(market)[["code", "file"]].values.T):
        path = os.path.join(price_dir, f"{fname}.csv")
        if not os.path.exists(path):
            continue
        p = pd.read_csv(path, parse_dates=["Date"]).iloc[-1]
        rows.append({"code": code, "last_date": p["Date"], "last_close": p["Close"]})
    return pd.DataFrame(rows).set_index("code")


def rank_stocks(name=config.LIVE_MODEL, market="kr"):
    """피처 표 마지막 날짜의 종목 순위 (1위 = 다음 날 시장 대비 가장 강할 것으로 본 종목)."""
    mp = market_paths(market)
    with open(os.path.join(MODEL_DIR, f"{mp['prefix']}model_{name}.json"), encoding="utf-8") as f:
        meta = json.load(f)
    df, _ = load_features(market)
    day = df.index.get_level_values("date").max()
    today = df.xs(day, level="date")
    score = 0
    for seed in meta["seeds"]:
        m = XGBRegressor()
        m.load_model(os.path.join(MODEL_DIR, f"{mp['prefix']}model_{name}_seed{seed}.json"))
        score = score + m.predict(today[meta["cols"]])
    out = pd.DataFrame({"score": score / len(meta["seeds"])}, index=today.index)

    universe = load_universe(market).set_index("code")
    px = last_closes(market)
    index_last = pd.read_csv(os.path.join(mp["price_dir"], f"_index_{mp['index']}.csv"),
                             parse_dates=["Date"])["Date"].max()
    out = out.join(universe[["name"]]).join(px)
    min_value = config.US_MIN_VALUE_USD if market == "us" else config.MIN_VALUE_KRW
    out["liquid"] = today["log_value_20"] >= np.log1p(min_value)
    out["fresh"] = out["last_date"] == index_last          # 거래정지 등으로 시세가 끊긴 종목 제외
    out["buyable"] = out["liquid"] & out["fresh"]
    out = out.sort_values("score", ascending=False)
    out.insert(0, "rank", np.arange(1, len(out) + 1))
    return day, meta, out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cash", type=float, default=100_000_000)
    parser.add_argument("--holdings", default=HOLDINGS_FILE)
    parser.add_argument("--market", default="kr", choices=["kr", "us"])
    args = parser.parse_args()

    if args.market == "us":
        day, meta, ranking = rank_stocks(config.US_MODEL, "us")
        os.makedirs(PRED_DIR, exist_ok=True)
        out = os.path.join(PRED_DIR, f"us_rank_{day:%Y%m%d}.csv")
        ranking.reset_index().to_csv(out, index=False, encoding="utf-8-sig")
        print(f"나스닥100 예측일 {day.date()} | 모델 {meta['model']} (정답 ~{meta['trained_until']}까지 학습)")
        print(ranking.head(10)[["rank", "name", "score", "last_close", "buyable"]].to_string())
        print(f"저장 → {out}")
        return

    day, meta, ranking = rank_stocks()
    holdings = {}
    if os.path.exists(args.holdings):
        h = pd.read_csv(args.holdings, dtype={"code": str})
        holdings = {r["code"]: {"name": r.get("name"), "shares": int(r["shares"]),
                                "avg_price": r.get("avg_price") if pd.notna(r.get("avg_price")) else None}
                    for r in h.to_dict("records") if r["shares"] > 0}
    mode = strategy.load_mode()
    print(f"투자 성향 {strategy.LABEL[mode]} ({config.SLOTS[mode]}종목)")
    orders, state = strategy.plan(ranking, holdings, args.cash, mode=mode, log=lambda m: print("  " + m))
    keep = [p["code"] for p in state["positions"] if "exit_reason" not in p]

    os.makedirs(PRED_DIR, exist_ok=True)
    tag = day.strftime("%Y%m%d")
    ranking.reset_index().to_csv(os.path.join(PRED_DIR, f"rank_{tag}.csv"), index=False,
                                 encoding="utf-8-sig")
    orders.to_csv(os.path.join(PRED_DIR, f"orders_{tag}.csv"), index=False, encoding="utf-8-sig")

    pd.set_option("display.width", 200)
    print(f"예측일 {day.date()} | 모델 {meta['model']} (정답 ~{meta['trained_until']}까지 학습) | "
          f"전략: AI 추세 {config.SLOTS[mode]}종목")
    print("\n상위 10:")
    print(ranking.head(10)[["rank", "name", "score", "last_close", "buyable"]].to_string())
    print(f"\n계속 보유: {[ranking['name'].get(c, c) for c in keep] or '없음'}")
    print("주문:" if len(orders) else "주문 없음")
    if len(orders):
        print(orders.to_string(index=False))
    print(f"\n저장 → {PRED_DIR}\\rank_{tag}.csv, orders_{tag}.csv")


if __name__ == "__main__":
    main()
