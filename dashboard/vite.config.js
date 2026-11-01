import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import account from "./api/account.js";
import stock from "./api/stock.js";
import naver from "./api/naver.js";

// 개발 서버에서도 /api/* 가 동작하도록 Vercel 함수와 같은 코드를 연결한다
const devApi = {
  name: "dev-api",
  configureServer(server) {
    server.middlewares.use("/api/naver", (req, res) => naver(req, res));
    server.middlewares.use("/api/account", (req, res) => account(req, res));
    server.middlewares.use("/api/stock", (req, res) => stock(req, res));
  },
};

export default defineConfig({
  plugins: [react(), devApi],
});
