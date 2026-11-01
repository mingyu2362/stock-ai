"""백테스트 (순위 전략)

매일 장 시작 전 모델 점수로 종목 순위를 매기고 시가에 매매한다.
- 매도: 보유 종목이 sell_rank 밖으로 밀리면 시가에 매도
- 매수: 빈 자리만큼 점수 높은 종목을 시가에 매수 (자리당 같은 금액, 이미 보유한 종목은 그대로)
        20일 평균 거래대금 config.MIN_VALUE_KRW 미만, 시가가 상한가 근처(+29% 이상)인 종목은 제외
- 손절: 매수가 대비 -stop. 시가부터 손절가 아래면 시가에, 장중 저가가 닿으면 손절가에 매도
        (일봉으로 흉내 낸 것이라 실제보다 약간 유리함 → STOP_SLIP 만큼 불리하게 체결)
- 공포 비중: 공포지수(news_fear_idx_3d)가 학습 기간 상위 20%인 날은 자리당 금액에 fear_exposure 를 곱하고,
             그보다 많이 들고 있는 종목은 줄인다
- 비용: config.COMMISSION (매수·매도), config.SELL_TAX (매도)
- 비교 기준: 코스피 보유, 351종목 같은 비중 (종목 목록이 2026-09 기준이라 과거 성과가 실제보다 좋게 나옴)

입력: data/predictions/model_{이름}.csv (model/train.py 월별 롤링 예측), data/raw/price/, data/processed/
출력: data/predictions/backtest_{이름}.csv  (종목 수 x 매도 순위 조합별 결과)
실행: python model/backtest.py [A C]   (프로젝트 루트에서, 기본 A C)
"""

import itertools
import os
import sys

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import config  # noqa: E402

PRICE_DIR = os.path.join(ROOT, "data", "raw", "price")
PROC_DIR = os.path.join(ROOT, "data", "processed")
PRED_DIR = os.path.join(ROOT, "data", "predictions")
UNIVERSE_FILE = os.path.join(ROOT, "data", "universe.csv")

CAPITAL = 100_000_000
CASH_BUFFER = 0.99     # 비용·가격 변동 대비 현금 1% 남김
STOP_SLIP = 0.002      # 손절 체결을 손절가보다 이만큼 불리하게
LIMIT_UP = 0.29        # 시가가 전일 종가 대비 이 이상이면 매수 제외 (상한가 체결 제한)
FEAR_QUANTILE = 0.8
CONTEST_DAYS = 30      # 대회 기간 거래일 수 (거래금액 환산용)
WINDOW = 15            # 남은 대회 기간과 같은 길이의 구간 수익률 분포를 본다

# 보고할 기간 (6/15 이후는 2026-06 지수 정기변경 이후라 생존 편향이 가장 작음)
PERIODS = {
    "2025": ("2025-01-01", "2025-12-31"),
    "2026 1~6월": ("2026-01-01", "2026-06-14"),
    "2026-06-15~": ("2026-06-15", "2026-12-31"),
    "대회 10/12~": ("2026-10-12", "2026-12-31"),
}
GRID = {"top_n": [3, 5, 7], "sell_mult": [4, 10]}   # sell_rank = top_n * sell_mult


def load_prices():
    codes = pd.read_csv(UNIVERSE_FILE, dtype={"code": str})["code"]
    frames = {code: pd.read_csv(os.path.join(PRICE_DIR, f"{code}.csv"),
                                parse_dates=["Date"]).set_index("Date") for code in codes}
    px = {k: pd.DataFrame({c: f[k] for c, f in frames.items()}).sort_index()
          for k in ["Open", "Low", "Close"]}
    px["PrevClose"] = px["Close"].shift(1)     # 거래정지 다음 날은 NaN → 매수 안 함
    return px


def load_context():
    chart = pd.read_csv(os.path.join(PROC_DIR, "chart_features.csv"), dtype={"code": str},
                        parse_dates=["date"], usecols=["date", "code", "log_value_20"])
    liquid = chart.assign(liquid=chart["log_value_20"] >= np.log1p(config.MIN_VALUE_KRW))
    liquid = liquid[["date", "code", "liquid"]]
    market = pd.read_csv(os.path.join(PROC_DIR, "market_features.csv"),
                         parse_dates=["date"]).set_index("date")
    fear = market["news_fear_idx_3d"]
    cut = fear[config.TRAIN[0]:config.TRAIN[1]].quantile(FEAR_QUANTILE)
    return liquid, fear >= cut


def simulate(pred, px, fear_high, top_n, sell_rank, stop, fear_exposure):
    """일별 평가금액과 거래 기록. pred 에는 liquid(매수 가능 유동성) 열이 있어야 한다."""
    cash, pos = float(CAPITAL), {}               # pos[code] = [주식 수, 매수가]
    last_close = {}
    equity, traded, trades = [], [], []

    def sell(code, price, shares, reason):
        nonlocal cash, day_traded
        amount = shares * price
        cash += amount * (1 - config.COMMISSION - config.SELL_TAX)
        day_traded += amount
        trades.append((day, code, reason, price / pos[code][1] - 1))
        pos[code][0] -= shares
        if pos[code][0] == 0:
            del pos[code]

    for day, g in pred.groupby("date"):
        day_traded = 0.0
        op, lo, cl, pc = (px[k].loc[day] for k in ["Open", "Low", "Close", "PrevClose"])
        rank = g.set_index("code")["score"].rank(ascending=False)

        # 1. 시가 매도: 순위 밖, 손절가 아래 시작
        for code in list(pos):
            if np.isnan(op.get(code, np.nan)):
                continue                              # 거래정지
            if stop and op[code] <= pos[code][1] * (1 - stop):
                sell(code, op[code], pos[code][0], "stop_gap")
            elif rank.get(code, np.inf) > sell_rank:
                sell(code, op[code], pos[code][0], "rank")

        # 2. 자리당 금액, 공포 날은 줄이기
        value_open = {c: s * (op[c] if not np.isnan(op.get(c, np.nan)) else last_close[c])
                      for c, (s, _) in pos.items()}
        eq_open = cash + sum(value_open.values())
        exposure = fear_exposure if fear_high.get(day, False) else 1.0
        target = eq_open * exposure * CASH_BUFFER / top_n
        if exposure < 1:
            for code in list(pos):
                if not np.isnan(op.get(code, np.nan)) and value_open[code] > target * 1.2:
                    sell(code, op[code], int(pos[code][0] - target // op[code]), "fear_trim")

        # 3. 시가 매수: 빈 자리만큼 점수 순으로
        ok = g[g["liquid"] & ~g["code"].isin(pos)]
        ok = ok[(ok["code"].map(op) < ok["code"].map(pc) * (1 + LIMIT_UP))]
        for code in ok.sort_values("score", ascending=False)["code"]:
            if len(pos) >= top_n:
                break
            shares = int(min(target, cash / (1 + config.COMMISSION)) // op[code])
            if shares == 0:
                continue
            cash -= shares * op[code] * (1 + config.COMMISSION)
            day_traded += shares * op[code]
            pos[code] = [shares, op[code]]

        # 4. 장중 손절
        if stop:
            for code in list(pos):
                level = pos[code][1] * (1 - stop)
                if not np.isnan(lo.get(code, np.nan)) and lo[code] <= level:
                    sell(code, level * (1 - STOP_SLIP), pos[code][0], "stop")

        # 5. 종가 평가
        for code in pos:
            if not np.isnan(cl.get(code, np.nan)):
                last_close[code] = cl[code]
        equity.append((day, cash + sum(s * last_close[c] for c, (s, _) in pos.items())))
        traded.append(day_traded)

    eq = pd.Series(dict(equity))
    return eq, pd.Series(traded, index=eq.index), pd.DataFrame(
        trades, columns=["date", "code", "reason", "ret"])


def metrics(eq, traded=None, trades=None):
    ret = eq.pct_change().fillna(eq.iloc[0] / CAPITAL - 1)
    out = {
        "수익률%": (eq.iloc[-1] / CAPITAL - 1) * 100,
        "MDD%": ((eq / eq.cummax()) - 1).min() * 100,
        "샤프": ret.mean() / ret.std() * np.sqrt(252) if ret.std() > 0 else np.nan,
    }
    if traded is not None:
        out["30일 거래금액(억)"] = traded.mean() * CONTEST_DAYS / 1e8
        out["매도 건수"] = len(trades)
        out["승률%"] = (trades["ret"] > 0).mean() * 100 if len(trades) else np.nan
        out["손절 비율%"] = trades["reason"].str.startswith("stop").mean() * 100 if len(trades) else np.nan
    return out


def benchmarks(px, days):
    kospi = pd.read_csv(os.path.join(PRICE_DIR, "_index_KOSPI.csv"),
                        parse_dates=["Date"]).set_index("Date")["Close"]
    k = kospi.reindex(days)
    k = CAPITAL * k / kospi.shift(1).reindex(days).iloc[0]
    # 같은 비중: 매일 시가에 전 종목 같은 금액 (다음 날 시가까지 수익률 평균)
    op = px["Open"]
    r = (op.shift(-1) / op - 1).reindex(days).mean(axis=1).shift(1).fillna(0)
    ew = CAPITAL * (1 + r).cumprod()
    return {"코스피 보유": metrics(k), "351종목 같은 비중": metrics(ew)}


def window_stats(eq):
    r = (eq / eq.shift(WINDOW) - 1).dropna() * 100
    return {f"{WINDOW}일>+15%": (r > 15).mean() * 100, f"{WINDOW}일<0": (r < 0).mean() * 100}


def by_period(pred, px, fear_high, top_n, sell_rank, stop, fear_exposure):
    row = {}
    for label, (a, b) in PERIODS.items():
        part = pred[(pred["date"] >= a) & (pred["date"] <= b)]
        if part.empty:
            continue
        eq, _, _ = simulate(part, px, fear_high, top_n, sell_rank, stop, fear_exposure)
        row[label] = (eq.iloc[-1] / CAPITAL - 1) * 100
    eq, traded, trades = simulate(pred, px, fear_high, top_n, sell_rank, stop, fear_exposure)
    m = metrics(eq, traded, trades)
    return {**row, "전체 MDD%": m["MDD%"], **window_stats(eq),
            "30일 거래금액(억)": m["30일 거래금액(억)"]}


def main():
    names = sys.argv[1:] or ["A", "C"]
    pd.set_option("display.width", 200)
    px = load_prices()
    liquid, fear_high = load_context()

    days = sorted(px["Open"].index)
    bench = {}
    for label, (a, b) in PERIODS.items():
        d = [x for x in days if pd.Timestamp(a) <= x <= pd.Timestamp(b)]
        bench[label] = {k: v["수익률%"] for k, v in benchmarks(px, d).items()}
    print("비교 기준 수익률%:")
    print(pd.DataFrame(bench).round(1).to_string())

    for name in names:
        pred = pd.read_csv(os.path.join(PRED_DIR, f"model_{name}.csv"),
                           dtype={"code": str}, parse_dates=["date"])
        pred = pred.merge(liquid, on=["date", "code"], how="left")
        pred["liquid"] = pred["liquid"].fillna(False).astype(bool)
        print(f"\n==================== 모델 {name} "
              f"({pred['date'].min().date()} ~ {pred['date'].max().date()}) ====================")
        rows = []
        for top_n, mult in itertools.product(*GRID.values()):
            rows.append({"top_n": top_n, "sell_rank": top_n * mult,
                         **by_period(pred, px, fear_high, top_n, top_n * mult,
                                     config.STOP_LOSS, config.FEAR_EXPOSURE)})
        grid = pd.DataFrame(rows).round(1)
        grid.to_csv(os.path.join(PRED_DIR, f"backtest_{name}.csv"), index=False, encoding="utf-8-sig")
        print(f"손절 {config.STOP_LOSS}, 공포 비중 {config.FEAR_EXPOSURE} | 기간별 수익률%")
        print(grid.to_string(index=False))
        print(f"config 설정: top {config.TOP_N}, {config.SELL_RANK}위 밖 매도")


if __name__ == "__main__":
    main()
