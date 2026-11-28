import { useCallback, useEffect, useState } from "react";
import { Pct, StockLink, won } from "./lib.jsx";

// 투자 성향 (안정형 / 공격형). 저장소의 data/strategy/*.json 을 /api/mode 로 읽고 바꾼다
// 두 성향 모두 전략 "AI 추세" (trade/strategy.py), 종목 수만 다르다
const LABEL = { stable: "안정형", aggressive: "공격형" };
const RULE = "종가가 20일선·60일선 위에 있는 오르는 종목 중 AI 점수 순으로 사요. 손절선(처음 매수가 − ATR×2, 그 뒤 종가 고점 − ATR×3)에 닿으면 장중에 바로, 종가가 20일선 아래면 다음 날 아침에 팔아요. 코스피가 60일선 아래면 새로 사지 않아요.";
const DESC = {
  stable: `6종목에 1/6씩. ${RULE}`,
  aggressive: `3종목에 1/3씩 (안정형보다 집중). ${RULE}`,
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

// 팀 보유 기록 (data/strategy/positions.json)
export const teamPositions = (s) => s?.positions || [];

function PositionsDetail({ s, positions }) {
  const list = teamPositions(s);
  const exits = (s?.exits || []).slice(-3).reverse();
  const market = s?.market;
  return (
    <>
      {market && (
        <p className="sub" style={{ margin: "10px 0 0" }}>
          시장 필터 ({market.date}): 코스피 {won(market.kospi)} {market.ok ? "≥" : "<"} 60일선 {won(market.kospi_ma)} →{" "}
          <b className={market.ok ? "up" : "down"}>{market.ok ? "새로 살 수 있어요" : "새로 사지 않아요 (현금 보유)"}</b>
        </p>
      )}
      {list.length === 0 && (
        <p className="sub" style={{ margin: "10px 0 0" }}>팀 보유 종목이 없어요.{market && !market.ok ? " 코스피가 60일선 위로 올라오면 다시 사요." : " 다음 거래일 아침에 조건에 맞는 종목을 사요."}</p>
      )}
      {list.map((pos) => <Position key={pos.code} pos={pos} positions={positions} />)}
      {exits.length > 0 && (
        <p className="sub" style={{ margin: "10px 0 0" }}>
          최근 정리: {exits.map((x, k) => (
            <span key={k}>{k ? " · " : ""}{x.date} {x.name} {x.price ? <>{x.estimated ? "약 " : ""}{won(x.price)}원 (<Pct v={(x.price / x.entry - 1) * 100} digits={1} />)</> : ""} {x.reason}</span>
          ))}
        </p>
      )}
    </>
  );
}

function Position({ pos, positions }) {
  const price = positions?.find((p) => p.code === pos.code)?.price;
  return (
    <dl className="info-grid" style={{ marginTop: 12 }}>
      <div><dt>종목</dt><dd><StockLink code={pos.code} name={pos.name} /></dd></div>
      <div><dt>매수가 ({pos.entry_date})</dt><dd className="num">{won(pos.entry)}원</dd></div>
      <div>
        <dt>현재가</dt>
        <dd className="num">{price ? <>{won(price)}원 <Pct v={(price / pos.entry - 1) * 100} digits={2} /></> : "계좌 연결 시 표시"}</dd>
      </div>
      <div><dt>종가 고점 · ATR</dt><dd className="num">{won(pos.peak)}원 · {won(pos.atr)}</dd></div>
      <div>
        <dt>손절선 · {pos.stop_reason}</dt>
        <dd className="num down">
          {won(pos.stop)}원{price ? <span className="muted"> (현재가 대비 {((pos.stop / price - 1) * 100).toFixed(1)}%)</span> : null}
        </dd>
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
          {DESC[mode]} 바꾸면 다음 거래일 아침부터 종목 수가 바뀌어요 (가진 종목은 억지로 팔지 않아요).
          {m.data.changedAt && <span className="muted"> · {m.data.changedAt.slice(0, 16).replace("T", " ")} 변경</span>}
        </p>
      )}
      {target && target !== mode && (
        <SwitchForm target={target} onCancel={() => setTarget(null)} onDone={() => { setTarget(null); m.reload(); }} />
      )}
      {mode && <PositionsDetail s={m.data.state} positions={positions} />}
    </div>
  );
}
