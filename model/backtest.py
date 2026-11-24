"""백테스트 (순위 전략 + 공격형·추가 전략, 국내·나스닥100)

매일 장 시작 전 점수로 종목 순위를 매기고 시가에 매매한다.
- 매도: 보유 종목이 sell_rank 밖으로 밀리면 시가에 매도 (sell_rank=None 이면 순위로는 팔지 않음)
- 매수: 빈 자리만큼 점수 높은 종목을 시가에 매수 (자리당 같은 금액, 이미 보유한 종목은 그대로)
        20일 평균 거래대금이 기준 미만, 시가가 상한가 근처(+29% 이상, 국내만)인 종목은 제외
- 손절: 매수가 대비 -stop. 시가부터 손절가 아래면 시가에, 장중 저가가 닿으면 손절가에 매도
        (일봉으로 흉내 낸 것이라 실제보다 약간 유리함 → STOP_SLIP 만큼 불리하게 체결)
- 추적 익절 (trail_start, trail): 고점이 매수가 +trail_start 에 닿은 뒤로는 손절선을 고점 -trail 로 올린다
        (공격형 규칙, trade/aggressive.py 와 같음). 고점은 그날 손절 확인이 끝난 뒤 그날 고가로 갱신 (보수적)
- 손절 다음 날 매수 (delay_after_stop): 손절로 빈 자리는 그날 다시 채우지 않는다 (공격형 실전 흐름과 같음)
- 주간 교체 (weekly): 순위 매도·매수를 그 주 첫 거래일에만. 손절은 매일
- 공포 비중: 공포지수(news_fear_idx_3d)가 학습 기간 상위 20%인 날은 자리당 금액에 fear_exposure 를 곱하고,
             그보다 많이 들고 있는 종목은 줄인다 (국내만)
- 비용: 국내 config.COMMISSION·SELL_TAX, 나스닥 config.US_COMMISSION·US_SELL_TAX (환율은 무시, 달러 기준)
- 비교 기준: 지수 보유, 전 종목 같은 비중 (종목 목록이 지금 기준이라 과거 성과가 실제보다 좋게 나옴 = 생존 편향)

전략 목록 (STRATEGIES): 안정형(실전) · 공격형(실전) · 안정형+추적손절 · 주간 교체 · 분산형 10종목 · 모멘텀(AI 없음)
  모멘텀은 모델 대신 20일 수익률 순위로 같은 규칙을 돌린 기준선 → AI 점수가 단순 추세 추종보다 나은지 본다

입력: data/predictions/{접두어}model_{이름}.csv (model/train.py 월별 롤링 예측), 시세, 피처
출력: data/predictions/{접두어}backtest_{이름}.csv  (종목 수 x 매도 순위 조합별 결과, 국내만)
      data/predictions/{접두어}strategies.csv       (전략 비교)
실행: python model/backtest.py [A C]              (프로젝트 루트에서, 기본 A C: 기존 조합 표 + 전략 비교)
      python model/backtest.py --market us        (나스닥100, 모델 A 전략 비교)
      python model/backtest.py --aggr-grid        (공격형 손절·익절 값 민감도)
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
LIMIT_UP = 0.29        # 시가가 전일 종가 대비 이 이상이면 매수 제외 (상한가 체결 제한, 국내)
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

# 비교할 전략. score="momentum" 이면 모델 점수 대신 20일 수익률
STRATEGIES = {
    "stable": {"label": "안정형 (실전)", "desc": "AI 상위 3종목 1/3씩, 12위 밖으로 밀리면 매도",
               "top_n": config.TOP_N, "sell_rank": config.SELL_RANK},
    "aggressive": {"label": "공격형 (실전)",
                   "desc": f"AI 1위 1종목 전액, 매수가 -{config.AGGR_STOP_LOSS:.0%} 손절, "
                           f"+{config.AGGR_BREAKEVEN_AT:.0%} 뒤로는 고점 -{config.AGGR_TRAIL:.0%} 추적 익절, 판 다음 날 1위 매수",
                   "top_n": 1, "sell_rank": None, "stop": config.AGGR_STOP_LOSS,
                   "trail_start": config.AGGR_BREAKEVEN_AT, "trail": config.AGGR_TRAIL, "delay_after_stop": True},
    "stable_trail": {"label": "안정형 + 추적 손절", "desc": "안정형에 매수가 -10% 손절, +10% 뒤로 고점 -8% 추적 익절",
                     "top_n": config.TOP_N, "sell_rank": config.SELL_RANK, "stop": 0.10,
                     "trail_start": 0.10, "trail": 0.08},
    "weekly": {"label": "주간 교체 5종목", "desc": "그 주 첫 거래일에만 상위 5종목으로 교체 (20위 밖 매도), 거래 비용 절약",
               "top_n": 5, "sell_rank": 20, "weekly": True},
    "diversified": {"label": "분산형 10종목", "desc": "AI 상위 10종목 1/10씩, 40위 밖 매도",
                    "top_n": 10, "sell_rank": 40},
    "momentum": {"label": "모멘텀 (AI 없음)", "desc": "AI 대신 20일 수익률 상위 3종목, 12위 밖 매도 (기준선)",
                 "top_n": config.TOP_N, "sell_rank": config.SELL_RANK, "score": "momentum"},
}
AGGR_GRID = {"stop": [0.06, 0.08, 0.12, 0.16], "trail": [0.05, 0.08, 0.12]}


def market_cfg(market="kr"):
    m = config.MARKETS[market]
    us = market == "us"
    return {
        "market": market, "price_dir": os.path.join(ROOT, m["price_dir"]),
        "universe": os.path.join(ROOT, m["universe"]), "chart": os.path.join(PROC_DIR, m["chart"]),
        "index": m["index"], "prefix": m["prefix"],
        "costs": (config.US_COMMISSION, config.US_SELL_TAX) if us else (config.COMMISSION, config.SELL_TAX),
        "min_value": config.US_MIN_VALUE_USD if us else config.MIN_VALUE_KRW,
        "limit_up": None if us else LIMIT_UP,
        "index_name": "나스닥100 보유" if us else "코스피 보유",
    }


def _universe(mc):
    u = pd.read_csv(mc["universe"], dtype={"code": str})
    u["file"] = u["symbol"] if "symbol" in u else u["code"]
    return u


def load_prices(market="kr"):
    mc = market_cfg(market)
    frames = {}
    for code, fname in zip(*_universe(mc)[["code", "file"]].values.T):
        path = os.path.join(mc["price_dir"], f"{fname}.csv")
        if os.path.exists(path):
            frames[code] = pd.read_csv(path, parse_dates=["Date"]).set_index("Date")
    px = {k: pd.DataFrame({c: f[k] for c, f in frames.items()}).sort_index()
          for k in ["Open", "High", "Low", "Close"]}
    px["PrevClose"] = px["Close"].shift(1)     # 거래정지 다음 날은 NaN → 매수 안 함
    return px


def load_context(market="kr", with_momentum=False):
    """(유동성 표, 공포 상위 날짜). with_momentum 이면 20일 수익률(ret_20d) 열도 붙인다."""
    mc = market_cfg(market)
    cols = ["date", "code", "log_value_20"] + (["ret_20d"] if with_momentum else [])
    chart = pd.read_csv(mc["chart"], dtype={"code": str}, parse_dates=["date"], usecols=cols)
    chart["liquid"] = chart["log_value_20"] >= np.log1p(mc["min_value"])
    liquid = chart.drop(columns="log_value_20")
    if market == "us":
        return liquid, pd.Series(dtype=bool)
    market_f = pd.read_csv(os.path.join(PROC_DIR, "market_features.csv"),
                           parse_dates=["date"]).set_index("date")
    fear = market_f["news_fear_idx_3d"]
    cut = fear[config.TRAIN[0]:config.TRAIN[1]].quantile(FEAR_QUANTILE)
    return liquid, fear >= cut


def load_pred(name, market="kr", liquid=None, score="model"):
    """모델 예측(또는 같은 날짜·종목의 20일 수익률 점수)에 liquid 열을 붙인 표."""
    mc = market_cfg(market)
    pred = pd.read_csv(os.path.join(PRED_DIR, f"{mc['prefix']}model_{name}.csv"),
                       dtype={"code": str}, parse_dates=["date"])
    if liquid is None:
        liquid, _ = load_context(market, with_momentum=score == "momentum")
    pred = pred.merge(liquid, on=["date", "code"], how="left")
    pred["liquid"] = pred["liquid"].fillna(False).astype(bool)
    if score == "momentum":
        pred["score"] = pred["ret_20d"].fillna(-np.inf)
    return pred.drop(columns=[c for c in ["ret_20d"] if c in pred])


def simulate(pred, px, fear_high, top_n, sell_rank, stop, fear_exposure=1.0, *, trail_start=None, trail=None,
             weekly=False, delay_after_stop=False, costs=None, limit_up=LIMIT_UP):
    """일별 평가금액과 거래 기록. pred 에는 liquid(매수 가능 유동성) 열이 있어야 한다.
    sell_rank=None 이면 순위로 팔지 않는다. 반환: (평가금액, 일별 거래금액, 매도 기록)"""
    commission, tax = costs or (config.COMMISSION, config.SELL_TAX)
    cash, pos = float(CAPITAL), {}               # pos[code] = [주식 수, 매수가, 고점]
    last_close = {}
    equity, traded, trades = [], [], []
    prev_week = None

    def level(code):
        """지금 손절선 (없으면 None). 추적 익절이 켜졌으면 고점 기준."""
        _, entry, peak = pos[code]
        if trail_start is not None and peak >= entry * (1 + trail_start):
            return peak * (1 - trail), "trail"
        if stop:
            return entry * (1 - stop), "stop"
        return None, None

    def sell(code, price, shares, reason):
        nonlocal cash, day_traded
        amount = shares * price
        cash += amount * (1 - commission - tax)
        day_traded += amount
        trades.append((day, code, reason, price / pos[code][1] * (1 - commission - tax) / (1 + commission) - 1))
        pos[code][0] -= shares
        if pos[code][0] == 0:
            del pos[code]

    for day, g in pred.groupby("date"):
        day_traded = 0.0
        stopped = 0
        op, hi, lo, cl, pc = (px[k].loc[day] for k in ["Open", "High", "Low", "Close", "PrevClose"])
        rank = g.set_index("code")["score"].rank(ascending=False)
        week = day.isocalendar()[:2]
        rebalance = not weekly or week != prev_week
        prev_week = week

        # 1. 시가 매도: 손절선 아래 시작, 순위 밖
        for code in list(pos):
            if np.isnan(op.get(code, np.nan)):
                continue                              # 거래정지
            lvl, kind = level(code)
            if lvl is not None and op[code] <= lvl:
                sell(code, op[code], pos[code][0], f"{kind}_gap")
                stopped += 1
            elif rebalance and sell_rank is not None and rank.get(code, np.inf) > sell_rank:
                sell(code, op[code], pos[code][0], "rank")

        # 2. 자리당 금액, 공포 날은 줄이기
        value_open = {c: s * (op[c] if not np.isnan(op.get(c, np.nan)) else last_close[c])
                      for c, (s, _, _) in pos.items()}
        eq_open = cash + sum(value_open.values())
        exposure = fear_exposure if fear_high.get(day, False) else 1.0
        target = eq_open * exposure * CASH_BUFFER / top_n
        if exposure < 1:
            for code in list(pos):
                if not np.isnan(op.get(code, np.nan)) and value_open[code] > target * 1.2:
                    sell(code, op[code], int(pos[code][0] - target // op[code]), "fear_trim")

        # 3. 시가 매수: 빈 자리만큼 점수 순으로 (손절로 빈 자리는 delay_after_stop 이면 내일)
        if rebalance:
            slots = top_n - len(pos) - (stopped if delay_after_stop else 0)
            ok = g[g["liquid"] & ~g["code"].isin(pos)]
            ok = ok[ok["code"].map(op).notna() & ok["code"].map(pc).notna()]
            if limit_up is not None:
                ok = ok[ok["code"].map(op) < ok["code"].map(pc) * (1 + limit_up)]
            # 점수가 같으면 종목코드 순 (예측 점수가 소수 5자리라 동점이 생김 → 실행마다 같은 결과, 브라우저 엔진과 같음)
            for code in ok.sort_values(["score", "code"], ascending=[False, True])["code"]:
                if slots <= 0:
                    break
                shares = int(min(target, cash / (1 + commission)) // op[code])
                if shares == 0:
                    continue
                cash -= shares * op[code] * (1 + commission)
                day_traded += shares * op[code]
                pos[code] = [shares, op[code], op[code]]
                slots -= 1

        # 4. 장중 손절·추적 익절 (오늘 아침 기준 손절선), 그 뒤 고점 갱신
        for code in list(pos):
            lvl, kind = level(code)
            if lvl is not None and not np.isnan(lo.get(code, np.nan)) and lo[code] <= lvl:
                sell(code, lvl * (1 - STOP_SLIP), pos[code][0], kind)
            elif not np.isnan(hi.get(code, np.nan)):
                pos[code][2] = max(pos[code][2], hi[code])

        # 5. 종가 평가
        for code in pos:
            if not np.isnan(cl.get(code, np.nan)):
                last_close[code] = cl[code]
            elif code not in last_close:
                last_close[code] = pos[code][1]
        equity.append((day, cash + sum(s * last_close[c] for c, (s, _, _) in pos.items())))
        traded.append(day_traded)

    eq = pd.Series(dict(equity))
    return eq, pd.Series(traded, index=eq.index), pd.DataFrame(
        trades, columns=["date", "code", "reason", "ret"])


def run_strategy(key, pred, px, fear_high, market="kr", pred_mom=None):
    """STRATEGIES[key] 로 simulate. pred_mom: 모멘텀 점수 표 (score='momentum' 전략용)."""
    s = STRATEGIES[key]
    mc = market_cfg(market)
    p = pred_mom if s.get("score") == "momentum" else pred
    return simulate(p, px, fear_high, s["top_n"], s["sell_rank"], s.get("stop"), 1.0,
                    trail_start=s.get("trail_start"), trail=s.get("trail"), weekly=s.get("weekly", False),
                    delay_after_stop=s.get("delay_after_stop", False), costs=mc["costs"], limit_up=mc["limit_up"])


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
        out["손절 비율%"] = trades["reason"].str.match(r"^(stop|trail)").mean() * 100 if len(trades) else np.nan
    return out


def period_returns(eq):
    """연속으로 돌린 자산 곡선에서 기간별 수익률% (기간 시작 전날 대비)."""
    out = {}
    for label, (a, b) in PERIODS.items():
        before = eq[eq.index < a]
        part = eq[(eq.index >= a) & (eq.index <= b)]
        if part.empty:
            continue
        base = before.iloc[-1] if len(before) else CAPITAL
        out[label] = (part.iloc[-1] / base - 1) * 100
    return out


def index_curve(days, market="kr"):
    """지수 보유 (시작 전날 종가 = CAPITAL)."""
    mc = market_cfg(market)
    idx = pd.read_csv(os.path.join(mc["price_dir"], f"_index_{mc['index']}.csv"),
                      parse_dates=["Date"]).set_index("Date")["Close"]
    return CAPITAL * idx.reindex(days).ffill() / idx[idx.index < days[0]].iloc[-1]


def equal_curve(px, days):
    """같은 비중: 매일 시가에 전 종목 같은 금액 (다음 날 시가까지 수익률 평균)."""
    op = px["Open"]
    r = (op.shift(-1) / op - 1).reindex(days).mean(axis=1).shift(1).fillna(0)
    return CAPITAL * (1 + r).cumprod()


def benchmarks(px, days, market="kr"):
    days = pd.DatetimeIndex(days)
    mc = market_cfg(market)
    n = px["Open"].shape[1]
    return {mc["index_name"]: metrics(index_curve(days, market)),
            f"{n}종목 같은 비중": metrics(equal_curve(px, days))}


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


def compare_strategies(name, market="kr", px=None):
    """전략별 성과 표와 자산 곡선 {key: 평가금액}."""
    px = px if px is not None else load_prices(market)
    liquid, fear_high = load_context(market, with_momentum=True)
    pred = load_pred(name, market, liquid.drop(columns="ret_20d"))
    pred_mom = load_pred(name, market, liquid, score="momentum")
    rows, curves = [], {}
    for key, s in STRATEGIES.items():
        eq, traded, trades = run_strategy(key, pred, px, fear_high, market, pred_mom)
        curves[key] = eq
        m = metrics(eq, traded, trades)
        rows.append({"key": key, "전략": s["label"], **period_returns(eq), "전체%": m["수익률%"],
                     "MDD%": m["MDD%"], "샤프": m["샤프"], "매도 건수": m["매도 건수"], "승률%": m["승률%"],
                     "손절 비율%": m["손절 비율%"], "30일 거래금액(억)": m["30일 거래금액(억)"]})
    return pd.DataFrame(rows), curves, px


def aggr_grid(name, market="kr"):
    """공격형 손절(stop)·추적 익절(trail) 값 민감도. 시작 기준(trail_start)은 config 값 그대로."""
    px = load_prices(market)
    liquid, fear_high = load_context(market)
    pred = load_pred(name, market, liquid)
    mc = market_cfg(market)
    rows = []
    for stop, trail in itertools.product(*AGGR_GRID.values()):
        eq, traded, trades = simulate(pred, px, fear_high, 1, None, stop, trail_start=config.AGGR_BREAKEVEN_AT,
                                      trail=trail, delay_after_stop=True, costs=mc["costs"], limit_up=mc["limit_up"])
        m = metrics(eq, traded, trades)
        rows.append({"손절": stop, "추적": trail, **period_returns(eq), "전체%": m["수익률%"], "MDD%": m["MDD%"],
                     "매도 건수": m["매도 건수"], "손절 비율%": m["손절 비율%"]})
    return pd.DataFrame(rows)


def main():
    args = sys.argv[1:]
    market = "kr"
    if "--market" in args:
        i = args.index("--market")
        market = args[i + 1]
        args = args[:i] + args[i + 2:]
    pd.set_option("display.width", 220)
    pd.set_option("display.max_columns", 30)
    mc = market_cfg(market)

    if "--aggr-grid" in args:
        name = ([a for a in args if not a.startswith("--")] or ["A"])[0]
        print(f"공격형 손절·추적 익절 민감도 ({market}, 모델 {name}, 추적 시작 +{config.AGGR_BREAKEVEN_AT:.0%})")
        g = aggr_grid(name, market)
        print(g.round({c: 1 for c in g.columns if c not in ("손절", "추적")}).to_string(index=False))
        return

    names = args or (["A"] if market == "us" else ["A", "C"])
    px = load_prices(market)
    days = sorted(px["Open"].index)
    bench = {}
    for label, (a, b) in PERIODS.items():
        d = [x for x in days if pd.Timestamp(a) <= x <= pd.Timestamp(b)]
        if d:
            bench[label] = {k: v["수익률%"] for k, v in benchmarks(px, d, market).items()}
    print("비교 기준 수익률%:")
    print(pd.DataFrame(bench).round(1).to_string())

    for name in names:
        print(f"\n==================== {market} 모델 {name} ====================")
        if market == "kr":   # 기존 종목 수 x 매도 순위 조합 표 (기간마다 새로 시작)
            liquid, fear_high = load_context(market)
            pred = load_pred(name, market, liquid)
            rows = []
            for top_n, mult in itertools.product(*GRID.values()):
                rows.append({"top_n": top_n, "sell_rank": top_n * mult,
                             **by_period(pred, px, fear_high, top_n, top_n * mult,
                                         config.STOP_LOSS, config.FEAR_EXPOSURE)})
            grid = pd.DataFrame(rows).round(1)
            grid.to_csv(os.path.join(PRED_DIR, f"backtest_{name}.csv"), index=False, encoding="utf-8-sig")
            print(f"손절 {config.STOP_LOSS}, 공포 비중 {config.FEAR_EXPOSURE} | 기간별 수익률%")
            print(grid.to_string(index=False))
        table, _, _ = compare_strategies(name, market, px)
        table.round(1).to_csv(os.path.join(PRED_DIR, f"{mc['prefix']}strategies_{name}.csv"),
                              index=False, encoding="utf-8-sig")
        print("\n전략 비교 (연속 실행, 기간별 수익률%):")
        print(table.drop(columns="key").round(1).to_string(index=False))


if __name__ == "__main__":
    main()
