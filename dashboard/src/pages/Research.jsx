import { LineChartBox } from "../chart.jsx";
import { Loading, Pct, Tile, useJson } from "../lib.jsx";

const MODEL_NAME = { A: "A (차트+시장)", C: "C (차트+뉴스+시장)" };

export default function Research() {
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
