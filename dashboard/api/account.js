// 한국투자증권 모의투자 계좌 잔고 (Vercel 서버리스 함수, 개발 중에는 vite.config.js 가 같은 함수를 씀)
// POST /api/account  { appKey, appSecret, account, token?, codes? } → { fetchedAt, summary, positions, orders, orderSummary, ordersByCode, token }
//
// 사용자 키는 사용자 브라우저에만 있고 요청마다 함께 온다. 서버는 저장·기록하지 않고 한투에 전달만 한다.
// - 잔고·오늘 주문 내역 조회만 한다. 주문 기능은 일부러 넣지 않음 (키가 새도 이 서버로는 주문이 나갈 수 없게)
// - 토큰(1분에 1번만 발급됨)도 브라우저로 돌려보내 브라우저가 들고 있게 한다 → 서버는 상태 없음
// - 키를 URL 이 아니라 본문으로 받는다 (URL 은 접속 기록에 남음)

const BASE = "https://openapivts.koreainvestment.com:29443";

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

const num = (s) => Number(s ?? 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const issuing = new Map();   // 같은 키로 동시에 들어온 요청이 토큰을 두 번 발급받지 않도록 (요청이 끝나면 지움)

// Vercel 은 JSON 본문을 req.body 로 주고, 개발 서버(vite)는 직접 읽어야 한다
async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("요청이 너무 큽니다.");
  }
  return JSON.parse(raw || "{}");
}

async function issueToken(appKey, appSecret) {
  const r = await fetch(`${BASE}/oauth2/tokenP`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: appKey, appsecret: appSecret }),
  });
  const body = await r.json();
  if (!body.access_token) {
    throw new Error(`토큰 발급 실패: ${body.error_description || body.msg1 || r.status} (키를 확인하거나 1분 뒤 다시 시도)`);
  }
  return { value: body.access_token, expires: Date.now() + (body.expires_in || 86400) * 1000 };
}

function getToken(appKey, appSecret) {
  if (!issuing.has(appKey)) {
    issuing.set(appKey, issueToken(appKey, appSecret).finally(() => issuing.delete(appKey)));
  }
  return issuing.get(appKey);
}

// 조회 GET 공통. 토큰 만료면 null
async function kisGet(path, trId, params, what, { appKey, appSecret, token }) {
  let body, r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fetch(`${BASE}${path}?${new URLSearchParams(params)}`, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        authorization: `Bearer ${token.value}`, appkey: appKey, appsecret: appSecret, tr_id: trId, custtype: "P",
      },
    });
    body = await r.json();
    if (body.msg_cd !== "EGW00201") break;   // 초당 거래건수 초과 → 1초 뒤 다시
    await sleep(1000);
  }
  if (body.msg_cd === "EGW00123") return null;   // 토큰 만료 → 새로 발급
  if (body.rt_cd !== "0") throw new Error(`${what} 실패: ${body.msg1 || r.status}`);
  return body;
}

// 한국 날짜 YYYYMMDD (Vercel 서버는 UTC)
const kstDay = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");

// 오늘 주문 (체결·미체결·취소 모두). 정정·취소 주문 자체(원주문번호가 있는 줄)는 빼고 원주문 상태만 보여 준다
async function fetchOrders(ctx) {
  const day = kstDay();
  const body = await kisGet("/uapi/domestic-stock/v1/trading/inquire-daily-ccld", "VTTC8001R", {
    CANO: ctx.cano, ACNT_PRDT_CD: ctx.prdt, INQR_STRT_DT: day, INQR_END_DT: day, SLL_BUY_DVSN_CD: "00",
    INQR_DVSN: "00", PDNO: "", CCLD_DVSN: "00", ORD_GNO_BRNO: "", ODNO: "", INQR_DVSN_3: "00", INQR_DVSN_1: "",
    CTX_AREA_FK100: "", CTX_AREA_NK100: "",
  }, "주문 내역 조회", ctx);
  if (!body) return null;
  // 모의투자는 주문별 목록(output1)을 비워 주고 합계(output2)만 채워 줄 때가 있다
  const s = Array.isArray(body.output2) ? body.output2[0] || {} : body.output2 || {};
  const summary = { qty: num(s.tot_ord_qty), filled: num(s.tot_ccld_qty), amount: num(s.tot_ccld_amt), fee: num(s.prsm_tlex_smtl) };
  const rows = (body.output1 || [])
    .filter((o) => !Number(o.orgn_odno))
    .map((o) => {
      const qty = num(o.ord_qty);
      const filled = num(o.tot_ccld_qty);
      const canceled = num(o.cncl_cfrm_qty);
      const remain = o.rmn_qty != null ? num(o.rmn_qty) : Math.max(qty - filled - canceled, 0);
      return {
        orderNo: o.odno,
        time: o.ord_tmd ? `${o.ord_tmd.slice(0, 2)}:${o.ord_tmd.slice(2, 4)}:${o.ord_tmd.slice(4, 6)}` : "",
        code: o.pdno,
        name: o.prdt_name,
        side: o.sll_buy_dvsn_cd === "01" ? "sell" : "buy",
        type: o.ord_dvsn_name || "",
        qty, filled, remain, canceled,
        orderPrice: num(o.ord_unpr),
        fillPrice: num(o.avg_prvs),
        rejected: num(o.rjct_qty),
      };
    })
    .sort((a, b) => b.time.localeCompare(a.time) || b.orderNo.localeCompare(a.orderNo));
  return { rows, summary };
}

// 주문별 목록이 비어 올 때: 종목코드를 넣어 조회하면 그 종목의 오늘 주문·체결 합계는 받을 수 있다
async function fetchOrdersByCode(ctx, codes) {
  const day = kstDay();
  const out = [];
  for (const code of codes) {
    await sleep(500);
    const body = await kisGet("/uapi/domestic-stock/v1/trading/inquire-daily-ccld", "VTTC8001R", {
      CANO: ctx.cano, ACNT_PRDT_CD: ctx.prdt, INQR_STRT_DT: day, INQR_END_DT: day, SLL_BUY_DVSN_CD: "00",
      INQR_DVSN: "00", PDNO: code, CCLD_DVSN: "00", ORD_GNO_BRNO: "", ODNO: "", INQR_DVSN_3: "00", INQR_DVSN_1: "",
      CTX_AREA_FK100: "", CTX_AREA_NK100: "",
    }, `${code} 주문 조회`, ctx);
    if (!body) return null;
    const s = Array.isArray(body.output2) ? body.output2[0] || {} : body.output2 || {};
    const qty = num(s.tot_ord_qty);
    const filled = num(s.tot_ccld_qty);
    if (qty) out.push({ code, qty, filled, remain: Math.max(qty - filled, 0), fillPrice: filled ? num(s.tot_ccld_amt) / filled : 0 });
  }
  return out;
}

async function fetchBalance(ctx) {
  const body = await kisGet("/uapi/domestic-stock/v1/trading/inquire-balance", "VTTC8434R", {
    CANO: ctx.cano, ACNT_PRDT_CD: ctx.prdt, AFHR_FLPR_YN: "N", OFL_YN: "", INQR_DVSN: "02", UNPR_DVSN: "01",
    FUND_STTL_ICLD_YN: "N", FNCG_AMT_AUTO_RDPT_YN: "N", PRCS_DVSN: "00", CTX_AREA_FK100: "", CTX_AREA_NK100: "",
  }, "잔고 조회", ctx);
  if (!body) return null;

  const positions = (body.output1 || [])
    .filter((p) => num(p.hldg_qty) > 0)
    .map((p) => ({
      code: p.pdno,
      name: p.prdt_name,
      shares: num(p.hldg_qty),
      avgPrice: num(p.pchs_avg_pric),
      price: num(p.prpr),
      dayRatio: num(p.fltt_rt),
      cost: num(p.pchs_amt),
      value: num(p.evlu_amt),
      pnl: num(p.evlu_pfls_amt),
      pnlRatio: num(p.evlu_pfls_rt),
    }));
  const s = body.output2?.[0] || {};
  const summary = {
    // 예수금: 오늘 산 주식 대금은 이틀 뒤(D+2)에 빠져나가서 dnca_tot_amt(오늘 예수금)는 매수 전 금액 그대로다.
    // 실제로 남은 현금은 D+2 예수금 (= 총평가 - 주식 평가)
    cash: num(s.prvs_rcdl_excc_amt),
    stockValue: num(s.scts_evlu_amt),
    cost: num(s.pchs_amt_smtl_amt),
    pnl: num(s.evlu_pfls_smtl_amt),
    total: num(s.tot_evlu_amt),
    prevTotal: num(s.bfdy_tot_asst_evlu_amt),
  };
  return { summary, positions };
}

// 잔고 + 오늘 주문. 토큰 만료면 null
// codes: 브라우저가 알려 준 오늘 주문 예정 종목 (팔고 없어진 종목은 잔고에 안 남으므로)
async function fetchAll(ctx, codes) {
  const balance = await fetchBalance(ctx);
  if (!balance) return null;
  await sleep(500);   // 모의투자는 초당 호출 수 제한이 낮다
  const orders = await fetchOrders(ctx);
  if (!orders) return null;
  let byCode = [];
  if (!orders.rows.length && orders.summary.qty) {
    const all = [...new Set([...balance.positions.map((p) => p.code), ...codes])];
    byCode = await fetchOrdersByCode(ctx, all);
    if (!byCode) return null;
  }
  return { fetchedAt: new Date().toISOString(), ...balance, orders: orders.rows, orderSummary: orders.summary, ordersByCode: byCode };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "POST 로만 호출합니다." });
  try {
    const { appKey, appSecret, account, token, codes: rawCodes } = await readBody(req);
    const codes = (Array.isArray(rawCodes) ? rawCodes : []).filter((c) => /^[0-9A-Z]{6}$/.test(c)).slice(0, 20);
    if (typeof appKey !== "string" || typeof appSecret !== "string" || !appKey || !appSecret) {
      return send(res, 400, { error: "앱 키와 앱 시크릿을 입력하세요." });
    }
    // 계좌번호: "12345678-01" 또는 "1234567801" 만 허용.
    // 한투 모의투자는 상품코드(뒤 2자리)를 검사하지 않고 통과시켜서, 주식 계좌 코드 01 인지 여기서 직접 확인한다
    const m = String(account ?? "").trim().match(/^(\d{8})-?(\d{2})$/);
    if (!m) return send(res, 400, { error: "계좌번호는 8자리-2자리 형식으로 입력하세요. (예: 12345678-01)" });
    const [, cano, prdt] = m;
    if (prdt !== "01") {
      return send(res, 400, { error: `상품코드 ${prdt} 는 지원하지 않아요. 모의투자 주식 계좌는 뒤 2자리가 01 이에요.` });
    }

    let t = token?.value && token.expires - Date.now() > 10 * 60_000 ? token : null;
    const ctx = { appKey, appSecret, cano, prdt };
    let result = t && await fetchAll({ ...ctx, token: t }, codes);
    if (!result) {
      t = await getToken(appKey, appSecret);
      result = await fetchAll({ ...ctx, token: t }, codes);
      if (!result) throw new Error("토큰이 거부됐습니다. 잠시 뒤 다시 시도하세요.");
    }
    send(res, 200, { ...result, token: t });
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}
