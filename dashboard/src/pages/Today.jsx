import { Loading, Pct, StockLink, Tile, eok, marketLabel, useJson, won } from "../lib.jsx";

export default function Today() {
  const state = useJson("today.json");
  return (
    <Loading state={state}>
      {(d) => (
        <>
          <div className="grid tiles">
            <Tile label="예측일" value={d.date} note={`${d.base_close} 종가까지 반영`} />
            <Tile label="모델" value={`모델 ${d.model}`} note={`차트 + 시장 피처, ${d.trained_until}까지 학습`} />
            <Tile label="전략" value={`상위 ${d.strategy.top_n}종목`}
              note={`${d.strategy.sell_rank}위 밖으로 밀리면 매도 · 손절 없음`} />
            <Tile label="매수 가능 종목" value={`${d.buyable} / ${d.universe_size}`}
              note={`20일 평균 거래대금 ${eok(d.strategy.min_value_krw)} 이상`} />
          </div>

          <div className="card section">
            <h2>오늘의 주문<span className="badge">안정형일 때 하는 매매예요</span></h2>
            <p className="sub">08:30~09:00 동시호가에 시장가로 제출. 수량은 전일 종가 기준이라 체결 금액은 조금 달라질 수 있어요.</p>
            {d.orders.length === 0 ? (
              <div className="empty">주문 없음 — 보유 종목을 그대로 유지해요</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th className="l">구분</th><th className="l">종목</th><th>순위</th><th>수량</th><th>기준가</th><th>금액</th></tr>
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card">
            <h2>AI 종목 순위 상위 {d.top.length}</h2>
            <p className="sub">
              점수 = 다음 거래일 시가→시가 수익률이 351종목 중 몇 번째일지 예측한 값 (0.5 = 중간). 수익률은 전일 종가 기준.
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>순위</th><th className="l">종목</th><th>점수</th><th>종가</th>
                    <th>1일</th><th>5일</th><th>20일</th><th>RSI</th><th>거래량 배수</th><th className="l">매수</th>
                  </tr>
                </thead>
                <tbody>
                  {d.top.map((r) => (
                    <tr key={r.code}>
                      <td className="num">{r.rank}</td>
                      <td className="l"><StockLink code={r.code} name={r.name} /><span className="badge">{marketLabel(r.market)}</span></td>
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
        </>
      )}
    </Loading>
  );
}
