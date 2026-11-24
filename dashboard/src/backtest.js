// 브라우저 백테스트 엔진: model/backtest.py 의 simulate 와 같은 규칙 (공포 비중 조절만 뺌)
// 데이터: public/data/backtest_data_{kr,us}.json (dashboard/export.py --backtest)
//   dates[d], open/high/low/close[d][i] (종목 i, 없으면 null), ai/mom[d] = 그날 점수 상위 k 개 종목 번호 (매수 불가는 -(i+1))
//
// 하루 순서 (모두 일봉으로 흉내 → 실제보다 약간 유리)
// 1. 시가: 손절선 아래로 시작한 종목은 시가 매도, (교체일이면) 순위 밖 종목 매도
// 2. 시가: 빈 자리만큼 순위 높은 종목 매수 (자리당 = 시가 기준 총자산 x 99% / 보유 종목 수)
//    손절로 빈 자리는 delay_after_stop 이면 다음 날. 거래대금 부족·시세 없음·상한가 근처(+29%, 국내) 제외
// 3. 장중: 저가가 손절선에 닿으면 손절가 -0.2% 로 매도. 그 뒤 고점을 그날 고가로 갱신
// 4. 종가로 평가
// 손절선: 고점이 매수가 +trail_start 에 닿은 뒤로는 고점 x (1 - trail), 그 전에는 매수가 x (1 - stop)

const isoWeek = (s) => {
  const d = new Date(`${s}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return `${d.getUTCFullYear()}-${Math.round((d - firstThu) / 864e5 / 7)}`;
};

export function runBacktest(data, opt) {
  const {
    top_n: topN, sell_rank: sellRank = null, stop = null, trail_start: trailStart = null, trail = null,
    weekly = false, delay_after_stop: delayAfterStop = false, score = "ai", from = 0, to = data.dates.length - 1,
    capital = 100_000_000,
  } = opt;
  const { commission, tax } = data.costs;
  const slip = data.stop_slip, buffer = data.cash_buffer, limitUp = data.limit_up;
  const lists = score === "momentum" ? data.mom : data.ai;
  const rankLists = score === "momentum" ? data.mom_rank : data.ai_rank;
  const pos = new Map();         // i -> { shares, entry, peak, date }
  const lastClose = new Map();
  const equity = [], trades = [];
  let cash = capital, tradedSum = 0, prevWeek = null;

  const level = (p) => {
    if (trailStart != null && trail != null && p.peak >= p.entry * (1 + trailStart)) return [p.peak * (1 - trail), "trail"];
    if (stop) return [p.entry * (1 - stop), "stop"];
    return [null, null];
  };

  for (let d = from; d <= to; d += 1) {
    const date = data.dates[d];
    const op = data.open[d], hi = data.high[d], lo = data.low[d], cl = data.close[d];
    const pc = d > 0 ? data.close[d - 1] : data.first_prev_close;
    const list = lists[d] || [];
    const ranks = rankLists?.[d];   // 동점은 평균 순위 (model/backtest.py 와 같음)
    const rank = new Map(list.map((v, r) => [v >= 0 ? v : -v - 1, ranks ? ranks[r] : r + 1]));
    const week = isoWeek(date);
    const rebalance = !weekly || week !== prevWeek;
    prevWeek = week;
    let stopped = 0;

    const sell = (i, price, reason) => {
      const p = pos.get(i);
      const amount = p.shares * price;
      cash += amount * (1 - commission - tax);
      tradedSum += amount;
      trades.push({
        date, i, name: data.names[i], shares: p.shares, entry: p.entry, entryDate: p.date, price, reason,
        ret: (price / p.entry) * (1 - commission - tax) / (1 + commission) - 1,
      });
      pos.delete(i);
    };

    // 1. 시가 매도
    for (const [i, p] of [...pos]) {
      if (op[i] == null) continue;   // 거래정지
      const [lvl, kind] = level(p);
      if (lvl != null && op[i] <= lvl) { sell(i, op[i], `${kind}_gap`); stopped += 1; }
      else if (rebalance && sellRank != null && (rank.get(i) ?? Infinity) > sellRank) sell(i, op[i], "rank");
    }

    // 2. 시가 매수
    if (rebalance) {
      let value = 0;
      for (const [i, p] of pos) value += p.shares * (op[i] ?? lastClose.get(i));
      const target = ((cash + value) * buffer) / topN;
      let slots = topN - pos.size - (delayAfterStop ? stopped : 0);
      for (const v of list) {
        if (slots <= 0) break;
        if (v < 0) continue;   // 거래대금 부족
        const i = v;
        if (pos.has(i) || op[i] == null || pc[i] == null) continue;
        if (limitUp != null && op[i] >= pc[i] * (1 + limitUp)) continue;
        const shares = Math.floor(Math.min(target, cash / (1 + commission)) / op[i]);
        if (shares <= 0) continue;
        cash -= shares * op[i] * (1 + commission);
        tradedSum += shares * op[i];
        pos.set(i, { shares, entry: op[i], peak: op[i], date });
        slots -= 1;
      }
    }

    // 3. 장중 손절·추적 익절, 고점 갱신
    for (const [i, p] of [...pos]) {
      const [lvl, kind] = level(p);
      if (lvl != null && lo[i] != null && lo[i] <= lvl) sell(i, lvl * (1 - slip), kind);
      else if (hi[i] != null) p.peak = Math.max(p.peak, hi[i]);
    }

    // 4. 종가 평가
    let value = 0;
    for (const [i, p] of pos) {
      if (cl[i] != null) lastClose.set(i, cl[i]);
      else if (!lastClose.has(i)) lastClose.set(i, p.entry);
      value += p.shares * lastClose.get(i);
    }
    equity.push({ date, value: cash + value });
  }

  const holdings = [...pos].map(([i, p]) => ({
    name: data.names[i], code: data.codes[i], shares: p.shares, entry: p.entry, entryDate: p.date, last: lastClose.get(i),
  }));
  return { equity, trades, holdings, metrics: summarize(equity, trades, capital, tradedSum) };
}

export function summarize(equity, trades, capital, tradedSum = 0) {
  if (!equity.length) return null;
  const vals = equity.map((e) => e.value);
  let peak = -Infinity, mdd = 0;
  const rets = [];
  vals.forEach((v, k) => {
    peak = Math.max(peak, v);
    mdd = Math.min(mdd, v / peak - 1);
    rets.push(v / (k ? vals[k - 1] : capital) - 1);
  });
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1));
  const wins = trades.filter((t) => t.ret > 0).length;
  return {
    total: (vals[vals.length - 1] / capital - 1) * 100,
    mdd: mdd * 100,
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(252) : null,
    sells: trades.length,
    win: trades.length ? (wins / trades.length) * 100 : null,
    stopShare: trades.length ? (trades.filter((t) => /^(stop|trail)/.test(t.reason)).length / trades.length) * 100 : null,
    turnover: tradedSum / capital,      // 원금의 몇 배를 거래했는지
    days: vals.length,
  };
}
