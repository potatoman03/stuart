import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const uiHost = process.env.STUART_UI_HOST ?? "127.0.0.1";
const uiPort = Number(process.env.STUART_UI_PORT ?? 5173);
const serverHost = process.env.HOST ?? "127.0.0.1";
const serverPort = Number(process.env.PORT ?? 8787);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@stuart/shared": resolve(__dirname, "../../packages/shared/src/index.ts")
    }
  },
  server: {
    host: uiHost,
    port: uiPort,
    proxy: {
      "/api/events": {
        target: `http://${serverHost}:${serverPort}`,
        changeOrigin: true,
        headers: {
          "Connection": "keep-alive",
        },
      },
      "/api": {
        target: `http://${serverHost}:${serverPort}`,
        changeOrigin: true
      }
    }
  }
});
