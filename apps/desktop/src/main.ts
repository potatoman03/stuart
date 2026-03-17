import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain } from "electron";

const uiPort = process.env.STUART_UI_PORT ?? "5173";
const uiHost = process.env.STUART_UI_HOST ?? "127.0.0.1";
const defaultUrl = process.env.STUART_UI_URL ?? `http://${uiHost}:${uiPort}`;

const resolvePreloadPath = () => {
  if (process.env.NODE_ENV === "production") {
    return path.resolve(app.getAppPath(), "apps/desktop/src/preload.cjs");
  }

  return fileURLToPath(new URL("./preload.cjs", import.meta.url));
};

ipcMain.handle("stuart:pick-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Select a study folder",
    buttonLabel: "Use this folder",
    properties: ["openDirectory", "createDirectory"],
  });

  return result.canceled ? null : (result.filePaths[0] ?? null);
});

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1180,
    minHeight: 760,
    title: "Stuart",
    backgroundColor: "#f4efe4",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: resolvePreloadPath(),
    }
  });

  if (process.env.NODE_ENV === "production") {
    window.loadFile(path.resolve("apps/web/dist/index.html"));
    return;
  }

  window.loadURL(defaultUrl);
};

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
