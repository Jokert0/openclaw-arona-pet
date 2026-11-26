(() => {
  const byId = (id) => document.getElementById(id);
  const api = window.pet;
  const bubble = byId("bubble");
  const bubbleText = byId("bubble-text");
  const input = byId("message");
  const canvas = byId("pet");
  let state = { connected: false, busy: false, activity: "", reply: "", notice: "" };
  let sending = false;
  let composing = false;
  let scene;
  let bubbleTimer;
  const readButton = byId("read-reply");
  let replyIsNewest = false;
  let dismissed = false;
  let showingReply = false;
  let reading = false;
  let remaining = 0;
  let expires = 0;
  let replyTimer;

  function measurePreview() {
    readButton.hidden = !showingReply || bubbleText.scrollHeight <= bubbleText.clientHeight + 1;
  }
  new ResizeObserver(measurePreview).observe(bubbleText);

  function pauseCountdown() {
    if (!expires) return;
    clearTimeout(replyTimer);
    remaining = Math.max(1, expires - performance.now());
    expires = 0;
  }
  function syncCountdown() {
    if (!showingReply || reading || bubble.matches(":hover, :focus-within")) {
      pauseCountdown();
    } else if (remaining && !expires) {
      expires = performance.now() + remaining;
      replyTimer = setTimeout(() => {
        expires = remaining = 0;
        dismissed = true;
        render();
      }, remaining);
    }
  }
  function speak(text, isReply = false) {
    showingReply = isReply;
    bubble.hidden = !text;
    bubble.classList.toggle("reply", isReply);
    if (bubbleText.textContent !== text) {
      bubbleText.textContent = text;
      bubbleText.scrollTop = 0;
    }
    measurePreview();
    syncCountdown();
  }
  function render() {
    const reply = !dismissed && state.reply;
    if (state.connected && state.notice && !document.body.classList.contains("compact")) speak(state.notice);
    else if (reply && (replyIsNewest || state.busy || !state.activity)) speak(reply, true);
    else speak(state.activity || (state.busy ? "阿洛娜在思考…" : ""));
  }
  function temporary(text) {
    if (document.body.classList.contains("compact")) return;
    clearTimeout(bubbleTimer);
    speak(text);
    bubbleTimer = setTimeout(render, 3600);
  }
  function controls() {
    byId("send").disabled = !state.connected || state.busy || sending || !input.value.trim();
  }
  bubble.addEventListener("pointerenter", pauseCountdown);
  bubble.addEventListener("pointerleave", syncCountdown);
  bubble.addEventListener("focusin", pauseCountdown);
  bubble.addEventListener("focusout", () => queueMicrotask(syncCountdown));
  readButton.addEventListener("click", () => {
    api.readReply().catch(() => temporary("全文暂时无法打开，请重试。"));
    readButton.blur();
  });
  api?.onReading((open) => {
    reading = open;
    syncCountdown();
  });
  api?.onCompact((enabled) => {
    document.body.classList.toggle("compact", enabled);
    clearTimeout(bubbleTimer);
    render();
  });
  api?.onState((next) => {
    const previous = state;
    if (next.activity !== previous.activity) replyIsNewest = false;
    if (next.reply !== previous.reply || (next.busy && !previous.busy)) {
      pauseCountdown();
      remaining = 0;
      dismissed = false;
      if (next.reply) replyIsNewest = true;
    }
    const finished = next.reply && !next.busy && (previous.busy || next.reply !== previous.reply);
    if (finished && !next.notice) replyIsNewest = true;
    state = next;
    clearTimeout(bubbleTimer);
    render();
    if (finished) {
      remaining = readButton.hidden ? 8000 : 15000;
      syncCountdown();
    }
    controls();
  });
  input.addEventListener("input", controls);
  input.addEventListener("compositionstart", () => {
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.isComposing || composing || event.keyCode === 229))
      event.preventDefault();
  });
  byId("chat").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (composing || byId("send").disabled) return;
    const draft = input.value;
    sending = true;
    controls();
    try {
      const result = await api.send(draft.trim());
      if (result === false) {
        if (!state.notice) temporary("未能确认发送，草稿已保留。");
        return;
      }
      if (input.value === draft) input.value = "";
    } catch (error) {
      temporary(`发送失败：${error.message}`);
    } finally {
      sending = false;
      controls();
    }
  });
  async function openMenu() {
    try {
      await api.menu();
    } catch {
      temporary("菜单暂不可用");
    }
  }
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openMenu();
  });
  const sounds = new Map();
  let releaseTimer;
  function sound(name) {
    clearTimeout(releaseTimer);
    if (!sounds.has(name)) sounds.set(name, new Audio(`petasset://local/sound/${name}.mp3`));
    const audio = sounds.get(name);
    function play() {
      audio.volume = 0.4;
      audio.currentTime = 0;
      audio.play().catch(() => {}); // Audio is optional when the DSH pack is absent.
    }
    const press = sounds.get("pinch_press");
    if (name === "pinch_release" && press && !press.paused) {
      const remaining = Number.isFinite(press.duration) ? press.duration - press.currentTime : 0.26;
      releaseTimer = setTimeout(play, Math.max(0, remaining * 1000 - 180));
    } else play();
  }
  function pressBody() {
    scene.press();
    sound("pinch_press");
  }
  function releaseBody() {
    scene.release();
    sound("pinch_release");
    if (!state.activity && !state.busy) temporary("老师，我在这里。");
  }
  let grab;
  canvas.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    const hit = scene?.hit(event.clientX, event.clientY);
    if (hit === "body") pressBody();
    canvas.setPointerCapture(event.pointerId);
    grab = {
      hit, id: event.pointerId, x: event.screenX, y: event.screenY,
      windowX: window.screenX, windowY: window.screenY, moved: false,
    };
  });
  function moveGrab(event) {
    const dx = event.screenX - grab.x;
    const dy = event.screenY - grab.y;
    if (!grab.moved && Math.hypot(dx, dy) < 5) return;
    if (!grab.moved && grab.hit === "body") scene?.release(true);
    grab.moved = true;
    api.move(Math.round(grab.windowX + dx), Math.round(grab.windowY + dy));
  }
  canvas.addEventListener("pointermove", (event) => {
    if (grab?.id === event.pointerId) moveGrab(event);
  });
  canvas.addEventListener("pointerup", (event) => {
    if (grab?.id !== event.pointerId) return;
    moveGrab(event);
    if (!grab.moved && scene) {
      if (grab.hit === "body") releaseBody();
      if (grab.hit === "halo") {
        scene.pulseHalo();
        sound("halo");
      }
    }
    grab = undefined;
  });
  canvas.addEventListener("lostpointercapture", () => {
    if (grab?.hit === "body") scene?.release(true);
    grab = undefined;
  });
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!event.repeat && scene) {
        pressBody();
        releaseBody();
      }
    }
  });
  let cursor;
  function updateGaze() {
    if (!scene || !cursor) return;
    const box = canvas.getBoundingClientRect();
    const x = (2 * (cursor.x - box.left)) / box.width - 1;
    const y = 1 - (2 * (cursor.y - box.top)) / box.height;
    const scale = Math.max(1, Math.abs(x), Math.abs(y));
    scene.look(x / scale, y / scale);
  }
  api?.onCursor((point) => {
    cursor = point;
    updateGaze();
  });
  new ResizeObserver(updateGaze).observe(canvas);

  function loadScript(src, failure) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.onload = resolve;
      script.onerror = () => reject(new Error(failure));
      script.src = src;
      document.head.append(script);
    });
  }
  function showFailure(error) {
    byId("model-status").hidden = false;
    byId("model-message").textContent = error.message;
    byId("retry").hidden = false;
  }
  async function start() {
    if (!api) throw new Error("请从桌宠窗口打开页面，以连接本地服务。");
    const { url, core } = await api.model();
    await loadScript(core, "无法加载 Cubism Core，请检查本地 Core 路径。");
    await loadScript("./cubism.bundle.js", "缺少模型渲染包，请重新构建 view。");
    scene = await AronaLive2D.mount(canvas, url);
    byId("model-status").hidden = true;
    updateGaze();
  }
  canvas.addEventListener("webglcontextlost", () => {
    scene?.stop();
    scene = undefined;
    showFailure(new Error("图形上下文已中断，点击重试恢复模型。"));
  });
  byId("retry").addEventListener("click", () => location.reload());
  window.addEventListener("pagehide", () => scene?.stop(), { once: true });
  start().catch(showFailure);
})();
