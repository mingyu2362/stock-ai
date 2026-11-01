"""실전 예측: 다음 거래일 종목 순위와 주문 목록

매일 장 시작 전(또는 전날 장 마감 후) 실행한다.
1. 피처 표의 맨 끝 날짜(다음 거래일) 행으로 351종목 점수를 매기고 순위를 낸다
   (data/models/ 의 config.LIVE_MODEL 모델, 시작값별 점수 평균)
2. 보유 종목과 비교해 주문을 정한다 (model/backtest.py 와 같은 규칙)
   - 매도: 보유 종목이 config.SELL_RANK 위 밖이면 전량 매도
   - 매수: 빈 자리(config.TOP_N - 보유 수)만큼 순위 높은 종목을 매수
           20일 평균 거래대금 config.MIN_VALUE_KRW 미만, 최근 시세가 없는(거래정지) 종목은 제외
   - 수량: (현금 + 보유 평가액) x 0.99 / TOP_N 을 전일 종가로 나눈 주식 수 (config.MAX_ORDER_KRW 상한)
     시가가 전일 종가와 다르면 금액이 조금 달라진다 → 동시호가 시장가 주문 기준

입력: data/processed/ 피처, data/models/, data/trades/holdings.csv (선택: code, shares 열. 없으면 보유 없음)
출력: data/predictions/rank_{날짜}.csv   전 종목 순위
      data/predictions/orders_{날짜}.csv 주문 목록 (action, code, name, shares, ref_price, amount, rank)
실행: python model/predict.py [--cash 100000000] [--holdings data/trades/holdings.csv]
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
from model.train import MODEL_DIR, PRED_DIR, PRICE_DIR, UNIVERSE_FILE, load_features  # noqa: E402

HOLDINGS_FILE = os.path.join(ROOT, "data", "trades", "holdings.csv")
CASH_BUFFER = 0.99


def last_closes():
    """종목별 마지막 종가와 그 날짜."""
    codes = pd.read_csv(UNIVERSE_FILE, dtype={"code": str})["code"]
    rows = []
    for code in codes:
        p = pd.read_csv(os.path.join(PRICE_DIR, f"{code}.csv"), parse_dates=["Date"]).iloc[-1]
        rows.append({"code": code, "last_date": p["Date"], "last_close": p["Close"]})
    return pd.DataFrame(rows).set_index("code")


def rank_stocks(name=config.LIVE_MODEL):
    """피처 표 마지막 날짜의 종목 순위 (1위 = 다음 날 시장 대비 가장 강할 것으로 본 종목)."""
    with open(os.path.join(MODEL_DIR, f"model_{name}.json"), encoding="utf-8") as f:
        meta = json.load(f)
    df, _ = load_features()
    day = df.index.get_level_values("date").max()
    today = df.xs(day, level="date")
    score = 0
    for seed in meta["seeds"]:
        m = XGBRegressor()
        m.load_model(os.path.join(MODEL_DIR, f"model_{name}_seed{seed}.json"))
        score = score + m.predict(today[meta["cols"]])
    out = pd.DataFrame({"score": score / len(meta["seeds"])}, index=today.index)

    universe = pd.read_csv(UNIVERSE_FILE, dtype={"code": str}).set_index("code")
    px = last_closes()
    index_last = pd.read_csv(os.path.join(PRICE_DIR, "_index_KOSPI.csv"),
                             parse_dates=["Date"])["Date"].max()
    out = out.join(universe[["name"]]).join(px)
    out["liquid"] = today["log_value_20"] >= np.log1p(config.MIN_VALUE_KRW)
    out["fresh"] = out["last_date"] == index_last          # 거래정지 등으로 시세가 끊긴 종목 제외
    out["buyable"] = out["liquid"] & out["fresh"]
    out = out.sort_values("score", ascending=False)
    out.insert(0, "rank", np.arange(1, len(out) + 1))
    return day, meta, out


def decide(ranking, holdings, cash):
    """보유 {code: shares}, 현금 → 주문 목록. 매도 먼저, 매수는 빈 자리만큼."""
    orders = []
    held = {c: s for c, s in holdings.items() if s > 0}
    value = sum(s * ranking["last_close"].get(c, 0) for c, s in held.items())
    target = min((cash + value) * CASH_BUFFER / config.TOP_N, config.MAX_ORDER_KRW)

    for code, shares in held.items():
        rank = ranking["rank"].get(code, np.inf)
        if rank > config.SELL_RANK:
            orders.append(("sell", code, shares, rank))
    keep = {c for c in held if c not in {o[1] for o in orders}}

    slots = config.TOP_N - len(keep)
    for code, row in ranking[ranking["buyable"]].iterrows():
        if slots <= 0:
            break
        if code in keep:
            continue
        shares = int(target // row["last_close"])
        if shares > 0:
            orders.append(("buy", code, shares, row["rank"]))
            slots -= 1

    o = pd.DataFrame(orders, columns=["action", "code", "shares", "rank"])
    o["name"] = o["code"].map(ranking["name"])
    o["ref_price"] = o["code"].map(ranking["last_close"])
    o["amount"] = o["shares"] * o["ref_price"]
    return o[["action", "code", "name", "shares", "ref_price", "amount", "rank"]], sorted(keep)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cash", type=float, default=100_000_000)
    parser.add_argument("--holdings", default=HOLDINGS_FILE)
    args = parser.parse_args()

    day, meta, ranking = rank_stocks()
    holdings = {}
    if os.path.exists(args.holdings):
        h = pd.read_csv(args.holdings, dtype={"code": str})
        holdings = dict(zip(h["code"], h["shares"]))
    orders, keep = decide(ranking, holdings, args.cash)

    os.makedirs(PRED_DIR, exist_ok=True)
    tag = day.strftime("%Y%m%d")
    ranking.reset_index().to_csv(os.path.join(PRED_DIR, f"rank_{tag}.csv"), index=False,
                                 encoding="utf-8-sig")
    orders.to_csv(os.path.join(PRED_DIR, f"orders_{tag}.csv"), index=False, encoding="utf-8-sig")

    pd.set_option("display.width", 200)
    print(f"예측일 {day.date()} | 모델 {meta['model']} (정답 ~{meta['trained_until']}까지 학습) | "
          f"전략: {config.TOP_N}종목, {config.SELL_RANK}위 밖 매도")
    print("\n상위 10:")
    print(ranking.head(10)[["rank", "name", "score", "last_close", "buyable"]].to_string())
    print(f"\n계속 보유: {[ranking['name'].get(c, c) for c in keep] or '없음'}")
    print("주문:" if len(orders) else "주문 없음")
    if len(orders):
        print(orders.to_string(index=False))
    print(f"\n저장 → {PRED_DIR}\\rank_{tag}.csv, orders_{tag}.csv")


if __name__ == "__main__":
    main()
