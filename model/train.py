"""모델 학습 (A~D 비교)

- A: 차트 / B: 뉴스 / C: 차트+뉴스 / D: 차트+뉴스+공시  (시장 피처는 모든 모델 공통)
- 같은 피처 표에서 사용하는 열만 바꿔 학습 (config.FEATURE_GROUPS)
- 시간 순서 분할: config.TRAIN/VALID/TEST 기간 (무작위 분할 금지)
- XGBoost 주력, LSTM 비교
"""
