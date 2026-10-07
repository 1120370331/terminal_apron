import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { selectTaskTerminalCwd } from "./tasks/taskTerminalContext.js";

test("requires a materialized task context directory for terminal allocation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-terminal-context-"));
  try {
    const contextDirectory = path.join(root, "TA-1");
    fs.mkdirSync(contextDirectory);
    fs.writeFileSync(path.join(contextDirectory, "context.md"), "handoff");
    assert.equal(selectTaskTerminalCwd({ contextDirectory, repositoryPath: path.join(root, "repo") }), contextDirectory);
    fs.rmSync(path.join(contextDirectory, "context.md"));
    assert.throws(
      () => selectTaskTerminalCwd({ contextDirectory, repositoryPath: path.join(root, "repo") }),
      /context workspace is unavailable/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
