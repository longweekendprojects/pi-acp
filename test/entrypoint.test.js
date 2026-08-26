import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entrypoint = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("starts when the installed command resolves through a symlink", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-acp-entrypoint-"));
  const command = join(directory, "pi-acp");

  try {
    symlinkSync(entrypoint, command);
    const result = spawnSync(command, [], {
      encoding: "utf8",
      input: "",
      timeout: 5_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^\[pi-acp\] ready$/m);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
