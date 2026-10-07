import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { DEFAULT_TASK_MODE_SETTINGS, DEFAULT_TASK_MODE_VIEW, type TaskModeDocument, type TaskModeSettings, type TaskModeState, type TaskModeViewPreferences } from "../../shared/taskModeTypes.js";

// One epoch per Node process. Readers in the same process must not reset a live clock.
const PROCESSING_RUNTIME_ID = randomUUID();

/** Additive tables in the user's existing task database. No demo data or task migration. */
export class TaskModeStore {
  private readonly db: DatabaseSync;
  constructor(dbPath: string, private readonly processingOptions: { nowMs?: () => number; isProcessing?: (state: TaskModeState) => boolean; recoverOrphanedProcessing?: boolean } = {}) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS task_mode_state (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_mode_preferences (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_mode_documents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_mode_processing (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, total_ms INTEGER, started_at TEXT, runtime_id TEXT);`);
    const columns = this.db.prepare("PRAGMA table_info(task_mode_processing)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "runtime_id")) this.db.exec("ALTER TABLE task_mode_processing ADD COLUMN runtime_id TEXT");
    if (processingOptions.recoverOrphanedProcessing) {
      // Only the owning scheduler opts in, after acquiring the existing conversation runtime lease.
      // An open interval from another epoch has no authoritative end. Do not count downtime.
      this.db.prepare("UPDATE task_mode_processing SET total_ms=NULL,started_at=NULL,runtime_id=? WHERE started_at IS NOT NULL AND (runtime_id IS NULL OR runtime_id<>?)").run(PROCESSING_RUNTIME_ID, PROCESSING_RUNTIME_ID);
    }
  }
  close() { this.db.close(); }
  get(taskId: string): TaskModeState | null {
    const row = this.db.prepare("SELECT data FROM task_mode_state WHERE task_id=?").get(taskId) as { data: string } | undefined;
    return row ? this.withProcessing(this.hydrate(JSON.parse(row.data) as TaskModeState)) : null;
  }
  all(): TaskModeState[] { return (this.db.prepare("SELECT data FROM task_mode_state").all() as unknown as Array<{ data: string }>).map(row => this.withProcessing(this.hydrate(JSON.parse(row.data) as TaskModeState))); }
  ensure(taskId: string): TaskModeState {
    const existing = this.get(taskId); if (existing) return existing;
    const state: TaskModeState = { taskId, phase: "idle", settings: this.settings(), instructions: [], runs: [], events: [], heartbeat: { status: "idle", recoveryAttempts: 0 }, revision: 0, updatedAt: new Date().toISOString() };
    this.save(state); return state;
  }
  save(state: TaskModeState): void {
    this.hydrate(state);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.updateProcessingInside(state, this.processingOptions.isProcessing?.(state) ?? (["planning", "working", "reviewing"].includes(state.phase) && !state.heartbeat.nextRetryAt));
      state.revision += 1; state.updatedAt = new Date().toISOString();
      this.db.prepare("INSERT INTO task_mode_state(task_id,data) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data").run(state.taskId, JSON.stringify(state));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Approval events can close/open the clock immediately without overwriting workflow state. */
  setProcessing(state: TaskModeState, counting: boolean): void {
    this.db.exec("BEGIN IMMEDIATE");
    try { this.updateProcessingInside(state, counting); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  stopProcessing(): void { for (const state of this.all()) this.setProcessing(state, false); }
  private withProcessing(state: TaskModeState): TaskModeState {
    const timing = this.db.prepare("SELECT total_ms,started_at FROM task_mode_processing WHERE task_id=?").get(state.taskId) as { total_ms: number | null; started_at: string | null } | undefined;
    state.processedDurationMs = timing?.total_ms ?? null;
    state.processingStartedAt = timing?.started_at ?? null;
    return state;
  }
  private updateProcessingInside(state: TaskModeState, counting: boolean): void {
    const prior = this.db.prepare("SELECT total_ms,started_at,runtime_id FROM task_mode_processing WHERE task_id=?").get(state.taskId) as { total_ms: number | null; started_at: string | null; runtime_id: string | null } | undefined;
    // Existing uninstrumented records lack pause/wait boundaries. Never fabricate their total.
    const historical = this.db.prepare("SELECT 1 FROM task_mode_state WHERE task_id=?").get(state.taskId);
    let total = prior ? prior.total_ms : historical ? null : 0;
    let startedAt = prior?.started_at ?? null;
    if (startedAt && prior?.runtime_id !== PROCESSING_RUNTIME_ID) { total = null; startedAt = null; }
    const current = this.processingOptions.nowMs?.() ?? Date.now();
    if (counting && !startedAt) startedAt = new Date(current).toISOString();
    if (!counting && startedAt) {
      if (total !== null) total += Math.max(0, current - Date.parse(startedAt));
      startedAt = null;
    }
    this.db.prepare("INSERT INTO task_mode_processing(task_id,total_ms,started_at,runtime_id) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET total_ms=excluded.total_ms,started_at=excluded.started_at,runtime_id=excluded.runtime_id").run(state.taskId, total, startedAt, PROCESSING_RUNTIME_ID);
    state.processedDurationMs = total; state.processingStartedAt = startedAt;
  }
  settings(): TaskModeSettings { return { ...DEFAULT_TASK_MODE_SETTINGS, ...this.preference("settings", DEFAULT_TASK_MODE_SETTINGS) }; }
  view(): TaskModeViewPreferences { return this.preference("view", DEFAULT_TASK_MODE_VIEW); }
  saveSettings(value: TaskModeSettings): void { this.savePreference("settings", value); }
  saveView(value: TaskModeViewPreferences): void { this.savePreference("view", value); }
  documents(): TaskModeDocument[] { return (this.db.prepare("SELECT data FROM task_mode_documents ORDER BY rowid DESC").all() as unknown as Array<{ data: string }>).map(row => JSON.parse(row.data)); }
  document(id: string): TaskModeDocument | undefined { const row=this.db.prepare("SELECT data FROM task_mode_documents WHERE id=?").get(id) as {data:string}|undefined;return row?JSON.parse(row.data):undefined; }
  saveDocument(input: { id?: string; title: string; markdown: string; revision?: number }): TaskModeDocument {
    const old=input.id?this.document(input.id):undefined;
    if(input.id&&!old)throw new Error("文档不存在");
    if(old&&input.revision!==old.revision)throw new Error("文档已更新，请重新打开后保存");
    const at=new Date().toISOString();const doc:TaskModeDocument={id:old?.id??randomUUID(),title:input.title,markdown:input.markdown,revision:(old?.revision??0)+1,createdAt:old?.createdAt??at,updatedAt:at};
    this.db.prepare("INSERT INTO task_mode_documents(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(doc.id,JSON.stringify(doc));return doc;
  }
  private preference<T>(key: string, fallback: T): T { const row=this.db.prepare("SELECT data FROM task_mode_preferences WHERE key=?").get(key) as {data:string}|undefined;return row?JSON.parse(row.data):structuredClone(fallback); }
  private savePreference(key: string, value: unknown) { this.db.prepare("INSERT INTO task_mode_preferences(key,data) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(key,JSON.stringify(value)); }
  private hydrate(state: TaskModeState): TaskModeState {
    state.settings = { ...DEFAULT_TASK_MODE_SETTINGS, ...state.settings };
    for (const run of state.runs) run.settings = { ...DEFAULT_TASK_MODE_SETTINGS, ...run.settings };
    state.heartbeat ??= { status: ["planning", "working", "reviewing"].includes(state.phase) ? "recovering" : "idle", recoveryAttempts: 0 };
    return state;
  }
}
