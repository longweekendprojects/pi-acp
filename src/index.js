#!/usr/bin/env node
// pi-acp: presents a pi session to Buzz (or any ACP client) over the Agent Client Protocol.
//
// Buzz speaks ACP on stdio. pi speaks its own JSONL protocol (`pi --mode rpc`).
// This process sits between them: one child pi per ACP session, ACP requests
// translated into pi commands, pi events translated into ACP session updates.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const PI_BIN = process.env.PI_ACP_PI_BIN || "pi";

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

/** One pi child process, wrapped so ACP handlers can await turns against it. */
class PiSession {
  constructor(sessionId, cwd, env) {
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
    this.child = spawn(PI_BIN, args, {
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

class PiAcpAgent {
  constructor(conn) {
    this.conn = conn;
    this.sessions = new Map();
    this.cancelled = new Set();
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
    this.sessions.set(sessionId, new PiSession(sessionId, cwd, {}));
    return { sessionId, modes: null };
  }

  async cancel(params) {
    const session = this.sessions.get(params?.sessionId);
    if (!session) return;
    this.cancelled.add(params.sessionId);
    session.send({ type: "abort" });
  }

  async prompt(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`unknown session ${params.sessionId}`);

    const message = this.#renderPrompt(params.prompt);
    if (!message.trim()) return { stopReason: "end_turn" };

    this.cancelled.delete(params.sessionId);
    return await this.#runTurn(session, message);
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

  #runTurn(session, message) {
    return new Promise((resolve) => {
      const seenTools = new Map();
      let settled = false;

      const finish = (stopReason) => {
        if (settled) return;
        settled = true;
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
