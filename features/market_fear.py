"""시장 뉴스 공포/심리 피처

입력: data/raw/news/market_{연도}.csv (collect/market_news.py), data/raw/market.csv
출력
- data/processed/news_title_scores.csv  제목별 FinBert 확률 (한 번 계산한 제목은 재사용)
- data/processed/market_news_daily.csv  달력 날짜별 점수 (시점 이동 전, 검증·확인용)
- data/processed/market_fear.csv        한국 거래일별 피처 (config.NEWS_LAG_DAYS 적용, 모델 입력용)

점수 (features/test_finbert.py 테스트 결과로 정함)
- fbneg:    KR-FinBert-SC가 부정으로 판정한 기사 비율. 81%를 중립으로 보고 급등일은 못 잡지만
            급락일엔 부정 비율이 평소의 두 배 → 방향이 아니라 공포 신호로만 쓴다
- fear:     공포 단어(폭락·패닉·공포 등)가 들어간 기사 비율
- fear_idx: 공포지수 = fbneg, fear 를 각각 학습 기간(config.TRAIN) 평균·표준편차로
            표준화한 뒤 평균. 0이 학습 기간 평균, +1이면 1 표준편차만큼 공포가 큼
- dict:     방향 단어 사전. (상승 단어 기사 - 하락 단어 기사) / 전체 (방향은 이것으로 판단)
            환율·금리 기사는 오르면 증시에 악재 → 부호를 뒤집는다

시점 규칙: 거래일 T의 피처 = T - NEWS_LAG_DAYS 일(달력 기준)까지 발행된 뉴스만 사용
          (기사 날짜는 검색 날짜가 아니라 발행 날짜, load_news 참고)
실행: python features/market_fear.py   (프로젝트 루트에서, 끝에 검증 결과 출력)
"""

import glob
import os
import re
import sys

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
import config  # noqa: E402

NEWS_GLOB = os.path.join(ROOT, "data", "raw", "news", "market_[0-9]*.csv")
MARKET_FILE = os.path.join(ROOT, "data", "raw", "market.csv")
PROC_DIR = os.path.join(ROOT, "data", "processed")
SCORE_FILE = os.path.join(PROC_DIR, "news_title_scores.csv")
DAILY_FILE = os.path.join(PROC_DIR, "market_news_daily.csv")
FEATURE_FILE = os.path.join(PROC_DIR, "market_fear.csv")

FINBERT = "snunlp/KR-FinBert-SC"

# 개별 종목 홍보성·리포트 기사, 예금·대출 상품 기사 (시장 심리와 무관하고 점수를 왜곡)
NOISE = re.compile(r"e종목|종목 체크|특징주|애널픽|공모가|상장 추진|코스닥 상장|IPO"
                   r"|리포트 브리핑|목표가 [\d,]+원|적금|정기예금|특판|금리 제공|대출 ?금리")
UP = re.compile(r"상승|급등|반등|돌파|강세|회복|랠리|최고|순매수|훈풍|오름|올라|뛰")
DOWN = re.compile(r"하락|급락|폭락|붕괴|약세|추락|최저|순매도|이탈|내림|내려|빠지|빠져|털썩|주저")
FEAR = re.compile(r"폭락|패닉|공포|쇼크|충격|공황|위기|블랙|투매|붕괴|서킷|사이드카|검은")
# 오르면 증시에 악재인 지표 (증시 단어가 같이 있으면 증시 방향을 우선,
# 실적 기사는 "환율 변수에도 실적 급등"처럼 방향이 회사 실적을 가리키므로 뒤집지 않음)
INVERSE = re.compile(r"환율|원·달러|원달러|금리|국채")
EQUITY = re.compile(r"코스피|코스닥|증시|주가|주식|실적")

LAG_WINDOWS = [1, 3]  # 달력 일 기준 롤링 창
COUNT_BASE = 20       # 기사 수 비교 기준 (최근 20일 평균)


def norm(title):
    return "".join(ch for ch in str(title) if ch.isalnum())


def load_news():
    files = sorted(glob.glob(NEWS_GLOB))
    if not files:
        raise SystemExit("시장 뉴스가 없습니다. 먼저 python collect/market_news.py 를 실행하세요.")
    df = pd.concat([pd.read_csv(f) for f in files], ignore_index=True)
    # 기사 날짜 = 발행 날짜. 검색 날짜(date)는 절반이 하루 이른 날로 잡혀 있다
    # (검색 날짜 d의 마감 시황 기사 절반이 d+1 장을 다룸 → 그대로 쓰면 미래 기사가 섞임).
    # 발행 시각은 16·17시 정각 자리표시라 쓸 수 없지만 날짜는 기사가 다룬 날과 90% 일치
    searched = pd.to_datetime(df["date"])
    df["date"] = (pd.to_datetime(df["pub_kst"], utc=True).dt.tz_convert("Asia/Seoul")
                  .dt.tz_localize(None).dt.normalize())
    # 발행일 D 기사는 검색 날짜 D-1, D 둘에 나뉘어 있으므로 양 끝 날짜는 덜 모인 상태 → 제외
    df = df[(df["date"] > searched.min()) & (df["date"] <= searched.max())]
    df["norm"] = df["title"].map(norm)
    df = df.drop_duplicates(["date", "norm"])          # 검색어·검색 날짜끼리 겹친 기사
    return df[~df["title"].str.contains(NOISE)].reset_index(drop=True)


def finbert_scores(titles):
    """제목별 (부정, 중립, 긍정) 확률. 캐시에 없는 제목만 계산한다."""
    cache = (pd.read_csv(SCORE_FILE).set_index("norm") if os.path.exists(SCORE_FILE)
             else pd.DataFrame(columns=["p_neg", "p_neu", "p_pos"]))
    todo = titles[~titles.map(norm).isin(cache.index)].drop_duplicates()
    if len(todo):
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        tok = AutoTokenizer.from_pretrained(FINBERT)
        model = AutoModelForSequenceClassification.from_pretrained(FINBERT).eval()
        print(f"FinBert: 새 제목 {len(todo)}개 판정 (기존 {len(cache)}개 재사용)")
        batch, parts = 128, [cache] if len(cache) else []
        for i in range(0, len(todo), batch):
            chunk = todo.iloc[i:i + batch].tolist()
            enc = tok(chunk, padding=True, truncation=True, max_length=64, return_tensors="pt")
            with torch.no_grad():
                p = torch.softmax(model(**enc).logits, dim=-1).numpy()  # 0 neg, 1 neu, 2 pos
            part = pd.DataFrame(p, columns=["p_neg", "p_neu", "p_pos"],
                                index=pd.Index([norm(t) for t in chunk], name="norm"))
            part.round(4).to_csv(SCORE_FILE, mode="a", encoding="utf-8-sig",
                                 header=not os.path.exists(SCORE_FILE))
            parts.append(part)
            if (i // batch) % 50 == 0:
                print(f"  {i + len(chunk)}/{len(todo)}", flush=True)
        cache = pd.concat(parts)
    return cache[~cache.index.duplicated(keep="last")]


def dict_direction(title):
    """+1 증시에 호재, -1 악재, 0 판단 불가."""
    d = int(bool(UP.search(title))) - int(bool(DOWN.search(title)))
    if d and INVERSE.search(title) and not EQUITY.search(title):
        d = -d
    return d


def daily_scores(news):
    scores = finbert_scores(news["title"])
    news = news.join(scores, on="norm")
    news["fbneg"] = (news[["p_neg", "p_neu", "p_pos"]].to_numpy().argmax(1) == 0).astype(int)
    news["dir"] = news["title"].map(dict_direction)
    news["fear"] = news["title"].str.contains(FEAR).astype(int)

    g = news.groupby("date")
    daily = pd.DataFrame({
        "n": g.size(),
        "fbneg_sum": g["fbneg"].sum(),
        "dir_sum": g["dir"].sum(),
        "fear_sum": g["fear"].sum(),
    })
    # 기사가 0건인 날도 행을 만든다 (주말 등)
    full = pd.date_range(daily.index.min(), daily.index.max(), freq="D")
    return daily.reindex(full, fill_value=0).rename_axis("date")


def fear_index(fbneg, fear):
    """공포지수: 두 비율을 학습 기간 평균·표준편차로 표준화한 뒤 평균 (검증·테스트 기간 정보 미사용)."""
    train = slice(*config.TRAIN)
    z = [(s - s[train].mean()) / s[train].std() for s in (fbneg, fear)]
    return (z[0] + z[1]) / 2


def to_trading_days(daily, lag):
    """거래일 T 행 = T - lag 일까지의 뉴스로 만든 피처."""
    feats = pd.DataFrame(index=daily.index)
    for w in LAG_WINDOWS:
        r = daily.rolling(w, min_periods=1).sum()
        n = r["n"].replace(0, np.nan)
        feats[f"news_fbneg_{w}d"] = r["fbneg_sum"] / n
        feats[f"news_fear_{w}d"] = r["fear_sum"] / n
        feats[f"news_fear_idx_{w}d"] = fear_index(feats[f"news_fbneg_{w}d"],
                                                  feats[f"news_fear_{w}d"])
        feats[f"news_dict_{w}d"] = r["dir_sum"] / n
    feats["news_dict_chg"] = feats["news_dict_1d"] - feats["news_dict_1d"].shift(1)
    feats["news_count_ratio"] = (daily["n"].rolling(3).mean()
                                 / daily["n"].rolling(COUNT_BASE).mean())
    feats["news_none"] = (daily["n"] == 0).astype(int)

    feats = feats.shift(lag, freq="D")   # 시점 이동
    trade_days = pd.to_datetime(pd.read_csv(MARKET_FILE, usecols=["date"])["date"])
    return feats.reindex(trade_days).rename_axis("date")


def validate(daily):
    """뉴스 점수가 실제 시장과 같이 움직이는지 확인 (시점 이동 전 달력 점수 사용)."""
    m = pd.read_csv(MARKET_FILE, parse_dates=["date"]).set_index("date")
    ret = m["kospi"].pct_change() * 100
    n = daily["n"].replace(0, np.nan)
    s = pd.DataFrame({
        "dict": daily["dir_sum"] / n,
        "fbneg": daily["fbneg_sum"] / n,
        "fear": daily["fear_sum"] / n,
    })
    s["fear_idx"] = fear_index(s["fbneg"], s["fear"])
    print("\n=== 검증: 뉴스 날짜 d 점수 vs 코스피 등락 (상관계수) ===")
    print("  shift -1: d일 뉴스 vs d-1일 등락 (전날 시황 기사)")
    print("  shift  0: d일 뉴스 vs d일 등락")
    print("  shift +1: d일 뉴스 vs d+1일 등락 (예측력, 시점상 사용 가능)")
    rows = []
    for k in [-1, 0, 1, config.NEWS_LAG_DAYS]:
        target = ret.shift(-k)
        j = s.join(target.rename("ret"), how="inner").dropna()
        rows.append({"shift": k, "n": len(j),
                     **{c: round(j[c].corr(j["ret"]), 3) for c in s.columns}})
    print(pd.DataFrame(rows).to_string(index=False))

    j = s.join(m["us_vix"], how="inner").dropna()
    j["vix_next"] = m["us_vix"].shift(-1).reindex(j.index)  # us_vix는 전날 미국 값
    print("\n=== 검증: 뉴스 점수 vs VIX 수준 ===")
    print({c: round(j[c].corr(j["vix_next"]), 3) for c in s.columns})
    print("(dict는 음수, fbneg/fear/fear_idx는 양수가 나와야 공포를 잘 잡는 것)")


def main():
    os.makedirs(PROC_DIR, exist_ok=True)
    news = load_news()
    print(f"기사 {len(news)}건, {news['date'].min().date()} ~ {news['date'].max().date()}")

    daily = daily_scores(news)
    daily.to_csv(DAILY_FILE, encoding="utf-8-sig")

    feats = to_trading_days(daily, config.NEWS_LAG_DAYS)
    feats.round(4).to_csv(FEATURE_FILE, encoding="utf-8-sig")
    print(f"거래일 피처 {feats.dropna(how='all').shape[0]}일 저장 → {FEATURE_FILE}")

    validate(daily)


if __name__ == "__main__":
    main()
