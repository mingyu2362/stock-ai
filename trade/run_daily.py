"""매 거래일 실행 흐름

1. 휴장일 확인 → 휴장일이면 종료
2. 데이터 수집 → 피처 계산 → 모델 D 예측 → SHAP 근거
3. 잔고와 비교해 매매 판단 → 주문
4. data/predictions, data/trades 에 저장

안전장치
- DRY_RUN=True 이면 주문 없이 "이렇게 주문하겠다"만 출력
- 같은 날 이미 주문 기록이 있으면 건너뜀 (중복 주문 방지)
- 종목당 최대 주문 금액 제한
"""
import config


def main():
    print(f"DRY_RUN={config.DRY_RUN} / 대상 종목 {len(config.TICKERS)}개")
    # TODO: SP2에서 구현


if __name__ == "__main__":
    main()
