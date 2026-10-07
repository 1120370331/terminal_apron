import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { TaskStore } from "./tasks/taskStore.js";
import { TaskModeStore } from "./tasks/taskModeStore.js";
import { TaskModeService } from "./tasks/taskModeService.js";
import type { TaskExecutionJob, TaskExecutionRun } from "../shared/taskModeTypes.js";

test("cached summaries join verified timing, preserve legacy-safe totals, and retain cross-writer triggers", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-processing-summary-merge-"));
  const tasks = new TaskStore(directory), task = tasks.create({ title: "Merged summary authority" });
  let now = 10_000; const store = new TaskModeStore(tasks.dbPath, { nowMs: () => now });
  const db = new DatabaseSync(tasks.dbPath);
  try {
    const state = store.ensure(task.id); state.phase = "paused"; store.save(state);
    db.prepare("UPDATE task_mode_processing_verified SET total_ms=5000,coverage='partial',recovered_ms=5000 WHERE task_id=?").run(task.id);
    const originalParse = JSON.parse; let historyReads = 0;
    JSON.parse = ((value: string, reviver?: Parameters<typeof JSON.parse>[1]) => { if (value.includes('"runs":')) historyReads++; return originalParse(value, reviver); }) as typeof JSON.parse;
    try {
      for (let i = 0; i < 3; i++) {
        const summary = store.summaries()[0]; assert.equal(summary.processedDurationMs, null);
        assert.equal(summary.processedVerifiedDurationMs, 5000); assert.equal(summary.processedTimingCoverage, "partial");
      }
      assert.equal(historyReads, 0);
      const legacy = { ...state, heartbeat: { ...state.heartbeat, message: "Updated by another writer" } };
      db.prepare("UPDATE task_mode_state SET data=? WHERE task_id=?").run(JSON.stringify(legacy), task.id);
      assert.equal(store.summaries()[0].heartbeat.message, "Updated by another writer");
      assert.equal(historyReads, 1); store.summaries(); assert.equal(historyReads, 1);
    } finally { JSON.parse = originalParse; }
    const running = store.get(task.id)!; running.phase = "working"; store.save(running);
    assert.deepEqual(store.scheduledTaskIds(), [task.id]); now += 2000; store.stopProcessing();
    assert.equal(store.summaries()[0].processedVerifiedDurationMs, 7000);
    assert.equal(store.summaries()[0].processedDurationMs, null);
    const before = JSON.stringify([db.prepare("SELECT * FROM task_mode_state").all(), db.prepare("SELECT * FROM task_mode_processing_verified").all(), db.prepare("SELECT * FROM task_mode_processing").all(), db.prepare("SELECT * FROM task_mode_summary").all()]);
    db.exec("CREATE TRIGGER reject_merged_summary BEFORE INSERT ON task_mode_summary BEGIN SELECT RAISE(ABORT,'merged projection failed'); END;");
    running.phase = "paused"; assert.throws(() => store.save(running), /merged projection failed/);
    const after = JSON.stringify([db.prepare("SELECT * FROM task_mode_state").all(), db.prepare("SELECT * FROM task_mode_processing_verified").all(), db.prepare("SELECT * FROM task_mode_processing").all(), db.prepare("SELECT * FROM task_mode_summary").all()]);
    assert.equal(after, before);
  } finally { db.close(); store.close(); tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("canonical partial time survives old projection writes and remains hidden from legacy clients", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-processing-rollback-"));
  const tasks = new TaskStore(directory), task = tasks.create({ title: "Rollback preserves evidence" });
  let now = 10_000; const store = new TaskModeStore(tasks.dbPath, { nowMs: () => now });
  try {
    const state = store.ensure(task.id); state.phase = "working"; store.save(state);
    const db = new DatabaseSync(tasks.dbPath);
    db.prepare("UPDATE task_mode_processing_verified SET total_ms=5000,coverage='partial',recovered_ms=5000 WHERE task_id=?").run(task.id);
    now += 2000; state.phase = "paused"; store.save(state);
    assert.equal(state.processedVerifiedDurationMs, 7000); assert.equal(state.processedDurationMs, null);
    assert.equal((db.prepare("SELECT total_ms FROM task_mode_processing WHERE task_id=?").get(task.id) as any).total_ms, null);
    // A legacy runtime may update only its old projection. It must not erase verified data.
    db.prepare("UPDATE task_mode_processing SET total_ms=NULL,started_at=NULL,runtime_id='old-runtime' WHERE task_id=?").run(task.id);
    assert.equal(store.get(task.id)!.processedVerifiedDurationMs, 7000);
    state.phase = "working"; store.save(state); now += 3000; state.phase = "paused"; store.save(state);
    assert.equal(state.processedVerifiedDurationMs, 10000); assert.equal(state.processedDurationMs, null);
    const unrelated = tasks.create({ title: "Business data created after migration" });
    assert.equal(tasks.get(unrelated.id)!.title, unrelated.title);
    db.close();
  } finally { store.close(); tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("previous d84 partial totals migrate once into canonical storage without dropping accrued time", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-processing-d84-upgrade-"));
  const tasks = new TaskStore(directory), task = tasks.create({ title: "d84 persisted lower bound" });
  let store = new TaskModeStore(tasks.dbPath);
  try {
    store.ensure(task.id); const db = new DatabaseSync(tasks.dbPath);
    db.prepare("DELETE FROM task_mode_processing_verified WHERE task_id=?").run(task.id);
    db.prepare("UPDATE task_mode_processing SET total_ms=576512,coverage='partial',recovered_ms=569138,tracked_since='2026-10-07T17:00:00Z' WHERE task_id=?").run(task.id); db.close();
    assert.equal(store.get(task.id)!.processedVerifiedDurationMs, 576512);
    assert.equal(store.get(task.id)!.processedDurationMs, null);
    store.close(); store = new TaskModeStore(tasks.dbPath);
    assert.equal(store.get(task.id)!.processedVerifiedDurationMs, 576512);
    assert.equal(store.get(task.id)!.processedRecoveredDurationMs, 569138);
  } finally { store.close(); tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("legacy recovery uses a conservative union lower bound once, then counts disjoint future intervals", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-processing-recovery-"));
  const tasks = new TaskStore(directory), task = tasks.create({ title: "Parallel historical commands" });
  let now = 10_000, store = new TaskModeStore(tasks.dbPath, { nowMs: () => now });
  try {
    const state = store.ensure(task.id);
    state.runs.push({ id: "old", instructionIds: [], createdAt: new Date(0).toISOString(), settings: state.settings, reviewAttempt: 0,
      jobs: [8_000, 5_000].map((durationMs, i) => ({ id: `job-${i}`, role: "worker", name: "parallel", objective: "", ownedPaths: [], status: "completed", attempt: 0, text: "", model: "", items: [
        { kind: "command", id: `command-${i}`, command: "work", cwd: directory, status: "completed", durationMs },
        { kind: "command", id: `running-${i}`, command: "unfinished", cwd: directory, status: "inProgress", durationMs: 999_000 }
      ] })) });
    store.save(state);
    const db = new DatabaseSync(tasks.dbPath); db.prepare("DELETE FROM task_mode_processing WHERE task_id=?").run(task.id); db.prepare("DELETE FROM task_mode_processing_verified WHERE task_id=?").run(task.id); db.close();
    let recovered = store.get(task.id)!;
    assert.equal(recovered.processedVerifiedDurationMs, 8_000); // Never sum overlapping/undated commands.
    assert.equal(recovered.processedTimingCoverage, "partial");
    assert.equal(recovered.processedRecoveredDurationMs, 8_000);
    recovered.phase = "working"; store.save(recovered);
    now += 3_000; recovered.phase = "needs_confirmation"; store.save(recovered);
    assert.equal(recovered.processedVerifiedDurationMs, 11_000);
    now += 50_000; store.close(); store = new TaskModeStore(tasks.dbPath, { nowMs: () => now }); recovered = store.get(task.id)!;
    assert.equal(recovered.processedVerifiedDurationMs, 11_000); assert.equal(recovered.processingStartedAt, null);
    assert.equal(recovered.processedRecoveredDurationMs, 8_000);
    // Repeated saves/reads cannot re-import evidence or trust a forged caller total.
    recovered.processedVerifiedDurationMs = 1_000_000; store.save(recovered);
    assert.equal(store.get(task.id)!.processedVerifiedDurationMs, 11_000);
  } finally { store.close(); tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("migration preserves already valid totals and handles a null live clock without double recovery", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-processing-migration-"));
  const tasks = new TaskStore(directory), task = tasks.create({ title: "Old live clock" });
  let now = 10_000; const store = new TaskModeStore(tasks.dbPath, { nowMs: () => now });
  try {
    const state = store.ensure(task.id); state.phase = "working"; store.save(state);
    const db = new DatabaseSync(tasks.dbPath);
    db.prepare("UPDATE task_mode_processing SET total_ms=NULL,coverage=NULL,recovered_ms=NULL WHERE task_id=?").run(task.id); db.prepare("DELETE FROM task_mode_processing_verified WHERE task_id=?").run(task.id); db.close();
    now = 12_000; state.phase = "paused"; store.save(state);
    assert.equal(state.processedVerifiedDurationMs, 2_000); assert.equal(state.processedTimingCoverage, "partial");
    const valid = tasks.create({ title: "Already displaying 51s" });
    const known = store.ensure(valid.id); known.phase = "working"; store.save(known);
    now += 51_680; known.phase = "paused"; store.save(known);
    assert.equal(store.get(valid.id)!.processedVerifiedDurationMs, 51_680);
    assert.equal(store.get(valid.id)!.processedTimingCoverage, "complete");
  } finally { store.close(); tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("processing uses one union interval across phases, pause, resume, refresh and completion", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-processing-"));
  const tasks = new TaskStore(directory), task = tasks.create({ title: "Clock" });
  let now = 1_000, store = new TaskModeStore(tasks.dbPath, { nowMs: () => now });
  try {
    let state = store.ensure(task.id);
    assert.equal(state.processedVerifiedDurationMs, 0); assert.equal(state.processingStartedAt, null);
    state.phase = "planning"; store.save(state); const startedAt = state.processingStartedAt;
    now = 2_000; state.phase = "working"; store.save(state);
    now = 3_000; state.phase = "reviewing"; store.save(state);
    assert.equal(state.processingStartedAt, startedAt); assert.equal(state.processedVerifiedDurationMs, 0);
    now = 4_000; state.phase = "paused"; store.save(state);
    assert.equal(state.processedVerifiedDurationMs, 3_000); assert.equal(state.processingStartedAt, null);
    // Read/reopen does not manufacture an interval or forget a paused total.
    now = 100_000; store.close(); store = new TaskModeStore(tasks.dbPath, { nowMs: () => now }); state = store.get(task.id)!;
    assert.equal(state.processedVerifiedDurationMs, 3_000); assert.equal(state.processingStartedAt, null);
    state.phase = "working"; store.save(state);
    now = 102_000; state.phase = "blocked"; store.save(state);
    assert.equal(state.processedVerifiedDurationMs, 5_000);
    now = 200_000; state.phase = "reviewing"; store.save(state);
    now = 201_000; state.phase = "needs_confirmation"; store.save(state);
    assert.equal(state.processedVerifiedDurationMs, 6_000); assert.equal(state.processingStartedAt, null);
    now = 999_000; state.phase = "completed"; store.save(state);
    assert.equal(state.processedVerifiedDurationMs, 6_000); assert.equal(state.processingStartedAt, null);
  } finally { store.close(); tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("parallel stores cannot double-close an interval or trust forged client totals", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-processing-overlap-"));
  const tasks = new TaskStore(directory), task = tasks.create({ title: "Overlap" });
  let now = 10_000;
  const a = new TaskModeStore(tasks.dbPath, { nowMs: () => now }), b = new TaskModeStore(tasks.dbPath, { nowMs: () => now });
  try {
    const first = a.ensure(task.id); first.phase = "working"; a.save(first);
    const concurrent = b.get(task.id)!;
    now = 11_000; b.save(concurrent); assert.equal(concurrent.processingStartedAt, first.processingStartedAt);
    now = 12_000; first.phase = "paused"; a.save(first);
    now = 15_000; concurrent.phase = "paused"; concurrent.processedVerifiedDurationMs = 999_999; b.save(concurrent);
    assert.equal(b.get(task.id)!.processedVerifiedDurationMs, 2_000);
  } finally { a.close(); b.close(); tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("missing history remains partial and subsequent real intervals accumulate across pause and refresh", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-processing-legacy-"));
  const tasks = new TaskStore(directory), task = tasks.create({ title: "Legacy" });
  let now = 10_000;
  const store = new TaskModeStore(tasks.dbPath, { nowMs: () => now });
  try {
    const state = store.ensure(task.id);
    const db = new DatabaseSync(tasks.dbPath);
    db.prepare("DELETE FROM task_mode_processing WHERE task_id=?").run(task.id); db.prepare("DELETE FROM task_mode_processing_verified WHERE task_id=?").run(task.id); db.close();
    state.phase = "working"; store.save(state);
    assert.equal(store.get(task.id)!.processedVerifiedDurationMs, null);
    assert.equal(state.processedTimingCoverage, "partial");
    now = 13_000;
    state.phase = "completed"; store.save(state);
    assert.equal(store.get(task.id)!.processedVerifiedDurationMs, 3_000); assert.equal(state.processingStartedAt, null);
    now = 100_000; state.phase = "working"; store.save(state);
    now = 102_000; state.phase = "paused"; store.save(state);
    assert.equal(store.get(task.id)!.processedVerifiedDurationMs, 5_000);
    assert.equal(store.get(task.id)!.processedTimingCoverage, "partial");
    assert.equal(store.get(task.id)!.processedTimingSince, new Date(10_000).toISOString());
  } finally { store.close(); tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("service excludes all-human-approval wait but counts other workers still processing", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-processing-approval-"));
  const tasks = new TaskStore(directory), task = tasks.create({ title: "Parallel approval" });
  const manager = new EventEmitter() as any; let waiting = new Set<string>();
  manager.pendingApprovals = (_taskId: string, threadId: string) => waiting.has(threadId) ? [{ turnId: `turn-${threadId}` }] : [];
  const usage = new EventEmitter() as any; usage.refreshTask = async () => {}; usage.summary = () => ({});
  const mode = new TaskModeService({ store: tasks, manager, usage, codexInfo: {} } as any, { pollMs: 3_600_000 });
  try {
    const state = mode.data.ensure(task.id);
    const jobs: TaskExecutionJob[] = ["a", "b"].map(threadId => ({ id: threadId, role: "worker", name: threadId, objective: "Work", ownedPaths: [], threadId, turnId: `turn-${threadId}`, status: "active", attempt: 0, text: "", model: "", items: [] }));
    const run: TaskExecutionRun = { id: "run", instructionIds: [], createdAt: new Date().toISOString(), settings: state.settings, jobs, reviewAttempt: 0 };
    state.runs.push(run); state.activeRunId = run.id; state.phase = "working"; mode.data.save(state);
    const start = state.processingStartedAt; assert.ok(start);
    waiting = new Set(["a"]); mode.data.save(state); assert.equal(state.processingStartedAt, start);
    waiting.add("b"); mode.data.save(state); assert.equal(state.processingStartedAt, null);
    waiting.delete("b"); mode.data.save(state); assert.ok(state.processingStartedAt);
    state.heartbeat.nextRetryAt = new Date(Date.now() + 60_000).toISOString(); mode.data.save(state); assert.equal(state.processingStartedAt, null);
    state.heartbeat.nextRetryAt = undefined; mode.data.save(state); assert.ok(state.processingStartedAt);
    const summary = mode.list().states.find(entry => entry.taskId === task.id)!;
    assert.equal(summary.processedVerifiedDurationMs, state.processedVerifiedDurationMs); assert.equal(summary.processingStartedAt, state.processingStartedAt);
  } finally { mode.close(); tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("abrupt process exit preserves verified closed time, marks history partial and excludes downtime", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-processing-crash-"));
  const script = `
    const {TaskStore}=await import(${JSON.stringify(new URL("./tasks/taskStore.ts", import.meta.url).href)});
    const {TaskModeStore}=await import(${JSON.stringify(new URL("./tasks/taskModeStore.ts", import.meta.url).href)});
    const tasks=new TaskStore(process.argv[1]);const task=tasks.create({title:'Crash clock'});
    let now=5000;const mode=new TaskModeStore(tasks.dbPath,{nowMs:()=>now});
    const state=mode.ensure(task.id);state.phase='working';mode.save(state);
    now=15000;state.phase='paused';mode.save(state);
    now=20000;state.phase='working';mode.save(state);
    console.log(JSON.stringify({taskId:task.id,closed:state.processedVerifiedDurationMs,started:state.processingStartedAt}));
    process.exit(17);`;
  let reopened: TaskModeStore | undefined;
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, directory], { encoding: "utf8", timeout: 15_000 });
    assert.equal(child.status, 17, child.stderr);
    const checkpoint = JSON.parse(child.stdout.trim()); assert.equal(checkpoint.closed, 10_000); assert.ok(checkpoint.started);
    let now = 3_620_000;
    reopened = new TaskModeStore(path.join(directory, "task-monitor.sqlite"), { nowMs: () => now, recoverOrphanedProcessing: true });
    const state = reopened.get(checkpoint.taskId)!;
    assert.equal(state.processedVerifiedDurationMs, 10_000); assert.equal(state.processingStartedAt, null);
    assert.equal(state.processedTimingCoverage, "partial");
    state.phase = "working"; reopened.save(state);
    assert.equal(state.processedVerifiedDurationMs, 10_000); assert.equal(state.processingStartedAt, new Date(3_620_000).toISOString());
    now += 2_000;
    state.phase = "paused"; reopened.save(state);
    assert.equal(state.processedVerifiedDurationMs, 12_000); assert.equal(state.processingStartedAt, null);
  } finally { reopened?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("normal process closure preserves its exact completed total across a later process", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-processing-clean-exit-"));
  const script = `
    const {TaskStore}=await import(${JSON.stringify(new URL("./tasks/taskStore.ts", import.meta.url).href)});
    const {TaskModeStore}=await import(${JSON.stringify(new URL("./tasks/taskModeStore.ts", import.meta.url).href)});
    const tasks=new TaskStore(process.argv[1]);const task=tasks.create({title:'Clean clock'});
    let now=5000;const mode=new TaskModeStore(tasks.dbPath,{nowMs:()=>now});
    const state=mode.ensure(task.id);state.phase='working';mode.save(state);
    now=15000;mode.stopProcessing();mode.close();tasks.close();console.log(task.id);`;
  let reopened: TaskModeStore | undefined;
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, directory], { encoding: "utf8", timeout: 15_000 });
    assert.equal(child.status, 0, child.stderr);
    reopened = new TaskModeStore(path.join(directory, "task-monitor.sqlite"), { nowMs: () => 3_620_000, recoverOrphanedProcessing: true });
    const state = reopened.get(child.stdout.trim())!;
    assert.equal(state.processedVerifiedDurationMs, 10_000); assert.equal(state.processingStartedAt, null);
  } finally { reopened?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
