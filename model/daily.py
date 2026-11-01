"""매일 아침 데이터 갱신 → 피처 → 예측을 순서대로 실행

실행 시각: 장 시작 전(07:00 ~ 08:20 권장, 미국 장 마감 후). 장중(08:30 ~ 15:40)에는 실행을 막는다.
          장중에 받으면 오늘의 미완성 시세가 저장되고, 주가 수집은 이어 받기라 고쳐지지 않음.
순서
1. collect/price.py        종목·지수 주가 (어제 종가까지)
2. collect/market.py       시장 지표 (+ 오늘 예측용 빈 행)
3. collect/market_news.py  시장 뉴스 (어제까지)
4. features/market_fear.py → features/market.py → features/chart.py
5. (--retrain) model/train.py --final   실전 모델 다시 학습 (주 1회 정도면 충분)
6. model/predict.py        순위·주문 목록 → data/predictions/
7. dashboard/export.py     대시보드 JSON → dashboard/public/data/ (커밋·푸시하면 Vercel 이 다시 배포)

실행: python model/daily.py [--retrain] [--force] [--cash 금액] [--holdings 파일]
      (프로젝트 루트에서. --force: 시각 확인 생략)
"""

import argparse
import os
import subprocess
import sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARKET_HOURS = ("08:30", "15:40")

STEPS = [
    ["collect/price.py"],
    ["collect/market.py"],
    ["collect/market_news.py"],
    ["features/market_fear.py"],
    ["features/market.py"],
    ["features/chart.py"],
]


def run(args):
    print(f"\n>>> python {' '.join(args)}", flush=True)
    env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
    result = subprocess.run([sys.executable, *args], cwd=ROOT, env=env)
    if result.returncode != 0:
        raise SystemExit(f"실패: {args[0]} (종료 코드 {result.returncode}) → 중단")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--retrain", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--cash")
    parser.add_argument("--holdings")
    args = parser.parse_args()

    now = datetime.now().strftime("%H:%M")
    if not args.force and MARKET_HOURS[0] <= now <= MARKET_HOURS[1]:
        raise SystemExit(f"지금 {now}는 장중입니다. 미완성 시세가 저장되므로 "
                         f"{MARKET_HOURS[1]} 이후나 다음 날 {MARKET_HOURS[0]} 전에 실행하세요.")

    for step in STEPS:
        run(step)
    if args.retrain:
        run(["model/train.py", "--final"])
    predict = ["model/predict.py"]
    if args.cash:
        predict += ["--cash", args.cash]
    if args.holdings:
        predict += ["--holdings", args.holdings]
    run(predict)
    run(["dashboard/export.py"])


if __name__ == "__main__":
    main()
