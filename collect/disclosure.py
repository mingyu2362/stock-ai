"""
350개 종목(코스피200 + 코스닥150) 공시 목록 수집 (OpenDART)

- 처음 실행: 2023-01-01부터 오늘까지 종목별로 전부 받는다.
- 다시 실행: 마지막 접수일부터 새 공시만 이어 받는다. (매일 자동 실행용)
- 종목코드 → OpenDART 고유번호(corp_code) 매칭은 corpCode.xml로 한다.

저장 위치: data/raw/disclosure/{종목코드}.csv, data/raw/disclosure/_corp_codes.csv
종목 목록: data/universe.csv  (code, name, market 열)
인증키:   .env 의 DART_API_KEY

설치: pip install requests pandas python-dotenv
실행: python collect/disclosure.py                  (전체)
      python collect/disclosure.py 005930 000660     (일부 종목만)
"""

import io
import os
import sys
import time
import zipfile
import xml.etree.ElementTree as ET
from datetime import date

import pandas as pd
import requests
from dotenv import load_dotenv

START = "20230101"
UNIVERSE_FILE = "data/universe.csv"
OUT_DIR = "data/raw/disclosure"
CORP_FILE = os.path.join(OUT_DIR, "_corp_codes.csv")
FAILED_FILE = os.path.join(OUT_DIR, "_failed.csv")
COLUMNS = ["rcept_dt", "rcept_no", "report_nm", "corp_name", "flr_nm", "rm"]
SLEEP_SEC = 0.3                          # 요청 간격
LIMIT_SLEEP_SEC = 60                     # 020(요청 한도 초과) 때 쉬는 시간
LIMIT_RETRIES = 3
FATAL_STATUS = {"010", "011", "012", "901"}  # 키 오류: 계속해도 소용없으므로 전체 중단

load_dotenv()
API_KEY = os.getenv("DART_API_KEY")


class FatalError(Exception):
    pass


def mask(text):
    """오류 메시지에 인증키가 섞여 나오지 않게 가린다."""
    return str(text).replace(API_KEY, "***") if API_KEY else str(text)


def load_universe():
    for path in [UNIVERSE_FILE, "universe.csv"]:
        if os.path.exists(path):
            df = pd.read_csv(path, dtype={"code": str})
            df["code"] = df["code"].str.zfill(6)
            return df
    sys.exit("종목 목록(data/universe.csv)이 없습니다.")


def load_corp_codes(universe):
    """corpCode.xml(zip)을 받아 종목코드 → 고유번호를 매칭한다."""
    res = requests.get("https://opendart.fss.or.kr/api/corpCode.xml",
                       params={"crtfc_key": API_KEY}, timeout=60)
    res.raise_for_status()
    try:
        with zipfile.ZipFile(io.BytesIO(res.content)) as z:
            root = ET.fromstring(z.read(z.namelist()[0]))
    except zipfile.BadZipFile:
        # 키 오류 등은 zip이 아니라 오류 메시지(xml/json)로 온다
        raise FatalError(f"corpCode.xml 받기 실패: {mask(res.text[:200])}")

    mapping = {}
    for item in root.iter("list"):
        stock_code = (item.findtext("stock_code") or "").strip()
        if stock_code:
            mapping[stock_code] = item.findtext("corp_code").strip()

    df = universe[["code", "name"]].copy()
    df["corp_code"] = df["code"].map(mapping)
    df.to_csv(CORP_FILE, index=False, encoding="utf-8-sig")

    missing = df[df["corp_code"].isna()]
    print(f"고유번호 매칭: {len(df) - len(missing)}개 성공 / {len(missing)}개 실패")
    for row in missing.itertuples():
        print(f"  매칭 실패: {row.code} {row.name}")
    return df.dropna(subset=["corp_code"])


def request_list(corp_code, start, end, page_no):
    """list.json 한 페이지를 받는다. 020이면 쉬었다가 다시 시도한다."""
    params = {"crtfc_key": API_KEY, "corp_code": corp_code,
              "bgn_de": start, "end_de": end,
              "page_no": page_no, "page_count": 100}
    for _ in range(LIMIT_RETRIES + 1):
        res = requests.get("https://opendart.fss.or.kr/api/list.json",
                           params=params, timeout=30)
        res.raise_for_status()
        data = res.json()
        time.sleep(SLEEP_SEC)

        status = data.get("status")
        if status == "020":
            time.sleep(LIMIT_SLEEP_SEC)
            continue
        if status in FATAL_STATUS:
            raise FatalError(f"OpenDART 오류 {status}: {data.get('message')}")
        if status not in ("000", "013"):
            raise RuntimeError(f"status {status}: {data.get('message')}")
        return data
    raise RuntimeError("요청 한도 초과(020)가 계속됨")


def update_one(corp_code, path):
    """저장된 마지막 접수일부터 받아서 이어 붙인다. 추가된 행 수를 반환.
    (그날 늦게 나온 공시를 놓치지 않도록 마지막 접수일 당일부터 다시 받고 rcept_no로 중복 제거)"""
    old = None
    start = START
    if os.path.exists(path):
        old = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8-sig")
        if len(old):
            start = old["rcept_dt"].max()

    today = date.today().strftime("%Y%m%d")
    if start > today:
        return 0

    rows, page_no, total_page = [], 1, 1
    while page_no <= total_page:
        data = request_list(corp_code, start, today, page_no)
        if data["status"] == "013":       # 공시 없음
            break
        rows += data.get("list", [])
        total_page = int(data.get("total_page", 1))
        page_no += 1

    new = pd.DataFrame(rows, columns=COLUMNS) if rows else pd.DataFrame(columns=COLUMNS)
    new = new[COLUMNS].apply(lambda s: s.str.strip())   # report_nm 끝 공백 제거
    if old is not None:
        new = new[~new["rcept_no"].isin(old["rcept_no"])]
        if new.empty:
            return 0

    merged = new if old is None else pd.concat([old, new])
    merged = merged.drop_duplicates("rcept_no").sort_values(["rcept_dt", "rcept_no"])
    merged.to_csv(path, index=False, encoding="utf-8-sig")
    return len(new)


def main():
    if not API_KEY:
        sys.exit(".env에 DART_API_KEY가 없습니다.")
    os.makedirs(OUT_DIR, exist_ok=True)

    universe = load_universe()
    if len(sys.argv) > 1:
        universe = universe[universe["code"].isin(sys.argv[1:])]

    try:
        targets = load_corp_codes(universe)
    except FatalError as e:
        sys.exit(str(e))

    failed = []
    for i, row in enumerate(targets.itertuples(), 1):
        path = os.path.join(OUT_DIR, f"{row.code}.csv")
        try:
            update_one(row.corp_code, path)
        except FatalError as e:
            sys.exit(f"중단: {e}")
        except Exception as e:
            failed.append((row.code, row.name, mask(e)))
            print(f"[{i}/{len(targets)}] {row.code} {row.name:<12} 실패: {mask(e)}")

    total = sum(len(pd.read_csv(os.path.join(OUT_DIR, f"{c}.csv"), dtype=str))
                for c in targets["code"] if os.path.exists(os.path.join(OUT_DIR, f"{c}.csv")))
    print(f"\n완료: 성공 {len(targets) - len(failed)} / 실패 {len(failed)}, 전체 공시 {total:,}건")

    if failed:
        pd.DataFrame(failed, columns=["code", "name", "error"]).to_csv(
            FAILED_FILE, index=False, encoding="utf-8-sig")
        print(f"실패 목록: {FAILED_FILE} (다시 실행하면 실패한 종목만 이어서 받음)")
    elif os.path.exists(FAILED_FILE):
        os.remove(FAILED_FILE)


if __name__ == "__main__":
    main()
