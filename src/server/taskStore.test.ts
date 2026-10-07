import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  TaskConversationConflictError,
  TaskConflictError,
  TaskStore,
  TaskValidationError,
  type TaskStoreEvent
} from "./tasks/taskStore.js";

const sqliteTestOptions = { concurrency: false };

test("project tag catalogs persist unused names, isolate projects, and tag edits preserve concurrent task fields",sqliteTestOptions,()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"apron-project-tags-"));let store=new TaskStore(directory);
  try{
    store.createProject({name:"Alpha",rootDirectory:directory});store.createProject({name:"Beta",rootDirectory:directory});
    const task=store.create({title:"Alpha task",project:"Alpha",tags:["项目专项","API"]});store.create({title:"Beta task",project:"Beta",tags:["另一个项目"]});
    const before=task.revision;store.update(task.id,{title:"Updated independently",tags:[...task.tags,"人工标签"]});
    const tagged=store.updateTags(task.id,{add:["性能优化","api"],remove:["项目专项"]})!;
    assert.equal(tagged.title,"Updated independently");assert.equal(tagged.status,"not_started");assert.deepEqual(tagged.tags,["API","人工标签","性能优化"]);
    assert.throws(()=>store.updateTags(task.id,{tags:["覆盖"],revision:before}),TaskConflictError);
    const alpha=store.tags(false,"alpha",true).tags,beta=store.tags(false,"Beta",true).tags;
    assert.equal(alpha.find(tag=>tag.name==="项目专项")?.taskCount,0);assert.equal(alpha.find(tag=>tag.name==="性能优化")?.taskCount,1);assert.equal(alpha.find(tag=>tag.name==="性能优化")?.builtin,true);
    assert.equal(beta.some(tag=>tag.name==="项目专项"),false);assert.equal(alpha.some(tag=>tag.name==="另一个项目"),false);
    store.updateTags(task.id,{tags:[]});store.close();store=new TaskStore(directory);
    assert.ok(store.tags(false,"Alpha",true).tags.some(tag=>tag.name==="人工标签"));store.updateProject("Alpha",{name:"Renamed"});assert.ok(store.tags(false,"Renamed",true).tags.some(tag=>tag.name==="项目专项"));
    assert.throws(()=>store.updateTags(task.id,{add:Array.from({length:13},(_,i)=>`tag-${i}`)}),TaskValidationError);assert.deepEqual(store.get(task.id)!.tags,[]);
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("schema v12 backfills existing project labels without changing task records",sqliteTestOptions,()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"apron-tags-migration-"));let store=new TaskStore(directory);
  try{
    const task=store.create({title:"Legacy task",tags:["旧标签"]}),file=store.dbPath;store.close();const legacy=new DatabaseSync(file);legacy.exec("DROP TABLE task_tag_catalog; PRAGMA user_version=11;");legacy.close();store=new TaskStore(directory);
    assert.deepEqual(store.get(task.id),task);assert.ok(store.tags(false,"",true).tags.some(tag=>tag.name==="旧标签"));
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("persists tasks and applies optimistic revisions", sqliteTestOptions, () => {
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
    assert.equal(created.group, "");
    assert.equal(created.repositoryPath, directory);
    assert.equal(created.createdAt, "2025-04-03T10:30:00.000Z");
    assert.equal(created.status, "not_started");
    assert.equal(created.releaseStatus, "not_released");
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

test("assigns tasks to projects and filters unassigned work", sqliteTestOptions, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-store-"));
  const store = new TaskStore(directory);
  try {
    store.createProject({ name: "Account Center", descriptionMd: "Handles account redirects", rootDirectory: directory });
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
    assert.equal(projects.projects.find((project) => project.name === "Account Center")?.descriptionMd, "Handles account redirects");
    assert.equal(projects.unassignedCount, 1);

    const renamed = store.updateProject("Account Center", { name: "Identity", descriptionMd: "Identity and recovery workflows", rootDirectory: directory });
    assert.equal(renamed?.name, "Identity");
    assert.equal(renamed?.descriptionMd, "Identity and recovery workflows");
    assert.equal(store.list({ project: "Identity" }).tasks.length, 2);
    const renamedContext = fs.readFileSync(
      path.join(store.list({ project: "Identity" }).tasks[0].contextDirectory, "project.json"),
      "utf8"
    );
    assert.match(renamedContext, /"project": "Identity"/);
    assert.throws(
      () => store.create({ title: "Unknown project", project: "Missing" }),
      TaskValidationError
    );
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("stores task groups and filters by exact group and tags", sqliteTestOptions, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-store-"));
  const store = new TaskStore(directory);
  try {
    const delivery = store.create({
      title: "Ship the API",
      group: "  Delivery   squad  ",
      tags: ["API", "urgent", "api"]
    });
    store.create({ title: "Verify release notes", group: "Delivery squad", tags: ["api"] });
    store.create({ title: "Review interaction", group: "Quality", tags: ["urgent", "ux"] });

    assert.equal(delivery.group, "Delivery squad");
    assert.deepEqual(delivery.tags, ["API", "urgent"]);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(delivery.contextDirectory, "project.json"), "utf8")),
      { project: "", group: "Delivery squad", tags: ["API", "urgent"], repositoryPath: "" }
    );
    assert.equal(store.list({ group: "delivery squad" }).tasks.length, 2);
    assert.equal(store.list({ tags: ["URGENT", "api"] }).tasks.length, 1);
    assert.equal(store.list({ query: "delivery squad" }).tasks.length, 2);
    assert.deepEqual(store.groups().groups, [
      { name: "Delivery squad", taskCount: 2 },
      { name: "Quality", taskCount: 1 }
    ]);
    assert.equal(store.groups().ungroupedCount, 0);
    assert.deepEqual(store.tags().tags, [
      { name: "API", taskCount: 2 },
      { name: "urgent", taskCount: 2 },
      { name: "ux", taskCount: 1 }
    ]);

    const updated = store.update(delivery.id, { revision: delivery.revision, group: "Release train" });
    assert.equal(updated?.group, "Release train");
    assert.equal(store.list({ group: "Delivery squad" }).tasks.length, 1);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates v2 task databases and legacy progress states to schema v12", sqliteTestOptions, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-store-"));
  let store: TaskStore | null = new TaskStore(directory);
  try {
    const created = store.create({ title: "Existing v2 task" });
    store.close();
    store = null;

    const legacyDatabase = new DatabaseSync(path.join(directory, "task-monitor.sqlite"));
    legacyDatabase.exec(`
      DROP INDEX IF EXISTS idx_tasks_project_active;
      DROP INDEX IF EXISTS idx_tasks_group_active;
      DROP TABLE IF EXISTS task_projects;
      ALTER TABLE tasks DROP COLUMN project;
      ALTER TABLE tasks DROP COLUMN group_name;
      UPDATE tasks SET status = 'review';
      PRAGMA user_version = 2;
    `);
    legacyDatabase.close();

    store = new TaskStore(directory);
    assert.equal(store.get(created.id)?.title, "Existing v2 task");
    assert.equal(store.get(created.id)?.project, "");
    assert.equal(store.get(created.id)?.group, "");
    assert.equal(store.get(created.id)?.status, "pending_manual_acceptance");
    assert.equal(store.get(created.id)?.releaseStatus, "not_released");
    store.createProject({ name: "Core", rootDirectory: directory });
    assert.equal(store.create({ title: "Assigned after migration", project: "Core" }).project, "Core");
    assert.equal(store.project("Core")?.descriptionMd, "");
    store.close();
    store = null;

    const migratedDatabase = new DatabaseSync(path.join(directory, "task-monitor.sqlite"));
    const version = migratedDatabase.prepare("PRAGMA user_version").get() as { user_version: number };
    migratedDatabase.close();
    assert.equal(version.user_version, 13);
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("adds project descriptions to an existing v10 database and preserves saved paths", sqliteTestOptions, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-project-upgrade-"));
  const nextDirectory = path.join(directory, "next");
  fs.mkdirSync(nextDirectory);
  let store: TaskStore | null = new TaskStore(directory);
  try {
    store.createProject({ name: "Legacy", rootDirectory: directory });
    const existingTask = store.create({ title: "Existing work", project: "Legacy" });
    store.close();
    store = null;
    const legacy = new DatabaseSync(path.join(directory, "task-monitor.sqlite"));
    legacy.exec("ALTER TABLE task_projects DROP COLUMN description_md; PRAGMA user_version = 10;");
    legacy.close();

    store = new TaskStore(directory);
    assert.equal(store.project("Legacy")?.descriptionMd, "");
    assert.equal(store.project("Legacy")?.rootDirectory, directory);
    assert.equal(store.get(existingTask.id)?.repositoryPath, directory);
    const changed = store.updateProject("Legacy", { descriptionMd: "# Purpose\nKeep delivery traceable.", rootDirectory: nextDirectory });
    assert.equal(changed?.descriptionMd, "# Purpose\nKeep delivery traceable.");
    assert.equal(changed?.rootDirectory, nextDirectory);
    assert.equal(store.create({ title: "New work", project: "Legacy" }).repositoryPath, nextDirectory);
    assert.equal(store.get(existingTask.id)?.repositoryPath, directory);
    const upgraded = new DatabaseSync(store.dbPath);
    try {
      assert.equal((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 13);
    } finally {
      upgraded.close();
    }
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("persists Task Codex defaults with safe virtual values and optimistic revisions", sqliteTestOptions, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-preferences-"));
  let store: TaskStore | null = new TaskStore(directory);
  try {
    const task = store.create({ title: "Configurable Codex defaults" });
    assert.deepEqual(store.getConversationPreferences(task.id), {
      taskId: task.id,
      defaultModel: null,
      defaultReasoningEffort: "medium",
      defaultPermissionPreset: "read_only",
      revision: 0
    });
    const saved = store.updateConversationPreferences({ taskId: task.id, defaultModel: "gpt-test", defaultReasoningEffort: "high", defaultPermissionPreset: "workspace_write", revision: 0 });
    assert.equal(saved.revision, 1);
    assert.throws(
      () => store?.updateConversationPreferences({ taskId: task.id, defaultModel: null, defaultReasoningEffort: "low", defaultPermissionPreset: "read_only", revision: 0 }),
      (error) => error instanceof TaskConversationConflictError && error.code === "PREFERENCES_CONFLICT"
    );
    store.close();
    store = new TaskStore(directory);
    assert.deepEqual(store.getConversationPreferences(task.id), saved);
    assert.throws(() => store?.updateConversationPreferences({ taskId: task.id, defaultModel: null, defaultReasoningEffort: "invalid" as never, defaultPermissionPreset: "read_only", revision: 1 }), TaskValidationError);
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("adds a nullable default model to v8 preference rows without changing existing defaults", sqliteTestOptions, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-preferences-v8-"));
  let store: TaskStore | null = new TaskStore(directory);
  try {
    const task = store.create({ title: "Legacy v8 defaults" });
    store.close();
    store = null;
    const database = new DatabaseSync(path.join(directory, "task-monitor.sqlite"));
    database.exec(`
      DROP TABLE task_codex_preferences;
      CREATE TABLE task_codex_preferences (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        default_reasoning_effort TEXT NOT NULL CHECK (default_reasoning_effort IN ('minimal','low','medium','high','xhigh')),
        default_permission_preset TEXT NOT NULL CHECK (default_permission_preset IN ('read_only','workspace_write','full_access')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        updated_at TEXT NOT NULL
      );
      INSERT INTO task_codex_preferences VALUES ('${task.id}', 'high', 'workspace_write', 7, '2026-08-14T00:00:00.000Z');
      PRAGMA user_version = 8;
    `);
    database.close();

    store = new TaskStore(directory);
    assert.deepEqual(store.getConversationPreferences(task.id), {
      taskId: task.id,
      defaultModel: null,
      defaultReasoningEffort: "high",
      defaultPermissionPreset: "workspace_write",
      revision: 7,
      updatedAt: "2026-08-14T00:00:00.000Z"
    });
    const migrated = new DatabaseSync(path.join(directory, "task-monitor.sqlite"));
    try {
      const columns = migrated.prepare("PRAGMA table_info(task_codex_preferences)").all() as unknown as Array<{ name: string }>;
      assert.ok(columns.some((column) => column.name === "default_model"));
      assert.equal((migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 13);
    } finally {
      migrated.close();
    }
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("creates hierarchical task workspaces and refreshes parent handoff context", sqliteTestOptions, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-store-"));
  const store = new TaskStore(directory);
  try {
    store.createProject({ name: "Core", rootDirectory: directory });
    const parent = store.create({ title: "Parent task", project: "Core" });
    const child = store.create({ title: "Child task", parentTaskId: parent.id });
    const grandchild = store.create({ title: "Grandchild task", parentTaskId: child.id });

    assert.equal(child.parentTaskId, parent.id);
    assert.equal(child.parentTask?.key, parent.key);
    assert.equal(child.project, parent.project);
    assert.equal(child.repositoryPath, parent.repositoryPath);
    assert.equal(child.contextDirectory, path.join(parent.contextDirectory, "subtasks", child.key));
    assert.ok(fs.existsSync(path.join(child.contextDirectory, "task.md")));
    assert.match(fs.readFileSync(path.join(parent.contextDirectory, "context.md"), "utf8"), /Child task/);
    assert.deepEqual(store.get(parent.id)?.subtasks.map((item) => item.id), [child.id]);

    const updated = store.update(child.id, { revision: child.revision, title: "Renamed child" });
    assert.equal(updated?.title, "Renamed child");
    assert.match(fs.readFileSync(path.join(parent.contextDirectory, "context.md"), "utf8"), /Renamed child/);
    const secondParent = store.create({ title: "Second parent", project: "Core" });
    const previousChildDirectory = child.contextDirectory;
    const previousGrandchildDirectory = grandchild.contextDirectory;
    const reparented = store.update(child.id, { revision: updated!.revision, parentTaskId: secondParent.id })!;
    const movedGrandchild = store.get(grandchild.id)!;
    assert.equal(reparented.contextDirectory, path.join(secondParent.contextDirectory, "subtasks", child.key));
    assert.equal(movedGrandchild.contextDirectory, path.join(reparented.contextDirectory, "subtasks", grandchild.key));
    assert.ok(fs.existsSync(path.join(movedGrandchild.contextDirectory, "task.md")));
    assert.match(fs.readFileSync(path.join(previousChildDirectory, "context.md"), "utf8"), /moved/i);
    assert.match(fs.readFileSync(path.join(previousGrandchildDirectory, "context.md"), "utf8"), /moved/i);
    assert.throws(() => store.create({ title: "Missing parent", parentTaskId: "missing" }), TaskValidationError);
    store.createProject({ name: "Other", rootDirectory: directory });
    assert.throws(
      () => store.create({ title: "Cross-project child", project: "Other", parentTaskId: parent.id }),
      TaskValidationError
    );
    assert.throws(
      () => store.update(secondParent.id, { revision: secondParent.revision, parentTaskId: grandchild.id }),
      TaskValidationError
    );
    assert.throws(
      () => store.update(child.id, { revision: reparented.revision, project: "Other" }),
      TaskValidationError
    );
    const movable = store.create({ title: "Movable child", parentTaskId: parent.id });
    const detached = store.update(movable.id, {
      revision: movable.revision,
      parentTaskId: null,
      project: "Other"
    })!;
    assert.equal(detached.parentTaskId, undefined);
    assert.equal(detached.project, "Other");
    assert.equal(detached.contextDirectory, path.join(directory, "task-contexts", detached.key));
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates a v4 task database to release progress and task hierarchy without changing existing task data", sqliteTestOptions, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-store-"));
  let store: TaskStore | null = new TaskStore(directory);
  try {
    const created = store.create({ title: "Existing v4 task", priority: "P1" });
    store.close();
    store = null;

    const legacyDatabase = new DatabaseSync(path.join(directory, "task-monitor.sqlite"));
    legacyDatabase.exec(`
      DROP INDEX IF EXISTS idx_tasks_release_status;
      ALTER TABLE tasks DROP COLUMN release_status;
      PRAGMA user_version = 4;
    `);
    legacyDatabase.close();

    store = new TaskStore(directory);
    const migrated = store.get(created.id);
    assert.equal(migrated?.title, "Existing v4 task");
    assert.equal(migrated?.priority, "P1");
    assert.equal(migrated?.releaseStatus, "not_released");
    store.close();
    store = null;

    const migratedDatabase = new DatabaseSync(path.join(directory, "task-monitor.sqlite"));
    const version = migratedDatabase.prepare("PRAGMA user_version").get() as { user_version: number };
    const column = (
      migratedDatabase.prepare("PRAGMA table_info(tasks)").all() as unknown as Array<{
        name: string;
        dflt_value: string | null;
      }>
    ).find((candidate) => candidate.name === "release_status");
    const parentColumn = (
      migratedDatabase.prepare("PRAGMA table_info(tasks)").all() as unknown as Array<{ name: string }>
    ).find((candidate) => candidate.name === "parent_id");
    migratedDatabase.close();
    assert.equal(version.user_version, 13);
    assert.equal(column?.dflt_value, "'not_released'");
    assert.equal(parentColumn?.name, "parent_id");
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("stores, filters, updates, and validates release progress independently", sqliteTestOptions, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-store-"));
  const store = new TaskStore(directory);
  try {
    const unreleased = store.create({ title: "Still in development" });
    const local = store.create({ title: "Local package ready", releaseStatus: "local_complete" });
    const production = store.create({
      title: "Production rollout complete",
      status: "in_progress",
      releaseStatus: "production_complete"
    });

    assert.equal(unreleased.releaseStatus, "not_released");
    assert.deepEqual(store.list({ releaseStatus: "local_complete" }).tasks.map((task) => task.id), [local.id]);
    assert.equal(production.status, "in_progress");
    assert.equal(production.releaseStatus, "production_complete");

    const reverted = store.update(production.id, {
      revision: production.revision,
      releaseStatus: "not_released"
    });
    assert.equal(reverted?.releaseStatus, "not_released");
    assert.equal(reverted?.status, "in_progress");
    assert.throws(
      () => store.update(local.id, { releaseStatus: "staging_complete" as "local_complete" }),
      TaskValidationError
    );
    assert.throws(
      () => store.list({ releaseStatus: "staging_complete" as "local_complete" }),
      TaskValidationError
    );
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("tracks completion, archive state, and attachment metadata", sqliteTestOptions, () => {
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

test("records Codex reports and advances the discrete task stage", sqliteTestOptions, () => {
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
      verification: [{ command: "npm test", result: "passed" }],
      releaseStatus: "local_complete"
    });
    assert.equal(completed?.status, "pending_auto_acceptance");
    assert.equal(completed?.releaseStatus, "local_complete");
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
    const reportCount = store.listReports(created.id)?.length;
    assert.throws(
      () =>
        store?.addReport(created.id, {
          status: "progress",
          summary: "Invalid release state",
          releaseStatus: "staging_complete" as "local_complete"
        }),
      TaskValidationError
    );
    assert.equal(store.listReports(created.id)?.length, reportCount);
    assert.equal(store.get(created.id)?.releaseStatus, "local_complete");

    store.close();
    store = new TaskStore(directory);
    assert.equal(store.get(created.id)?.latestReport?.summary, "Fixed the race and added regression coverage.");
  } finally {
    store?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("publishes task changes to realtime subscribers and stops after unsubscribe", sqliteTestOptions, () => {
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

test("permanently deletes only a leaf task and returns its durable artifact paths", sqliteTestOptions, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-store-"));
  const store = new TaskStore(directory);
  const events: TaskStoreEvent[] = [];
  try {
    store.createProject({ name: "Deletion", rootDirectory: directory });
    const parent = store.create({ title: "Keep parent", project: "Deletion" });
    const doomed = store.create({ title: "Delete me", parentTaskId: parent.id });
    const survivor = store.create({ title: "Keep sibling", parentTaskId: parent.id });
    const attachmentDirectory = store.attachmentDirectory(doomed.id);
    const attachmentPath = store.attachmentFilePath(doomed.id, "evidence.png");
    fs.writeFileSync(attachmentPath, "evidence", "utf8");
    store.addAttachment(doomed.id, {
      name: "evidence.png",
      storageName: "evidence.png",
      mimeType: "image/png",
      size: 8
    });
    store.addReport(doomed.id, { status: "progress", summary: "Work in progress" });
    const contextDirectory = doomed.contextDirectory;
    assert.ok(fs.existsSync(contextDirectory));
    assert.equal(store.projects().projects.find((project) => project.name === "Deletion")?.taskCount, 3);

    const unsubscribe = store.subscribe((event) => events.push(event));
    const removed = store.delete(doomed.id);
    unsubscribe();

    assert.deepEqual(removed, {
      id: doomed.id,
      key: doomed.key,
      project: "Deletion",
      attachmentDirectory,
      contextDirectory,
      parentTaskId: parent.id
    });
    assert.equal(store.get(doomed.id), null);
    assert.equal(store.listReports(doomed.id), null);
    const inspection = new DatabaseSync(store.dbPath);
    assert.equal(
      (inspection.prepare("SELECT COUNT(*) AS count FROM task_reports WHERE task_id = ?").get(doomed.id) as { count: number }).count,
      0
    );
    assert.equal(
      (inspection.prepare("SELECT COUNT(*) AS count FROM task_attachments WHERE task_id = ?").get(doomed.id) as { count: number }).count,
      0
    );
    inspection.close();
    assert.equal(store.get(parent.id)?.subtasks.some((task) => task.id === doomed.id), false);
    assert.ok(store.get(survivor.id));
    assert.equal(store.projects().projects.find((project) => project.name === "Deletion")?.taskCount, 2);
    assert.equal(events.at(-1)?.type, "task.deleted");
    assert.equal(events.at(-1)?.taskId, doomed.id);
    assert.equal(events.at(-1)?.project, "Deletion");

    fs.rmSync(attachmentDirectory, { recursive: true, force: true });
    fs.rmSync(contextDirectory, { recursive: true, force: true });
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("refuses to delete a task that still has subtasks", sqliteTestOptions, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-store-"));
  const store = new TaskStore(directory);
  try {
    const parent = store.create({ title: "Parent" });
    const child = store.create({ title: "Child", parentTaskId: parent.id });

    assert.throws(() => store.delete(parent.id), TaskValidationError);
    assert.ok(store.get(parent.id));
    assert.ok(store.get(child.id));
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("persists conversation bindings, primary invariant, idempotency, and concurrency leases", sqliteTestOptions, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-conversation-store-"));
  const store = new TaskStore(directory);
  try {
    const task = store.create({ title: "Conversation task", maxConcurrency: 1 });
    store.bindConversation(task.id, "thread-a", "A", true);
    store.bindConversation(task.id, "thread-b", "B", true);
    assert.equal(store.listConversationBindings(task.id).filter((binding) => binding.isPrimary).length, 1);
    assert.equal(store.listConversationBindings(task.id).find((binding) => binding.isPrimary)?.threadId, "thread-b");

    const first = store.reserveConversationRequestAndLease({
      taskId: task.id, threadId: "thread-a", operation: "send", clientMessageId: "message-0001",
      requestHash: "same-hash", ownerInstanceId: "test-owner"
    });
    assert.equal(first.duplicate, false);
    const duplicate = store.reserveConversationRequestAndLease({
      taskId: task.id, threadId: "thread-a", operation: "send", clientMessageId: "message-0001",
      requestHash: "same-hash", ownerInstanceId: "test-owner"
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.receipt.operationId, first.receipt.operationId);
    assert.throws(
      () => store.reserveConversationRequestAndLease({ taskId: task.id, threadId: "thread-a", operation: "send", clientMessageId: "message-0002", requestHash: "other", ownerInstanceId: "test-owner" }),
      (error) => error instanceof TaskConversationConflictError && error.code === "TASK_CONCURRENCY_LIMIT"
    );
    store.markConversationRequestSubmitted(first.receipt.operationId, "turn-a");
    store.completeConversationTurn("thread-a", "turn-a");
    assert.doesNotThrow(() => store.reserveConversationRequestAndLease({ taskId: task.id, threadId: "thread-b", operation: "send", clientMessageId: "message-0003", requestHash: "third", ownerInstanceId: "test-owner" }));

    const database = new DatabaseSync(store.dbPath);
    try {
      assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 13);
      assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='uq_task_codex_threads_active_primary'").get());
    } finally {
      database.close();
    }
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("serializes conversation reservations across two store connections", sqliteTestOptions, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-conversation-race-"));
  const firstStore = new TaskStore(directory);
  const secondStore = new TaskStore(directory);
  try {
    const task = firstStore.create({ title: "Race", maxConcurrency: 1 });
    firstStore.bindConversation(task.id, "thread-a", "A");
    firstStore.bindConversation(task.id, "thread-b", "B");
    firstStore.reserveConversationRequestAndLease({ taskId: task.id, threadId: "thread-a", operation: "send", clientMessageId: "race-message-1", requestHash: "a", ownerInstanceId: "one" });
    assert.throws(
      () => secondStore.reserveConversationRequestAndLease({ taskId: task.id, threadId: "thread-b", operation: "send", clientMessageId: "race-message-2", requestHash: "b", ownerInstanceId: "two" }),
      (error) => error instanceof TaskConversationConflictError && error.code === "TASK_CONCURRENCY_LIMIT"
    );
  } finally {
    secondStore.close(); firstStore.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime owner lease prevents a second live owner", sqliteTestOptions, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-owner-"));
  const firstStore = new TaskStore(directory); const secondStore = new TaskStore(directory);
  try {
    assert.equal(firstStore.acquireConversationRuntimeOwner("owner-a", 20_000).acquired, true);
    assert.equal(secondStore.acquireConversationRuntimeOwner("owner-b", 20_000).acquired, false);
    firstStore.releaseConversationRuntimeOwner("owner-a");
    assert.equal(secondStore.acquireConversationRuntimeOwner("owner-b", 20_000).acquired, true);
  } finally { secondStore.close(); firstStore.close(); fs.rmSync(directory,{recursive:true,force:true}); }
});


test("legacy attachment migration trusts importer markers, preserves uploads and persists feedback tombstones",sqliteTestOptions,()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"apron-attachment-source-"));let store=new TaskStore(directory);
  try{
    const task=store.create({title:"Legacy migration"});const marker=`tm-${"a".repeat(64)}.md`,extensionless=`tm-${"b".repeat(64)}`;
    for(const storageName of [marker,extensionless,`tm-${"e".repeat(64)}.材料-code`,"user.md","report.html"]){store.addAttachment(task.id,{name:storageName,storageName,mimeType:"text/markdown",size:1});}
    store.close();const db=new DatabaseSync(path.join(directory,"task-monitor.sqlite"));db.exec("ALTER TABLE task_attachments DROP COLUMN source; ALTER TABLE task_attachments DROP COLUMN import_key");db.close();
    store=new TaskStore(directory);const migrated=store.get(task.id)!;
    assert.deepEqual(migrated.attachments.map(file=>file.source),["feedback","feedback","feedback","input","input"]);
    store.removeAttachment(task.id,migrated.attachments[0].id);store.close();store=new TaskStore(directory);
    assert.equal(store.feedbackImportDeleted(task.id,marker,"unknown-key"),true);
    assert.equal(store.get(task.id)!.attachments.length,4);
    const explicit=store.addAttachment(task.id,{name:"Explicit user upload",storageName:`tm-${"c".repeat(64)}.md`,mimeType:"text/markdown",size:1,source:"input"})!;
    store.close();store=new TaskStore(directory);assert.equal(store.get(task.id)!.attachments.find(file=>file.id===explicit.attachments.at(-1)!.id)!.source,"input");
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});
