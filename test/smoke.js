#!/usr/bin/env node
// Drives pi-acp the way Buzz does: initialize, open a session, send one prompt,
// and print every session update until the turn stops.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapter = path.join(here, "..", "src", "index.js");
const cwd = process.argv[2] || process.cwd();
const promptText = process.argv[3] || "Reply with exactly: pong";

const child = spawn(process.execPath, [adapter], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
const pending = new Map();
let nextId = 1;
let sawText = "";

child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method === "session/update") {
      const u = msg.params.update;
      if (u.sessionUpdate === "agent_message_chunk") {
        sawText += u.content.text;
        process.stdout.write(u.content.text);
      } else if (u.sessionUpdate === "tool_call") {
        console.log(`\n  [tool ${u.title} (${u.kind})]`);
      } else if (u.sessionUpdate === "tool_call_update") {
        console.log(`  [tool ${u.toolCallId} -> ${u.status}]`);
      }
    }
  }
});

function call(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const init = await call("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});
console.log("initialize ->", JSON.stringify(init.agentInfo), "protocol", init.protocolVersion);

const session = await call("session/new", { cwd, mcpServers: [] });
console.log("session/new ->", session.sessionId);
console.log("--- prompt ---");

const res = await call("session/prompt", {
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: promptText }],
});
console.log(`\n--- stopReason: ${res.stopReason} ---`);
child.kill();
process.exit(sawText.trim() ? 0 : 1);
