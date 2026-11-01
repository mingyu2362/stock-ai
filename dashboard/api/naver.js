// 네이버 증권 실시간 순위 중계 (Vercel 서버리스 함수, 개발 중에는 vite.config.js 가 같은 함수를 씀)
// GET /api/naver?type=searchTop|up|down&market=KOSPI|KOSDAQ&size=20
// 공식 API가 아니라 응답 형식이 바뀌면 고쳐야 한다. 브라우저에서 직접 부르면 CORS에 막혀 서버가 대신 받는다.

const TYPES = new Set(["searchTop", "up", "down"]);
const MARKETS = new Set(["KOSPI", "KOSDAQ"]);

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (cache) res.setHeader("Cache-Control", cache);
  res.end(JSON.stringify(body));
}

const num = (s) => Number(String(s ?? "").replace(/,/g, ""));

export default async function handler(req, res) {
  const params = new URL(req.url, "http://localhost").searchParams;
  const type = params.get("type") || "searchTop";
  const market = params.get("market") || "KOSPI";
  const size = Math.min(Math.max(Number(params.get("size")) || 20, 1), 50);
  if (!TYPES.has(type) || !MARKETS.has(market)) {
    return send(res, 400, { error: "type 또는 market 값이 잘못됐습니다." });
  }

  try {
    const url = `https://m.stock.naver.com/api/stocks/${type}/${market}?page=1&pageSize=${size}`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error(`네이버 응답 ${r.status}`);
    const data = await r.json();
    const stocks = (data.stocks || []).map((s, i) => ({
      rank: i + 1,
      code: s.itemCode,
      name: s.stockName,
      price: num(s.closePrice),
      change: num(s.compareToPreviousClosePrice),
      ratio: num(s.fluctuationsRatio),
      value: s.accumulatedTradingValueKrwHangeul,
      time: s.localTradedAt,
    }));
    send(res, 200, { type, market, fetchedAt: new Date().toISOString(), stocks },
      "s-maxage=30, stale-while-revalidate=60");
  } catch (e) {
    send(res, 502, { error: `순위를 가져오지 못했습니다: ${e.message}` });
  }
}
