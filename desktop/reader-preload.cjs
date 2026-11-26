const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("replyReader", {
  onText(fn) {
    ipcRenderer.on("reader:text", (_event, text, reset) => fn(text, reset));
  },
});
