"""장중 손절 감시 (python -m trade.monitor [--live])   09:00 ~ 15:20, 안정형·공격형 공통

GitHub Actions(monitor.yml)가 장 시작 무렵 한 번 실행하면 15:20 까지 1분마다 보유 종목(data/strategy/positions.json) 각각
- 현재가가 손절선 이하면 그 종목만 전량 시장가 매도 → 보유 기록에서 빼고 정리 기록(exits)에 남김
  (빈 자리는 다음 날 아침에 채움). 나머지 종목은 계속 감시
- 손절선은 장 마감 기록(trade/run_daily.py --close)이 종가로만 올린다 (장중에는 바꾸지 않음, 백테스트와 같음)
- 5분마다 원격 저장소의 보유 기록을 다시 읽어, 아침에 새로 산 종목도 감시에 넣는다
- 보유가 하나도 없으면 09:30 까지 아침 매수 기록을 기다렸다가 그래도 없으면 끝낸다 (Actions 시간 절약)
끝날 때 보유 기록을 저장 (Actions 가 커밋 → 대시보드에 보임)

안전장치: 실제 주문은 --live 이고 GitHub Actions 에서만 (PC 에서는 --allow-local)
"""

import argparse
import os
import time

from trade import strategy
from trade.kis_api import Kis, KisError, real_orders_allowed
from trade.run_daily import DayLog, log, now, wait_until

OPEN = (9, 0, 5)
END = "15:20"            # 15:20 부터는 종가 동시호가 → 장 마감 기록이 이어받음
CHECK_SEC = 60
REFRESH_EVERY = 5        # 몇 번 확인마다 원격 보유 기록을 다시 읽을지
EMPTY_GIVE_UP = "09:30"  # 보유가 없으면 아침 매수 기록을 이 시각까지 기다리고, 그래도 없으면 끝냄 (현금인 날)
FILL_WAIT_SEC = 60       # 손절 매도 뒤 체결가를 확인하려고 기다리는 시간 (다른 종목 감시가 멈추지 않게 짧게)


def sell_position(kis, state, pos, price, live):
    """손절 매도. 실제 주문이면 state 에서 빼고 정리 기록을 남겨 바로 저장한다. 판 종목 코드를 돌려준다."""
    why = f"손절선 {pos['stop']:,} 이하 ({pos['stop_reason']})"
    if not live:
        log(f"[DRY] {pos['name']} {pos['shares']}주 시장가 매도 - {why}, 현재가 {price:,.0f}")
        return pos["code"]
    shares = kis.balance()["holdings"].get(pos["code"], {}).get("shares", 0)
    if shares <= 0:   # 아침 동시호가에 이미 팔렸거나 손으로 판 경우
        log(f"{pos['name']}: 잔고에 없어 감시에서 뺌")
        state["positions"] = [p for p in state["positions"] if p["code"] != pos["code"]]
        return pos["code"]
    day = now().strftime("%Y%m%d")
    daylog = DayLog(day)
    for attempt in range(5):   # 재시도까지 실패해도 몇 번 더 (손절 주문이 가장 중요)
        try:
            order_no, _ = kis.order("sell", pos["code"], shares)
            break
        except KisError as e:
            log(f"매도 주문 실패 ({attempt + 1}/5): {e}")
            time.sleep(5)
    else:
        log(f"{pos['name']} 손절 매도 주문을 끝내 못 냈어요 → 다음 확인 때 다시 시도 (직접 확인 필요)")
        return None
    daylog.data["sells"].append({"code": pos["code"], "name": pos["name"], "shares": shares,
                                 "order_no": order_no, "time": f"{now():%H:%M:%S}", "note": why})
    daylog.save()
    log(f"매도 {pos['name']} {shares}주 시장가 → 주문번호 {order_no} ({why}, 현재가 {price:,.0f})")
    time.sleep(FILL_WAIT_SEC)
    try:
        qty, avg = kis.fill_summary(pos["code"], "sell", day)
    except KisError:
        qty, avg = 0, 0
    strategy.record_exit(state, pos, avg or price, why, shares=qty or shares, estimated=not avg)
    strategy.save_state(state)
    log(f"정리: {pos['name']} {qty or shares}주 {'평균' if avg else '약'} {avg or price:,.0f}원 "
        f"(매수가 {pos['entry']:,.0f}) → 빈 자리는 다음 날 아침에 채움")
    return pos["code"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--live", action="store_true", help="실제 주문 (없으면 출력만)")
    parser.add_argument("--allow-local", action="store_true", help="GitHub Actions 밖(내 PC)에서도 실제 주문 허용")
    args = parser.parse_args()
    on_actions = os.environ.get("GITHUB_ACTIONS") == "true"
    if args.live and not on_actions and not args.allow_local:
        raise SystemExit("실제 주문은 GitHub Actions 에서만 해요. 이 PC 에서 꼭 감시해야 하면 --allow-local 을 붙이세요")
    if now().weekday() >= 5 or now().strftime("%H:%M") >= END:
        return log("장 시간이 아니라 종료")

    kis = Kis()
    if args.live and kis.is_real and not real_orders_allowed():
        raise SystemExit("실전 서버인데 KIS_REAL_ORDER=yes 가 없어 감시(손절 주문)를 하지 않아요")
    state = strategy.load_state(remote=on_actions)
    log(f"[{kis.server_name}] {'실제 주문' if args.live else 'DRY RUN'} 감시 시작: "
        + (", ".join(f"{p['name']} {p['shares']}주 (손절선 {p['stop']:,})" for p in state["positions"])
           or "보유 기록 없음 (아침 매수를 기다림)"))
    wait_until(OPEN)

    done = set()              # 오늘 판(또는 DRY 에서 판 것으로 친) 종목
    checks = 0
    while now().strftime("%H:%M") < END:
        if checks % REFRESH_EVERY == 0 and on_actions and checks:
            fresh = strategy.load_state(remote=True)
            new = {p["code"] for p in fresh["positions"]} - {p["code"] for p in state["positions"]} - done
            if new:
                log("새 보유 기록 감시 시작: " + ", ".join(p["name"] for p in fresh["positions"] if p["code"] in new))
            fresh["positions"] = [p for p in fresh["positions"] if p["code"] not in done]
            fresh["exits"] = state.get("exits", fresh["exits"])
            state = fresh
        watching = [p for p in state["positions"] if p["code"] not in done]
        if not watching and now().strftime("%H:%M") >= EMPTY_GIVE_UP:
            log("감시할 보유 종목이 없어 끝내요")
            break
        for pos in watching:
            try:
                q = kis.quote(pos["code"])
            except KisError as e:
                log(f"{pos['name']} 현재가 조회 실패, 다음 확인 때 다시: {e}")
                continue
            if checks % 10 == 0:
                log(f"{pos['name']} {q['price']:,.0f}원 (손절선 {pos['stop']:,}, {pos['stop_reason']})")
            if q["price"] <= pos["stop"]:
                sold = sell_position(kis, state, pos, q["price"], args.live)
                if sold:
                    done.add(sold)
        checks += 1
        time.sleep(CHECK_SEC)
    if args.live:
        strategy.save_state(state)
    log("감시 끝: " + (", ".join(f"{p['name']} 손절선 {p['stop']:,}원" for p in state["positions"]) or "보유 없음"))


if __name__ == "__main__":
    main()
