"""백테스트

- 매매 규칙: config.BUY_THRESHOLD 이상·미보유 → 매수, config.SELL_THRESHOLD 이하·보유 → 매도
- 거래 비용: config.ROUND_TRIP_COST 차감
- 지표: 누적 수익률, MDD, 샤프지수 / 비교 기준: Buy & Hold
"""
