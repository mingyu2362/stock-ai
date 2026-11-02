import { useEffect, useMemo, useState } from "react";
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

const MARKET_LABEL = { KOSPI200: "코스피200", KOSDAQ150: "코스닥150", KOSPI: "코스피", KOSDAQ: "코스닥", KONEX: "코넥스" };
const norm = (s) => s.toLowerCase().replace(/\s/g, "");

// 전체 상장 종목(stocks.json)을 이름·코드로 찾는다. 대회 종목이 먼저, 대회 밖 종목은 "대회 매매 불가" 표시.
// 목록에 없는 6자리 코드도 종목 상세로 보낼 수 있다 (신규 상장 등)
function StockSearch({ universe, ranks }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const all = useJson("stocks.json").data;
  const key = norm(q);

  const list = useMemo(() => {
    const m = new Map((all || []).map(([code, name, market]) => [code, { code, name, market }]));
    for (const [code, u] of Object.entries(universe)) m.set(code, { code, ...u });
    return [...m.values()].map((s) => ({ ...s, contest: !!universe[s.code], key: norm(s.name), lc: s.code.toLowerCase() }));
  }, [all, universe]);

  const results = useMemo(() => {
    if (!key) return [];
    const hits = list
      .map((s) => ({
        ...s,
        score: s.lc === key || s.key === key ? 0 : s.key.startsWith(key) || s.lc.startsWith(key) ? 1
          : s.key.includes(key) ? 2 : -1,
      }))
      .filter((r) => r.score >= 0)
      .sort((a, b) => a.score - b.score || b.contest - a.contest
        || (ranks[a.code] ?? 999) - (ranks[b.code] ?? 999) || a.name.length - b.name.length);
    if (/^[0-9a-z]{6}$/.test(key) && !list.some((s) => s.lc === key)) {
      hits.unshift({ code: key.toUpperCase(), name: `${key.toUpperCase()} 종목 보기`, outside: true });
    }
    return hits.slice(0, 10);
  }, [key, list, ranks]);

  const go = (r) => {
    if (!r) return;
    window.location.hash = `stock/${r.code}`;
    setQ(""); setOpen(false);
  };
  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); go(results[active]); }
    else if (e.key === "Escape") setOpen(false);
  };

  return (
    <div className="search" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <input type="search" placeholder="종목 이름 또는 코드 검색" value={q} aria-label="종목 검색"
        role="combobox" aria-expanded={open && results.length > 0} aria-controls="stock-search-list"
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)} onKeyDown={onKey} />
      {open && key && (
        <ul className="search-list" id="stock-search-list" role="listbox">
          {results.length === 0 && <li className="muted search-none">찾는 종목이 없어요. 6자리 종목코드로 찾아보세요.</li>}
          {results.map((r, i) => (
            <li key={r.code} role="option" aria-selected={i === active}>
              <button type="button" className={i === active ? "on" : ""} onMouseEnter={() => setActive(i)} onClick={() => go(r)}>
                <span className="search-name">{r.name}</span>
                {!r.outside && <span className="muted">{r.code} · {MARKET_LABEL[r.market] || r.market}</span>}
                {r.contest
                  ? ranks[r.code] && <span className="search-rank">AI {ranks[r.code]}위</span>
                  : <span className="badge blocked search-rank">대회 매매 불가</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Live() {
  const [type, setType] = useState("searchTop");
  const [market, setMarket] = useState("KOSPI");
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const universe = useJson("universe.json").data || {};
  const ranks = useJson("today.json").data?.ranks || {};

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
      <StockSearch universe={universe} ranks={ranks} />
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
