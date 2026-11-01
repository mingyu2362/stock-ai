import { LineChartBox } from "../chart.jsx";
import { Loading, Pct, StockLink, Tile, eok, useJson, won } from "../lib.jsx";

// 대회 수상 자격 (BanKIS 모의투자대회 AI리그)
const RULES = [
  { key: "days", label: "매매일수", goal: 5, unit: "영업일" },
  { key: "amount", label: "거래금액 (매수+매도)", goal: 5e8, unit: "원" },
  { key: "codes", label: "체결 종목 수", goal: 5, unit: "종목" },
  { key: "fills", label: "API 체결 횟수", goal: 5, unit: "회" },
];

function Eligibility({ now }) {
  return (
    <div className="card">
      <h2>수상 자격</h2>
      <p className="sub">하나라도 못 채우거나 최종 수익률이 마이너스면 시상에서 제외돼요.</p>
      {RULES.map((r) => {
        const v = now[r.key] ?? 0;
        const ok = v >= r.goal;
        return (
          <div className="check" key={r.key}>
            <span>{r.label}</span>
            <span className="status">
              <span className="dot" style={{ background: ok ? "var(--good)" : "var(--warning)" }} />
              {r.key === "amount" ? `${eok(v)} / ${eok(r.goal)}` : `${v} / ${r.goal}${r.unit}`}
              <span className="muted">{ok ? "충족" : "미충족"}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function Performance() {
  const state = useJson("performance.json");
  return (
    <Loading state={state}>
      {(d) => {
        if (d.status !== "live") {
          return (
            <div className="grid two">
              <div className="card empty">
                <strong>{d.start} 매매 시작 예정</strong>
                한국투자증권 모의투자 계좌의 평가금액과 거래 내역이 매일 장 마감 후 여기에 표시돼요.
              </div>
              <Eligibility now={{}} />
            </div>
          );
        }
        const eq = d.equity;
        const last = eq[eq.length - 1];
        const fills = d.trades.length;
        return (
          <>
            <div className="grid tiles">
              <Tile label="누적 수익률" value={<Pct v={last.equity_idx - 100} digits={2} />} note={`${d.start} 시작, 원금 1억`} />
              <Tile label="평가금액" value={`${won(last.equity)}원`} note={last.date} />
              <Tile label="코스피 대비" value={<Pct v={last.equity_idx - last.kospi_idx} digits={2} />}
                note={`같은 기간 코스피 ${(last.kospi_idx - 100).toFixed(2)}%`} />
              <Tile label="거래금액" value={`${eok(d.traded_total)}원`} note={`${d.traded_days}일 · ${d.traded_codes}종목`} />
            </div>
            <div className="grid two section">
              <div className="card">
                <h2>수익률 추이</h2>
                <p className="sub">시작일 = 100</p>
                <LineChartBox data={eq} series={[{ key: "equity_idx", name: "우리 계좌" }, { key: "kospi_idx", name: "코스피" }]} />
              </div>
              <Eligibility now={{ days: d.traded_days, amount: d.traded_total, codes: d.traded_codes, fills }} />
            </div>
            <div className="card">
              <h2>거래 내역</h2>
              <div className="table-wrap">
                <table>
                  <thead><tr><th className="l">날짜</th><th className="l">구분</th><th className="l">종목</th><th>수량</th><th>가격</th><th>금액</th></tr></thead>
                  <tbody>
                    {d.trades.map((t, i) => (
                      <tr key={i}>
                        <td className="l">{t.date}</td>
                        <td className="l"><span className={`badge ${t.side}`}>{t.side === "buy" ? "매수" : "매도"}</span></td>
                        <td className="l"><StockLink code={t.code} name={t.name} /></td>
                        <td className="num">{won(t.shares)}</td>
                        <td className="num">{won(t.price)}</td>
                        <td className="num">{eok(t.amount)}원</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        );
      }}
    </Loading>
  );
}
