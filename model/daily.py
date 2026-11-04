"""매일 아침 데이터 갱신 → 피처 → 예측을 순서대로 실행

실행 시각: 장 시작 전(06:40 ~ 08:20 권장, 미국 장 마감 후). 아무 때나 돌려도 되지만
          주가·시장 지표는 종가가 확정된 날(한국 15:40 전이면 어제)까지, 시장 뉴스는 어제까지만 받는다.
순서
1. collect/price.py        종목·지수 주가 (어제 종가까지)
2. collect/market.py       시장 지표 (+ 오늘 예측용 빈 행)
3. collect/market_news.py  시장 뉴스 (어제까지)
4. features/market_fear.py → features/market.py → features/chart.py
5. (--retrain) model/train.py --final   실전 모델 다시 학습 (주 1회 정도면 충분)
6. model/predict.py        순위·주문 목록 → data/predictions/
7. dashboard/export.py     대시보드 JSON → dashboard/public/data/ (커밋·푸시하면 Vercel 이 다시 배포)

실행: python model/daily.py [--retrain] [--cash 금액] [--holdings 파일]   (프로젝트 루트에서)
"""

import argparse
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLOSE_DONE = "15:40"   # 이 시각 전에는 오늘 시세가 미완성 (collect/price.py 와 같은 기준)
KST = timezone(timedelta(hours=9))   # GitHub Actions 서버는 UTC 라 한국 시간으로 비교

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
    parser.add_argument("--cash")
    parser.add_argument("--holdings")
    args = parser.parse_args()

    # 시장 지표는 주가(collect/price.py)처럼 종가가 확정된 날까지, 시장 뉴스는 한국 날짜로 어제까지
    # (뉴스 수집의 기본값은 서버 날짜 기준이라 UTC 인 Actions 아침에는 그제까지만 받게 됨)
    t = datetime.now(KST)
    end = t.date() if t.strftime("%H:%M") >= CLOSE_DONE else t.date() - timedelta(days=1)
    ends = {"collect/market.py": end, "collect/market_news.py": t.date() - timedelta(days=1)}
    for step in STEPS:
        run(step + ["--end", ends[step[0]].isoformat()] if step[0] in ends else step)
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
