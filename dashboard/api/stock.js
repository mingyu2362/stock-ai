// 종목 상세: 네이버 증권 시세·종목 정보·투자자 동향 중계 (Vercel 서버리스 함수, 개발 중에는 vite.config.js 가 같은 함수를 씀)
// GET /api/stock?code=005930&interval=day|week|month
// 공식 API가 아니라 응답 형식이 바뀌면 고쳐야 한다.

const INTERVALS = { day: 3, week: 10, month: 20 };   // 받아 올 기간 (년)
const HEADERS = { "User-Agent": "Mozilla/5.0" };

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (cache) res.setHeader("Cache-Control", cache);
  res.end(JSON.stringify(body));
}

const num = (s) => Number(String(s ?? "").replace(/[,+]/g, ""));
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");

async function getJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`네이버 응답 ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  const params = new URL(req.url, "http://localhost").searchParams;
  const code = params.get("code") || "";
  const interval = params.get("interval") || "day";
  if (!/^[0-9A-Z]{6}$/.test(code) || !(interval in INTERVALS)) {
    return send(res, 400, { error: "code(6자리) 또는 interval 값이 잘못됐습니다." });
  }

  const end = new Date(Date.now() + 9 * 3600_000);   // 한국 날짜
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - INTERVALS[interval]);

  try {
    const [basic, integ, chart] = await Promise.all([
      getJson(`https://m.stock.naver.com/api/stock/${code}/basic`),
      getJson(`https://m.stock.naver.com/api/stock/${code}/integration`),
      getJson(`https://api.stock.naver.com/chart/domestic/item/${code}/${interval}`
        + `?startDateTime=${ymd(start)}0000&endDateTime=${ymd(end)}2359`),
    ]);
    const candles = (Array.isArray(chart) ? chart : [])
      .filter((c) => c.openPrice > 0)   // 거래정지 등으로 시가가 0인 날 제외
      .map((c) => ({
        time: `${c.localDate.slice(0, 4)}-${c.localDate.slice(4, 6)}-${c.localDate.slice(6, 8)}`,
        open: c.openPrice, high: c.highPrice, low: c.lowPrice, close: c.closePrice,
        volume: c.accumulatedTradingVolume,
      }));
    send(res, 200, {
      code,
      name: basic.stockName,
      market: basic.stockExchangeType?.nameKor,
      price: num(basic.closePrice),
      change: num(basic.compareToPreviousClosePrice),
      ratio: num(basic.fluctuationsRatio),
      open: basic.marketStatus === "OPEN",
      tradedAt: basic.localTradedAt,
      infos: (integ.totalInfos || []).map((i) => ({ key: i.key, value: i.value, desc: i.valueDesc })),
      deals: (integ.dealTrendInfos || []).map((d) => ({
        date: `${d.bizdate.slice(4, 6)}.${d.bizdate.slice(6, 8)}`,
        foreign: num(d.foreignerPureBuyQuant),
        organ: num(d.organPureBuyQuant),
        individual: num(d.individualPureBuyQuant),
        close: num(d.closePrice),
        ratio: num(d.closePrice) / (num(d.closePrice) - num(d.compareToPreviousClosePrice)) * 100 - 100,
      })),
      interval,
      candles,
    }, "s-maxage=30, stale-while-revalidate=60");
  } catch (e) {
    send(res, 502, { error: `종목 정보를 가져오지 못했습니다: ${e.message}` });
  }
}
