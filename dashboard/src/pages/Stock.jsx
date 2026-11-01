import { useEffect, useState } from "react";
import CandleChart from "../candle.jsx";
import { marketOpen, Pct, pct, useJson, won } from "../lib.jsx";

const INTERVALS = [
  { key: "day", label: "일봉" },
  { key: "week", label: "주봉" },
  { key: "month", label: "월봉" },
];
const REFRESH_MS = 30_000;

const signed = (v) => `${v > 0 ? "+" : ""}${won(v)}`;
const dirOf = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");

function goBack() {
  if (window.history.length > 1) window.history.back();
  else window.location.hash = "today";
}

export default function Stock({ code }) {
  const [interval, setInterval_] = useState("day");
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const today = useJson("today.json").data;
  const universe = useJson("universe.json").data || {};

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
                <div className="note">대회 종목이 아니라 AI 순위가 없어요</div>
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
              <span className="muted" style={{ fontSize: 12 }}>드래그로 이동 · 휠로 확대/축소{marketOpen() ? " · 30초마다 갱신" : ""}</span>
            </div>
            {d.interval === interval && d.candles.length > 0
              ? <CandleChart candles={d.candles} interval={interval} />
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
