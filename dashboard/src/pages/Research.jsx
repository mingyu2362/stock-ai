import { useState } from "react";
import Backtester from "../backtester.jsx";
import { LineChartBox } from "../chart.jsx";
import { Loading, Pct, Tile, useJson } from "../lib.jsx";

const MODEL_NAME = { A: "A (차트+시장)", C: "C (차트+뉴스+시장)" };
const VIEWS = [["compare", "전략 비교"], ["try", "직접 백테스트"], ["research", "모델 연구"]];
const VIEW_KEY = "research-view";

export default function Research() {
  const [view, setView] = useState(() => {
    try { return localStorage.getItem(VIEW_KEY) || "compare"; } catch { return "compare"; }
  });
  const pick = (v) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* 무시 */ }
  };
  return (
    <>
      <div className="seg research-views" role="tablist" aria-label="백테스트 화면">
        {VIEWS.map(([k, l]) => <button key={k} role="tab" aria-pressed={view === k} onClick={() => pick(k)}>{l}</button>)}
      </div>
      {view === "compare" && <StrategyCompare />}
      {view === "try" && <Backtester />}
      {view === "research" && <ModelResearch />}
    </>
  );
}

// 전략 비교 (dashboard/export.py strategies → backtest.json): 국내·나스닥, 연속 실행 결과
function StrategyCompare() {
  const state = useJson("backtest.json");
  const [market, setMarket] = useState("kr");
  const [picked, setPicked] = useState(["trend_stable", "stable"]);
  return (
    <Loading state={state}>
      {(all) => {
        const st = all.strategies;
        if (!st) return <div className="card empty">전략 비교 데이터가 아직 없어요 (python dashboard/export.py --backtest).</div>;
        const d = st[market];
        if (!d) return <div className="card empty">{market === "us" ? "나스닥100" : "국내"} 전략 비교 데이터가 없어요.</div>;
        const has = new Set(d.rows.map((r) => r.key));
        const shown = picked.filter((k) => has.has(k));
        const series = [
          ...(shown.length ? shown : [d.rows[0].key]).map((k) => ({ key: k, name: st.defs[k].label })),
          { key: "index", name: d.index_name, short: market === "us" ? "나스닥100" : "코스피" },
        ];
        const toggle = (k) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p.slice(-1), k]));
        const best = Math.max(...d.rows.map((r) => r.total));
        return (
          <>
            <div className="card section">
              <div className="filters" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                <h2 style={{ margin: 0 }}>전략별 자산 (시작 = 100)</h2>
                <div className="seg" role="group" aria-label="시장">
                  {[["kr", "국내 351종목"], ["us", "나스닥100"]].map(([k, l]) => (
                    <button key={k} aria-pressed={market === k} onClick={() => setMarket(k)}>{l}</button>
                  ))}
                </div>
              </div>
              <p className="sub">
                {d.from} ~ {d.to}, 모델 {d.model} 월별 재학습 예측(모두 처음 보는 기간)으로 같은 엔진·같은 비용을 써서 돌린 결과예요.
                아래 표에서 전략 이름을 눌러 그래프에 넣고 빼세요 (최대 2개 + 지수).
              </p>
              <LineChartBox data={d.curve} height={320} series={series} format={(v) => v.toFixed(0)}
                shade={market === "kr" ? { from: "2026-10-12", to: d.to, label: "대회" } : undefined} />
            </div>

            <div className="card section">
              <h2>전략 비교표</h2>
              <p className="sub">기간별 수익률은 처음부터 이어서 돌린 자산 곡선에서 그 기간만 잘라 본 값이에요.</p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="l">전략</th>{st.periods.map((p) => <th key={p}>{p}</th>)}
                      <th>전체</th><th>MDD</th><th>샤프</th><th>매도</th><th>승률</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map((r) => (
                      <tr key={r.key} style={r.total === best ? { fontWeight: 600 } : undefined}>
                        <td className="l">
                          <button type="button" className={`chip ${picked.includes(r.key) ? "on" : ""}`} onClick={() => toggle(r.key)}
                            title={st.defs[r.key].desc}>
                            {st.defs[r.key].label}
                          </button>
                        </td>
                        {st.periods.map((p) => <td key={p}><Pct v={r[p]} /></td>)}
                        <td><Pct v={r.total} /></td>
                        <td className="num">{r.mdd?.toFixed(1)}%</td>
                        <td className="num">{r.sharpe?.toFixed(2)}</td>
                        <td className="num">{r.sells}</td>
                        <td className="num">{r.win == null ? "–" : `${r.win.toFixed(0)}%`}</td>
                      </tr>
                    ))}
                    {d.bench.map((b) => (
                      <tr key={b.key}>
                        <td className="l muted">{b.key === "index" ? d.index_name : d.equal_name}</td>
                        {st.periods.map((p) => <td key={p}><Pct v={b[p]} /></td>)}
                        <td><Pct v={b.total} /></td>
                        <td className="num muted">{b.mdd?.toFixed(1)}%</td>
                        <td colSpan={3} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="findings" style={{ marginTop: 10 }}>
                {Object.entries(st.defs).map(([k, s]) => <li key={k}><b>{s.label}</b> — {s.desc}</li>)}
              </ul>
            </div>

            {market === "kr" && st.aggr_grid && <AggrGrid rows={st.aggr_grid} periods={st.periods} />}

            <div className="card">
              <h2>읽을 때 주의할 점</h2>
              <ul className="findings">
                <li><b>2026-11-28에 전략을 "AI 추세"로 새로 짰어요 (안정형·공격형 공통, 종목 수만 6 / 3).</b> 목표는 코스피 대비 안정적인 초과수익과 낙폭 제한이에요. 후보 6개(눌림목·과매도 반등·추세·모멘텀·저변동)를 2025-01~2026-06에서만 미리 정한 기준으로 비교해 고르고, 2026-07~11(코스피 −45%)에서 한 번 확인했어요: 안정형 −11% (MDD −15%), 공격형 −16% (MDD −17%). 손실을 줄인 건 대부분 "코스피 60일선 아래면 새로 사지 않기" 덕분이고, 하락장에서 돈을 번 건 아니에요. 자세한 표: data/predictions/lab_*.csv (model/strategy_lab.py).</li>
                <li><b>처음부터 이어서 돌리면 AI 추세 안정형의 MDD는 −39%예요.</b> 2026-06~07 고점 부근에서 코스피가 ±10%씩 출렁일 때(60일선보다는 위라 필터가 안 켜짐) 사고 손절당하기를 반복해 −33%가 났어요. 위 표는 2026-10-27까지라 11월 급락이 빠져 이전 안정형이 더 좋아 보이지만, 2026-11-25까지 이으면 AI 추세 +169% · 이전 안정형 +157% · 코스피 +96%예요. 기간을 어디서 자르느냐에 따라 순서가 바뀔 만큼 차이가 크지 않다는 뜻이에요.</li>
                <li><b>이전 전략은 비교용이에요.</b> 이전 안정형(대회)은 2026-07 이후 −38%로 하락장 방어가 거의 없었고, 이전 공격형은 손절·익절 값을 조금만 바꿔도 결과가 완전히 달라졌어요.</li>
                <li><b>AI 모델은 단기 낙폭 과대 반등을 노려요.</b> 최근 5일 많이 빠진 종목일수록 점수가 높아서, 하락장에서는 급락주를 상위에 올려요 (2026년 11월 실전 순위 1위 종목 평균 −1.9%/일).</li>
                <li><b>모멘텀(AI 없음)이 높게 나온 기간은 생존 편향을 의심하세요.</b> 지금 지수에 남아 있는 종목만으로 과거를 돌리면 많이 오른 종목을 미리 아는 셈이라 추세 추종이 특히 유리해져요.</li>
                <li><b>나스닥100 모델은 신호가 약해요.</b> 월별 검증 순위상관(IC)이 2025년 +0.03, 2026년 0 근처라 국내 모델(차트+시장)보다 확실히 약해요. 참고용으로만 보세요.</li>
                <li>모두 일봉으로 흉내 낸 결과예요. 장중 손절은 손절가에서 0.2% 불리하게 체결한다고 가정했어요.</li>
              </ul>
            </div>
          </>
        );
      }}
    </Loading>
  );
}

// 공격형 손절·추적 익절 값 민감도 (국내)
function AggrGrid({ rows, periods }) {
  const stops = [...new Set(rows.map((r) => r.stop))];
  const trails = [...new Set(rows.map((r) => r.trail))];
  const cell = (s, t) => rows.find((r) => r.stop === s && r.trail === t);
  return (
    <div className="card section">
      <h2>이전 공격형 민감도: 손절 x 추적 익절 폭 (전체 기간 수익률)</h2>
      <p className="sub">이전 공격형 규칙(2종목, 20위 밖 매도, 칼날 제외)에서 손절·추적 폭만 바꾼 결과예요 (지금은 쓰지 않는 전략, 값에 따라 결과가 크게 흔들렸던 근거). 추적 익절은 고점이 매수가 +10%에 닿은 뒤부터. 11/26 값은 손절 8%, 폭 8% (테두리). 칸에 마우스를 올리면 기간별 수익률이 보여요.</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th className="l">손절 \ 추적 폭</th>{trails.map((t) => <th key={t}>{Math.round(t * 100)}%</th>)}</tr></thead>
          <tbody>
            {stops.map((s) => (
              <tr key={s}>
                <td className="l">−{Math.round(s * 100)}%</td>
                {trails.map((t) => {
                  const c = cell(s, t);
                  const live = Math.abs(s - 0.08) < 1e-9 && Math.abs(t - 0.08) < 1e-9;
                  return (
                    <td key={t} title={periods.map((p) => `${p}: ${c?.[p]?.toFixed(1)}%`).join("\n") + `\nMDD ${c?.mdd?.toFixed(1)}%`}
                      style={live ? { fontWeight: 700, outline: "2px solid var(--accent)", outlineOffset: -2 } : undefined}>
                      <Pct v={c?.total} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ModelResearch() {
  const state = useJson("backtest.json");
  return (
    <Loading state={state}>
      {(d) => {
        const s = d.summary;
        const live = d.grid.find((g) => g.model === d.config.model && g.top_n === d.config.top_n);
        return (
          <>
            <div className="grid tiles">
              <Tile label="누적 수익률 (2025-01~)" value={<Pct v={s.return} />} note={`실전 전략: 모델 ${d.config.model}, 상위 ${d.config.top_n}종목`} />
              <Tile label="최대 낙폭 (MDD)" value={`${s.mdd}%`} note={`샤프 ${s.sharpe}`} />
              <Tile label="15거래일 +15% 넘을 확률" value={`${s.p15_over15}%`} note="대회 남은 기간과 같은 길이" />
              <Tile label="15거래일 마이너스 확률" value={`${s.p15_negative}%`} note={`30일 거래금액 약 ${s.turnover30}억`} />
            </div>

            <div className="card section">
              <h2>실전 전략 vs 시장 (시작 = 100)</h2>
              <p className="sub">
                매달 그 전까지의 데이터로만 다시 학습해 예측한 결과 (모두 모델이 처음 보는 기간). 비용 반영, 시가 매매.
              </p>
              <LineChartBox data={d.curve} height={300}
                series={[{ key: "strategy", name: "AI 전략" }, { key: "kospi", name: "코스피" }, { key: "equal", name: "351종목 같은 비중", short: "같은 비중" }]}
                format={(v) => v.toFixed(0)} shade={{ from: "2026-10-12", to: d.curve[d.curve.length - 1].date, label: "대회" }} />
            </div>

            <div className="card section">
              <h2>모델·종목 수별 기간 수익률 (%)</h2>
              <p className="sub">
                점수에 작은 잡음을 섞어 {d.noise_seeds}번 반복한 중앙값. 종목이 적으면 한 번의 백테스트는 운에 크게 흔들려서 여러 번 돌려 비교했어요.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th className="l">모델</th><th>보유 종목</th><th>매도 순위</th>{d.periods.map((p) => <th key={p}>{p}</th>)}</tr>
                  </thead>
                  <tbody>
                    {d.grid.map((g) => (
                      <tr key={g.model + g.top_n} style={g === live ? { fontWeight: 600 } : undefined}>
                        <td className="l">{MODEL_NAME[g.model]}{g === live && <span className="badge contest">실전</span>}</td>
                        <td className="num">{g.top_n}</td>
                        <td className="num">{g.sell_rank}위</td>
                        {d.periods.map((p) => <td key={p}><Pct v={g[p]} /></td>)}
                      </tr>
                    ))}
                    {[["kospi", "코스피 보유"], ["equal", "351종목 같은 비중"]].map(([k, label]) => (
                      <tr key={k}>
                        <td className="l muted" colSpan={3}>{label}</td>
                        {d.periods.map((p) => <td key={p}><Pct v={d.bench.find((b) => b.period === p)[k]} /></td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card">
              <h2>연구에서 확인한 것</h2>
              <ul className="findings">
                <li><b>뉴스 날짜 누수를 찾아 고쳤어요.</b> 구글 뉴스 검색 날짜 d 결과의 절반이 d+1 기사였어요. 발행 날짜로 맞추자 "다음 날 코스피 예측력"(상관 0.26)이 0으로 사라졌어요.</li>
                <li><b>시장 뉴스 공포지수는 방향이 아니라 변동성 신호예요.</b> 공포 상위 20%인 날 다음 날 코스피 변동폭이 평소의 2.6배였어요.</li>
                <li><b>뉴스를 더한 모델 C는 하락장에서 오히려 나빴어요.</b> 2026년 6월 이후 C는 −33~−40%, A는 −8~−16% (코스피 −26%).</li>
                <li><b>손절(−3%, −5%)과 공포 비중 축소는 모든 조합에서 수익을 깎았어요.</b></li>
                <li><b>주의: 생존 편향.</b> 종목 목록이 2026-09 기준이라 과거 성과는 실제보다 좋게 나와요. 2026-06 지수 정기변경 이후 구간이 가장 공정해요.</li>
              </ul>
            </div>
          </>
        );
      }}
    </Loading>
  );
}
