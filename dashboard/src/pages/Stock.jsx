import { useEffect, useState } from "react";
import CandleChart from "../candle.jsx";
import { marketOpen, Pct, pct, useJson, won } from "../lib.jsx";
import { liveStop, useMode } from "../strategy.jsx";
import { loadCreds, saveCreds } from "./Account.jsx";

const INTERVALS = [
  { key: "day", label: "일봉" },
  { key: "week", label: "주봉" },
  { key: "month", label: "월봉" },
  { key: "minute", label: "1분" },
  { key: "minute5", label: "5분" },
  { key: "minute10", label: "10분" },
  { key: "minute30", label: "30분" },
  { key: "minute60", label: "60분" },
];
const REFRESH_MS = 30_000;

const signed = (v) => `${v > 0 ? "+" : ""}${won(v)}`;
const dirOf = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");

const SHOW_KEY = "chart-holding";   // 평단·손절선 표시 여부 (이 브라우저에만 기억)
const loadShow = () => { try { return localStorage.getItem(SHOW_KEY) !== "off"; } catch { return true; } };

// 내 계좌에서 이 종목 보유 현황. 키가 이 브라우저에 있을 때만, 종목을 열 때 한 번 (평단가는 장중에 거의 안 바뀜)
function useAccountPosition(code) {
  const [state, setState] = useState({ code: null, connected: false, position: null });
  useEffect(() => {
    const creds = loadCreds();
    if (!creds) return;
    let alive = true;
    const { appKey, appSecret, account, token } = creds;
    fetch("/api/account", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appKey, appSecret, account, token, balanceOnly: true }),
    })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || r.status);
        if (body.token?.value !== token?.value) saveCreds({ ...creds, token: body.token });
        if (alive) setState({ code, connected: true, position: body.positions.find((p) => p.code === code) || null });
      })
      .catch(() => { /* 계좌를 못 읽으면 공격형 보유 기록으로 대신 */ });
    return () => { alive = false; };
  }, [code]);
  return state.code === code ? state : { connected: false, position: null };
}

// 평단가: 계좌 연결 시 한투 잔고, 아니면 공격형 보유 기록의 매수가. 손절선은 공격형 규칙에만 있음
function holdingOf(d, acct, mode) {
  if (!d) return null;
  const aggr = mode?.mode === "aggressive" && mode.state?.position?.code === d.code ? mode.state.position : null;
  const base = acct.connected
    ? acct.position && { avg: acct.position.avgPrice, shares: acct.position.shares }
    : aggr && { avg: aggr.entry, shares: aggr.shares };
  if (!base || !base.avg) return null;
  const s = aggr && liveStop(aggr, mode.state.rules, d.price);
  return {
    ...base,
    price: d.price,
    pnl: (d.price - base.avg) * base.shares,
    ratio: (d.price / base.avg - 1) * 100,
    stop: s ? Math.round(s.stop) : null,
    stopWhy: s?.why,
  };
}

function goBack() {
  if (window.history.length > 1) window.history.back();
  else window.location.hash = "today";
}

export default function Stock({ code }) {
  const [interval, setInterval_] = useState("day");
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const today = useJson("today.json").data;
  const universeData = useJson("universe.json").data;
  const universe = universeData || {};
  const mode = useMode().data;
  const acct = useAccountPosition(code);
  const [show, setShow] = useState(loadShow);
  const toggleShow = (e) => {
    setShow(e.target.checked);
    try { localStorage.setItem(SHOW_KEY, e.target.checked ? "on" : "off"); } catch { /* 무시 */ }
  };

  useEffect(() => {
    let alive = true;
    const load = () => {
      setState((s) => ({ ...s, loading: true }));
      fetch(`/api/stock?code=${code}&interval=${interval}`)
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
  }, [code, interval]);

  const d = state.data?.code === code ? state.data : null;
  const rank = today?.ranks?.[code];
  const top = today?.top?.find((t) => t.code === code);
  const sellRank = today?.strategy?.sell_rank;
  const time = d?.tradedAt?.slice(11, 16);
  const holding = holdingOf(d, acct, mode);

  return (
    <>
      <div className="filters">
        <button className="icon-btn" onClick={goBack}>← 뒤로</button>
      </div>

      {state.error && !d && <div className="card empty"><strong>종목 정보를 불러오지 못했어요</strong>{String(state.error.message)}</div>}
      {!d && !state.error && <div className="card empty">불러오는 중…</div>}

      {d && (
        <>
          <div className="card section stock-head">
            <div>
              <h2 className="stock-name">
                {d.name} <span className="muted">{d.code}</span>
                {d.market && <span className="badge">{d.market}</span>}
                {universe[d.code] && <span className="badge contest">대회</span>}
                {universeData && !universe[d.code] && <span className="badge blocked">대회 매매 불가</span>}
              </h2>
              <div className="stock-price">
                <b className={dirOf(d.change)}>{won(d.price)}</b>
                <span className={dirOf(d.change)}>
                  {d.change > 0 ? "▲" : d.change < 0 ? "▼" : ""} {won(Math.abs(d.change))} ({pct(d.ratio, { digits: 2 })})
                </span>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                {d.open ? "장중" : "장 마감"}{time ? ` · ${time} 기준` : ""} · 출처 네이버 증권
              </p>
            </div>
            <div className="ai-box">
              <div className="label">오늘의 AI 순위</div>
              {rank ? (
                <>
                  <div className="value">{rank}위 <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>/ {today.universe_size}</span></div>
                  <div className="note">
                    {rank <= today.strategy.top_n ? "매수 대상" : rank <= sellRank ? `보유 중이면 유지 (${sellRank}위 이내)` : `보유 중이면 매도 (${sellRank}위 밖)`}
                    {" · "}{today.date} 예측
                  </div>
                </>
              ) : (
                <div className="note">대회 거래 가능 종목(코스피200·코스닥150)이 아니라 대회에서 매매할 수 없고, AI 순위도 없어요</div>
              )}
            </div>
          </div>

          <div className="card section">
            <div className="filters" style={{ marginBottom: 8 }}>
              <div className="seg" role="group" aria-label="봉 주기">
                {INTERVALS.map((t) => (
                  <button key={t.key} aria-pressed={interval === t.key} onClick={() => setInterval_(t.key)}>{t.label}</button>
                ))}
              </div>
              {holding && (
                <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}>
                  <input type="checkbox" checked={show} onChange={toggleShow} /> 평단·손절선
                </label>
              )}
              <span className="muted" style={{ fontSize: 12 }}>드래그로 이동 · 휠로 확대/축소{marketOpen() ? " · 30초마다 갱신" : ""}</span>
            </div>
            {d.interval === interval && d.candles.length > 0
              ? <CandleChart candles={d.candles} interval={interval} holding={show ? holding : null} />
              : <div className="empty">{d.candles.length ? "불러오는 중…" : "시세 데이터가 없어요."}</div>}
          </div>

          <div className="grid two">
            <div className="card">
              <h2>종목 정보</h2>
              <p className="sub">기준 시점이 있는 값은 괄호 안 날짜 기준이에요.</p>
              <dl className="info-grid">
                {d.infos.map((i) => (
                  <div key={i.key}>
                    <dt>{i.key}{i.desc && <span className="muted"> ({i.desc})</span>}</dt>
                    <dd className="num">{i.value}</dd>
                  </div>
                ))}
              </dl>
            </div>

            <div className="card">
              <h2>투자자별 순매수 (주)</h2>
              <p className="sub">최근 거래일 기준, 개인은 장 마감 후 확정돼요.</p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th className="l">날짜</th><th>종가</th><th>등락률</th><th>외국인</th><th>기관</th><th>개인</th></tr>
                  </thead>
                  <tbody>
                    {d.deals.map((r) => (
                      <tr key={r.date}>
                        <td className="l">{r.date}</td>
                        <td className="num">{won(r.close)}</td>
                        <td><Pct v={r.ratio} digits={2} /></td>
                        {[r.foreign, r.organ, r.individual].map((v, i) => (
                          <td key={i} className={`num ${dirOf(v)}`}>{signed(v)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {top && (
            <div className="card" style={{ marginTop: 12 }}>
              <h2>AI가 본 차트 지표</h2>
              <p className="sub">{today.base_close} 종가까지의 값이에요 (모델 입력의 일부).</p>
              <dl className="info-grid">
                <div><dt>1일 수익률</dt><dd><Pct v={top.ret_1d} ratio digits={2} /></dd></div>
                <div><dt>5일 수익률</dt><dd><Pct v={top.ret_5d} ratio digits={2} /></dd></div>
                <div><dt>20일 수익률</dt><dd><Pct v={top.ret_20d} ratio digits={2} /></dd></div>
                <div><dt>RSI(14)</dt><dd className="num">{top.rsi_14?.toFixed(1)}</dd></div>
                <div><dt>거래량 (20일 평균 대비)</dt><dd className="num">{top.vol_ratio_20?.toFixed(2)}배</dd></div>
                <div><dt>20일 변동성 (일)</dt><dd className="num">{(top.volat_20 * 100).toFixed(2)}%</dd></div>
              </dl>
            </div>
          )}
        </>
      )}
    </>
  );
}
