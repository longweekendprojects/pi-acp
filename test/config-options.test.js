import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PiAcpAgent } from "../src/index.js";

/**
 * A pi stand-in that answers the RPC commands session configuration depends on
 * and records everything written to it, so a test can assert what pi was told.
 */
function fakePi() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.writable = true;
  child.killed = false;
  child.exitCode = null;
  child.kill = () => (child.killed = true);
  child.commands = [];

  let model = { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 sol" };
  let level = "medium";

  child.stdin.write = (line) => {
    const command = JSON.parse(String(line));
    child.commands.push(command);
    const reply = (data) =>
      queueMicrotask(() =>
        child.stdout.emit(
          "data",
          Buffer.from(`${JSON.stringify({ type: "response", command: command.type, success: true, data })}\n`),
        ),
      );

    switch (command.type) {
      case "get_available_models":
        return reply({
          models: [
            { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 sol" },
            { provider: "anthropic-c", id: "claude-opus-5", name: "Claude Opus 5" },
          ],
        }), true;
      case "get_state":
        return reply({ model, thinkingLevel: level }), true;
      case "get_available_thinking_levels":
        return reply({ levels: ["off", "medium", "high", "xhigh"] }), true;
      case "set_model":
        model = { provider: command.provider, id: command.modelId };
        return reply(model), true;
      case "set_thinking_level":
        level = command.level;
        return reply({ level }), true;
      default:
        return true;
    }
  };
  child.stdin.end = () => (child.stdin.writable = false);
  return child;
}

function agentWithPi() {
  const children = [];
  const agent = new PiAcpAgent(
    { sessionUpdate: async () => {} },
    {
      spawnProcess: () => {
        const child = fakePi();
        children.push(child);
        return child;
      },
      env: {},
    },
  );
  return { agent, children };
}

test("advertises pi's configured models and thinking levels as ACP config options", async () => {
  const { agent } = agentWithPi();
  const { configOptions } = await agent.newSession({ cwd: "/tmp" });

  const model = configOptions.find((option) => option.id === "model");
  assert.equal(model.category, "model");
  assert.equal(model.type, "select");
  assert.equal(model.currentValue, "openai-codex/gpt-5.6-sol");
  assert.deepEqual(
    model.options.map((option) => option.value),
    ["openai-codex/gpt-5.6-sol", "anthropic-c/claude-opus-5"],
  );

  const thinking = configOptions.find((option) => option.id === "thought_level");
  assert.equal(thinking.category, "thought_level");
  assert.equal(thinking.currentValue, "medium");
  assert.deepEqual(thinking.options.map((option) => option.value), ["off", "medium", "high", "xhigh"]);
});

test("selecting a model switches the running pi rather than restarting it", async () => {
  const { agent, children } = agentWithPi();
  const { sessionId } = await agent.newSession({ cwd: "/tmp" });

  const { configOptions } = await agent.setSessionConfigOption({
    sessionId,
    configId: "model",
    value: "anthropic-c/claude-opus-5",
  });

  assert.equal(children.length, 1, "the pi child is reused, so the conversation keeps its context");
  assert.deepEqual(
    children[0].commands.find((command) => command.type === "set_model"),
    { type: "set_model", provider: "anthropic-c", modelId: "claude-opus-5" },
  );
  assert.equal(
    configOptions.find((option) => option.id === "model").currentValue,
    "anthropic-c/claude-opus-5",
  );
});

test("selecting a thinking level applies it to the running pi", async () => {
  const { agent, children } = agentWithPi();
  const { sessionId } = await agent.newSession({ cwd: "/tmp" });

  const { configOptions } = await agent.setSessionConfigOption({
    sessionId,
    configId: "thought_level",
    value: "xhigh",
  });

  assert.deepEqual(
    children[0].commands.find((command) => command.type === "set_thinking_level"),
    { type: "set_thinking_level", level: "xhigh" },
  );
  assert.equal(configOptions.find((option) => option.id === "thought_level").currentValue, "xhigh");
});

test("an unknown session is rejected rather than silently ignored", async () => {
  const { agent } = agentWithPi();
  await assert.rejects(
    () => agent.setSessionConfigOption({ sessionId: "missing", configId: "model", value: "a/b" }),
    /unknown session/,
  );
});
