import { useEffect, useState } from "react";
import { ColorContext, readColors } from "./chart.jsx";
import Account from "./pages/Account.jsx";
import Guide from "./pages/Guide.jsx";
import Live from "./pages/Live.jsx";
import Market from "./pages/Market.jsx";
import Paper from "./pages/Paper.jsx";
import Performance from "./pages/Performance.jsx";
import Research from "./pages/Research.jsx";
import Stock from "./pages/Stock.jsx";
import Today from "./pages/Today.jsx";
import StockSearch from "./search.jsx";
import { IndexTicker, MarketClock, PaperMatcher, WatchSide } from "./shell.jsx";
import { Toaster } from "./ui.jsx";

const TABS = [
  { key: "today", label: "홈", Page: Today },
  { key: "paper", label: "모의투자", Page: Paper },
  { key: "account", label: "내 계좌", Page: Account },
  { key: "live", label: "실시간 순위", Page: Live },
  { key: "market", label: "시장·공포지수", Page: Market },
  { key: "performance", label: "AI 실전 성과", Page: Performance },
  { key: "research", label: "백테스트·연구", Page: Research },
  { key: "guide", label: "API 연결 가이드", Page: Guide },
];

// #탭 또는 #stock/종목코드
const tabFromHash = () => {
  const h = window.location.hash;
  if (h.startsWith("#stock/")) return h.slice(1);
  return TABS.find((t) => `#${t.key}` === h)?.key ?? "today";
};

function storedTheme() {
  try { return localStorage.getItem("theme"); } catch { return null; }
}

export default function App() {
  const [tab, setTab] = useState(tabFromHash);
  const [theme, setTheme] = useState(storedTheme);
  const [colors, setColors] = useState(readColors);

  useEffect(() => {
    const onHash = () => { setTab(tabFromHash()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try { theme ? localStorage.setItem("theme", theme) : localStorage.removeItem("theme"); } catch { /* 저장 불가 무시 */ }
    setColors(readColors());
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setColors(readColors());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const dark = theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  const stockCode = tab.startsWith("stock/") ? tab.slice(6) : null;
  const Page = TABS.find((t) => t.key === tab)?.Page;

  return (
    <ColorContext.Provider value={colors}>
      <PaperMatcher />
      <Toaster />
      <div className="bg-deco" aria-hidden="true" />
      <header className="topbar">
        <div className="topbar-in">
          <a className="brand" href="#today" aria-label="Stock AI 처음 화면">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17l5-6 4 4 8-10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
            <span>Stock AI</span>
          </a>
          <StockSearch />
          <div className="topbar-right">
            <MarketClock />
            <button className="icon-btn" onClick={() => setTheme(dark ? "light" : "dark")} aria-label="테마 바꾸기">
              {dark ? "☀ 라이트" : "☾ 다크"}
            </button>
          </div>
        </div>
        <IndexTicker />
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key}
              onClick={() => { window.location.hash = t.key; }}>
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <div className="app">
        <main className="main">{stockCode ? <Stock code={stockCode} /> : <Page />}</main>
        <WatchSide current={stockCode} />
      </div>
      <p className="foot">
        2026-2 인공지능서비스개발 II 팀 프로젝트 · 시세 출처 네이버 증권(지연될 수 있음) · 투자 권유가 아닌 연구·학습용 화면이에요.
      </p>
    </ColorContext.Provider>
  );
}
