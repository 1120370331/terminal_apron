import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  TaskConflictError,
  TaskStore,
  TaskValidationError,
  type TaskStoreEvent
} from "./tasks/taskStore.js";

test("persists tasks and applies optimistic revisions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-store-"));
  let store: TaskStore | null = new TaskStore(directory);
  try {
    store.createProject({ name: "Account Center", rootDirectory: directory });
    const created = store.create({
      title: "Fix login redirect",
      project: "Account Center",
      descriptionMd: "The callback returns to the wrong route.",
      priority: "P1",
      difficulty: 4,
      createdAt: "2025-04-03T10:30:00.000Z",
      tags: ["login", "bug", "bug"]
    });
    assert.equal(created.key, "TA-1");
    assert.equal(created.project, "Account Center");
    assert.equal(created.repositoryPath, directory);
    assert.equal(created.createdAt, "2025-04-03T10:30:00.000Z");
    assert.equal(created.status, "not_started");
    assert.deepEqual(created.tags, ["login", "bug"]);

    const updated = store.update(created.id, {
      revision: created.revision,
      status: "in_progress",
      createdAt: "2025-04-04T12:45:00.000Z"
    });
    assert.equal(updated?.revision, 2);
    assert.throws(
      () => store?.update(created.id, { revision: created.revision, title: "stale edit" }),
      TaskConflictError
    );

    store.close();
    store = new TaskStore(directory);
    const persisted = store.get(created.id);
    assert.equal(persisted?.title, "Fix login redirect");
    assert.equal(persisted?.project, "Account Center");
    assert.equal(persisted?.status, "in_progress");
    assert.equal(persisted?.createdAt, "2025-04-04T12:45:00.000Z");
    assert.equal(store.list().stats.active, 1);
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("assigns tasks to projects and filters unassigned work", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-store-"));
  const store = new TaskStore(directory);
  try {
    store.createProject({ name: "Account Center", rootDirectory: directory });
    store.createProject({ name: "Terminal Apron", rootDirectory: directory });
    store.createProject({ name: "Empty Project", rootDirectory: directory });
    store.create({ title: "Fix login redirect", project: "  Account   Center  " });
    store.create({ title: "Add password recovery", project: "Account Center" });
    store.create({ title: "Tune terminal preview", project: "Terminal Apron" });
    store.create({ title: "Triage later" });

    const accountTasks = store.list({ project: "account center" }).tasks;
    assert.equal(accountTasks.length, 2);
    assert.ok(accountTasks.every((task) => task.project === "Account Center"));
    assert.deepEqual(store.list({ project: "" }).tasks.map((task) => task.title), ["Triage later"]);
    assert.equal(store.list({ query: "Terminal Apron" }).tasks[0]?.title, "Tune terminal preview");

    const projects = store.projects();
    assert.deepEqual(
      projects.projects.map((project) => [project.name, project.taskCount]),
      [
        ["Account Center", 2],
        ["Empty Project", 0],
        ["Terminal Apron", 1]
      ]
    );
    assert.ok(projects.projects.every((project) => project.rootDirectory === directory));
    assert.equal(projects.unassignedCount, 1);

    const renamed = store.updateProject("Account Center", { name: "Identity", rootDirectory: directory });
    assert.equal(renamed?.name, "Identity");
    assert.equal(store.list({ project: "Identity" }).tasks.length, 2);
    assert.throws(
      () => store.create({ title: "Unknown project", project: "Missing" }),
      TaskValidationError
    );
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates v2 task databases and legacy progress states to schema v4", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-store-"));
  let store: TaskStore | null = new TaskStore(directory);
  try {
    const created = store.create({ title: "Existing v2 task" });
    store.close();
    store = null;

    const legacyDatabase = new DatabaseSync(path.join(directory, "task-monitor.sqlite"));
    legacyDatabase.exec(`
      DROP INDEX IF EXISTS idx_tasks_project_active;
      DROP TABLE IF EXISTS task_projects;
      ALTER TABLE tasks DROP COLUMN project;
      UPDATE tasks SET status = 'review';
      PRAGMA user_version = 2;
    `);
    legacyDatabase.close();

    store = new TaskStore(directory);
    assert.equal(store.get(created.id)?.title, "Existing v2 task");
    assert.equal(store.get(created.id)?.project, "");
    assert.equal(store.get(created.id)?.status, "pending_manual_acceptance");
    store.createProject({ name: "Core", rootDirectory: directory });
    assert.equal(store.create({ title: "Assigned after migration", project: "Core" }).project, "Core");
    store.close();
    store = null;

    const migratedDatabase = new DatabaseSync(path.join(directory, "task-monitor.sqlite"));
    const version = migratedDatabase.prepare("PRAGMA user_version").get() as { user_version: number };
    migratedDatabase.close();
    assert.equal(version.user_version, 4);
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("tracks completion, archive state, and attachment metadata", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-store-"));
  const store = new TaskStore(directory);
  try {
    const created = store.create({ title: "Add task monitor" });
    const completed = store.update(created.id, { revision: created.revision, status: "done" });
    assert.ok(completed?.completedAt);

    const withAttachment = store.addAttachment(created.id, {
      name: "login screenshot.png",
      storageName: "asset.png",
      mimeType: "image/png",
      size: 128
    });
    assert.equal(withAttachment?.attachments.length, 1);
    assert.match(withAttachment?.attachments[0].url ?? "", /\/api\/tasks\//);

    const archived = store.archive(created.id);
    assert.equal(archived?.archived, true);
    assert.equal(store.list().tasks.length, 0);
    assert.equal(store.list({ archived: true }).tasks.length, 1);

    const restored = store.restore(created.id);
    assert.equal(restored?.archived, false);
    assert.equal(store.list().stats.done, 1);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("records Codex reports and advances the discrete task stage", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-store-"));
  let store: TaskStore | null = new TaskStore(directory);
  try {
    const created = store.create({ title: "Repair login flow", status: "not_started" });
    const started = store.addReport(created.id, {
      status: "started",
      summary: "Reproduced the redirect race and started the fix.",
      changedFiles: ["src/login.tsx"],
      verification: [{ command: "npm test", result: "not_run", details: "Implementation in progress" }],
      nextStep: "Add regression coverage"
    });
    assert.equal(started?.status, "in_progress");
    assert.equal(started?.revision, 2);
    assert.equal(started?.latestReport?.status, "started");
    assert.deepEqual(started?.latestReport?.changedFiles, ["src/login.tsx"]);

    const blocked = store.addReport(created.id, {
      status: "blocked",
      summary: "Waiting for a reproducible production trace.",
      blockers: ["Missing callback trace"]
    });
    assert.equal(blocked?.status, "blocked");
    assert.deepEqual(blocked?.latestReport?.blockers, ["Missing callback trace"]);

    const completed = store.addReport(created.id, {
      status: "completed",
      summary: "Fixed the race and added regression coverage.",
      verification: [{ command: "npm test", result: "passed" }]
    });
    assert.equal(completed?.status, "pending_auto_acceptance");
    assert.equal(store.listReports(created.id)?.length, 3);
    assert.equal(store.listReports(created.id)?.[0].status, "completed");
    assert.throws(
      () =>
        store?.addReport(created.id, {
          status: "progress",
          summary: "Invalid evidence",
          verification: [{ command: "npm test", result: "unknown" as "passed" }]
        }),
      TaskValidationError
    );

    store.close();
    store = new TaskStore(directory);
    assert.equal(store.get(created.id)?.latestReport?.summary, "Fixed the race and added regression coverage.");
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("publishes task changes to realtime subscribers and stops after unsubscribe", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-store-"));
  const store = new TaskStore(directory);
  const events: TaskStoreEvent[] = [];
  try {
    const unsubscribe = store.subscribe((event) => events.push(event));
    store.createProject({ name: "Realtime", rootDirectory: directory });
    const created = store.create({ title: "Show Codex progress", project: "Realtime" });
    store.update(created.id, { revision: created.revision, status: "in_progress" });
    const withAttachment = store.addAttachment(created.id, {
      name: "evidence.png",
      storageName: "evidence.png",
      mimeType: "image/png",
      size: 128
    });
    const attachmentId = withAttachment?.attachments[0]?.id;
    assert.ok(attachmentId);
    store.removeAttachment(created.id, attachmentId);
    store.addReport(created.id, { status: "progress", summary: "AI updated the implementation progress." });
    store.archive(created.id);
    store.restore(created.id);
    store.updateProject("Realtime", { name: "Realtime Updates", rootDirectory: directory });

    assert.deepEqual(
      events.map((event) => event.type),
      [
        "project.created",
        "task.created",
        "task.updated",
        "attachment.added",
        "attachment.removed",
        "report.added",
        "task.archived",
        "task.restored",
        "project.updated"
      ]
    );
    assert.deepEqual(
      events.map((event) => event.id),
      events.map((_, index) => index + 1)
    );
    assert.equal(events.find((event) => event.type === "report.added")?.taskId, created.id);
    assert.ok(events.every((event) => !Number.isNaN(Date.parse(event.occurredAt))));

    unsubscribe();
    const latest = store.get(created.id)!;
    store.update(created.id, { revision: latest.revision, priority: "P0" });
    assert.equal(events.length, 9);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
