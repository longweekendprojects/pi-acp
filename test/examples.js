import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));

const harness = await readJson("../examples/buzz-harness.json");
assert.equal(harness.id, "pi");
assert.equal(harness.command, "pi-acp");
assert.deepEqual(harness.args, []);
assert.equal("acpCommand" in harness, false);
assert.equal("agentCommand" in harness, false);

const reviewer = await readJson("../examples/pr-reviewer.agent.json");
assert.equal(reviewer.format, "buzz-agent-snapshot");
assert.equal(reviewer.version, 1);
assert.equal(reviewer.definition.runtime, "pi");
for (const field of ["acpCommand", "agentCommand", "agentArgs", "backend"]) {
  assert.equal(field in reviewer.definition, false, `${field} is machine-local and must stay out of snapshots`);
}

console.log("Buzz harness and agent snapshot examples use portable schemas.");
