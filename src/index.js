#!/usr/bin/env node
// pi-acp: presents a pi session to Buzz (or any ACP client) over the Agent Client Protocol.
//
// Buzz speaks ACP on stdio. pi speaks its own JSONL protocol (`pi --mode rpc`).
// This process sits between them: one child pi per ACP session, ACP requests
// translated into pi commands, pi events translated into ACP session updates.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";

const PI_BIN = process.env.PI_ACP_PI_BIN || "pi";
const MINUTE = 60_000;
const PROGRESS_DEADLINES = [2 * MINUTE, 5 * MINUTE, 10 * MINUTE];
const CHANNEL_UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const EVENT_ID = /^[0-9a-f]{64}$/i;
const CONTEXT_HISTORY_LINES = new Set([
  "Thread context included below. Use `buzz messages thread --channel <UUID> --event <ID>` for full history if truncated.",
  "Conversation context included below. Use `buzz messages get --channel <UUID>` for full history if truncated.",
  "Earlier thread context was already delivered in this session. Use `buzz messages thread --channel <UUID> --event <ID>` to re-read the reply chain.",
  "Earlier conversation context was already delivered in this session. Use `buzz messages get --channel <UUID>` to re-read it.",
  "Use `buzz messages thread --channel <UUID> --event <ID>` to fetch the reply chain.",
  "Use `buzz messages thread --channel <UUID> --event <ID>` to fetch thread context.",
  "Use `buzz messages get --channel <UUID>` for conversation context.",
]);

function log(...args) {
  // stdout belongs to ACP. Diagnostics go to stderr, which Buzz captures in the agent log.
  process.stderr.write(`[pi-acp] ${args.join(" ")}\n`);
}

// pi tool names mapped onto the ACP tool kinds a client renders with an icon.
const TOOL_KINDS = {
  read: "read",
  write: "edit",
  edit: "edit",
  multiedit: "edit",
  bash: "execute",
  grep: "search",
  glob: "search",
  find: "search",
  web_search: "fetch",
  fetch_content: "fetch",
  source_check: "fetch",
  subagent: "think",
  oracle: "think",
};

function toolKind(name) {
  return TOOL_KINDS[String(name || "").toLowerCase()] || "other";
}

function textOf(result) {
  if (!result) return "";
  const blocks = Array.isArray(result.content) ? result.content : [];
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function parseChannelUuid(channel) {
  if (CHANNEL_UUID.test(channel)) return channel;
  const uuid = channel.match(/^.+ \(#(.+)\)$/)?.[1];
  return uuid && CHANNEL_UUID.test(uuid) ? uuid : null;
}

function replyAnchor(line) {
  const anchors = [...line.matchAll(/--reply-to\s+([^\s`]+)/g)];
  if (anchors.length === 0) return undefined;
  if (anchors.length !== 1 || !EVENT_ID.test(anchors[0][1])) return null;
  return anchors[0][1];
}

function buzzContext(message) {
  const headers = [...message.matchAll(/^\[Context\]\r?$/gm)];
  if (headers.length !== 1) return null;

  let bodyStart = headers[0].index + headers[0][0].length;
  if (message[bodyStart] === "\n") bodyStart += 1;
  const remainder = message.slice(bodyStart);
  const separator = remainder.search(/\r?\n\r?\n/);
  const lines = (separator === -1 ? remainder : remainder.slice(0, separator)).split(/\r?\n/);
  const fields = new Map();
  const nonRouting = new Set();
  let anchor;

  for (const line of lines) {
    const field = line.match(/^(Scope|Channel|Thread root|Parent): (.+)$/);
    if (field) {
      if (fields.has(field[1])) return null;
      fields.set(field[1], field[2]);
      continue;
    }

    const nonRoutingField = line.match(/^(Description|Hint): (.+)$/);
    if (nonRoutingField) {
      if (nonRouting.has(nonRoutingField[1])) return null;
      nonRouting.add(nonRoutingField[1]);
      continue;
    }

    if (line.startsWith("IMPORTANT: ")) {
      const parsedAnchor = replyAnchor(line);
      if (parsedAnchor === null || (parsedAnchor && anchor)) return null;
      if (parsedAnchor) anchor = parsedAnchor;
      continue;
    }

    if (!CONTEXT_HISTORY_LINES.has(line)) return null;
  }

  const scope = fields.get("Scope");
  const channel = parseChannelUuid(fields.get("Channel") || "");
  const threadRoot = fields.get("Thread root");
  const parent = fields.get("Parent");
  if (!new Set(["thread", "channel", "dm"]).has(scope) || !channel) return null;
  if ((threadRoot && !EVENT_ID.test(threadRoot)) || (parent && !EVENT_ID.test(parent))) return null;

  if (scope === "channel" && (threadRoot || parent)) return null;
  if (scope === "thread" && !threadRoot) return null;
  if (parent && (!threadRoot || parent === threadRoot)) return null;
  if (scope === "dm" && nonRouting.has("Description")) return null;
  if (scope !== "channel" && nonRouting.has("Hint")) return null;

  return { channel, replyTo: anchor };
}

function hasRelayCredentials(env) {
  return [env.BUZZ_RELAY_URL, env.BUZZ_PRIVATE_KEY].every(
    (value) => typeof value === "string" && value.trim() !== "",
  );
}

function progressStatus(displayName, elapsed) {
  return `${displayName || "pi"} is still working on this request (${elapsed / MINUTE} minutes elapsed).`;
}

/** One pi child process, wrapped so ACP handlers can await turns against it. */
export class PiSession {
  constructor(sessionId, cwd, env, spawnProcess = spawn) {
    this.id = sessionId;
    this.cwd = cwd;
    this.buffer = "";
    this.listeners = new Set();
    this.openTools = new Set();

    const args = ["--mode", "rpc", "--name", `buzz-${sessionId.slice(0, 8)}`];
    // pi accepts `provider/id` with an optional `:<thinking>` suffix, so a single
    // model string can carry the reasoning level too.
    const model = process.env.BUZZ_AGENT_MODEL || process.env.PI_ACP_MODEL;
    const thinking =
      process.env.BUZZ_AGENT_THINKING_EFFORT || process.env.PI_ACP_THINKING || "";
    if (model) args.push("--model", thinking && !model.includes(":") ? `${model}:${thinking}` : model);
    const provider = process.env.BUZZ_AGENT_PROVIDER || process.env.PI_ACP_PROVIDER;
    if (provider) args.push("--provider", provider);
    this.thinking = thinking;

    log(`spawning ${PI_BIN} ${args.join(" ")} in ${cwd}`);
    this.child = spawnProcess(PI_BIN, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk) => this.#ingest(chunk));
    this.child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    this.child.stdin.on("error", () => {});
    this.child.on("error", (err) => log(`pi process error: ${err?.message || err}`));

    // A model string without a provider prefix cannot carry the thinking suffix,
    // so set the level explicitly once the session is up.
    if (this.thinking && (!model || model.includes(":"))) {
      this.send({ type: "set_thinking_level", level: this.thinking });
    }
    this.child.on("exit", (code) => {
      log(`pi exited for session ${this.id} with code ${code}`);
      for (const fn of this.listeners) fn({ type: "__exit", code });
    });
  }

  #ingest(chunk) {
    this.buffer += chunk.toString("utf8");
    // pi RPC is strict JSONL on LF. Split on \n only; tolerate a trailing \r.
    let nl;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        log(`unparseable line from pi: ${line.slice(0, 200)}`);
        continue;
      }
      for (const fn of [...this.listeners]) fn(event);
    }
  }

  send(command) {
    if (this.child.killed || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
    } catch (err) {
      log(`write to pi failed: ${err?.message || err}`);
    }
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  kill() {
    // Close stdin first so pi shuts down on its own terms rather than being cut
    // off mid-write, which is what produces EPIPE noise on the way out.
    try {
      this.child.stdin.end();
    } catch {}
    try {
      this.child.kill("SIGTERM");
    } catch {}
  }
}

export class PiAcpAgent {
  constructor(
    conn,
    { spawnProcess = spawn, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, now = Date.now, env = process.env } = {},
  ) {
    this.conn = conn;
    this.sessions = new Map();
    this.cancelled = new Set();
    this.turns = new Map();
    this.spawnProcess = spawnProcess;
    this.setTimeout = setTimeoutFn;
    this.clearTimeout = clearTimeoutFn;
    this.now = now;
    this.env = env;
  }

  async initialize(params) {
    return {
      protocolVersion: Math.min(params?.protocolVersion ?? PROTOCOL_VERSION, PROTOCOL_VERSION),
      agentInfo: { name: "pi", version: "0.1.0" },
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false, acp: false },
      },
      authMethods: [],
    };
  }

  async authenticate() {
    // pi authenticates through its own provider configuration, so there is nothing to do here.
    return {};
  }

  async newSession(params) {
    const sessionId = randomUUID();
    const cwd = params?.cwd || process.env.PI_ACP_CWD || process.cwd();
    this.sessions.set(sessionId, new PiSession(sessionId, cwd, {}, this.spawnProcess));
    return { sessionId, modes: null };
  }

  async cancel(params) {
    const session = this.sessions.get(params?.sessionId);
    if (!session) return;
    this.cancelled.add(params.sessionId);
    this.turns.get(params.sessionId)?.stopProgress();
    session.send({ type: "abort" });
  }

  async prompt(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown session ${params.sessionId}`);

    const message = this.#renderPrompt(params.prompt);
    if (!message.trim()) return { stopReason: "end_turn" };

    this.cancelled.delete(params.sessionId);
    return await this.#runTurn(session, message, buzzContext(message));
  }

  /** Flatten ACP content blocks into the single string pi's `prompt` command takes. */
  #renderPrompt(blocks) {
    const parts = [];
    const images = [];
    for (const block of blocks || []) {
      if (!block) continue;
      if (block.type === "text") parts.push(block.text);
      else if (block.type === "resource_link") parts.push(`[${block.name || block.uri}](${block.uri})`);
      else if (block.type === "resource" && block.resource?.text) {
        parts.push(`\`\`\`\n${block.resource.text}\n\`\`\``);
      } else if (block.type === "image" && block.data) {
        images.push({ type: "image", data: block.data, mimeType: block.mimeType || "image/png" });
      }
    }
    this.pendingImages = images;
    return parts.join("\n\n");
  }

  #startProgressReporter(context) {
    if (!context || !hasRelayCredentials(this.env)) return () => {};

    const timers = new Set();
    const startedAt = this.now();
    const displayName = this.env.BUZZ_ACP_DISPLAY_NAME || "pi";
    let active = true;
    let deadline = PROGRESS_DEADLINES[0];

    const schedule = () => {
      if (!active) return;
      const timer = this.setTimeout(() => {
        timers.delete(timer);
        if (!active) return;
        this.#reportProgress(context, progressStatus(displayName, deadline));
        deadline = deadline < PROGRESS_DEADLINES.at(-1) ? PROGRESS_DEADLINES[PROGRESS_DEADLINES.indexOf(deadline) + 1] : deadline + 10 * MINUTE;
        schedule();
      }, Math.max(0, deadline - (this.now() - startedAt)));
      timers.add(timer);
      timer.unref?.();
    };

    schedule();
    return () => {
      if (!active) return;
      active = false;
      for (const timer of timers) this.clearTimeout(timer);
      timers.clear();
    };
  }

  #reportProgress(context, status) {
    const args = ["messages", "send", "--channel", context.channel, "--content", status];
    if (context.replyTo) args.push("--reply-to", context.replyTo);

    try {
      const reporter = this.spawnProcess("buzz", args, {
        env: { ...this.env },
        shell: false,
        stdio: "ignore",
      });
      reporter.once("error", (err) => log(`progress reporter failed: ${err?.message || err}`));
      reporter.once("exit", (code) => {
        if (code !== 0) log(`progress reporter exited with code ${code}`);
      });
    } catch (err) {
      log(`progress reporter failed: ${err?.message || err}`);
    }
  }

  shutdown() {
    for (const turn of this.turns.values()) turn.stopProgress();
  }

  #runTurn(session, message, context) {
    return new Promise((resolve) => {
      const seenTools = new Map();
      const turn = { stopProgress: this.#startProgressReporter(context) };
      this.turns.set(session.id, turn);
      let settled = false;

      const finish = (stopReason) => {
        if (settled) return;
        settled = true;
        turn.stopProgress();
        if (this.turns.get(session.id) === turn) this.turns.delete(session.id);
        off();
        resolve({ stopReason });
      };

      const push = (update) =>
        this.conn.sessionUpdate({ sessionId: session.id, update }).catch((err) => {
          log(`sessionUpdate failed: ${err?.message || err}`);
        });

      const off = session.on((event) => {
        switch (event.type) {
          case "__exit":
            finish("cancelled");
            break;

          case "message_update": {
            const delta = event.assistantMessageEvent;
            if (!delta) break;
            if (delta.type === "text_delta" && delta.delta) {
              push({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: delta.delta },
              });
            } else if (delta.type === "thinking_delta" && delta.delta) {
              push({
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: delta.delta },
              });
            }
            break;
          }

          case "tool_execution_start": {
            seenTools.set(event.toolCallId, event.toolName);
            push({
              sessionUpdate: "tool_call",
              toolCallId: event.toolCallId,
              title: event.toolName,
              kind: toolKind(event.toolName),
              status: "in_progress",
              rawInput: event.args ?? {},
            });
            break;
          }

          case "tool_execution_end": {
            const output = textOf(event.result);
            push({
              sessionUpdate: "tool_call_update",
              toolCallId: event.toolCallId,
              status: event.isError ? "failed" : "completed",
              content: output
                ? [{ type: "content", content: { type: "text", text: output.slice(0, 20000) } }]
                : undefined,
            });
            break;
          }

          case "agent_settled":
            finish(this.cancelled.has(session.id) ? "cancelled" : "end_turn");
            break;
        }
      });

      const command = { type: "prompt", message };
      if (this.pendingImages?.length) command.images = this.pendingImages;
      this.pendingImages = [];
      session.send(command);
    });
  }
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  const agent = new PiAcpAgent(null);
  new AgentSideConnection((conn) => {
    agent.conn = conn;
    return agent;
  }, stream);

  // Buzz stops a harness by closing stdio or signalling. Either way, take the pi
  // children down with us so no orphan keeps running against a dead pipe.
  let shuttingDown = false;
  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    agent.shutdown();
    const children = [...agent.sessions.values()];
    for (const session of children) session.kill();
    // pi flushes an exit banner to stdout on the way down. Stay alive until every
    // child is gone (or a grace period lapses) so those writes land in a live pipe
    // instead of raising EPIPE inside pi.
    const alive = children.filter((s) => s.child.exitCode === null);
    if (alive.length === 0) return process.exit(0);
    let remaining = alive.length;
    const done = () => {
      if (--remaining === 0) process.exit(0);
    };
    for (const session of alive) session.child.once("exit", done);
    setTimeout(() => process.exit(0), 2000).unref();
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, shutdown);
  process.stdin.on("close", shutdown);
  process.stdin.on("end", shutdown);
  process.stdout.on("error", () => {});

  log("ready");
}
