// 가상 자금 모의투자 (API 키 없이 누구나). 모든 기록은 이 브라우저 localStorage 에만 저장된다.
//
// 체결 규칙 (연습용으로 단순화)
// - 시장가: 주문 순간 네이버 현재가로 바로 체결. 장 마감 뒤에는 마지막 가격(종가)으로 체결
// - 지정가: 매수는 현재가 ≤ 지정가, 매도는 현재가 ≥ 지정가가 되면 지정가로 체결. 그 전까지 미체결로 남고
//   이 화면이 열려 있는 동안 시세를 다시 받아 확인한다. 실제처럼 당일에만 유효 (다음 날 자동 취소)
// - 미체결 매수 금액·매도 수량은 묶어 두어 같은 돈·주식으로 두 번 주문하지 못하게 한다
// - 비용: 수수료 매수·매도 각 0.015%, 매도 시 거래세 0.20% (실제 증권사·연도별로 다름)
// - 호가 잔량·체결 순서는 따지지 않는다 (내 주문이 시장 가격을 움직이지 않는다고 가정)
import { useSyncExternalStore } from "react";
import { api, kstDate, roundTick, tickSize } from "./lib.jsx";
import { notify } from "./ui.jsx";

export const FEE = 0.00015;
export const TAX = 0.002;
export const START_OPTIONS = [5_000_000, 10_000_000, 30_000_000, 100_000_000];
const KEY = "paper-v1";

const fresh = (startCash = 10_000_000) => ({
  startCash, cash: startCash, positions: {}, orders: [], trades: [], createdAt: new Date().toISOString(), seq: 1,
  history: [{ date: kstDate(), total: startCash }],   // 날짜별 총자산 (나 vs AI vs 코스피 그래프)
});

// 오늘 총자산을 기록 (하루 한 줄, 같은 날이면 덮어씀). 시세를 받은 뒤 화면에서 부른다
export function recordValue(total) {
  const s = state;
  if (!s || !(total > 0)) return;
  const today = kstDate();
  const hist = s.history || [];
  const last = hist[hist.length - 1];
  if (last?.date === today && Math.round(last.total) === Math.round(total)) return;
  const next = last?.date === today ? [...hist.slice(0, -1), { date: today, total }] : [...hist, { date: today, total }];
  commit({ ...s, history: next.slice(-400) });
}

const fillText = (side, name, shares, price) =>
  `${name} ${shares.toLocaleString("ko-KR")}주 ${side === "buy" ? "매수" : "매도"} 체결`;
const fillSub = (price, type) => `${type === "limit" ? "지정가" : "시장가"} ${Math.round(price).toLocaleString("ko-KR")}원`;

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    if (v && typeof v.cash === "number") return v;
  } catch { /* 저장소를 못 쓰는 환경 */ }
  return null;
}

let state = read();
const listeners = new Set();

function commit(next) {
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 저장 못 해도 이 탭에서는 동작 */ }
  listeners.forEach((l) => l());
}

// 다른 탭에서 바꾸면 따라간다
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) { state = read(); listeners.forEach((l) => l()); }
  });
}

const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
export const usePaper = () => useSyncExternalStore(subscribe, () => state);

export function startPaper(startCash) { commit(fresh(startCash)); }
export function resetPaper() {
  try { localStorage.removeItem(KEY); } catch { /* 무시 */ }
  state = null;
  listeners.forEach((l) => l());
}

// ---------- 계산 ----------

export const buyCost = (price, shares) => {
  const amount = price * shares;
  return { amount, fee: Math.floor(amount * FEE), tax: 0, total: amount + Math.floor(amount * FEE) };
};
export const sellProceeds = (price, shares) => {
  const amount = price * shares;
  const fee = Math.floor(amount * FEE);
  const tax = Math.floor(amount * TAX);
  return { amount, fee, tax, total: amount - fee - tax };
};

// 미체결 주문이 묶어 둔 현금·주식
export function reserved(s, code) {
  let cash = 0, shares = 0;
  for (const o of s?.orders || []) {
    if (o.side === "buy") cash += buyCost(o.price, o.shares).total;
    else if (o.code === code) shares += o.shares;
  }
  return { cash, shares };
}
export const orderableCash = (s) => (s ? s.cash - reserved(s).cash : 0);
export const sellableShares = (s, code) => (s?.positions[code]?.shares || 0) - reserved(s, code).shares;

// 최대 매수 가능 수량 (수수료 포함)
export const maxBuyShares = (s, price) => (price > 0 ? Math.max(0, Math.floor(orderableCash(s) / (price * (1 + FEE)))) : 0);

// 총자산 = 현금 + 보유 주식 평가 (quotes 에 없는 종목은 평단가로)
export function valuation(s, quotes = {}) {
  if (!s) return null;
  let stock = 0, cost = 0;
  const rows = Object.entries(s.positions).map(([code, p]) => {
    const price = quotes[code]?.price || p.lastPrice || p.avg;
    const value = price * p.shares;
    stock += value;
    cost += p.avg * p.shares;
    return { code, ...p, price, value, pnl: value - p.avg * p.shares, ratio: (price / p.avg - 1) * 100, quote: quotes[code] };
  });
  const total = s.cash + stock;
  const realized = s.trades.reduce((a, t) => a + (t.pnl || 0), 0);
  return {
    rows: rows.sort((a, b) => b.value - a.value),
    stock, cost, total, cash: s.cash,
    pnl: stock - cost,
    totalPnl: total - s.startCash,
    totalRatio: (total / s.startCash - 1) * 100,
    realized,
    orderable: orderableCash(s),
  };
}

// ---------- 주문 ----------

class PaperError extends Error {}

function check(s, { side, code, shares, price }) {
  if (!s) throw new PaperError("먼저 모의투자 계좌를 만들어 주세요.");
  if (!Number.isInteger(shares) || shares <= 0) throw new PaperError("수량은 1주 이상 정수로 입력하세요.");
  if (!(price > 0)) throw new PaperError("가격을 확인하세요.");
  if (side === "buy" && buyCost(price, shares).total > orderableCash(s)) {
    throw new PaperError(`주문가능금액이 부족해요. (최대 ${maxBuyShares(s, price).toLocaleString("ko-KR")}주)`);
  }
  if (side === "sell" && shares > sellableShares(s, code)) {
    throw new PaperError(`매도 가능 수량은 ${sellableShares(s, code).toLocaleString("ko-KR")}주예요.`);
  }
}

// 체결: 현금·보유 수량을 바꾸고 거래 기록을 남긴다 (s 를 복사해 돌려줌)
function fill(s, { side, code, name, shares, price, type, orderId }) {
  const next = { ...s, positions: { ...s.positions }, trades: [...s.trades] };
  const p = next.positions[code];
  let pnl = null, cost;
  if (side === "buy") {
    cost = buyCost(price, shares);
    next.cash -= cost.total;
    const held = p?.shares || 0;
    // 평단가는 증권사 앱처럼 수수료를 빼고 계산
    next.positions[code] = {
      name, shares: held + shares, avg: ((p?.avg || 0) * held + price * shares) / (held + shares), lastPrice: price,
    };
  } else {
    cost = sellProceeds(price, shares);
    next.cash += cost.total;
    pnl = (price - p.avg) * shares - cost.fee - cost.tax - Math.floor(p.avg * shares * FEE);   // 매수 수수료도 반영한 실현손익
    const left = p.shares - shares;
    if (left > 0) next.positions[code] = { ...p, shares: left, lastPrice: price };
    else delete next.positions[code];
  }
  next.trades.unshift({
    id: orderId ?? next.seq, at: new Date().toISOString(), side, code, name, shares, price, type,
    fee: cost.fee, tax: cost.tax, pnl,
  });
  next.trades = next.trades.slice(0, 500);
  return next;
}

// 주문을 낸다. 가격은 화면 값을 믿지 않고 이 순간 시세를 다시 받는다.
// type: "market" | "limit".  → { status: "filled" | "pending", price }
export async function placeOrder({ side, code, name, shares, type, limitPrice }) {
  const q = (await api(`/api/quote?codes=${code}`)).quotes?.[code];
  if (!q?.price) throw new PaperError("현재가를 받지 못했어요. 잠시 뒤 다시 시도하세요.");
  const prevClose = q.price - q.change;
  let price = q.price;
  if (type === "limit") {
    price = Number(limitPrice);
    if (price % tickSize(price) !== 0) throw new PaperError(`호가 단위는 ${tickSize(price).toLocaleString("ko-KR")}원이에요. (예: ${roundTick(price).toLocaleString("ko-KR")}원)`);
    if (prevClose > 0 && (price > prevClose * 1.3 || price < prevClose * 0.7)) {
      throw new PaperError("지정가는 전일 종가의 ±30% (상·하한가) 안에서만 낼 수 있어요.");
    }
  }
  const s = state;
  check(s, { side, code, shares, price });
  const order = { side, code, name: name || q.name, shares, type };
  const marketable = type === "market" || (side === "buy" ? q.price <= price : q.price >= price);
  const id = s.seq;
  if (marketable) {
    commit({ ...fill(s, { ...order, price, orderId: id }), seq: id + 1 });
    notify(fillText(side, order.name, shares), side, fillSub(price, type));
    return { status: "filled", price };
  }
  commit({ ...s, seq: id + 1, orders: [...s.orders, { ...order, id, price, at: new Date().toISOString(), date: kstDate() }] });
  notify(`${order.name} 지정가 ${side === "buy" ? "매수" : "매도"} 접수`, "info", `${Math.round(price).toLocaleString("ko-KR")}원에 닿으면 체결 · 오늘만 유효`);
  return { status: "pending", price };
}

export function cancelOrder(id) {
  if (!state) return;
  commit({ ...state, orders: state.orders.filter((o) => o.id !== id) });
}

// 미체결 지정가를 지금 시세로 확인해 체결. 지난 날 주문은 취소 (당일 유효)
export function matchOrders(quotes) {
  const s = state;
  if (!s?.orders.length) return;
  const today = kstDate();
  const live = s.orders.filter((o) => o.date === today);
  let next = { ...s, orders: [] };
  let changed = live.length !== s.orders.length;
  live.forEach((o, i) => {
    const q = quotes[o.code];
    const hit = q?.price && (o.side === "buy" ? q.price <= o.price : q.price >= o.price);
    if (hit) {
      try {
        // 체결 직전에 다시 확인 (그 사이 다른 체결로 현금·수량이 바뀌었을 수 있음).
        // 이 주문 자신이 묶어 둔 몫은 빼고, 나머지 미체결 주문이 묶어 둔 몫은 넣고 본다
        check({ ...next, orders: [...next.orders, ...live.slice(i + 1)] }, o);
        next = fill(next, { ...o, orderId: o.id });
        changed = true;
        notify(fillText(o.side, o.name, o.shares), o.side, fillSub(o.price, "limit"));
        return;
      } catch { /* 조건이 안 맞으면 그대로 미체결 */ }
    }
    next.orders.push(o);
  });
  if (changed) commit(next);
}

export { PaperError };
