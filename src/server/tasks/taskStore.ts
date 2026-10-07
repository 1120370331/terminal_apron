import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { taskArtifactFormat, taskArtifactLink } from "../../shared/taskArtifactTypes.js";
import { DEVELOPMENT_TASK_TAGS, type TaskTagMutation } from "../../shared/taskTags.js";
import { taskContextDirectory, writeTaskContextWorkspace } from "./taskContextWorkspace.js";
import {
  TASK_PRIORITIES,
  TASK_RELEASE_STATUSES,
  TASK_REPORT_STATUSES,
  TASK_STATUSES,
  TASK_VERIFICATION_RESULTS,
  type CreateTaskProjectInput,
  type CreateTaskReportInput,
  type CreateTaskInput,
  type TaskAttachment,
  type TaskDashboardStats,
  type TaskDifficulty,
  type TaskGroupListResponse,
  type TaskGroupSummary,
  type TaskItem,
  type TaskListResponse,
  type TaskPriority,
  type TaskReleaseStatus,
  type TaskProjectListResponse,
  type TaskProjectSummary,
  type TaskReport,
  type TaskReportStatus,
  type TaskStatus,
  type TaskTagListResponse,
  type TaskTagSummary,
  type TaskVerification,
  type TaskVerificationResult,
  type UpdateTaskInput,
  type UpdateTaskProjectInput
} from "../../shared/taskTypes.js";
import {
  TASK_PERMISSION_PRESETS,
  TASK_REASONING_EFFORTS,
  type TaskConversationBinding,
  type TaskConversationOperationReceipt,
  type TaskConversationPreferences,
  type TaskPermissionPreset,
  type TaskReasoningEffort
} from "../../shared/taskConversationTypes.js";

interface TaskRow {
  task_number: number;
  id: string;
  parent_id: string | null;
  project: string;
  group_name: string;
  title: string;
  description_md: string;
  acceptance_criteria_md: string;
  status: string;
  release_status: string;
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
  codex_lifecycle_state?: string;
}

interface ConversationBindingRow {
  thread_id: string; task_id: string; display_name: string; is_primary: number; archived_at: string | null;
  remote_sync_state: string; remote_sync_operation: string | null; remote_sync_error: string | null;
  remote_sync_attempted_at: string | null; pending_display_name: string | null; created_at: string; updated_at: string;
}

interface ConversationPreferencesRow {
  task_id: string;
  default_model: string | null;
  default_reasoning_effort: string;
  default_permission_preset: string;
  revision: number;
  updated_at: string;
}

export interface ConversationReservation {
  duplicate: boolean;
  requestHash: string;
  receipt: TaskConversationOperationReceipt;
}
export interface RuntimeOwnerClaim { acquired: boolean; ownerInstanceId: string; leaseExpiresAt: string }
export interface ConversationRecoveryWork { requestId:string;taskId:string;threadId?:string;operation:string;turnId?:string;clientMessageId:string;requestState:string;recoveryData?:Record<string,unknown>;leaseState?:string;leaseExpiresAt?:string }
export interface ConversationCreateGuardReservation extends ConversationReservation { snapshotRequired: boolean }

interface AttachmentRow {
  source?: "input" | "feedback" | null;
  import_key?: string | null;
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
  description_md: string;
  root_directory: string;
  created_at: string;
  updated_at: string;
  task_count?: number;
}

export interface TaskListOptions {
  query?: string;
  status?: TaskStatus;
  releaseStatus?: TaskReleaseStatus;
  project?: string;
  group?: string;
  tags?: string[];
  archived?: boolean;
}

interface TaskGroupRow {
  name: string;
  task_count: number;
}

interface TaskTagRow {
  name: string;
  task_count: number;
}

export interface NewTaskAttachment {
  source?: "input" | "feedback";
  importKey?: string;
  name: string;
  storageName: string;
  mimeType: string;
  size: number;
}

export interface StoredTaskAttachment extends TaskAttachment {
  importKey?: string;
  storageName: string;
  filePath: string;
}

export interface DeletedTaskArtifacts {
  id: string;
  key: string;
  project: string;
  attachmentDirectory: string;
  contextDirectory: string;
  parentTaskId?: string;
}

export type TaskStoreEventType =
  | "project.created"
  | "project.updated"
  | "task.created"
  | "task.updated"
  | "task.archived"
  | "task.restored"
  | "task.deleted"
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
export class TaskConversationConflictError extends TaskConflictError {
  constructor(message: string, readonly code: string, readonly details: Record<string, unknown> = {}) { super(message); }
}

export class TaskStore {
  readonly dbPath: string;
  readonly attachmentsRoot: string;
  private readonly database: DatabaseSync;
  private readonly listeners = new Set<TaskStoreListener>();
  private readonly closeHandlers = new Set<() => void>();
  private closed = false;
  private eventSequence = 0;

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, "task-monitor.sqlite");
    this.attachmentsRoot = path.join(dataDir, "task-attachments");
    this.database = new DatabaseSync(this.dbPath);
    this.initialize();
    this.initializeAttachmentSources();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of [...this.closeHandlers]) handler();
    this.closeHandlers.clear();
    this.listeners.clear();
    this.database.close();
  }

  onClose(handler: () => void): () => void {
    if (this.closed) { handler(); return () => undefined; }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
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
    if (options.releaseStatus) {
      filters.push("release_status = ?");
      parameters.push(normalizeReleaseStatus(options.releaseStatus));
    }
    if (options.project !== undefined) {
      filters.push("project = ? COLLATE NOCASE");
      parameters.push(normalizeProject(options.project));
    }
    if (options.group !== undefined) {
      filters.push("group_name = ? COLLATE NOCASE");
      parameters.push(normalizeGroup(options.group));
    }
    for (const tag of normalizeTags(options.tags)) {
      filters.push("EXISTS (SELECT 1 FROM json_each(tasks.tags_json) AS task_tag WHERE task_tag.value = ? COLLATE NOCASE)");
      parameters.push(tag);
    }
    const query = options.query?.trim().slice(0, 200);
    if (query) {
      filters.push(
        "LOWER(project || ' ' || group_name || ' ' || title || ' ' || description_md || ' ' || tags_json || ' ' || repository_path) LIKE ?"
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
                project.description_md,
                project.root_directory,
                project.created_at,
                project.updated_at,
                COUNT(task.id) AS task_count
           FROM task_projects AS project
           LEFT JOIN tasks AS task
             ON task.project = project.name COLLATE NOCASE
            AND task.archived_at IS ${archived ? "NOT " : ""}NULL
          GROUP BY project.name, project.description_md, project.root_directory, project.created_at, project.updated_at
          ORDER BY project.name COLLATE NOCASE ASC`
      )
      .all() as unknown as TaskProjectRow[];
    const unassigned = this.database
      .prepare(`SELECT COUNT(*) AS task_count FROM tasks WHERE project = '' AND archived_at IS ${archived ? "NOT " : ""}NULL`)
      .get() as { task_count: number };
    return {
      projects: rows.map(toTaskProject),
      unassignedCount: Number(unassigned.task_count) || 0,
      supportsDescription: true
    };
  }

  project(name: string): TaskProjectSummary | null {
    const normalizedName = normalizeProjectName(name);
    const row = this.database
      .prepare(
        `SELECT project.name,
                project.description_md,
                project.root_directory,
                project.created_at,
                project.updated_at,
                COUNT(task.id) AS task_count
           FROM task_projects AS project
           LEFT JOIN tasks AS task
             ON task.project = project.name COLLATE NOCASE
            AND task.archived_at IS NULL
          WHERE project.name = ? COLLATE NOCASE
          GROUP BY project.name, project.description_md, project.root_directory, project.created_at, project.updated_at`
      )
      .get(normalizedName) as unknown as TaskProjectRow | undefined;
    return row ? toTaskProject(row) : null;
  }

  createProject(input: CreateTaskProjectInput): TaskProjectSummary {
    const name = normalizeProjectName(input.name);
    const descriptionMd = normalizeMarkdown(input.descriptionMd, 10_000);
    const rootDirectory = normalizeRootDirectory(input.rootDirectory);
    const timestamp = now();
    try {
      this.database
        .prepare(
          `INSERT INTO task_projects (name, description_md, root_directory, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(name, descriptionMd, rootDirectory, timestamp, timestamp);
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
    const descriptionMd = "descriptionMd" in patch ? normalizeMarkdown(patch.descriptionMd, 10_000) : existing.descriptionMd;
    const rootDirectory =
      "rootDirectory" in patch ? normalizeRootDirectory(patch.rootDirectory) : existing.rootDirectory;
    if (name === existing.name && descriptionMd === existing.descriptionMd && rootDirectory === existing.rootDirectory) {
      return existing;
    }
    const timestamp = now();
    try {
      this.transaction(() => {
        if (name !== existing.name) {
          this.database.prepare("UPDATE task_tag_catalog SET project=? WHERE project=? COLLATE NOCASE").run(name,existing.name);
          this.database
            .prepare("UPDATE tasks SET project = ?, updated_at = ?, revision = revision + 1 WHERE project = ? COLLATE NOCASE")
            .run(name, timestamp, existing.name);
        }
        this.database
          .prepare(
            `UPDATE task_projects
                SET name = ?, description_md = ?, root_directory = ?, updated_at = ?
              WHERE name = ? COLLATE NOCASE`
          )
          .run(name, descriptionMd, rootDirectory, timestamp, existing.name);
      });
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new TaskConflictError("project name already exists");
      }
      throw error;
    }
    const project = this.project(name)!;
    const affected = this.database
      .prepare("SELECT id FROM tasks WHERE project = ? COLLATE NOCASE ORDER BY task_number")
      .all(name) as unknown as Array<{ id: string }>;
    for (const task of affected) {
      this.materializeContext(task.id);
    }
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
    const parent = this.resolveParent(input.parentTaskId);
    const project = normalizeProject(input.project) || parent?.project || "";
    const group = normalizeGroup(input.group);
    const projectRecord = project ? this.project(project) : null;
    if (project && !projectRecord) {
      throw new TaskValidationError("selected project does not exist");
    }
    if (parent && project.toLocaleLowerCase() !== parent.project.toLocaleLowerCase()) {
      throw new TaskValidationError("parent task must belong to the same project");
    }
    const status = normalizeStatus(input.status ?? "not_started");
    const releaseStatus = normalizeReleaseStatus(input.releaseStatus ?? "not_released");
    const priority = normalizePriority(input.priority ?? "P2");
    const difficulty = normalizeDifficulty(input.difficulty ?? 3);
    const requestedRepositoryPath = normalizeRepositoryPath(input.repositoryPath);
    const repositoryPath = requestedRepositoryPath || parent?.repository_path || projectRecord?.rootDirectory || "";
    this.database
      .prepare(
        `INSERT INTO tasks (
           id, parent_id, project, group_name, title, description_md, acceptance_criteria_md, status, release_status, priority,
           difficulty, tags_json,
           repository_path, max_concurrency, revision, created_at, updated_at, completed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
      .run(
        id,
        parent?.id ?? null,
        projectRecord?.name ?? "",
        group,
        title,
        normalizeMarkdown(input.descriptionMd, 100_000),
        normalizeMarkdown(input.acceptanceCriteriaMd, 50_000),
        status,
        releaseStatus,
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
    this.rememberTaskTags(task);
    this.refreshContextChain(id);
    this.refreshContextChain(parent?.id);
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
    const previousDirectory = this.contextDirectoryForRow(existingRow);
    const nextParent = "parentTaskId" in patch
      ? this.resolveParent(patch.parentTaskId, id)
      : this.resolveParent(existingRow.parent_id, id);
    const requestedProject = "project" in patch ? normalizeProject(patch.project) : existingRow.project;
    const projectRecord = "project" in patch && requestedProject ? this.project(requestedProject) : null;
    if ("project" in patch && requestedProject && !projectRecord) {
      throw new TaskValidationError("selected project does not exist");
    }
    const nextProject = projectRecord?.name ?? requestedProject;
    if (nextParent && nextProject.toLocaleLowerCase() !== nextParent.project.toLocaleLowerCase()) {
      throw new TaskValidationError("parent task must belong to the same project");
    }
    if ("project" in patch) {
      const mismatchedChild = this.database
        .prepare("SELECT id FROM tasks WHERE parent_id = ? AND project <> ? COLLATE NOCASE LIMIT 1")
        .get(id, nextProject) as { id: string } | undefined;
      if (mismatchedChild) {
        throw new TaskValidationError("child tasks must belong to the same project");
      }
    }
    this.assertNoParentCycle(id, nextParent?.id);
    const parentChanged = (nextParent?.id ?? null) !== existingRow.parent_id;
    const previousSubtreeDirectories = parentChanged ? this.contextSubtreeDirectories(id) : undefined;
    if ("parentTaskId" in patch) {
      set("parent_id", nextParent?.id ?? null);
    }

    if ("title" in patch) {
      set("title", normalizeTitle(patch.title));
    }
    if ("project" in patch) {
      set("project", nextProject);
      if (!("repositoryPath" in patch) && projectRecord) {
        set("repository_path", projectRecord.rootDirectory);
      }
    }
    if ("group" in patch) {
      set("group_name", normalizeGroup(patch.group));
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
    if ("releaseStatus" in patch) {
      set("release_status", normalizeReleaseStatus(patch.releaseStatus));
    }

    if (fields.length === 0) {
      return this.getRequired(id);
    }
    fields.push("revision = revision + 1", "updated_at = ?");
    values.push(now(), id);
    this.database.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    const task = this.getRequired(id);
    this.rememberTaskTags(task);
    if (previousSubtreeDirectories) {
      this.materializeContextSubtree(id, previousSubtreeDirectories);
    } else {
      this.materializeContext(id, previousDirectory);
    }
    this.refreshContextChain(existingRow.parent_id);
    this.refreshContextChain(task.parentTaskId);
    this.publish({ type: "task.updated", taskId: id, project: task.project });
    return task;
  }

  archive(id: string): TaskItem | null {
    const existing = this.get(id);
    if (!existing) {
      return null;
    }
    if (!existing.archived) {
      this.transaction(() => {
        const active = this.database.prepare("SELECT COUNT(*) AS count FROM task_codex_turn_leases WHERE task_id = ? AND state IN ('starting','active','reconciling')").get(id) as { count: number };
        if (active.count > 0) throw new TaskConversationConflictError("Task has an active Codex turn", "TASK_HAS_ACTIVE_TURN", { allowedActions: ["open_conversation", "interrupt"] });
        this.database.prepare("UPDATE tasks SET archived_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND codex_lifecycle_state = 'normal'").run(now(), now(), id);
      });
      this.publish({ type: "task.archived", taskId: id, project: existing.project });
      this.refreshContextChain(id);
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
      this.refreshContextChain(id);
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
             id, task_id, display_name, storage_name, mime_type, size_bytes, created_at, source, import_key
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          taskId,
          normalizeAttachmentName(attachment.name),
          attachment.storageName,
          attachment.mimeType,
          Math.max(0, Math.floor(attachment.size)),
          timestamp,
          attachment.source ?? "input",
          attachment.importKey ?? null
        );
      this.database
        .prepare("UPDATE tasks SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(timestamp, taskId);
    });
    const task = this.getRequired(taskId);
    this.refreshContextChain(taskId);
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
      importKey: row.import_key ?? undefined,
      filePath: this.attachmentFilePath(taskId, row.storage_name)
    };
  }

  feedbackImportDeleted(taskId: string, storageName: string, importKey: string, contentHash?: string): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM task_attachment_tombstones WHERE task_id = ? AND (import_key = ? OR storage_name = ? OR (import_key IS NULL AND content_hash = ?))").get(taskId, importKey, storageName, contentHash ?? null));
  }

  removeAttachment(taskId: string, attachmentId: string): { task: TaskItem; storageName: string } | null {
    const attachment = this.attachment(taskId, attachmentId);
    if (!attachment) {
      return null;
    }
    this.transaction(() => {
      if (attachment.source === "feedback") {
        const contentHash = !attachment.importKey && fs.existsSync(attachment.filePath) ? createHash("sha256").update(fs.readFileSync(attachment.filePath)).digest("hex") : null;
        this.database.prepare("INSERT OR IGNORE INTO task_attachment_tombstones(task_id, storage_name, import_key, content_hash) VALUES (?, ?, ?, ?)").run(taskId, attachment.storageName, attachment.importKey ?? null, contentHash);
      }
      this.database.prepare("DELETE FROM task_attachments WHERE task_id = ? AND id = ?").run(taskId, attachmentId);
      this.database
        .prepare("UPDATE tasks SET updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(now(), taskId);
    });
    const task = this.getRequired(taskId);
    this.refreshContextChain(taskId);
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
    const releaseStatus =
      input.releaseStatus === undefined ? undefined : normalizeReleaseStatus(input.releaseStatus);

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
      if (releaseStatus !== undefined) {
        fields.push("release_status = ?");
        values.push(releaseStatus);
      }
      values.push(taskId);
      this.database.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    });

    const task = this.getRequired(taskId);
    this.refreshContextChain(taskId);
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
        parent_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        project TEXT NOT NULL DEFAULT '',
        group_name TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        description_md TEXT NOT NULL DEFAULT '',
        acceptance_criteria_md TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        release_status TEXT NOT NULL DEFAULT 'not_released',
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
        description_md TEXT NOT NULL DEFAULT '',
        root_directory TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_codex_threads (
        thread_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL DEFAULT '',
        is_primary INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        remote_sync_state TEXT NOT NULL DEFAULT 'synced',
        remote_sync_operation TEXT,
        remote_sync_error TEXT,
        remote_sync_attempted_at TEXT,
        pending_display_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_codex_requests (
        request_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        thread_id TEXT REFERENCES task_codex_threads(thread_id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        client_message_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        codex_turn_id TEXT,
        response_json TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, operation, client_message_id)
      );

      CREATE TABLE IF NOT EXISTS task_codex_turn_leases (
        lease_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE REFERENCES task_codex_requests(request_id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        thread_id TEXT NOT NULL REFERENCES task_codex_threads(thread_id) ON DELETE CASCADE,
        turn_id TEXT,
        state TEXT NOT NULL,
        owner_instance_id TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_codex_runtime_owner (
        user_data_root TEXT PRIMARY KEY,
        instance_id TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_codex_create_guards (
        user_data_root TEXT NOT NULL,
        resolved_cwd TEXT NOT NULL,
        request_id TEXT NOT NULL UNIQUE REFERENCES task_codex_requests(request_id) ON DELETE CASCADE,
        state TEXT NOT NULL CHECK (state IN ('snapshotting','reserved','submitted','reconciling')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_data_root, resolved_cwd)
      );

      CREATE TABLE IF NOT EXISTS task_codex_preferences (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        default_model TEXT,
        default_reasoning_effort TEXT NOT NULL CHECK (default_reasoning_effort IN ('minimal','low','medium','high','xhigh')),
        default_permission_preset TEXT NOT NULL CHECK (default_permission_preset IN ('read_only','workspace_write','full_access')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        updated_at TEXT NOT NULL
      );
    `);

    const preferenceColumns = this.database.prepare("PRAGMA table_info(task_codex_preferences)").all() as unknown as Array<{ name: string }>;
    const projectColumns = this.database.prepare("PRAGMA table_info(task_projects)").all() as unknown as Array<{ name: string }>;
    if (!projectColumns.some((column) => column.name === "description_md")) {
      this.database.exec("ALTER TABLE task_projects ADD COLUMN description_md TEXT NOT NULL DEFAULT ''");
    }
    if (!preferenceColumns.some((column) => column.name === "default_model")) {
      this.database.exec("ALTER TABLE task_codex_preferences ADD COLUMN default_model TEXT");
    }

    const taskColumns = this.database.prepare("PRAGMA table_info(tasks)").all() as unknown as Array<{ name: string }>;
    if (!taskColumns.some((column) => column.name === "project")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN project TEXT NOT NULL DEFAULT ''");
    }
    if (!taskColumns.some((column) => column.name === "group_name")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN group_name TEXT NOT NULL DEFAULT ''");
    }
    if (!taskColumns.some((column) => column.name === "release_status")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN release_status TEXT NOT NULL DEFAULT 'not_released'");
    }
    if (!taskColumns.some((column) => column.name === "parent_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN parent_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT");
    }
    if (!taskColumns.some((column) => column.name === "codex_lifecycle_state")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN codex_lifecycle_state TEXT NOT NULL DEFAULT 'normal'");
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
      CREATE INDEX IF NOT EXISTS idx_tasks_release_status
        ON tasks(release_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_project_active
        ON tasks(project COLLATE NOCASE, archived_at, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_group_active
        ON tasks(group_name COLLATE NOCASE, archived_at, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent
        ON tasks(parent_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_attachments_task
        ON task_attachments(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_task_reports_task_created
        ON task_reports(task_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_task_codex_threads_task
        ON task_codex_threads(task_id, archived_at, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_task_codex_threads_active_primary
        ON task_codex_threads(task_id) WHERE is_primary = 1 AND archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_task_codex_turn_leases_active
        ON task_codex_turn_leases(task_id, state, lease_expires_at);

      CREATE TABLE IF NOT EXISTS task_tag_catalog (
        project TEXT NOT NULL COLLATE NOCASE,
        name TEXT NOT NULL COLLATE NOCASE,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project,name)
      );
      INSERT OR IGNORE INTO task_tag_catalog(project,name,created_at)
        SELECT task.project,task_tag.value,MIN(task.created_at) FROM tasks task
        JOIN json_each(CASE WHEN json_valid(task.tags_json) THEN task.tags_json ELSE '[]' END) task_tag
        WHERE typeof(task_tag.value)='text' AND trim(task_tag.value)<>''
        GROUP BY task.project COLLATE NOCASE,task_tag.value COLLATE NOCASE;
      PRAGMA user_version = 12;
    `);
  }

  private initializeAttachmentSources(): void {
    const columns = this.database.prepare("PRAGMA table_info(task_attachments)").all() as unknown as Array<{ name: string }>;
    if (!columns.some(column => column.name === "source")) this.database.exec("ALTER TABLE task_attachments ADD COLUMN source TEXT");
    if (!columns.some(column => column.name === "import_key")) this.database.exec("ALTER TABLE task_attachments ADD COLUMN import_key TEXT");
    this.database.exec(`CREATE TABLE IF NOT EXISTS task_attachment_tombstones (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      storage_name TEXT NOT NULL, import_key TEXT, content_hash TEXT, PRIMARY KEY(task_id, storage_name)
    )`);
    this.database.exec("PRAGMA user_version = 13");
    const rows = this.database.prepare("SELECT id, storage_name FROM task_attachments WHERE source IS NULL").all() as unknown as Array<{ id: string; storage_name: string }>;
    const update = this.database.prepare("UPDATE task_attachments SET source = ? WHERE id = ? AND source IS NULL");
    for (const row of rows) update.run(/^tm-[a-f0-9]{64}(?:\..*)?$/.test(row.storage_name) ? "feedback" : "input", row.id);
  }

  groups(archived = false): TaskGroupListResponse {
    const rows = this.database
      .prepare(
        `SELECT MIN(group_name) AS name, COUNT(*) AS task_count
           FROM tasks
          WHERE group_name <> ''
            AND archived_at IS ${archived ? "NOT " : ""}NULL
          GROUP BY group_name COLLATE NOCASE
          ORDER BY MIN(group_name) COLLATE NOCASE ASC`
      )
      .all() as unknown as TaskGroupRow[];
    const ungrouped = this.database
      .prepare(`SELECT COUNT(*) AS task_count FROM tasks WHERE group_name = '' AND archived_at IS ${archived ? "NOT " : ""}NULL`)
      .get() as { task_count: number };
    return {
      groups: rows.map(toTaskGroup),
      ungroupedCount: Number(ungrouped.task_count) || 0
    };
  }

  tags(archived = false, project?:string, catalog=false): TaskTagListResponse {
    const rows = this.database
      .prepare(
        `SELECT MIN(task_tag.value) AS name, COUNT(DISTINCT task.id) AS task_count
           FROM tasks AS task
           JOIN json_each(task.tags_json) AS task_tag
          WHERE task.archived_at IS ${archived ? "NOT " : ""}NULL
            ${project!==undefined?"AND task.project = ? COLLATE NOCASE":""}
            AND typeof(task_tag.value) = 'text'
            AND trim(task_tag.value) <> ''
          GROUP BY task_tag.value COLLATE NOCASE
          ORDER BY MIN(task_tag.value) COLLATE NOCASE ASC`
      )
      .all(...(project!==undefined?[normalizeProject(project)]:[])) as unknown as TaskTagRow[];
    if(!catalog)return { tags: rows.map(toTaskTag) };
    const tags=new Map(rows.map(row=>{const tag=toTaskTag(row);return[tag.name.toLocaleLowerCase(),tag];}));
    const remembered=this.database.prepare(`SELECT DISTINCT name FROM task_tag_catalog ${project!==undefined?"WHERE project=? COLLATE NOCASE":""}`).all(...(project!==undefined?[normalizeProject(project)]:[])) as Array<{name:string}>;
    for(const {name} of remembered)if(!tags.has(name.toLocaleLowerCase()))tags.set(name.toLocaleLowerCase(),{name,taskCount:0});
    for(const name of DEVELOPMENT_TASK_TAGS){const key=name.toLocaleLowerCase();tags.set(key,{...(tags.get(key)??{name,taskCount:0}),builtin:true});}
    return {project,tags:[...tags.values()].sort((a,b)=>b.taskCount-a.taskCount||Number(Boolean(b.builtin))-Number(Boolean(a.builtin))||a.name.localeCompare(b.name,"zh-CN"))};
  }

  private rememberTaskTags(task:TaskItem):void {
    const insert=this.database.prepare("INSERT OR IGNORE INTO task_tag_catalog(project,name,created_at) VALUES(?,?,?)");
    for(const name of task.tags)insert.run(task.project,name,now());
  }

  updateTags(taskId:string,input:TaskTagMutation):TaskItem|null {
    for(const key of ["add","remove","tags"] as const)if(input[key]!==undefined&&(!Array.isArray(input[key])||input[key]!.some(value=>typeof value!=="string"||!value.trim()||value.trim().length>40)))throw new TaskValidationError("标签必须为 1–40 个字符的文本");
    if(input.tags!==undefined&&(input.add!==undefined||input.remove!==undefined))throw new TaskValidationError("替换标签不能与增删标签同时使用");
    if(input.tags===undefined&&input.add===undefined&&input.remove===undefined)throw new TaskValidationError("请提供需要增加、移除或设置的标签");
    let changed=false;
    const updated=this.transaction(()=>{
      const task=this.get(taskId);if(!task)return null;
      if(input.revision!==undefined&&input.revision!==task.revision)throw new TaskConflictError("任务已更新，请重新读取后设置标签");
      const removed=new Set(normalizeTags(input.remove).map(tag=>tag.toLocaleLowerCase()));
      const raw=input.tags??[...task.tags.filter(tag=>!removed.has(tag.toLocaleLowerCase())),...(input.add??[])];
      const unique=new Set(raw.map(tag=>tag.replace(/\s+/g," ").trim().toLocaleLowerCase()));if(unique.size>12)throw new TaskValidationError("单个任务最多设置 12 个标签");
      const tags=normalizeTags(raw);if(JSON.stringify(tags)===JSON.stringify(task.tags))return task;
      this.database.prepare("UPDATE tasks SET tags_json=?,updated_at=?,revision=revision+1 WHERE id=?").run(JSON.stringify(tags),now(),taskId);
      const next=this.getRequired(taskId);this.rememberTaskTags(next);changed=true;return next;
    });
    if(updated&&changed){this.refreshContextChain(taskId);this.publish({type:"task.updated",taskId,project:updated.project});}
    return updated;
  }

  getConversationPreferences(taskId: string): TaskConversationPreferences {
    if (!this.get(taskId)) throw new TaskValidationError("task does not exist");
    const row = this.database.prepare("SELECT * FROM task_codex_preferences WHERE task_id = ?").get(taskId) as unknown as ConversationPreferencesRow | undefined;
    return row ? toConversationPreferences(row) : {
      taskId,
      defaultModel: null,
      defaultReasoningEffort: "medium",
      defaultPermissionPreset: "read_only",
      revision: 0
    };
  }

  updateConversationPreferences(input: {
    taskId: string;
    defaultModel: string | null;
    defaultReasoningEffort: TaskReasoningEffort;
    defaultPermissionPreset: TaskPermissionPreset;
    revision: number;
  }): TaskConversationPreferences {
    if (!(TASK_REASONING_EFFORTS as readonly string[]).includes(input.defaultReasoningEffort)) throw new TaskValidationError("invalid default reasoning effort");
    if (!(TASK_PERMISSION_PRESETS as readonly string[]).includes(input.defaultPermissionPreset)) throw new TaskValidationError("invalid default permission preset");
    if (!Number.isInteger(input.revision) || input.revision < 0) throw new TaskValidationError("invalid preferences revision");
    return this.transaction(() => {
      if (!this.database.prepare("SELECT 1 FROM tasks WHERE id = ?").get(input.taskId)) throw new TaskValidationError("task does not exist");
      const existing = this.database.prepare("SELECT * FROM task_codex_preferences WHERE task_id = ?").get(input.taskId) as unknown as ConversationPreferencesRow | undefined;
      const current = existing ? toConversationPreferences(existing) : { taskId: input.taskId, defaultModel: null, defaultReasoningEffort: "medium" as const, defaultPermissionPreset: "read_only" as const, revision: 0 };
      if (current.revision !== input.revision) throw new TaskConversationConflictError("Codex defaults changed since they were opened", "PREFERENCES_CONFLICT", { preferences: current });
      const revision = current.revision + 1;
      const timestamp = now();
      this.database.prepare(`INSERT INTO task_codex_preferences
        (task_id, default_model, default_reasoning_effort, default_permission_preset, revision, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          default_model=excluded.default_model,
          default_reasoning_effort=excluded.default_reasoning_effort,
          default_permission_preset=excluded.default_permission_preset,
          revision=excluded.revision,
          updated_at=excluded.updated_at`
      ).run(input.taskId, input.defaultModel, input.defaultReasoningEffort, input.defaultPermissionPreset, revision, timestamp);
      return { taskId: input.taskId, defaultModel: input.defaultModel, defaultReasoningEffort: input.defaultReasoningEffort, defaultPermissionPreset: input.defaultPermissionPreset, revision, updatedAt: timestamp };
    });
  }

  beginConversationCreate(input: { taskId: string; clientMessageId: string; requestHash: string; resolvedCwd: string }): ConversationCreateGuardReservation {
    return this.transaction(() => {
      const existing = this.database.prepare("SELECT * FROM task_codex_requests WHERE task_id=? AND operation='create' AND client_message_id=?").get(input.taskId,input.clientMessageId) as unknown as {request_id:string;request_hash:string;state:string;thread_id:string|null}|undefined;
      if(existing){if(existing.request_hash!==input.requestHash)throw new TaskConversationConflictError("clientMessageId was already used with different input","IDEMPOTENCY_KEY_REUSED");return{duplicate:true,snapshotRequired:false,requestHash:existing.request_hash,receipt:{operationId:existing.request_id,clientMessageId:input.clientMessageId,state:normalizeOperationState(existing.state),threadId:existing.thread_id??undefined}};}
      const task=this.database.prepare("SELECT archived_at,codex_lifecycle_state FROM tasks WHERE id=?").get(input.taskId) as {archived_at:string|null;codex_lifecycle_state:string}|undefined;
      if(!task)throw new TaskValidationError("task does not exist"); if(task.archived_at||task.codex_lifecycle_state!=="normal")throw new TaskConversationConflictError("task cannot create a conversation","TASK_CONVERSATION_BLOCKED");
      const normalizedCwd=path.resolve(input.resolvedCwd);const userDataRoot=path.resolve(this.dataDir);
      const inFlight=this.database.prepare("SELECT request_id FROM task_codex_create_guards WHERE user_data_root=? AND resolved_cwd=?").get(userDataRoot,normalizedCwd) as {request_id:string}|undefined;
      if(inFlight)throw new TaskConversationConflictError("another conversation create is still in progress","CREATE_CONFLICT",{operationId:inFlight.request_id});
      const requestId=randomUUID(),timestamp=now();
      this.database.prepare("INSERT INTO task_codex_requests(request_id,task_id,operation,client_message_id,request_hash,state,created_at,updated_at) VALUES (?,?,'create',?,?,'snapshotting',?,?)").run(requestId,input.taskId,input.clientMessageId,input.requestHash,timestamp,timestamp);
      this.database.prepare("INSERT INTO task_codex_create_guards(user_data_root,resolved_cwd,request_id,state,created_at,updated_at) VALUES (?,?,?,'snapshotting',?,?)").run(userDataRoot,normalizedCwd,requestId,timestamp,timestamp);
      return{duplicate:false,snapshotRequired:true,requestHash:input.requestHash,receipt:{operationId:requestId,clientMessageId:input.clientMessageId,state:"reserved"}};
    });
  }

  saveConversationCreateSnapshot(requestId:string,resolvedCwd:string,priorThreadIds:string[]):void{this.transaction(()=>{const timestamp=now(),root=path.resolve(this.dataDir),cwd=path.resolve(resolvedCwd);const guard=this.database.prepare("SELECT request_id FROM task_codex_create_guards WHERE user_data_root=? AND resolved_cwd=? AND request_id=? AND state='snapshotting'").get(root,cwd,requestId);if(!guard)throw new TaskConversationConflictError("conversation create guard is no longer owned","CREATE_CONFLICT",{operationId:requestId});this.database.prepare("UPDATE task_codex_requests SET state='reserved',response_json=?,updated_at=? WHERE request_id=? AND state='snapshotting'").run(JSON.stringify({recoveryVersion:1,resolvedCwd:cwd,priorThreadIds}),timestamp,requestId);this.database.prepare("UPDATE task_codex_create_guards SET state='reserved',updated_at=? WHERE request_id=?").run(timestamp,requestId);});}

  markConversationCreateSubmitted(requestId:string):void{const timestamp=now();this.transaction(()=>{this.database.prepare("UPDATE task_codex_requests SET state='submitted',updated_at=? WHERE request_id=?").run(timestamp,requestId);this.database.prepare("UPDATE task_codex_create_guards SET state='submitted',updated_at=? WHERE request_id=?").run(timestamp,requestId);});}

  completeConversationCreate(requestId:string,threadId:string):void{this.transaction(()=>{this.database.prepare("UPDATE task_codex_requests SET thread_id=?,state='completed',updated_at=? WHERE request_id=?").run(threadId,now(),requestId);this.database.prepare("DELETE FROM task_codex_create_guards WHERE request_id=?").run(requestId);});}

  prepareStaleConversationCreateRecovery(staleBeforeIso:string):{released:number;promoted:number}{
    return this.transaction(()=>{
      const stale=this.database.prepare("SELECT request_id,state FROM task_codex_create_guards WHERE updated_at<=? ORDER BY updated_at").all(staleBeforeIso) as unknown as Array<{request_id:string;state:string}>;
      let released=0,promoted=0;const timestamp=now();
      for(const guard of stale){
        if(guard.state==="snapshotting"){
          this.database.prepare("UPDATE task_codex_requests SET state='failed',error_code='CREATE_GUARD_EXPIRED',updated_at=? WHERE request_id=? AND state='snapshotting'").run(timestamp,guard.request_id);
          this.database.prepare("DELETE FROM task_codex_create_guards WHERE request_id=? AND state='snapshotting'").run(guard.request_id);
          released++;
          continue;
        }
        if(guard.state==="reserved"||guard.state==="submitted"||guard.state==="reconciling"){
          this.database.prepare("UPDATE task_codex_requests SET state='reconciling',error_code='CREATE_OUTCOME_UNKNOWN',updated_at=? WHERE request_id=? AND state IN ('reserved','submitted','reconciling')").run(timestamp,guard.request_id);
          this.database.prepare("UPDATE task_codex_create_guards SET state='reconciling',updated_at=? WHERE request_id=?").run(timestamp,guard.request_id);
          promoted++;
        }
      }
      return{released,promoted};
    });
  }

  renameConversationBinding(taskId:string,threadId:string,displayName:string):TaskConversationBinding{
    const timestamp=now();this.database.prepare("UPDATE task_codex_threads SET pending_display_name=?,remote_sync_state='pending_rename',remote_sync_operation='rename',remote_sync_error=NULL,updated_at=? WHERE task_id=? AND thread_id=? AND archived_at IS NULL").run(displayName.trim().slice(0,120),timestamp,taskId,threadId);return this.getConversationBinding(taskId,threadId)!;
  }
  completeConversationRename(taskId:string,threadId:string,success:boolean,error?:string):TaskConversationBinding{
    const timestamp=now();if(success)this.database.prepare("UPDATE task_codex_threads SET display_name=pending_display_name,pending_display_name=NULL,remote_sync_state='synced',remote_sync_operation=NULL,remote_sync_error=NULL,updated_at=? WHERE task_id=? AND thread_id=?").run(timestamp,taskId,threadId);else this.database.prepare("UPDATE task_codex_threads SET remote_sync_state='sync_failed',remote_sync_error=?,remote_sync_attempted_at=?,updated_at=? WHERE task_id=? AND thread_id=?").run((error??"rename failed").slice(0,500),timestamp,timestamp,taskId,threadId);return this.getConversationBinding(taskId,threadId)!;
  }
  beginConversationArchive(taskId:string,threadId:string):void{this.database.prepare("UPDATE task_codex_threads SET remote_sync_state='pending_archive',remote_sync_operation='archive',remote_sync_error=NULL,updated_at=? WHERE task_id=? AND thread_id=? AND archived_at IS NULL").run(now(),taskId,threadId);}
  completeConversationArchive(taskId:string,threadId:string,success:boolean,error?:string):TaskConversationBinding{
    const timestamp=now();if(success)this.database.prepare("UPDATE task_codex_threads SET archived_at=?,is_primary=0,remote_sync_state='synced',remote_sync_operation=NULL,remote_sync_error=NULL,updated_at=? WHERE task_id=? AND thread_id=?").run(timestamp,timestamp,taskId,threadId);else this.database.prepare("UPDATE task_codex_threads SET remote_sync_state='sync_failed',remote_sync_error=?,remote_sync_attempted_at=?,updated_at=? WHERE task_id=? AND thread_id=?").run((error??"archive failed").slice(0,500),timestamp,timestamp,taskId,threadId);return this.getConversationBinding(taskId,threadId)!;
  }

  beginTaskDeletionArchiveBatch(taskId:string):TaskConversationBinding[]{
    return this.transaction(()=>{const task=this.database.prepare("SELECT codex_lifecycle_state FROM tasks WHERE id=?").get(taskId) as {codex_lifecycle_state:string}|undefined;if(!task)throw new TaskValidationError("task does not exist");const active=this.database.prepare("SELECT COUNT(*) AS count FROM task_codex_turn_leases WHERE task_id=? AND state IN ('starting','active','reconciling')").get(taskId) as {count:number};if(active.count)throw new TaskConversationConflictError("Task has an active Codex turn","TASK_HAS_ACTIVE_TURN",{allowedActions:["open_conversation","interrupt"]});this.database.prepare("UPDATE tasks SET codex_lifecycle_state='pending_delete' WHERE id=?").run(taskId);this.database.prepare("UPDATE task_codex_threads SET remote_sync_state='pending_archive',remote_sync_operation='archive',updated_at=? WHERE task_id=? AND archived_at IS NULL AND remote_sync_state<>'pending_archive'").run(now(),taskId);return this.listConversationBindings(taskId);});
  }

  acquireConversationRuntimeOwner(instanceId:string,ttlMs=20_000):RuntimeOwnerClaim{
    return this.transaction(()=>{const timestamp=new Date(),expires=new Date(timestamp.getTime()+ttlMs).toISOString(),root=path.resolve(this.dataDir);const existing=this.database.prepare("SELECT * FROM task_codex_runtime_owner WHERE user_data_root=?").get(root) as {instance_id:string;lease_expires_at:string}|undefined;if(existing&&existing.instance_id!==instanceId&&Date.parse(existing.lease_expires_at)>timestamp.getTime())return{acquired:false,ownerInstanceId:existing.instance_id,leaseExpiresAt:existing.lease_expires_at};this.database.prepare("INSERT INTO task_codex_runtime_owner(user_data_root,instance_id,heartbeat_at,lease_expires_at) VALUES (?,?,?,?) ON CONFLICT(user_data_root) DO UPDATE SET instance_id=excluded.instance_id,heartbeat_at=excluded.heartbeat_at,lease_expires_at=excluded.lease_expires_at").run(root,instanceId,timestamp.toISOString(),expires);return{acquired:true,ownerInstanceId:instanceId,leaseExpiresAt:expires};});
  }
  releaseConversationRuntimeOwner(instanceId:string):void{this.database.prepare("DELETE FROM task_codex_runtime_owner WHERE user_data_root=? AND instance_id=?").run(path.resolve(this.dataDir),instanceId);}

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
    return rows.map((row) => {
      const parent = row.parent_id
        ? (this.database.prepare("SELECT task_number, id, title, status FROM tasks WHERE id = ?").get(row.parent_id) as
            | { task_number: number; id: string; title: string; status: string }
            | undefined)
        : undefined;
      const children = this.database
        .prepare("SELECT task_number, id, title, status FROM tasks WHERE parent_id = ? ORDER BY task_number")
        .all(row.id) as unknown as Array<{ task_number: number; id: string; title: string; status: string }>;
      return toTask(
        row,
        byTask.get(row.id) ?? [],
        reportsByTask.get(row.id),
        this.contextDirectoryForRow(row),
        parent ? { id: parent.id, key: `TA-${parent.task_number}`, title: parent.title } : undefined,
        children.map((child) => ({
          id: child.id,
          key: `TA-${child.task_number}`,
          title: child.title,
          status: normalizeStatus(child.status)
        }))
      );
    });
  }

  bindConversation(taskId: string, threadId: string, displayName: string, primary = true): TaskConversationBinding {
    const timestamp = now();
    this.transaction(() => {
      if (!this.get(taskId)) throw new TaskValidationError("task does not exist");
      if (primary) this.database.prepare("UPDATE task_codex_threads SET is_primary = 0, updated_at = ? WHERE task_id = ? AND archived_at IS NULL").run(timestamp, taskId);
      this.database.prepare(`INSERT INTO task_codex_threads
        (thread_id, task_id, display_name, is_primary, remote_sync_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'synced', ?, ?)`
      ).run(threadId, taskId, displayName.trim().slice(0, 120), primary ? 1 : 0, timestamp, timestamp);
    });
    return this.getConversationBinding(taskId, threadId)!;
  }

  listConversationBindings(taskId: string, archived = false): TaskConversationBinding[] {
    return (this.database.prepare(`SELECT * FROM task_codex_threads WHERE task_id = ? AND archived_at IS ${archived ? "NOT " : ""}NULL ORDER BY is_primary DESC, updated_at DESC`).all(taskId) as unknown as ConversationBindingRow[]).map(toConversationBinding);
  }

  getConversationBinding(taskId: string, threadId: string): TaskConversationBinding | null {
    const row = this.database.prepare("SELECT * FROM task_codex_threads WHERE task_id = ? AND thread_id = ?").get(taskId, threadId) as unknown as ConversationBindingRow | undefined;
    return row ? toConversationBinding(row) : null;
  }

  setPrimaryConversation(taskId: string, threadId: string): void {
    this.transaction(() => {
      const target = this.database.prepare("SELECT 1 FROM task_codex_threads WHERE task_id = ? AND thread_id = ? AND archived_at IS NULL").get(taskId, threadId);
      if (!target) throw new TaskValidationError("conversation does not exist");
      const timestamp = now();
      this.database.prepare("UPDATE task_codex_threads SET is_primary = 0, updated_at = ? WHERE task_id = ? AND archived_at IS NULL AND thread_id <> ? AND is_primary = 1").run(timestamp, taskId, threadId);
      this.database.prepare("UPDATE task_codex_threads SET is_primary = 1, updated_at = ? WHERE task_id = ? AND thread_id = ? AND archived_at IS NULL").run(timestamp, taskId, threadId);
    });
  }

  reserveConversationRequestAndLease(input: { taskId: string; threadId: string; operation: string; clientMessageId: string; requestHash: string; ownerInstanceId: string }): ConversationReservation {
    return this.transaction(() => {
      const existing = this.database.prepare("SELECT * FROM task_codex_requests WHERE task_id = ? AND operation = ? AND client_message_id = ?").get(input.taskId, input.operation, input.clientMessageId) as unknown as { request_id: string; request_hash: string; state: string; codex_turn_id: string | null } | undefined;
      if (existing) {
        if (existing.request_hash !== input.requestHash) throw new TaskConversationConflictError("clientMessageId was already used with different input", "IDEMPOTENCY_KEY_REUSED");
        return { duplicate: true, requestHash: existing.request_hash, receipt: { operationId: existing.request_id, clientMessageId: input.clientMessageId, state: normalizeOperationState(existing.state), threadId: input.threadId, turnId: existing.codex_turn_id ?? undefined } };
      }
      const task = this.database.prepare("SELECT max_concurrency, archived_at, codex_lifecycle_state FROM tasks WHERE id = ?").get(input.taskId) as { max_concurrency: number; archived_at: string | null; codex_lifecycle_state: string } | undefined;
      if (!task) throw new TaskValidationError("task does not exist");
      if (task.archived_at || task.codex_lifecycle_state !== "normal") throw new TaskConversationConflictError("task cannot start a turn in its current lifecycle state", "TASK_CONVERSATION_BLOCKED");
      const binding = this.database.prepare("SELECT 1 FROM task_codex_threads WHERE task_id = ? AND thread_id = ? AND archived_at IS NULL").get(input.taskId, input.threadId);
      if (!binding) throw new TaskValidationError("conversation does not exist");
      const active = this.database.prepare("SELECT COUNT(*) AS count FROM task_codex_turn_leases WHERE task_id = ? AND state IN ('starting','active','reconciling')").get(input.taskId) as { count: number };
      if (active.count >= task.max_concurrency) throw new TaskConversationConflictError("task concurrency limit reached", "TASK_CONCURRENCY_LIMIT");
      const requestId = randomUUID(); const timestamp = now(); const expires = new Date(Date.now() + 60_000).toISOString();
      this.database.prepare(`INSERT INTO task_codex_requests (request_id,task_id,thread_id,operation,client_message_id,request_hash,state,created_at,updated_at) VALUES (?,?,?,?,?,?,'reserved',?,?)`).run(requestId,input.taskId,input.threadId,input.operation,input.clientMessageId,input.requestHash,timestamp,timestamp);
      this.database.prepare(`INSERT INTO task_codex_turn_leases (lease_id,request_id,task_id,thread_id,state,owner_instance_id,lease_expires_at,created_at,updated_at) VALUES (?,?,?,?, 'starting', ?,?,?,?)`).run(randomUUID(),requestId,input.taskId,input.threadId,input.ownerInstanceId,expires,timestamp,timestamp);
      return { duplicate: false, requestHash: input.requestHash, receipt: { operationId: requestId, clientMessageId: input.clientMessageId, state: "reserved", threadId: input.threadId } };
    });
  }

  reserveConversationOperation(input:{taskId:string;threadId:string;operation:string;clientMessageId:string;requestHash:string}):ConversationReservation{
    return this.transaction(()=>{const existing=this.database.prepare("SELECT * FROM task_codex_requests WHERE task_id=? AND operation=? AND client_message_id=?").get(input.taskId,input.operation,input.clientMessageId) as unknown as {request_id:string;request_hash:string;state:string;codex_turn_id:string|null}|undefined;if(existing){if(existing.request_hash!==input.requestHash)throw new TaskConversationConflictError("clientMessageId was already used with different input","IDEMPOTENCY_KEY_REUSED");return{duplicate:true,requestHash:existing.request_hash,receipt:{operationId:existing.request_id,clientMessageId:input.clientMessageId,state:normalizeOperationState(existing.state),threadId:input.threadId,turnId:existing.codex_turn_id??undefined}};}const binding=this.database.prepare("SELECT 1 FROM task_codex_threads WHERE task_id=? AND thread_id=? AND archived_at IS NULL").get(input.taskId,input.threadId);if(!binding)throw new TaskValidationError("conversation does not exist");const requestId=randomUUID(),timestamp=now();this.database.prepare("INSERT INTO task_codex_requests(request_id,task_id,thread_id,operation,client_message_id,request_hash,state,created_at,updated_at) VALUES (?,?,?,?,?,?,'reserved',?,?)").run(requestId,input.taskId,input.threadId,input.operation,input.clientMessageId,input.requestHash,timestamp,timestamp);return{duplicate:false,requestHash:input.requestHash,receipt:{operationId:requestId,clientMessageId:input.clientMessageId,state:"reserved",threadId:input.threadId}};});
  }
  completeConversationOperation(requestId:string,turnId?:string):TaskConversationOperationReceipt{const timestamp=now();this.database.prepare("UPDATE task_codex_requests SET state='completed',codex_turn_id=COALESCE(?,codex_turn_id),updated_at=? WHERE request_id=?").run(turnId??null,timestamp,requestId);const row=this.database.prepare("SELECT * FROM task_codex_requests WHERE request_id=?").get(requestId) as {client_message_id:string;thread_id:string;codex_turn_id:string|null};return{operationId:requestId,clientMessageId:row.client_message_id,state:"completed",threadId:row.thread_id,turnId:row.codex_turn_id??undefined};}

  markConversationRequestSubmitted(requestId: string, turnId: string): TaskConversationOperationReceipt {
    const timestamp = now();
    this.transaction(() => {
      this.database.prepare("UPDATE task_codex_requests SET state='submitted', codex_turn_id=?, updated_at=? WHERE request_id=?").run(turnId,timestamp,requestId);
      this.database.prepare("UPDATE task_codex_turn_leases SET state='active', turn_id=?, lease_expires_at='9999-12-31T23:59:59.999Z', updated_at=? WHERE request_id=?").run(turnId,timestamp,requestId);
    });
    const row = this.database.prepare("SELECT * FROM task_codex_requests WHERE request_id=?").get(requestId) as { client_message_id: string; thread_id: string; state: string; codex_turn_id: string };
    return { operationId: requestId, clientMessageId: row.client_message_id, state: "submitted", threadId: row.thread_id, turnId: row.codex_turn_id };
  }

  completeConversationTurn(threadId: string, turnId: string, failed = false): void {
    const timestamp = now(); const state = failed ? "failed" : "completed";
    this.transaction(() => {
      this.database.prepare("UPDATE task_codex_requests SET state=?, updated_at=? WHERE thread_id=? AND codex_turn_id=?").run(state,timestamp,threadId,turnId);
      this.database.prepare("UPDATE task_codex_turn_leases SET state=?, updated_at=? WHERE thread_id=? AND turn_id=?").run(state,timestamp,threadId,turnId);
    });
  }

  getActiveConversationLease(taskId: string, threadId: string): { state: "starting" | "active" | "reconciling"; turnId?: string } | null {
    const row = this.database.prepare(`SELECT state, turn_id FROM task_codex_turn_leases
      WHERE task_id = ? AND thread_id = ? AND state IN ('starting','active','reconciling')
      ORDER BY updated_at DESC LIMIT 1`).get(taskId, threadId) as { state: "starting" | "active" | "reconciling"; turn_id: string | null } | undefined;
    return row ? { state: row.state, turnId: row.turn_id ?? undefined } : null;
  }

  failConversationRequest(requestId: string, uncertain: boolean, code: string): void {
    const state = uncertain ? "reconciling" : "failed"; const timestamp = now();
    this.transaction(() => {
      this.database.prepare("UPDATE task_codex_requests SET state=?, error_code=?, updated_at=? WHERE request_id=?").run(state,code,timestamp,requestId);
      this.database.prepare("UPDATE task_codex_turn_leases SET state=?, updated_at=? WHERE request_id=?").run(state, timestamp, requestId);
      if(uncertain)this.database.prepare("UPDATE task_codex_create_guards SET state='reconciling', updated_at=? WHERE request_id=?").run(timestamp,requestId);
      else this.database.prepare("DELETE FROM task_codex_create_guards WHERE request_id=?").run(requestId);
    });
  }

  listConversationRecoveryWork(taskId?:string):ConversationRecoveryWork[]{const where=taskId?"AND request.task_id = ?":"";return(this.database.prepare(`SELECT request.request_id,request.task_id,request.thread_id,request.operation,request.client_message_id,request.state AS request_state,request.response_json,lease.turn_id,lease.state AS lease_state,lease.lease_expires_at FROM task_codex_requests request LEFT JOIN task_codex_turn_leases lease ON request.request_id=lease.request_id WHERE (request.state='reconciling' OR lease.state IN ('starting','active','reconciling')) ${where} ORDER BY request.created_at LIMIT 100`).all(...(taskId?[taskId]:[])) as unknown as Array<{request_id:string;task_id:string;thread_id:string|null;operation:string;client_message_id:string;request_state:string;response_json:string|null;turn_id:string|null;lease_state:string|null;lease_expires_at:string|null}>).map(row=>({requestId:row.request_id,taskId:row.task_id,threadId:row.thread_id??undefined,operation:row.operation,turnId:row.turn_id??undefined,clientMessageId:row.client_message_id,requestState:row.request_state,recoveryData:parseRecoveryData(row.response_json),leaseState:row.lease_state??undefined,leaseExpiresAt:row.lease_expires_at??undefined}));}
  reconcileConversationLease(requestId:string,outcome:{state:"active"|"completed"|"failed"|"reconciling";turnId?:string}):void{const timestamp=now();this.transaction(()=>{const requestState=outcome.state==="active"?"submitted":outcome.state;this.database.prepare("UPDATE task_codex_requests SET state=?,codex_turn_id=COALESCE(?,codex_turn_id),updated_at=? WHERE request_id=?").run(requestState,outcome.turnId??null,timestamp,requestId);this.database.prepare("UPDATE task_codex_turn_leases SET state=?,turn_id=COALESCE(?,turn_id),lease_expires_at=CASE WHEN ?='active' THEN '9999-12-31T23:59:59.999Z' ELSE lease_expires_at END,updated_at=? WHERE request_id=?").run(outcome.state,outcome.turnId??null,outcome.state,timestamp,requestId);});}

  refreshContext(id: string): TaskItem | null {
    if (!this.get(id)) {
      return null;
    }
    this.refreshContextChain(id);
    return this.getRequired(id);
  }

  delete(id: string): DeletedTaskArtifacts | null {
    const existing = this.get(id);
    if (!existing) {
      return null;
    }
    if (existing.subtasks.length > 0) {
      throw new TaskValidationError("delete subtasks before deleting their parent task");
    }
    const active = this.database.prepare("SELECT COUNT(*) AS count FROM task_codex_turn_leases WHERE task_id = ? AND state IN ('starting','active','reconciling')").get(id) as { count: number };
    if (active.count > 0) throw new TaskConversationConflictError("Task has an active Codex turn", "TASK_HAS_ACTIVE_TURN", { allowedActions: ["open_conversation", "interrupt"] });

    const artifacts: DeletedTaskArtifacts = {
      id: existing.id,
      key: existing.key,
      project: existing.project,
      attachmentDirectory: path.join(this.attachmentsRoot, existing.id),
      contextDirectory: existing.contextDirectory,
      parentTaskId: existing.parentTaskId
    };
    this.database.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    this.refreshContextChain(existing.parentTaskId);
    this.publish({ type: "task.deleted", taskId: id, project: existing.project });
    return artifacts;
  }

  private resolveParent(value: unknown, childId?: string): TaskRow | null {
    const parentId = typeof value === "string" ? value.trim() : "";
    if (!parentId) {
      return null;
    }
    const parent = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(parentId) as unknown as TaskRow | undefined;
    if (!parent || parent.id === childId) {
      throw new TaskValidationError(parent?.id === childId ? "task cannot be its own parent" : "parent task does not exist");
    }
    return parent;
  }

  private assertNoParentCycle(childId: string, parentId?: string): void {
    let current = parentId;
    const seen = new Set<string>();
    while (current) {
      if (current === childId || seen.has(current)) {
        throw new TaskValidationError("task hierarchy cannot contain a cycle");
      }
      seen.add(current);
      const row = this.database.prepare("SELECT parent_id FROM tasks WHERE id = ?").get(current) as
        | { parent_id: string | null }
        | undefined;
      current = row?.parent_id ?? undefined;
    }
  }

  private contextDirectoryForRow(row: Pick<TaskRow, "task_number" | "parent_id">): string {
    const key = `TA-${row.task_number}`;
    if (!row.parent_id) {
      return taskContextDirectory(this.dataDir, key);
    }
    const parent = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(row.parent_id) as unknown as
      | TaskRow
      | undefined;
    if (!parent) {
      throw new TaskValidationError("parent task does not exist");
    }
    return taskContextDirectory(this.dataDir, key, this.contextDirectoryForRow(parent));
  }

  private materializeContext(id: string, previousDirectory?: string): void {
    const task = this.getRequired(id);
    writeTaskContextWorkspace(
      this.dataDir,
      { task, reports: this.listReports(id) ?? [] },
      {
        parentDirectory: task.parentTaskId ? path.dirname(path.dirname(task.contextDirectory)) : undefined,
        previousDirectory
      }
    );
  }

  private contextSubtreeDirectories(id: string): Map<string, string> {
    const directories = new Map<string, string>();
    const pending = [id];
    while (pending.length > 0) {
      const current = pending.shift()!;
      const row = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(current) as unknown as TaskRow | undefined;
      if (!row) {
        continue;
      }
      directories.set(current, this.contextDirectoryForRow(row));
      const children = this.database.prepare("SELECT id FROM tasks WHERE parent_id = ? ORDER BY task_number").all(current) as unknown as Array<{
        id: string;
      }>;
      pending.push(...children.map((child) => child.id));
    }
    return directories;
  }

  private materializeContextSubtree(id: string, previousDirectories: Map<string, string>): void {
    const pending = [id];
    while (pending.length > 0) {
      const current = pending.shift()!;
      this.materializeContext(current, previousDirectories.get(current));
      const children = this.database.prepare("SELECT id FROM tasks WHERE parent_id = ? ORDER BY task_number").all(current) as unknown as Array<{
        id: string;
      }>;
      pending.push(...children.map((child) => child.id));
    }
  }

  private refreshContextChain(id?: string | null): void {
    let current = id ?? undefined;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      this.materializeContext(current);
      const row = this.database.prepare("SELECT parent_id FROM tasks WHERE id = ?").get(current) as
        | { parent_id: string | null }
        | undefined;
      current = row?.parent_id ?? undefined;
    }
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

function toTask(
  row: TaskRow,
  attachments: TaskAttachment[],
  latestReport: TaskReport | undefined,
  contextDirectory: string,
  parentTask: TaskItem["parentTask"],
  subtasks: TaskItem["subtasks"]
): TaskItem {
  return {
    id: row.id,
    key: `TA-${row.task_number}`,
    parentTaskId: row.parent_id ?? undefined,
    parentTask,
    subtasks,
    project: row.project,
    group: normalizeGroup(row.group_name),
    title: row.title,
    descriptionMd: row.description_md,
    acceptanceCriteriaMd: row.acceptance_criteria_md,
    status: normalizeStatus(row.status),
    releaseStatus: normalizeReleaseStatus(row.release_status),
    priority: normalizePriority(row.priority),
    difficulty: normalizeDifficulty(row.difficulty),
    tags: parseTags(row.tags_json),
    repositoryPath: row.repository_path,
    contextDirectory,
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
    descriptionMd: row.description_md,
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
  const previewFormat = taskArtifactFormat(row.storage_name, row.mime_type);
  return {
    id: row.id,
    taskId: row.task_id,
    source: row.source === "feedback" ? "feedback" : "input",
    name: row.display_name,
    mimeType: row.mime_type,
    size: row.size_bytes,
    createdAt: row.created_at,
    url: `/api/tasks/${encodeURIComponent(row.task_id)}/attachments/${encodeURIComponent(row.id)}/content`,
    ...(previewFormat ? { previewFormat, previewUrl: taskArtifactLink(row.task_id, { attachmentId: row.id }) } : {})
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

function toConversationBinding(row: ConversationBindingRow): TaskConversationBinding {
  return {
    taskId: row.task_id,
    threadId: row.thread_id,
    displayName: row.display_name,
    isPrimary: row.is_primary === 1,
    archived: Boolean(row.archived_at),
    remoteSyncState: normalizeRemoteSyncState(row.remote_sync_state),
    pendingDisplayName: row.pending_display_name ?? undefined,
    remoteSyncError: row.remote_sync_error ? { code: "REMOTE_SYNC_FAILED", message: row.remote_sync_error, retryable: true } : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toTaskGroup(row: TaskGroupRow): TaskGroupSummary {
  return {
    name: normalizeGroup(row.name),
    taskCount: Number(row.task_count) || 0
  };
}

function toTaskTag(row: TaskTagRow): TaskTagSummary {
  return {
    name: normalizeText(row.name, 40).replace(/\s+/g, " "),
    taskCount: Number(row.task_count) || 0
  };
}

function normalizeRemoteSyncState(value: string): TaskConversationBinding["remoteSyncState"] {
  return value === "pending_rename" || value === "pending_archive" || value === "sync_failed" ? value : "synced";
}

function normalizeOperationState(value: string): TaskConversationOperationReceipt["state"] {
  if (value === "submitted" || value === "reconciling" || value === "completed" || value === "failed") return value;
  return "reserved";
}
function toConversationPreferences(row: ConversationPreferencesRow): TaskConversationPreferences {
  return {
    taskId: row.task_id,
    defaultModel: row.default_model,
    defaultReasoningEffort: row.default_reasoning_effort as TaskReasoningEffort,
    defaultPermissionPreset: row.default_permission_preset as TaskPermissionPreset,
    revision: row.revision,
    updatedAt: row.updated_at
  };
}
function parseRecoveryData(value:string|null):Record<string,unknown>|undefined{if(!value)return undefined;try{const parsed=JSON.parse(value);return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:undefined;}catch{return undefined;}}

function normalizeReleaseStatus(value: unknown): TaskReleaseStatus {
  if (typeof value === "string" && (TASK_RELEASE_STATUSES as readonly string[]).includes(value)) {
    return value as TaskReleaseStatus;
  }
  throw new TaskValidationError("invalid task release status");
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
  const unique = new Map<string, string>();
  for (const tag of value) {
    if (typeof tag !== "string") {
      continue;
    }
    const normalized = tag.replace(/\s+/g, " ").trim().slice(0, 40);
    if (normalized && !unique.has(normalized.toLocaleLowerCase())) {
      unique.set(normalized.toLocaleLowerCase(), normalized);
    }
  }
  return Array.from(unique.values()).slice(0, 12);
}

function normalizeGroup(value: unknown): string {
  return normalizeText(value, 80).replace(/\s+/g, " ");
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
