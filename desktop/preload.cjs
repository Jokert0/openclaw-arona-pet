const { contextBridge, ipcRenderer } = require("electron");

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("pet", {
    onState(fn) {
      if (typeof fn !== "function") throw new TypeError("onState 需要回调函数");
      let active = true;
      let revision = 0;
      function deliver(packet) {
        if (active && packet && packet.revision > revision) {
          revision = packet.revision;
          fn(packet.state);
        }
      }
      // Subscribe before reading so a delayed initial snapshot cannot replace a newer event.
      const listener = (_event, packet) => deliver(packet);
      ipcRenderer.on("pet:changed", listener);
      ipcRenderer.invoke("pet:state").then(deliver);
      return () => {
        active = false;
        ipcRenderer.removeListener("pet:changed", listener);
      };
    },
    send: (text) => ipcRenderer.invoke("pet:send", text),
    readReply: () => ipcRenderer.invoke("pet:read-reply"),
    onReading(fn) {
      ipcRenderer.on("pet:reading", (_event, open) => fn(open));
    },
    menu: () => ipcRenderer.invoke("pet:menu"),
    onCompact(fn) {
      ipcRenderer.on("pet:compact", (_event, enabled) => fn(enabled));
    },
    onCursor(fn) {
      ipcRenderer.on("pet:cursor", (_event, point) => fn(point));
    },
    move: (x, y) => ipcRenderer.invoke("pet:move", x, y),
    model: () => ipcRenderer.invoke("pet:model"),
  });
}
