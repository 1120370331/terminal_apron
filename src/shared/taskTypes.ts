export const TASK_STATUSES = [
  "not_started",
  "in_progress",
  "pending_auto_acceptance",
  "pending_manual_acceptance",
  "done",
  "blocked"
] as const;

export const TASK_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

export const TASK_REPORT_STATUSES = ["started", "progress", "blocked", "completed", "note"] as const;

export const TASK_VERIFICATION_RESULTS = ["passed", "failed", "not_run"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskDifficulty = 1 | 2 | 3 | 4 | 5;
export type TaskReportStatus = (typeof TASK_REPORT_STATUSES)[number];
export type TaskVerificationResult = (typeof TASK_VERIFICATION_RESULTS)[number];

export interface TaskVerification {
  command: string;
  result: TaskVerificationResult;
  details?: string;
}

export interface TaskReport {
  id: string;
  taskId: string;
  status: TaskReportStatus;
  summary: string;
  changedFiles: string[];
  verification: TaskVerification[];
  risks: string[];
  blockers: string[];
  nextStep: string;
  createdAt: string;
}

export interface TaskAttachment {
  id: string;
  taskId: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  url: string;
}

export interface TaskItem {
  id: string;
  key: string;
  project: string;
  title: string;
  descriptionMd: string;
  acceptanceCriteriaMd: string;
  status: TaskStatus;
  priority: TaskPriority;
  difficulty: TaskDifficulty;
  tags: string[];
  repositoryPath: string;
  maxConcurrency: number;
  revision: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  completedAt?: string;
  attachments: TaskAttachment[];
  latestReport?: TaskReport;
}

export interface TaskDashboardStats {
  total: number;
  active: number;
  blocked: number;
  done: number;
  byStatus: Record<TaskStatus, number>;
}

export interface TaskListResponse {
  tasks: TaskItem[];
  stats: TaskDashboardStats;
}

export interface TaskProjectSummary {
  name: string;
  rootDirectory: string;
  taskCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskProjectListResponse {
  projects: TaskProjectSummary[];
  unassignedCount: number;
}

export interface CreateTaskProjectInput {
  name: string;
  rootDirectory: string;
}

export interface UpdateTaskProjectInput {
  name?: string;
  rootDirectory?: string;
}

export interface CreateTaskInput {
  title: string;
  project?: string;
  descriptionMd?: string;
  acceptanceCriteriaMd?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  difficulty?: TaskDifficulty;
  tags?: string[];
  repositoryPath?: string;
  maxConcurrency?: number;
  createdAt?: string;
}

export interface UpdateTaskInput extends Partial<CreateTaskInput> {
  revision?: number;
}

export interface CreateTaskReportInput {
  status: TaskReportStatus;
  summary: string;
  changedFiles?: string[];
  verification?: TaskVerification[];
  risks?: string[];
  blockers?: string[];
  nextStep?: string;
  taskStatus?: TaskStatus;
}

export interface TaskReportListResponse {
  reports: TaskReport[];
}

export interface TaskAttachmentUploadResponse {
  attachments: TaskAttachment[];
  task: TaskItem;
}
