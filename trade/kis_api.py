"""한국투자증권 Open API (모의투자)

- 토큰 발급 (하루 1회 발급 후 재사용, 1분 내 재요청 시 차단됨) → token_kis.json 에 저장 (.gitignore)
- 잔고 조회, 주문가능금액, 현재가, 시장가 주문, 오늘 체결 조회
- 모의투자 주소: https://openapivts.koreainvestment.com:29443
- 키는 환경변수(.env / GitHub Secrets)에서만 읽는다
- 모의투자는 초당 호출 수 제한이 낮아(약 2회) 호출 사이에 간격을 둔다
"""

import json
import os
import time
from datetime import datetime

import requests
from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(ROOT, ".env"))

BASE = "https://openapivts.koreainvestment.com:29443"
TOKEN_FILE = os.path.join(ROOT, "token_kis.json")
CALL_GAP_SEC = 0.6
RATE_LIMIT = ("EGW00201", "EGW00215")   # 초당 거래건수 초과 (모의투자는 주로 EGW00215)
RETRIES = 6


class KisError(Exception):
    pass


class Kis:
    def __init__(self):
        self.key = os.environ.get("KIS_APP_KEY")
        self.secret = os.environ.get("KIS_APP_SECRET")
        account = os.environ.get("KIS_ACCOUNT", "")
        digits = "".join(ch for ch in account if ch.isdigit())
        if not self.key or not self.secret or len(digits) < 8:
            raise KisError("KIS_APP_KEY, KIS_APP_SECRET, KIS_ACCOUNT 환경변수를 확인하세요 (.env)")
        self.cano, self.prdt = digits[:8], digits[8:10] or "01"
        self._token = None
        self._last_call = 0.0

    # ---------- 공통 ----------
    def token(self):
        if self._token and self._token["expires"] - time.time() > 600:
            return self._token["value"]
        if os.path.exists(TOKEN_FILE):
            with open(TOKEN_FILE, encoding="utf-8") as f:
                saved = json.load(f)
            if saved.get("key") == self.key[:8] and saved["expires"] - time.time() > 600:
                self._token = saved
                return saved["value"]
        r = requests.post(f"{BASE}/oauth2/tokenP", json={
            "grant_type": "client_credentials", "appkey": self.key, "appsecret": self.secret}, timeout=10)
        body = r.json()
        if "access_token" not in body:
            raise KisError(f"토큰 발급 실패: {body.get('error_description') or body.get('msg1') or r.status_code}"
                           " (1분에 1번만 발급됨)")
        self._token = {"key": self.key[:8], "value": body["access_token"],
                       "expires": time.time() + int(body.get("expires_in", 86400))}
        with open(TOKEN_FILE, "w", encoding="utf-8") as f:
            json.dump(self._token, f)
        return self._token["value"]

    def _call(self, method, path, tr_id, params=None, body=None):
        for attempt in range(RETRIES):
            wait = self._last_call + CALL_GAP_SEC - time.time()
            if wait > 0:
                time.sleep(wait)
            headers = {
                "content-type": "application/json; charset=utf-8",
                "authorization": f"Bearer {self.token()}",
                "appkey": self.key, "appsecret": self.secret, "tr_id": tr_id, "custtype": "P",
            }
            r = requests.request(method, f"{BASE}{path}", headers=headers, params=params,
                                 data=json.dumps(body) if body else None, timeout=10)
            self._last_call = time.time()
            data = r.json()
            if data.get("msg_cd") in RATE_LIMIT:      # 거부된 요청이라 주문도 다시 보내도 중복되지 않음
                time.sleep(1 + attempt)
                continue
            if data.get("msg_cd") == "EGW00123":      # 토큰 만료
                self._token = None
                if os.path.exists(TOKEN_FILE):
                    os.remove(TOKEN_FILE)
                continue
            return data
        return data

    def _account(self):
        return {"CANO": self.cano, "ACNT_PRDT_CD": self.prdt}

    @staticmethod
    def _check(data, what):
        if data.get("rt_cd") != "0":
            raise KisError(f"{what} 실패: [{data.get('msg_cd')}] {data.get('msg1')}")
        return data

    # ---------- 조회 ----------
    def balance(self):
        """보유 종목과 계좌 요약. holdings: {code: {name, shares, avg_price, price, value}}"""
        params = {**self._account(), "AFHR_FLPR_YN": "N", "OFL_YN": "", "INQR_DVSN": "02",
                  "UNPR_DVSN": "01", "FUND_STTL_ICLD_YN": "N", "FNCG_AMT_AUTO_RDPT_YN": "N",
                  "PRCS_DVSN": "00", "CTX_AREA_FK100": "", "CTX_AREA_NK100": ""}
        data = self._check(self._call("GET", "/uapi/domestic-stock/v1/trading/inquire-balance",
                                      "VTTC8434R", params=params), "잔고 조회")
        holdings = {}
        for p in data.get("output1", []):
            shares = int(p["hldg_qty"])
            if shares > 0:
                holdings[p["pdno"]] = {"name": p["prdt_name"], "shares": shares,
                                       "avg_price": float(p["pchs_avg_pric"]), "price": float(p["prpr"]),
                                       "value": float(p["evlu_amt"])}
        s = (data.get("output2") or [{}])[0]
        total = float(s.get("tot_evlu_amt", 0))           # 총평가금액 = 주식 평가 + D+2 예수금
        stock_value = float(s.get("scts_evlu_amt", 0))
        return {"holdings": holdings, "total": total, "stock_value": stock_value,
                "cash": total - stock_value}

    def orderable_cash(self, code="005930"):
        """지금 매수에 쓸 수 있는 현금 (주문가능현금)."""
        params = {**self._account(), "PDNO": code, "ORD_UNPR": "0", "ORD_DVSN": "01",
                  "CMA_EVLU_AMT_ICLD_YN": "N", "OVRS_ICLD_YN": "N"}
        data = self._check(self._call("GET", "/uapi/domestic-stock/v1/trading/inquire-psbl-order",
                                      "VTTC8908R", params=params), "주문가능금액 조회")
        return float(data["output"]["ord_psbl_cash"])

    def price(self, code):
        """현재가 (장 전에는 전일 종가, 동시호가 중에는 예상 체결가가 아닐 수 있음)."""
        return self.quote(code)["price"]

    def quote(self, code):
        """현재가와 오늘 고가·저가."""
        params = {"FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code}
        data = self._check(self._call("GET", "/uapi/domestic-stock/v1/quotations/inquire-price",
                                      "FHKST01010100", params=params), f"{code} 현재가 조회")
        o = data["output"]
        return {"price": float(o["stck_prpr"]), "high": float(o["stck_hgpr"]), "low": float(o["stck_lwpr"])}

    def fills(self, day=None):
        """오늘(또는 day=YYYYMMDD) 체결된 주문. [{code, name, side, shares, price, order_no}]"""
        day = day or datetime.now().strftime("%Y%m%d")
        params = {**self._account(), "INQR_STRT_DT": day, "INQR_END_DT": day, "SLL_BUY_DVSN_CD": "00",
                  "INQR_DVSN": "00", "PDNO": "", "CCLD_DVSN": "01", "ORD_GNO_BRNO": "", "ODNO": "",
                  "INQR_DVSN_3": "00", "INQR_DVSN_1": "", "CTX_AREA_FK100": "", "CTX_AREA_NK100": ""}
        data = self._check(self._call("GET", "/uapi/domestic-stock/v1/trading/inquire-daily-ccld",
                                      "VTTC8001R", params=params), "체결 조회")
        out = []
        for o in data.get("output1", []):
            qty = int(o.get("tot_ccld_qty") or 0)
            if qty > 0:
                out.append({"code": o["pdno"], "name": o["prdt_name"],
                            "side": "sell" if o["sll_buy_dvsn_cd"] == "01" else "buy",
                            "shares": qty, "price": float(o["avg_prvs"]), "order_no": o["odno"]})
        return out

    def fill_summary(self, code, side, day=None):
        """종목·매매 방향별 그날 체결 합계 (수량, 평균가).
        모의투자 체결 조회는 주문별 목록(output1)이 비어 나오지만 합계(output2)는 채워져 있어 이것을 쓴다."""
        day = day or datetime.now().strftime("%Y%m%d")
        params = {**self._account(), "INQR_STRT_DT": day, "INQR_END_DT": day,
                  "SLL_BUY_DVSN_CD": {"sell": "01", "buy": "02"}[side], "INQR_DVSN": "00", "PDNO": code,
                  "CCLD_DVSN": "01", "ORD_GNO_BRNO": "", "ODNO": "", "INQR_DVSN_3": "00", "INQR_DVSN_1": "",
                  "CTX_AREA_FK100": "", "CTX_AREA_NK100": ""}
        data = self._check(self._call("GET", "/uapi/domestic-stock/v1/trading/inquire-daily-ccld",
                                      "VTTC8001R", params=params), f"{code} 체결 합계 조회")
        s = data.get("output2") or {}
        s = s[0] if isinstance(s, list) else s
        qty = int(float(s.get("tot_ccld_qty") or 0))
        amt = float(s.get("tot_ccld_amt") or 0)
        return qty, (amt / qty if qty else 0.0)

    # ---------- 주문 ----------
    def order(self, side, code, shares, price=None):
        """주문. price=None 이면 시장가, 아니면 지정가. (주문번호, 주문 기관번호)를 돌려준다.
        시장가 매수는 한투가 상한가 근처 가격으로 현금을 잡아 두므로, 여러 종목을 살 때는 지정가를 쓴다."""
        body = {**self._account(), "PDNO": code, "ORD_DVSN": "01" if price is None else "00",
                "ORD_QTY": str(int(shares)), "ORD_UNPR": "0" if price is None else str(int(price))}
        tr_id = {"buy": "VTTC0802U", "sell": "VTTC0801U"}[side]
        data = self._check(self._call("POST", "/uapi/domestic-stock/v1/trading/order-cash", tr_id,
                                      body=body), f"{code} {side} {shares}주 주문")
        return data["output"]["ODNO"], data["output"]["KRX_FWDG_ORD_ORGNO"]

    def cancel(self, order_no, org_no):
        """미체결 주문 전량 취소."""
        body = {**self._account(), "KRX_FWDG_ORD_ORGNO": org_no, "ORGN_ODNO": order_no, "ORD_DVSN": "00",
                "RVSE_CNCL_DVSN_CD": "02", "ORD_QTY": "0", "ORD_UNPR": "0", "QTY_ALL_ORD_YN": "Y"}
        self._check(self._call("POST", "/uapi/domestic-stock/v1/trading/order-rvsecncl", "VTTC0803U",
                               body=body), f"주문 {order_no} 취소")


def tick_size(price):
    """한국거래소 호가 단위 (2023년 이후 코스피·코스닥 공통)."""
    for limit, tick in [(2_000, 1), (5_000, 5), (20_000, 10), (50_000, 50), (200_000, 100), (500_000, 500)]:
        if price < limit:
            return tick
    return 1_000


def round_up_tick(price):
    t = tick_size(price)
    return int(-(-price // t) * t)
