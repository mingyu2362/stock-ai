// "직접 백테스트": 전략 값을 바꿔 가며 브라우저에서 바로 돌려 본다 (src/backtest.js)
import { useMemo, useState } from "react";
import { runBacktest } from "./backtest.js";
import { LineChartBox } from "./chart.jsx";
import { Loading, Pct, Tile, useJson, won } from "./lib.jsx";

export const PRESET_LABEL = {
  stable: "이전 안정형 (대회)", aggressive: "이전 공격형 (11/26 수정)", aggressive_old: "이전 공격형 (대회)", stable_trail: "안정형 + 추적 손절",
  weekly: "주간 교체 5종목", diversified: "분산형 10종목", momentum: "모멘텀 (AI 없음)",
};
const REASON = { rank: "순위 이탈", stop: "손절", stop_gap: "손절 (시가)", trail: "추적 익절", trail_gap: "추적 익절 (시가)" };
const pctOpts = (xs) => xs.map((v) => [v, v == null ? "안 씀" : `${Math.round(v * 100)}%`]);
const STOP_OPTS = pctOpts([null, 0.03, 0.05, 0.08, 0.1, 0.12, 0.15, 0.2]);
const TRAIL_START_OPTS = pctOpts([null, 0.05, 0.1, 0.15, 0.2, 0.3]);
const TRAIL_OPTS = pctOpts([0.05, 0.08, 0.1, 0.12, 0.15]);

function Select({ label, value, options, onChange, hint }) {
  return (
    <label className="bt-field">
      <span>{label}</span>
      <select value={value == null ? "" : String(value)} onChange={(e) => {
        const raw = e.target.value;
        const opt = options.find(([v]) => (v == null ? "" : String(v)) === raw);
        onChange(opt ? opt[0] : null);
      }}>
        {options.map(([v, l]) => <option key={String(v)} value={v == null ? "" : String(v)}>{l}</option>)}
      </select>
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

export default function Backtester() {
  const [market, setMarket] = useState("kr");
  const state = useJson(`backtest_data_${market}.json`);
  return (
    <div className="card section">
      <div className="filters" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>직접 백테스트</h2>
        <div className="seg" role="group" aria-label="시장">
          {[["kr", "국내 351종목"], ["us", "나스닥100"]].map(([k, l]) => (
            <button key={k} aria-pressed={market === k} onClick={() => setMarket(k)}>{l}</button>
          ))}
        </div>
      </div>
      <p className="sub">
        AI가 매일 매긴 순위(모두 학습에 쓰지 않은 기간의 월별 재학습 예측)로 규칙을 바꿔 가며 돌려 보세요. 값을 바꾸면 바로 다시 계산해요.
      </p>
      <Loading state={state}>{(d) => <BacktestBody key={market} d={d} />}</Loading>
    </div>
  );
}

function BacktestBody({ d }) {
  const us = d.market === "us";
  const [opt, setOpt] = useState({ ...d.presets.stable, preset: "stable" });
  const [range, setRange] = useState([0, d.dates.length - 1]);
  const [man, setMan] = useState("10000");   // 시작 금액 (만 원, 나스닥은 달러로 보지 않고 같은 숫자를 원 단위로)
  const capital = (Number(man) || 10000) * 10_000;
  const set = (patch) => setOpt((o) => ({ ...o, ...patch, preset: null }));
  const usePreset = (key) => setOpt({ ...d.presets[key], preset: key });

  const res = useMemo(() => runBacktest(d, { ...opt, from: range[0], to: range[1], capital }), [d, opt, range, capital]);
  const curve = useMemo(() => {
    const base = range[0] > 0 ? d.index[range[0] - 1] : 100;
    return res.equity.map((e, k) => ({
      date: e.date, strategy: (e.value / capital) * 100, index: (d.index[range[0] + k] / base) * 100,
    }));
  }, [res, d, range, capital]);
  const m = res.metrics;
  const idxRet = curve.length ? curve[curve.length - 1].index - 100 : 0;
  const sellOpts = [[null, "안 팖"], ...[1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 30, 40, 60]
    .filter((v) => v >= opt.top_n).map((v) => [v, `${v}위 밖`])];
  const money = (v) => (us ? `$${won(v)}` : `${won(v)}원`);

  return (
    <>
      <div className="chips" style={{ marginBottom: 10 }}>
        {Object.keys(d.presets).map((k) => (
          <button key={k} type="button" className={`chip ${opt.preset === k ? "on" : ""}`} onClick={() => usePreset(k)}>
            {PRESET_LABEL[k] || k}
          </button>
        ))}
      </div>

      <div className="bt-form">
        <Select label="순위 기준" value={opt.score || "ai"} onChange={(v) => set({ score: v })}
          options={[["ai", `AI 모델 ${d.model}`], ["momentum", "20일 수익률 (AI 없음)"]]} />
        <Select label="보유 종목 수" value={opt.top_n}
          onChange={(v) => set({ top_n: v, sell_rank: opt.sell_rank != null && opt.sell_rank < v ? v : opt.sell_rank })}
          options={[1, 2, 3, 4, 5, 7, 10].map((v) => [v, `${v}종목`])} />
        <Select label="순위 매도" value={opt.sell_rank} onChange={(v) => set({ sell_rank: v })} options={sellOpts}
          hint="보유 종목이 이 순위 밖이면 판다" />
        <Select label="교체 주기" value={opt.weekly ? "w" : "d"} onChange={(v) => set({ weekly: v === "w" })}
          options={[["d", "매일"], ["w", "매주 첫 거래일"]]} />
        <Select label="손절" value={opt.stop} onChange={(v) => set({ stop: v })} options={STOP_OPTS} hint="매수가 대비" />
        <Select label="추적 익절 시작" value={opt.trail_start} onChange={(v) => set({ trail_start: v })} options={TRAIL_START_OPTS}
          hint="고점이 매수가 +이만큼 닿으면" />
        <Select label="추적 익절 폭" value={opt.trail ?? 0.08} onChange={(v) => set({ trail: v })} options={TRAIL_OPTS}
          hint="그 뒤 고점 대비 이만큼 빠지면 매도" />
        <label className="bt-field bt-check">
          <input type="checkbox" checked={!!opt.knife} onChange={(e) => set({ knife: e.target.checked })} />
          <span>떨어지는 칼날 제외 (20일 −30%·변동성 상위 20%)</span>
        </label>
        <label className="bt-field bt-check">
          <input type="checkbox" checked={!!opt.delay_after_stop} onChange={(e) => set({ delay_after_stop: e.target.checked })} />
          <span>손절한 자리는 다음 날 채우기</span>
        </label>
        <label className="bt-field">
          <span>시작일</span>
          <input type="date" value={d.dates[range[0]]} min={d.dates[0]} max={d.dates[range[1]]}
            onChange={(e) => { const k = d.dates.findIndex((x) => x >= e.target.value); if (k >= 0 && k < range[1]) setRange([k, range[1]]); }} />
        </label>
        <label className="bt-field">
          <span>종료일</span>
          <input type="date" value={d.dates[range[1]]} min={d.dates[range[0]]} max={d.dates[d.dates.length - 1]}
            onChange={(e) => {
              let k = d.dates.length - 1;
              while (k > 0 && d.dates[k] > e.target.value) k -= 1;
              if (k > range[0]) setRange([range[0], k]);
            }} />
        </label>
        <label className="bt-field">
          <span>시작 금액 ({us ? "만 달러처럼 숫자만" : "만 원"})</span>
          <input inputMode="numeric" value={man} onChange={(e) => setMan(e.target.value.replace(/\D/g, "").slice(0, 7))} />
        </label>
      </div>
      {opt.trail_start != null && opt.trail == null && <p className="error-text">추적 익절 폭을 골라 주세요.</p>}

      {m && (
        <>
          <div className="grid tiles" style={{ marginTop: 12 }}>
            <Tile label="누적 수익률" value={<Pct v={m.total} />} note={`${d.index_name} ${idxRet >= 0 ? "+" : ""}${idxRet.toFixed(1)}%`} />
            <Tile label="최대 낙폭 (MDD)" value={`${m.mdd.toFixed(1)}%`} note={`샤프 ${m.sharpe == null ? "–" : m.sharpe.toFixed(2)}`} />
            <Tile label="매도 건수 · 승률" value={`${m.sells}건`} note={`승률 ${m.win == null ? "–" : m.win.toFixed(0)}% · 손절·익절 ${m.stopShare == null ? "–" : m.stopShare.toFixed(0)}%`} />
            <Tile label="최종 평가금액" value={money(res.equity[res.equity.length - 1].value)}
              note={`거래금액 원금의 ${m.turnover.toFixed(0)}배 · ${m.days}거래일`} />
          </div>

          <div style={{ marginTop: 12 }}>
            <LineChartBox data={curve} height={300} format={(v) => v.toFixed(0)}
              series={[{ key: "strategy", name: "내 전략", short: "내 전략" }, { key: "index", name: d.index_name, short: us ? "나스닥100" : "코스피" }]} />
          </div>

          <div className="grid two" style={{ marginTop: 12 }}>
            <div>
              <h3 className="bt-h3">최근 매도 {Math.min(12, res.trades.length)}건</h3>
              {res.trades.length === 0 ? <div className="empty small">매도 기록이 없어요.</div> : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th className="l">매도일</th><th className="l">종목</th><th className="l">이유</th><th>보유</th><th>수익률</th></tr></thead>
                    <tbody>
                      {res.trades.slice(-12).reverse().map((t, k) => (
                        <tr key={k}>
                          <td className="l num">{t.date.slice(2)}</td>
                          <td className="l">{t.name}</td>
                          <td className="l muted">{REASON[t.reason] || t.reason}</td>
                          <td className="num muted">{t.entryDate.slice(5)}~</td>
                          <td><Pct v={t.ret} ratio digits={1} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div>
              <h3 className="bt-h3">마지막 날 보유 {res.holdings.length}종목</h3>
              {res.holdings.length === 0 ? <div className="empty small">보유 종목이 없어요 (현금).</div> : (
                <div className="table-wrap">
                  <table>
                    <thead><tr><th className="l">종목</th><th>매수일</th><th>평가 수익률</th></tr></thead>
                    <tbody>
                      {res.holdings.map((h) => (
                        <tr key={h.code}>
                          <td className="l"><a href={`#stock/${h.code}`}>{h.name}</a></td>
                          <td className="num muted">{h.entryDate.slice(2)}</td>
                          <td><Pct v={h.last / h.entry - 1} ratio digits={1} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}
      <p className="fine">
        일봉으로 흉내 낸 결과라 실제보다 약간 유리해요 (장중 손절은 손절가 −0.2%로 체결 가정). 비용: 수수료 {(d.costs.commission * 100).toFixed(3)}%
        {d.costs.tax ? `, 매도세 ${(d.costs.tax * 100).toFixed(2)}%` : ""}{us ? ", 환율 변화는 빼고 달러 기준" : ""}.
        종목 목록이 지금 기준이라 과거 성과가 실제보다 좋게 나오는 생존 편향이 있어요. 과거 성과가 미래 수익을 보장하지 않아요.
      </p>
    </>
  );
}
