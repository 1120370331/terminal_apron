import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureTaskSkillAvailable } from "./taskSkill.js";

test("task-skill-discovery: links the project skill into the user discovery directory", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-skill-"));
  const projectRoot = path.join(directory, "terminal-apron");
  const homeDir = path.join(directory, "home");
  const source = path.join(projectRoot, ".agents", "skills", "manage-terminal-apron-tasks");
  const destination = path.join(homeDir, ".agents", "skills", "manage-terminal-apron-tasks");
  try {
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "SKILL.md"), "---\nname: manage-terminal-apron-tasks\n---\n");

    const installed = ensureTaskSkillAvailable({ projectRoot, homeDir });
    assert.equal(installed.status, "linked");
    assert.equal(fs.realpathSync(destination), fs.realpathSync(source));

    const repeated = ensureTaskSkillAvailable({ projectRoot, homeDir });
    assert.equal(repeated.status, "already_linked");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("task-skill-discovery: preserves an existing user skill instead of overwriting it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-skill-"));
  const projectRoot = path.join(directory, "terminal-apron");
  const homeDir = path.join(directory, "home");
  const source = path.join(projectRoot, ".agents", "skills", "manage-terminal-apron-tasks");
  const destination = path.join(homeDir, ".agents", "skills", "manage-terminal-apron-tasks");
  try {
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, "SKILL.md"), "canonical");
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "SKILL.md"), "user-owned");

    const result = ensureTaskSkillAvailable({ projectRoot, homeDir });
    assert.equal(result.status, "conflict");
    assert.equal(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8"), "user-owned");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
