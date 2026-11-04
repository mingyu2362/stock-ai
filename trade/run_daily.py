"""매 거래일 실행 흐름 (한투 모의투자)

아침 (python -m trade.run_daily [--live])   06:40 ~ 08:00 사이에 시작
1. 주말이면 종료, 같은 날 이미 주문했으면 종료 (중복 주문 방지)
2. 잔고 조회 → data/trades/holdings.csv
3. model/daily.py --cash --holdings  (수집 → 피처 → 예측 → orders_{오늘}.csv, 월요일은 재학습)
   08:30 이후에 시작했으면 이미 만든 orders_{오늘}.csv 를 쓰고, 없으면 그때 예측한다 (재학습 없이)
   → 늦게 시작하면 매도·매수가 시가가 아니라 그 시각 가격으로 나간다
4. 08:30 ~ 09:00 동시호가: 매도 주문 (시장가)
5. 09:00 직후: 매수 주문 (현재가 +1% 지정가 → 즉시 체결, 1분 안에 안 되면 취소 후 새 가격으로 최대 3번)
   시장가 매수는 한투가 상한가 근처 가격으로 현금을 잡아 두어 여러 종목을 다 살 수 없어서 지정가를 쓴다
   매수 금액은 주문가능현금 안에서 종목마다 같게 나눈다

장 마감 후 (python -m trade.run_daily --close)   15:40 이후
- 오늘 체결 → data/trades/trades.csv, 총평가금액 → equity.csv, 보유 → holdings.csv
- dashboard/export.py (대시보드 데이터 갱신)

안전장치
- --live 를 주지 않고 config.DRY_RUN=True 이면 주문하지 않고 "이렇게 주문하겠다"만 출력
- 실제 주문은 GitHub Actions 에서만 (PC 에서는 --allow-local 을 붙여야 함, 같은 날 두 번 주문 방지)
- 같은 날 매수까지 끝낸 기록(data/trades/log_{날짜}.json)이 있으면 다시 주문하지 않음
- 종목당 최대 주문 금액 config.MAX_ORDER_KRW

시험 (python -m trade.run_daily --test)   아무 때나
- 주문 없이(DRY RUN) 시각·오늘 기록과 상관없이 수집·예측부터 다시 돌려 "이렇게 주문하겠다"를 출력
- 오늘 주문 기록(log_날짜.json)은 건드리지 않는다. 주가·시장 지표는 종가가 확정된 날까지만 받는다
"""

import argparse
import json
import math
import os
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import config  # noqa: E402
from trade import aggressive  # noqa: E402
from trade.kis_api import Kis, KisError, round_up_tick  # noqa: E402

KST = timezone(timedelta(hours=9))
TRADE_DIR = os.path.join(ROOT, "data", "trades")
PRED_DIR = os.path.join(ROOT, "data", "predictions")
HOLDINGS_FILE = os.path.join(TRADE_DIR, "holdings.csv")
AUCTION_START = (8, 30, 10)      # 매도 주문 시각
BUY_START = (9, 0, 30)           # 매수 시작 시각 (시가 체결 직후)
BUY_PREMIUM = 0.01               # 매수 지정가 = 현재가 x (1 + 1%)
BUY_ROUNDS = 3                   # 안 되면 취소 후 다시 내는 횟수
ROUND_WAIT_SEC = 60
CASH_USE = 0.995                 # 주문가능현금 중 쓰는 비율 (수수료 여유)


def now():
    return datetime.now(KST)


def log(msg):
    print(f"[{now():%H:%M:%S}] {msg}", flush=True)


def wait_until(hms):
    target = now().replace(hour=hms[0], minute=hms[1], second=hms[2], microsecond=0)
    sec = (target - now()).total_seconds()
    if sec > 0:
        log(f"{target:%H:%M:%S} 까지 대기 ({sec / 60:.0f}분)")
        time.sleep(sec)


class DayLog:
    """그날 보낸 주문 기록 (중복 주문 방지 + 나중에 확인용)."""

    def __init__(self, day):
        self.path = os.path.join(TRADE_DIR, f"log_{day}.json")
        self.data = {"sells": [], "buys": [], "buys_done": False}
        if os.path.exists(self.path):
            with open(self.path, encoding="utf-8") as f:
                self.data = json.load(f)

    def save(self):
        os.makedirs(TRADE_DIR, exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self.data, f, ensure_ascii=False, indent=1)


def save_holdings(holdings):
    os.makedirs(TRADE_DIR, exist_ok=True)
    pd.DataFrame([{"code": c, "name": h["name"], "shares": h["shares"]} for c, h in holdings.items()],
                 columns=["code", "name", "shares"]).to_csv(HOLDINGS_FILE, index=False, encoding="utf-8-sig")


def predict(cash, retrain):
    args = [sys.executable, os.path.join(ROOT, "model", "daily.py"), "--cash", str(int(cash)),
            "--holdings", HOLDINGS_FILE]
    if retrain:
        args.append("--retrain")
    log("예측 실행: model/daily.py" + (" --retrain" if retrain else ""))
    result = subprocess.run(args, cwd=ROOT, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    if result.returncode != 0:
        raise SystemExit("예측 실패 → 주문하지 않고 종료")


def held(kis, code):
    return kis.balance()["holdings"].get(code, {}).get("shares", 0)


def unfilled(kis, code, before, shares):
    """주문 중 아직 체결 안 된 수량. 모의투자 체결 조회(inquire-daily-ccld)는 당일 내역이 비어 나올 때가 있어
    잔고가 늘어난 만큼을 체결로 본다."""
    return shares - (held(kis, code) - before)


def buy_all(kis, buys, live, daylog, cap=config.MAX_ORDER_KRW):
    """매수 목록을 현재가 +1% 지정가로 산다. 주문가능현금을 종목 수로 나눠 금액을 맞춘다.
    cap: 종목당 최대 금액 (공격형은 None = 전액)"""
    cap = cap or float("inf")
    ordered = {b["code"] for b in daylog.data["buys"]}   # 중간에 멈췄다 다시 실행해도 같은 종목을 또 사지 않게
    buys = buys[~buys["code"].isin(ordered)]
    if ordered:
        log(f"이미 매수 주문한 종목 {len(ordered)}개 건너뜀 → 남은 매수 {len(buys)}건")
    if buys.empty:
        return
    cash = kis.orderable_cash() if live else None
    for _, o in buys.iterrows():
        code, name = o["code"], o["name"]
        planned = o["amount"]
        if live:
            budget = min(planned, cash * CASH_USE / len(buys), cap)
            before = held(kis, code)
        else:
            budget = min(planned, cap)
        remaining = None
        for rnd in range(BUY_ROUNDS):
            price = kis.price(code)
            limit = round_up_tick(price * (1 + BUY_PREMIUM))
            shares = math.floor(budget / limit) if remaining is None else remaining
            if shares <= 0:
                log(f"  {name}: 살 수량 0주 (예산 {budget:,.0f}원, 지정가 {limit:,}원) → 건너뜀")
                break
            if not live:
                log(f"  [DRY] 매수 {name}({code}) {shares}주 지정가 {limit:,}원 (현재가 {price:,.0f}원)")
                break
            order_no, org_no = kis.order("buy", code, shares, limit)
            daylog.data["buys"].append({"code": code, "name": name, "shares": shares, "limit": limit,
                                        "order_no": order_no, "time": f"{now():%H:%M:%S}"})
            daylog.save()
            log(f"  매수 {name}({code}) {shares}주 지정가 {limit:,}원 → 주문번호 {order_no}")
            time.sleep(ROUND_WAIT_SEC if rnd < BUY_ROUNDS - 1 else 5)
            entry = daylog.data["buys"][-1]
            left = unfilled(kis, code, before, shares)
            if left <= 0:
                entry.update(filled=shares, checked_at=f"{now():%H:%M:%S}")
                daylog.save()
                log(f"  {name} 체결 완료")
                break
            try:
                kis.cancel(order_no, org_no)
            except KisError as e:
                if "40330000" not in str(e):     # 취소할 수량 없음 = 그 사이 다 체결됨
                    raise
                entry.update(filled=shares, checked_at=f"{now():%H:%M:%S}")
                daylog.save()
                log(f"  {name} 체결 완료 (취소 직전 체결)")
                break
            left = unfilled(kis, code, before, shares)   # 취소 사이에 더 체결됐을 수 있어 다시 센다
            entry.update(filled=shares - left, canceled=left, checked_at=f"{now():%H:%M:%S}")
            daylog.save()
            log(f"  {name} {left}주 미체결 → 취소" + (" 후 다시 주문" if rnd < BUY_ROUNDS - 1 else " (포기)"))
            before = held(kis, code)
            remaining = left


def morning(args):
    if args.test and args.live:
        raise SystemExit("--test 는 주문하지 않는 시험용이라 --live 와 같이 쓸 수 없어요")
    live = False if args.test else args.live or not config.DRY_RUN
    # 실제 주문은 GitHub Actions 에서만 (내 PC 에서도 돌리면 같은 날 주문이 두 번 나감)
    if live and os.environ.get("GITHUB_ACTIONS") != "true" and not args.allow_local:
        raise SystemExit("실제 주문은 GitHub Actions 에서만 해요. 이 PC 에서 꼭 주문해야 하면 --allow-local 을 붙이세요 "
                         "(그날 Actions 아침 실행이 실패·취소된 경우에만)")
    today = now()
    if args.day:   # 시험용: 다른 날짜의 주문 목록으로 DRY RUN
        if live:
            raise SystemExit("--day 는 DRY RUN 에서만 쓸 수 있어요")
        today = datetime.strptime(args.day, "%Y%m%d").replace(tzinfo=KST)
        args.skip_predict = True
    tag = today.strftime("%Y%m%d")
    if today.weekday() >= 5:
        return log("주말 → 종료")
    daylog = DayLog(tag)
    if args.test:   # 오늘 기록은 무시하고 처음부터 (DRY RUN 이라 이 기록은 저장되지 않음)
        daylog.data = {"sells": [], "buys": [], "buys_done": False}
    if daylog.data["buys_done"]:
        return log(f"오늘({tag}) 이미 주문을 마쳤어요 → 종료 ({daylog.path})")
    log(f"{'실전 주문' if live else 'DRY RUN (주문 안 함)'}{' [시험]' if args.test else ''} | {tag}")

    kis = Kis()
    bal = kis.balance()
    save_holdings(bal["holdings"])
    if "start_holdings" not in daylog.data and not args.test:   # 장 마감 후 체결 추정용 (다시 실행해도 처음 잔고 유지)
        daylog.data["start_holdings"] = {c: {k: h[k] for k in ("name", "shares", "avg_price")}
                                         for c, h in bal["holdings"].items()}
        daylog.save()
    log(f"총평가 {bal['total']:,.0f}원 | 현금 {bal['cash']:,.0f}원 | 보유 "
        + (", ".join(f"{h['name']} {h['shares']}주" for h in bal["holdings"].values()) or "없음"))

    orders_file = os.path.join(PRED_DIR, f"orders_{tag}.csv")
    if args.test and not args.skip_predict:
        # 재학습은 하지 않는다 (실전 모델을 낮에 바꾸지 않게)
        predict(bal["cash"], retrain=False)
        # 장 마감 후에 돌리면 오늘 종가까지 들어가 예측일이 다음 거래일이 된다 → 방금 만든 목록을 쓴다
        made = sorted(f for f in os.listdir(PRED_DIR) if f.startswith("orders_"))
        orders_file = os.path.join(PRED_DIR, made[-1])
        log(f"시험 주문 목록: {made[-1]}")
    elif not args.skip_predict:
        early = now().strftime("%H:%M") < "08:30"
        if early or not os.path.exists(orders_file):
            # 늦게 시작했으면 재학습은 건너뛴다 (시간이 걸려 주문이 더 늦어짐)
            predict(bal["cash"], retrain=early and today.weekday() == 0)
    if not os.path.exists(orders_file):
        raise SystemExit(f"{orders_file} 이 없어요. 장 마감 후에는 다음 거래일 목록이 만들어져요.")
    mode = aggressive.load_mode()
    if mode == "aggressive":
        sells, buys = aggressive_orders(bal, os.path.join(PRED_DIR, f"rank_{tag}.csv"))
    else:
        orders = pd.read_csv(orders_file, dtype={"code": str})
        sells, buys = orders[orders["action"] == "sell"], orders[orders["action"] == "buy"]
        state = aggressive.load_state()
        if state.get("position") and live:   # 공격형 → 안정형: 공격형 보유 기록을 지운다 (다시 공격형이 되면 1위부터)
            state["position"] = None
            aggressive.save_state(state)
    log(f"[{'공격형' if mode == 'aggressive' else '안정형'}] 주문 목록: 매도 {len(sells)}건, 매수 {len(buys)}건")

    # 매도: 동시호가 시장가
    if len(sells):
        if live:
            wait_until(AUCTION_START)
        sent = {s["code"] for s in daylog.data["sells"]}
        for _, o in sells.iterrows():
            held = bal["holdings"].get(o["code"], {}).get("shares", 0)
            shares = min(int(o["shares"]), held)
            if o["code"] in sent or shares <= 0:
                continue
            if not live:
                log(f"  [DRY] 매도 {o['name']}({o['code']}) {shares}주 시장가")
                continue
            order_no, _ = kis.order("sell", o["code"], shares)
            daylog.data["sells"].append({"code": o["code"], "name": o["name"], "shares": shares,
                                         "order_no": order_no, "time": f"{now():%H:%M:%S}"})
            daylog.save()
            log(f"  매도 {o['name']}({o['code']}) {shares}주 시장가 → 주문번호 {order_no}")

    # 매수: 시가 체결 직후 지정가
    if len(buys):
        if live:
            wait_until(BUY_START)
        buy_all(kis, buys, live, daylog, cap=None if mode == "aggressive" else config.MAX_ORDER_KRW)
        if mode == "aggressive" and live:
            start_aggressive(kis, buys.iloc[0], today)
    if live:
        daylog.data["buys_done"] = True
        daylog.save()
    log("아침 주문 끝")
    if live:   # 대시보드 계좌 현황에 주문 시각이 보이게
        subprocess.run([sys.executable, os.path.join(ROOT, "dashboard", "export.py")], cwd=ROOT,
                       env={**os.environ, "PYTHONIOENCODING": "utf-8"})


def aggressive_orders(bal, rank_file):
    """공격형 아침 주문. 공격형 종목을 들고 있으면 그대로 두고(다른 종목만 판다),
    없으면(손절·익절했거나 막 공격형으로 바꿈) 전부 팔고 AI 1위를 전액 산다."""
    state = aggressive.load_state()
    pos = aggressive.held_position(state, bal["holdings"])
    if pos:
        target = pos["code"]
        buys = pd.DataFrame(columns=["code", "name", "amount"])
        log(f"공격형: {pos['name']} 보유 유지 (손절선 {aggressive.stop_price(pos)[0]:,}원)")
    else:
        if not os.path.exists(rank_file):
            raise SystemExit(f"{rank_file} 이 없어 공격형 매수 종목(AI 1위)을 못 골라요")
        rank = pd.read_csv(rank_file, dtype={"code": str}).sort_values("rank")
        top = rank[rank["buyable"]].iloc[0]
        target = top["code"]
        buys = pd.DataFrame([{"code": target, "name": top["name"], "amount": bal["total"]}])
        log(f"공격형: 보유 없음 → AI {int(top['rank'])}위 {top['name']} 전액 매수")
    sells = pd.DataFrame([{"code": c, "name": h["name"], "shares": h["shares"]}
                          for c, h in bal["holdings"].items() if c != target],
                         columns=["code", "name", "shares"])
    return sells, buys


def start_aggressive(kis, buy, today):
    """공격형 매수가 체결되면 보유 기록을 새로 쓴다 (매수가 = 평균 단가, 고점 = 매수가)."""
    h = kis.balance()["holdings"].get(buy["code"])
    if not h:
        return log(f"공격형: {buy['name']} 이 체결되지 않아 보유 기록을 쓰지 않아요")
    state = aggressive.load_state()
    state["position"] = {"code": buy["code"], "name": h["name"], "shares": h["shares"], "entry": h["avg_price"],
                         "entry_date": today.strftime("%Y-%m-%d"), "peak": h["avg_price"]}
    aggressive.save_state(state)
    log(f"공격형 시작: {h['name']} {h['shares']}주 @ {h['avg_price']:,.0f} → 손절선 {state['stop']:,}원")


def fills_by_code(kis, daylog, bal, tag):
    """모의투자 체결 조회는 주문별 목록이 비어 나온다 → 오늘 주문한 종목마다 체결 합계를 조회한다."""
    names = {o["code"]: o["name"] for o in daylog.data["buys"] + daylog.data["sells"]}
    out = []
    for side, key in (("sell", "sells"), ("buy", "buys")):
        for code in sorted({o["code"] for o in daylog.data[key]}):
            qty, price = kis.fill_summary(code, side, tag)
            if qty:
                out.append({"code": code, "name": names[code], "side": side, "shares": qty,
                            "price": round(price), "order_no": ""})
    if out or not (daylog.data["buys"] or daylog.data["sells"]):
        return out
    return fills_from_balance(kis, daylog, bal)


def fills_from_balance(kis, daylog, bal):
    """체결 합계도 못 받을 때: 아침 시작 잔고와 지금 잔고의 차이로 체결을 추정한다.
    매수 단가는 평균 단가 변화로 계산, 매도 단가는 알 수 없어 지금 가격으로 적는다."""
    start = daylog.data.get("start_holdings")
    if start is None:
        log("체결 조회가 비었고 아침 시작 잔고 기록도 없어 거래 내역을 남기지 못해요")
        return []
    out = []
    for code in sorted(set(start) | set(bal["holdings"])):
        s = start.get(code, {"shares": 0, "avg_price": 0})
        n = bal["holdings"].get(code, {"shares": 0, "avg_price": 0, "price": 0})
        diff = n["shares"] - s["shares"]
        if diff > 0:
            price = (n["avg_price"] * n["shares"] - s["avg_price"] * s["shares"]) / diff
            out.append({"code": code, "name": n["name"], "side": "buy", "shares": diff, "price": round(price),
                        "order_no": ""})
        elif diff < 0:
            out.append({"code": code, "name": s["name"], "side": "sell", "shares": -diff,
                        "price": n["price"] or kis.price(code), "order_no": ""})
    log(f"체결 조회가 비어 잔고 변화로 추정 ({len(out)}건)")
    return out


def close(args):
    tag = now().strftime("%Y%m%d")
    day = now().strftime("%Y-%m-%d")
    kis = Kis()
    fills = kis.fills(tag)
    bal = kis.balance()
    if not fills:
        fills = fills_by_code(kis, DayLog(tag), bal, tag)
    save_holdings(bal["holdings"])
    os.makedirs(TRADE_DIR, exist_ok=True)
    state = aggressive.load_state()
    if state.get("position"):   # 공격형 고점·손절선 갱신 (손으로 팔았으면 기록을 지움)
        pos = aggressive.held_position(state, bal["holdings"])
        if pos:
            aggressive.update_peak(pos, kis.quote(pos["code"]), day)
        else:
            state["position"] = None
        aggressive.save_state(state)
        log(f"공격형: {pos['name']} 고점 {pos['peak']:,.0f} → 손절선 {state['stop']:,}원 ({state['stop_reason']})"
            if pos else "공격형: 보유 기록 종목이 잔고에 없어 기록을 지움")

    tfile = os.path.join(TRADE_DIR, "trades.csv")
    trades = pd.read_csv(tfile, dtype={"code": str}) if os.path.exists(tfile) else pd.DataFrame(
        columns=["date", "code", "name", "side", "shares", "price"])
    trades = trades[trades["date"] != day]   # 같은 날 다시 실행하면 덮어씀
    new = pd.DataFrame(fills, columns=["code", "name", "side", "shares", "price", "order_no"])
    new.insert(0, "date", day)
    trades = pd.concat([d for d in (trades, new.drop(columns="order_no")) if len(d)], ignore_index=True)         if len(trades) or len(new) else trades
    trades.to_csv(tfile, index=False, encoding="utf-8-sig")

    efile = os.path.join(TRADE_DIR, "equity.csv")
    eq = pd.read_csv(efile) if os.path.exists(efile) else pd.DataFrame(columns=["date", "equity"])
    eq = eq[eq["date"] != day]
    row = pd.DataFrame([{"date": day, "equity": bal["total"]}])
    eq = pd.concat([eq, row], ignore_index=True) if len(eq) else row
    eq.to_csv(efile, index=False, encoding="utf-8-sig")

    log(f"체결 {len(fills)}건 → {tfile}")
    for f in fills:
        log(f"  {f['side']} {f['name']} {f['shares']}주 @ {f['price']:,.0f}")
    log(f"총평가 {bal['total']:,.0f}원 (시작 1억 대비 {(bal['total'] / 1e8 - 1) * 100:+.2f}%) → {efile}")
    subprocess.run([sys.executable, os.path.join(ROOT, "dashboard", "export.py")], cwd=ROOT,
                   env={**os.environ, "PYTHONIOENCODING": "utf-8"})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="실제 주문 (없으면 config.DRY_RUN 을 따름)")
    parser.add_argument("--close", action="store_true", help="장 마감 후 기록")
    parser.add_argument("--skip-predict", action="store_true", help="이미 만든 orders_{오늘}.csv 로 주문만")
    parser.add_argument("--day", help="시험용 YYYYMMDD: 그날 주문 목록으로 DRY RUN")
    parser.add_argument("--allow-local", action="store_true", help="GitHub Actions 밖(내 PC)에서도 실제 주문 허용")
    parser.add_argument("--test", action="store_true",
                        help="시험: 주문 없이 시각·오늘 기록과 상관없이 예측부터 다시 실행")
    args = parser.parse_args()
    try:
        close(args) if args.close else morning(args)
    except KisError as e:
        raise SystemExit(f"한투 API 오류: {e}")


if __name__ == "__main__":
    main()
