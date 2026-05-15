const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  onMetrics: (fn) => ipcRenderer.on("metrics", (_, data) => fn(data)),
  onLog: (fn) => ipcRenderer.on("log", (_, entry) => fn(entry)),
});
