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

test("processing uses one union interval across phases, pause, resume, refresh and completion", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-processing-"));
  const tasks = new TaskStore(directory), task = tasks.create({ title: "Clock" });
  let now = 1_000, store = new TaskModeStore(tasks.dbPath, { nowMs: () => now });
  try {
    let state = store.ensure(task.id);
    assert.equal(state.processedDurationMs, 0); assert.equal(state.processingStartedAt, null);
    state.phase = "planning"; store.save(state); const startedAt = state.processingStartedAt;
    now = 2_000; state.phase = "working"; store.save(state);
    now = 3_000; state.phase = "reviewing"; store.save(state);
    assert.equal(state.processingStartedAt, startedAt); assert.equal(state.processedDurationMs, 0);
    now = 4_000; state.phase = "paused"; store.save(state);
    assert.equal(state.processedDurationMs, 3_000); assert.equal(state.processingStartedAt, null);
    // Read/reopen does not manufacture an interval or forget a paused total.
    now = 100_000; store.close(); store = new TaskModeStore(tasks.dbPath, { nowMs: () => now }); state = store.get(task.id)!;
    assert.equal(state.processedDurationMs, 3_000); assert.equal(state.processingStartedAt, null);
    state.phase = "working"; store.save(state);
    now = 102_000; state.phase = "blocked"; store.save(state);
    assert.equal(state.processedDurationMs, 5_000);
    now = 200_000; state.phase = "reviewing"; store.save(state);
    now = 201_000; state.phase = "needs_confirmation"; store.save(state);
    assert.equal(state.processedDurationMs, 6_000); assert.equal(state.processingStartedAt, null);
    now = 999_000; state.phase = "completed"; store.save(state);
    assert.equal(state.processedDurationMs, 6_000); assert.equal(state.processingStartedAt, null);
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
    now = 15_000; concurrent.phase = "paused"; concurrent.processedDurationMs = 999_999; b.save(concurrent);
    assert.equal(b.get(task.id)!.processedDurationMs, 2_000);
  } finally { a.close(); b.close(); tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("uninstrumented historical states remain unknown rather than guessing from createdAt", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-processing-legacy-"));
  const tasks = new TaskStore(directory), task = tasks.create({ title: "Legacy" });
  const store = new TaskModeStore(tasks.dbPath);
  try {
    const state = store.ensure(task.id);
    const db = new DatabaseSync(tasks.dbPath);
    db.prepare("DELETE FROM task_mode_processing WHERE task_id=?").run(task.id); db.close();
    state.phase = "working"; store.save(state);
    assert.equal(store.get(task.id)!.processedDurationMs, null);
    state.phase = "completed"; store.save(state);
    assert.equal(store.get(task.id)!.processedDurationMs, null); assert.equal(state.processingStartedAt, null);
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
    assert.equal(summary.processedDurationMs, state.processedDurationMs); assert.equal(summary.processingStartedAt, state.processingStartedAt);
  } finally { mode.close(); tasks.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("abrupt process exit marks an unclosed interval unknown instead of counting downtime", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "task-processing-crash-"));
  const script = `
    const {TaskStore}=await import(${JSON.stringify(new URL("./tasks/taskStore.ts", import.meta.url).href)});
    const {TaskModeStore}=await import(${JSON.stringify(new URL("./tasks/taskModeStore.ts", import.meta.url).href)});
    const tasks=new TaskStore(process.argv[1]);const task=tasks.create({title:'Crash clock'});
    let now=5000;const mode=new TaskModeStore(tasks.dbPath,{nowMs:()=>now});
    const state=mode.ensure(task.id);state.phase='working';mode.save(state);
    now=15000;state.phase='paused';mode.save(state);
    now=20000;state.phase='working';mode.save(state);
    console.log(JSON.stringify({taskId:task.id,closed:state.processedDurationMs,started:state.processingStartedAt}));
    process.exit(17);`;
  let reopened: TaskModeStore | undefined;
  try {
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, directory], { encoding: "utf8", timeout: 15_000 });
    assert.equal(child.status, 17, child.stderr);
    const checkpoint = JSON.parse(child.stdout.trim()); assert.equal(checkpoint.closed, 10_000); assert.ok(checkpoint.started);
    reopened = new TaskModeStore(path.join(directory, "task-monitor.sqlite"), { nowMs: () => 3_620_000, recoverOrphanedProcessing: true });
    const state = reopened.get(checkpoint.taskId)!;
    assert.equal(state.processedDurationMs, null); assert.equal(state.processingStartedAt, null);
    state.phase = "working"; reopened.save(state);
    assert.equal(state.processedDurationMs, null); assert.equal(state.processingStartedAt, new Date(3_620_000).toISOString());
    state.phase = "paused"; reopened.save(state);
    assert.equal(state.processedDurationMs, null); assert.equal(state.processingStartedAt, null);
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
    assert.equal(state.processedDurationMs, 10_000); assert.equal(state.processingStartedAt, null);
  } finally { reopened?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
