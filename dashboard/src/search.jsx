import { useMemo, useState } from "react";
import { useJson } from "./lib.jsx";

const MARKET_LABEL = { KOSPI200: "코스피200", KOSDAQ150: "코스닥150", KOSPI: "코스피", KOSDAQ: "코스닥", KONEX: "코넥스" };
const norm = (s) => s.toLowerCase().replace(/\s/g, "");

// 전체 상장 종목(stocks.json)을 이름·코드로 찾는다. AI 분석 종목(코스피200·코스닥150)이 먼저.
// 목록에 없는 6자리 코드도 종목 상세로 보낼 수 있다 (신규 상장 등)
export default function StockSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const all = useJson("stocks.json").data;
  const universe = useJson("universe.json").data;
  const ranks = useJson("today.json").data?.ranks;
  const key = norm(q);

  const list = useMemo(() => {
    const u = universe || {};
    const m = new Map((all || []).map(([code, name, market]) => [code, { code, name, market }]));
    for (const [code, x] of Object.entries(u)) m.set(code, { code, ...x });
    return [...m.values()].map((s) => ({ ...s, ai: !!u[s.code], key: norm(s.name), lc: s.code.toLowerCase() }));
  }, [all, universe]);

  const results = useMemo(() => {
    if (!key) return [];
    const r = ranks || {};
    const hits = list
      .map((s) => ({
        ...s,
        score: s.lc === key || s.key === key ? 0 : s.key.startsWith(key) || s.lc.startsWith(key) ? 1
          : s.key.includes(key) ? 2 : -1,
      }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => a.score - b.score || b.ai - a.ai
        || (r[a.code] ?? 999) - (r[b.code] ?? 999) || a.name.length - b.name.length);
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
    else if (e.key === "Escape") { setOpen(false); e.currentTarget.blur(); }
  };

  return (
    <div className="search" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <svg className="search-icon" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M13 13l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input type="search" placeholder="종목명 또는 코드 검색" value={q} aria-label="종목 검색"
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
                {r.ai && ranks?.[r.code] && <span className="search-rank">AI {ranks[r.code]}위</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
