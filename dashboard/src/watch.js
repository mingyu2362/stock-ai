// 관심종목 (이 브라우저 localStorage 에만 저장). [{ code, name }]
import { useSyncExternalStore } from "react";
import { isStockCode } from "./lib.jsx";

const KEY = "watchlist-v1";
const MAX = 30;

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (Array.isArray(v)) return v.filter((x) => isStockCode(x?.code));
  } catch { /* 저장소를 못 쓰는 환경 */ }
  return [];
}

let list = read();
const listeners = new Set();

function commit(next) {
  list = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 이 탭에서만 유지 */ }
  listeners.forEach((l) => l());
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) { list = read(); listeners.forEach((l) => l()); }
  });
}

const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
export const useWatch = () => useSyncExternalStore(subscribe, () => list);
export const isWatched = (code) => list.some((x) => x.code === code);

export function toggleWatch(code, name) {
  if (isWatched(code)) commit(list.filter((x) => x.code !== code));
  else commit([{ code, name: name || code }, ...list].slice(0, MAX));
}
