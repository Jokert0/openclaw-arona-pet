import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "playwright-core";
import { electronBinary, project } from "../launch.mjs";
import { fakeGateway, row, until } from "./gateway.mjs";
const gateway = await fakeGateway();
const userData = await mkdtemp(join(tmpdir(), "arona-ui-"));
const artifacts = join(project, ".runtime", "proof");
await mkdir(artifacts, { recursive: true });
// Bootstrap the real desktop entry with an isolated app directory for gateway.json.
const appDir = join(userData, "app");
await mkdir(appDir);
await writeFile(join(appDir, "package.json"), JSON.stringify({ name: "arona-window-test", main: "main.cjs" }));
await writeFile(join(appDir, "main.cjs"), `require(${JSON.stringify(join(project, "desktop", "main.cjs"))});`);
await writeFile(join(appDir, "gateway.json"), JSON.stringify({ port: gateway.port, token: "window-test" }));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({
    executablePath: electronBinary(),
    args: [`--user-data-dir=${userData}`, appDir],
    env,
    timeout: 25000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (e) => console.warn("Page error", e.message));
  await page.waitForFunction(
    () =>
      document.querySelector("#model-status")?.hidden || !document.querySelector("#retry")?.hidden,
    {},
    { timeout: 18000 },
  );
  if (!(await page.locator("#model-status").isHidden()))
    throw new Error(await page.locator("#model-message").innerText());
  // Playwright cannot click native Windows menus. Capture the menu built by the
  // actual context menu action and activate its native MenuItems in the main process.
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () { globalThis.petTestMenu = this; };
  });
  async function menuAction(action) {
    await page.locator("#pet").click({ button: "right" });
    return app.evaluate(({ BrowserWindow }, action) => {
      const menu = globalThis.petTestMenu;
      if (action === "connection") return menu.items[0].label;
      const item = menu.items.find((item) => item.label === action);
      if (!item?.enabled) throw new Error(`不可用的菜单项 ${action}`);
      item.click({}, BrowserWindow.getAllWindows()[0]);
    }, action);
  }
  await until(() => gateway.requests.some((r) => r.method === "sessions.subscribe"));
  assert.equal(gateway.requests.find((r) => r.method === "connect").params.auth.token, "window-test");
  assert.equal(await menuAction("connection"), "Gateway：在线");
  assert.equal(await page.locator("header").count(), 0);
  await page.screenshot({ path: join(artifacts, "idle.png"), omitBackground: true });
  const petBox = await page.locator("#pet").boundingBox();
  await page.mouse.click(petBox.x + 2, petBox.y + 2);
  assert.equal(await page.locator("#bubble").isHidden(), true);
  await page.mouse.click(petBox.x + petBox.width * 0.55, petBox.y + petBox.height * 0.15);
  await page.waitForTimeout(370);
  await page.screenshot({ path: join(artifacts, "halo-heart.png"), omitBackground: true });
  assert.equal(await page.locator("#bubble").isHidden(), true);
  await page.waitForTimeout(2000);
  await page.mouse.move(petBox.x + petBox.width / 2, petBox.y + petBox.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(320);
  await page.screenshot({ path: join(artifacts, "body-pinch.png"), omitBackground: true });
  await page.mouse.up();
  await page.getByText("老师，我在这里。", { exact: true }).waitFor({ timeout: 1200 });
  await page.screenshot({ path: join(artifacts, "tap-cloud.png"), omitBackground: true });
  assert.deepEqual(await page.locator("#pet").boundingBox(), petBox, "显示气泡时画布位置和大小应保持稳定");
  await page.locator("#bubble").waitFor({ state: "hidden" });
  const window = await app.browserWindow(page);
  const [x, y] = await window.evaluate((win) => win.getPosition());
  const stage = await page.locator("#pet").boundingBox();
  const midX = stage.x + stage.width / 2;
  const midY = stage.y + stage.height / 2;
  await page.mouse.move(midX, midY);
  await page.mouse.down();
  await page.mouse.move(midX - 48, midY - 24);
  await page.waitForFunction(([x, y]) => screenX === x && screenY === y, [x - 48, y - 24]);
  await page.mouse.move(midX, midY);
  await page.mouse.up();
  assert.deepEqual(await window.evaluate((win) => win.getPosition()), [x - 48, y - 24]);
  assert.equal(await page.locator("#bubble").isHidden(), true);
  assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [420, 560]);
  await page.mouse.click(midX, midY);
  await page.getByText("老师，我在这里。", { exact: true }).waitFor();
  assert.deepEqual(await window.evaluate((win) => win.getPosition()), [x - 48, y - 24]);
  async function openSlider() {
    const panelPromise = app.waitForEvent("window");
    await menuAction("调整桌宠大小…");
    const panel = await panelPromise;
    await panel.waitForFunction(() => document.querySelector("#scale")?.disabled === false);
    return panel;
  }
  let panel = await openSlider();
  const sliderSize = await panel.locator("#scale").boundingBox();
  async function checkSize(percent) {
    await page.waitForFunction(([w, h]) => Math.abs(innerWidth - w) <= 1 && Math.abs(innerHeight - h) <= 1,
      [Math.round(420 * percent / 100), Math.round(560 * percent / 100)]);
    assert.equal(await panel.locator("output").innerText(), `${percent}%`);
    assert.deepEqual(await panel.locator("#scale").boundingBox(), sliderSize);
  }
  const sliderY = sliderSize.y + sliderSize.height / 2;
  await panel.mouse.move(sliderSize.x + sliderSize.width / 2, sliderY);
  await panel.mouse.down();
  await panel.mouse.move(sliderSize.x + sliderSize.width * 0.8, sliderY, { steps: 6 });
  await panel.mouse.up();
  const dragged = Number(await panel.locator("#scale").inputValue());
  assert.ok(dragged > 100 && dragged < 150);
  await checkSize(dragged);
  await panel.locator("#scale").press("Home");
  await checkSize(10);
  await panel.close();
  panel = await openSlider();
  await checkSize(10);
  await panel.locator("#scale").press("End");
  await checkSize(150);
  await panel.locator("#scale").press("ArrowLeft");
  await checkSize(149);
  await panel.screenshot({ path: join(artifacts, "scale-slider.png") });
  await panel.locator("#scale").fill("100");
  await checkSize(100);
  await panel.close();
  const a = row("pet-demo", 10);
  gateway.rows = [a, row("second", 20)];
  gateway.emit("sessions.changed", {});
  await until(() =>
    gateway.requests.some(
      (r) => r.method === "sessions.messages.subscribe" && r.params.key === a.key,
    ),
  );
  gateway.emit("session.tool", {
    runId: a.activeRunIds[0], sessionKey: a.key, stream: "tool",
    data: { phase: "start", name: "read" },
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(artifacts, "tool-progress.png"), omitBackground: true });
  assert.equal(await page.locator("#bubble-text").innerText(), "正在读取文件…");
  gateway.emit("agent", {
    runId: a.activeRunIds[0],
    sessionKey: a.key,
    stream: "thinking",
    data: { text: "正在整理这次会话的要点…" },
  });
  const thought = page.locator("#bubble").getByText("正在整理这次会话的要点…", { exact: true });
  await thought.waitFor({ timeout: 5000 });
  await page.screenshot({ path: join(artifacts, "thinking.png"), omitBackground: true });
  await page.locator("#message").fill("阿洛娜，今天一起做什么？");
  await page.locator("#send").click();
  await until(() => gateway.requests.some((r) => r.method === "chat.send"));
  const { sessionKey, idempotencyKey: runId } = gateway.requests.find((r) => r.method === "chat.send").params;
  await menuAction("精简模式");
  assert.equal(await page.locator("footer").isVisible(), false);
  await thought.waitFor();
  const first = "老师，今天的天空很蓝呢。要一起出去走走吗？\n带上画本吧，我们可以把今天看到的云朵都画下来。\n等回来的时候，再一起给它们取名字，好不好？";
  const reply = [first, ...Array.from({ length: 7 }, (_, i) => `第 ${i + 1} 页\n${first}`)].join("\n\n");
  await page.clock.install();
  gateway.emit("chat", { sessionKey, runId, state: "delta", replace: true, deltaText: reply });
  const more = page.getByRole("button", { name: "查看全文" });
  await more.waitFor();
  await page.clock.fastForward(20000);
  await more.waitFor();
  assert.deepEqual(await page.locator("#pet").boundingBox(), petBox);
  const readerPromise = app.waitForEvent("window");
  await more.click();
  const reader = await readerPromise;
  const body = reader.locator("main");
  await body.getByText(reply, { exact: true }).waitFor();
  const readerWindow = await app.browserWindow(reader);
  const rb = await readerWindow.evaluate((w) => w.getBounds());
  const wb = await window.evaluate((w) => w.getBounds());
  assert.ok(rb.x + rb.width <= wb.x || rb.x >= wb.x + wb.width);
  await reader.screenshot({ path: join(artifacts, "direct-chat-reader.png") });
  const top = await body.evaluate((e) => { e.scrollTop = 100; return e.scrollTop; });
  assert.ok(top > 0);
  const extra = "\n老师，明天见。";
  gateway.emit("chat", { sessionKey, runId, state: "delta", deltaText: extra });
  await body.getByText(reply + extra, { exact: true }).waitFor();
  assert.equal(await body.evaluate((e) => e.scrollTop), top);
  gateway.emit("chat", { sessionKey, runId, state: "final" });
  await page.mouse.move(3, 400);
  await page.clock.fastForward(20000);
  assert.ok(await more.isVisible());
  await Promise.all([reader.waitForEvent("close"), reader.keyboard.down("Escape")]);
  await more.hover();
  await page.clock.fastForward(20000);
  assert.ok(await more.isVisible());
  await menuAction("精简模式");
  await page.locator("#message").waitFor();
  await page.screenshot({ path: join(artifacts, "direct-chat-preview.png"), omitBackground: true });
  await page.clock.fastForward(14000);
  assert.ok(await more.isVisible());
  await page.clock.fastForward(1200);
  assert.ok(await more.isHidden());
  const replayPromise = app.waitForEvent("window");
  await menuAction("查看上次回复");
  const replay = await replayPromise;
  await replay.locator("main").getByText(reply + extra, { exact: true }).waitFor();
  await replay.getByRole("button", { name: "关闭" }).click();
  await page.locator("#message").fill("明天见");
  await page.locator("#send").click();
  await until(() => gateway.requests.filter((r) => r.method === "chat.send").length === 2);
  const secondId = gateway.requests.filter((r) => r.method === "chat.send")[1].params.idempotencyKey;
  gateway.emit("chat", { sessionKey, runId: secondId, state: "delta", replace: true, deltaText: "老师，明天见。" });
  gateway.emit("chat", { sessionKey, runId: secondId, state: "final" });
  await page.getByText("老师，明天见。", { exact: true }).waitFor();
  assert.ok(await more.isHidden());
  await page.clock.fastForward(7000);
  await page.locator("#bubble-text").hover();
  await page.clock.fastForward(10000);
  assert.equal(await page.locator("#bubble-text").innerText(), "老师，明天见。");
  await page.mouse.move(3, 400);
  await page.clock.fastForward(1200);
  assert.notEqual(await page.locator("#bubble-text").innerText(), "老师，明天见。");
  await gateway.close();
  await until(async () => (await menuAction("connection")) === "Gateway：离线");
  assert.ok(await page.locator("#bubble").isHidden());
  console.log("Real model and session bubble verified:", artifacts);
} finally {
  if (app) await app.close();
  await gateway.close();
}
