import { useState } from "react";

// 초보자용: 한국투자증권 Open API(KIS Developers) 키를 받아 이 대시보드에 연결하기까지
// 체크 표시는 이 브라우저에만 저장 (진행 상황 기억용)
const KEY = "guide-progress-v1";
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };

const STEPS = [
  {
    id: "account",
    title: "한국투자증권 계좌 만들기",
    time: "약 10분",
    body: (
      <>
        <p>스마트폰에 <b>한국투자증권 앱</b>을 설치하고 <b>비대면 계좌 개설</b>을 진행해요. 신분증과 본인 명의 은행 계좌가 필요해요.</p>
        <ul>
          <li>계좌 종류는 <b>주식(종합) 계좌</b>를 고르세요. 계좌번호는 <code>12345678-01</code> 처럼 <b>8자리-2자리</b>이고, 주식 계좌는 뒤 2자리가 <code>01</code> 이에요.</li>
          <li>연금저축·ISA 계좌(뒤 2자리가 01이 아닌 계좌)는 이 대시보드에서 지원하지 않아요.</li>
          <li>이미 한국투자증권 계좌가 있다면 이 단계는 건너뛰세요.</li>
        </ul>
      </>
    ),
  },
  {
    id: "id",
    title: "홈페이지 ID 등록",
    time: "약 3분",
    body: (
      <>
        <p>KIS Developers 는 한국투자증권 <b>홈페이지 ID</b>로 로그인해요. 앱에서 계좌만 만들고 ID를 안 만들었다면 앱 또는 홈페이지에서 <b>ID 등록</b>을 먼저 해 주세요.</p>
      </>
    ),
  },
  {
    id: "apply",
    title: "KIS Developers 서비스 신청 → 앱 키 발급",
    time: "약 5분",
    body: (
      <>
        <p>
          <a href="https://apiportal.koreainvestment.com" target="_blank" rel="noreferrer">KIS Developers (apiportal.koreainvestment.com)</a> 에
          접속해 로그인한 뒤 <b>API 신청</b>(서비스 신청) 메뉴로 들어가요. 메뉴 이름·위치는 증권사 사정으로 바뀔 수 있어요.
        </p>
        <ol>
          <li>약관에 동의하고 <b>API를 쓸 계좌</b>를 고른 뒤 신청해요.</li>
          <li>신청이 끝나면 <b>APP KEY</b>(앱 키)와 <b>APP SECRET</b>(앱 시크릿)이 나와요. 두 값을 복사해 두세요.</li>
          <li>APP SECRET 은 아주 긴 문자열이에요. 앞뒤 공백 없이 <b>전부</b> 복사해야 해요.</li>
        </ol>
        <div className="callout warn">
          <b>앱 키 = 내 계좌 비밀번호</b>라고 생각하세요. 실전 키가 새면 다른 사람이 내 계좌로 주문을 낼 수 있어요.
          카톡·디스코드·깃허브·스크린샷에 절대 올리지 마세요.
        </div>
      </>
    ),
  },
  {
    id: "mock",
    title: "(선택) 모의투자 계좌도 신청하기",
    time: "약 5분",
    body: (
      <>
        <p>실제 돈 없이 한투 시스템에서 연습하고 싶다면 한국투자증권 홈페이지·앱에서 <b>모의투자 신청</b>을 하고, KIS Developers 에서 <b>모의투자용 앱 키를 따로</b> 발급받아요.</p>
        <ul>
          <li><b>실전 키와 모의투자 키는 서로 달라요.</b> 실전 키로 모의투자 서버에 연결하면(또는 반대로) "유효하지 않은 AppKey" 같은 오류가 나요.</li>
          <li>모의투자 계좌번호는 실전 계좌번호와 달라요. 모의투자 화면에서 확인하세요.</li>
          <li>키 없이 바로 연습하고 싶다면 이 사이트의 <a href="#paper">모의투자</a> 탭(가상 자금)을 쓰면 돼요.</li>
        </ul>
      </>
    ),
  },
  {
    id: "connect",
    title: "이 대시보드에 연결하기",
    time: "1분",
    body: (
      <>
        <ol>
          <li><a href="#account">내 계좌</a> 탭으로 가요.</li>
          <li><b>실전 계좌</b> 또는 <b>모의투자 계좌</b> 중 키를 받은 쪽을 골라요.</li>
          <li>APP KEY, APP SECRET, 계좌번호(<code>12345678-01</code>)를 넣고 <b>연결</b>을 눌러요.</li>
          <li>잔고가 보이면 성공! 장중에는 10초마다 자동으로 새로고침돼요.</li>
        </ol>
        <p className="muted">이 사이트는 <b>조회만</b> 해요. 실제 매수·매도는 한국투자증권 앱에서 하세요.</p>
      </>
    ),
  },
];

const ERRORS = [
  ["토큰 발급 실패 … 1분 안에 다시 요청", "한투는 토큰을 1분에 1번만 발급해요. 1분 기다렸다가 다시 연결하세요."],
  ["유효하지 않은 AppKey / appsecret", "실전·모의투자 선택이 키와 맞는지 확인하세요. 복사할 때 앞뒤 공백이나 일부가 빠졌는지도 확인하세요."],
  ["계좌번호는 8자리-2자리 형식으로", "하이픈 포함 12345678-01 또는 숫자만 1234567801 로 넣으세요."],
  ["상품코드 … 지원하지 않아요", "주식(종합) 계좌(뒤 2자리 01)만 지원해요. 연금·ISA·해외 계좌는 안 돼요."],
  ["초당 거래건수 초과 (EGW00201 등)", "짧은 시간에 너무 많이 조회했어요. 잠시 뒤 새로고침하세요. 모의투자 서버는 제한이 더 빡빡해요."],
  ["잔고 조회 실패 (토큰은 받았는데 조회가 안 됨)", "KIS Developers 신청 때 고른 계좌와 입력한 계좌번호가 같은지, 실전/모의 선택이 맞는지 확인하세요."],
];

export default function Guide() {
  const [done, setDone] = useState(load);
  const toggle = (id) => setDone((d) => {
    const next = { ...d, [id]: !d[id] };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* 저장 불가 무시 */ }
    return next;
  });
  const count = STEPS.filter((s) => done[s.id]).length;

  return (
    <div className="guide">
      <div className="card hero">
        <span className="badge contest">처음이라면 여기부터</span>
        <h2>한국투자증권 API 연결 가이드</h2>
        <p className="sub">
          내 실제 증권 계좌를 이 대시보드에 연결해 잔고·수익률을 AI 순위와 함께 보는 방법이에요.
          계좌가 없어도 괜찮아요 — <a href="#paper">모의투자</a>는 키 없이 바로 할 수 있어요.
        </p>
        <div className="progress" aria-label={`진행 ${count}/${STEPS.length}`}>
          <i style={{ width: `${(count / STEPS.length) * 100}%` }} />
        </div>
        <span className="muted" style={{ fontSize: 12 }}>{count}/{STEPS.length} 단계 완료 (체크 표시는 이 브라우저에만 저장돼요)</span>
      </div>

      <div className="card section">
        <h2>먼저 알아두기: 세 가지 방법 비교</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th className="l" /><th className="l">이 사이트 모의투자</th><th className="l">한투 모의투자 계좌</th><th className="l">한투 실전 계좌</th></tr>
            </thead>
            <tbody>
              <tr><td className="l">돈</td><td className="l">가상 자금</td><td className="l">가상 자금 (한투 제공)</td><td className="l"><b>실제 돈</b></td></tr>
              <tr><td className="l">필요한 것</td><td className="l">없음</td><td className="l">한투 계좌 + 모의투자 신청 + 모의용 키</td><td className="l">한투 계좌 + 실전용 키</td></tr>
              <tr><td className="l">이 사이트에서 주문</td><td className="l">가능</td><td className="l">조회만</td><td className="l">조회만</td></tr>
              <tr><td className="l">추천 대상</td><td className="l">주식이 처음인 분</td><td className="l">API·자동매매를 공부하는 분</td><td className="l">내 실제 계좌를 AI와 함께 보고 싶은 분</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className={`card step-card ${done[s.id] ? "done" : ""}`}>
            <div className="step-top">
              <span className="step-no">{done[s.id] ? "✓" : i + 1}</span>
              <h2>{s.title}</h2>
              <span className="muted step-time">{s.time}</span>
              <label className="step-check">
                <input type="checkbox" checked={!!done[s.id]} onChange={() => toggle(s.id)} /> 완료
              </label>
            </div>
            <div className="step-body">{s.body}</div>
          </li>
        ))}
      </ol>

      <div className="grid two">
        <div className="card">
          <h2>자주 나는 오류</h2>
          <dl className="faq">
            {ERRORS.map(([q, a]) => (
              <div key={q}><dt>{q}</dt><dd>{a}</dd></div>
            ))}
          </dl>
        </div>
        <div className="card">
          <h2>안전하게 쓰는 법</h2>
          <ul className="notes">
            <li>앱 키는 <b>내 기기 브라우저에만</b> 저장되고, 서버는 저장하지 않아요. 그래도 공용 PC에서는 쓰지 마세요.</li>
            <li>다 보면 <b>연결 해제</b>를 눌러 브라우저에서 키를 지우세요.</li>
            <li>키가 새었다고 생각되면 KIS Developers 에서 <b>즉시 재발급</b>하세요. 예전 키는 바로 무효가 돼요.</li>
            <li>키에는 유효기간이 있어요. 연결이 갑자기 안 되면 KIS Developers 에서 키 상태를 확인하세요.</li>
            <li>이 사이트의 AI 순위는 <b>연구용</b>이에요. 실제 투자 판단과 책임은 본인에게 있어요.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
