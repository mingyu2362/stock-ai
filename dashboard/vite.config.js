import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import account from "./api/account.js";
import stock from "./api/stock.js";
import naver from "./api/naver.js";
import mode from "./api/mode.js";

// 개발 서버에서도 /api/* 가 동작하도록 Vercel 함수와 같은 코드를 연결한다
const devApi = {
  name: "dev-api",
  configureServer(server) {
    server.middlewares.use("/api/naver", (req, res) => naver(req, res));
    server.middlewares.use("/api/account", (req, res) => account(req, res));
    server.middlewares.use("/api/stock", (req, res) => stock(req, res));
    server.middlewares.use("/api/mode", (req, res) => mode(req, res));
  },
};

// /api/mode 가 쓰는 GITHUB_TOKEN·MODE_PASSWORD 를 dashboard/.env.local 에서 읽는다 (Vercel 에서는 환경 변수)
export default defineConfig(({ mode: m }) => {
  Object.assign(process.env, loadEnv(m, process.cwd(), ""));
  return { plugins: [react(), devApi] };
});
