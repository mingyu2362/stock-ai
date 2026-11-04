// 투자 성향 (안정형 / 공격형) 조회·전환 (Vercel 서버리스 함수, 개발 중에는 vite.config.js 가 같은 함수를 씀)
// GET  /api/mode                        → { mode, changedAt, state }   state = data/strategy/aggressive.json
// POST /api/mode { mode, password }     → 팀 비밀번호가 맞으면 저장소의 data/strategy/mode.json 을 바꾼다
//
// 매매 프로그램(GitHub Actions)이 저장소의 파일을 읽으므로 GitHub API 로 파일을 직접 고친다.
// - 이 함수가 바꿀 수 있는 파일은 mode.json 하나. 주문 기능은 없다
// - 환경 변수 (Vercel → Settings → Environment Variables, 개발 중에는 dashboard/.env.local)
//     GITHUB_TOKEN   이 저장소의 Contents 읽기·쓰기만 준 fine-grained 토큰
//     MODE_PASSWORD  팀 비밀번호
//     GITHUB_REPO    기본 mingyu2362/stock-ai
import { createHash, timingSafeEqual } from "node:crypto";

const MODES = { stable: "안정형", aggressive: "공격형" };
const MODE_PATH = "data/strategy/mode.json";
const STATE_PATH = "data/strategy/aggressive.json";

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000) throw new Error("요청이 너무 큽니다.");
  }
  return JSON.parse(raw || "{}");
}

const repo = () => process.env.GITHUB_REPO || "mingyu2362/stock-ai";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function github(path, init = {}) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "stock-ai-dashboard" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`https://api.github.com/repos/${repo()}/contents/${path}`, {
    ...init, headers: { ...headers, ...init.headers },
  });
  if (r.status === 404 && !init.method) return null;
  const body = await r.json();
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${body.message || ""}`);
  return body;
}

// 파일 내용과 sha (고칠 때 필요)
async function readFile(path) {
  const f = await github(`${path}?ref=main`);
  if (!f) return { data: null, sha: undefined };
  return { data: JSON.parse(Buffer.from(f.content, "base64").toString("utf-8")), sha: f.sha };
}

// 길이가 달라도 시간 차이로 비밀번호가 새지 않게 해시끼리 비교
const same = (a, b) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const [mode, state] = await Promise.all([readFile(MODE_PATH), readFile(STATE_PATH)]);
      return send(res, 200, {
        mode: MODES[mode.data?.mode] ? mode.data.mode : "stable",
        changedAt: mode.data?.changed_at ?? null,
        state: state.data,
      });
    }
    if (req.method !== "POST") return send(res, 405, { error: "GET 또는 POST 로만 호출합니다." });

    const { mode, password } = await readBody(req);
    if (!MODES[mode]) return send(res, 400, { error: "mode 는 stable 또는 aggressive 예요." });
    if (!process.env.MODE_PASSWORD || !process.env.GITHUB_TOKEN) {
      return send(res, 500, { error: "서버에 MODE_PASSWORD, GITHUB_TOKEN 환경 변수가 없어요." });
    }
    if (typeof password !== "string" || !same(password, process.env.MODE_PASSWORD)) {
      await sleep(1000);   // 비밀번호 대입을 느리게
      return send(res, 403, { error: "비밀번호가 맞지 않아요." });
    }

    const { data, sha } = await readFile(MODE_PATH);
    if (data?.mode === mode) return send(res, 200, { mode, changedAt: data.changed_at, unchanged: true });
    const changedAt = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19) + "+09:00";
    const content = { mode, changed_at: changedAt, by: "대시보드" };
    await github(MODE_PATH, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `투자 성향 → ${MODES[mode]} (대시보드)`,
        content: Buffer.from(JSON.stringify(content, null, 1) + "\n").toString("base64"),
        sha, branch: "main",
      }),
    });
    send(res, 200, { mode, changedAt });
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}
