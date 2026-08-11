import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  TASK_PRIORITIES,
  TASK_REPORT_STATUSES,
  TASK_STATUSES,
  TASK_VERIFICATION_RESULTS,
  type CreateTaskProjectInput,
  type CreateTaskReportInput,
  type CreateTaskInput,
  type TaskAttachment,
  type TaskDashboardStats,
  type TaskDifficulty,
  type TaskItem,
  type TaskListResponse,
  type TaskPriority,
  type TaskProjectListResponse,
  type TaskProjectSummary,
  type TaskReport,
  type TaskReportStatus,
  type TaskStatus,
  type TaskVerification,
  type TaskVerificationResult,
  type UpdateTaskInput,
  type UpdateTaskProjectInput
} from "../../shared/taskTypes.js";

interface TaskRow {
  task_number: number;
  id: string;
  project: string;
  title: string;
  description_md: string;
  acceptance_criteria_md: string;
  status: string;
  priority: string;
  difficulty: number;
  computed_progress: number;
  progress_override: number | null;
  tags_json: string;
  repository_path: string;
  max_concurrency: number;
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  completed_at: string | null;
}

interface AttachmentRow {
  id: string;
  task_id: string;
  display_name: string;
  storage_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
}

interface TaskReportRow {
  id: string;
  task_id: string;
  status: string;
  summary: string;
  changed_files_json: string;
  verification_json: string;
  risks_json: string;
  blockers_json: string;
  next_step: string;
  created_at: string;
}

interface TaskProjectRow {
  name: string;
  root_directory: string;
  created_at: string;
  updated_at: string;
  task_count?: number;
}

export interface TaskListOptions {
  query?: string;
  status?: TaskStatus;
  project?: string;
  archived?: boolean;
}

export interface NewTaskAttachment {
  name: string;
  storageName: string;
  mimeType: string;
  size: number;
}

export interface StoredTaskAttachment extends TaskAttachment {
  storageName: string;
  filePath: string;
}

export type TaskStoreEventType =
  | "project.created"
  | "project.updated"
  | "task.created"
  | "task.updated"
  | "task.archived"
  | "task.restored"
  | "attachment.added"
  | "attachment.removed"
  | "report.added";

export interface TaskStoreEvent {
  id: number;
  type: TaskStoreEventType;
  occurredAt: string;
  taskId?: string;
  project?: string;
}

export type TaskStoreListener = (event: TaskStoreEvent) => void;

export class TaskValidationError extends Error {}
export class TaskConflictError extends Error {}

export class TaskStore {
  readonly dbPath: string;
  readonly attachmentsRoot: string;
  private readonly database: DatabaseSync;
  private readonly listeners = new Set<TaskStoreListener>();
  private eventSequence = 0;

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, "task-monitor.sqlite");
    this.attachmentsRoot = path.join(dataDir, "task-attachments");
    this.database = new DatabaseSync(this.dbPath);
    this.initialize();
  }

  close(): void {
    this.listeners.clear();
    this.database.close();
  }

  subscribe(listener: TaskStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(options: TaskListOptions = {}): TaskListResponse {
    const filters: string[] = [options.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"];
    const parameters: Array<string | number> = [];
    if (options.status) {
      filters.push("status = ?");
      parameters.push(normalizeStatus(options.status));
    }
    if (options.project !== undefined) {
      filters.push("project = ? COLLATE NOCASE");
      parameters.push(normalizeProject(options.project));
    }
    const query = options.query?.trim().slice(0, 200);
    if (query) {
      filters.push(
        "LOWER(project || ' ' || title || ' ' || description_md || ' ' || tags_json || ' ' || repository_path) LIKE ?"
      );
      parameters.push(`%${query.toLowerCase()}%`);
    }

    const rows = this.database
      .prepare(
        `SELECT *
           FROM tasks
          WHERE ${filters.join(" AND ")}
          ORDER BY
            CASE status
              WHEN 'in_progress' THEN 0
              WHEN 'blocked' THEN 1
              WHEN 'pending_auto_acceptance' THEN 2
              WHEN 'pending_manual_acceptance' THEN 3
              WHEN 'not_started' THEN 4
              WHEN 'done' THEN 5
              ELSE 6
            END,
            CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
            updated_at DESC`
      )
      .all(...parameters) as unknown as TaskRow[];

    return {
      tasks: this.hydrateRows(rows),
      stats: this.dashboardStats()
    };
  }

  projects(archived = false): TaskProjectListResponse {
    const rows = this.database
      .prepare(
        `SELECT project.name,
                project.root_directory,
                project.created_at,
                project.updated_at,
                COUNT(task.id) AS task_count
           FROM task_projects AS project
           LEFT JOIN tasks AS task
             ON task.project = project.name COLLATE NOCASE
            AND task.archived_at IS ${archived ? "NOT " : ""}NULL
          GROUP BY project.name, project.root_directory, project.created_at, project.updated_at
          ORDER BY project.name COLLATE NOCASE ASC`
      )
      .all() as unknown as TaskProjectRow[];
    const unassigned = this.database
      .prepare(`SELECT COUNT(*) AS task_count FROM tasks WHERE project = '' AND archived_at IS ${archived ? "NOT " : ""}NULL`)
      .get() as { task_count: number };
    return {
      projects: rows.map(toTaskProject),
      unassignedCount: Number(unassigned.task_count) || 0
    };
  }

  project(name: string): TaskProjectSummary | null {
    const normalizedName = normalizeProjectName(name);
    const row = this.database
      .prepare(
        `SELECT project.name,
                project.root_directory,
                project.created_at,
                project.updated_at,
                COUNT(task.id) AS task_count
           FROM task_projects AS project
           LEFT JOIN tasks AS task
             ON task.project = project.name COLLATE NOCASE
            AND task.archived_at IS NULL
          WHERE project.name = ? COLLATE NOCASE
          GROUP BY project.name, project.root_directory, project.created_at, project.updated_at`
      )
      .get(normalizedName) as unknown as TaskProjectRow | undefined;
    return row ? toTaskProject(row) : null;
  }

  createProject(input: CreateTaskProjectInput): TaskProjectSummary {
    const name = normalizeProjectName(input.name);
    const rootDirectory = normalizeRootDirectory(input.rootDirectory);
    const timestamp = now();
    try {
      this.database
        .prepare(
          `INSERT INTO task_projects (name, root_directory, created_at, updated_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(name, rootDirectory, timestamp, timestamp);
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new TaskConflictError("project name already exists");
      }
      throw error;
    }
    const project = this.project(name)!;
    this.publish({ type: "project.created", project: project.name });
    return project;
  }

  updateProject(currentName: string, patch: UpdateTaskProjectInput): TaskProjectSummary | null {
    const existing = this.project(currentName);
    if (!existing) {
      return null;
    }
    const name = "name" in patch ? normalizeProjectName(patch.name) : existing.name;
    const rootDirectory =
      "rootDirectory" in patch ? normalizeRootDirectory(patch.rootDirectory) : existing.rootDirectory;
    if (name === existing.name && rootDirectory === existing.rootDirectory) {
      return existing;
    }
    const timestamp = now();
    try {
      this.transaction(() => {
        if (name !== existing.name) {
          this.database
            .prepare("UPDATE tasks SET project = ?, updated_at = ?, revision = revision + 1 WHERE project = ? COLLATE NOCASE")
            .run(name, timestamp, existing.name);
        }
        this.database
          .prepare(
            `UPDATE task_projects
                SET name = ?, root_directory = ?, updated_at = ?
              WHERE name = ? COLLATE NOCASE`
          )
          .run(name, rootDirectory, timestamp, existing.name);
      });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new TaskConflictError("project name already exists");
      }
      throw error;
    }
    const project = this.project(name)!;
    this.publish({ type: "project.updated", project: project.name });
    return project;
  }

  get(id: string): TaskItem | null {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as TaskRow | undefined;
    return row ? this.hydrateRows([row])[0] : null;
  }

  create(input: CreateTaskInput): TaskItem {
    const timestamp = now();
    const createdAt = normalizeTaskTimestamp(input.createdAt ?? timestamp);
    const id = randomUUID();
    const title = normalizeTitle(input.title);
    const project = normalizeProject(input.project);
    const projectRecord = project ? this.project(project) : null;
    if (project && !projectRecord) {
      throw new TaskValidationError("selected project does not exist");
    }
    const status = normalizeStatus(input.status ?? "not_started");
    const priority = normalizePriority(input.priority ?? "P2");
    const difficulty = normalizeDifficulty(input.difficulty ?? 3);
    const requestedRepositoryPath = normalizeRepositoryPath(input.repositoryPath);
    const repositoryPath = requestedRepositoryPath || projectRecord?.rootDirectory || "";
    this.database
      .prepare(
        `INSERT INTO tasks (
           id, project, title, description_md, acceptance_criteria_md, status, priority,
           difficulty, tags_json,
           repository_path, max_concurrency, revision, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
      .run(
        id,
        projectRecord?.name ?? "",
        title,
        normalizeMarkdown(input.descriptionMd, 100_000),
        normalizeMarkdown(input.acceptanceCriteriaMd, 50_000),
        status,
        priority,
        difficulty,
        JSON.stringify(normalizeTags(input.tags)),
        repositoryPath,
        normalizeMaxConcurrency(input.maxConcurrency ?? 1),
        createdAt,
        timestamp,
        status === "done" ? timestamp : null
      );
    const task = this.getRequired(id);
    this.publish({ type: "task.created", taskId: id, project: task.project });
    return task;
  }

  update(id: string, patch: UpdateTaskInput): TaskItem | null {
    const existingRow = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as
      | TaskRow
      | undefined;
    if (!existingRow) {
      return null;
    }
    if (patch.revision !== undefined && normalizeRevision(patch.revision) !== existingRow.revision) {
      throw new TaskConflictError("task changed since it was opened");
    }

    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };

    if ("title" in patch) {
      set("title", normalizeTitle(patch.title));
    }
    if ("project" in patch) {
      const project = normalizeProject(patch.project);
      const projectRecord = project ? this.project(project) : null;
      if (project && !projectRecord) {
        throw new TaskValidationError("selected project does not exist");
      }
      set("project", projectRecord?.name ?? "");
      if (!("repositoryPath" in patch) && projectRecord) {
        set("repository_path", projectRecord.rootDirectory);
      }
    }
    if ("descriptionMd" in patch) {
      set("description_md", normalizeMarkdown(patch.descriptionMd, 100_000));
    }
    if ("acceptanceCriteriaMd" in patch) {
      set("acceptance_criteria_md", normalizeMarkdown(patch.acceptanceCriteriaMd, 50_000));
    }
    if ("priority" in patch) {
      set("priority", normalizePriority(patch.priority));
    }
    if ("difficulty" in patch) {
      set("difficulty", normalizeDifficulty(patch.difficulty));
    }
    if ("tags" in patch) {
      set("tags_json", JSON.stringify(normalizeTags(patch.tags)));
    }
    if ("repositoryPath" in patch) {
      set("repository_path", normalizeRepositoryPath(patch.repositoryPath));
    }
    if ("maxConcurrency" in patch) {
      set("max_concurrency", normalizeMaxConcurrency(patch.maxConcurrency));
    }
    if ("createdAt" in patch) {
      set("created_at", normalizeTaskTimestamp(patch.createdAt));
    }
    if ("status" in patch) {
      const status = normalizeStatus(patch.status);
      set("status", status);
      if (status === "done") {
        set("completed_at", existingRow.completed_at ?? now());
      } else if (existingRow.status === "done") {
        set("completed_at", null);
      }
    }

    if (fields.length === 0) {
      return this.getRequired(id);
    }
    fields.push("revision = revision + 1", "updated_at = ?");
    values.push(now(), id);
    this.database.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    const task = this.getRequired(id);
    this.publish({ type: "task.updated", taskId: id, project: task.project });
    return task;
  }

  archive(id: string): TaskItem | null {
    const existing = this.get(id);
    if (!existing) {
      return null;
    }
    if (!existing.archived) {
      this.database
        .prepare("UPDATE tasks SET archived_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now(), now(), id);
      this.publish({ type: "task.archived", taskId: id, project: existing.project });
    }
    return this.getRequired(id);
  }

  restore(id: string): TaskItem | null {
    const existing = this.get(id);
    if (!existing) {
      return null;
    }
    if (existing.archived) {
      this.database
        .prepare("UPDATE tasks SET archived_at = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now(), id);
      this.publish({ type: "task.restored", taskId: id, project: existing.project });
    }
    return this.getRequired(id);
  }

  addAttachment(taskId: string, attachment: NewTaskAttachment): TaskItem | null {
    const existing = this.get(taskId);
    if (!existing) {
      return null;
    }
    const id = randomUUID();
    const timestamp = now();
    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO task_attachments (
             id, task_id, display_name, storage_name, mime_type, size_bytes, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          taskId,
          normalizeAttachmentName(attachment.name),
          attachment.storageName,
          attachment.mimeType,
          Math.max(0, Math.floor(attachment.size)),
          timestamp
        );
      this.database
        .prepare("UPDATE tasks SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(timestamp, taskId);
    });
    const task = this.getRequired(taskId);
    this.publish({ type: "attachment.added", taskId, project: task.project });
    return task;
  }

  attachment(taskId: string, attachmentId: string): StoredTaskAttachment | null {
    const row = this.database
      .prepare("SELECT * FROM task_attachments WHERE task_id = ? AND id = ?")
      .get(taskId, attachmentId) as unknown as AttachmentRow | undefined;
    if (!row) {
      return null;
    }
    return {
      ...toAttachment(row),
      storageName: row.storage_name,
      filePath: this.attachmentFilePath(taskId, row.storage_name)
    };
  }

  removeAttachment(taskId: string, attachmentId: string): { task: TaskItem; storageName: string } | null {
    const attachment = this.attachment(taskId, attachmentId);
    if (!attachment) {
      return null;
    }
    this.transaction(() => {
      this.database.prepare("DELETE FROM task_attachments WHERE task_id = ? AND id = ?").run(taskId, attachmentId);
      this.database
        .prepare("UPDATE tasks SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now(), taskId);
    });
    const task = this.getRequired(taskId);
    this.publish({ type: "attachment.removed", taskId, project: task.project });
    return { task, storageName: attachment.storageName };
  }

  listReports(taskId: string, limit = 50): TaskReport[] | null {
    if (!this.get(taskId)) {
      return null;
    }
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit) || 50));
    const rows = this.database
      .prepare(
        `SELECT *
           FROM task_reports
          WHERE task_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`
      )
      .all(taskId, normalizedLimit) as unknown as TaskReportRow[];
    return rows.map(toTaskReport);
  }

  addReport(taskId: string, input: CreateTaskReportInput): TaskItem | null {
    const existing = this.get(taskId);
    if (!existing) {
      return null;
    }

    const timestamp = now();
    const reportStatus = normalizeReportStatus(input.status);
    const summary = normalizeRequiredText(input.summary, "report summary", 2_000);
    const changedFiles = normalizeStringList(input.changedFiles, 50, 1_000);
    const verification = normalizeVerification(input.verification);
    const risks = normalizeStringList(input.risks, 20, 2_000);
    const blockers = normalizeStringList(input.blockers, 20, 2_000);
    const nextStep = normalizeText(input.nextStep, 2_000);
    const inferredTaskStatus =
      input.taskStatus ??
      (reportStatus === "blocked"
        ? "blocked"
        : reportStatus === "completed"
          ? "pending_auto_acceptance"
          : reportStatus === "started" && existing.status === "not_started"
            ? "in_progress"
            : undefined);
    const taskStatus = inferredTaskStatus === undefined ? undefined : normalizeStatus(inferredTaskStatus);

    this.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO task_reports (
             id, task_id, status, summary, changed_files_json, verification_json,
             risks_json, blockers_json, next_step, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          randomUUID(),
          taskId,
          reportStatus,
          summary,
          JSON.stringify(changedFiles),
          JSON.stringify(verification),
          JSON.stringify(risks),
          JSON.stringify(blockers),
          nextStep,
          timestamp
        );

      const fields = ["updated_at = ?", "revision = revision + 1"];
      const values: Array<string | number | null> = [timestamp];
      if (taskStatus !== undefined) {
        fields.push("status = ?");
        values.push(taskStatus);
        if (taskStatus === "done") {
          fields.push("completed_at = ?");
          values.push(existing.completedAt ?? timestamp);
        } else if (existing.status === "done") {
          fields.push("completed_at = ?");
          values.push(null);
        }
      }
      values.push(taskId);
      this.database.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    });

    const task = this.getRequired(taskId);
    this.publish({ type: "report.added", taskId, project: task.project });
    return task;
  }

  private publish(event: Omit<TaskStoreEvent, "id" | "occurredAt">): void {
    if (this.listeners.size === 0) {
      return;
    }
    const published: TaskStoreEvent = {
      ...event,
      id: ++this.eventSequence,
      occurredAt: now()
    };
    for (const listener of this.listeners) {
      try {
        listener(published);
      } catch {
        // A disconnected realtime client must never make a committed task write fail.
      }
    }
  }

  attachmentDirectory(taskId: string): string {
    const directory = path.join(this.attachmentsRoot, taskId);
    fs.mkdirSync(directory, { recursive: true });
    return directory;
  }

  attachmentFilePath(taskId: string, storageName: string): string {
    return path.join(this.attachmentsRoot, taskId, storageName);
  }

  private initialize(): void {
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS tasks (
        task_number INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        project TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        description_md TEXT NOT NULL DEFAULT '',
        acceptance_criteria_md TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        priority TEXT NOT NULL,
        difficulty INTEGER NOT NULL,
        computed_progress INTEGER NOT NULL DEFAULT 0,
        progress_override INTEGER,
        tags_json TEXT NOT NULL DEFAULT '[]',
        repository_path TEXT NOT NULL DEFAULT '',
        max_concurrency INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        storage_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, storage_name)
      );

      CREATE TABLE IF NOT EXISTS task_reports (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        summary TEXT NOT NULL,
        changed_files_json TEXT NOT NULL DEFAULT '[]',
        verification_json TEXT NOT NULL DEFAULT '[]',
        risks_json TEXT NOT NULL DEFAULT '[]',
        blockers_json TEXT NOT NULL DEFAULT '[]',
        next_step TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_projects (
        name TEXT PRIMARY KEY COLLATE NOCASE,
        root_directory TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const taskColumns = this.database.prepare("PRAGMA table_info(tasks)").all() as unknown as Array<{ name: string }>;
    if (!taskColumns.some((column) => column.name === "project")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN project TEXT NOT NULL DEFAULT ''");
    }

    this.database.exec(`
      INSERT OR IGNORE INTO task_projects (name, root_directory, created_at, updated_at)
      SELECT project,
             COALESCE(MAX(CASE WHEN repository_path <> '' THEN repository_path END), ''),
             MIN(created_at),
             MAX(updated_at)
        FROM tasks
       WHERE project <> ''
       GROUP BY project COLLATE NOCASE;

      UPDATE tasks
         SET status = CASE status
           WHEN 'backlog' THEN 'not_started'
           WHEN 'ready' THEN 'not_started'
           WHEN 'review' THEN 'pending_manual_acceptance'
           ELSE status
         END
       WHERE status IN ('backlog', 'ready', 'review');
    `);

    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_active_updated
        ON tasks(archived_at, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_status_priority
        ON tasks(status, priority, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_project_active
        ON tasks(project COLLATE NOCASE, archived_at, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_attachments_task
        ON task_attachments(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_task_reports_task_created
        ON task_reports(task_id, created_at DESC);

      PRAGMA user_version = 4;
    `);
  }

  private hydrateRows(rows: TaskRow[]): TaskItem[] {
    if (rows.length === 0) {
      return [];
    }
    const attachments = this.database
      .prepare(
        `SELECT * FROM task_attachments
          WHERE task_id IN (${rows.map(() => "?").join(", ")})
          ORDER BY created_at ASC`
      )
      .all(...rows.map((row) => row.id)) as unknown as AttachmentRow[];
    const byTask = new Map<string, TaskAttachment[]>();
    for (const attachment of attachments) {
      byTask.set(attachment.task_id, [...(byTask.get(attachment.task_id) ?? []), toAttachment(attachment)]);
    }
    const reportRows = this.database
      .prepare(
        `SELECT report.*
           FROM task_reports AS report
          WHERE report.task_id IN (${rows.map(() => "?").join(", ")})
            AND report.rowid = (
              SELECT latest.rowid
                FROM task_reports AS latest
               WHERE latest.task_id = report.task_id
               ORDER BY latest.created_at DESC, latest.rowid DESC
               LIMIT 1
            )`
      )
      .all(...rows.map((row) => row.id)) as unknown as TaskReportRow[];
    const reportsByTask = new Map(reportRows.map((report) => [report.task_id, toTaskReport(report)]));
    return rows.map((row) => toTask(row, byTask.get(row.id) ?? [], reportsByTask.get(row.id)));
  }

  private dashboardStats(): TaskDashboardStats {
    const rows = this.database
      .prepare("SELECT status FROM tasks WHERE archived_at IS NULL")
      .all() as unknown as Array<{ status: string }>;
    const byStatus = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<TaskStatus, number>;
    for (const row of rows) {
      const status = normalizeStatus(row.status);
      byStatus[status] += 1;
    }
    return {
      total: rows.length,
      active: rows.filter((row) => !["not_started", "done"].includes(row.status)).length,
      blocked: byStatus.blocked,
      done: byStatus.done,
      byStatus
    };
  }

  private getRequired(id: string): TaskItem {
    const task = this.get(id);
    if (!task) {
      throw new Error(`task ${id} disappeared`);
    }
    return task;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function toTask(row: TaskRow, attachments: TaskAttachment[], latestReport?: TaskReport): TaskItem {
  return {
    id: row.id,
    key: `TA-${row.task_number}`,
    project: row.project,
    title: row.title,
    descriptionMd: row.description_md,
    acceptanceCriteriaMd: row.acceptance_criteria_md,
    status: normalizeStatus(row.status),
    priority: normalizePriority(row.priority),
    difficulty: normalizeDifficulty(row.difficulty),
    tags: parseTags(row.tags_json),
    repositoryPath: row.repository_path,
    maxConcurrency: normalizeMaxConcurrency(row.max_concurrency),
    revision: normalizeRevision(row.revision),
    archived: Boolean(row.archived_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    attachments,
    latestReport
  };
}

function toTaskProject(row: TaskProjectRow): TaskProjectSummary {
  return {
    name: row.name,
    rootDirectory: row.root_directory,
    taskCount: Number(row.task_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toTaskReport(row: TaskReportRow): TaskReport {
  return {
    id: row.id,
    taskId: row.task_id,
    status: normalizeReportStatus(row.status),
    summary: row.summary,
    changedFiles: parseStringList(row.changed_files_json, 50, 1_000),
    verification: parseVerification(row.verification_json),
    risks: parseStringList(row.risks_json, 20, 2_000),
    blockers: parseStringList(row.blockers_json, 20, 2_000),
    nextStep: row.next_step,
    createdAt: row.created_at
  };
}

function toAttachment(row: AttachmentRow): TaskAttachment {
  return {
    id: row.id,
    taskId: row.task_id,
    name: row.display_name,
    mimeType: row.mime_type,
    size: row.size_bytes,
    createdAt: row.created_at,
    url: `/api/tasks/${encodeURIComponent(row.task_id)}/attachments/${encodeURIComponent(row.id)}/content`
  };
}

function now(): string {
  return new Date().toISOString();
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TaskValidationError("task title is required");
  }
  return value.replace(/\s+/g, " ").trim().slice(0, 160);
}

function normalizeProject(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 160) : "";
}

function normalizeProjectName(value: unknown): string {
  const name = normalizeProject(value);
  if (!name) {
    throw new TaskValidationError("project name is required");
  }
  return name;
}

function normalizeRootDirectory(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TaskValidationError("project root directory is required");
  }
  const rootDirectory = path.resolve(value.trim());
  try {
    if (!fs.statSync(rootDirectory).isDirectory()) {
      throw new TaskValidationError("project root must be a directory");
    }
  } catch (error) {
    if (error instanceof TaskValidationError) {
      throw error;
    }
    throw new TaskValidationError("project root directory does not exist or cannot be accessed");
  }
  return rootDirectory.slice(0, 1_000);
}

function normalizeMarkdown(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").slice(0, maxLength) : "";
}

function normalizeStatus(value: unknown): TaskStatus {
  if (typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value)) {
    return value as TaskStatus;
  }
  throw new TaskValidationError("invalid task status");
}

function normalizeReportStatus(value: unknown): TaskReportStatus {
  if (typeof value === "string" && (TASK_REPORT_STATUSES as readonly string[]).includes(value)) {
    return value as TaskReportStatus;
  }
  throw new TaskValidationError("invalid report status");
}

function normalizePriority(value: unknown): TaskPriority {
  if (typeof value === "string" && (TASK_PRIORITIES as readonly string[]).includes(value)) {
    return value as TaskPriority;
  }
  throw new TaskValidationError("invalid task priority");
}

function normalizeDifficulty(value: unknown): TaskDifficulty {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 5) {
    return parsed as TaskDifficulty;
  }
  throw new TaskValidationError("difficulty must be between 1 and 5");
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.replace(/\s+/g, " ").trim().slice(0, 40))
        .filter(Boolean)
    )
  ).slice(0, 12);
}

function normalizeRequiredText(value: unknown, field: string, maxLength: number): string {
  const normalized = normalizeText(value, maxLength);
  if (!normalized) {
    throw new TaskValidationError(`${field} is required`);
  }
  return normalized;
}

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim().slice(0, maxLength) : "";
}

function normalizeStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalizeText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function parseStringList(value: string, maxItems: number, maxLength: number): string[] {
  try {
    return normalizeStringList(JSON.parse(value), maxItems, maxLength);
  } catch {
    return [];
  }
}

function normalizeVerification(value: unknown): TaskVerification[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, 20).map((item) => {
    if (!item || typeof item !== "object") {
      throw new TaskValidationError("invalid verification entry");
    }
    const record = item as Record<string, unknown>;
    const result = normalizeVerificationResult(record.result);
    const details = normalizeText(record.details, 4_000);
    return {
      command: normalizeRequiredText(record.command, "verification command", 1_000),
      result,
      ...(details ? { details } : {})
    };
  });
}

function parseVerification(value: string): TaskVerification[] {
  try {
    return normalizeVerification(JSON.parse(value));
  } catch {
    return [];
  }
}

function normalizeVerificationResult(value: unknown): TaskVerificationResult {
  if (typeof value === "string" && (TASK_VERIFICATION_RESULTS as readonly string[]).includes(value)) {
    return value as TaskVerificationResult;
  }
  throw new TaskValidationError("invalid verification result");
}

function parseTags(value: string): string[] {
  try {
    return normalizeTags(JSON.parse(value));
  } catch {
    return [];
  }
}

function normalizeRepositoryPath(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 1_000) : "";
}

function normalizeMaxConcurrency(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new TaskValidationError("max concurrency must be a number");
  }
  return Math.max(1, Math.min(12, Math.floor(parsed)));
}

function normalizeRevision(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new TaskValidationError("invalid task revision");
  }
  return parsed;
}

function normalizeTaskTimestamp(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TaskValidationError("created time is required");
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TaskValidationError("invalid created time");
  }
  return timestamp.toISOString();
}

function normalizeAttachmentName(value: string): string {
  const cleaned = value
    .split(/[\\/]/)
    .pop()
    ?.replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return (cleaned || "screenshot").slice(0, 180);
}

function isUniqueConstraint(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = "code" in error ? String((error as Error & { code?: unknown }).code ?? "") : "";
  return code.startsWith("SQLITE_CONSTRAINT") || /unique constraint/i.test(error.message);
}
