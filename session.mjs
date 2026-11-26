import { randomUUID } from "node:crypto";
import { GatewayClient, mergeChatStreamMessage } from "@openclaw/gateway-client";
import { readGatewayConfig } from "./gateway-config.mjs";
import { deviceAuth } from "./device.mjs";

const rosterQuery = {
  activeOnly: true,
  includeGlobal: true,
  includeUnknown: true,
  limit: 100,
  rowMode: "compact",
};
const working = "正在处理…";
const sameSession = (a, b) =>
  a && b && a.key === b.key && a.agentId === b.agentId && a.sessionId === b.sessionId;
const sameRun = (row, event) =>
  row &&
  row.key === event.sessionKey &&
  row.activeRunIds?.includes(event.runId) &&
  (!event.agentId || !row.agentId || row.agentId === event.agentId);
const canPreview = (row) => ["on", "stream"].includes(row?.reasoningLevel);

// Only these local labels reach the bubble. Tool arguments and output can contain secrets.
const toolLabels = new Map([
  ["read", ["正在读取文件…", "文件读取结束"]],
  ["web_fetch", ["正在读取网页…", "网页读取结束"]],
  ["web_search", ["正在搜索网页…", "网页搜索结束"]],
  ["exec", ["正在执行命令…", "命令执行结束"]],
  ["write", ["正在写入文件…", "文件写入结束"]],
  ["edit", ["正在修改文件…", "文件修改结束"]],
]);
function toolActivity(data) {
  if (!data || data.hideFromChannelProgress || data.suppressChannelProgress) return;
  const [active, finished] = toolLabels.get(data.name) ?? ["正在调用工具…", "工具调用结束"];
  if (data.phase === "start" || data.phase === "update") return active;
  if (data.phase === "result")
    return data.isError ? "工具执行出错，等待下一步…" : `${finished}，等待下一步…`;
}

function preview(text) {
  if (typeof text !== "string") return "";
  // Prefer the short, user-visible heading when the provider supplies one. Never evaluate markup.
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, "").trim();
  const heading = [...prose.matchAll(/(?:^|\n)\s*(?:\*\*([^*\n]+)\*\*|#{1,4}\s+([^\n]+))/g)].at(-1);
  const line = (
    heading?.[1] ??
    heading?.[2] ??
    prose
      .split("\n")
      .filter((s) => s.trim())
      .at(-1) ??
    ""
  ).trim();
  if (!line || /^(?:[$>{\[<]|at\s+\S+\s*\(|(?:INFO|DEBUG|WARN|ERROR|TRACE)\b)/i.test(line))
    return "";
  return line.length > 76 ? `${line.slice(0, 75)}…` : line;
}

function visibleReply(msg) {
  if (!msg || msg.role !== "assistant" || msg.isReasoning) return "";
  if (typeof msg.content === "string") return msg.content;
  return Array.isArray(msg.content)
    ? msg.content
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
    : "";
}

export function createPetSession({
  onState,
  gatewayOptions,
  chatKey = "agent:main:arona-desktop-pet",
}) {
  let client, connection, timer, selected, watchedRun, pending, chatSessionId;
  let state = {
    connected: false,
    activity: "",
    reply: "",
    notice: "正在连接 OpenClaw…",
    busy: false,
  };
  const publish = (patch) => {
    state = { ...state, ...patch };
    onState({ ...state });
  };
  const valid = (context) => context && connection === context;
  const subscription = (row) => ({
    key: row.key,
    ...(row.agentId ? { agentId: row.agentId } : {}),
    subscriptionId: "arona-activity",
  });

  async function refresh(context, initial = false) {
    if (!valid(context)) return;
    if (context.loading) {
      context.dirty = true;
      return;
    }
    context.loading = true;
    try {
      let page = initial
        ? (await client.request("sessions.subscribe", rosterQuery)).list
        : await client.request("sessions.list", rosterQuery);
      const rows = [...page.sessions];
      while (
        valid(context) &&
        page.hasMore &&
        Number.isInteger(page.nextOffset) &&
        page.nextOffset > (page.offset ?? 0)
      ) {
        page = await client.request("sessions.list", { ...rosterQuery, offset: page.nextOffset });
        rows.push(...page.sessions);
      }
      if (!valid(context)) return;
      const running = rows.filter((row) => row.hasActiveRun === true && row.status !== "queued");
      // When a runtime omits start times, retain the Gateway's stable first match.
      const first = running.every((r) => Number.isFinite(r.startedAt))
        ? running.sort((a, b) => a.startedAt - b.startedAt)[0]
        : running[0];
      const next = running.find((row) => sameSession(row, selected)) ?? first;
      if (next && next.activeRunIds === undefined) {
        const history = await client.request("chat.history", {
          sessionKey: next.key,
          ...(next.agentId ? { agentId: next.agentId } : {}),
          limit: 1,
          maxChars: 1,
          maxBytes: 1024,
        });
        if (!valid(context)) return;
        if (history.sessionId === next.sessionId && history.inFlightRun?.runId)
          next.activeRunIds = [history.inFlightRun.runId];
      }
      if (sameSession(next, selected)) {
        selected = next;
        if ((watchedRun?.thinking && !canPreview(next)) || !next.activeRunIds?.includes(watchedRun?.id)) {
          watchedRun = undefined;
          if (state.activity !== working) publish({ activity: working });
        }
      } else if (selected || next) {
        const old = selected;
        selected = next;
        watchedRun = undefined;
        publish({ activity: next ? working : "" });
        if (old) await client.request("sessions.messages.unsubscribe", subscription(old));
        if (valid(context) && next)
          await client.request("sessions.messages.subscribe", subscription(next));
      }
    } catch {
      if (valid(context)) {
        selected = undefined;
        watchedRun = undefined;
        publish({ activity: "", notice: "会话状态暂不可用，请检查设备配对和读取权限。" });
      }
    } finally {
      context.loading = false;
      if (valid(context) && context.dirty) {
        context.dirty = false;
        schedule();
      }
    }
  }
  function schedule() {
    if (!connection || timer) return;
    const context = connection;
    timer = setTimeout(() => {
      timer = undefined;
      void refresh(context);
    }, 100);
  }
  function disconnected(notice) {
    clearTimeout(timer);
    timer = connection = selected = watchedRun = pending = undefined;
    chatSessionId = undefined;
    publish({ connected: false, busy: false, activity: "", notice });
  }
  function event({ event: kind, payload: p }) {
    if (!connection) return;
    if (kind === "sessions.changed") {
      schedule();
      return;
    }
    if (!p) return;
    if ((kind === "agent" || kind === "session.tool") && sameRun(selected, p)) {
      const thinking = p.stream === "thinking" && canPreview(selected);
      const line = thinking ? preview(p.data?.text) : p.stream === "tool" ? toolActivity(p.data) : undefined;
      if (line) {
        watchedRun = { id: p.runId, thinking };
        if (line !== state.activity) publish({ activity: line });
      }
    }
    if (kind !== "chat") return;
    const terminal = ["final", "aborted", "error"].includes(p.state);
    if (terminal && sameRun(selected, p)) {
      watchedRun = undefined;
      publish({ activity: "" });
      schedule();
    }
    if (!pending || p.sessionKey !== chatKey || p.runId !== pending.id) return;
    if (p.state === "delta" || terminal) {
      pending.msg = mergeChatStreamMessage(pending.msg, p);
      const reply = visibleReply(pending.msg);
      publish({
        reply,
        busy: !terminal,
        notice:
          p.state === "error"
            ? "本次回复失败，请稍后重试。"
            : p.state === "aborted"
              ? "本次回复已停止。"
              : terminal && !reply
                ? "本次会话已完成。"
                : "",
      });
      if (terminal) pending = undefined;
    }
  }
  return {
    async start() {
      try {
        let opts = gatewayOptions;
        if (!opts) {
          const { app, safeStorage } = await import("electron");
          try {
            opts = await readGatewayConfig(app.getAppPath());
          } catch {
            disconnected("请检查启动目录的 gateway.json、端口与凭据格式，保存后重开桌宠。");
            return;
          }
          opts = { ...opts, ...(await deviceAuth(app.getPath("userData"), safeStorage, new URL(opts.url).origin)) };
        }
        client = new GatewayClient({
          ...opts,
          caps: ["tool-events"],
          clientName: "gateway-client",
          clientDisplayName: "Arona Desktop Pet",
          mode: "ui",
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          onHelloOk() {
            connection = {};
            publish({ connected: true, notice: "" });
            void refresh(connection, true);
          },
          onEvent: event,
          onGap: schedule,
          onClose() {
            disconnected("连接已断开。请检查 Gateway 和设备配对。");
          },
          onConnectError() {
            disconnected("连接失败。请检查本机 Gateway、凭据和设备配对。");
          },
          onReconnectPaused() {
            disconnected("请在 OpenClaw 完成设备配对，然后重新打开桌宠。");
          },
        });
        client.start();
      } catch {
        disconnected("无法初始化连接，请检查本机端口和 Windows 凭据存储。");
      }
    },
    stop() {
      disconnected("已离线");
      return client?.stopAndWait();
    },
    async send(input) {
      const message = typeof input === "string" ? input.trim() : "";
      if (!connection || pending || !message || message.length > 4000) return false;
      const context = connection;
      const turn = { id: randomUUID() };
      pending = turn;
      publish({ busy: true, reply: "", notice: "" });
      try {
        if (!chatSessionId) {
          const history = await client.request("chat.history", {
            sessionKey: chatKey,
            limit: 1,
            maxChars: 1,
            maxBytes: 1024,
          });
          if (!valid(context)) return false;
          const target = history.sessionId
            ? history
            : await client.request("sessions.create", { key: chatKey });
          if (!valid(context)) return false;
          await client.request("sessions.messages.subscribe", {
            key: chatKey,
            subscriptionId: "arona-chat",
          });
          if (!valid(context)) return false;
          if (!target.sessionId) throw new Error("缺少会话标识");
          chatSessionId = target.sessionId;
        }
        await client.request("chat.send", {
          sessionKey: chatKey,
          sessionId: chatSessionId,
          message,
          idempotencyKey: turn.id,
        });
        return true;
      } catch {
        if (valid(context) && pending === turn) {
          chatSessionId = undefined;
          pending = undefined;
          publish({ busy: false, notice: "未能确认发送。请在 OpenClaw 查看桌宠会话后再试。" });
        }
        return false;
      }
    },
  };
}
