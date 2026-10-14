"""공시 수집 (OpenDART)

- 종목코드 → OpenDART 고유번호(corp_code) 매칭 후 공시 목록 수집
- 페이지당 최대 100건 → 페이지 넘기며 수집
- 저장: data/raw/disclosure/{종목코드}.csv
"""
