"""모델 학습 (A~D 비교 + 실전 모델)

- A: 차트 / B: 뉴스 / C: 차트+뉴스 / D: 차트+뉴스+공시  (시장 피처는 모든 모델 공통)
- 같은 피처 표에서 사용하는 열만 바꿔 학습 (config.FEATURE_GROUPS)
- B는 피처가 그날 모든 종목에 같은 값이라 종목 순위를 매길 수 없음 (비교용으로만 남김)

정답 (순위 전략용)
- T일 행: T일 시가에 사서 그 종목의 다음 거래일 시가에 판 수익률
- 그날 전체 종목 평균을 뺀 초과 수익률의 그날 안 순위(0~1)를 회귀로 맞힌다
  (시장 방향은 맞히지 않고 종목 간 우열만. 0/1 분류, 상위 20% 분류, 5일 수익률보다
   2025-01 ~ 2026-10 롤링 검증에서 상승장·하락장 모두 꾸준했음)

비교 (기본 실행): 월별 롤링 학습
- 2025-01 부터 매달, 그 달 이전 데이터로만 학습해 그 달을 예측 (모든 예측이 처음 보는 기간)
- 학습 기간 마지막 60거래일로 나무 수를 정한 뒤 전체로 다시 학습, 시작값 3개 평균
- 정답이 예측 달의 시가를 쓰는 행은 학습에서 뺀다 (기간 경계 누수 방지)
- 출력: data/predictions/model_{A..D}.csv  (date, code, score)

실전 (--final): 정답이 있는 모든 데이터로 학습해 data/models/ 에 저장 → model/predict.py 가 사용

실행: python model/train.py [A C]         (프로젝트 루트에서, 기본 A C)
      python model/train.py --final [C]   (기본 config.LIVE_MODEL)
"""

import json
import os
import sys

import pandas as pd
from xgboost import XGBRegressor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import config  # noqa: E402

PROC_DIR = os.path.join(ROOT, "data", "processed")
PRICE_DIR = os.path.join(ROOT, "data", "raw", "price")
PRED_DIR = os.path.join(ROOT, "data", "predictions")
MODEL_DIR = os.path.join(ROOT, "data", "models")
UNIVERSE_FILE = os.path.join(ROOT, "data", "universe.csv")

PARAMS = dict(learning_rate=0.03, max_depth=4, min_child_weight=50, subsample=0.8,
              colsample_bytree=0.8, tree_method="hist", n_jobs=-1)
SEEDS = [0, 1, 2]
ES_DAYS = 60            # 나무 수를 정하는 데 쓰는 학습 기간 마지막 거래일 수
FIRST_MONTH = "2025-01"


def load_labels():
    """(date, code)별 다음 거래일 시가까지 수익률, 초과 수익률, 그날 안 순위."""
    codes = pd.read_csv(UNIVERSE_FILE, dtype={"code": str})["code"]
    parts = []
    for code in codes:
        p = pd.read_csv(os.path.join(PRICE_DIR, f"{code}.csv"), parse_dates=["Date"])
        parts.append(pd.DataFrame({"date": p["Date"], "code": code,
                                   "next_date": p["Date"].shift(-1),
                                   "ret": p["Open"].shift(-1) / p["Open"] - 1}))
    lab = pd.concat(parts).dropna()
    lab["excess"] = lab["ret"] - lab.groupby("date")["ret"].transform("mean")
    lab["y"] = lab.groupby("date")["excess"].rank(pct=True)
    return lab.set_index(["date", "code"])


def load_features():
    """피처 표와 피처 묶음별 열 이름. 정답이 아직 없는 다음 거래일 행도 포함."""
    chart = pd.read_csv(os.path.join(PROC_DIR, "chart_features.csv"),
                        dtype={"code": str}, parse_dates=["date"]).set_index(["date", "code"])
    chart = chart.dropna(how="all")                   # 상장 직후 비워 둔 행
    market = pd.read_csv(os.path.join(PROC_DIR, "market_features.csv"),
                         parse_dates=["date"]).set_index("date")
    groups = {
        "chart": list(chart.columns),
        "news": [c for c in market.columns if c.startswith("news_")],
        "market": [c for c in market.columns if not c.startswith("news_")],
        "disclosure": [],
    }
    return chart.join(market, on="date"), groups


def feature_cols(name, groups):
    if "disclosure" in config.FEATURE_GROUPS[name] and not groups["disclosure"]:
        raise SystemExit(f"모델 {name}: 공시 피처가 아직 없습니다.")
    return [c for g in config.FEATURE_GROUPS[name] for c in groups[g]]


def fit(train, cols, seed):
    """마지막 ES_DAYS 거래일로 나무 수를 정한 뒤 train 전체로 다시 학습."""
    d = train.index.get_level_values("date")
    cut = d.unique().sort_values()[-ES_DAYS]
    early, late = train[(d < cut) & (train["next_date"] < cut)], train[d >= cut]
    m = XGBRegressor(n_estimators=600, early_stopping_rounds=60, random_state=seed, **PARAMS)
    m.fit(early[cols], early["y"], eval_set=[(late[cols], late["y"])], verbose=False)
    n_trees = max(m.best_iteration + 1, 20)
    m = XGBRegressor(n_estimators=n_trees, random_state=seed, **PARAMS)
    m.fit(train[cols], train["y"], verbose=False)
    return m


def report(pred):
    """연도별 일평균 순위상관(IC)과 상위 3·5종목의 다음 날 초과 수익."""
    for year, g in pred.groupby(pred["date"].dt.year):
        ic = g.groupby("date").apply(lambda x: x["score"].corr(x["excess"], method="spearman"))
        top = {n: g.groupby("date", group_keys=False).apply(lambda x: x.nlargest(n, "score"))
               ["excess"].mean() * 100 for n in [3, 5]}
        print(f"  {year}: IC {ic.mean():+.3f} | 상위 3종목 초과수익 {top[3]:+.3f}%/일, "
              f"상위 5종목 {top[5]:+.3f}%/일")


def rolling(name, df, groups):
    cols = feature_cols(name, groups)
    print(f"\n모델 {name}: 피처 {len(cols)}개 ({' + '.join(config.FEATURE_GROUPS[name])})")
    d = df.index.get_level_values("date")
    labeled = df.dropna(subset=["y"])
    preds = []
    for month in pd.period_range(FIRST_MONTH, d.max(), freq="M"):
        start, end = month.start_time, month.end_time
        train = labeled[(labeled.index.get_level_values("date") < start)
                        & (labeled["next_date"] < start)]
        test = labeled[(labeled.index.get_level_values("date") >= start)
                       & (labeled.index.get_level_values("date") <= end)]
        if test.empty:
            continue
        score = sum(fit(train, cols, s).predict(test[cols]) for s in SEEDS) / len(SEEDS)
        preds.append(test[["excess"]].assign(score=score))
        print(f"  {month} 완료", flush=True)
    pred = pd.concat(preds).reset_index()
    report(pred)

    os.makedirs(PRED_DIR, exist_ok=True)
    out = os.path.join(PRED_DIR, f"model_{name}.csv")
    pred[["date", "code", "score"]].round({"score": 5}).to_csv(out, index=False, encoding="utf-8-sig")
    print(f"  저장 → {out}")


def final(name, df, groups):
    cols = feature_cols(name, groups)
    train = df.dropna(subset=["y"])
    last = train.index.get_level_values("date").max().date()
    os.makedirs(MODEL_DIR, exist_ok=True)
    importance = 0
    for seed in SEEDS:
        m = fit(train, cols, seed)
        m.save_model(os.path.join(MODEL_DIR, f"model_{name}_seed{seed}.json"))
        importance = importance + pd.Series(m.feature_importances_, index=cols)
    meta = {"model": name, "cols": cols, "seeds": SEEDS, "trained_until": str(last)}
    with open(os.path.join(MODEL_DIR, f"model_{name}.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    print(f"모델 {name}: {len(train)}행 (정답 ~{last})으로 학습, 시작값 {len(SEEDS)}개 → {MODEL_DIR}")
    top = (importance / len(SEEDS)).sort_values(ascending=False).head(8)
    print("  중요 피처:", ", ".join(f"{k} {v:.3f}" for k, v in top.items()))


def main():
    args = sys.argv[1:]
    df, groups = load_features()
    df = df.join(load_labels(), how="left")
    if args[:1] == ["--final"]:
        for name in args[1:] or [config.LIVE_MODEL]:
            final(name, df, groups)
        return
    for name in args or ["A", "C"]:
        rolling(name, df, groups)


if __name__ == "__main__":
    main()
