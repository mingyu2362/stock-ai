"""매매 전략 "AI 추세" (2026-11-28 재설계, 안정형·공격형 공통)

근거: model/strategy_lab.py (개발 2025-01~2026-06 에서 고르고 2026-07~11 검증 기간에 한 번 확인)
  검증 기간 코스피 -45% 일 때 안정형 -11% (MDD -15%), 공격형 -16% (MDD -17%)

규칙 (지표는 모두 전날 종가 기준, config.STRAT_*)
- 매수 후보: 종가 > 20일선 > 60일선 (오르는 종목), 거래대금 충분, 시세 끊기지 않음 → AI 점수 순
- 시장 필터: 코스피 종가가 60일선 아래면 새로 사지 않음 (가진 종목은 각자 규칙대로)
- 종목 수: 안정형 config.SLOTS["stable"](6), 공격형 config.SLOTS["aggressive"](3). 자리당 총평가 x 0.99 / 종목 수
- 매도 (먼저 닿는 것)
  1) 종가가 20일선 아래 → 다음 날 아침 동시호가 매도
  2) 손절선: 처음 = 매수가 - ATR x2, 그 뒤 매일 종가로 max(손절선, 종가 고점 - ATR x3) 로만 올림
     장중 현재가가 손절선 이하이면 바로 시장가 매도 (trade/monitor.py), 손절선 아래로 마감해도 다음 날 아침 매도
- 성향을 바꿔도 가진 종목은 억지로 팔지 않는다. 자리 수가 줄면 빈 자리가 생길 때까지 사지 않음

파일
data/strategy/mode.json       {"mode": "stable" | "aggressive", ...}  대시보드 버튼(dashboard/api/mode.js)만 쓴다
data/strategy/positions.json  보유 상태 (매매 프로그램만 쓴다)
    {"positions": [{code, name, shares, entry, entry_date, atr_entry, peak, atr, stop, stop_reason}
     (exit_reason 이 있으면 오늘 아침 매도 대상)],
     "exits": [최근 정리 20건], "market": {...}, "rules": {...}, "updated_at"}
    두 파일을 나눈 이유: Actions 실행이 커밋할 때 충돌을 자기 쪽으로 풀어서(-X theirs)
    같은 파일이면 실행 중에 누른 버튼이 덮어써질 수 있다
잔고에는 있는데 기록에 없는 종목(예전 규칙으로 산 것, 손으로 산 것)은 평균 단가를 매수가로 보고 편입해
같은 규칙(20일선·손절선)으로 다룬다.
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import config  # noqa: E402

KST = timezone(timedelta(hours=9))
STRATEGY_DIR = os.path.join(ROOT, "data", "strategy")
MODE_FILE = os.path.join(STRATEGY_DIR, "mode.json")
STATE_FILE = os.path.join(STRATEGY_DIR, "positions.json")
STATE_REL = "data/strategy/positions.json"
PRICE_DIR = os.path.join(ROOT, "data", "raw", "price")
UNIVERSE_FILE = os.path.join(ROOT, "data", "universe.csv")
MODES = ("stable", "aggressive")
LABEL = {"stable": "안정형", "aggressive": "공격형"}
KEEP_EXITS = 20
CASH_BUFFER = 0.99


def _read(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _git_show(rel):
    r = subprocess.run(f"git fetch -q origin main && git show origin/main:{rel}", shell=True, cwd=ROOT,
                       capture_output=True, text=True, encoding="utf-8")
    return json.loads(r.stdout) if r.returncode == 0 else None


def load_mode(remote=False):
    """지금 투자 성향. remote=True 면 원격 저장소의 최신 값 (Actions 장중 감시가 실행 중 버튼 변경을 알아채게)."""
    data = _git_show("data/strategy/mode.json") if remote else None
    mode = (data if data is not None else _read(MODE_FILE, {})).get("mode")
    return mode if mode in MODES else "stable"


def slots(mode=None):
    return config.SLOTS[mode or load_mode()]


def load_state(remote=False):
    s = _git_show(STATE_REL) if remote else None
    s = s if s is not None else _read(STATE_FILE, {})
    s.setdefault("positions", [])
    s.setdefault("exits", [])
    return s


def rules():
    return {"slots": config.SLOTS, "ma": config.STRAT_MA, "ma_long": config.STRAT_MA_LONG,
            "atr_n": config.STRAT_ATR_N, "atr_init": config.STRAT_ATR_INIT, "atr_trail": config.STRAT_ATR_TRAIL,
            "market_ma": config.STRAT_MARKET_MA}


def save_state(state):
    state["rules"] = rules()
    state["exits"] = state.get("exits", [])[-KEEP_EXITS:]
    state["updated_at"] = datetime.now(KST).isoformat(timespec="seconds")
    os.makedirs(STRATEGY_DIR, exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)


# ---------------------------------------------------------------- 지표

def _atr(df, n):
    prev = df["Close"].shift(1)
    tr = np.maximum(df["High"] - df["Low"], np.maximum((df["High"] - prev).abs(), (df["Low"] - prev).abs()))
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def market_filter(with_index=False):
    """시장 필터: 코스피 마지막 종가가 STRAT_MARKET_MA 일선 이상이면 ok (새로 살 수 있음)."""
    idx = pd.read_csv(os.path.join(PRICE_DIR, "_index_KOSPI.csv"), parse_dates=["Date"]).set_index("Date")["Close"]
    kma = idx.rolling(config.STRAT_MARKET_MA).mean()
    market = {"date": f"{idx.index[-1]:%Y-%m-%d}", "kospi": round(float(idx.iloc[-1]), 2),
              "kospi_ma": round(float(kma.iloc[-1]), 2), "ok": bool(idx.iloc[-1] >= kma.iloc[-1])}
    return (market, idx) if with_index else market


def snapshot():
    """종목별 마지막 종가 기준 지표 (index=code): last_date, close, ma, ma_long, atr, trend, fresh.
    그리고 시장 필터 {"date", "kospi", "kospi_ma", "ok"}."""
    market, idx = market_filter(with_index=True)
    rows = []
    u = pd.read_csv(UNIVERSE_FILE, dtype={"code": str})
    for code in u["code"]:
        path = os.path.join(PRICE_DIR, f"{code}.csv")
        if not os.path.exists(path):
            continue
        p = pd.read_csv(path, parse_dates=["Date"]).set_index("Date")
        if len(p) < config.STRAT_MA_LONG:
            continue
        c = p["Close"]
        rows.append({"code": code, "last_date": p.index[-1], "close": float(c.iloc[-1]),
                     "prev_close": float(c.iloc[-2]),
                     "ma": float(c.rolling(config.STRAT_MA).mean().iloc[-1]),
                     "ma_long": float(c.rolling(config.STRAT_MA_LONG).mean().iloc[-1]),
                     "atr": float(_atr(p, config.STRAT_ATR_N).iloc[-1])})
    snap = pd.DataFrame(rows).set_index("code")
    snap["fresh"] = snap["last_date"] == idx.index[-1]
    snap["trend"] = (snap["close"] > snap["ma"]) & (snap["ma"] > snap["ma_long"])
    return snap, market


# ---------------------------------------------------------------- 손절선

def set_stop(pos, close, atr):
    """종가로 고점·ATR 을 갱신하고 손절선을 올린다 (내리지 않음). 같은 종가로 여러 번 불러도 결과가 같다."""
    pos["peak"] = max(pos["peak"], close)
    pos["atr"] = atr
    trail = pos["peak"] - config.STRAT_ATR_TRAIL * atr
    init = pos["entry"] - config.STRAT_ATR_INIT * pos["atr_entry"]
    if trail > init:
        stop, why = round(trail), f"추적 손절 (종가 고점 {pos['peak']:,.0f} - ATR x{config.STRAT_ATR_TRAIL:g})"
    else:
        stop, why = round(init), f"처음 손절 (매수가 - ATR x{config.STRAT_ATR_INIT:g})"
    if stop >= pos.get("stop", 0):     # ATR 이 커져도 손절선은 내려가지 않는다
        pos["stop"], pos["stop_reason"] = stop, why


def new_position(code, name, shares, entry, entry_date, atr_prev):
    pos = {"code": code, "name": name, "shares": int(shares), "entry": float(entry), "entry_date": entry_date,
           "atr_entry": float(atr_prev), "peak": float(entry), "atr": float(atr_prev)}
    set_stop(pos, float(entry), float(atr_prev))
    return pos


def today_atr(pos_atr_prev, prev_close, high, low):
    """어제까지의 ATR 에 오늘 고가·저가·전일 종가로 하루를 더한 ATR (Wilder)."""
    tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
    n = config.STRAT_ATR_N
    return (pos_atr_prev * (n - 1) + tr) / n


def record_exit(state, pos, price, reason, shares=None, estimated=False):
    t = datetime.now(KST)
    state.setdefault("exits", []).append({
        "date": t.strftime("%Y-%m-%d"), "time": t.strftime("%H:%M"), "code": pos["code"], "name": pos["name"],
        "shares": shares if shares is not None else pos["shares"], "price": round(price) if price else None,
        "entry": round(pos["entry"]), "reason": reason, **({"estimated": True} if estimated else {}),
    })
    state["positions"] = [p for p in state["positions"] if p["code"] != pos["code"]]


# ---------------------------------------------------------------- 아침 주문

def plan(ranking, holdings, cash, mode=None, state=None, snap=None, market=None, today=None, log=print):
    """아침 주문 목록과 바뀐 보유 상태.
    ranking: model/predict.py rank_stocks() 결과 (index=code, rank·name·buyable·last_close)
    holdings: {code: {"name", "shares", "avg_price"(없어도 됨)}}
    반환: (orders DataFrame[action, code, name, shares, ref_price, amount, rank, reason, atr], state)
    state["positions"] 에는 오늘 팔 종목도 exit_reason 을 달고 남아 있다 (매도 주문 뒤 record_exit)"""
    mode = mode or load_mode()
    n_slots = slots(mode)
    state = state if state is not None else load_state()
    if snap is None:
        snap, market = snapshot()
    today = today or datetime.now(KST).strftime("%Y-%m-%d")
    names = ranking["name"].to_dict() if "name" in ranking else {}
    ranks = ranking["rank"].to_dict()
    price_of = lambda c: snap["close"].get(c, ranking["last_close"].get(c, np.nan))  # noqa: E731
    total = cash + sum(h["shares"] * price_of(c) for c, h in holdings.items() if not np.isnan(price_of(c)))

    tracked = {p["code"]: p for p in state["positions"]}
    gone = set(tracked) - set(holdings)
    if gone:
        log(f"기록에 있지만 잔고에 없는 종목 {sorted(gone)} → 기록에서 지움")
    positions, orders = [], []
    for code, h in holdings.items():
        name = h.get("name") or names.get(code, code)
        s = snap.loc[code] if code in snap.index else None
        pos = tracked.get(code)
        if pos is None:
            if s is None:
                orders.append(("sell", code, name, h["shares"], ranks.get(code), "지표 없음 (대상 종목 아님)"))
                continue
            entry = h.get("avg_price") or s["close"]
            pos = new_position(code, name, h["shares"], entry, today, s["atr"])
            log(f"{name}: 기록에 없던 보유 → 새 규칙으로 편입 (매수가 {entry:,.0f}, 손절선 {pos['stop']:,})")
        pos = {**pos, "shares": int(h["shares"]), "name": name}
        if s is not None and s["last_date"] >= pd.Timestamp(pos["entry_date"]):
            set_stop(pos, s["close"], s["atr"])
        why = None
        if s is not None and s["close"] < s["ma"]:
            why = f"20일선 이탈 (종가 {s['close']:,.0f} < {config.STRAT_MA}일선 {s['ma']:,.0f})"
        elif s is not None and s["close"] <= pos["stop"]:
            why = f"손절선 아래 마감 (종가 {s['close']:,.0f} <= {pos['stop']:,})"
        if why:
            orders.append(("sell", code, name, h["shares"], ranks.get(code), why))
            pos["exit_reason"] = why
            log(f"{name}: {why} → 동시호가 매도")
        else:
            log(f"{name}: 보유 유지 (손절선 {pos['stop']:,}, {pos['stop_reason']})")
        positions.append(pos)
    keep = [p for p in positions if "exit_reason" not in p]

    free = n_slots - len(keep)
    per_slot = total * CASH_BUFFER / n_slots
    if free > 0 and not market["ok"]:
        log(f"시장 필터: 코스피 {market['kospi']:,.0f} < {config.STRAT_MARKET_MA}일선 {market['kospi_ma']:,.0f} "
            f"→ 새로 사지 않음 (빈 자리 {free})")
    elif free > 0:
        r = ranking[["rank", "name", "buyable"]].join(
            snap[["trend", "fresh", "close"]].rename(columns={"fresh": "px_fresh"}), how="inner")
        cand = r[r["buyable"] & r["px_fresh"] & r["trend"] & ~r.index.isin(list(holdings))].sort_values("rank")
        for code, row in cand.head(free).iterrows():
            shares = int(min(per_slot, config.MAX_ORDER_KRW) // row["close"])
            if shares > 0:
                orders.append(("buy", code, row.get("name", code), shares, row["rank"],
                               f"추세 (종가 > {config.STRAT_MA}일선 > {config.STRAT_MA_LONG}일선) 중 AI {int(row['rank'])}위"))
                log(f"매수: AI {int(row['rank'])}위 {row.get('name', code)} (자리당 {per_slot:,.0f}원)")
        if len(cand) < free:
            log(f"추세 조건 만족 종목이 {len(cand)}개뿐 → 빈 자리 {free - len(cand)}개는 현금")

    o = pd.DataFrame(orders, columns=["action", "code", "name", "shares", "rank", "reason"])
    o["ref_price"] = o["code"].map(lambda c: price_of(c))
    o["amount"] = o["shares"] * o["ref_price"]
    o["atr"] = o["code"].map(lambda c: round(float(snap["atr"][c]), 2) if c in snap.index else np.nan)
    state = {**state, "positions": positions, "market": market, "mode": mode}
    return o[["action", "code", "name", "shares", "ref_price", "amount", "rank", "reason", "atr"]], state


# ---------------------------------------------------------------- 장 마감

def close_update(state, holdings, quote, today, log=print):
    """장 마감 후: 잔고에 남은 기록 종목의 종가 고점·ATR·손절선 갱신 (손으로 판 종목은 기록에서 지움).
    quote(code) -> {"price", "high", "low"} (한투 현재가 = 마감 후에는 종가).
    시세 파일에 오늘 줄이 아직 없으면 어제까지의 ATR 에 오늘 고가·저가를 더해 센다."""
    kept = []
    for pos in state["positions"]:
        shares = holdings.get(pos["code"], {}).get("shares", 0)
        if shares <= 0:
            log(f"{pos['name']}: 잔고에 없어 기록에서 지움")
            continue
        pos = {**pos, "shares": shares}
        pos.pop("exit_reason", None)
        p = pd.read_csv(os.path.join(PRICE_DIR, f"{pos['code']}.csv"), parse_dates=["Date"]).set_index("Date")
        atr = _atr(p, config.STRAT_ATR_N)
        if f"{p.index[-1]:%Y-%m-%d}" == today:
            close, a = float(p["Close"].iloc[-1]), float(atr.iloc[-1])
        else:
            q = quote(pos["code"])
            close = q["price"]
            a = today_atr(float(atr.iloc[-1]), float(p["Close"].iloc[-1]), q["high"], q["low"])
        set_stop(pos, close, a)
        log(f"{pos['name']}: 종가 {close:,.0f}, 고점 {pos['peak']:,.0f}, ATR {a:,.0f} → 손절선 {pos['stop']:,} ({pos['stop_reason']})")
        kept.append(pos)
    state["positions"] = kept
    return state
