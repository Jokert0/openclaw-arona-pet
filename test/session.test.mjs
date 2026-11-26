import assert from "node:assert/strict";
import test from "node:test";
import { createPetSession } from "../session.mjs";
import { fakeGateway, row, until } from "./gateway.mjs";

test("the pet follows the first run, summarizes tools and filters foreign frames, respects visibility and keeps its own replies separate", async (t) => {
  const gateway = await fakeGateway();
  const a = row("alpha", 10),
    b = row("beta", 20, "off");
  const queued = { ...row("queued", 1), status: "queued" };
  const aWithoutIds = { ...a, activeRunIds: undefined };
  gateway.history = {
    [a.key]: { sessionId: a.sessionId, inFlightRun: { runId: a.activeRunIds[0] } },
    "agent:main:arona-desktop-pet": { sessionId: "existing-pet-id" },
  };
  gateway.rows = [queued, b, aWithoutIds];
  const seen = [];
  const session = createPetSession({
    onState: (s) => seen.push(s),
    gatewayOptions: { url: `ws://127.0.0.1:${gateway.port}`, deviceIdentity: null },
  });
  t.after(async () => {
    session.stop();
    await gateway.close();
  });
  await session.start();
  const subscribed = (key) =>
    gateway.requests.some(
      (r) => r.method === "sessions.messages.subscribe" && r.params.key === key,
    );
  await until(() => subscribed(a.key));
  const thinking = (r, text) =>
    gateway.emit("agent", {
      runId: r.activeRunIds[0],
      sessionKey: r.key,
      stream: "thinking",
      data: { text },
    });
  thinking(b, "FOREIGN");
  gateway.emit("agent", {
    runId: "run-alpha",
    sessionKey: a.key,
    stream: "tool",
    data: { text: "RAW LOG" },
  });
  thinking(a, "**核对会话状态**\n```\nRAW LOG\n```");
  await until(() => seen.at(-1).activity === "核对会话状态");
  gateway.rows = [b];
  gateway.emit("sessions.changed", {});
  await until(() => subscribed(b.key));
  thinking(a, "STALE");
  thinking(b, "HIDDEN");
  const tool = (kind, r, phase) => gateway.emit(kind, {
    sessionKey: r.key, runId: r.activeRunIds[0], stream: "tool",
    data: { phase, name: "read", args: { path: "RAW LOG" }, result: "RAW LOG" },
  });
  tool("session.tool", b, "start");
  await until(() => seen.at(-1).activity === "正在读取文件…");
  gateway.emit("sessions.changed", {});
  tool("agent", b, "result");
  await until(() => seen.at(-1).activity === "文件读取结束，等待下一步…");
  tool("session.tool", a, "start");
  assert.equal(await session.send("你好阿洛娜"), true);
  const request = gateway.requests.find((r) => r.method === "chat.send").params;
  assert.equal(request.sessionId, "existing-pet-id");
  assert.equal(
    gateway.requests.some((r) => r.method === "sessions.create"),
    false,
  );
  const own = { sessionKey: request.sessionKey, runId: request.idempotencyKey };
  gateway.emit("chat", {
    ...own,
    state: "delta",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "HIDDEN" },
        { type: "text", text: "你好" },
      ],
    },
    deltaText: "你好",
  });
  gateway.emit("chat", { ...own, state: "delta", deltaText: "！" });
  gateway.emit("chat", { ...own, state: "final" });
  await until(() => seen.at(-1).reply === "你好！" && !seen.at(-1).busy);
  assert.equal(seen.at(-1).activity, "文件读取结束，等待下一步…");
  gateway.rows = [];
  gateway.emit("sessions.changed", {});
  await until(() => seen.at(-1).activity === "");
  assert.doesNotMatch(JSON.stringify(seen), /RAW LOG|FOREIGN|STALE|HIDDEN/);
});
