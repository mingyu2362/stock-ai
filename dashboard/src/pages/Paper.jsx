import { useState } from "react";
import { Change, dir, marketPhase, pct, signed, StockLink, Tile, useJson, useQuotes, won } from "../lib.jsx";
import { korMoney, StartPaperForm } from "../order.jsx";
import { cancelOrder, FEE, resetPaper, TAX, usePaper, valuation } from "../paper.js";
import { Flash } from "../ui.jsx";
import VersusChart from "../versus.jsx";

const fmtTime = (iso) => new Date(iso).toLocaleString("ko-KR", {
  timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

export default function Paper() {
  const paper = usePaper();
  return paper ? <PaperAccount s={paper} /> : <PaperStart />;
}

function PaperStart() {
  const top = useJson("today.json").data?.top?.slice(0, 5) || [];
  return (
    <>
      <div className="hero hero-split">
        <div className="hero-copy">
          <span className="hero-tag">API 키 필요 없음 · 실제 돈 아님</span>
          <h2>가상 자금으로<br />실제 시세에 투자해 보세요</h2>
          <p>
            네이버 증권 실시간 시세로 사고팔고, 수수료·세금까지 실제처럼 계산해요.
            AI 추천 종목을 따라 사 보거나 내 판단과 AI를 겨뤄 보세요.
          </p>
          <ul className="hero-points">
            <li><b>실시간</b><span>장중 10초마다 시세·수익률 갱신</span></li>
            <li><b>시장가·지정가</b><span>호가창을 눌러 원하는 가격에 주문</span></li>
            <li><b>내 브라우저에만</b><span>회원가입 없이, 기록은 이 기기에</span></li>
          </ul>
        </div>
        <div className="card hero-form">
          <h2>모의투자 계좌 만들기</h2>
          <p className="sub">원하는 금액을 입력하세요. 언제든 초기화하고 다시 시작할 수 있어요.</p>
          <StartPaperForm />
        </div>
      </div>

      <div className="grid three">
        {[
          ["1", "종목 고르기", <>위쪽 검색창이나 <a href="#today">AI 추천</a>·<a href="#live">실시간 순위</a>에서 종목을 눌러요.</>],
          ["2", "주문하기", "종목 화면 오른쪽 주문창에서 시장가(바로 체결) 또는 지정가(가격이 닿으면 체결)로 주문해요."],
          ["3", "수익 확인", "이 화면에서 총자산·평가손익·거래 내역을 실시간으로 봐요."],
        ].map(([no, t, d]) => (
          <div key={no} className="card step">
            <span className="step-no">{no}</span>
            <h2>{t}</h2>
            <p className="sub" style={{ margin: 0 }}>{d}</p>
          </div>
        ))}
      </div>

      {top.length > 0 && (
        <div className="card section" style={{ marginTop: 12 }}>
          <h2>오늘 AI가 고른 종목</h2>
          <p className="sub">눌러서 차트를 보고 바로 모의 주문해 보세요.</p>
          <div className="chips">
            {top.map((t) => <a key={t.code} className="chip" href={`#stock/${t.code}`}><b className="accent-text">{t.rank}위</b> {t.name}</a>)}
          </div>
        </div>
      )}

      <p className="muted" style={{ fontSize: 12 }}>
        실제 한국투자증권 계좌를 연결하고 싶다면 <a href="#guide">API 연결 가이드</a>를 먼저 읽어 보세요.
      </p>
    </>
  );
}

function PaperAccount({ s }) {
  const quotes = useQuotes([...Object.keys(s.positions), ...s.orders.map((o) => o.code)], 10_000);
  const v = valuation(s, quotes);
  const [confirmReset, setConfirmReset] = useState(false);
  const [histFilter, setHistFilter] = useState("all");
  const phase = marketPhase();
  const trades = s.trades.filter((t) => histFilter === "all" || t.side === histFilter);

  return (
    <>
      <div className={`asset-card ${dir(v.totalPnl) || "flat"}`}>
        <div className="asset-main">
          <span className="asset-label">내 모의투자 총자산</span>
          <Flash value={Math.round(v.total)} className="big-num num">{won(v.total)}<small>원</small></Flash>
          <div className="asset-pnl num">
            <span className="pill">{v.totalPnl > 0 ? "▲" : v.totalPnl < 0 ? "▼" : ""} {signed(Math.round(v.totalPnl))}원</span>
            <span className="pill">{pct(v.totalRatio, { digits: 2 })}</span>
            <span className="asset-start">시작 {korMoney(s.startCash)}</span>
          </div>
          <div className="asset-bar" title={`주식 ${v.total ? Math.round(v.stock / v.total * 100) : 0}% · 현금 ${v.total ? Math.round(v.cash / v.total * 100) : 0}%`}>
            <i style={{ width: `${v.total ? (v.stock / v.total) * 100 : 0}%` }} />
          </div>
          <div className="asset-legend">
            <span><i className="dot-stock" />주식 {won(v.stock)}원</span>
            <span><i className="dot-cash" />현금 {won(v.cash)}원</span>
          </div>
        </div>
        <div className="paper-actions">
          <span className="asset-status">
            {phase.key === "open" ? "● 장중 · 10초마다 갱신" : `${phase.label} · 주문 시 마지막 가격으로 체결`}
          </span>
          {confirmReset ? (
            <span className="confirm-inline">
              모든 기록을 지울까요?
              <button className="icon-btn" onClick={() => setConfirmReset(false)}>아니요</button>
              <button className="icon-btn danger" onClick={() => { resetPaper(); setConfirmReset(false); }}>초기화</button>
            </span>
          ) : <button className="icon-btn ghost" onClick={() => setConfirmReset(true)}>초기화</button>}
        </div>
      </div>

      <div className="grid tiles">
        <Tile label="주식 평가금액" value={`${won(v.stock)}원`} note={`매입 ${won(v.cost)}원`} />
        <Tile label="평가손익 (보유 중)" value={<span className={dir(v.pnl)}>{signed(Math.round(v.pnl))}원</span>}
          note={v.cost ? pct(v.pnl / v.cost * 100, { digits: 2 }) : "보유 종목 없음"} />
        <Tile label="실현손익 (판 종목)" value={<span className={dir(v.realized)}>{signed(Math.round(v.realized))}원</span>}
          note="수수료·세금 뺀 금액" />
        <Tile label="주문가능 현금" value={`${won(v.orderable)}원`}
          note={v.orderable !== v.cash ? `미체결 주문에 ${won(v.cash - v.orderable)}원 묶임` : `주식 비중 ${v.total ? Math.round(v.stock / v.total * 100) : 0}%`} />
      </div>

      <div className="card section">
        <h2>보유 종목 {v.rows.length}개</h2>
        {v.rows.length === 0 ? (
          <div className="empty">
            <strong>아직 보유 종목이 없어요</strong>
            위 검색창에서 종목을 찾아 종목 화면 오른쪽 주문창으로 사 보세요.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th className="l">종목</th><th>현재가</th><th>오늘</th><th>보유</th><th>평단가</th><th>평가금액</th><th>평가손익</th><th>수익률</th><th>비중</th></tr>
              </thead>
              <tbody>
                {v.rows.map((r) => (
                  <tr key={r.code} className="row-link" onClick={() => { window.location.hash = `stock/${r.code}`; }}>
                    <td className="l"><StockLink code={r.code} name={r.name} /> <span className="muted">{r.code}</span></td>
                    <td className={`num ${dir(r.quote?.change)}`}><Flash value={r.price}>{won(r.price)}</Flash></td>
                    <td>{r.quote ? <Change change={r.quote.change} ratio={r.quote.ratio} arrowOnly /> : "–"}</td>
                    <td className="num">{won(r.shares)}</td>
                    <td className="num">{won(r.avg)}</td>
                    <td className="num">{won(r.value)}</td>
                    <td className={`num ${dir(r.pnl)}`}>{signed(Math.round(r.pnl))}</td>
                    <td className={`num ${dir(r.ratio)}`}>{pct(r.ratio, { digits: 2 })}</td>
                    <td className="num">{v.total ? (r.value / v.total * 100).toFixed(1) : 0}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card section">
        <h2>나 vs AI vs 코스피</h2>
        <p className="sub">내 모의투자 누적 수익률을 팀 AI 계좌·코스피와 비교해요.</p>
        <VersusChart />
      </div>

      {s.orders.length > 0 && (
        <div className="card section">
          <h2>미체결 주문 {s.orders.length}건</h2>
          <p className="sub">지정가에 닿으면 자동으로 체결돼요 (이 사이트를 열어 둔 동안 확인). 오늘 안에 체결되지 않으면 자동 취소돼요.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th className="l">주문 시각</th><th className="l">종목</th><th className="l">구분</th><th>지정가</th><th>현재가</th><th>수량</th><th /></tr></thead>
              <tbody>
                {s.orders.map((o) => (
                  <tr key={o.id}>
                    <td className="l num">{fmtTime(o.at)}</td>
                    <td className="l"><StockLink code={o.code} name={o.name} /></td>
                    <td className="l"><span className={`badge ${o.side}`}>{o.side === "buy" ? "매수" : "매도"}</span></td>
                    <td className="num">{won(o.price)}</td>
                    <td className="num">{won(quotes[o.code]?.price)}</td>
                    <td className="num">{won(o.shares)}</td>
                    <td><button className="icon-btn" onClick={() => cancelOrder(o.id)}>취소</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card section">
        <div className="filters" style={{ justifyContent: "space-between", marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>거래 내역 {s.trades.length}건</h2>
          <div className="seg" role="group" aria-label="거래 구분">
            {[["all", "전체"], ["buy", "매수"], ["sell", "매도"]].map(([k, l]) => (
              <button key={k} aria-pressed={histFilter === k} onClick={() => setHistFilter(k)}>{l}</button>
            ))}
          </div>
        </div>
        {trades.length === 0 ? <div className="empty">거래 내역이 없어요.</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th className="l">체결 시각</th><th className="l">종목</th><th className="l">구분</th><th>체결가</th><th>수량</th><th>금액</th><th>수수료·세금</th><th>실현손익</th></tr></thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={`${t.id}-${t.at}`}>
                    <td className="l num">{fmtTime(t.at)}</td>
                    <td className="l"><StockLink code={t.code} name={t.name} /></td>
                    <td className="l">
                      <span className={`badge ${t.side}`}>{t.side === "buy" ? "매수" : "매도"}</span>
                      <span className="muted"> {t.type === "limit" ? "지정가" : "시장가"}</span>
                    </td>
                    <td className="num">{won(t.price)}</td>
                    <td className="num">{won(t.shares)}</td>
                    <td className="num">{won(t.price * t.shares)}</td>
                    <td className="num">{won(t.fee + t.tax)}</td>
                    <td className={`num ${dir(t.pnl)}`}>{t.pnl == null ? "–" : signed(Math.round(t.pnl))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="fine">
          수수료 {(FEE * 100).toFixed(3)}% (매수·매도), 매도 시 거래세 {(TAX * 100).toFixed(2)}%. 실제 증권사·연도에 따라 달라요.
          호가 잔량·체결 순서는 따지지 않는 연습용 모의투자예요.
        </p>
      </div>
    </>
  );
}
