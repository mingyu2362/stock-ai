// 가벼운 시세 중계: 지수 · 여러 종목 현재가 · 호가 (Vercel 서버리스 함수, 개발 중에는 vite.config.js 가 같은 함수를 씀)
// GET /api/quote?index=1                → { indices: [...코스피·코스닥·코스피200], world: [...나스닥100·나스닥종합·원달러] }
// GET /api/quote?codes=005930,AAPL.O    → { quotes: { 005930: { code, name, price, change, ratio, open, high, low, volume, value } }, fx }
//   (최대 40종목). 나스닥 종목은 로이터 코드(AAPL.O)로 받고 가격은 달러, cur: "USD", fx(원/달러)를 함께 준다
// GET /api/quote?asking=005930          → { asking: { prevClose, sell: [{price, qty, rate}], buy: [...], totalSell, totalBuy } }
// GET /api/quote?spark=005930,KOSPI     → 마지막 거래일 10분봉 (미니 차트)
// GET /api/quote?daily=KOSPI&from=YYYYMMDD → 지수 일봉 종가
// 네이버 증권 공개 주소를 쓴다 (공식 API 아님, 형식이 바뀌면 고쳐야 함). 브라우저에서 직접 부르면 CORS 에 막혀 서버가 대신 받는다.

const HEADERS = { "User-Agent": "Mozilla/5.0" };
const INDICES = ["KOSPI", "KOSDAQ", "KPI200"];
const KR_RE = /^[0-9A-Z]{6}$/;
const US_RE = /^[A-Z0-9-]{1,8}\.[A-Z]{1,2}$/;   // 네이버 해외주식 로이터 코드 (AAPL.O = 나스닥 애플)
const isUS = (c) => US_RE.test(c);

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (cache) res.setHeader("Cache-Control", cache);
  res.end(JSON.stringify(body));
}

const num = (s) => Number(String(s ?? "").replace(/[,+]/g, "")) || 0;

async function getJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`네이버 응답 ${r.status}`);
  return r.json();
}

const toQuote = (d) => ({
  code: d.itemCode || d.reutersCode,
  name: d.stockName,
  price: num(d.closePrice),
  change: num(d.compareToPreviousClosePrice),
  ratio: num(d.fluctuationsRatio),
  open: d.marketStatus === "OPEN",
  openPrice: num(d.openPrice),
  high: num(d.highPrice),
  low: num(d.lowPrice),
  volume: num(d.accumulatedTradingVolume),
  value: d.accumulatedTradingValue || "",
  tradedAt: d.localTradedAt,
});

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const kstNow = () => new Date(Date.now() + 9 * 3600_000);
const chartUrl = (code, interval, from, to) => {
  const kind = INDICES.includes(code) ? "index" : "item";
  return `https://api.stock.naver.com/chart/domestic/${kind}/${code}/${interval}?startDateTime=${from}0000&endDateTime=${to}2359`;
};

// 원/달러 환율 (하나은행 고시, 네이버). 1분 캐시
let fxCache = { at: 0, value: 0 };
async function usdkrw() {
  if (Date.now() - fxCache.at < 60_000 && fxCache.value) return fxCache;
  const d = await getJson("https://api.stock.naver.com/marketindex/exchange/FX_USDKRW");
  const x = d.exchangeInfo || {};
  fxCache = { at: Date.now(), value: num(x.closePrice), change: num(x.fluctuations), ratio: num(x.fluctuationsRatio) };
  return fxCache;
}

async function usQuotes(codes) {
  if (!codes.length) return {};
  const [d, fx] = await Promise.all([
    getJson(`https://polling.finance.naver.com/api/realtime/worldstock/stock/${codes.join(",")}`), usdkrw(),
  ]);
  return Object.fromEntries((d.datas || []).map((x) => [x.reutersCode, { ...toQuote(x), cur: "USD", fx: fx.value }]));
}

// 마지막 거래일 10분봉 종가 (미니 차트용). 주말·휴일이면 직전 거래일
// 해외 종목은 네이버가 분봉을 주지 않아 최근 30거래일 종가
async function spark(code) {
  const end = kstNow();
  if (isUS(code)) {
    const start = new Date(end);
    start.setDate(start.getDate() - 50);
    const rows = await getJson(`https://api.stock.naver.com/chart/foreign/item/${code}/day?startDateTime=${ymd(start)}0000&endDateTime=${ymd(end)}2359`);
    return (Array.isArray(rows) ? rows : []).slice(-30).map((r) => r.closePrice);
  }
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  const rows = await getJson(chartUrl(code, "minute10", ymd(start), ymd(end)));
  if (!Array.isArray(rows) || !rows.length) return [];
  const day = rows[rows.length - 1].localDateTime.slice(0, 8);
  return rows.filter((r) => r.localDateTime.startsWith(day)).map((r) => r.currentPrice);
}

export default async function handler(req, res) {
  const params = new URL(req.url, "http://localhost").searchParams;
  try {
    // GET /api/quote?spark=005930,KOSPI  → { sparks: { 005930: [가격...] } }  (최대 20개, 지수 코드 KOSPI·KOSDAQ·KPI200 가능)
    const sparkList = params.get("spark");
    if (sparkList) {
      const codes = [...new Set(sparkList.split(","))]
        .filter((c) => KR_RE.test(c) || isUS(c) || INDICES.includes(c)).slice(0, 20);
      const out = await Promise.all(codes.map((c) => spark(c).catch(() => [])));
      return send(res, 200, { sparks: Object.fromEntries(codes.map((c, i) => [c, out[i]])) },
        "s-maxage=60, stale-while-revalidate=120");
    }

    // GET /api/quote?daily=KOSPI&from=20261101  → { daily: [{ date: "2026-11-02", close }] }
    const daily = params.get("daily");
    if (daily) {
      const from = params.get("from") || "";
      if (!INDICES.includes(daily) || !/^\d{8}$/.test(from)) return send(res, 400, { error: "daily(지수) 와 from(YYYYMMDD) 이 필요합니다." });
      const rows = await getJson(chartUrl(daily, "day", from, ymd(kstNow())));
      return send(res, 200, {
        daily: (Array.isArray(rows) ? rows : []).map((r) => ({
          date: `${r.localDate.slice(0, 4)}-${r.localDate.slice(4, 6)}-${r.localDate.slice(6, 8)}`, close: r.closePrice,
        })),
      }, "s-maxage=600, stale-while-revalidate=1200");
    }

    if (params.get("index")) {
      const [d, w, fx] = await Promise.all([
        getJson(`https://polling.finance.naver.com/api/realtime/domestic/index/${INDICES.join(",")}`),
        getJson("https://polling.finance.naver.com/api/realtime/worldstock/index/.NDX,.IXIC").catch(() => ({})),
        usdkrw().catch(() => null),
      ]);
      const indices = (d.datas || []).map((x) => ({
        code: x.itemCode, name: x.stockName, price: num(x.closePrice),
        change: num(x.compareToPreviousClosePrice), ratio: num(x.fluctuationsRatio), open: x.marketStatus === "OPEN",
      }));
      const world = (w.datas || []).map((x) => ({
        code: x.reutersCode, name: x.indexName, price: num(x.closePrice),
        change: num(x.compareToPreviousClosePrice), ratio: num(x.fluctuationsRatio), open: x.marketStatus === "OPEN",
      }));
      if (fx?.value) world.push({ code: "USDKRW", name: "원/달러", price: fx.value, change: fx.change, ratio: fx.ratio, open: true });
      return send(res, 200, { indices, world }, "s-maxage=15, stale-while-revalidate=30");
    }

    const asking = params.get("asking");
    if (asking) {
      if (isUS(asking)) return send(res, 400, { error: "해외 종목은 호가를 제공하지 않아요." });
      if (!KR_RE.test(asking)) return send(res, 400, { error: "종목코드(6자리)가 잘못됐습니다." });
      const d = await getJson(`https://m.stock.naver.com/api/stock/${asking}/askingPrice`);
      const row = (r) => ({ price: num(r.price), qty: num(r.count), rate: Number(r.rate) || 0 });
      return send(res, 200, {
        asking: {
          prevClose: num(d.lastClosePrice),
          sell: (d.sellInfo || d.sellInfos || []).map(row),   // 높은 가격부터
          buy: (d.buyInfos || d.buyInfo || []).map(row),       // 높은 가격부터
          totalSell: num(d.totalSell),
          totalBuy: num(d.totalBuy),
        },
      }, "s-maxage=5, stale-while-revalidate=10");
    }

    const codes = [...new Set((params.get("codes") || "").split(","))].filter((c) => KR_RE.test(c) || isUS(c)).slice(0, 40);
    if (!codes.length) return send(res, 400, { error: "codes(6자리 종목코드 또는 AAPL.O 같은 해외 코드, 쉼표로 구분) 또는 index=1 이 필요합니다." });
    const kr = codes.filter((c) => !isUS(c));
    const us = codes.filter(isUS);
    const [d, uq] = await Promise.all([
      kr.length ? getJson(`https://polling.finance.naver.com/api/realtime/domestic/stock/${kr.join(",")}`) : {},
      usQuotes(us),
    ]);
    const quotes = { ...Object.fromEntries((d.datas || []).map((x) => [x.itemCode, toQuote(x)])), ...uq };
    const fx = us.length ? fxCache.value : undefined;
    send(res, 200, { fetchedAt: new Date().toISOString(), quotes, fx }, "s-maxage=10, stale-while-revalidate=20");
  } catch (e) {
    send(res, 502, { error: `시세를 가져오지 못했습니다: ${e.message}` });
  }
}
