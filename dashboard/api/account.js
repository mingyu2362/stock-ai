// 한국투자증권 모의투자 계좌 잔고 (Vercel 서버리스 함수, 개발 중에는 vite.config.js 가 같은 함수를 씀)
// POST /api/account  { appKey, appSecret, account, token? } → { fetchedAt, summary, positions, token }
//
// 사용자 키는 사용자 브라우저에만 있고 요청마다 함께 온다. 서버는 저장·기록하지 않고 한투에 전달만 한다.
// - 잔고 조회만 한다. 주문 기능은 일부러 넣지 않음 (키가 새도 이 서버로는 주문이 나갈 수 없게)
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

async function fetchBalance(appKey, appSecret, cano, prdt, token) {
  const params = new URLSearchParams({
    CANO: cano, ACNT_PRDT_CD: prdt, AFHR_FLPR_YN: "N", OFL_YN: "", INQR_DVSN: "02", UNPR_DVSN: "01",
    FUND_STTL_ICLD_YN: "N", FNCG_AMT_AUTO_RDPT_YN: "N", PRCS_DVSN: "00", CTX_AREA_FK100: "", CTX_AREA_NK100: "",
  });
  let body, r;
  for (let attempt = 0; attempt < 2; attempt++) {
    r = await fetch(`${BASE}/uapi/domestic-stock/v1/trading/inquire-balance?${params}`, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        authorization: `Bearer ${token.value}`, appkey: appKey, appsecret: appSecret, tr_id: "VTTC8434R", custtype: "P",
      },
    });
    body = await r.json();
    if (body.msg_cd !== "EGW00201") break;   // 초당 거래건수 초과 → 1초 뒤 한 번 더
    await sleep(1000);
  }
  if (body.msg_cd === "EGW00123") return null;   // 토큰 만료 → 새로 발급
  if (body.rt_cd !== "0") throw new Error(`잔고 조회 실패: ${body.msg1 || r.status}`);

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
    cash: num(s.dnca_tot_amt),            // 예수금
    stockValue: num(s.scts_evlu_amt),
    cost: num(s.pchs_amt_smtl_amt),
    pnl: num(s.evlu_pfls_smtl_amt),
    total: num(s.tot_evlu_amt),
    prevTotal: num(s.bfdy_tot_asst_evlu_amt),
  };
  return { fetchedAt: new Date().toISOString(), summary, positions };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "POST 로만 호출합니다." });
  try {
    const { appKey, appSecret, account, token } = await readBody(req);
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
    let result = t && await fetchBalance(appKey, appSecret, cano, prdt, t);
    if (!result) {
      t = await getToken(appKey, appSecret);
      result = await fetchBalance(appKey, appSecret, cano, prdt, t);
      if (!result) throw new Error("토큰이 거부됐습니다. 잠시 뒤 다시 시도하세요.");
    }
    send(res, 200, { ...result, token: t });
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}
