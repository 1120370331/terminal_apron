import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { quotePosixLiteral, quotePowerShellLiteral, writeTaskContextWorkspace } from "./tasks/taskContextWorkspace.js";

test("materializes a safe task context bundle with copyable repository commands", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-context-"));
  try {
    const repositoryPath = `C:\\Work Space\\Bob's $project; &(示例)`;
    const contextDirectory = writeTaskContextWorkspace(dataDir, {
      task: {
        id: "task-1",
        key: "TA-1",
        project: "Terminal Apron",
        group: "Context persistence",
        title: "Persist context",
        descriptionMd: "Keep handoff facts durable.",
        acceptanceCriteriaMd: "- [ ] Resume from files",
        status: "in_progress",
        releaseStatus: "not_released",
        priority: "P1",
        difficulty: 3,
        tags: ["context"],
        repositoryPath,
        contextDirectory: "",
        subtasks: [],
        maxConcurrency: 1,
        revision: 1,
        archived: false,
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
        attachments: []
      },
      reports: []
    });

    assert.equal(contextDirectory, path.join(dataDir, "task-contexts", "TA-1"));
    assert.deepEqual(
      fs.readdirSync(contextDirectory).sort(),
      ["attachments.json", "feedback-artifacts.json", "input-attachments.json", "context.md", "project.json", "reports.json", "task.md"].sort()
    );
    const context = fs.readFileSync(path.join(contextDirectory, "context.md"), "utf8");
    assert.match(context, /Set-Location -LiteralPath 'C:\\Work Space\\Bob''s \$project; &\(示例\)'/);
    assert.match(context, /cd 'C:\\Work Space\\Bob'\\''s \$project; &\(示例\)'/);
    assert.match(context, /- Group: Context persistence/);
    assert.match(context, /- Tags: context/);
    assert.equal(quotePowerShellLiteral("a'b"), "'a''b'");
    assert.equal(quotePosixLiteral("a'b"), "'a'\\''b'");
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("nests child context below its parent and tombstones an old path after reparent", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-context-"));
  try {
    const first = path.join(dataDir, "task-contexts", "TA-1", "subtasks", "TA-3");
    fs.mkdirSync(first, { recursive: true });
    fs.writeFileSync(path.join(first, "context.md"), "old");
    const next = writeTaskContextWorkspace(
      dataDir,
      {
        task: {
          id: "child",
          key: "TA-3",
          parentTaskId: "parent-2",
          parentTask: { id: "parent-2", key: "TA-2", title: "New parent" },
          project: "Core",
          group: "",
          title: "Child",
          descriptionMd: "",
          acceptanceCriteriaMd: "",
          status: "not_started",
          releaseStatus: "not_released",
          priority: "P2",
          difficulty: 2,
          tags: [],
          repositoryPath: "C:\\repo",
          contextDirectory: "",
          subtasks: [],
          maxConcurrency: 1,
          revision: 2,
          archived: false,
          createdAt: "2026-08-12T00:00:00.000Z",
          updatedAt: "2026-08-12T00:01:00.000Z",
          attachments: []
        },
        reports: []
      },
      { previousDirectory: first, parentDirectory: path.join(dataDir, "task-contexts", "TA-2") }
    );
    assert.equal(next, path.join(dataDir, "task-contexts", "TA-2", "subtasks", "TA-3"));
    assert.match(fs.readFileSync(path.join(first, "context.md"), "utf8"), /moved/i);
    assert.match(fs.readFileSync(path.join(first, "context.md"), "utf8"), /TA-2/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
