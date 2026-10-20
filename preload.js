const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quotist", {
  call: (action, payload) => ipcRenderer.invoke("api", action, payload),
  exportText: (items, name) => ipcRenderer.invoke("export-text", items, name),
  exportPdf: (items, name) => ipcRenderer.invoke("export-pdf", items, name),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  minimize: () => ipcRenderer.send("win-min"),
  maximize: () => ipcRenderer.send("win-max"),
  close: () => ipcRenderer.send("win-close")
});
