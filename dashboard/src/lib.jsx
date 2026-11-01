import { useEffect, useState } from "react";

// public/data 의 JSON (dashboard/export.py 가 만든 파일)
export function useJson(name) {
  const [state, setState] = useState({ data: null, error: null });
  useEffect(() => {
    let alive = true;
    fetch(`/data/${name}`, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${name} ${r.status}`))))
      .then((data) => alive && setState({ data, error: null }))
      .catch((error) => alive && setState({ data: null, error }));
    return () => { alive = false; };
  }, [name]);
  return state;
}

export const won = (v) => (v == null ? "–" : Math.round(v).toLocaleString("ko-KR"));

export function eok(v) {
  if (v == null) return "–";
  if (v === 0) return "0";
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(1)}억`;
  return `${Math.round(v / 1e4).toLocaleString("ko-KR")}만`;
}

// 비율(0.0123) 또는 퍼센트(1.23)를 부호 붙여 표시
export function pct(v, { ratio = false, digits = 1 } = {}) {
  if (v == null) return "–";
  const p = ratio ? v * 100 : v;
  return `${p > 0 ? "+" : ""}${p.toFixed(digits)}%`;
}

export const dir = (v) => (v == null || v === 0 ? "" : v > 0 ? "up" : "down");

export function Pct({ v, ratio, digits }) {
  return <span className={`num ${dir(v)}`}>{pct(v, { ratio, digits })}</span>;
}

export function Tile({ label, value, note, className = "" }) {
  return (
    <div className="card tile">
      <div className="label">{label}</div>
      <div className={`value ${className}`}>{value}</div>
      {note && <div className="note">{note}</div>}
    </div>
  );
}

export function Loading({ state, children }) {
  if (state.error) {
    return <div className="card empty"><strong>데이터를 불러오지 못했어요</strong>{String(state.error.message)}</div>;
  }
  if (!state.data) return <div className="card empty">불러오는 중…</div>;
  return children(state.data);
}

export const marketLabel = (m) => (m?.startsWith("KOSDAQ") ? "코스닥" : "코스피");

// 한국 시간 평일 09:00~15:30
export function marketOpen() {
  const kst = new Date(Date.now() + (9 * 60 + new Date().getTimezoneOffset()) * 60_000);
  const hm = kst.getHours() * 100 + kst.getMinutes();
  return kst.getDay() >= 1 && kst.getDay() <= 5 && hm >= 900 && hm <= 1530;
}

// 종목 이름 → 종목 상세 화면 (#stock/코드)
export function StockLink({ code, name }) {
  return <a className="stock-link" href={`#stock/${code}`}>{name ?? code}</a>;
}
