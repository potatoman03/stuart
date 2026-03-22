import { defineConfig } from "@playwright/test";

const serverPort = 8877;
const uiPort = 5273;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${uiPort}`,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `STUART_DATA_DIR=.stuart-data-e2e PORT=${serverPort} pnpm --filter @stuart/web dev:server`,
      url: `http://127.0.0.1:${serverPort}/api/dashboard`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: `STUART_UI_PORT=${uiPort} PORT=${serverPort} pnpm --filter @stuart/web dev:client`,
      url: `http://127.0.0.1:${uiPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
