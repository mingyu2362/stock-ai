import { useCallback, useEffect, useState } from "react";
import { Pct, StockLink, won } from "./lib.jsx";

// 투자 성향 (안정형 / 공격형). 저장소의 data/strategy/*.json 을 /api/mode 로 읽고 바꾼다
const LABEL = { stable: "안정형", aggressive: "공격형" };
const DESC = {
  stable: "AI 1~3위를 1/3씩 보유하고, 보유 종목이 12위 밖으로 밀리면 다음 날 아침에 팔아요.",
  aggressive: "1종목에 전액. 순위와 상관없이 손절선 아래로 내려가면 장중에 바로 팔고, 다음 날 아침 AI 1위를 사요.",
};

export function useMode() {
  const [state, setState] = useState({ data: null, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch("/api/mode")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || r.status);
        return body;
      })
      .then((data) => alive && setState({ data, error: null }))
      .catch((error) => alive && setState((s) => ({ ...s, error })));
    return () => { alive = false; };
  }, [tick]);
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) };
}

// 매매 프로그램(trade/aggressive.py)과 같은 계산: 지금 가격까지 넣은 고점으로 손절선을 다시 센다
export function liveStop(pos, rules, price) {
  const peak = Math.max(pos.peak, price || 0);
  if (peak >= pos.entry * (1 + rules.breakeven_at)) {
    return { stop: peak * (1 - rules.trail), peak, why: `추적 익절 (고점 -${rules.trail * 100}%)` };
  }
  return { stop: pos.entry * (1 - rules.stop_loss), peak, why: `손절 (매수가 -${rules.stop_loss * 100}%)` };
}

function SwitchForm({ target, onDone, onCancel }) {
  const [password, setPassword] = useState("");
  const [state, setState] = useState({ busy: false, error: null });
  const submit = (e) => {
    e.preventDefault();
    setState({ busy: true, error: null });
    fetch("/api/mode", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: target, password }),
    })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || r.status);
        onDone();
      })
      .catch((error) => setState({ busy: false, error }));
  };
  return (
    <form className="form" onSubmit={submit} autoComplete="off" style={{ marginTop: 12 }}>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        <b>{LABEL[target]}</b>으로 바꿔요. {DESC[target]}
      </p>
      <label>팀 비밀번호
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
      </label>
      {state.error && <p className="error-text">{String(state.error.message)}</p>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn-primary" disabled={state.busy}>{state.busy ? "바꾸는 중…" : `${LABEL[target]}으로 바꾸기`}</button>
        <button type="button" className="icon-btn" onClick={onCancel}>취소</button>
      </div>
    </form>
  );
}

function AggressiveDetail({ s, positions }) {
  const pos = s?.position;
  if (!pos) {
    const x = s?.last_exit;
    return (
      <p className="sub" style={{ margin: "12px 0 0" }}>
        공격형 보유 종목이 없어요. 다음 거래일 아침에 AI 1위를 전액 매수해요.
        {x && <> 최근 정리: {x.date} {x.time} {x.name} {won(x.shares)}주 @ {won(x.price)}원
          (매수가 {won(x.entry)}원, <Pct v={(x.price / x.entry - 1) * 100} digits={2} />, {x.reason})</>}
      </p>
    );
  }
  const price = positions?.find((p) => p.code === pos.code)?.price;
  const { stop, peak, why } = liveStop(pos, s.rules, price);
  const trailing = peak >= pos.entry * (1 + s.rules.breakeven_at);
  return (
    <dl className="info-grid" style={{ marginTop: 12 }}>
      <div><dt>종목</dt><dd><StockLink code={pos.code} name={pos.name} /></dd></div>
      <div><dt>매수가 ({pos.entry_date})</dt><dd className="num">{won(pos.entry)}원</dd></div>
      <div>
        <dt>현재가</dt>
        <dd className="num">{price ? <>{won(price)}원 <Pct v={(price / pos.entry - 1) * 100} digits={2} /></> : "계좌 연결 시 표시"}</dd>
      </div>
      <div><dt>고점</dt><dd className="num">{won(peak)}원</dd></div>
      <div>
        <dt>손절선 · {why}</dt>
        <dd className="num down">
          {won(stop)}원{price ? <span className="muted"> (현재가 대비 {((stop / price - 1) * 100).toFixed(1)}%)</span> : null}
        </dd>
      </div>
      <div>
        <dt>추적 익절 시작</dt>
        <dd className="num">{trailing ? "적용 중" : `${won(pos.entry * (1 + s.rules.breakeven_at))}원 (+${s.rules.breakeven_at * 100}%)`}</dd>
      </div>
    </dl>
  );
}

export default function StrategyCard({ m, positions }) {
  const [target, setTarget] = useState(null);
  const mode = m.data?.mode;
  return (
    <div className="card section">
      <div className="filters" style={{ justifyContent: "space-between", marginBottom: 4 }}>
        <h2 style={{ margin: 0 }}>투자 성향 {mode && <span className="badge contest">{LABEL[mode]}</span>}</h2>
        <div className="seg" role="group" aria-label="투자 성향">
          {Object.keys(LABEL).map((k) => (
            <button key={k} aria-pressed={mode === k} disabled={!m.data}
              onClick={() => setTarget(k === mode ? null : k)}>{LABEL[k]}</button>
          ))}
        </div>
      </div>
      {m.error && !m.data && <p className="error-text">투자 성향을 불러오지 못했어요: {String(m.error.message)}</p>}
      {mode && (
        <p className="sub" style={{ margin: 0 }}>
          {DESC[mode]} 바꾸면 다음 매매부터 적용돼요 (장중 감시는 5분 안에, 아침 매매는 다음 거래일부터).
          {m.data.changedAt && <span className="muted"> · {m.data.changedAt.slice(0, 16).replace("T", " ")} 변경</span>}
        </p>
      )}
      {target && target !== mode && (
        <SwitchForm target={target} onCancel={() => setTarget(null)} onDone={() => { setTarget(null); m.reload(); }} />
      )}
      {mode === "aggressive" && <AggressiveDetail s={m.data.state} positions={positions} />}
    </div>
  );
}
