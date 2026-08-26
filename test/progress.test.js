import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PiAcpAgent } from "../src/index.js";

const MINUTE = 60_000;
const CHANNEL = "550e8400-e29b-41d4-a716-446655440000";
const ROOT = "a".repeat(64);
const PARENT = "b".repeat(64);
const ANCHOR = "c".repeat(64);
const RELAY_CREDENTIALS = {
  BUZZ_RELAY_URL: "wss://relay.example",
  BUZZ_PRIVATE_KEY: "private-key",
};

class FakeTimers {
  constructor() {
    this.now = 0;
    this.created = [];
    this.pending = new Set();
  }

  setTimeout = (callback, delay) => {
    const timer = {
      due: this.now + delay,
      unrefed: false,
      unref() {
        this.unrefed = true;
      },
      callback,
    };
    this.created.push(timer);
    this.pending.add(timer);
    return timer;
  };

  clearTimeout = (timer) => this.pending.delete(timer);

  advanceTo(target) {
    for (;;) {
      const next = [...this.pending].filter((timer) => timer.due <= target).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      this.pending.delete(next);
      this.now = next.due;
      next.callback();
    }
    this.now = target;
  }
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.writable = true;
  child.stdin.write = () => true;
  child.stdin.end = () => {
    child.stdin.writable = false;
  };
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

function important(anchor, newThread = false) {
  if (newThread) {
    return `IMPORTANT: This is a new top-level message. For ordinary replies in this turn, use \`--reply-to ${anchor}\` on \`buzz messages send\` — the triggering message is the thread root. Do NOT reply into any other (older) thread. If the human explicitly asks for a channel-root, top-level, or broadcast post, send that message without \`--reply-to\`. If the requested destination is ambiguous, ask before sending.`;
  }
  return `IMPORTANT: For ordinary replies in this turn, use \`--reply-to ${anchor}\` on \`buzz messages send\` so the conversation stays threaded. If the human explicitly asks for a channel-root, top-level, or broadcast post, send that message without \`--reply-to\`. If the requested destination is ambiguous, ask before sending.`;
}

function context(scope = "channel", channel = CHANNEL, anchor = ANCHOR) {
  const channelLine = `Channel: ${channel}`;
  if (scope === "thread") {
    return [
      "[Context]",
      "Scope: thread",
      channelLine,
      "Description: Engineering discussions",
      `Thread root: ${ROOT}`,
      `Parent: ${PARENT}`,
      "Thread context included below. Use `buzz messages thread --channel <UUID> --event <ID>` for full history if truncated.",
      important(anchor),
    ].join("\n");
  }
  if (scope === "dm") {
    return [
      "[Context]",
      "Scope: dm",
      channelLine,
      `Thread root: ${ROOT}`,
      `Parent: ${PARENT}`,
      "Thread context included below. Use `buzz messages thread --channel <UUID> --event <ID>` for full history if truncated.",
      important(anchor),
    ].join("\n");
  }
  return [
    "[Context]",
    "Scope: channel",
    channelLine,
    "Description: Engineering discussions",
    "Hint: Use `buzz messages get --channel <UUID>` for recent messages if needed.",
    important(anchor, true),
  ].join("\n");
}

async function startTurn({ prompt = context(), env = RELAY_CREDENTIALS } = {}) {
  const timers = new FakeTimers();
  const piChildren = [];
  const reports = [];
  const updates = [];
  const spawnProcess = (command, args, options) => {
    const child = fakeChild();
    if (command === "buzz") reports.push({ args, child, options });
    else piChildren.push(child);
    return child;
  };
  const agent = new PiAcpAgent(
    { sessionUpdate: async (update) => updates.push(update) },
    {
      spawnProcess,
      setTimeoutFn: timers.setTimeout,
      clearTimeoutFn: timers.clearTimeout,
      now: () => timers.now,
      env,
    },
  );
  const { sessionId } = await agent.newSession({ cwd: "/tmp" });
  const turn = agent.prompt({ sessionId, prompt: [{ type: "text", text: prompt }] });
  return { agent, piChild: piChildren[0], reports, sessionId, timers, turn, updates };
}

function settle(run) {
  run.piChild.stdout.emit("data", Buffer.from('{"type":"agent_settled"}\n'));
  return run.turn;
}

function reportArgument(report, name) {
  return report.args[report.args.indexOf(name) + 1];
}

test("routes production-shaped Buzz channel, thread, and DM context", async () => {
  const cases = [
    { name: "raw channel", scope: "channel", channel: CHANNEL, anchor: ANCHOR },
    { name: "named channel", scope: "channel", channel: `engineering (#${CHANNEL})`, anchor: ROOT },
    { name: "named thread", scope: "thread", channel: `engineering (#${CHANNEL})`, anchor: ANCHOR },
    { name: "raw DM", scope: "dm", channel: CHANNEL, anchor: ROOT },
  ];

  for (const entry of cases) {
    const run = await startTurn({ prompt: context(entry.scope, entry.channel, entry.anchor) });
    run.timers.advanceTo(2 * MINUTE);

    assert.equal(run.reports.length, 1, entry.name);
    assert.equal(reportArgument(run.reports[0], "--channel"), CHANNEL, entry.name);
    assert.equal(reportArgument(run.reports[0], "--reply-to"), entry.anchor, entry.name);
    assert.equal(run.reports[0].options.env.BUZZ_RELAY_URL, RELAY_CREDENTIALS.BUZZ_RELAY_URL, entry.name);
    assert.equal(run.reports[0].options.env.BUZZ_PRIVATE_KEY, RELAY_CREDENTIALS.BUZZ_PRIVATE_KEY, entry.name);
    assert.equal(run.reports[0].options.shell, false, entry.name);
    assert.equal(run.reports[0].options.stdio, "ignore", entry.name);
    assert.ok(run.timers.created.every((timer) => timer.unrefed), entry.name);

    await settle(run);
    assert.equal(run.timers.pending.size, 0, entry.name);
  }
});

test("rejects malformed, duplicate, and ambiguous Buzz routing context", async () => {
  const channelContext = context("channel");
  const threadContext = context("thread");
  const cases = [
    ["missing context", "Review this change."],
    ["duplicate context blocks", `${channelContext}\n\n${channelContext}`],
    ["duplicate scope", channelContext.replace("Scope: channel", "Scope: channel\nScope: channel")],
    ["duplicate channel", channelContext.replace(`Channel: ${CHANNEL}`, `Channel: ${CHANNEL}\nChannel: ${CHANNEL}`)],
    ["duplicate thread root", threadContext.replace(`Thread root: ${ROOT}`, `Thread root: ${ROOT}\nThread root: ${ROOT}`)],
    ["duplicate parent", threadContext.replace(`Parent: ${PARENT}`, `Parent: ${PARENT}\nParent: ${PARENT}`)],
    ["malformed channel UUID", channelContext.replace(CHANNEL, "not-a-uuid")],
    ["malformed named channel UUID", context("channel", "engineering (#not-a-uuid)")],
    ["malformed thread root", threadContext.replace(ROOT, "not-an-event")],
    ["malformed parent", threadContext.replace(PARENT, "not-an-event")],
    ["malformed reply anchor", channelContext.replace(ANCHOR, "not-an-event")],
    ["duplicate reply anchors", channelContext.replace(important(ANCHOR, true), `IMPORTANT: Use \`--reply-to ${ANCHOR}\` and \`--reply-to ${ROOT}\`.`)],
    ["unknown routing field", channelContext.replace("Hint:", `Reply anchor: ${ANCHOR}\nHint:`)],
    ["unknown context prose", channelContext.replace("Hint:", "Route this reply safely\nHint:")],
  ];

  for (const [name, prompt] of cases) {
    const run = await startTurn({ prompt });
    assert.equal(run.timers.created.length, 0, name);
    run.timers.advanceTo(30 * MINUTE);
    assert.equal(run.reports.length, 0, name);
    await settle(run);
  }
});

test("requires both relay credentials before arming progress reporting", async () => {
  const cases = [
    ["neither credential", {}, 0],
    ["relay URL only", { BUZZ_RELAY_URL: RELAY_CREDENTIALS.BUZZ_RELAY_URL }, 0],
    ["private key only", { BUZZ_PRIVATE_KEY: RELAY_CREDENTIALS.BUZZ_PRIVATE_KEY }, 0],
    ["both credentials", RELAY_CREDENTIALS, 1],
  ];

  for (const [name, env, expectedTimers] of cases) {
    const run = await startTurn({ env });
    assert.equal(run.timers.created.length, expectedTimers, name);
    run.timers.advanceTo(2 * MINUTE);
    assert.equal(run.reports.length, expectedTimers, name);
    await settle(run);
    assert.equal(run.timers.pending.size, 0, name);
  }
});

test("uses cumulative elapsed deadlines for recurring progress", async () => {
  const run = await startTurn();

  for (const minutes of [2, 5, 10, 20, 30]) run.timers.advanceTo(minutes * MINUTE);

  assert.deepEqual(
    run.reports.map((report) => reportArgument(report, "--content")),
    [2, 5, 10, 20, 30].map(
      (minutes) => `pi is still working on this request (${minutes} minutes elapsed).`,
    ),
  );
  assert.ok(run.timers.created.every((timer) => timer.unrefed));

  await settle(run);
  assert.equal(run.timers.pending.size, 0);
});

test("keeps fast and failed reporter paths out of ACP output", async () => {
  const fast = await startTurn();
  await settle(fast);
  fast.timers.advanceTo(30 * MINUTE);
  assert.equal(fast.reports.length, 0);
  assert.deepEqual(fast.updates, []);

  const failed = await startTurn();
  failed.timers.advanceTo(2 * MINUTE);
  failed.reports[0].child.emit("error", new Error("relay unavailable"));
  failed.timers.advanceTo(5 * MINUTE);
  failed.reports[1].child.emit("exit", 1);
  assert.deepEqual(failed.updates, []);
  await settle(failed);
  assert.deepEqual(failed.updates, []);
});

test("clears unreferenced progress timers on every terminal path", async () => {
  const paths = {
    settled: async (run) => settle(run),
    "pi child exit": async (run) => {
      run.piChild.emit("exit", 0);
      await run.turn;
    },
    cancellation: async (run) => {
      await run.agent.cancel({ sessionId: run.sessionId });
      await settle(run);
    },
    shutdown: async (run) => {
      run.agent.shutdown();
      await settle(run);
    },
  };

  for (const [name, finish] of Object.entries(paths)) {
    const run = await startTurn();
    await finish(run);
    assert.equal(run.timers.pending.size, 0, name);
    assert.ok(run.timers.created.every((timer) => timer.unrefed), name);
  }
});
