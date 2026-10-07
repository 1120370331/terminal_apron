import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { DEFAULT_TASK_MODE_SETTINGS, DEFAULT_TASK_MODE_VIEW, type TaskModeDocument, type TaskModeList, type TaskModeSettings, type TaskModeState, type TaskModeViewPreferences } from "../../shared/taskModeTypes.js";

// One epoch per Node process. Readers in the same process must not reset a live clock.
const PROCESSING_RUNTIME_ID = randomUUID();

interface ProcessingRow {
  total_ms: number | null; started_at: string | null; runtime_id: string | null;
  coverage: "complete" | "partial" | null; recovered_ms: number | null; tracked_since: string | null;
}

type ListSummary = TaskModeList["states"][number];
type StoredSummary = Pick<ListSummary, "taskId" | "phase" | "settings" | "instructionCount" | "heartbeat" | "updatedAt">;
const activePhases = new Set(["planning", "working", "reviewing"]);
const readyPhases = new Set(["idle", "completed", "needs_confirmation"]);

/** Without item timestamps we cannot sum commands (including parallel/nested calls).
 * The longest finished command is a verified lower bound of their interval union.
 * Approval waits precede command execution; unmeasured turn/run lifetimes are never used.
 */
function historicalLowerBound(state: TaskModeState): number {
  let longest = 0;
  for (const run of state.runs) for (const job of run.jobs) for (const item of job.items) {
    if (item.kind === "command" && item.status === "completed"
      && Number.isFinite(item.durationMs) && item.durationMs! > longest) longest = item.durationMs!;
  }
  return longest;
}

/** Additive tables in the user's existing task database. No demo data or task migration. */
export class TaskModeStore {
  private readonly db: DatabaseSync;
  constructor(dbPath: string, private readonly processingOptions: { nowMs?: () => number; isProcessing?: (state: TaskModeState) => boolean; recoverOrphanedProcessing?: boolean } = {}) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS task_mode_state (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_mode_preferences (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_mode_documents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS task_mode_processing (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, total_ms INTEGER, started_at TEXT, runtime_id TEXT);
      CREATE TABLE IF NOT EXISTS task_mode_processing_verified (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        total_ms INTEGER, started_at TEXT, runtime_id TEXT, coverage TEXT, recovered_ms INTEGER, tracked_since TEXT);`);
    const columns = this.db.prepare("PRAGMA table_info(task_mode_processing)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "runtime_id")) this.db.exec("ALTER TABLE task_mode_processing ADD COLUMN runtime_id TEXT");
    for (const [name, type] of [["coverage", "TEXT"], ["recovered_ms", "INTEGER"], ["tracked_since", "TEXT"]]) {
      if (!columns.some(column => column.name === name)) this.db.exec(`ALTER TABLE task_mode_processing ADD COLUMN ${name} ${type}`);
    }
    // Old writers also invalidate the projection. It is rebuilt only for changed
    // rows, under the same write lock as history/timing, never from a stale read.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_mode_summary (
        task_id TEXT PRIMARY KEY REFERENCES task_mode_state(task_id) ON DELETE CASCADE,
        data TEXT NOT NULL, scheduled INTEGER NOT NULL, startup INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS task_mode_summary_insert AFTER INSERT ON task_mode_state
        BEGIN DELETE FROM task_mode_summary WHERE task_id=NEW.task_id; END;
      CREATE TRIGGER IF NOT EXISTS task_mode_summary_update AFTER UPDATE ON task_mode_state
        BEGIN DELETE FROM task_mode_summary WHERE task_id=OLD.task_id OR task_id=NEW.task_id; END;
      CREATE TRIGGER IF NOT EXISTS task_mode_summary_delete AFTER DELETE ON task_mode_state
        BEGIN DELETE FROM task_mode_summary WHERE task_id=OLD.task_id; END;`);
    if (processingOptions.recoverOrphanedProcessing) {
      // Only the owning scheduler opts in, after acquiring the existing conversation runtime lease.
      // An open interval from another epoch has no authoritative end. Do not count downtime.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("UPDATE task_mode_processing_verified SET coverage='partial',started_at=NULL,runtime_id=? WHERE started_at IS NOT NULL AND (runtime_id IS NULL OR runtime_id<>?)").run(PROCESSING_RUNTIME_ID, PROCESSING_RUNTIME_ID);
        // Import pre-migration evidence before quarantining partial totals for old clients.
        this.db.prepare("UPDATE task_mode_processing SET coverage='partial',started_at=NULL,runtime_id=? WHERE started_at IS NOT NULL AND (runtime_id IS NULL OR runtime_id<>?)").run(PROCESSING_RUNTIME_ID, PROCESSING_RUNTIME_ID);
        this.db.prepare("UPDATE task_mode_processing SET total_ms=NULL WHERE task_id IN (SELECT task_id FROM task_mode_processing_verified WHERE coverage='partial')").run();
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
  }
  close() { this.db.close(); }
  get(taskId: string): TaskModeState | null {
    const row = this.db.prepare("SELECT data FROM task_mode_state WHERE task_id=?").get(taskId) as { data: string } | undefined;
    return row ? this.withProcessing(this.hydrate(JSON.parse(row.data) as TaskModeState)) : null;
  }
  all(): TaskModeState[] { return (this.db.prepare("SELECT data FROM task_mode_state").all() as unknown as Array<{ data: string }>).map(row => this.withProcessing(this.hydrate(JSON.parse(row.data) as TaskModeState))); }
  /** Same public list fields; live timing is always joined from its authority. */
  summaries(): ListSummary[] {
    return this.readProjection(() => {
      const rows = this.db.prepare(`SELECT summary.data, processing.* FROM task_mode_summary summary
        JOIN task_mode_state state ON state.task_id=summary.task_id
        JOIN task_mode_processing_verified processing ON processing.task_id=summary.task_id ORDER BY state.rowid`).all() as unknown as Array<ProcessingRow & { data: string }>;
      return rows.map(row => {
        const summary = JSON.parse(row.data) as StoredSummary;
        return { ...summary, settings: { ...DEFAULT_TASK_MODE_SETTINGS, ...summary.settings },
          processedDurationMs: row.coverage === "complete" ? row.total_ms : null,
          processedVerifiedDurationMs: row.total_ms, processingStartedAt: row.started_at,
          processedTimingCoverage: row.coverage ?? "partial", processedTimingSince: row.tracked_since,
          processedRecoveredDurationMs: row.recovered_ms ?? 0 };
      });
    });
  }
  taskIds(): string[] { return (this.db.prepare("SELECT task_id FROM task_mode_state ORDER BY rowid").all() as Array<{ task_id: string }>).map(row => row.task_id); }
  scheduledTaskIds(): string[] { return this.candidateIds(false); }
  /** Blocked rows retain the existing one-time legacy/output recovery checks. */
  startupTaskIds(): string[] { return this.candidateIds(true); }
  private candidateIds(startup: boolean): string[] {
    return this.readProjection(() => (this.db.prepare(`SELECT summary.task_id FROM task_mode_summary summary
      JOIN task_mode_state state ON state.task_id=summary.task_id
      JOIN tasks task ON task.id=summary.task_id
      JOIN task_mode_processing_verified processing ON processing.task_id=summary.task_id
      WHERE (summary.scheduled=1 AND (task.archived_at IS NULL OR processing.started_at IS NOT NULL))${startup ? " OR (summary.startup=1 AND task.archived_at IS NULL)" : ""}
      ORDER BY state.rowid`).all() as Array<{ task_id: string }>).map(row => row.task_id));
  }
  private writeSummary(state: TaskModeState): void {
    const summary: StoredSummary = { taskId: state.taskId, phase: state.phase, settings: state.settings,
      instructionCount: state.instructions.filter(entry => !entry.deletedAt).length, heartbeat: state.heartbeat, updatedAt: state.updatedAt };
    const queued = state.instructions.some(entry => entry.status === "queued" && !entry.archivedAt && !entry.deletedAt);
    const scheduled = activePhases.has(state.phase) || readyPhases.has(state.phase) && queued;
    this.db.prepare("INSERT INTO task_mode_summary(task_id,data,scheduled,startup) VALUES(?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data,scheduled=excluded.scheduled,startup=excluded.startup")
      .run(state.taskId, JSON.stringify(summary), Number(scheduled), Number(state.phase === "blocked"));
  }
  private missingSummaryIds(): Array<{ task_id: string }> {
    return this.db.prepare(`SELECT state.task_id FROM task_mode_state state
      LEFT JOIN task_mode_summary summary ON summary.task_id=state.task_id
      LEFT JOIN task_mode_processing_verified processing ON processing.task_id=state.task_id
      WHERE summary.task_id IS NULL OR processing.coverage IS NULL OR processing.recovered_ms IS NULL ORDER BY state.rowid`).all() as Array<{ task_id: string }>;
  }
  private readProjection<T>(read: () => T): T {
    // Discovery and result share a snapshot, so an old writer cannot invalidate
    // a row between them and make it disappear from the returned list.
    this.db.exec("BEGIN"); let transaction = true;
    try {
      if (this.missingSummaryIds().length) {
        this.db.exec("ROLLBACK"); transaction = false;
        this.db.exec("BEGIN IMMEDIATE"); transaction = true;
        // Recheck under the write lock; do not upgrade a stale read transaction.
        this.backfillSummaries();
      }
      const result = read(); this.db.exec("COMMIT"); transaction = false; return result;
    } catch (error) { if (transaction) this.db.exec("ROLLBACK"); throw error; }
  }
  /** Only called inside readProjection's write transaction. */
  private backfillSummaries(): void {
    for (const { task_id } of this.missingSummaryIds()) {
      const row = this.db.prepare("SELECT data FROM task_mode_state WHERE task_id=?").get(task_id) as { data: string };
      const state = this.hydrate(JSON.parse(row.data) as TaskModeState);
      this.applyProcessing(state, this.processingRow(state)); this.writeSummary(state);
    }
  }
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
      this.writeSummary(state);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Approval events can close/open the clock immediately without overwriting workflow state. */
  setProcessing(state: TaskModeState, counting: boolean): void {
    this.db.exec("BEGIN IMMEDIATE");
    try { this.updateProcessingInside(state, counting); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  stopProcessing(): void {
    const rows = this.db.prepare("SELECT processing.task_id FROM task_mode_processing_verified processing JOIN task_mode_state state ON state.task_id=processing.task_id WHERE processing.started_at IS NOT NULL").all() as Array<{ task_id: string }>;
    for (const row of rows) { const state = this.get(row.task_id); if (state) this.setProcessing(state, false); }
  }
  private withProcessing(state: TaskModeState): TaskModeState {
    this.db.exec("BEGIN IMMEDIATE");
    try { this.applyProcessing(state, this.processingRow(state)); this.db.exec("COMMIT"); }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return state;
  }
  private processingRow(state: TaskModeState): ProcessingRow {
    const canonical = this.db.prepare("SELECT * FROM task_mode_processing_verified WHERE task_id=?").get(state.taskId) as ProcessingRow | undefined;
    if (canonical) return canonical;
    const prior = this.db.prepare("SELECT * FROM task_mode_processing WHERE task_id=?").get(state.taskId) as ProcessingRow | undefined;
    if (prior?.coverage && prior.recovered_ms !== null) { this.writeProcessing(state.taskId, prior); return prior; }
    const historical = this.db.prepare("SELECT 1 FROM task_mode_state WHERE task_id=?").get(state.taskId);
    const coverage = prior?.coverage ?? (prior ? prior.total_ms === null ? "partial" : "complete" : historical ? "partial" : "complete");
    // Recover once, before starting the new clock. A live legacy interval may overlap
    // saved commands, so count that authoritative interval instead of adding a baseline.
    const recovered = prior?.total_ms == null && !prior?.started_at && coverage === "partial" ? historicalLowerBound(state) : 0;
    const row: ProcessingRow = { total_ms: prior?.total_ms ?? (recovered > 0 ? recovered : coverage === "complete" ? 0 : null),
      started_at: prior?.started_at ?? null, runtime_id: prior?.runtime_id ?? PROCESSING_RUNTIME_ID,
      coverage, recovered_ms: recovered, tracked_since: prior?.tracked_since ?? prior?.started_at ?? null };
    this.writeProcessing(state.taskId, row);
    return row;
  }
  private writeProcessing(taskId: string, row: ProcessingRow): void {
    this.db.prepare("INSERT INTO task_mode_processing_verified(task_id,total_ms,started_at,runtime_id,coverage,recovered_ms,tracked_since) VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET total_ms=excluded.total_ms,started_at=excluded.started_at,runtime_id=excluded.runtime_id,coverage=excluded.coverage,recovered_ms=excluded.recovered_ms,tracked_since=excluded.tracked_since")
      .run(taskId, row.total_ms, row.started_at, row.runtime_id, row.coverage, row.recovered_ms, row.tracked_since);
    // The legacy projection must never present a historical lower bound as a complete total.
    this.db.prepare("INSERT INTO task_mode_processing(task_id,total_ms,started_at,runtime_id,coverage,recovered_ms,tracked_since) VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET total_ms=excluded.total_ms,started_at=excluded.started_at,runtime_id=excluded.runtime_id,coverage=excluded.coverage,recovered_ms=excluded.recovered_ms,tracked_since=excluded.tracked_since")
      .run(taskId, row.coverage === "complete" ? row.total_ms : null, row.started_at, row.runtime_id, row.coverage, row.recovered_ms, row.tracked_since);
  }
  private applyProcessing(state: TaskModeState, row: ProcessingRow): void {
    state.processedDurationMs = row.coverage === "complete" ? row.total_ms : null;
    state.processedVerifiedDurationMs = row.total_ms; state.processingStartedAt = row.started_at;
    state.processedTimingCoverage = row.coverage ?? "partial";
    state.processedTimingSince = row.tracked_since; state.processedRecoveredDurationMs = row.recovered_ms ?? 0;
  }
  private updateProcessingInside(state: TaskModeState, counting: boolean): void {
    const row = this.processingRow(state);
    if (row.started_at && row.runtime_id !== PROCESSING_RUNTIME_ID) { row.coverage = "partial"; row.started_at = null; }
    const current = this.processingOptions.nowMs?.() ?? Date.now();
    if (counting && !row.started_at) {
      row.started_at = new Date(current).toISOString(); row.tracked_since ??= row.started_at;
    }
    if (!counting && row.started_at) {
      const delta = current - Date.parse(row.started_at);
      if (Number.isFinite(delta) && delta > 0) row.total_ms = (row.total_ms ?? 0) + delta;
      else if (!Number.isFinite(delta) || delta < 0) row.coverage = "partial";
      row.started_at = null;
    }
    row.runtime_id = PROCESSING_RUNTIME_ID;
    this.writeProcessing(state.taskId, row); this.applyProcessing(state, row);
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
