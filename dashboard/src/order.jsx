// 종목 화면 오른쪽: 호가창 + 모의투자 주문 (가상 자금, src/paper.js)
import { useEffect, useState } from "react";
import { pct, roundTick, tickSize, usePolling, won } from "./lib.jsx";
import {
  buyCost, maxBuyShares, orderableCash, placeOrder, sellableShares, sellProceeds, startPaper, START_OPTIONS, usePaper,
} from "./paper.js";

// 호가창: 매도 5호가(위, 파랑) / 매수 5호가(아래, 빨강). 가격을 누르면 주문 가격으로
export function OrderBook({ code, price, prevClose, onPick }) {
  const { data, error } = usePolling(`/api/quote?asking=${code}`, 5_000);
  const a = data?.asking;
  const base = prevClose || a?.prevClose;
  const maxQty = Math.max(1, ...(a ? [...a.sell, ...a.buy].map((r) => r.qty) : [1]));
  const row = (r, side) => {
    const ratio = base ? (r.price / base - 1) * 100 : null;
    const d = ratio > 0 ? "up" : ratio < 0 ? "down" : "";
    return (
      <button key={side + r.price} type="button" className={`ob-row ${side} ${r.price === price ? "now" : ""}`}
        onClick={() => onPick(r.price)} title="이 가격으로 지정가 주문">
        <span className="ob-qty sell-qty">{side === "sell" && <><i style={{ width: `${(r.qty / maxQty) * 100}%` }} />{won(r.qty)}</>}</span>
        <span className={`ob-price num ${d}`}>{won(r.price)}<small>{ratio != null ? pct(ratio, { digits: 2 }) : ""}</small></span>
        <span className="ob-qty buy-qty">{side === "buy" && <><i style={{ width: `${(r.qty / maxQty) * 100}%` }} />{won(r.qty)}</>}</span>
      </button>
    );
  };
  return (
    <div className="card orderbook">
      <div className="panel-head"><h2>호가</h2><span className="muted">5초마다 · 가격을 누르면 주문가로</span></div>
      {!a && <div className="empty small">{error ? `호가를 불러오지 못했어요: ${error.message}` : "불러오는 중…"}</div>}
      {a && (
        <>
          <div className="ob">
            {a.sell.map((r) => row(r, "sell"))}
            {a.buy.map((r) => row(r, "buy"))}
          </div>
          <div className="ob-total num">
            <span className="down">매도잔량 {won(a.totalSell)}</span>
            <span className="up">매수잔량 {won(a.totalBuy)}</span>
          </div>
        </>
      )}
    </div>
  );
}

// 1억 2,345만 원 처럼 읽기 쉬운 금액
export function korMoney(v) {
  const man = Math.round(v / 10_000);
  const eokPart = Math.floor(man / 10_000);
  const manPart = man % 10_000;
  if (!man) return `${won(v)}원`;
  return `${eokPart ? `${won(eokPart)}억 ` : ""}${manPart ? `${won(manPart)}만 ` : ""}원`;
}

const MIN_MAN = 1;            // 최소 1만 원
const MAX_MAN = 1_000_000;    // 최대 100억 원

// 시작 금액 입력 (단위: 만 원). 10000 → 1억 원, 100 → 100만 원
export function StartPaperForm({ compact = false }) {
  const [man, setMan] = useState("1000");
  const n = Number(man) || 0;
  const bad = n < MIN_MAN || n > MAX_MAN;
  const submit = (e) => {
    e.preventDefault();
    if (!bad) startPaper(n * 10_000);
  };
  return (
    <form className={`start-form ${compact ? "compact" : ""}`} onSubmit={submit}>
      <label className="money-label" htmlFor="start-man">
        시작 금액 <small>(단위: 만 원)</small>
      </label>
      <div className="money-input">
        <input id="start-man" inputMode="numeric" value={man} autoComplete="off"
          onChange={(e) => setMan(e.target.value.replace(/\D/g, "").replace(/^0+/, "").slice(0, 7))} />
        <span className="unit">만 원</span>
      </div>
      {bad && <div className="money-preview bad">1만 원 ~ 100억 원 사이로 입력하세요 (1 ~ 1,000,000)</div>}
      <div className="chips">
        {START_OPTIONS.map((v) => (
          <button key={v} type="button" className={`chip ${n * 10_000 === v ? "on" : ""}`} onClick={() => setMan(String(v / 10_000))}>
            {korMoney(v)}
          </button>
        ))}
      </div>
      <button className="btn-primary btn-wide" disabled={bad}>모의투자 시작하기</button>
    </form>
  );
}

export function OrderPanel({ code, name, price, picked }) {
  const paper = usePaper();
  const [side, setSide] = useState("buy");
  const [type, setType] = useState("market");
  const [limit, setLimit] = useState("");
  const [qty, setQty] = useState("");
  const [state, setState] = useState({ busy: false, msg: null, error: null, confirm: false });

  // 호가창에서 가격을 고르면 지정가로
  useEffect(() => {
    if (picked?.price) { setType("limit"); setLimit(String(picked.price)); }
  }, [picked]);
  useEffect(() => { setQty(""); setLimit(""); setState({ busy: false, msg: null, error: null, confirm: false }); }, [code]);

  if (!paper) {
    return (
      <div className="card order">
        <h2>모의투자로 주문해 보기</h2>
        <p className="sub">가상 자금으로 실제 시세에 사고팔아요. API 키도, 실제 돈도 필요 없어요.</p>
        <StartPaperForm compact />
      </div>
    );
  }

  const unit = type === "limit" ? Number(limit) || 0 : price || 0;
  const shares = Number(qty) || 0;
  const pos = paper.positions[code];
  const sellable = sellableShares(paper, code);
  const maxBuy = maxBuyShares(paper, unit);
  const cost = side === "buy" ? buyCost(unit, shares) : sellProceeds(unit, shares);
  const limitBad = type === "limit" && unit > 0 && unit % tickSize(unit) !== 0;

  const setPart = (p) => {
    const max = side === "buy" ? maxBuy : sellable;
    setQty(String(Math.max(0, Math.floor(max * p))));
  };
  const step = (dir) => {
    const base = Number(limit) || price || 0;
    setType("limit");
    setLimit(String(roundTick(base + dir * tickSize(base + (dir < 0 ? -1 : 0)))));
  };

  const submit = async () => {
    setState({ busy: true, msg: null, error: null, confirm: false });
    try {
      const r = await placeOrder({ side, code, name, shares, type, limitPrice: limit });
      setState({
        busy: false, error: null, confirm: false,
        msg: r.status === "filled"
          ? `${side === "buy" ? "매수" : "매도"} 체결 · ${won(shares)}주 @ ${won(r.price)}원`
          : `지정가 ${won(r.price)}원 주문 접수 · 가격이 닿으면 체결돼요 (오늘만 유효)`,
      });
      setQty("");
    } catch (e) {
      setState({ busy: false, msg: null, error: e.message, confirm: false });
    }
  };

  return (
    <div className={`card order ${side}`}>
      <div className="order-tabs" role="tablist">
        <button role="tab" aria-selected={side === "buy"} className="buy" onClick={() => setSide("buy")}>매수</button>
        <button role="tab" aria-selected={side === "sell"} className="sell" onClick={() => setSide("sell")}>매도</button>
      </div>

      <div className="seg seg-full" role="group" aria-label="주문 유형">
        <button aria-pressed={type === "market"} onClick={() => setType("market")}>시장가</button>
        <button aria-pressed={type === "limit"} onClick={() => { setType("limit"); if (!limit && price) setLimit(String(price)); }}>지정가</button>
      </div>

      <label className="field">
        <span>가격</span>
        {type === "market" ? (
          <div className="field-box muted">현재가 {won(price)}원으로 바로 체결</div>
        ) : (
          <div className="stepper">
            <button type="button" onClick={() => step(-1)} aria-label="한 호가 내리기">−</button>
            <input inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value.replace(/\D/g, ""))} aria-label="지정 가격" />
            <button type="button" onClick={() => step(1)} aria-label="한 호가 올리기">+</button>
          </div>
        )}
      </label>
      {limitBad && <p className="error-text">호가 단위 {won(tickSize(unit))}원에 맞춰 주세요. (예: {won(roundTick(unit))})</p>}

      <label className="field">
        <span>수량</span>
        <div className="stepper">
          <button type="button" onClick={() => setQty(String(Math.max(0, shares - 1)))} aria-label="1주 줄이기">−</button>
          <input inputMode="numeric" value={qty} placeholder="0" onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} aria-label="주문 수량" />
          <button type="button" onClick={() => setQty(String(shares + 1))} aria-label="1주 늘리기">+</button>
        </div>
      </label>
      <div className="parts">
        {[[0.1, "10%"], [0.25, "25%"], [0.5, "50%"], [1, "최대"]].map(([p, l]) => (
          <button key={l} type="button" onClick={() => setPart(p)}>{l}</button>
        ))}
      </div>

      <dl className="order-sum">
        {side === "buy"
          ? <div><dt>주문가능</dt><dd className="num">{won(orderableCash(paper))}원 · 최대 {won(maxBuy)}주</dd></div>
          : <div><dt>매도가능</dt><dd className="num">{won(sellable)}주</dd></div>}
        {pos && <div><dt>보유 · 평단</dt><dd className="num">{won(pos.shares)}주 · {won(pos.avg)}원</dd></div>}
        <div><dt>주문 금액</dt><dd className="num">{won(cost.amount)}원</dd></div>
        <div><dt>수수료{side === "sell" ? "·세금" : ""}</dt><dd className="num">{won(cost.fee + cost.tax)}원</dd></div>
        <div className="total"><dt>{side === "buy" ? "총 결제" : "받을 금액"}</dt><dd className="num">{won(cost.total)}원</dd></div>
      </dl>

      {state.error && <p className="error-text">{state.error}</p>}
      {state.msg && <p className="ok-text">{state.msg}</p>}

      {state.confirm ? (
        <div className="confirm">
          <p><b>{name}</b> {won(shares)}주를 {type === "market" ? "시장가" : `${won(unit)}원 지정가`}로 {side === "buy" ? "살까요" : "팔까요"}?</p>
          <div className="confirm-btns">
            <button className="icon-btn" onClick={() => setState((s) => ({ ...s, confirm: false }))}>취소</button>
            <button className={`btn-order ${side}`} onClick={submit} disabled={state.busy}>{state.busy ? "주문 중…" : "확인"}</button>
          </div>
        </div>
      ) : (
        <button className={`btn-order ${side}`} disabled={!shares || !unit || limitBad || state.busy}
          onClick={() => setState((s) => ({ ...s, confirm: true, msg: null, error: null }))}>
          {side === "buy" ? "매수" : "매도"} {shares ? `${won(shares)}주` : ""}
        </button>
      )}
      <p className="fine">가상 자금 모의투자예요. 실제 주문이 나가지 않아요. 수수료 0.015%, 매도세 0.20% 반영. <a href="#paper">내 모의투자 →</a></p>
    </div>
  );
}
