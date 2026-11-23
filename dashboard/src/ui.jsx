// 증권앱 느낌을 내는 작은 부품들: 시세 깜빡임, 미니 차트, 종목 이니셜 배지, 알림(토스트)
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { usePolling } from "./lib.jsx";

// ---------- 시세 깜빡임: 값이 바뀌는 순간 빨강(오름)·파랑(내림) 배경이 잠깐 번쩍 ----------
export function Flash({ value, children, className = "" }) {
  const prev = useRef(value);
  const [f, setF] = useState(null);
  useEffect(() => {
    if (prev.current != null && value != null && value !== prev.current) {
      setF({ d: value > prev.current ? "up" : "down", k: Date.now() });
    }
    prev.current = value;
  }, [value]);
  // key 가 바뀌면 span 을 새로 그려 애니메이션을 다시 시작
  return <span key={f?.k ?? 0} className={`${className} ${f ? `flash-${f.d}` : ""}`}>{children}</span>;
}

// ---------- 미니 차트 ----------
// 여러 종목·지수의 마지막 거래일 10분봉 { code: [가격...] }. 1분마다 (장중만)
export function useSparks(codes) {
  const key = [...new Set(codes)].filter(Boolean).sort().join(",");
  return usePolling(key ? `/api/quote?spark=${key}` : null, 60_000).data?.sparks || {};
}

// points: 가격 배열, base: 전일 종가 (점선 기준선, 색 결정)
export function Spark({ points, base, width = 96, height = 32, fill = true }) {
  const id = useId().replace(/:/g, "");
  if (!points || points.length < 2) return <svg className="spark empty" width={width} height={height} aria-hidden="true" />;
  const ref = base ?? points[0];
  const lo = Math.min(...points, ref);
  const hi = Math.max(...points, ref);
  const span = hi - lo || 1;
  const pad = 2;
  // 정규장 6.5시간 = 10분봉 39개. 장중이면 남은 시간은 비워 둔다
  const n = Math.max(points.length, 39);
  const x = (i) => (i / (n - 1)) * width;
  const y = (v) => pad + (1 - (v - lo) / span) * (height - pad * 2);
  const line = points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const last = points[points.length - 1];
  const d = last > ref ? "up" : last < ref ? "down" : "flat";
  return (
    <svg className={`spark ${d}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id={`g${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line x1="0" x2={width} y1={y(ref)} y2={y(ref)} className="spark-base" />
      {fill && <path d={`${line}L${x(points.length - 1).toFixed(1)},${height}L0,${height}Z`} fill={`url(#g${id})`} />}
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(points.length - 1)} cy={y(last)} r="2.2" fill="currentColor" />
    </svg>
  );
}

// ---------- 종목 이니셜 배지 (외부 로고 이미지는 CSP 로 막혀 있어 직접 그림) ----------
const PALETTE = [
  ["#3182f6", "#6b4cf6"], ["#f04452", "#ff8a3d"], ["#12b886", "#2bb3e0"], ["#f59f00", "#f76707"],
  ["#7048e8", "#d6336c"], ["#1098ad", "#3182f6"], ["#e64980", "#ae3ec9"], ["#2f9e44", "#94d82d"],
];
function initials(name = "") {
  const n = name.replace(/^(KODEX|TIGER|KBSTAR|ACE|SOL|HANARO|ARIRANG|PLUS|RISE)\s*/i, "").trim();
  const ascii = n.match(/^[A-Za-z&]+/);
  if (ascii) return ascii[0].slice(0, 2).toUpperCase();
  return n.slice(0, 2) || "?";
}
export function StockAvatar({ code = "", name, size = 24 }) {
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [a, b] = PALETTE[h % PALETTE.length];
  const text = initials(name);
  return (
    <span className="avatar" aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * (text.length > 1 ? 0.38 : 0.5), background: `linear-gradient(135deg, ${a}, ${b})` }}>
      {text}
    </span>
  );
}

// ---------- 알림 (오른쪽 아래 토스트) ----------
let toasts = [];
const listeners = new Set();
const emit = () => listeners.forEach((l) => l());
let seq = 0;

export function notify(text, kind = "info", sub) {
  const id = ++seq;
  toasts = [...toasts, { id, text, kind, sub }].slice(-4);
  emit();
  setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); emit(); }, 5000);
}

export function Toaster() {
  const list = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <i className="toast-icon">{t.kind === "buy" ? "매수" : t.kind === "sell" ? "매도" : t.kind === "error" ? "!" : "i"}</i>
          <div>
            <b>{t.text}</b>
            {t.sub && <span>{t.sub}</span>}
          </div>
          <button aria-label="닫기" onClick={() => { toasts = toasts.filter((x) => x.id !== t.id); emit(); }}>×</button>
        </div>
      ))}
    </div>
  );
}
