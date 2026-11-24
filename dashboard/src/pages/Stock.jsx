import { useEffect, useState } from "react";
import CandleChart from "../candle.jsx";
import { fmtPrice, isUS, marketOpen, Pct, pct, useJson, usMarketOpen, won } from "../lib.jsx";
import { OrderBook, OrderPanel } from "../order.jsx";
import { usePaper } from "../paper.js";
import { liveStop, useMode } from "../strategy.jsx";
import { Flash, StockAvatar } from "../ui.jsx";
import { toggleWatch, useWatch } from "../watch.js";
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
const US_INTERVALS = INTERVALS.slice(0, 3);   // 네이버가 해외 분봉을 주지 않음
const REFRESH_MS = 30_000;

const signed = (v) => `${v > 0 ? "+" : ""}${won(v)}`;
const signedPrice = (v, code) => (isUS(code) ? `${v > 0 ? "+" : v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}` : `${signed(Math.round(v))}원`);
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
    const { server, appKey, appSecret, account, token } = creds;
    fetch("/api/account", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server, appKey, appSecret, account, token, balanceOnly: true }),
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

// 평단가: 계좌 연결 시 한투 잔고, 없으면 가상 모의투자 보유, 그것도 없으면 팀 공격형 보유 기록의 매수가.
// 손절선은 팀 공격형 규칙에만 있음
function holdingOf(d, acct, mode, paperPos) {
  if (!d) return null;
  const aggr = mode?.mode === "aggressive" && mode.state?.position?.code === d.code ? mode.state.position : null;
  const base = (acct.position && { avg: acct.position.avgPrice, shares: acct.position.shares, src: "계좌" })
    || (paperPos && { avg: paperPos.avg, shares: paperPos.shares, src: "모의" })
    || (!acct.connected && aggr && { avg: aggr.entry, shares: aggr.shares, src: "팀" });
  if (!base || !base.avg) return null;
  const s = base.src === "팀" && liveStop(aggr, mode.state.rules, d.price);
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
  const [intervalRaw, setInterval_] = useState("day");
  const us = isUS(code);
  const interval = us && !US_INTERVALS.some((t) => t.key === intervalRaw) ? "day" : intervalRaw;
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const todayKr = useJson("today.json").data;
  const todayUs = useJson("today_us.json").data;
  const today = us ? todayUs : todayKr;
  const universeKr = useJson("universe.json").data || {};
  const universeUs = useJson("universe_us.json").data || {};
  const universe = us ? universeUs : universeKr;
  const mode = useMode().data;
  const acct = useAccountPosition(code);
  const paper = usePaper();
  const watch = useWatch();
  const [picked, setPicked] = useState(null);
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
    const timer = setInterval(() => (isUS(code) ? usMarketOpen() : marketOpen()) && load(), REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [code, interval]);

  const d = state.data?.code === code ? state.data : null;
  const rank = today?.ranks?.[code];
  const top = today?.top?.find((t) => t.code === code);
  const sellRank = today?.strategy?.sell_rank;
  const time = d?.tradedAt?.slice(11, 16);
  const holding = holdingOf(d, acct, mode, paper?.positions[code]);
  const watched = watch.some((w) => w.code === code);

  return (
    <>
      <div className="crumb">
        <button className="icon-btn" onClick={goBack}>← 뒤로</button>
      </div>

      {state.error && !d && <div className="card empty"><strong>종목 정보를 불러오지 못했어요</strong>{String(state.error.message)}</div>}
      {!d && !state.error && <div className="card empty">불러오는 중…</div>}

      {d && (
        <>
          <div className={`card section stock-head ${dirOf(d.change)}`}>
            <div>
              <h2 className="stock-name">
                <button className={`star big ${watched ? "on" : ""}`} onClick={() => toggleWatch(d.code, d.name)}
                  aria-label={watched ? "관심종목 해제" : "관심종목 추가"} title={watched ? "관심종목 해제" : "관심종목 추가"}>
                  {watched ? "★" : "☆"}
                </button>
                <StockAvatar code={d.code} name={d.name} size={34} />
                {d.name} <span className="muted code">{d.code}</span>
                {d.market && <span className="badge">{d.market}</span>}
                {universe[d.code] && <span className="badge contest">AI 분석 종목</span>}
              </h2>
              <div className="stock-price">
                <Flash value={d.price}><b className={dirOf(d.change)}>{fmtPrice(d.price, d.code)}{!us && <small>원</small>}</b></Flash>
                <span className={dirOf(d.change)}>
                  {d.change > 0 ? "▲" : d.change < 0 ? "▼" : ""} {fmtPrice(Math.abs(d.change), d.code)} ({pct(d.ratio, { digits: 2 })})
                </span>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                <span className={`live-dot ${d.open ? "on" : ""}`} />{d.open ? "장중 실시간" : "장 마감"}{time ? ` · ${us ? "뉴욕 " : ""}${time} 기준` : ""} · 출처 네이버 증권
                {us && d.nameEng && <> · {d.nameEng}</>}
                {holding && <> · <b className={dirOf(holding.pnl)}>{holding.src === "모의" ? "모의 보유" : holding.src === "계좌" ? "내 계좌 보유" : "팀 보유"} {won(holding.shares)}주 {signedPrice(holding.pnl, d.code)} ({pct(holding.ratio, { digits: 2 })})</b></>}
              </p>
            </div>
            <div className="ai-box">
              <div className="label">오늘의 AI 순위</div>
              {rank ? (
                <>
                  <div className="value">{rank}위 <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>/ {today.universe_size}</span></div>
                  <div className="note">
                    {rank <= today.strategy.top_n ? "AI 매수 대상" : rank <= sellRank ? `보유 유지 구간 (${sellRank}위 이내)` : `AI라면 매도 (${sellRank}위 밖)`}
                    {" · "}{today.date} 예측
                  </div>
                </>
              ) : (
                <div className="note">AI 분석 대상({us ? "나스닥100" : "코스피200·코스닥150"})이 아니라 AI 순위가 없어요</div>
              )}
            </div>
          </div>

          <div className="stock-layout">
            <div className="stock-main">
              <div className="card section chart-card">
                <div className="filters" style={{ marginBottom: 8 }}>
                  <div className="seg" role="group" aria-label="봉 주기">
                    {(us ? US_INTERVALS : INTERVALS).map((t) => (
                      <button key={t.key} aria-pressed={interval === t.key} onClick={() => setInterval_(t.key)}>{t.label}</button>
                    ))}
                  </div>
                  {holding && (
                    <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}>
                      <input type="checkbox" checked={show} onChange={toggleShow} /> 평단{holding.stop ? "·손절선" : ""}
                    </label>
                  )}
                  <span className="muted" style={{ fontSize: 12 }}>
                    드래그로 이동 · 휠로 확대/축소{(us ? usMarketOpen() : marketOpen()) ? " · 30초마다 갱신" : ""}{us ? " · 해외 종목은 분봉 없음" : ""}
                  </span>
                </div>
                {d.interval === interval && d.candles.length > 0
                  ? <CandleChart candles={d.candles} interval={interval} holding={show ? holding : null} />
                  : <div className="empty">{d.candles.length ? "불러오는 중…" : "시세 데이터가 없어요."}</div>}
              </div>

              <div className={d.deals.length ? "grid two" : ""}>
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

                {d.deals.length > 0 && <div className="card">
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
                </div>}
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
            </div>

            <div className="stock-side">
              <OrderBook code={d.code} price={d.price} prevClose={d.price - d.change} onPick={(p) => setPicked({ price: p, at: Date.now() })} />
              <OrderPanel code={d.code} name={d.name} price={d.price} picked={picked} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
