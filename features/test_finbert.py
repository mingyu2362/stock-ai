"""KR-FinBert-SC 뉴스 감성 판정 테스트

확인하는 것
1. 정답을 아는 예문(직접 작성)을 맞히는지
2. 수집한 시장 뉴스 제목의 판정 분포 (긍정/중립/부정 비율, 확신도)
3. 방향 단어 사전과 판정이 얼마나 일치하는지 (사전이 상승/하락으로 본 제목 기준)
4. 사전과 반대로 판정한 제목 예시 (눈으로 확인)
5. 코스피가 크게 오르거나 내린 날의 뉴스 점수가 그 방향과 맞는지

입력: data/raw/news/market_{연도}.csv, data/processed/news_title_scores.csv (market_fear.py가 만든 캐시)
실행: python features/test_finbert.py   (프로젝트 루트에서, 먼저 python features/market_fear.py)
"""

import os
import sys

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from features.market_fear import (FINBERT, MARKET_FILE, SCORE_FILE,  # noqa: E402
                                  dict_direction, load_news)

LABELS = ["부정", "중립", "긍정"]
EXAMPLES_PER_CASE = 8
EXTREME_DAYS = 15  # 코스피 등락 상하위 N일

# 정답을 아는 예문 (직접 작성, 시장 뉴스 제목 형식)
SANITY = [
    ("코스피 3% 급락…외국인 1조 매도 폭탄", "부정"),
    ("코스닥 700선 붕괴, 투자심리 꽁꽁", "부정"),
    ("美 금리 인상 충격에 증시 패닉…시총 100조 증발", "부정"),
    ("반도체 실적 쇼크에 코스피 2,400선 추락", "부정"),
    ("원·달러 환율 1,450원 돌파…외국인 이탈 우려", "부정"),
    ("코스피 사상 최고치 경신…외국인 순매수 행진", "긍정"),
    ("코스닥 2% 급등, 2차전지 강세에 반등 성공", "긍정"),
    ("증시 훈풍에 개인 투자자 수익률 개선", "긍정"),
    ("외국인 귀환에 코스피 3,000 회복", "긍정"),
    ("금리 인하 기대감에 증시 랠리 이어져", "긍정"),
    ("코스피 보합 마감…관망세 이어져", "중립"),
    ("한국거래소, 다음 달 코스피200 정기변경 발표", "중립"),
    ("오늘의 증시 일정", "중립"),
    ("한국은행, 기준금리 동결 결정", "중립"),
]


def show(title, df, cols):
    print(f"\n=== {title} ===")
    print(df[cols].to_string(index=False) if len(df) else "(없음)")


def test_sanity():
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(FINBERT)
    model = AutoModelForSequenceClassification.from_pretrained(FINBERT).eval()
    texts = [t for t, _ in SANITY]
    enc = tok(texts, padding=True, truncation=True, max_length=64, return_tensors="pt")
    with torch.no_grad():
        p = torch.softmax(model(**enc).logits, dim=-1).numpy()
    df = pd.DataFrame({
        "정답": [y for _, y in SANITY],
        "판정": [LABELS[i] for i in p.argmax(1)],
        "확신": p.max(1).round(2),
        "제목": texts,
    })
    df["맞음"] = (df["정답"] == df["판정"]).map({True: "O", False: "X"})
    show(f"1. 예문 테스트: {(df['맞음'] == 'O').sum()}/{len(df)} 정답",
         df, ["맞음", "정답", "판정", "확신", "제목"])


def load_scored():
    news = load_news()
    scores = pd.read_csv(SCORE_FILE)
    scores = scores.drop_duplicates("norm", keep="last").set_index("norm")
    news = news.join(scores, on="norm", how="inner")
    p = news[["p_neg", "p_neu", "p_pos"]].to_numpy()
    news["label"] = [LABELS[i] for i in p.argmax(1)]
    news["conf"] = p.max(1).round(2)
    news["dir"] = news["title"].map(dict_direction)
    return news


def test_distribution(news):
    print(f"\n=== 2. 판정 분포 (기사 {len(news)}건) ===")
    dist = news["label"].value_counts(normalize=True).reindex(LABELS).mul(100).round(1)
    print(dist.to_string())
    print("\n연도별 비율(%):")
    by_year = pd.crosstab(news["date"].dt.year, news["label"], normalize="index")
    print(by_year.reindex(columns=LABELS).mul(100).round(1).to_string())
    print(f"\n확신도 0.9 이상 비율: {(news['conf'] >= 0.9).mean() * 100:.1f}%")


def test_vs_dict(news):
    d = news[news["dir"] != 0].copy()
    d["사전"] = d["dir"].map({1: "긍정", -1: "부정"})
    print(f"\n=== 3. 방향 사전과 비교 (사전이 방향을 판단한 {len(d)}건, 전체의 "
          f"{len(d) / len(news) * 100:.0f}%) ===")
    print("행 = 사전, 열 = FinBert (%)")
    tab = pd.crosstab(d["사전"], d["label"], normalize="index")
    print(tab.reindex(columns=LABELS).mul(100).round(1).to_string())
    agree = (d["사전"] == d["label"]).mean() * 100
    opposite = (((d["사전"] == "긍정") & (d["label"] == "부정"))
                | ((d["사전"] == "부정") & (d["label"] == "긍정"))).mean() * 100
    print(f"일치 {agree:.1f}%, 정반대 {opposite:.1f}%, 나머지는 FinBert가 중립")

    cols = ["date", "conf", "title"]
    for dict_lab, fb_lab in [("부정", "긍정"), ("긍정", "부정"), ("부정", "중립")]:
        ex = d[(d["사전"] == dict_lab) & (d["label"] == fb_lab)]
        ex = ex.sample(min(EXAMPLES_PER_CASE, len(ex)), random_state=0).sort_values("date")
        show(f"4. 사전 {dict_lab} / FinBert {fb_lab} 예시", ex, cols)


def test_extreme_days(news):
    m = pd.read_csv(MARKET_FILE, parse_dates=["date"]).set_index("date")
    ret = (m["kospi"].pct_change() * 100).dropna()
    news = news.assign(fb=news["p_pos"] - news["p_neg"])
    daily = news.groupby("date").agg(fb=("fb", "mean"), dir=("dir", "mean"),
                                     neg=("label", lambda s: (s == "부정").mean()))
    print(f"\n=== 5. 코스피 등락 상하위 {EXTREME_DAYS}일의 같은 날 뉴스 점수 ===")
    rows = []
    for name, days in [("급락일", ret.nsmallest(EXTREME_DAYS).index),
                       ("급등일", ret.nlargest(EXTREME_DAYS).index),
                       ("전체 평균", ret.index)]:
        s = daily.reindex(days)
        rows.append({"구분": name, "코스피 등락(%)": round(ret.reindex(days).mean(), 2),
                     "finbert(긍-부)": round(s["fb"].mean(), 3),
                     "사전 방향": round(s["dir"].mean(), 3),
                     "부정 비율": round(s["neg"].mean(), 3)})
    print(pd.DataFrame(rows).to_string(index=False))
    print("(급락일에 finbert·사전이 전체 평균보다 낮고, 부정 비율이 높아야 함)")


def main():
    pd.set_option("display.max_colwidth", 60)
    pd.set_option("display.width", 200)
    test_sanity()
    news = load_scored()
    test_distribution(news)
    test_vs_dict(news)
    test_extreme_days(news)


if __name__ == "__main__":
    main()
