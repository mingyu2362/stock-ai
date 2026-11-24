// 화면 틀: 지수 티커, 장 상태 시계, 관심종목 사이드바, 모의투자 미체결 확인기
import { useEffect, useState } from "react";
import { Change, dir, fmtPrice, marketPhase, pct, useJson, usePolling, useQuotes, won } from "./lib.jsx";
import { matchOrders, recordValue, usePaper, valuation } from "./paper.js";
import { Flash, Spark, StockAvatar, useSparks } from "./ui.jsx";
import { toggleWatch, useWatch } from "./watch.js";

const idx = (v) => v.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function MarketClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const phase = marketPhase();
  const time = new Date(now).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
  return (
    <div className={`clock ${phase.key}`} title="한국 시간 기준">
      <i className="dot" />
      <span>{phase.label}</span>
      <span className="num muted">{time}</span>
    </div>
  );
}

export function IndexTicker() {
  const { data } = usePolling("/api/quote?index=1", 20_000);
  const paper = usePaper();
  const codes = paper ? Object.keys(paper.positions) : [];
  const quotes = useQuotes(codes, 20_000);
  const v = paper && valuation(paper, quotes);
  // 보유 종목 시세를 다 받았을 때 오늘 총자산을 기록 (나 vs AI 그래프용)
  const ready = !!paper && codes.every((c) => quotes[c]);
  useEffect(() => { if (ready) recordValue(v.total); }, [ready, v?.total]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ticker" aria-label="주요 지수">
      {[...(data?.indices || [{ code: "KOSPI", name: "코스피" }, { code: "KOSDAQ", name: "코스닥" }, { code: "KPI200", name: "코스피 200" }]),
        ...(data?.world || []).filter((x) => x.code !== ".IXIC")]
        .map((x) => (
          <div className={`tick ${dir(x.change)} ${x.code === "USDKRW" ? "tick-fx" : ""}`} key={x.code}>
            <span className="tick-name">{x.name}</span>
            <Flash value={x.price} className={`num tick-price ${dir(x.change)}`}>{x.price ? idx(x.price) : "–"}</Flash>
            {x.price ? (
              <span className={`num ${dir(x.change)}`}>
                {x.change > 0 ? "▲" : x.change < 0 ? "▼" : ""}{idx(Math.abs(x.change))} {pct(x.ratio, { digits: 2 })}
              </span>
            ) : null}
          </div>
        ))}
      <a className="tick tick-paper" href="#paper">
        <span className="tick-name">내 모의투자</span>
        {v ? (
          <>
            <Flash value={Math.round(v.total)} className="num tick-price">{won(v.total)}원</Flash>
            <span className={`num ${dir(v.totalPnl)}`}>{pct(v.totalRatio, { digits: 2 })}</span>
          </>
        ) : <b className="accent-text">시작하기 →</b>}
      </a>
    </div>
  );
}

// 미체결 지정가 주문을 시세로 확인 (어느 화면에 있든 앱이 열려 있으면 동작)
export function PaperMatcher() {
  const paper = usePaper();
  const codes = [...new Set((paper?.orders || []).map((o) => o.code))];
  const quotes = useQuotes(codes, 10_000);
  useEffect(() => {
    if (Object.keys(quotes).length || paper?.orders.length) matchOrders(quotes);
  }, [quotes]);   // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// 관심종목 + 모의투자 보유 종목 실시간 시세. 관심종목이 비면 오늘 AI 상위 종목을 추천
export function WatchSide({ current }) {
  const watch = useWatch();
  const paper = usePaper();
  const today = useJson("today.json").data;
  const [tab, setTab] = useState("watch");
  const held = paper ? Object.entries(paper.positions).map(([code, p]) => ({ code, name: p.name })) : [];
  const suggest = !watch.length ? (today?.top || []).slice(0, 5).map((t) => ({ code: t.code, name: t.name, rank: t.rank })) : [];
  const list = tab === "watch" ? (watch.length ? watch : suggest) : held;
  const quotes = useQuotes([...watch, ...held, ...suggest].map((x) => x.code), 15_000);
  const sparks = useSparks(list.map((x) => x.code).slice(0, 20));

  return (
    <aside className="side card" aria-label="관심종목">
      <div className="seg seg-full" role="group">
        <button aria-pressed={tab === "watch"} onClick={() => setTab("watch")}>관심종목 {watch.length || ""}</button>
        <button aria-pressed={tab === "held"} onClick={() => setTab("held")}>모의 보유 {held.length || ""}</button>
      </div>
      {tab === "watch" && !watch.length && (
        <p className="side-hint">☆ 를 눌러 관심종목을 담아 보세요. 아래는 오늘 AI 상위 종목이에요.</p>
      )}
      {tab === "held" && !held.length && (
        <p className="side-hint">모의투자로 산 종목이 여기에 보여요. <a href="#paper">모의투자 시작 →</a></p>
      )}
      <ul className="watch">
        {list.map((x) => {
          const q = quotes[x.code];
          const watched = watch.some((w) => w.code === x.code);
          return (
            <li key={x.code} className={current === x.code ? "on" : ""}>
              <button className={`star ${watched ? "on" : ""}`} aria-label={watched ? "관심종목 해제" : "관심종목 추가"}
                onClick={() => toggleWatch(x.code, x.name)}>{watched ? "★" : "☆"}</button>
              <a href={`#stock/${x.code}`}>
                <StockAvatar code={x.code} name={x.name} size={28} />
                <span className="w-name">{x.name}{x.rank && <span className="w-rank">AI {x.rank}위</span>}</span>
                <Spark points={sparks[x.code]} base={q ? q.price - q.change : undefined} width={44} height={22} fill={false} />
                <span className="w-price">
                  <Flash value={q?.price} className={`num ${dir(q?.change)}`}><b>{q ? fmtPrice(q.price, x.code) : "–"}</b></Flash>
                  {q && <Change ratio={q.ratio} change={q.change} arrowOnly />}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
