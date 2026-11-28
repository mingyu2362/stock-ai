"""매매전략 재설계 연구 (2026-11-28)

목표: 코스피 대비 안정적인 초과수익, 낙폭 제한. 안정형·공격형을 처음부터 다시 고른다.
고정 보유 기간 대신 보조지표로 매도한다. 사는 이유와 파는 신호의 성격을 맞춘다.
  - 반등형(rev): 눌린 종목을 산다 → 20일선 회복(볼린저 중앙선)이면 매도, 20거래일 안에 회복 못 하면 정리
  - 추세형(trend): 오르는 종목을 산다 → 종가가 20일선 아래면 매도, 고점에서 ATR x3 추적 손절
  - 공통: 처음 손절선 = 매수가 - ATR x2 (종목 변동성에 맞춰 폭이 자동으로 바뀜)
  - 시장 필터: 코스피 종가가 60일선 아래면 새로 사지 않음 (가진 종목은 각자 규칙대로)

과최적화 방지 (미리 정한 규칙, 결과를 보고 바꾸지 않는다)
  - 지표 숫자는 교과서 기본값 (RSI 14, 20·60일선, ATR 14, ATR x2 / x3)
  - 개발 기간(DEV)에서만 비교해 고른다. 검증 기간(HOLD)은 고른 뒤 한 번만 본다
  - 안정형: 6종목, 개발 기간 칼마 비율(연수익률 / |MDD|) 최고
  - 공격형: 3종목, 개발 기간 수익률 최고 (단 MDD -25% 이내)
    → 개발 기간에서 만족 후보가 없어 보조 기준 MDD -35% 이내를 추가 (검증 기간을 보기 전에 정함)
  - 고른 전략은 숫자 흔들기(ATR 배수·RSI 기준·이동평균 길이)와 순위 잡음으로 안정성 확인

신호 시점: 모든 지표는 전날 종가까지 → 오늘 시가에 매매. 장중 손절은 아침 손절선 기준.
비용: 수수료 config.COMMISSION, 매도세 config.SELL_TAX, 시가 체결 미끄러짐 0.05%, 손절 체결 0.2% 불리하게.

한계: 종목 목록이 2026-09 지수 구성이라 과거(특히 2025년)에 생존 편향이 있다 → 추세형이 유리하게 나옴.
      AI 점수 = model_A.csv(월별 롤링 예측) + 11월 실전 순위 파일(rank_YYYYMMDD.csv), 빈 날은 직전 점수(최대 5일).

실행: python model/strategy_lab.py            (개발 기간 후보 비교 → 선택 → 안정성 → 검증 기간)
출력: data/predictions/lab_*.csv
"""

import glob
import os
import sys

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import config  # noqa: E402

PRICE_DIR = os.path.join(ROOT, "data", "raw", "price")
PRED_DIR = os.path.join(ROOT, "data", "predictions")

DEV = ("2025-01-02", "2026-06-30")
HOLD = ("2026-07-01", "2026-12-31")

CAPITAL = 100_000_000
CASH_BUFFER = 0.99
SLIP = 0.0005
STOP_SLIP = 0.002
LIMIT_UP = 0.29

BASE = {"atr_init": 2.0, "atr_trail": 3.0, "rsi_th": 35, "max_hold": 20, "ma": 20, "filter": True}

# 후보 (모두 시장 필터 켬). entry: 매수 후보와 점수, family: 매도 규칙 묶음
CANDIDATES = {
    "R1": {"label": "AI 눌림목", "desc": "20일선 아래 종목 중 AI 점수 순", "entry": "ai_dip", "family": "rev"},
    "R2": {"label": "AI 눌림목 + 상승추세", "desc": "20일선 아래지만 60일 수익률 + 인 종목 중 AI 점수 순",
           "entry": "ai_dip_up", "family": "rev"},
    "R3": {"label": "RSI 과매도 + 상승추세", "desc": "RSI14 < 35 이고 60일 수익률 + 인 종목, RSI 낮은 순",
           "entry": "rsi_dip_up", "family": "rev"},
    "T1": {"label": "AI 추세", "desc": "종가 > 20일선 > 60일선 종목 중 AI 점수 순", "entry": "ai_trend",
           "family": "trend"},
    "T2": {"label": "모멘텀 추세", "desc": "종가 > 20일선 > 60일선 종목 중 60일 수익률 순", "entry": "mom_trend",
           "family": "trend"},
    "T3": {"label": "저변동 추세", "desc": "종가 > 20일선 > 60일선 종목 중 20일 변동성 낮은 순",
           "entry": "lowvol_trend", "family": "trend"},
}
# 비교용 (선택 대상 아님)
REFERENCE = {
    "OLD_STABLE": {"label": "이전 안정형", "desc": "AI 상위 3, 12위 밖 매도, 손절·필터 없음", "entry": "ai",
                   "family": "rank", "filter": False, "slots": 3},
}
SLOTS = {"stable": 6, "aggressive": 3}
AGGR_MDD_LIMIT = -25.0
AGGR_MDD_FALLBACK = -35.0


# ---------------------------------------------------------------- 데이터

def load_data():
    u = pd.read_csv(os.path.join(ROOT, "data", "universe.csv"), dtype={"code": str})
    frames = {}
    for code in u["code"]:
        path = os.path.join(PRICE_DIR, f"{code}.csv")
        if os.path.exists(path):
            frames[code] = pd.read_csv(path, parse_dates=["Date"]).set_index("Date")
    px = {k: pd.DataFrame({c: f[k] for c, f in frames.items()}).sort_index()
          for k in ["Open", "High", "Low", "Close", "Volume"]}
    dates = px["Close"].index
    idx = pd.read_csv(os.path.join(PRICE_DIR, "_index_KOSPI.csv"), parse_dates=["Date"]).set_index("Date")["Close"]
    idx = idx.reindex(dates).ffill()

    C, H, L = px["Close"], px["High"], px["Low"]
    prev = C.shift(1)
    tr = np.maximum(H - L, np.maximum((H - prev).abs(), (L - prev).abs()))
    delta = C.diff()
    up = delta.clip(lower=0).ewm(alpha=1 / 14, adjust=False).mean()
    dn = (-delta.clip(upper=0)).ewm(alpha=1 / 14, adjust=False).mean()
    ind = {   # 그날 종가 기준
        "close": C,
        "rsi": 100 - 100 / (1 + up / dn),
        "atr": tr.ewm(alpha=1 / 14, adjust=False).mean(),
        "ret60": C / C.shift(60) - 1,
        "vol20": C.pct_change().rolling(20).std(),
        "liquid": (C * px["Volume"]).rolling(20).mean() >= config.MIN_VALUE_KRW,
    }
    for n in (10, 15, 20, 30, 40, 60, 90):
        ind[f"ma{n}"] = C.rolling(n).mean()
    mkt_ok = (idx >= idx.rolling(60).mean()).shift(1, fill_value=False)

    return {"dates": dates, "codes": list(C.columns), "px": px, "ind": ind, "idx": idx,
            "mkt_ok": mkt_ok.values, "ai": load_ai(dates, list(C.columns))}


def load_ai(dates, codes):
    pred = pd.read_csv(os.path.join(PRED_DIR, "model_A.csv"), dtype={"code": str}, parse_dates=["date"])
    parts = [pred[["date", "code", "score"]]]
    last = pred["date"].max()
    for f in sorted(glob.glob(os.path.join(PRED_DIR, "rank_*.csv"))):
        day = pd.Timestamp(os.path.basename(f)[5:13])
        if day > last:
            r = pd.read_csv(f, dtype={"code": str})
            parts.append(r[["code", "score"]].assign(date=day))
    wide = pd.concat(parts).pivot_table(index="date", columns="code", values="score")
    return wide.reindex(index=dates, columns=codes).ffill(limit=5)


# ---------------------------------------------------------------- 신호

def signals(d, spec):
    """(매수 점수 [-inf = 후보 아님], 매도 신호) — 둘 다 오늘 매매용 (전날 종가 기준)."""
    ind, p = d["ind"], {**BASE, **spec}
    sh = lambda k: ind[k].shift(1)                      # noqa: E731
    close, ma, ma60 = sh("close"), sh(f"ma{p['ma']}"), sh("ma60")
    liquid = ind["liquid"].astype(float).shift(1).fillna(0).astype(bool)
    ai = d["ai"]
    e = p["entry"]
    if e == "ai":
        ok, score = ai.notna(), ai
    elif e == "ai_dip":
        ok, score = close < ma, ai
    elif e == "ai_dip_up":
        ok, score = (close < ma) & (sh("ret60") > 0), ai
    elif e == "rsi_dip_up":
        ok, score = (sh("rsi") < p["rsi_th"]) & (sh("ret60") > 0), -sh("rsi")
    elif e == "ai_trend":
        ok, score = (close > ma) & (ma > ma60), ai
    elif e == "mom_trend":
        ok, score = (close > ma) & (ma > ma60), sh("ret60")
    elif e == "lowvol_trend":
        ok, score = (close > ma) & (ma > ma60), -sh("vol20")
    else:
        raise ValueError(e)
    score = score.where(ok & liquid & score.notna(), -np.inf)

    f = p["family"]
    if f == "rev":
        exit_sig = close >= ma
    elif f == "trend":
        exit_sig = close < ma
    elif f == "rank":
        exit_sig = ai.rank(axis=1, ascending=False) > 12
    else:
        raise ValueError(f)
    return score.values.astype(float), exit_sig.fillna(False).values


# ---------------------------------------------------------------- 시뮬레이션

def simulate(d, spec, start, end, slots, noise=0.0, seed=0):
    p = {**BASE, **spec}
    score, exit_sig = signals(d, p)
    if noise:
        rng = np.random.default_rng(seed)
        valid = np.isfinite(score)
        pct = pd.DataFrame(np.where(valid, score, np.nan)).rank(axis=1, pct=True).values
        score = np.where(valid, pct + rng.normal(0, noise, score.shape), -np.inf)
    px = d["px"]
    O, H, L, C = (px[k].values for k in ["Open", "High", "Low", "Close"])
    PC = px["Close"].shift(1).values
    atr_prev = d["ind"]["atr"].shift(1).values
    atr_now = d["ind"]["atr"].values
    dates = d["dates"]
    ids = np.where((dates >= pd.Timestamp(start)) & (dates <= pd.Timestamp(end)))[0]
    comm, tax = config.COMMISSION, config.SELL_TAX
    family, use_filter = p["family"], p["filter"]

    cash, pos, last = float(CAPITAL), {}, {}     # pos[j] = [주식 수, 매수 단가, 종가 고점, 손절선, 보유일]
    equity, invested, trades = [], [], []
    turnover = 0.0

    def sell(j, price, reason, t):
        nonlocal cash, turnover
        sh_, entry, _, _, days = pos.pop(j)
        cash += sh_ * price * (1 - comm - tax)
        turnover += sh_ * price
        trades.append((dates[t], d["codes"][j], reason, price * (1 - comm - tax) / (entry * (1 + comm)) - 1, days))

    for t in ids:
        o, h, lo, c = O[t], H[t], L[t], C[t]
        sold = set()
        # 1. 시가 매도: 손절선 아래 시작 / 지표 매도 신호 / 반등형 시간 정리
        for j in list(pos):
            if np.isnan(o[j]):
                continue
            ps = pos[j]
            if o[j] <= ps[3]:
                sell(j, o[j] * (1 - SLIP), "stop_gap", t)
            elif exit_sig[t, j]:
                sell(j, o[j] * (1 - SLIP), "signal", t)
            elif family == "rev" and p["max_hold"] and ps[4] >= p["max_hold"]:
                sell(j, o[j] * (1 - SLIP), "time", t)
            else:
                continue
            sold.add(j)
        # 2. 시가 매수
        if len(pos) < slots and (not use_filter or d["mkt_ok"][t]):
            eq_open = cash + sum(s[0] * (o[j] if not np.isnan(o[j]) else last[j]) for j, s in pos.items())
            target = eq_open * CASH_BUFFER / slots
            sc = score[t].copy()
            bad = np.isnan(o) | np.isnan(PC[t]) | (o >= PC[t] * (1 + LIMIT_UP)) | np.isnan(atr_prev[t])
            sc[bad] = -np.inf
            for j in list(pos) + list(sold):
                sc[j] = -np.inf
            for j in np.lexsort((np.arange(len(sc)), -sc)):
                if len(pos) >= slots or not np.isfinite(sc[j]):
                    break
                price = o[j] * (1 + SLIP)
                n = int(min(target, cash / (1 + comm)) // price)
                if n == 0:
                    continue
                cash -= n * price * (1 + comm)
                turnover += n * price
                stop = o[j] - p["atr_init"] * atr_prev[t, j] if family != "rank" else -np.inf
                pos[j] = [n, price, o[j], stop, 0]
        # 3. 장중 손절
        for j in list(pos):
            if not np.isnan(lo[j]) and lo[j] <= pos[j][3]:
                sell(j, pos[j][3] * (1 - STOP_SLIP), "stop", t)
        # 4. 종가: 고점·추적 손절 갱신, 평가
        for j, ps in pos.items():
            if not np.isnan(c[j]):
                last[j] = c[j]
                ps[2] = max(ps[2], c[j])
                if family == "trend":
                    ps[3] = max(ps[3], ps[2] - p["atr_trail"] * atr_now[t, j])
            last.setdefault(j, ps[1])
            ps[4] += 1
        stock = sum(s[0] * last[j] for j, s in pos.items())
        equity.append(cash + stock)
        invested.append(stock / (cash + stock))

    eq = pd.Series(equity, index=dates[ids])
    tr = pd.DataFrame(trades, columns=["date", "code", "reason", "ret", "days"])
    return eq, tr, float(np.mean(invested)), turnover


def metrics(eq, tr, invested, turnover, idx):
    ret = eq.pct_change().fillna(eq.iloc[0] / CAPITAL - 1)
    years = len(eq) / 252
    total = eq.iloc[-1] / CAPITAL - 1
    cagr = (1 + total) ** (1 / years) - 1
    mdd = (eq / eq.cummax() - 1).min()
    k = idx.reindex(eq.index)
    k_base = idx[idx.index < eq.index[0]].iloc[-1]
    k_total = k.iloc[-1] / k_base - 1
    k_mdd = (k / k.cummax() - 1).min()
    return {
        "수익률%": total * 100, "코스피%": k_total * 100, "초과%p": (total - k_total) * 100,
        "MDD%": mdd * 100, "코스피MDD%": k_mdd * 100,
        "칼마": cagr / abs(mdd) if mdd < 0 else np.nan,
        "샤프": ret.mean() / ret.std() * np.sqrt(252) if ret.std() > 0 else np.nan,
        "매매": len(tr), "승률%": (tr["ret"] > 0).mean() * 100 if len(tr) else np.nan,
        "평균보유일": tr["days"].mean() if len(tr) else np.nan,
        "평균손익%": tr["ret"].mean() * 100 if len(tr) else np.nan,
        "투자비중%": invested * 100,
        "연회전율": turnover / CAPITAL / years,
    }


def run(d, spec, period, slots, **kw):
    eq, tr, inv, to = simulate(d, spec, *period, slots, **kw)
    return metrics(eq, tr, inv, to, d["idx"]), eq, tr


# ---------------------------------------------------------------- 연구 단계

def compare(d, period):
    rows = []
    for key, s in CANDIDATES.items():
        for kind, n in SLOTS.items():
            m, _, _ = run(d, s, period, n)
            rows.append({"key": key, "전략": s["label"], "종목수": n, **m})
            m, _, _ = run(d, {**s, "filter": False}, period, n)
            rows.append({"key": key, "전략": s["label"] + " (필터 없음)", "종목수": n, **m})
    for key, s in REFERENCE.items():
        m, _, _ = run(d, s, period, s["slots"])
        rows.append({"key": key, "전략": s["label"], "종목수": s["slots"], **m})
    return pd.DataFrame(rows)


def choose(dev):
    c = dev[dev["key"].isin(CANDIDATES) & ~dev["전략"].str.contains("필터 없음")]
    st = c[c["종목수"] == SLOTS["stable"]].sort_values("칼마", ascending=False).iloc[0]
    ag = c[(c["종목수"] == SLOTS["aggressive"]) & (c["MDD%"] >= AGGR_MDD_LIMIT)]
    if ag.empty:
        ag = c[(c["종목수"] == SLOTS["aggressive"]) & (c["MDD%"] >= AGGR_MDD_FALLBACK)]
    ag = ag.sort_values("수익률%", ascending=False).iloc[0] if len(ag) else None
    return st["key"], (ag["key"] if ag is not None else None)


def robustness(d, key, slots, period):
    """숫자 흔들기 + 순위 잡음 8회."""
    s = CANDIDATES[key]
    rows = []
    shakes = [("기본", {})]
    shakes += [(f"처음 손절 ATR x{v}", {"atr_init": v}) for v in (1.5, 2.5, 3.0)]
    shakes += [(f"이동평균 {v}일", {"ma": v}) for v in (15, 30)]
    if s["family"] == "trend":
        shakes += [(f"추적 ATR x{v}", {"atr_trail": v}) for v in (2.0, 2.5, 3.5, 4.0)]
    else:
        shakes += [(f"시간 정리 {v}일", {"max_hold": v}) for v in (10, 30, 0)]
    if s["entry"] == "rsi_dip_up":
        shakes += [(f"RSI < {v}", {"rsi_th": v}) for v in (30, 40)]
    for name, ch in shakes:
        m, _, _ = run(d, {**s, **ch}, period, slots)
        rows.append({"변형": name, **m})
    for seed in range(8):
        m, _, _ = run(d, s, period, slots, noise=0.1, seed=seed)
        rows.append({"변형": f"순위 잡음 {seed + 1}", **m})
    return pd.DataFrame(rows)


SHOW = ["전략", "종목수", "수익률%", "코스피%", "초과%p", "MDD%", "코스피MDD%", "칼마", "샤프", "매매", "승률%",
        "평균보유일", "평균손익%", "투자비중%", "연회전율"]


def main():
    pd.set_option("display.width", 250)
    pd.set_option("display.max_columns", 30)
    pd.set_option("display.unicode.east_asian_width", True)
    d = load_data()
    print(f"데이터: {d['dates'][0].date()} ~ {d['dates'][-1].date()}, {len(d['codes'])}종목")

    stage = sys.argv[1] if len(sys.argv) > 1 else "all"
    dev = compare(d, DEV)
    dev.round(2).to_csv(os.path.join(PRED_DIR, "lab_dev.csv"), index=False, encoding="utf-8-sig")
    print(f"\n[1] 개발 기간 {DEV[0]} ~ {DEV[1]}")
    print(dev[SHOW].round(2).to_string(index=False))
    st, ag = choose(dev)
    print(f"\n[2] 선택 (미리 정한 기준): 안정형 = {st} {CANDIDATES[st]['label']}, "
          f"공격형 = {ag} {CANDIDATES[ag]['label'] if ag else '조건 만족 없음'}")
    if stage == "dev":
        return

    for kind, key in (("stable", st), ("aggressive", ag)):
        if key is None:
            continue
        r = robustness(d, key, SLOTS[kind], DEV)
        r.round(2).to_csv(os.path.join(PRED_DIR, f"lab_robust_{kind}.csv"), index=False, encoding="utf-8-sig")
        print(f"\n[3] 안정성 ({kind} = {key}, 개발 기간)")
        print(r[["변형"] + SHOW[2:]].round(2).to_string(index=False))

    hold = compare(d, HOLD)
    hold.round(2).to_csv(os.path.join(PRED_DIR, "lab_hold.csv"), index=False, encoding="utf-8-sig")
    print(f"\n[4] 검증 기간 {HOLD[0]} ~ {d['dates'][-1].date()} (전 후보 공개, 선택은 위에서 이미 끝남)")
    print(hold[SHOW].round(2).to_string(index=False))


if __name__ == "__main__":
    main()
