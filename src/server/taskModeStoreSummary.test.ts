import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { TaskStore } from "./tasks/taskStore.js";
import { TaskModeStore } from "./tasks/taskModeStore.js";
import { TaskModeService } from "./tasks/taskModeService.js";
import { DEFAULT_TASK_MODE_SETTINGS, type TaskInstruction, type TaskModeState } from "../shared/taskModeTypes.js";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-summary-")), tasks = new TaskStore(directory);
  const db = new DatabaseSync(tasks.dbPath); db.exec("PRAGMA foreign_keys=ON;");
  return { tasks, db, directory, close() { db.close(); tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
function state(taskId: string, phase: TaskModeState["phase"] = "idle"): TaskModeState {
  return { taskId, phase, settings: { ...DEFAULT_TASK_MODE_SETTINGS }, instructions: [], runs: [], events: [], heartbeat: { status: "idle", recoveryAttempts: 0 }, revision: 1, updatedAt: "2020-01-01T00:00:00Z" };
}
function instruction(overrides: Partial<TaskInstruction> = {}): TaskInstruction {
  return { id: "instruction", clientMessageId: "request", text: "immutable input", timing: "after", status: "queued", createdAt: "2020-01-01T00:00:00Z", deliveries: [],
    snapshot: { title: "Snapshot", descriptionMd: "original", acceptanceCriteriaMd: "criteria", revision: 1, repositoryPath: "", attachments: [], references: [] }, ...overrides };
}
function projection(s: TaskModeState) {
  return { taskId: s.taskId, phase: s.phase, settings: s.settings, instructionCount: s.instructions.filter(x => !x.deletedAt).length,
    heartbeat: s.heartbeat, updatedAt: s.updatedAt, processedDurationMs: s.processedDurationMs, processedVerifiedDurationMs: s.processedVerifiedDurationMs, processingStartedAt: s.processingStartedAt,
    processedTimingCoverage: s.processedTimingCoverage, processedTimingSince: s.processedTimingSince, processedRecoveredDurationMs: s.processedRecoveredDurationMs };
}
function historyParses(fn: () => void): number {
  const original = JSON.parse; let count = 0;
  JSON.parse = ((value: string, reviver?: Parameters<typeof JSON.parse>[1]) => { if (value.includes('"runs":')) count++; return original(value, reviver); }) as typeof JSON.parse;
  try { fn(); } finally { JSON.parse = original; }
  return count;
}
function legacySchema(db: DatabaseSync) {
  db.exec("CREATE TABLE task_mode_state(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,data TEXT NOT NULL); CREATE TABLE task_mode_processing(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,total_ms INTEGER,started_at TEXT,runtime_id TEXT);");
}
function measuredHistory(s: TaskModeState, duration = 8000) {
  s.runs.push({ id: "old", instructionIds: [], createdAt: s.updatedAt, settings: s.settings, reviewAttempt: 0, jobs: [{ id: "job", role: "execute", name: "quick", objective: "", ownedPaths: [], status: "completed", attempt: 0, text: "", model: "", items: [
    { kind: "command", id: "done", command: "retained-command", cwd: "", status: "completed", durationMs: duration },
    { kind: "command", id: "not-done", command: "retained-unfinished", cwd: "", status: "inProgress", durationMs: 900000 }
  ] }] });
}

test("old rows backfill once, preserve full history, timing migration and summary result across reopen", () => {
  const f = fixture(); let mode: TaskModeStore | undefined;
  try {
    legacySchema(f.db);
    const a = f.tasks.create({ title: "Historical quick" }), b = f.tasks.create({ title: "Known exact total" });
    const old = state(a.id, "paused"); old.settings.executionMode = "quick"; old.instructions = [instruction(), instruction({ id: "deleted", deletedAt: old.updatedAt }), instruction({ id: "archived", archivedAt: old.updatedAt })]; measuredHistory(old);
    const serialized = JSON.stringify(old);
    f.db.prepare("INSERT INTO task_mode_state VALUES(?,?)").run(a.id, serialized);
    f.db.prepare("INSERT INTO task_mode_state VALUES(?,?)").run(b.id, JSON.stringify(state(b.id, "completed")));
    f.db.prepare("INSERT INTO task_mode_processing VALUES(?,?,NULL,NULL)").run(b.id, 51680);
    mode = new TaskModeStore(f.tasks.dbPath);
    assert.equal(historyParses(() => { const summaries = mode!.summaries(); assert.equal(summaries.length, 2); assert.equal(summaries[0].instructionCount, 2); assert.equal(summaries[0].processedDurationMs, null); assert.equal(summaries[0].processedVerifiedDurationMs, 8000); assert.equal(summaries[0].processedTimingCoverage, "partial"); assert.equal(summaries[0].processedRecoveredDurationMs, 8000); assert.equal(summaries[1].processedDurationMs, 51680); assert.equal(summaries[1].processedVerifiedDurationMs, 51680); assert.equal(summaries[1].processedTimingCoverage, "complete"); }), 2);
    assert.equal((f.db.prepare("SELECT total_ms FROM task_mode_processing WHERE task_id=?").get(a.id) as { total_ms: number | null }).total_ms, null);
    assert.equal((f.db.prepare("SELECT total_ms FROM task_mode_processing_verified WHERE task_id=?").get(a.id) as { total_ms: number }).total_ms, 8000);
    assert.deepEqual(mode.summaries(), mode.all().map(projection));
    assert.equal((f.db.prepare("SELECT data FROM task_mode_state WHERE task_id=?").get(a.id) as { data: string }).data, serialized);
    assert.equal(mode.get(a.id)!.runs[0].jobs[0].items[0].kind, "command");
    mode.close(); mode = new TaskModeStore(f.tasks.dbPath);
    assert.equal(historyParses(() => { mode!.summaries(); mode!.scheduledTaskIds(); mode!.startupTaskIds(); }), 0);
  } finally { mode?.close(); f.close(); }
});

test("new and legacy cross-connection saves invalidate only changed rows; deletion cascades", () => {
  const f = fixture(), a = new TaskModeStore(f.tasks.dbPath), b = new TaskModeStore(f.tasks.dbPath);
  try {
    const task = f.tasks.create({ title: "Cross connection" }), s = a.ensure(task.id); s.phase = "completed"; a.save(s);
    assert.equal(historyParses(() => b.summaries()), 0);
    s.phase = "idle"; s.instructions.push(instruction()); a.save(s);
    assert.deepEqual(b.scheduledTaskIds(), [task.id]); assert.deepEqual(b.summaries(), a.all().map(projection));
    const legacy = b.get(task.id)!; legacy.phase = "paused"; legacy.heartbeat.message = "legacy update";
    f.db.prepare("UPDATE task_mode_state SET data=? WHERE task_id=?").run(JSON.stringify(legacy), task.id);
    assert.equal(historyParses(() => { assert.equal(a.summaries()[0].heartbeat.message, "legacy update"); }), 1);
    assert.equal(historyParses(() => a.summaries()), 0); assert.deepEqual(a.scheduledTaskIds(), []);
    const other = f.tasks.create({ title: "Legacy insert" });
    f.db.prepare("INSERT INTO task_mode_state VALUES(?,?)").run(other.id, JSON.stringify(state(other.id)));
    assert.equal(historyParses(() => b.summaries()), 1);
    f.tasks.delete(task.id); assert.equal(b.summaries().some(x => x.taskId === task.id), false);
    assert.equal(f.db.prepare("SELECT * FROM task_mode_processing_verified WHERE task_id=?").get(task.id), undefined);
    assert.equal(f.db.prepare("SELECT * FROM task_mode_processing WHERE task_id=?").get(task.id), undefined);
    f.db.prepare("DELETE FROM task_mode_state WHERE task_id=?").run(other.id); assert.deepEqual(a.summaries(), []);
    assert.equal((f.db.prepare("SELECT count(*) n FROM task_mode_summary").get() as { n: number }).n, 0);
  } finally { a.close(); b.close(); f.close(); }
});

test("timing stays authoritative across connections, recover missing lower bounds once, close only open clocks", () => {
  const f = fixture(); let now = 10000; const a = new TaskModeStore(f.tasks.dbPath, { nowMs: () => now }), b = new TaskModeStore(f.tasks.dbPath, { nowMs: () => now });
  try {
    const task = f.tasks.create({ title: "Live clock" }), s = a.ensure(task.id); measuredHistory(s); s.phase = "working"; a.save(s);
    const start = s.processingStartedAt; now = 12000; b.setProcessing(b.get(task.id)!, false);
    assert.equal(historyParses(() => { const summary = a.summaries()[0]; assert.equal(summary.processedDurationMs, 2000); assert.equal(summary.processedVerifiedDurationMs, 2000); assert.equal(summary.processingStartedAt, null); }), 0);
    s.phase = "paused"; a.save(s);
    f.db.prepare("UPDATE task_mode_processing SET total_ms=999999,coverage='partial',recovered_ms=999999 WHERE task_id=?").run(task.id);
    assert.equal(historyParses(() => { const summary = b.summaries()[0]; assert.equal(summary.processedDurationMs, 2000); assert.equal(summary.processedVerifiedDurationMs, 2000); assert.equal(summary.processedTimingCoverage, "complete"); }), 0);
    // Simulate a pre-migration/missing authority, not an old writer changing its projection.
    f.db.prepare("DELETE FROM task_mode_processing_verified WHERE task_id=?").run(task.id);
    f.db.prepare("UPDATE task_mode_processing SET total_ms=NULL,coverage=NULL,recovered_ms=NULL WHERE task_id=?").run(task.id);
    assert.equal(historyParses(() => { const summary = b.summaries()[0]; assert.equal(summary.processedDurationMs, null); assert.equal(summary.processedVerifiedDurationMs, 8000); assert.equal(summary.processedTimingCoverage, "partial"); }), 1);
    assert.equal(historyParses(() => b.summaries()), 0);
    const idle = f.tasks.create({ title: "No clock" }); a.ensure(idle.id);
    const active = a.get(task.id)!; active.phase = "working"; a.save(active); assert.notEqual(active.processingStartedAt, start);
    now += 3000;
    assert.equal(historyParses(() => a.stopProcessing()), 1);
    assert.equal(b.summaries().find(x => x.taskId === task.id)!.processedDurationMs, null);
    assert.equal(b.summaries().find(x => x.taskId === task.id)!.processedVerifiedDurationMs, 11000);
    assert.equal(b.summaries().find(x => x.taskId === task.id)!.processedRecoveredDurationMs, 8000);
  } finally { a.close(); b.close(); f.close(); }
});

test("save and backfill failures roll back history, clock and summary together", () => {
  const f = fixture(), mode = new TaskModeStore(f.tasks.dbPath);
  try {
    const task = f.tasks.create({ title: "Atomic projection" }), s = mode.ensure(task.id);
    const snapshot = () => JSON.stringify([f.db.prepare("SELECT * FROM task_mode_state").all(), f.db.prepare("SELECT * FROM task_mode_processing_verified").all(), f.db.prepare("SELECT * FROM task_mode_processing").all(), f.db.prepare("SELECT * FROM task_mode_summary").all()]);
    const before = snapshot();
    f.db.exec("CREATE TRIGGER reject_summary BEFORE INSERT ON task_mode_summary BEGIN SELECT RAISE(ABORT,'projection failed'); END;");
    s.phase = "working"; assert.throws(() => mode.save(s), /projection failed/); assert.equal(snapshot(), before);
    f.db.exec("DROP TRIGGER reject_summary;");
    const legacy = f.tasks.create({ title: "Backfill atomicity" });
    f.db.prepare("INSERT INTO task_mode_state VALUES(?,?)").run(legacy.id, JSON.stringify(state(legacy.id)));
    f.db.exec("CREATE TRIGGER reject_summary BEFORE INSERT ON task_mode_summary BEGIN SELECT RAISE(ABORT,'projection failed'); END;");
    assert.throws(() => mode.summaries(), /projection failed/);
    assert.equal(f.db.prepare("SELECT * FROM task_mode_processing_verified WHERE task_id=?").get(legacy.id), undefined);
    assert.equal(f.db.prepare("SELECT * FROM task_mode_processing WHERE task_id=?").get(legacy.id), undefined);
    f.db.exec("DROP TRIGGER reject_summary;"); assert.equal(mode.summaries().length, 2);
  } finally { mode.close(); f.close(); }
});

test("candidate IDs retain active/retry and effective ready queues, exclude paused/archive, preserve blocked startup", () => {
  const f = fixture(), mode = new TaskModeStore(f.tasks.dbPath); const expected: string[] = [], blocked: string[] = [];
  try {
    for (const phase of ["idle", "completed", "needs_confirmation", "planning", "working", "reviewing", "paused", "blocked"] as const) {
      const task = f.tasks.create({ title: phase }), s = mode.ensure(task.id); s.phase = phase; s.instructions.push(instruction());
      s.settings.executionMode = "quick"; s.heartbeat.nextRetryAt = "2099-01-01T00:00:00Z"; mode.save(s);
      if (!["paused", "blocked"].includes(phase)) expected.push(task.id); if (phase === "blocked") blocked.push(task.id);
    }
    for (const override of [{ archivedAt: "2020-01-01" }, { deletedAt: "2020-01-01" }, { status: "completed" as const }]) {
      const task = f.tasks.create({ title: "Ineffective queue" }), s = mode.ensure(task.id); s.instructions.push(instruction(override)); mode.save(s);
    }
    assert.deepEqual(mode.scheduledTaskIds(), expected); assert.deepEqual(mode.startupTaskIds(), [...expected, ...blocked]);
    f.tasks.archive(expected[0]); assert.deepEqual(mode.scheduledTaskIds(), expected.slice(1));
    f.tasks.restore(expected[0]); assert.equal(historyParses(() => assert.deepEqual(mode.scheduledTaskIds(), expected)), 0);
    assert.deepEqual(mode.summaries(), mode.all().map(projection));
  } finally { mode.close(); f.close(); }
});

test("service list, constructor and polling do not call all; only real candidates reach advance and usage stays intact", async () => {
  const f = fixture(), seed = new TaskModeStore(f.tasks.dbPath), archived: string[] = [], candidate: string[] = [];
  const originalAll = TaskModeStore.prototype.all, originalAdvance = (TaskModeService.prototype as any).advance;
  let mode: TaskModeService | undefined; const advanced = new Set<string>(), refreshed: string[] = [];
  try {
    for (const phase of ["idle", "completed", "paused", "working"] as const) { const task = f.tasks.create({ title: phase }), s = seed.ensure(task.id); s.phase = phase; seed.save(s); if (phase === "working") candidate.push(task.id); }
    const hidden = f.tasks.create({ title: "Archived working" }), s = seed.ensure(hidden.id); s.phase = "working"; seed.save(s); seed.setProcessing(s, false); f.tasks.archive(hidden.id); archived.push(hidden.id);
    seed.close();
    TaskModeStore.prototype.all = () => { throw new Error("full history read forbidden"); };
    (TaskModeService.prototype as any).advance = async (id: string) => { advanced.add(id); };
    const manager = new EventEmitter() as any; manager.pendingApprovals = () => [];
    const usage = new EventEmitter() as any; usage.refreshTask = async (id: string) => { refreshed.push(id); }; usage.summary = () => ({ persisted: true });
    mode = new TaskModeService({ store: f.tasks, manager, usage, codexInfo: {} } as any, { pollMs: 10 });
    const result = mode.list(); assert.equal(result.tasks.length, 4); assert.equal(result.states.length, 5);
    assert.equal(refreshed.length, 4); assert.deepEqual(Object.values(result.usage), Array(4).fill({ persisted: true }));
    const deadline = Date.now() + 1000; while (!advanced.size && Date.now() < deadline) await new Promise(r => setTimeout(r,10));
    assert.deepEqual([...advanced], candidate); assert.equal(advanced.has(archived[0]), false);
  } finally { mode?.close(); TaskModeStore.prototype.all = originalAll; (TaskModeService.prototype as any).advance = originalAdvance; f.close(); }
});

test("an externally archived active task is selected once to close its authoritative clock", async () => {
  const f = fixture(); const seed = new TaskModeStore(f.tasks.dbPath); let mode: TaskModeService | undefined;
  try {
    const task = f.tasks.create({ title: "Archive clock cleanup" }), s = seed.ensure(task.id); s.phase = "working"; seed.save(s);
    f.tasks.archive(task.id); assert.deepEqual(seed.scheduledTaskIds(), [task.id]); seed.close();
    const manager = new EventEmitter() as any; manager.pendingApprovals = () => [];
    const usage = new EventEmitter() as any; usage.refreshTask = async () => {}; usage.summary = () => ({});
    mode = new TaskModeService({ store: f.tasks, manager, usage, codexInfo: {} } as any, { pollMs: 10 });
    const deadline = Date.now() + 1000; while (mode.data.summaries()[0].processingStartedAt && Date.now() < deadline) await new Promise(r => setTimeout(r,10));
    assert.equal(mode.data.summaries()[0].processingStartedAt, null);
    assert.deepEqual(mode.data.scheduledTaskIds(), []); f.tasks.restore(task.id); assert.deepEqual(mode.data.scheduledTaskIds(), [task.id]);
  } finally { mode?.close(); f.close(); }
});

test("concurrent legacy WAL writer cannot cause missing summaries or mixed generations", async () => {
  const f = fixture(), mode = new TaskModeStore(f.tasks.dbPath); let writer: Worker | undefined;
  try {
    f.db.exec("PRAGMA journal_mode=WAL;");
    for (const title of ["a", "b"]) mode.ensure(f.tasks.create({ title }).id);
    writer = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(workerData);
      db.exec('PRAGMA busy_timeout=5000;');let generation=0;
      const update=db.prepare("UPDATE task_mode_state SET data=json_set(data,'$.heartbeat.message',?)");
      const timer=setInterval(()=>{db.exec('BEGIN IMMEDIATE');update.run(String(++generation));db.exec('COMMIT');parentPort.postMessage(generation);},20);
      parentPort.on('message',()=>{clearInterval(timer);db.close();parentPort.close();});
    `, { eval: true, workerData: f.tasks.dbPath });
    await new Promise<void>((resolve, reject) => { writer!.once("message", () => resolve()); writer!.once("error", reject); });
    const generations = new Set<string | undefined>();
    for (let i = 0; i < 30; i++) {
      const summaries = mode.summaries(); assert.equal(summaries.length, 2);
      assert.equal(summaries[0].heartbeat.message, summaries[1].heartbeat.message);
      generations.add(summaries[0].heartbeat.message);
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(generations.size > 1, "writer must commit during the reader campaign");
  } finally {
    if (writer) { const exit = new Promise(resolve => writer!.once("exit", resolve)); writer.postMessage("stop"); await exit; }
    mode.close(); f.close();
  }
});
