import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "playwright-core";
import { electronBinary, project } from "../launch.mjs";
import { fakeGateway } from "./gateway.mjs";
const gateway = await fakeGateway();
const userData = await mkdtemp(join(tmpdir(), "arona-settings-"));
// Bootstrap the real desktop entry with an isolated app directory for gateway.json.
const appDir = join(userData, "app");
await mkdir(appDir);
await writeFile(join(appDir, "package.json"), JSON.stringify({ name: "arona-window-test", main: "main.cjs" }));
await writeFile(join(appDir, "main.cjs"), `require(${JSON.stringify(join(project, "desktop", "main.cjs"))});`);
await writeFile(join(appDir, "gateway.json"), JSON.stringify({ port: gateway.port, token: "window-test" }));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
function launch() {
  return _electron.launch({
    executablePath: electronBinary(),
    args: [`--user-data-dir=${userData}`, appDir],
    env,
    timeout: 25000,
  });
}
let app;
try {
  app = await launch();
  const page = await app.firstWindow();
  // Playwright cannot click native Windows menus. Capture the menu built by the
  // actual context menu action and activate its native MenuItems in the main process.
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () { globalThis.petTestMenu = this; };
  });
  async function menuAction(action) {
    await page.locator("#pet").click({ button: "right" });
    return app.evaluate(({ BrowserWindow }, action) => {
      const menu = globalThis.petTestMenu;
      const item = menu.items.find((item) => item.label === action);
      if (!item?.enabled) throw new Error(`不可用的菜单项 ${action}`);
      item.click({}, BrowserWindow.getAllWindows()[0]);
    }, action);
  }
  const panelPromise = app.waitForEvent("window");
  await menuAction("调整桌宠大小…");
  const panel = await panelPromise;
  await panel.waitForFunction(() => document.querySelector("#scale")?.disabled === false);
  await panel.locator("#scale").fill("80");
  await page.waitForFunction(() => innerWidth === 336 && innerHeight === 448);
  await panel.close();
  await menuAction("精简模式");
  const position = await app.evaluate(({ screen }) => {
    const { x, y } = screen.getPrimaryDisplay().workArea;
    return [x + 30, y + 40];
  });
  await page.evaluate(([x, y]) => globalThis.pet.move(x, y), position);
  await app.close();
  app = undefined;
  const settings = JSON.parse(await readFile(join(appDir, "pet-settings.json"), "utf8"));
  assert.deepEqual(settings, { scalePercent: 80, position, compactMode: true });
  app = await launch();
  const restored = await app.firstWindow();
  await restored.waitForFunction(() => document.body.classList.contains("compact"));
  assert.deepEqual(await restored.evaluate(() => [innerWidth, innerHeight]), [336, 448]);
  const restoredWindow = await app.browserWindow(restored);
  assert.deepEqual(await restoredWindow.evaluate((w) => w.getPosition()), position);
  console.log("Verified restart with 80% scale, saved position and compact mode.");
} finally {
  if (app) await app.close();
  await gateway.close();
}
