"""공격형 장중 감시 (python -m trade.monitor [--live])   09:00 ~ 15:20

GitHub Actions(monitor.yml)가 장 시작 무렵 한 번 실행하면 15:20 까지 1분마다
- 현재가·오늘 고가로 고점을 갱신하고 손절선을 다시 계산 (trade/aggressive.py)
- 현재가가 손절선 이하면 전량 시장가 매도 → 공격형 보유 기록을 비움 (다음 날 아침 AI 1위 매수)
- 5분마다 원격 저장소의 투자 성향을 다시 읽어, 대시보드에서 안정형으로 바꾸면 감시를 멈춤
끝날 때 고점·손절선을 data/strategy/aggressive.json 에 저장 (Actions 가 커밋 → 대시보드에 보임)

안전장치: 실제 주문은 --live 이고 GitHub Actions 에서만 (PC 에서는 --allow-local)
"""

import argparse
import os
import time

from trade import aggressive
from trade.kis_api import Kis, KisError
from trade.run_daily import DayLog, log, now, wait_until

OPEN = (9, 0, 5)
END = "15:20"            # 15:20 부터는 종가 동시호가 → 장 마감 기록이 이어받음
CHECK_SEC = 60
MODE_CHECK_EVERY = 5     # 몇 번 확인마다 원격 투자 성향을 다시 읽을지
FILL_WAIT_SEC = 600      # 손절 매도 체결을 기다리는 최대 시간


def sell_all(kis, pos, price, why, live):
    if not live:
        return log(f"[DRY] {pos['name']} {pos['shares']}주 시장가 매도 ({why})")
    day = now().strftime("%Y%m%d")
    daylog = DayLog(day)
    order_no, _ = kis.order("sell", pos["code"], pos["shares"])
    daylog.data["sells"].append({"code": pos["code"], "name": pos["name"], "shares": pos["shares"],
                                 "order_no": order_no, "time": f"{now():%H:%M:%S}", "note": f"공격형 {why}"})
    daylog.save()
    log(f"매도 {pos['name']} {pos['shares']}주 시장가 → 주문번호 {order_no} ({why}, 현재가 {price:,.0f})")
    deadline = time.time() + FILL_WAIT_SEC
    while time.time() < deadline:
        time.sleep(15)
        left = kis.balance()["holdings"].get(pos["code"], {}).get("shares", 0)
        if not left:
            break
        log(f"  남은 {left}주 체결 대기")
    else:
        log("  10분 안에 다 체결되지 않았어요 (나머지는 주문이 살아 있으면 계속 체결됨)")
    qty, avg = kis.fill_summary(pos["code"], "sell", day)
    state = aggressive.load_state()
    state["position"] = None
    state["last_exit"] = {"date": now().strftime("%Y-%m-%d"), "time": f"{now():%H:%M}", "code": pos["code"],
                          "name": pos["name"], "shares": qty, "price": round(avg), "entry": pos["entry"],
                          "reason": why}
    aggressive.save_state(state)
    log(f"공격형 정리: {pos['name']} {qty}주 평균 {avg:,.0f}원 (매수가 {pos['entry']:,.0f}) → 다음 날 아침 AI 1위 매수")


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
    if aggressive.load_mode(remote=on_actions) != "aggressive":
        return log("안정형이라 감시하지 않아요")
    state = aggressive.load_state()
    if not state.get("position"):
        return log("공격형 보유 종목이 없어요 (다음 날 아침 매수)")

    kis = Kis()
    pos = aggressive.held_position(state, kis.balance()["holdings"])
    if not pos:
        state["position"] = None
        aggressive.save_state(state)
        return log("공격형 기록 종목이 잔고에 없어 기록을 지우고 종료")
    log(f"{'실전' if args.live else 'DRY RUN'} 감시 시작: {pos['name']} {pos['shares']}주, 매수가 {pos['entry']:,.0f}, "
        f"고점 {pos['peak']:,.0f}, 손절선 {aggressive.stop_price(pos)[0]:,}원")
    wait_until(OPEN)

    today = now().strftime("%Y-%m-%d")
    checks = 0
    while now().strftime("%H:%M") < END:
        if checks and checks % MODE_CHECK_EVERY == 0 and aggressive.load_mode(remote=on_actions) != "aggressive":
            log("안정형으로 바뀌어 감시를 멈춰요 (다음 날 아침부터 안정형 매매)")
            break
        try:
            q = kis.quote(pos["code"])
        except KisError as e:
            log(f"현재가 조회 실패, 다음 확인 때 다시: {e}")
            time.sleep(CHECK_SEC)
            continue
        aggressive.update_peak(pos, q, today)
        stop, why = aggressive.stop_price(pos)
        if checks % 10 == 0:
            log(f"{pos['name']} {q['price']:,.0f}원 (고점 {pos['peak']:,.0f}, 손절선 {stop:,} {why})")
        if q["price"] <= stop:
            sell_all(kis, pos, q["price"], why, args.live)
            return
        checks += 1
        time.sleep(CHECK_SEC)
    state["position"] = pos
    aggressive.save_state(state)
    log(f"감시 끝: 고점 {pos['peak']:,.0f} → 손절선 {state['stop']:,}원")


if __name__ == "__main__":
    main()
