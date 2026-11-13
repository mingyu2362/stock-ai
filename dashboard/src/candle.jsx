import { useContext, useEffect, useRef, useState } from "react";
import {
  CandlestickSeries, createChart, CrosshairMode, HistogramSeries, LineSeries, LineStyle,
} from "lightweight-charts";
import { ColorContext } from "./chart.jsx";
import { won } from "./lib.jsx";

// TradingView 오픈소스 Lightweight Charts 로 그리는 캔들 차트 (위: 가격·이동평균, 아래: 거래량)
// 끌어서 이동, 휠로 확대·축소, 십자선 위치의 시고저종을 왼쪽 위에 표시
// holding 을 주면 평단가·손절선을 가로선으로 긋고 평가손익을 표시 ({ avg, shares, price, pnl, ratio, stop?, stopWhy? })

const MAS = [5, 20, 60];
const DEFAULT_BARS = { day: 120, week: 104, month: 120, minute: 390, minute5: 156, minute10: 117, minute30: 65, minute60: 67 };
const isIntraday = (interval) => interval.startsWith("minute");

// 분봉 time 은 한국 시각을 UTC로 둔 초 단위 숫자
const fmtTime = (t) => {
  if (typeof t !== "number") return t;
  const d = new Date(t * 1000).toISOString();
  return `${d.slice(5, 10)} ${d.slice(11, 16)}`;
};

function movingAverage(candles, n) {
  const out = [];
  let sum = 0;
  candles.forEach((c, i) => {
    sum += c.close;
    if (i >= n) sum -= candles[i - n].close;
    if (i >= n - 1) out.push({ time: c.time, value: sum / n });
  });
  return out;
}

const fmtVol = (v) => (v >= 1e8 ? `${(v / 1e8).toFixed(1)}억` : v >= 1e4 ? `${Math.round(v / 1e4).toLocaleString("ko-KR")}만` : won(v));

const signed = (v, digits) => `${v > 0 ? "+" : ""}${digits == null ? won(v) : v.toFixed(digits)}`;
const dirOf = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");

export default function CandleChart({ candles, interval, holding, height = 440 }) {
  const c = useContext(ColorContext);
  const box = useRef(null);
  const api = useRef(null);
  const levels = useRef([]);   // 평단가·손절선: 캔들 범위 밖이어도 보이도록 세로 범위에 포함
  const [hover, setHover] = useState(null);

  // 차트 한 번 생성
  useEffect(() => {
    const chart = createChart(box.current, {
      autoSize: true,
      crosshair: { mode: CrosshairMode.Normal },
      localization: { locale: "ko-KR", dateFormat: "yyyy-MM-dd" },
      timeScale: { rightOffset: 4, borderVisible: false },
      rightPriceScale: { borderVisible: false },
      layout: { attributionLogo: true, fontSize: 11 },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      borderVisible: false, priceLineVisible: false, priceFormat: { type: "custom", formatter: won, minMove: 1 },
      autoscaleInfoProvider: (original) => {
        const r = original();
        if (!r?.priceRange || !levels.current.length) return r;
        return {
          ...r,
          priceRange: {
            minValue: Math.min(r.priceRange.minValue, ...levels.current),
            maxValue: Math.max(r.priceRange.maxValue, ...levels.current),
          },
        };
      },
    });
    const mas = MAS.map(() => chart.addSeries(LineSeries, {
      lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    }));
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "custom", formatter: fmtVol }, priceLineVisible: false, lastValueVisible: false,
    }, 1);
    chart.panes()[0].setStretchFactor(3);
    chart.panes()[1].setStretchFactor(1);
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } });

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) return setHover(null);
      setHover({
        bar: param.seriesData.get(candle),
        mas: mas.map((s) => param.seriesData.get(s)?.value),
        volume: param.seriesData.get(volume)?.value,
      });
    });
    api.current = { chart, candle, mas, volume, lines: [] };
    return () => { chart.remove(); api.current = null; };
  }, []);

  // 테마 색
  useEffect(() => {
    const a = api.current;
    if (!a || !c.surface) return;
    a.chart.applyOptions({
      layout: { background: { color: c.surface }, textColor: c.muted, panes: { separatorColor: c.grid } },
      grid: { vertLines: { visible: false }, horzLines: { color: c.grid } },
      crosshair: { vertLine: { color: c.axis, labelBackgroundColor: c.text2 }, horzLine: { color: c.axis, labelBackgroundColor: c.text2 } },
    });
    a.candle.applyOptions({ upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
    a.mas.forEach((s, i) => s.applyOptions({ color: c.series[i] }));
  }, [c]);

  // 데이터 (거래량 막대 색은 그날 양봉·음봉을 따름)
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.candle.setData(candles);
    a.mas.forEach((s, i) => s.setData(movingAverage(candles, MAS[i])));
    a.volume.setData(candles.map((k) => ({
      time: k.time, value: k.volume, color: k.close >= k.open ? c.upSoft : c.downSoft,
    })));
  }, [candles, c]);

  // 평단가·손절선
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    a.lines.forEach((l) => a.candle.removePriceLine(l));
    a.lines = [];
    levels.current = [];
    if (!holding) return;
    const line = (price, color, title) => {
      a.lines.push(a.candle.createPriceLine({
        price, color, title, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true,
      }));
      levels.current.push(price);
    };
    line(holding.avg, c.text2, `평단 ${signed(holding.ratio, 2)}%`);
    if (holding.stop) line(holding.stop, c.warning, "손절");
  }, [holding?.avg, holding?.stop, holding?.ratio, c]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 분봉이면 시간축에 시:분 표시
  useEffect(() => {
    api.current?.chart.applyOptions({ timeScale: { timeVisible: isIntraday(interval), secondsVisible: false } });
  }, [interval]);

  // 종목·봉 주기가 바뀔 때만 기본 구간으로 (자동 갱신 때는 보던 구간 유지)
  const first = candles[0]?.time;
  useEffect(() => {
    const a = api.current;
    if (!a || !candles.length) return;
    const n = candles.length;
    const bars = Math.min(DEFAULT_BARS[interval], Math.floor(box.current.clientWidth / 7));   // 봉 하나에 7px 이상
    a.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - bars), to: n + 3 });
  }, [interval, first]);   // eslint-disable-line react-hooks/exhaustive-deps

  const last = candles[candles.length - 1];
  const prevClose = (bar) => {
    const i = candles.findIndex((k) => k.time === bar.time);
    return i > 0 ? candles[i - 1].close : null;
  };
  const bar = hover?.bar ?? last;
  const mas = hover?.mas ?? MAS.map((n) => movingAverage(candles.slice(-n), n)[0]?.value);
  const vol = hover?.volume ?? last?.volume;
  const pc = bar && prevClose(bar);
  const chg = pc ? (bar.close / pc - 1) * 100 : null;
  const dirClass = chg > 0 ? "up" : chg < 0 ? "down" : "";

  return (
    <div className="candle">
      {bar && (
        <div className="candle-legend">
          <div>
            <span className="muted">{fmtTime(bar.time)}</span>
            {[["시", bar.open], ["고", bar.high], ["저", bar.low], ["종", bar.close]].map(([k, v]) => (
              <span key={k}><span className="muted">{k}</span> <b className={dirClass}>{won(v)}</b></span>
            ))}
            {chg != null && <b className={dirClass}>{chg > 0 ? "+" : ""}{chg.toFixed(2)}%</b>}
            <span><span className="muted">거래량</span> {fmtVol(vol)}</span>
          </div>
          <div>
            {MAS.map((n, i) => (
              <span key={n}>
                <i style={{ background: c.series?.[i] }} />
                <span className="muted">MA{n}</span> {mas[i] != null ? won(mas[i]) : "–"}
              </span>
            ))}
          </div>
          {holding && (
            <div>
              <span><span className="muted">보유</span> {won(holding.shares)}주</span>
              <span><i style={{ background: c.text2 }} /><span className="muted">평단</span> {won(holding.avg)}</span>
              <span>
                <span className="muted">평가손익</span>{" "}
                <b className={dirOf(holding.pnl)}>{signed(Math.round(holding.pnl))}원 ({signed(holding.ratio, 2)}%)</b>
              </span>
              {holding.stop && (
                <span title={holding.stopWhy}>
                  <i style={{ background: c.warning }} /><span className="muted">손절</span> {won(holding.stop)}
                  <span className="muted"> (현재가 {signed((holding.stop / holding.price - 1) * 100, 1)}%)</span>
                </span>
              )}
            </div>
          )}
        </div>
      )}
      <div ref={box} style={{ height }} />
    </div>
  );
}
