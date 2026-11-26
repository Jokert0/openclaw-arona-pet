const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  screen,
  session,
  Tray,
} = require("electron");
const { existsSync, readFileSync, renameSync, writeFileSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { createAssets, CORE_URL, MODEL_URL } = require("./assets.cjs");

const root = path.resolve(__dirname, "..");
const view = path.join(root, "view", "index.html");
const viewURL = pathToFileURL(view).href;
const icon = path.join(__dirname, "tray.png");
const baseSize = { width: 420, height: 560 };
const scaleView = path.join(root, "view", "scale.html");
let scalePercent = 100;
let scalePanel;
const readerView = path.join(root, "view", "reader.html");
let reader;
let followReply = false;
let readerText = "";
let lastReply = "";
let compactMode = false;

const settingsFile = path.join(app.getAppPath(), "pet-settings.json");
let saveTimer;
let settingsReady = false;

function validScale(percent) {
  return Number.isInteger(percent) && percent >= 10 && percent <= 150;
}

function readSettings() {
  try {
    return JSON.parse(readFileSync(settingsFile, "utf8")) ?? {};
  } catch (error) {
    if (error.code === "ENOENT") return;
    console.warn("桌宠设置读取失败，将使用默认设置", error.message);
    return {};
  }
}

function saveSettings() {
  clearTimeout(saveTimer);
  if (!settingsReady || !win || win.isDestroyed()) return false;
  const settings = { scalePercent, position: win.getPosition(), compactMode };
  try {
    writeFileSync(settingsFile + ".tmp", JSON.stringify(settings, null, 2) + "\n", "utf8");
    renameSync(settingsFile + ".tmp", settingsFile);
    return true;
  } catch (error) {
    console.warn("桌宠设置保存失败", error.message);
    return false;
  }
}

function scheduleSave() {
  if (!settingsReady || quitting) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 250);
}

function petSize(percent = scalePercent) {
  return { width: Math.round(baseSize.width * percent / 100), height: Math.round(baseSize.height * percent / 100) };
}

// On fractional-DPI Windows displays, setPosition can round the previous bounds
// up on each move. Always supply the selected DIP dimensions along with the origin.
function movePet(x, y) {
  win.setBounds({ x, y, ...petSize() });
  scheduleSave();
}
let win, tray, pet, latest;
let revision = 0;
let ignoringMouse = false;
let quitting = false;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "petasset",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function placement(saved) {
  const valid = Array.isArray(saved) && saved.length === 2 && saved.every(Number.isSafeInteger);
  const display = valid
    ? screen.getDisplayNearestPoint({ x: saved[0], y: saved[1] })
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const size = petSize();
  const right = Math.max(area.x, area.x + area.width - size.width);
  const bottom = Math.max(area.y, area.y + area.height - size.height);
  return valid
    ? [Math.max(area.x, Math.min(right, saved[0])), Math.max(area.y, Math.min(bottom, saved[1]))]
    : [Math.max(area.x, right - 16), Math.max(area.y, bottom - 16)];
}

function recover(reset = false) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  movePet(...placement(reset ? undefined : win.getPosition()));
  ignoringMouse = false;
  win.setIgnoreMouseEvents(false);
  win.show();
  win.focus();
  updateTray();
}

function openScalePanel() {
  if (scalePanel) {
    scalePanel.show();
    scalePanel.focus();
    return;
  }
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const [x, y] = win.getPosition();
  scalePanel = new BrowserWindow({
    title: "桌宠大小", icon, width: 300, height: 106, useContentSize: true,
    show: false, resizable: false, alwaysOnTop: true, minimizable: false,
    webPreferences: {
      preload: path.join(__dirname, "scale-preload.cjs"),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  scalePanel.removeMenu();
  const [width, height] = scalePanel.getSize();
  scalePanel.setPosition(
    Math.max(area.x, Math.min(x - width, area.x + area.width - width)),
    Math.max(area.y, Math.min(y, area.y + area.height - height)),
  );
  scalePanel.once("ready-to-show", () => scalePanel.show());
  scalePanel.once("closed", () => { scalePanel = undefined; });
  scalePanel.loadFile(scaleView);
}

function readerBounds() {
  const petBounds = win.getBounds();
  const area = screen.getDisplayMatching(petBounds).workArea;
  const left = petBounds.x - area.x;
  const right = area.x + area.width - petBounds.x - petBounds.width;
  const width = Math.min(380, area.width, Math.max(260, Math.max(left, right) - 8));
  const height = Math.min(360, area.height);
  const x = left >= right ? petBounds.x - width - 8 : petBounds.x + petBounds.width + 8;
  return { width, height,
    x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(petBounds.y + 14, area.y + area.height - height)),
  };
}

function openReader(text, follow) {
  if (!text) return;
  followReply = follow;
  readerText = text;
  if (reader) {
    reader.webContents.send("reader:text", text, true);
    reader.show();
    return;
  }
  reader = new BrowserWindow({
    ...readerBounds(), title: "阿洛娜的回复", icon, frame: false, show: false,
    resizable: false, alwaysOnTop: true, skipTaskbar: true, backgroundColor: "#f4faff",
    webPreferences: { preload: path.join(__dirname, "reader-preload.cjs"),
      sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  reader.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  reader.webContents.on("will-navigate", (event) => event.preventDefault());
  reader.webContents.once("did-finish-load", () => {
    reader.webContents.send("reader:text", readerText, true);
    reader.show();
  });
  win.webContents.send("pet:reading", true);
  reader.once("closed", () => {
    reader = undefined;
    readerText = "";
    followReply = false;
    if (!win.isDestroyed()) win.webContents.send("pet:reading", false);
  });
  reader.loadFile(readerView);
}

function makeMenu() {
  const state = latest?.state;
  const status = state ? (state.connected ? "在线" : "离线") : "连接中";
  return Menu.buildFromTemplate([
    { label: `Gateway：${status}`, enabled: false },
    ...(!state?.connected && state?.notice ? [{ label: state.notice, enabled: false }] : []),
    { type: "separator" },
    { label: "查看上次回复", enabled: Boolean(lastReply), click: () => openReader(lastReply, false) },
    { label: "显示并恢复互动", click: () => recover() },
    {
      label: "精简模式",
      type: "checkbox",
      checked: compactMode,
      click: (item) => {
        compactMode = item.checked;
        scheduleSave();
        win.webContents.send("pet:compact", compactMode);
        updateTray();
      },
    },
    { label: "隐藏桌宠", enabled: win.isVisible(), click: () => win.hide() },
    {
      label: "鼠标穿透",
      type: "checkbox",
      checked: ignoringMouse,
      click: (item) => {
        ignoringMouse = item.checked;
        win.setIgnoreMouseEvents(ignoringMouse);
        updateTray();
      },
    },
    { label: "调整桌宠大小…", click: openScalePanel },
    { label: "移回主屏幕", click: () => recover(true) },
    { type: "separator" },
    { label: "退出", click: () => app.quit() },
  ]);
}

function updateTray() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(makeMenu());
}

function registerIPC() {
  function handle(channel, fn, owner = () => win, url = viewURL) {
    ipcMain.handle(channel, (event, ...args) => {
      const target = owner();
      if (
        !target ||
        target.isDestroyed() ||
        event.sender !== target.webContents ||
        !event.senderFrame ||
        event.senderFrame !== target.webContents.mainFrame ||
        event.senderFrame.url !== url
      ) {
        throw new Error("桌宠窗口不可用");
      }
      return fn(...args);
    });
  }
  handle("pet:read-reply", () => openReader(latest?.state.reply, Boolean(latest?.state.busy)));
  handle("pet:scale", (percent) => {
    if (percent === undefined) return scalePercent;
    if (!validScale(percent)) throw new Error("比例超出范围");
    scalePercent = percent;
    movePet(...placement(win.getPosition()));
    return scalePercent;
  }, () => scalePanel, pathToFileURL(scaleView).href);
  handle("pet:state", () => latest);
  handle("pet:model", () => ({ url: MODEL_URL, core: CORE_URL }));
  handle("pet:menu", () => {
    makeMenu().popup({ window: win });
  });
  handle("pet:send", (text) => {
    if (typeof text !== "string" || !text.trim()) throw new Error("消息不能为空");
    return pet.send(text);
  });
  handle("pet:move", (x, y) => {
    if (Number.isSafeInteger(x) && Number.isSafeInteger(y) && !ignoringMouse) movePet(x, y);
  });
}

function onState(state) {
  const previous = latest?.state;
  latest = { revision: ++revision, state };
  const hadReply = Boolean(lastReply);
  if (previous?.busy && !state.busy && state.connected && !state.notice && state.reply) {
    lastReply = state.reply;
  }
  if (reader && followReply) {
    if (state.reply && state.reply !== readerText) {
      readerText = state.reply;
      reader.webContents.send("reader:text", readerText, false);
    }
    if (!state.busy) followReply = false;
  }
  if (hadReply !== Boolean(lastReply) || previous?.connected !== state.connected || (!state.connected && previous?.notice !== state.notice)) {
    updateTray();
  }
  if (win && !win.isDestroyed() && win.webContents.getURL() === viewURL) {
    win.webContents.send("pet:changed", latest);
  }
}

async function boot() {
  const local = session.fromPartition("persist:arona-pet");
  const model = path.join(root, "assets", "阿洛娜桌宠模型");
  const core = path.join(root, "assets", "live2dcubismcore.min.js");
  const assets = createAssets({
    directory: process.env.ARONA_MODEL_DIR || (existsSync(model) ? model : path.resolve(root, "..", "阿洛娜桌宠模型")),
    core: process.env.ARONA_CUBISM_CORE || (existsSync(core) ? core : path.join(root, ".runtime", "live2dcubismcore.min.js")),
  });
  local.protocol.handle("petasset", assets);
  local.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  local.setPermissionCheckHandler(() => false);
  const viewRoot = path.dirname(view) + path.sep;
  local.webRequest.onBeforeRequest((details, done) => {
    const url = new URL(details.url);
    let allow = ["petasset:", "data:", "blob:", "about:", "devtools:"].includes(url.protocol);
    if (url.protocol === "file:" && !url.host) {
      try {
        allow = fileURLToPath(url).startsWith(viewRoot);
      } catch {
        allow = false;
      }
    }
    done({ cancel: !allow });
  });
  const { createPetSession } = await import("../session.mjs");
  pet = await createPetSession({ onState });
  if (quitting) return;
  const saved = readSettings();
  if (validScale(saved?.scalePercent)) scalePercent = saved.scalePercent;
  compactMode = saved?.compactMode === true;
  const [x, y] = placement(saved?.position);
  win = new BrowserWindow({
    ...petSize(),
    x,
    y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    title: "阿洛娜桌宠",
    icon,
    webPreferences: {
      session: local,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame || event.url !== viewURL) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("moved", scheduleSave);
  // Cursor and content bounds share Electron's desktop DIP coordinate system.
  let cursorTimer;
  function startTracking() {
    if (cursorTimer) return;
    let lastX, lastY;
    function sample() {
      const point = screen.getCursorScreenPoint();
      const bounds = win.getContentBounds();
      const x = point.x - bounds.x;
      const y = point.y - bounds.y;
      if (x === lastX && y === lastY) return;
      win.webContents.send("pet:cursor", { x, y });
      lastX = x;
      lastY = y;
    }
    sample();
    cursorTimer = setInterval(sample, 33);
  }
  function stopTracking() {
    clearInterval(cursorTimer);
    cursorTimer = undefined;
  }
  win.on("show", startTracking);
  win.on("hide", () => {
    stopTracking();
    reader?.close();
  });
  win.on("move", () => reader?.setBounds(readerBounds()));
  win.on("resize", () => reader?.setBounds(readerBounds()));
  win.on("closed", stopTracking);
  win.webContents.on("did-finish-load", () => {
    win.webContents.send("pet:compact", compactMode);
    stopTracking();
    if (win.isVisible()) startTracking();
  });
  win.on("show", updateTray);
  win.on("hide", updateTray);
  tray = new Tray(icon);
  tray.setToolTip("阿洛娜桌宠 · 单击恢复互动");
  tray.on("click", () => recover());
  updateTray();
  registerIPC();
  await win.loadFile(view);
  if (quitting) return;
  // Older builds kept only the position in the renderer partition.
  let position = saved?.position;
  let legacyPosition;
  if (saved === undefined) {
    try {
      legacyPosition = await win.webContents.executeJavaScript('localStorage.getItem("arona.window-position")');
      if (legacyPosition) position = JSON.parse(legacyPosition);
    } catch { /* Keep the primary display placement. */ }
  }
  if (quitting) return;
  // Windows can round or constrain the initial bounds during window creation.
  movePet(...placement(position));
  settingsReady = true;
  if (saveSettings() && legacyPosition) {
    await win.webContents.executeJavaScript('localStorage.removeItem("arona.window-position")').catch(() => {});
  }
  if (quitting) return;
  win.showInactive();
  await pet.start();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => recover());
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    saveSettings();
    if (!pet) return;
    event.preventDefault();
    Promise.resolve()
      .then(() => pet.stop())
      .catch(() => console.warn("桌宠会话停止失败"))
      .finally(() => app.quit());
  });
  app
    .whenReady()
    .then(boot)
    .catch((error) => {
      dialog.showErrorBox("阿洛娜桌宠启动失败", error.message);
      app.quit();
    });
}
