import { useState } from "react";
import {
  Change, Loading, Pct, StockLink, Tile, dir, eok, marketLabel, pct, signed, usd, useJson, usePolling, useQuotes, won,
} from "../lib.jsx";
import { usePaper, valuation } from "../paper.js";
import { useMode } from "../strategy.jsx";
import { Flash, Spark, StockAvatar, useSparks } from "../ui.jsx";
import VersusChart from "../versus.jsx";

const INDEX_CODES = ["KOSPI", "KOSDAQ", "KPI200"];
const idx = (v) => v.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------- 시장 요약: 지수 3개 + 공포지수 게이지 ----------
function MarketStrip() {
  const indices = usePolling("/api/quote?index=1", 20_000).data?.indices || [];
  const sparks = useSparks(INDEX_CODES);
  const market = useJson("market.json").data;
  const last = market?.rows?.[market.rows.length - 1];
  return (
    <div className="market-strip">
      {INDEX_CODES.map((code) => {
        const x = indices.find((i) => i.code === code);
        return (
          <div key={code} className={`card index-card ${dir(x?.change)}`}>
            <div className="index-top">
              <span className="index-name">{x?.name ?? code}</span>
              {x && <span className={`index-chg num ${dir(x.change)}`}>{pct(x.ratio, { digits: 2 })}</span>}
            </div>
            <Flash value={x?.price} className={`index-price num ${dir(x?.change)}`}>{x ? idx(x.price) : "–"}</Flash>
            <div className={`num index-diff ${dir(x?.change)}`}>
              {x ? `${x.change > 0 ? "▲" : x.change < 0 ? "▼" : ""} ${idx(Math.abs(x.change))}` : ""}
            </div>
            <Spark points={sparks[code]} base={x ? x.price - x.change : undefined} width={220} height={44} />
          </div>
        );
      })}
      <FearGauge v={last?.fear} cut={market?.fear_high} date={last?.date} vix={last?.vix} />
    </div>
  );
}

function FearGauge({ v, cut, date, vix }) {
  // 공포지수(표준점수)를 -2 ~ +3 범위의 반원 게이지로
  const t = v == null ? 0 : Math.min(Math.max((v + 2) / 5, 0), 1);
  const ang = Math.PI * (1 - t);
  const nx = 60 + 46 * Math.cos(ang);
  const ny = 58 - 46 * Math.sin(ang);
  const high = v != null && v >= cut;
  return (
    <div className="card index-card fear-card">
      <div className="index-top"><span className="index-name">뉴스 공포지수</span><span className="muted" style={{ fontSize: 11 }}>{date}</span></div>
      <svg viewBox="0 0 120 66" className="gauge" aria-hidden="true">
        <defs>
          <linearGradient id="fearg" x1="0" x2="1">
            <stop offset="0" stopColor="#12b886" /><stop offset="0.5" stopColor="#fab005" /><stop offset="1" stopColor="#f03e3e" />
          </linearGradient>
        </defs>
        <path d="M14 58 A46 46 0 0 1 106 58" fill="none" stroke="url(#fearg)" strokeWidth="9" strokeLinecap="round" />
        <line x1="60" y1="58" x2={nx} y2={ny} stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        <circle cx="60" cy="58" r="4.5" fill="currentColor" />
      </svg>
      <div className="gauge-label">
        <b className={high ? "up" : ""}>{v == null ? "–" : v.toFixed(2)}</b>
        <span className={`gauge-tag ${high ? "high" : ""}`}>{high ? "공포 국면" : "보통"}</span>
      </div>
      <small className="muted">VIX {vix?.toFixed(1) ?? "–"} · <a href="#market">자세히</a></small>
    </div>
  );
}

// ---------- AI TOP 3 카드 ----------
function TopCards({ d, quotes, sparks }) {
  return (
    <div className="top3">
      {d.top.slice(0, 3).map((r, i) => {
        const q = quotes[r.code];
        const pctile = 1 - (r.rank - 1) / d.universe_size;
        const C = 2 * Math.PI * 22;
        return (
          <a key={r.code} className={`card top-card medal${i + 1}`} href={`#stock/${r.code}`}>
            <div className="top-head">
              <span className="medal">{r.rank}</span>
              <StockAvatar code={r.code} name={r.name} size={34} />
              <div className="top-name">
                <b>{r.name}</b>
                <span className="muted">{r.code} · {marketLabel(r.market)}</span>
              </div>
              <svg className="ring" viewBox="0 0 52 52" aria-label={`${d.universe_size}종목 중 ${r.rank}위`}>
                <circle cx="26" cy="26" r="22" className="ring-bg" />
                <circle cx="26" cy="26" r="22" className="ring-fg" strokeDasharray={`${C * pctile} ${C}`} transform="rotate(-90 26 26)" />
                <text x="26" y="24" textAnchor="middle" className="ring-t">상위</text>
                <text x="26" y="35" textAnchor="middle" className="ring-v">{Math.max(1, Math.round((1 - pctile) * 100))}%</text>
              </svg>
            </div>
            <div className="top-price">
              <Flash value={q?.price} className={`num ${dir(q?.change)}`}>{q ? won(q.price) : won(r.last_close)}<small>원</small></Flash>
              {q && <Change change={q.change} ratio={q.ratio} />}
            </div>
            <Spark points={sparks[r.code]} base={q ? q.price - q.change : r.last_close} width={300} height={54} />
            <div className="top-meta">
              <span>AI 점수 <b className="num">{r.score.toFixed(4)}</b></span>
              <span>5일 <Pct v={r.ret_5d} ratio /></span>
              <span>RSI <b className="num">{r.rsi_14?.toFixed(0) ?? "–"}</b></span>
            </div>
            <span className="top-cta">차트 보고 모의로 사기 →</span>
          </a>
        );
      })}
    </div>
  );
}

// ---------- 상승·하락 TOP 5 ----------
function Movers() {
  const [type, setType] = useState("up");
  const [market, setMarket] = useState("KOSPI");
  const list = usePolling(`/api/naver?type=${type}&market=${market}&size=6`, 30_000).data?.stocks || [];
  return (
    <div className="card movers">
      <div className="filters" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>지금 많이 움직이는 종목</h2>
        <div className="filters" style={{ margin: 0 }}>
          <div className="seg" role="group" aria-label="상승 하락">
            <button aria-pressed={type === "up"} onClick={() => setType("up")}>상승</button>
            <button aria-pressed={type === "down"} onClick={() => setType("down")}>하락</button>
          </div>
          <div className="seg" role="group" aria-label="시장">
            <button aria-pressed={market === "KOSPI"} onClick={() => setMarket("KOSPI")}>코스피</button>
            <button aria-pressed={market === "KOSDAQ"} onClick={() => setMarket("KOSDAQ")}>코스닥</button>
          </div>
        </div>
      </div>
      <ol className="mover-list">
        {list.map((s) => (
          <li key={s.code}>
            <span className="mover-rank">{s.rank}</span>
            <StockLink code={s.code} name={s.name} />
            <Flash value={s.price} className="num mover-price">{won(s.price)}</Flash>
            <span className={`mover-chip ${dir(s.ratio)}`}>{pct(s.ratio, { digits: 2 })}</span>
          </li>
        ))}
        {!list.length && <li className="muted">불러오는 중…</li>}
      </ol>
      <a className="more" href="#live">실시간 순위 더 보기 →</a>
    </div>
  );
}

// ---------- 내 모의투자 요약 ----------
function MyPaper() {
  const paper = usePaper();
  const quotes = useQuotes(paper ? Object.keys(paper.positions) : [], 15_000);
  if (!paper) {
    return (
      <a className="card my-paper cta" href="#paper">
        <span className="hero-tag">키 없이 바로</span>
        <b>가상 자금으로 모의투자 시작하기</b>
        <span>원하는 금액을 정하고 AI 추천 종목을 실제 시세로 사 보세요.</span>
        <span className="top-cta">시작하기 →</span>
      </a>
    );
  }
  const v = valuation(paper, quotes);
  return (
    <a className={`card my-paper ${dir(v.totalPnl) || "flat"}`} href="#paper">
      <span className="asset-label">내 모의투자</span>
      <Flash value={Math.round(v.total)} className="big-num num">{won(v.total)}<small>원</small></Flash>
      <span className="asset-pnl num"><span className="pill">{signed(Math.round(v.totalPnl))}원</span><span className="pill">{pct(v.totalRatio, { digits: 2 })}</span></span>
      <span className="my-paper-sub">보유 {v.rows.length}종목 · 현금 {eok(v.cash)}원</span>
      <span className="top-cta">자세히 →</span>
    </a>
  );
}

// ---------- 나스닥100 AI 순위 (참고용, 팀 자동매매는 국내만) ----------
function NasdaqPicks() {
  const d = useJson("today_us.json").data;
  const rows = d?.top?.slice(0, 10) || [];
  const quotes = useQuotes(rows.map((r) => r.code), 20_000);
  if (!d) return null;
  return (
    <div className="card section">
      <h2>나스닥100 AI 순위 상위 10 <span className="badge us">참고용</span></h2>
      <p className="sub">
        {d.date} (뉴욕) 예측 · {d.base_close} 종가까지 반영 · 모델 {d.model}(차트+나스닥 지수·VIX), {d.trained_until}까지 학습.
        국내 모델보다 검증 신호가 약해요 (<a href="#research">백테스트</a>). 가격은 달러, <a href="#paper">모의투자</a>에서 원화로 환전해 사고팔 수 있어요.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>순위</th><th className="l">종목</th><th>현재가</th><th>오늘</th><th>점수</th><th>5일</th><th>20일</th><th>RSI</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const q = quotes[r.code];
              return (
                <tr key={r.code}>
                  <td className="num">{r.rank}</td>
                  <td className="l"><StockLink code={r.code} name={r.name} /> <span className="muted">{r.symbol}</span></td>
                  <td className={`num ${dir(q?.change)}`}><Flash value={q?.price}>{usd(q?.price ?? r.last_close)}</Flash></td>
                  <td>{q ? <Change ratio={q.ratio} change={q.change} arrowOnly /> : "–"}</td>
                  <td className="num">{r.score.toFixed(4)}</td>
                  <td><Pct v={r.ret_5d} ratio /></td>
                  <td><Pct v={r.ret_20d} ratio /></td>
                  <td className="num">{r.rsi_14?.toFixed(0) ?? "–"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Today() {
  const state = useJson("today.json");
  const mode = useMode().data?.mode;
  const codes = (state.data?.top || []).map((t) => t.code);
  const quotes = useQuotes(codes, 15_000);
  const sparks = useSparks(codes.slice(0, 3));
  return (
    <>
      <MarketStrip />
      <Loading state={state}>
        {(d) => (
          <>
            <div className="section-title">
              <h2>오늘의 AI TOP 3</h2>
              <span className="muted">{d.date} 예측 · {d.universe_size}종목 중 다음 거래일 수익률 순위 · 모델 {d.model}</span>
            </div>
            <TopCards d={d} quotes={quotes} sparks={sparks} />

            <div className="home-grid">
              <Movers />
              <div className="home-side">
                <MyPaper />
                <div className="card vs-card">
                  <h2>나 vs AI vs 코스피</h2>
                  <p className="sub">누적 수익률 비교</p>
                  <VersusChart height={190} />
                </div>
              </div>
            </div>

            <div className="card section">
              <h2>AI 종목 순위 상위 {d.top.length}</h2>
              <p className="sub">
                점수 = 다음 거래일 시가→시가 수익률이 {d.universe_size}종목 중 몇 번째일지 예측한 값 (0.5 = 중간). 현재가는 실시간, 1·5·20일 수익률은 기준 종가까지.
                종목을 누르면 차트와 함께 <a href="#paper">모의투자</a>로 바로 사 볼 수 있어요.
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>순위</th><th className="l">종목</th><th>현재가</th><th>오늘</th><th>점수</th><th>기준 종가</th>
                      <th>1일</th><th>5일</th><th>20일</th><th>RSI</th><th>거래량 배수</th><th className="l">매수</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.top.map((r) => (
                      <tr key={r.code}>
                        <td className="num">{r.rank}</td>
                        <td className="l"><StockLink code={r.code} name={r.name} /><span className="badge">{marketLabel(r.market)}</span></td>
                        <td className={`num ${dir(quotes[r.code]?.change)}`}><Flash value={quotes[r.code]?.price}>{won(quotes[r.code]?.price)}</Flash></td>
                        <td>{quotes[r.code] ? <Change change={quotes[r.code].change} ratio={quotes[r.code].ratio} arrowOnly /> : "–"}</td>
                        <td className="num">{r.score.toFixed(4)}</td>
                        <td className="num">{won(r.last_close)}</td>
                        <td><Pct v={r.ret_1d} ratio /></td>
                        <td><Pct v={r.ret_5d} ratio /></td>
                        <td><Pct v={r.ret_20d} ratio /></td>
                        <td className="num">{r.rsi_14?.toFixed(0) ?? "–"}</td>
                        <td className="num">{r.vol_ratio_20?.toFixed(2) ?? "–"}</td>
                        <td className="l">{r.buyable ? "가능" : <span className="muted">거래대금 부족</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <NasdaqPicks />

            <div className="grid tiles">
              <Tile label="예측일" value={d.date} note={`${d.base_close} 종가까지 반영`} />
              <Tile label="모델" value={`모델 ${d.model}`} note={`차트 + 시장 피처, ${d.trained_until}까지 학습`} />
              <Tile label="전략" value={`${d.strategy.name ?? "AI 추세"}${d.strategy.slots && mode ? ` · ${d.strategy.slots[mode]}종목` : ""}`}
                note={d.strategy.market
                  ? <>코스피 {won(d.strategy.market.kospi)} {d.strategy.market.ok ? "≥" : "<"} {d.strategy.market_ma}일선 {won(d.strategy.market.kospi_ma)} · {d.strategy.market.ok ? "매수 가능" : "새 매수 쉼"}</>
                  : `종가 > ${d.strategy.ma}일선 > ${d.strategy.ma_long}일선 종목 중 AI 순`} />
              <Tile label="매수 가능 종목" value={`${d.buyable} / ${d.universe_size}`}
                note={`20일 평균 거래대금 ${eok(d.strategy.min_value_krw)} 이상`} />
            </div>

            <div className="card section">
              <h2>팀 AI 계좌 오늘의 주문{mode && <span className="badge">{mode === "aggressive" ? "공격형" : "안정형"} 기준</span>}</h2>
              <p className="sub">
                매도는 08:30~09:00 동시호가에 시장가, 매수는 09:00 직후 지정가. 수량은 전일 종가 기준이라 체결 금액은 조금 달라질 수 있어요.
                손절선 매도는 장중에 따로 나가요.
              </p>
              {d.orders.length === 0 ? (
                <div className="empty">주문 없음 — 보유 종목을 그대로 유지해요{d.strategy.market && !d.strategy.market.ok ? " (코스피가 60일선 아래라 새로 사지 않아요)" : ""}</div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr><th className="l">구분</th><th className="l">종목</th><th>순위</th><th>수량</th><th>기준가</th><th>금액</th><th className="l">이유</th></tr>
                    </thead>
                    <tbody>
                      {d.orders.map((o) => (
                        <tr key={o.action + o.code}>
                          <td className="l"><span className={`badge ${o.action}`}>{o.action === "buy" ? "매수" : "매도"}</span></td>
                          <td className="l"><StockLink code={o.code} name={o.name} /><span className="badge">{marketLabel(o.market)}</span></td>
                          <td className="num">{o.rank}</td>
                          <td className="num">{won(o.shares)}주</td>
                          <td className="num">{won(o.ref_price)}</td>
                          <td className="num">{eok(o.amount)}원</td>
                          <td className="l muted" style={{ fontSize: 12 }}>{o.reason || ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </Loading>
    </>
  );
}
