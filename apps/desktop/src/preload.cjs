const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stuartDesktop", {
  isDesktop: true,
  isPackaged: process.env.STUART_IS_PACKAGED === "1",
  platform: process.platform,
  appVersion: process.env.STUART_APP_VERSION || process.env.npm_package_version || "1.0.1",
  apiOrigin: process.env.STUART_API_ORIGIN || "http://127.0.0.1:8787",
  /** Authoritative harness URL from main (dynamic port in packaged builds). Do not rely on apiOrigin alone. */
  getApiOriginSync: () => {
    try {
      return ipcRenderer.sendSync("stuart:get-api-origin-sync");
    } catch {
      return "";
    }
  },
  pickFolder: () => ipcRenderer.invoke("stuart:pick-folder"),
  openExternal: (url) => ipcRenderer.invoke("stuart:open-external", url),
  showInFolder: (filePath) => ipcRenderer.invoke("stuart:show-in-folder", filePath),
  startCodexLogin: () => ipcRenderer.invoke("stuart:start-codex-login"),
  getCodexLoginState: () => ipcRenderer.invoke("stuart:get-codex-login-state"),
  restartServer: () => ipcRenderer.invoke("stuart:restart-server"),
  encryptToken: (plaintext) => ipcRenderer.invoke("stuart:encrypt-token", plaintext),
  decryptToken: (encryptedBase64) => ipcRenderer.invoke("stuart:decrypt-token", encryptedBase64),
});
