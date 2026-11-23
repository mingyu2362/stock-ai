import { useEffect, useState } from "react";
import { StockAvatar } from "./ui.jsx";   // 서로 import 하지만 렌더할 때만 쓰므로 문제 없음

// public/data 의 JSON (dashboard/export.py 가 만든 파일)
// 하루에 한 번 바뀌는 파일이라 한 번 연 페이지 안에서는 같은 요청을 나눠 쓴다 (헤더·사이드바·본문이 같은 파일을 읽음)
const jsonCache = new Map();
function loadJson(name) {
  if (!jsonCache.has(name)) {
    const p = fetch(`/data/${name}`, { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${name} ${r.status}`))));
    p.catch(() => jsonCache.delete(name));   // 실패하면 다음에 다시 시도
    jsonCache.set(name, p);
  }
  return jsonCache.get(name);
}

export function useJson(name) {
  const [state, setState] = useState({ data: null, error: null });
  useEffect(() => {
    let alive = true;
    loadJson(name)
      .then((data) => alive && setState({ data, error: null }))
      .catch((error) => alive && setState({ data: null, error }));
    return () => { alive = false; };
  }, [name]);
  return state;
}

// /api/* 를 부르고 실패하면 서버가 준 오류 문구로 던진다
export async function api(url, init) {
  const r = await fetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `요청 실패 (${r.status})`);
  return body;
}

// 주기적으로 다시 불러오는 데이터. 장이 열려 있을 때만 refreshMs 마다 갱신 (always 면 항상)
export function usePolling(url, refreshMs, { always = false } = {}) {
  const [state, setState] = useState({ data: null, error: null, url: null });
  useEffect(() => {
    if (!url) return undefined;
    let alive = true;
    const load = () => api(url)
      .then((data) => alive && setState({ data, error: null, url }))
      .catch((error) => alive && setState((s) => ({ ...s, error })));
    load();
    const timer = setInterval(() => (always || marketOpen()) && load(), refreshMs);
    return () => { alive = false; clearInterval(timer); };
  }, [url, refreshMs, always]);
  return state.url === url ? state : { data: null, error: state.error, url };
}

// 여러 종목 현재가 { code: {price, change, ratio, ...} }
export function useQuotes(codes, refreshMs = 15_000) {
  const key = [...new Set(codes)].filter(Boolean).sort().join(",");
  return usePolling(key ? `/api/quote?codes=${key}` : null, refreshMs).data?.quotes || {};
}

// 한국거래소 호가 단위 (2023년 이후 코스피·코스닥 공통, trade/kis_api.py 와 같음)
export function tickSize(price) {
  for (const [limit, tick] of [[2_000, 1], [5_000, 5], [20_000, 10], [50_000, 50], [200_000, 100], [500_000, 500]]) {
    if (price < limit) return tick;
  }
  return 1_000;
}
export const roundTick = (price) => Math.round(price / tickSize(price)) * tickSize(price);

// 한국 날짜 YYYY-MM-DD
export const kstDate = (t = Date.now()) => new Date(t + 9 * 3600_000).toISOString().slice(0, 10);

// 장 상태 문구 (평일 08:30~09:00 동시호가, 09:00~15:30 정규장)
export function marketPhase() {
  const kst = new Date(Date.now() + (9 * 60 + new Date().getTimezoneOffset()) * 60_000);
  const hm = kst.getHours() * 100 + kst.getMinutes();
  const weekday = kst.getDay() >= 1 && kst.getDay() <= 5;
  if (!weekday) return { key: "closed", label: "휴장" };
  if (hm >= 830 && hm < 900) return { key: "pre", label: "장 시작 전 동시호가" };
  if (hm >= 900 && hm <= 1530) return { key: "open", label: "정규장" };
  return { key: "closed", label: hm < 830 ? "장 시작 전" : "장 마감" };
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
export const signed = (v) => `${v > 0 ? "+" : ""}${won(v)}`;

// 증권앱식 전일 대비: ▲ 2,500  +1.37%
export function Change({ change, ratio, digits = 2, arrowOnly = false }) {
  const d = dir(change ?? ratio);
  return (
    <span className={`num ${d}`}>
      {d === "up" ? "▲" : d === "down" ? "▼" : ""}{change != null && !arrowOnly ? ` ${won(Math.abs(change))}` : ""}
      {ratio != null && <span className="chg-ratio"> {pct(ratio, { digits })}</span>}
    </span>
  );
}

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

// 종목 이름 → 종목 상세 화면 (#stock/코드). 앞에 종목 이니셜 배지
export function StockLink({ code, name, avatar = true }) {
  return (
    <a className="stock-link" href={`#stock/${code}`}>
      {avatar && <StockAvatar code={code} name={name ?? code} size={22} />}
      <span>{name ?? code}</span>
    </a>
  );
}
