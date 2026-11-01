import { useState } from "react";
import { LineChartBox } from "../chart.jsx";
import { Loading, Pct, Tile, useJson } from "../lib.jsx";

const RANGES = [
  { key: "contest", label: "대회 기간" },
  { key: "3m", label: "3개월" },
  { key: "6m", label: "6개월" },
  { key: "all", label: "2025~" },
];

function slice(rows, range, contest) {
  if (range === "all") return rows;
  if (range === "contest") return rows.filter((r) => r.date >= contest[0]);
  const months = range === "3m" ? 3 : 6;
  const end = new Date(rows[rows.length - 1].date);
  end.setMonth(end.getMonth() - months);
  const from = end.toISOString().slice(0, 10);
  return rows.filter((r) => r.date >= from);
}

function FearStatus({ v, cut }) {
  const high = v >= cut;
  return (
    <span className="status">
      <span className="dot" style={{ background: high ? "var(--critical)" : "var(--good)" }} />
      {high ? "공포 국면" : "보통"}
    </span>
  );
}

export default function Market() {
  const state = useJson("market.json");
  const [range, setRange] = useState("6m");
  return (
    <Loading state={state}>
      {(d) => {
        const rows = d.rows;
        const last = rows[rows.length - 1];
        const prev = rows[rows.length - 2];
        const view = slice(rows, range, d.contest);
        const shade = { from: d.contest[0], to: view[view.length - 1].date, label: "대회 기간" };
        return (
          <>
            <div className="grid tiles">
              <Tile label="코스피" value={last.kospi.toLocaleString("ko-KR")}
                note={<><Pct v={(last.kospi / prev.kospi - 1) * 100} digits={2} /> · {last.date}</>} />
              <Tile label="코스닥" value={last.kosdaq.toLocaleString("ko-KR")}
                note={<Pct v={(last.kosdaq / prev.kosdaq - 1) * 100} digits={2} />} />
              <Tile label="뉴스 공포지수 (3일)" value={last.fear?.toFixed(2) ?? "–"}
                note={<FearStatus v={last.fear} cut={d.fear_high} />} />
              <Tile label="미국 VIX" value={last.vix?.toFixed(1) ?? "–"} note="전날 미국 장 마감 기준" />
            </div>

            <div className="filters">
              <div className="seg" role="group" aria-label="기간">
                {RANGES.map((r) => (
                  <button key={r.key} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>{r.label}</button>
                ))}
              </div>
            </div>

            <div className="grid two">
              <div className="card">
                <h2>코스피 지수</h2>
                <p className="sub">종가</p>
                <LineChartBox data={view} series={[{ key: "kospi", name: "코스피" }]}
                  format={(v) => v.toLocaleString("ko-KR", { maximumFractionDigits: 0 })} shade={shade} />
              </div>
              <div className="card">
                <h2>뉴스 공포지수</h2>
                <p className="sub">
                  시장 뉴스 6개 키워드의 FinBert 부정 비율과 공포 단어 비율 (학습 기간 평균 0, 단위 표준편차). 기준선 위 = 상위 20% 공포 국면
                </p>
                <LineChartBox data={view} series={[{ key: "fear", name: "공포지수" }]}
                  format={(v) => v.toFixed(2)} shade={shade} refY={[{ y: d.fear_high, label: "공포 국면 기준" }]} />
              </div>
            </div>
            <p className="foot">
              공포지수는 다음 날 코스피 방향은 예측하지 못하지만(상관 0.03), 다음 날 변동폭과 VIX와는 함께 움직여요(VIX 상관 0.34).
            </p>
          </>
        );
      }}
    </Loading>
  );
}
