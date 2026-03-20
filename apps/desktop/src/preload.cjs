const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stuartDesktop", {
  isDesktop: true,
  isPackaged: process.env.STUART_IS_PACKAGED === "1",
  platform: process.platform,
  appVersion: process.env.STUART_APP_VERSION || process.env.npm_package_version || "0.1.0",
  apiOrigin: process.env.STUART_API_ORIGIN || "http://127.0.0.1:8787",
  pickFolder: () => ipcRenderer.invoke("stuart:pick-folder"),
  openExternal: (url) => ipcRenderer.invoke("stuart:open-external", url),
  startCodexLogin: () => ipcRenderer.invoke("stuart:start-codex-login"),
  getCodexLoginState: () => ipcRenderer.invoke("stuart:get-codex-login-state"),
});
