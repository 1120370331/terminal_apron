import { DatabaseSync } from "node:sqlite";
import type { RelayUsageRates, TaskTokenCounts } from "../../shared/taskUsageTypes.js";

export interface StoredThreadUsage {
  taskId: string;
  threadId: string;
  provider?: string;
  rolloutPath?: string;
  rolloutSignature?: string;
  metadataCheckedAt?: string;
  tokens?: TaskTokenCounts;
  estimatedCreditsMicros?: number;
  estimatedUsdMicros?: number;
  estimateCheckedAt?: string;
  updatedAt?: string;
}

export class TaskUsageStore {
  private readonly db: DatabaseSync;
  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS task_codex_usage (
        thread_id TEXT PRIMARY KEY REFERENCES task_codex_threads(thread_id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_codex_usage_task ON task_codex_usage(task_id);`);
    this.db.exec("CREATE TABLE IF NOT EXISTS task_usage_preferences (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
  }
  get(taskId: string, threadId: string): StoredThreadUsage | null {
    const row = this.db.prepare("SELECT data FROM task_codex_usage WHERE task_id=? AND thread_id=?").get(taskId, threadId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }
  save(value: StoredThreadUsage): void {
    this.db.prepare("INSERT INTO task_codex_usage(thread_id,task_id,data) VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET data=excluded.data WHERE task_codex_usage.task_id=excluded.task_id").run(value.threadId, value.taskId, JSON.stringify(value));
  }
  close(): void { this.db.close(); }
  rates(): RelayUsageRates | null {
    const row = this.db.prepare("SELECT data FROM task_usage_preferences WHERE key='relay_rates'").get() as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }
  saveRates(value: RelayUsageRates): void { this.db.prepare("INSERT INTO task_usage_preferences(key,data) VALUES('relay_rates',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(JSON.stringify(value)); }
}
