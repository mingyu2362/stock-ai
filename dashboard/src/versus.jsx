// 나(모의투자) vs AI(팀 실전 모의계좌) vs 코스피 — 누적 수익률 비교
import { LineChartBox } from "./chart.jsx";
import { dir, pct, usePolling, useJson } from "./lib.jsx";
import { usePaper } from "./paper.js";

const TEAM_START_CASH = 100_000_000;

export default function VersusChart({ height = 240 }) {
  const perf = useJson("performance.json").data;
  const paper = usePaper();
  const aiRows = (perf?.equity || []).filter((r) => r.equity);
  const myHist = paper?.history || [];
  const starts = [aiRows[0]?.date, myHist[0]?.date].filter(Boolean).sort();
  const start = starts[0];
  const kospi = usePolling(start ? `/api/quote?daily=KOSPI&from=${start.replace(/-/g, "")}` : null, 600_000, { always: true }).data?.daily || [];

  if (!start) return <div className="empty small">비교할 기록이 아직 없어요.</div>;

  const byDate = new Map();
  const row = (date) => {
    if (!byDate.has(date)) byDate.set(date, { date });
    return byDate.get(date);
  };
  const k0 = kospi.find((r) => r.date >= start)?.close;
  for (const r of kospi) if (r.date >= start && k0) row(r.date).kospi = (r.close / k0 - 1) * 100;
  for (const r of aiRows) row(r.date).ai = (r.equity / TEAM_START_CASH - 1) * 100;
  for (const h of myHist) row(h.date).me = (h.total / paper.startCash - 1) * 100;
  const data = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  const lastOf = (key) => [...data].reverse().find((r) => r[key] != null)?.[key];
  const stats = [
    { key: "me", name: "나 (모의투자)", v: lastOf("me"), note: paper ? `${myHist[0].date} 시작` : "아직 시작 안 함" },
    { key: "ai", name: "AI (팀 계좌)", v: lastOf("ai"), note: aiRows.length ? `${aiRows[0].date} ~ ${aiRows[aiRows.length - 1].date}` : "기록 없음" },
    { key: "kospi", name: "코스피", v: lastOf("kospi"), note: `${start} 대비` },
  ];
  const best = stats.filter((s) => s.v != null).sort((a, b) => b.v - a.v)[0];

  return (
    <>
      <div className="vs-stats">
        {stats.map((s, i) => (
          <div key={s.key} className={`vs-stat s${i + 1} ${best?.key === s.key ? "best" : ""}`}>
            <span>{s.name}{best?.key === s.key && <em>1위</em>}</span>
            <b className={`num ${dir(s.v)}`}>{s.v == null ? "–" : pct(s.v, { digits: 2 })}</b>
            <small>{s.note}</small>
          </div>
        ))}
      </div>
      <LineChartBox data={data} height={height} format={(v) => pct(v, { digits: 1 })} yFormat={(v) => `${v.toFixed(0)}%`}
        series={[{ key: "me", name: "나", short: "나" }, { key: "ai", name: "AI", short: "AI" }, { key: "kospi", name: "코스피", short: "코스피" }]}
        refY={[{ y: 0, label: "시작" }]} />
      {myHist.length < 2 && (
        <p className="fine">내 선은 모의투자를 하루 이상 하면 그려져요. 이 사이트를 열 때마다 그날 총자산이 기록돼요.</p>
      )}
    </>
  );
}
