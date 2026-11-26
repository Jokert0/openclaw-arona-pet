import { once } from "node:events";
import { WebSocketServer } from "ws";
export async function fakeGateway() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let socket,
    seq = 0;
  const fixture = {
    port: server.address().port,
    rows: [],
    requests: [],
    emit(event, payload) {
      socket.send(JSON.stringify({ type: "event", event, payload, seq: ++seq }));
    },
    close() {
      for (const peer of server.clients) peer.terminate();
      return new Promise((resolve) => server.close(resolve));
    },
  };
  server.on("connection", (peer) => {
    socket = peer;
    seq = 0;
    fixture.emit("connect.challenge", { nonce: "fixture", ts: Date.now() });
    peer.on("message", (wire) => {
      const { id, method, params } = JSON.parse(wire);
      fixture.requests.push({ method, params });
      let payload = {};
      const list = { sessions: fixture.rows, hasMore: false };
      if (method === "connect")
        payload = {
          type: "hello-ok",
          protocol: 4,
          server: { version: "fixture", connId: "test" },
          features: { methods: [], events: [] },
          snapshot: {
            presence: [],
            health: {},
            stateVersion: { presence: 1, health: 1 },
            uptimeMs: 1,
          },
          auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
          policy: { maxPayload: 1024000, maxBufferedBytes: 1024000, tickIntervalMs: 30000 },
        };
      if (method === "sessions.create")
        payload = { key: params.key, sessionId: "private-pet-session" };
      if (method === "chat.history") payload = fixture.history?.[params.sessionKey] ?? {};
      if (method === "sessions.list") payload = list;
      if (method === "sessions.subscribe") payload = { subscribed: true, list };
      if (method === "chat.send") payload = { runId: params.idempotencyKey, status: "started" };
      peer.send(JSON.stringify({ type: "res", id, ok: true, payload }));
    });
  });
  return fixture;
}
export function row(name, startedAt, reasoningLevel = "stream") {
  return {
    key: `agent:main:${name}`,
    agentId: "main",
    sessionId: `id-${name}`,
    hasActiveRun: true,
    activeRunIds: [`run-${name}`],
    startedAt,
    reasoningLevel,
  };
}
export async function until(condition) {
  for (let i = 0; i < 250; i++) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("Timed out waiting for expected state");
}
