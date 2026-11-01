import { useEffect, useState } from "react";
import { marketOpen, Pct, StockLink, useJson, won } from "../lib.jsx";

const TYPES = [
  { key: "searchTop", label: "검색 상위" },
  { key: "up", label: "상승률 상위" },
  { key: "down", label: "하락률 상위" },
];
const MARKETS = [
  { key: "KOSPI", label: "코스피" },
  { key: "KOSDAQ", label: "코스닥" },
];
const REFRESH_MS = 30_000;

export default function Live() {
  const [type, setType] = useState("searchTop");
  const [market, setMarket] = useState("KOSPI");
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const universe = useJson("universe.json").data || {};

  useEffect(() => {
    let alive = true;
    const load = () => {
      setState((s) => ({ ...s, loading: true }));
      fetch(`/api/naver?type=${type}&market=${market}&size=30`)
        .then(async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body.error || r.status);
          return body;
        })
        .then((data) => alive && setState({ data, error: null, loading: false }))
        .catch((error) => alive && setState((s) => ({ ...s, error, loading: false })));
    };
    load();
    const timer = setInterval(() => marketOpen() && load(), REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [type, market]);

  const d = state.data;
  const time = d?.stocks?.[0]?.time?.slice(11, 16);
  return (
    <>
      <div className="filters">
        <div className="seg" role="group" aria-label="순위 종류">
          {TYPES.map((t) => (
            <button key={t.key} aria-pressed={type === t.key} onClick={() => setType(t.key)}>{t.label}</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="시장">
          {MARKETS.map((m) => (
            <button key={m.key} aria-pressed={market === m.key} onClick={() => setMarket(m.key)}>{m.label}</button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          {marketOpen() ? `장중 · 30초마다 갱신${time ? ` · ${time} 기준` : ""}` : `장 마감${time ? ` · ${time} 기준` : ""}`}
        </span>
      </div>

      <div className="card" style={{ opacity: state.loading && d ? 0.6 : 1 }}>
        <h2>{MARKETS.find((m) => m.key === market).label} {TYPES.find((t) => t.key === type).label}</h2>
        <p className="sub">
          출처: 네이버 증권 (지연될 수 있음). <span className="badge contest">대회</span> 표시는 대회 거래 가능 종목(코스피200·코스닥150)이에요.
        </p>
        {state.error && !d && <div className="empty"><strong>순위를 불러오지 못했어요</strong>{String(state.error.message)}</div>}
        {!d && !state.error && <div className="empty">불러오는 중…</div>}
        {d && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>순위</th><th className="l">종목</th><th>현재가</th><th>전일 대비</th><th>등락률</th><th>거래대금</th></tr>
              </thead>
              <tbody>
                {d.stocks.map((s) => (
                  <tr key={s.code}>
                    <td className="num">{s.rank}</td>
                    <td className="l"><StockLink code={s.code} name={s.name} />{universe[s.code] && <span className="badge contest">대회</span>}</td>
                    <td className="num">{won(s.price)}</td>
                    <td className={`num ${s.change > 0 ? "up" : s.change < 0 ? "down" : ""}`}>
                      {s.change > 0 ? "▲" : s.change < 0 ? "▼" : ""} {won(Math.abs(s.change))}
                    </td>
                    <td><Pct v={s.ratio} digits={2} /></td>
                    <td className="num">{s.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
