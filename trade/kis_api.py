"""한국투자증권 Open API (모의투자)

- 토큰 발급 (하루 1회 발급 후 재사용, 1분 내 재요청 시 차단됨)
- 잔고 조회, 주문, 체결 조회
- 모의투자 주소: https://openapivts.koreainvestment.com:29443
- 키는 환경변수(.env / GitHub Secrets)에서만 읽는다
"""
