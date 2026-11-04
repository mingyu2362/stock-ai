import { useEffect, useRef, useState } from "react";
import { eok, marketOpen, Pct, StockLink, Tile, useJson, won } from "../lib.jsx";
import StrategyCard, { useMode } from "../strategy.jsx";

const REFRESH_MS = 10_000;
const START_CASH = 100_000_000;   // 대회 시작 자금
const STORE_KEY = "kis-account";

// 키는 이 브라우저에만 둔다. 기본은 sessionStorage (탭을 닫으면 지워짐), "이 기기에 기억"을 고르면 localStorage
function loadCreds() {
  for (const store of ["sessionStorage", "localStorage"]) {
    try {
      const v = JSON.parse(window[store].getItem(STORE_KEY));
      if (v?.appKey) return { ...v, remember: store === "localStorage" };
    } catch { /* 저장소를 못 쓰는 환경 */ }
  }
  return null;
}

function saveCreds(creds) {
  const { remember, ...data } = creds;
  try {
    (remember ? localStorage : sessionStorage).setItem(STORE_KEY, JSON.stringify(data));
    (remember ? sessionStorage : localStorage).removeItem(STORE_KEY);
  } catch { /* 저장 못 해도 이 탭에서는 동작 */ }
}

function clearCreds() {
  try { sessionStorage.removeItem(STORE_KEY); localStorage.removeItem(STORE_KEY); } catch { /* 무시 */ }
}

const maskAccount = (a) => {
  const d = a.replace(/\D/g, "");
  return `${d.slice(0, 2)}******-${d.slice(8, 10) || "01"}`;
};

export default function Account() {
  const [creds, setCreds] = useState(loadCreds);
  const mode = useMode();
  if (!creds) {
    return (
      <>
        <StrategyCard m={mode} />
        <ConnectForm onConnect={(c) => { saveCreds(c); setCreds(c); }} />
      </>
    );
  }
  return <Balance creds={creds} mode={mode} onDisconnect={() => { clearCreds(); setCreds(null); }} />;
}

function ConnectForm({ onConnect }) {
  const [form, setForm] = useState({ appKey: "", appSecret: "", account: "", remember: false });
  const [state, setState] = useState({ busy: false, error: null });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value.trim() }));

  // 연결 전에 한 번 조회해 키가 맞는지 확인하고, 받은 토큰도 같이 저장
  const submit = (e) => {
    e.preventDefault();
    setState({ busy: true, error: null });
    fetch("/api/account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || r.status);
        onConnect({ ...form, token: body.token });
      })
      .catch((error) => setState({ busy: false, error }));
  };

  return (
    <div className="grid two">
      <div className="card">
        <h2>내 모의투자 계좌 연결</h2>
        <p className="sub">한국투자증권 KIS Developers 에서 발급받은 모의투자 앱 키로 내 계좌만 조회해요.</p>
        <form className="form" onSubmit={submit} autoComplete="off">
          <label>앱 키 (APP KEY)
            <input type="password" value={form.appKey} onChange={set("appKey")} required spellCheck={false} />
          </label>
          <label>앱 시크릿 (APP SECRET)
            <input type="password" value={form.appSecret} onChange={set("appSecret")} required spellCheck={false} />
          </label>
          <label>모의투자 계좌번호
            <input type="text" inputMode="numeric" placeholder="12345678-01" value={form.account}
              onChange={set("account")} required pattern="\d{8}-?01" title="8자리-01 형식 (예: 12345678-01)" />
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={form.remember} onChange={set("remember")} />
            이 기기에 기억하기 (개인 기기에서만)
          </label>
          {state.error && <p className="error-text">{String(state.error.message)}</p>}
          <button className="btn-primary" disabled={state.busy}>{state.busy ? "확인 중…" : "연결"}</button>
        </form>
      </div>
      <div className="card">
        <h2>키는 어떻게 다뤄지나요</h2>
        <ul className="notes">
          <li>키는 <b>이 브라우저에만</b> 저장돼요. 서버는 조회할 때 한투에 전달만 하고 저장하거나 기록하지 않아요.</li>
          <li>기본은 탭을 닫으면 지워져요. "이 기기에 기억하기"를 켜면 연결 해제 전까지 남아요.</li>
          <li>이 사이트는 <b>잔고 조회만</b> 해요. 주문 기능은 서버에 아예 없어요.</li>
          <li>PC방·공용 컴퓨터에서는 쓰지 말고, 다 보면 "연결 해제"를 눌러 주세요.</li>
          <li>키가 새었다고 생각되면 KIS Developers 에서 키를 재발급하면 예전 키는 바로 무효가 돼요.</li>
        </ul>
      </div>
    </div>
  );
}

function Balance({ creds, mode, onDisconnect }) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const token = useRef(creds.token);
  const today = useJson("today.json").data;
  const orderlog = useJson("orderlog.json").data;
  const planned = useRef([]);   // 오늘 주문 예정 종목 (다 팔아 잔고에서 사라진 종목도 주문 조회하려고)
  planned.current = (today?.orders || []).map((o) => o.code);

  useEffect(() => {
    let alive = true;
    const load = () => {
      setState((s) => ({ ...s, loading: true }));
      const { appKey, appSecret, account } = creds;
      fetch("/api/account", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appKey, appSecret, account, token: token.current, codes: planned.current }),
      })
        .then(async (r) => {
          const body = await r.json();
          if (!r.ok) throw new Error(body.error || r.status);
          if (body.token?.value !== token.current?.value) {
            token.current = body.token;
            saveCreds({ ...creds, token: body.token });
          }
          return body;
        })
        .then((data) => alive && setState({ data, error: null, loading: false }))
        .catch((error) => alive && setState((s) => ({ ...s, error, loading: false })));
    };
    load();
    const timer = setInterval(() => marketOpen() && load(), REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [creds, tick]);

  const d = state.data;
  const rankOf = today?.ranks || {};
  const aggressive = mode.data?.mode === "aggressive";
  const sellRank = aggressive ? null : today?.strategy?.sell_rank;   // 공격형은 순위로 팔지 않음
  const time = d && new Date(d.fetchedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  return (
    <>
      <div className="filters">
        <button className="icon-btn" onClick={() => setTick((t) => t + 1)} disabled={state.loading}>새로고침</button>
        <button className="icon-btn" onClick={onDisconnect}>연결 해제</button>
        <span className="muted" style={{ fontSize: 12 }}>
          계좌 {maskAccount(creds.account)} · {marketOpen() ? "장중 · 10초마다 갱신" : "장 마감 · 새로고침 버튼으로 갱신"}{time ? ` · ${time} 조회` : ""}
        </span>
      </div>

      {state.error && !d && (
        <div className="card empty"><strong>계좌를 불러오지 못했어요</strong>{String(state.error.message)}</div>
      )}
      {!d && !state.error && <div className="card empty">불러오는 중…</div>}

      {d && (
        <div style={{ opacity: state.loading ? 0.6 : 1 }}>
          {state.error && <p className="muted" style={{ fontSize: 12 }}>마지막 갱신 실패: {String(state.error.message)}</p>}
          <div className="grid tiles">
            <Tile label="총 평가금액" value={`${won(d.summary.total)}원`}
              note={<>전일 대비 <Pct v={d.summary.prevTotal ? (d.summary.total / d.summary.prevTotal - 1) * 100 : null} digits={2} /></>} />
            <Tile label="대회 수익률 (시작 1억)" value={<Pct v={(d.summary.total / START_CASH - 1) * 100} digits={2} />}
              note={`${d.summary.total >= START_CASH ? "+" : ""}${won(d.summary.total - START_CASH)}원`} />
            <Tile label="보유 종목 평가손익" value={<Pct v={d.summary.cost ? (d.summary.pnl / d.summary.cost) * 100 : null} digits={2} />}
              note={`${d.summary.pnl > 0 ? "+" : ""}${won(d.summary.pnl)}원 · 평가 ${eok(d.summary.stockValue)}`} />
            <Tile label="예수금" value={`${eok(d.summary.cash)}원`}
              note={`주식 비중 ${d.summary.total ? ((d.summary.stockValue / d.summary.total) * 100).toFixed(0) : 0}%`} />
          </div>

          <StrategyCard m={mode} positions={d.positions} />

          <div className="card">
            <h2>보유 종목 {d.positions.length}개</h2>
            <p className="sub">
              한국투자증권 모의투자 계좌 실시간 잔고. AI 순위는 {today?.date ?? "–"} 예측 기준이며,
              {aggressive ? " 공격형이라 순위와 상관없이 손절선에서만 팔아요." : sellRank ? ` ${sellRank}위 밖으로 밀리면 다음 날 시가에 팔아요.` : ""}
            </p>
            {d.positions.length === 0 ? (
              <div className="empty">보유 종목이 없어요.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="l">종목</th><th>AI 순위</th><th>수량</th><th>평균 단가</th><th>현재가</th>
                      <th>오늘 등락</th><th>평가금액</th><th>비중</th><th>평가손익</th><th>수익률</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.positions.map((p) => {
                      const rank = rankOf[p.code];
                      const out = sellRank && !(rank <= sellRank);
                      return (
                        <tr key={p.code}>
                          <td className="l"><StockLink code={p.code} name={p.name} /> <span className="muted">{p.code}</span></td>
                          <td className="num">
                            {rank ? `${rank}위` : "–"}
                            {out && <span className="badge sell">매도 대상</span>}
                          </td>
                          <td className="num">{won(p.shares)}</td>
                          <td className="num">{won(p.avgPrice)}</td>
                          <td className="num">{won(p.price)}</td>
                          <td><Pct v={p.dayRatio} digits={2} /></td>
                          <td className="num">{won(p.value)}</td>
                          <td className="num">{d.summary.total ? ((p.value / d.summary.total) * 100).toFixed(1) : 0}%</td>
                          <td className={`num ${p.pnl > 0 ? "up" : p.pnl < 0 ? "down" : ""}`}>{p.pnl > 0 ? "+" : ""}{won(p.pnl)}</td>
                          <td><Pct v={p.pnlRatio} digits={2} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {d.orders?.length || !d.ordersByCode?.length
            ? <Orders orders={d.orders || []} />
            : <OrdersByCode rows={d.ordersByCode} summary={d.orderSummary} positions={d.positions}
                today={today} orderlog={orderlog} fetchedAt={d.fetchedAt} />}
        </div>
      )}
    </>
  );
}

function orderStatus(o) {
  if (o.rejected > 0) return { text: "거부", open: false };
  if (o.remain > 0) return { text: o.filled > 0 ? "부분 체결" : "미체결", open: true };
  if (o.filled >= o.qty) return { text: "체결", open: false };
  if (o.canceled > 0) return { text: o.filled > 0 ? "일부 체결 후 취소" : "취소", open: false };
  return { text: "접수", open: true };
}

const FILTERS = [["all", "전체"], ["open", "미체결"], ["filled", "체결"]];

const kstToday = (iso) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);

function StatusFilter({ filter, setFilter }) {
  return (
    <div className="filters" style={{ marginBottom: 8 }}>
      <div className="seg" role="group" aria-label="주문 상태">
        {FILTERS.map(([k, label]) => (
          <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>
    </div>
  );
}

// 한투 모의투자는 주문별 목록을 주지 않아 종목별 합계로 보여 준다.
// 주문 시각·체결 확인 시각은 우리 매매 프로그램 기록(orderlog.json)에 같은 날·같은 종목이 있을 때만 붙인다
function OrdersByCode({ rows, summary, positions, today, orderlog, fetchedAt }) {
  const [filter, setFilter] = useState("all");
  const names = Object.fromEntries([...(today?.orders || []), ...positions].map((p) => [p.code, p.name]));
  const action = Object.fromEntries((today?.orders || []).map((o) => [o.code, o.action]));
  const logged = orderlog?.date === kstToday(fetchedAt) ? orderlog.orders : [];
  const list = rows.map((r) => {
    const mine = logged.filter((o) => o.code === r.code);
    const checked = mine.map((o) => o.checked_at).filter(Boolean).sort();
    const status = r.remain > 0 ? { text: r.filled > 0 ? "부분 체결" : "미체결", open: true } : { text: "체결", open: false };
    return {
      ...r, status, name: names[r.code] || mine[0]?.name || r.code,
      side: mine[0]?.side || action[r.code] || "buy",
      orderedAt: mine.map((o) => o.time).sort()[0],
      checkedAt: r.remain > 0 ? null : checked[checked.length - 1],
      tries: mine.length,
    };
  });
  const shown = list.filter((o) => filter === "all" || (filter === "open" ? o.status.open : o.filled > 0));

  return (
    <div className="card">
      <h2>오늘 주문 {list.length}종목</h2>
      <p className="sub">
        체결 {won(summary.filled)}주 / 주문 {won(summary.qty)}주 · 체결금액 {eok(summary.amount)}원 · 수수료·세금 약 {won(summary.fee)}원.
        한투 모의투자는 주문별 내역을 주지 않아 종목별 합계로 보여요. 체결 확인은 매매 프로그램이 체결을 확인한 시각이에요 (실제 체결은 그보다 이를 수 있음).
      </p>
      <StatusFilter filter={filter} setFilter={setFilter} />
      {shown.length === 0 ? (
        <div className="empty">해당하는 주문이 없어요.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="l">종목</th><th className="l">구분</th><th>주문 수량</th><th>체결 수량</th><th>미체결</th>
                <th>체결 평균가</th><th className="l">상태</th><th className="l">주문 시각</th><th className="l">체결 확인</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.code}>
                  <td className="l"><StockLink code={o.code} name={o.name} /></td>
                  <td className="l">
                    <span className={`badge ${o.side}`}>{o.side === "buy" ? "매수" : "매도"}</span>
                    {o.tries > 1 && <span className="muted"> {o.tries}회 주문</span>}
                  </td>
                  <td className="num">{won(o.qty)}</td>
                  <td className="num">{won(o.filled)}</td>
                  <td className="num">{o.remain ? won(o.remain) : "–"}</td>
                  <td className="num">{o.filled ? won(Math.round(o.fillPrice)) : "–"}</td>
                  <td className="l">{o.status.open ? <b>{o.status.text}</b> : <span className="muted">{o.status.text}</span>}</td>
                  <td className="l num">{o.orderedAt || "–"}</td>
                  <td className="l num">{o.checkedAt || "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Orders({ orders }) {
  const [filter, setFilter] = useState("all");
  const rows = orders.map((o) => ({ ...o, status: orderStatus(o) }));
  const openCount = rows.filter((o) => o.status.open).length;
  const filledCount = rows.filter((o) => o.filled > 0).length;
  const shown = rows.filter((o) => filter === "all" || (filter === "open" ? o.status.open : o.filled > 0));

  return (
    <div className="card">
      <h2>오늘 주문 {orders.length}건</h2>
      <p className="sub">체결 {filledCount}건 · 미체결 {openCount}건. 취소하고 다시 낸 주문은 각각 따로 보여요.</p>
      <StatusFilter filter={filter} setFilter={setFilter} />
      {shown.length === 0 ? (
        <div className="empty">{orders.length ? "해당하는 주문이 없어요." : "오늘 낸 주문이 없어요."}</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="l">시각</th><th className="l">종목</th><th className="l">구분</th><th>주문 가격</th>
                <th>주문 수량</th><th>체결 수량</th><th>체결 평균가</th><th>미체결</th><th className="l">상태</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((o) => (
                <tr key={o.orderNo}>
                  <td className="l num">{o.time}</td>
                  <td className="l"><StockLink code={o.code} name={o.name} /></td>
                  <td className="l">
                    <span className={`badge ${o.side}`}>{o.side === "buy" ? "매수" : "매도"}</span>
                    <span className="muted"> {o.type}</span>
                  </td>
                  <td className="num">{o.orderPrice ? won(o.orderPrice) : "시장가"}</td>
                  <td className="num">{won(o.qty)}</td>
                  <td className="num">{won(o.filled)}</td>
                  <td className="num">{o.filled ? won(o.fillPrice) : "–"}</td>
                  <td className="num">{o.remain ? won(o.remain) : "–"}</td>
                  <td className="l">{o.status.open ? <b>{o.status.text}</b> : <span className="muted">{o.status.text}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
