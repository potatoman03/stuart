const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("stuartDesktop", {
  pickFolder: () => ipcRenderer.invoke("stuart:pick-folder"),
});
