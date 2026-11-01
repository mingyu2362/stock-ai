import { createContext, useContext } from "react";
import {
  CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";

// 차트 색은 CSS 변수에서 읽어 온다 (테마가 바뀌면 App 이 다시 읽어 내려줌)
export const ColorContext = createContext({});

export function readColors() {
  const s = getComputedStyle(document.documentElement);
  const get = (n) => s.getPropertyValue(n).trim();
  return {
    series: [get("--series-1"), get("--series-2"), get("--series-3")],
    grid: get("--grid"), axis: get("--axis"), muted: get("--muted"), text2: get("--text-2"),
    surface: get("--surface"), shade: get("--shade"), critical: get("--critical"),
    up: get("--up"), down: get("--down"), upSoft: `${get("--up")}66`, downSoft: `${get("--down")}66`,
  };
}

const shortDate = (d) => `${d.slice(2, 4)}.${d.slice(5, 7)}${d.length > 7 ? "." + d.slice(8, 10) : ""}`;

function TipBox({ active, payload, label, series, format }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip">
      <div className="t">{label}</div>
      {series.map((s, i) => {
        const p = payload.find((x) => x.dataKey === s.key);
        if (!p || p.value == null) return null;
        return (
          <div className="row" key={s.key}>
            <i style={{ background: s.color }} />
            <b>{format(p.value)}</b>
            <span>{s.name}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 한 축 선 차트. series: [{key, name, short?}] (색은 순서대로 고정 슬롯, short 는 선 끝 라벨용)
 * shade: {from, to, label} 기간 음영, refY: [{y, label}] 가로 기준선 (라벨은 선과 겹치므로 설명 문구에 적는다)
 */
export function LineChartBox({ data, series, height = 260, format = (v) => v.toFixed(1),
  yFormat = format, shade, refY = [], endLabels = series.length > 1 }) {
  const c = useContext(ColorContext);
  const colored = series.map((s, i) => ({ ...s, color: c.series?.[i] }));
  const last = data.length - 1;

  const endLabel = (s) => (props) => {
    const { x, y, index, value } = props;
    if (index !== last || value == null) return null;
    return (
      <text x={x + 6} y={y} dy={4} fontSize={11} fill={c.text2}>
        {s.short ?? s.name} {format(value)}
      </text>
    );
  };

  return (
    <>
      {series.length > 1 && (
        <div className="legend">
          {colored.map((s) => (
            <span key={s.key}><i style={{ background: s.color }} />{s.name}</span>
          ))}
        </div>
      )}
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: endLabels ? 96 : 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={c.grid} vertical={false} />
          <XAxis dataKey="date" tickFormatter={shortDate} stroke={c.axis} tick={{ fill: c.muted, fontSize: 11 }}
            minTickGap={40} tickLine={false} />
          <YAxis tickFormatter={yFormat} stroke={c.axis} tick={{ fill: c.muted, fontSize: 11 }}
            width={56} tickLine={false} axisLine={false} domain={["auto", "auto"]} />
          {shade && (
            <ReferenceArea x1={shade.from} x2={shade.to} fill={c.shade} stroke="none" ifOverflow="hidden"
              label={{ value: shade.label, position: "insideTopLeft", fill: c.muted, fontSize: 11 }} />
          )}
          {refY.map((r) => (
            <ReferenceLine key={r.label} y={r.y} stroke={c.muted} strokeWidth={1} />
          ))}
          <Tooltip cursor={{ stroke: c.axis, strokeWidth: 1 }}
            content={<TipBox series={colored} format={format} />} isAnimationActive={false} />
          {colored.map((s) => (
            <Line key={s.key} dataKey={s.key} name={s.name} stroke={s.color} strokeWidth={2} dot={false}
              activeDot={{ r: 4, stroke: c.surface, strokeWidth: 2 }} isAnimationActive={false}
              strokeLinecap="round" strokeLinejoin="round" connectNulls
              label={endLabels ? endLabel(s) : false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}
