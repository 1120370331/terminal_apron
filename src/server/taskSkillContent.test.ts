import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("task-skill-discovery: bundled CLI instructions are portable across task repositories", () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const skill = fs.readFileSync(
    path.join(repositoryRoot, ".agents", "skills", "manage-terminal-apron-tasks", "SKILL.md"),
    "utf8"
  );

  assert.doesNotMatch(skill, /node \.agents\/skills\/manage-terminal-apron-tasks\/scripts\/task-monitor\.mjs/);
  assert.match(skill, /<task-skill-dir>\/scripts\/task-monitor\.mjs/);
});

test("task-release-progress: skill documents the release report contract and evidence boundary", () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const skillRoot = path.join(repositoryRoot, ".agents", "skills", "manage-terminal-apron-tasks");
  const skill = fs.readFileSync(path.join(skillRoot, "SKILL.md"), "utf8");
  const schema = fs.readFileSync(path.join(skillRoot, "references", "report-schema.md"), "utf8");
  const cli = fs.readFileSync(path.join(skillRoot, "scripts", "task-monitor.mjs"), "utf8");

  assert.match(skill, /--release-status/);
  assert.match(skill, /production_complete/);
  assert.match(skill, /生产/);
  assert.match(schema, /releaseStatus/);
  assert.match(cli, /option\(parsed, "release-status"\)/);
  assert.match(cli, /not_released\|local_complete\|production_complete/);
});
