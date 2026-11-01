import { useEffect, useState } from "react";
import { ColorContext, readColors } from "./chart.jsx";
import Account from "./pages/Account.jsx";
import Live from "./pages/Live.jsx";
import Market from "./pages/Market.jsx";
import Performance from "./pages/Performance.jsx";
import Research from "./pages/Research.jsx";
import Stock from "./pages/Stock.jsx";
import Today from "./pages/Today.jsx";

const TABS = [
  { key: "today", label: "오늘의 추천", Page: Today },
  { key: "account", label: "계좌 현황", Page: Account },
  { key: "performance", label: "실전 성과", Page: Performance },
  { key: "market", label: "시장·공포지수", Page: Market },
  { key: "live", label: "실시간 순위", Page: Live },
  { key: "research", label: "백테스트·연구", Page: Research },
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
      <div className="app">
        <header className="header">
          <div>
            <h1>Stock AI 대시보드</h1>
            <p>차트·시장 지표로 351종목 순위를 예측하는 AI · BanKIS 모의투자대회 AI리그</p>
          </div>
          <button className="icon-btn" onClick={() => setTheme(dark ? "light" : "dark")}>
            {dark ? "라이트 모드" : "다크 모드"}
          </button>
        </header>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key}
              onClick={() => { window.location.hash = t.key; }}>
              {t.label}
            </button>
          ))}
        </nav>
        <main>{stockCode ? <Stock code={stockCode} /> : <Page />}</main>
        <p className="foot">2026-2 인공지능서비스개발 II 팀 프로젝트 · 투자 권유가 아닌 연구용 화면이에요.</p>
      </div>
    </ColorContext.Provider>
  );
}
