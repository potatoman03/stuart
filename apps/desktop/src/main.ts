import { createServer } from "node:net";
import path from "node:path";
import { execSync, fork, spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

type RunningWebServer = {
  port: number;
  child: ChildProcess;
  close: () => Promise<void>;
};

type CodexLoginState = {
  status: "idle" | "launching" | "waiting" | "completed" | "error";
  message: string;
  recentLines: string[];
  verificationUri?: string;
  userCode?: string;
  updatedAt: string;
};

type LoadingStepState = {
  id: string;
  label: string;
  status: "pending" | "active" | "done";
};

type LoadingWindowState = {
  title: string;
  detail: string;
  steps: LoadingStepState[];
};

const uiPort = process.env.STUART_UI_PORT ?? "4173";
const uiHost = process.env.STUART_UI_HOST ?? "127.0.0.1";
const defaultUrl = process.env.STUART_UI_URL ?? `http://${uiHost}:${uiPort}`;

// In production, resolve a free port dynamically so we never clash with dev servers
// or other running instances. Dev mode uses the fixed ports from env.
let apiPort = Number(process.env.PORT ?? process.env.STUART_API_PORT ?? 8787);
let apiOrigin = process.env.STUART_API_ORIGIN ?? `http://127.0.0.1:${apiPort}`;

async function reserveFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

let mainWindow: BrowserWindow | null = null;
let runningWebServer: RunningWebServer | null = null;
let codexLoginChild: ChildProcess | null = null;
let codexLoginState: CodexLoginState = createCodexLoginState();
let codexLoginResetTimer: ReturnType<typeof setTimeout> | null = null;

const LOADING_STEPS: Array<{ id: string; label: string }> = [
  { id: "runtime", label: "Starting Stuart" },
  { id: "server", label: "Launching the local study server" },
  { id: "health", label: "Checking the local runtime" },
  { id: "ui", label: "Opening your study workspace" },
];

function isDevelopment() {
  return !app.isPackaged;
}

/**
 * Kill orphaned Codex app-server processes left behind by a previous force-quit.
 * Matches processes whose command line includes our app's resource path.
 */
function cleanupOrphanedProcesses() {
  if (isDevelopment()) return;
  try {
    const appPath = app.getAppPath();
    // Find codex app-server processes spawned from our bundle
    const result = execSync(
      `pgrep -f "codex app-server" 2>/dev/null || true`,
      { encoding: "utf8", timeout: 3000 }
    ).trim();
    if (!result) return;
    for (const line of result.split("\n")) {
      const pid = Number(line.trim());
      if (!pid || pid === process.pid) continue;
      try {
        // Only kill processes from our app bundle, not other Codex instances
        const cmdline = execSync(`ps -p ${pid} -o command= 2>/dev/null || true`, {
          encoding: "utf8", timeout: 2000
        }).trim();
        if (cmdline.includes(appPath) || cmdline.includes("Stuart.app")) {
          process.kill(pid, "SIGTERM");
        }
      } catch { /* process already gone */ }
    }
  } catch { /* non-critical */ }
}

function resolveDesktopDistPath(...parts: string[]) {
  if (isDevelopment()) {
    return path.resolve(fileURLToPath(new URL("../", import.meta.url)), ...parts);
  }

  return path.resolve(app.getAppPath(), "dist", ...parts);
}

function resolveServerBundlePath() {
  return pathToFileURL(resolveDesktopDistPath("web-server", "index.js")).href;
}

function resolvePreloadPath() {
  if (isDevelopment()) {
    return fileURLToPath(new URL("./preload.cjs", import.meta.url));
  }

  return resolveDesktopDistPath("preload.cjs");
}

function resolveCodexLauncherPath() {
  if (isDevelopment()) {
    return fileURLToPath(new URL("./codex-launcher.mjs", import.meta.url));
  }

  return resolveDesktopDistPath("codex-launcher.mjs");
}

function resolveDesktopDataDir() {
  return process.env.STUART_DATA_DIR && process.env.STUART_DATA_DIR.trim() !== ""
    ? path.resolve(process.env.STUART_DATA_DIR)
    : path.join(app.getPath("userData"), "data");
}

function configureDesktopManagedCodex() {
  if (process.env.CODEX_BINARY_PATH && process.env.CODEX_BINARY_PATH.trim() !== "") {
    return;
  }

  process.env.CODEX_BINARY_PATH = process.execPath;
  process.env.CODEX_BINARY_SCRIPT_PATH = resolveCodexLauncherPath();
  process.env.CODEX_BINARY_RUN_AS_NODE = "1";
  process.env.STUART_DESKTOP_MANAGED_CODEX = "1";
}

function buildCodexCommandArgs(args: string[]) {
  const launcherPath = process.env.CODEX_BINARY_SCRIPT_PATH?.trim();
  return [...(launcherPath ? [launcherPath] : []), ...args];
}

function buildCodexCommandEnv() {
  return {
    ...process.env,
    ...(process.env.CODEX_BINARY_RUN_AS_NODE === "1"
      ? { ELECTRON_RUN_AS_NODE: "1" }
      : {}),
  };
}

async function waitForHealthcheck(url: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000)
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Keep retrying until the deadline.
    }

    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  throw new Error(`Stuart desktop server did not become healthy at ${url}.`);
}

function buildLoadingSteps(activeId: string, completedIds: string[] = []): LoadingStepState[] {
  const done = new Set(completedIds);
  return LOADING_STEPS.map((step) => ({
    ...step,
    status: done.has(step.id) ? "done" : step.id === activeId ? "active" : "pending",
  }));
}

function updateLoadingWindow(window: BrowserWindow | null, state: LoadingWindowState) {
  if (!window || window.isDestroyed()) {
    return;
  }

  const payload = JSON.stringify(state).replace(/</g, "\\u003c");
  void window.webContents.executeJavaScript(`window.__stuartSetLoadingState?.(${payload});`, true).catch(() => {
    // Ignore splash update failures; the main app will still boot.
  });
}

async function stopEmbeddedWebServer() {
  if (!runningWebServer) return;
  try {
    await runningWebServer.close();
  } catch { /* best effort */ }
  runningWebServer = null;
}

async function restartEmbeddedWebServer() {
  await stopEmbeddedWebServer();
  await startEmbeddedWebServer();
  // Update the preload env so the renderer picks up the (potentially new) port
  process.env.STUART_API_ORIGIN = apiOrigin;
  // Reload the main window to reconnect
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(apiOrigin);
  }
}

let healthWatchdogTimer: ReturnType<typeof setInterval> | null = null;

function startHealthWatchdog() {
  if (healthWatchdogTimer || isDevelopment()) return;

  healthWatchdogTimer = setInterval(async () => {
    // Don't check if we're already restarting or no server was ever started
    if (!runningWebServer && !apiOrigin) return;

    try {
      const res = await fetch(`${apiOrigin}/api/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return; // healthy
    } catch {
      // Server not responding
    }

    // Check if the child process is still alive
    const child = runningWebServer?.child;
    if (child && child.exitCode === null) {
      // Process alive but not responding — might be blocked. Give it one more chance.
      try {
        const retry = await fetch(`${apiOrigin}/api/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (retry.ok) return;
      } catch { /* still dead */ }
    }

    // Server is down — restart it
    process.stderr.write("[stuart] Health watchdog: server not responding. Restarting...\n");
    try {
      await restartEmbeddedWebServer();
      process.stderr.write("[stuart] Health watchdog: server restarted successfully.\n");
    } catch (err) {
      process.stderr.write(`[stuart] Health watchdog: restart failed: ${err}\n`);
    }
  }, 30_000);

  // Don't let the watchdog keep the process alive on quit
  healthWatchdogTimer.unref();
}

async function startEmbeddedWebServer(onProgress?: (state: LoadingWindowState) => void) {
  if (runningWebServer || isDevelopment()) {
    return runningWebServer;
  }

  // Pick a free port so we never collide with dev servers or other instances.
  onProgress?.({
    title: "Starting Stuart",
    detail: "Nothing is being downloaded right now. Stuart is reserving a local port for your private study runtime.",
    steps: buildLoadingSteps("server", ["runtime"]),
  });
  const freePort = await reserveFreePort();
  apiPort = freePort;
  apiOrigin = `http://127.0.0.1:${freePort}`;

  configureDesktopManagedCodex();

  const dataDir = resolveDesktopDataDir();
  const serverScript = resolveDesktopDistPath("web-server", "index.js");

  // Fork the server as a separate process so heavy runtime work (ingestion,
  // Codex turns) never blocks the Electron main-process event loop.
  // In Electron, fork() uses the Electron binary — ELECTRON_RUN_AS_NODE=1
  // makes it behave as plain Node.js.
  onProgress?.({
    title: "Starting Stuart",
    detail: "The local study server is launching now. Your files and study history stay on this Mac.",
    steps: buildLoadingSteps("health", ["runtime", "server"]),
  });
  const child = fork(serverScript, [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(apiPort),
      STUART_API_ORIGIN: apiOrigin,
      STUART_DATA_DIR: dataDir,
      STUART_WORKSPACE_ROOT: app.getAppPath(),
      STUART_RUNTIME_MODE: "standalone",
      STUART_WEB_STATIC_DIR: resolveDesktopDistPath("web-client"),
    },
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    process.stdout.write(chunk);
  });

  runningWebServer = {
    port: apiPort,
    child,
    close: () => new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 3000).unref();
    }),
  };

  await waitForHealthcheck(`${apiOrigin}/api/health`, 30_000);
  return runningWebServer;
}

async function launchCodexLogin() {
  configureDesktopManagedCodex();

  if (codexLoginChild && codexLoginChild.exitCode === null) {
    updateCodexLoginState({
      status: "waiting",
      message: "Sign-in is already in progress.",
    });
    return true;
  }

  clearCodexLoginResetTimer();
  codexLoginState = createCodexLoginState({
    status: "launching",
    message: "Starting ChatGPT sign-in…",
  });

  try {
    const child = spawn(
      process.env.CODEX_BINARY_PATH || process.execPath,
      buildCodexCommandArgs(["login", "--device-auth"]),
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: buildCodexCommandEnv(),
      }
    );
    codexLoginChild = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      handleCodexLoginOutput(chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      handleCodexLoginOutput(chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      codexLoginChild = null;
      updateCodexLoginState({
        status: "error",
        message: "Stuart could not start the ChatGPT sign-in flow.",
        recentLines: [error instanceof Error ? error.message : String(error)],
      });
    });

    child.on("exit", (code) => {
      codexLoginChild = null;
      if (code === 0) {
        updateCodexLoginState({
          status: "completed",
          message: "ChatGPT connected. Stuart is refreshing your study engine.",
        });
        codexLoginResetTimer = setTimeout(() => {
          codexLoginState = createCodexLoginState();
        }, 10_000);
        return;
      }

      updateCodexLoginState({
        status: "error",
        message: "The sign-in flow stopped before it finished.",
      });
    });

    updateCodexLoginState({
      status: "waiting",
      message: "Continue with ChatGPT in your browser to finish connecting Stuart.",
    });
    return true;
  } catch (error) {
    updateCodexLoginState({
      status: "error",
      message: "Stuart could not start the ChatGPT sign-in flow.",
      recentLines: [error instanceof Error ? error.message : String(error)],
    });
    return false;
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    title: "Stuart",
    backgroundColor: "#f4efe4",
    autoHideMenuBar: true,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: resolvePreloadPath(),
    }
  });

  mainWindow = window;

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  if (isDevelopment()) {
    void window.loadURL(defaultUrl);
    return window;
  }

  // In production, load from the embedded HTTP server (same-origin, no CORS issues).
  void window.loadURL(apiOrigin);
  return window;
}

function showLoadingWindow(): BrowserWindow {
  const loading = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    resizable: false,
    transparent: false,
    backgroundColor: "#f4efe4",
    center: true,
    show: false,
    alwaysOnTop: true,
    titleBarStyle: "hidden",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  loading.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
background:#f4efe4;color:#3a3a3a;display:flex;flex-direction:column;
align-items:center;justify-content:center;height:100vh;-webkit-app-region:drag;
user-select:none;padding:28px}
.shell{width:100%;max-width:340px;display:flex;flex-direction:column;align-items:center;text-align:center}
h1{font-size:28px;font-weight:700;letter-spacing:-0.5px;margin-bottom:12px;color:#296767}
p{font-size:14px;opacity:0.78;line-height:1.45}
.dot-pulse{display:flex;gap:6px;margin-top:18px}
.dot-pulse span{width:8px;height:8px;border-radius:50%;background:#296767;opacity:0.3;
animation:pulse 1.2s ease-in-out infinite}
.dot-pulse span:nth-child(2){animation-delay:0.2s}
.dot-pulse span:nth-child(3){animation-delay:0.4s}
.loading-steps{margin-top:18px;width:100%;display:flex;flex-direction:column;gap:8px;text-align:left}
.loading-step{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:12px;background:rgba(41,103,103,0.07);font-size:12px;color:#4a4a4a}
.loading-step-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;background:#c4c4bf}
.loading-step.active .loading-step-dot{background:#296767;box-shadow:0 0 0 4px rgba(41,103,103,0.15)}
.loading-step.done .loading-step-dot{background:#1f8f63}
.loading-step.pending{opacity:0.7}
@keyframes pulse{0%,100%{opacity:0.3;transform:scale(1)}50%{opacity:1;transform:scale(1.2)}}
</style></head>
<body>
<div class="shell">
<h1 id="loading-title">Stuart</h1>
<p id="loading-detail">Starting your study workspace&hellip;</p>
<div class="dot-pulse"><span></span><span></span><span></span></div>
<div class="loading-steps" id="loading-steps"></div>
</div>
<script>
window.__stuartSetLoadingState = function(payload){
  const title = document.getElementById("loading-title");
  const detail = document.getElementById("loading-detail");
  const stepsRoot = document.getElementById("loading-steps");
  if (title) title.textContent = payload && payload.title ? payload.title : "Stuart";
  if (detail) detail.textContent = payload && payload.detail ? payload.detail : "Starting your study workspace…";
  if (!stepsRoot) return;
  stepsRoot.innerHTML = "";
  const steps = Array.isArray(payload && payload.steps) ? payload.steps : [];
  for (const step of steps) {
    const row = document.createElement("div");
    row.className = "loading-step " + (step.status || "pending");
    const dot = document.createElement("span");
    dot.className = "loading-step-dot";
    const label = document.createElement("span");
    label.textContent = step.label || "";
    row.appendChild(dot);
    row.appendChild(label);
    stepsRoot.appendChild(row);
  }
};
</body></html>`)}`);

  loading.once("ready-to-show", () => loading.show());
  return loading;
}

async function boot() {
  const lock = app.requestSingleInstanceLock();
  if (!lock) {
    app.quit();
    return;
  }

  app.on("second-instance", () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  await app.whenReady();

  cleanupOrphanedProcesses();

  process.env.STUART_IS_PACKAGED = app.isPackaged ? "1" : "0";
  process.env.STUART_APP_VERSION = app.getVersion();
  configureDesktopManagedCodex();

  let loadingWindow: BrowserWindow | null = null;
  if (!isDevelopment()) {
    loadingWindow = showLoadingWindow();
    updateLoadingWindow(loadingWindow, {
      title: "Starting Stuart",
      detail: "Nothing is being downloaded right now. Stuart is waking up its built-in study runtime and checking the local environment.",
      steps: buildLoadingSteps("runtime"),
    });
    await startEmbeddedWebServer((state) => updateLoadingWindow(loadingWindow, state));
  }

  // Set API origin AFTER the server starts so the dynamic port is reflected.
  process.env.STUART_API_ORIGIN = apiOrigin;

  // Start the health watchdog to auto-restart the server if it crashes
  startHealthWatchdog();

  updateLoadingWindow(loadingWindow, {
    title: "Opening your workspace",
    detail: "The study engine is ready. Stuart is loading the app interface now.",
    steps: buildLoadingSteps("ui", ["runtime", "server", "health"]),
  });
  const window = createWindow();

  if (loadingWindow && !loadingWindow.isDestroyed()) {
    await Promise.race([
      new Promise<void>((resolve) => {
        window.webContents.once("did-finish-load", () => resolve());
      }),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
    if (!loadingWindow.isDestroyed()) {
      loadingWindow.close();
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}

ipcMain.handle("stuart:pick-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select a study folder",
    buttonLabel: "Use this folder",
    properties: ["openDirectory", "createDirectory"],
  });

  return result.canceled ? null : (result.filePaths[0] ?? null);
});

ipcMain.handle("stuart:show-in-folder", async (_event, filePath: string) => {
  if (!filePath || typeof filePath !== "string") return false;
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle("stuart:open-external", async (_event, url: string) => {
  if (!url || typeof url !== "string") {
    return false;
  }

  // Only allow http/https URLs to prevent protocol handler exploits
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
  } catch {
    return false;
  }

  await shell.openExternal(url);
  return true;
});

ipcMain.handle("stuart:start-codex-login", async () => {
  return launchCodexLogin();
});

ipcMain.handle("stuart:get-codex-login-state", async () => {
  return codexLoginState;
});

ipcMain.handle("stuart:restart-server", async () => {
  try {
    await restartEmbeddedWebServer();
    return true;
  } catch {
    return false;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (healthWatchdogTimer) {
    clearInterval(healthWatchdogTimer);
    healthWatchdogTimer = null;
  }
  if (codexLoginChild && codexLoginChild.exitCode === null) {
    codexLoginChild.kill("SIGTERM");
    codexLoginChild = null;
  }
  clearCodexLoginResetTimer();
  if (runningWebServer) {
    void runningWebServer.close().catch(() => undefined);
    runningWebServer = null;
  }
});

void boot().catch((error) => {
  dialog.showErrorBox(
    "Error launching Stuart",
    error instanceof Error ? error.message : String(error)
  );
  app.quit();
});

function createCodexLoginState(
  patch: Partial<CodexLoginState> = {}
): CodexLoginState {
  return {
    status: "idle",
    message: "Ready to connect your ChatGPT account.",
    recentLines: [],
    updatedAt: new Date().toISOString(),
    ...patch,
  };
}

function updateCodexLoginState(patch: Partial<CodexLoginState>) {
  codexLoginState = {
    ...codexLoginState,
    ...patch,
    recentLines: patch.recentLines ?? codexLoginState.recentLines,
    updatedAt: new Date().toISOString(),
  };
}

function handleCodexLoginOutput(rawChunk: string) {
  const nextLines = rawChunk
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (nextLines.length === 0) {
    return;
  }

  const recentLines = [...codexLoginState.recentLines, ...nextLines].slice(-8);
  const verificationUri =
    codexLoginState.verificationUri ??
    nextLines
      .map((line) => line.match(/https?:\/\/\S+/)?.[0]?.replace(/[),.]$/, ""))
      .find(Boolean);
  const userCode =
    codexLoginState.userCode ??
    nextLines
      .map(extractDeviceCode)
      .find(Boolean);

  const shouldOpenVerification = Boolean(verificationUri && !codexLoginState.verificationUri);

  updateCodexLoginState({
    status: "waiting",
    message: verificationUri
      ? "Finish the ChatGPT sign-in in your browser."
      : "Waiting for the ChatGPT sign-in instructions…",
    recentLines,
    verificationUri,
    userCode,
  });

  if (shouldOpenVerification && verificationUri) {
    void shell.openExternal(verificationUri).catch(() => undefined);
  }
}

function extractDeviceCode(line: string): string | undefined {
  const codeMatch = line.match(/\b([A-Z0-9]{4}(?:-[A-Z0-9]{4})+|[A-Z0-9]{6,10})\b/);
  return codeMatch?.[1];
}

function clearCodexLoginResetTimer() {
  if (codexLoginResetTimer) {
    clearTimeout(codexLoginResetTimer);
    codexLoginResetTimer = null;
  }
}
