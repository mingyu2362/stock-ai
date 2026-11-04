"""투자 성향 (안정형 / 공격형)

data/strategy/mode.json        {"mode": "stable" | "aggressive", "changed_at", "by"}
    대시보드 계좌 현황 버튼(dashboard/api/mode.js)만 쓴다. 매매 프로그램은 읽기만 한다
data/strategy/aggressive.json  공격형 보유 상태 (매매 프로그램만 쓴다)
    {"position": {code, name, shares, entry, entry_date, peak} | null,
     "stop", "stop_reason", "rules", "last_exit", "updated_at"}
    두 파일을 나눈 이유: Actions 실행이 커밋할 때 충돌을 자기 쪽으로 풀어서(-X theirs)
    같은 파일이면 실행 중에 누른 버튼이 덮어써질 수 있다

공격형 규칙 (config.AGGR_*)
- 1종목에 전액. 순위와 상관없이 손절선 아래로 내려가면 판다 (장중 감시: trade/monitor.py)
- 손절선: 고점이 매수가 +10% 에 닿기 전에는 매수가 -12%, 닿은 뒤에는 고점 -8% (추적 익절, 본전 위)
- 판 다음 날 아침 AI 1위를 산다 (trade/run_daily.py)
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import config  # noqa: E402

KST = timezone(timedelta(hours=9))
STRATEGY_DIR = os.path.join(ROOT, "data", "strategy")
MODE_FILE = os.path.join(STRATEGY_DIR, "mode.json")
STATE_FILE = os.path.join(STRATEGY_DIR, "aggressive.json")
MODES = ("stable", "aggressive")


def _read(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def load_mode(remote=False):
    """지금 투자 성향. remote=True 면 원격 저장소의 최신 값 (Actions 장중 감시가 실행 중 버튼 변경을 알아채게)."""
    if remote:
        r = subprocess.run("git fetch -q origin main && git show origin/main:data/strategy/mode.json",
                           shell=True, cwd=ROOT, capture_output=True, text=True, encoding="utf-8")
        if r.returncode == 0:
            mode = json.loads(r.stdout).get("mode")
            return mode if mode in MODES else "stable"
    mode = _read(MODE_FILE, {}).get("mode")
    return mode if mode in MODES else "stable"


def load_state():
    return _read(STATE_FILE, {"position": None})


def stop_price(pos):
    """(손절선, 이유)."""
    if pos["peak"] >= pos["entry"] * (1 + config.AGGR_BREAKEVEN_AT):
        return round(pos["peak"] * (1 - config.AGGR_TRAIL)), f"추적 익절 (고점 {pos['peak']:,.0f} -{config.AGGR_TRAIL:.0%})"
    return round(pos["entry"] * (1 - config.AGGR_STOP_LOSS)), f"손절 (매수가 -{config.AGGR_STOP_LOSS:.0%})"


def update_peak(pos, quote, today):
    """고점 갱신. 매수한 날은 매수 전 고가가 섞여 있어 오늘 고가 대신 현재가로 센다."""
    high = quote["price"] if pos["entry_date"] == today else quote["high"]
    pos["peak"] = max(pos["peak"], high, quote["price"])


def save_state(state):
    pos = state.get("position")
    state["rules"] = {"stop_loss": config.AGGR_STOP_LOSS, "breakeven_at": config.AGGR_BREAKEVEN_AT,
                      "trail": config.AGGR_TRAIL}
    if pos:
        state["stop"], state["stop_reason"] = stop_price(pos)
        state["trail_from"] = round(pos["entry"] * (1 + config.AGGR_BREAKEVEN_AT))
    else:
        state["stop"] = state["stop_reason"] = state["trail_from"] = None
    state["updated_at"] = datetime.now(KST).isoformat(timespec="seconds")
    os.makedirs(STRATEGY_DIR, exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)


def held_position(state, holdings):
    """기록된 공격형 종목을 지금도 들고 있으면 그 기록, 아니면 None (손으로 판 경우 등)."""
    pos = state.get("position")
    if pos and holdings.get(pos["code"], {}).get("shares", 0) > 0:
        pos["shares"] = holdings[pos["code"]]["shares"]
        return pos
    return None
