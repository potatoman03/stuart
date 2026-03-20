import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;
const mainFile = fileURLToPath(new URL("./main.ts", import.meta.url));
const uiPort = process.env.STUART_UI_PORT ?? "5173";
const uiHost = process.env.STUART_UI_HOST ?? "127.0.0.1";
const apiPort = process.env.PORT ?? process.env.STUART_API_PORT ?? "8787";
const nodeOptions = [process.env.NODE_OPTIONS, "--import tsx"].filter(Boolean).join(" ");

const child = spawn(
  electronBinary,
  [mainFile],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptions,
      STUART_UI_URL: process.env.STUART_UI_URL ?? `http://${uiHost}:${uiPort}`,
      STUART_API_ORIGIN: process.env.STUART_API_ORIGIN ?? `http://127.0.0.1:${apiPort}`,
      STUART_APP_VERSION: process.env.STUART_APP_VERSION ?? "0.1.0",
      STUART_IS_PACKAGED: "0",
      NODE_ENV: process.env.NODE_ENV ?? "development",
      ELECTRON_ENABLE_LOGGING: "true",
      ELECTRON_NO_ATTACH_CONSOLE: "true",
    },
    cwd: path.resolve(fileURLToPath(new URL("../../..", import.meta.url))),
  }
);

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
