import { TASK_STATUSES, type TaskStatus } from "../../shared/taskTypes";

export interface TaskSearchFilters {
  query: string;
  status: TaskStatus | "all";
  project?: string;
  group?: string;
  tags: string[];
  archived: boolean;
}

export interface SavedTaskView {
  id: string;
  name: string;
  filters: TaskSearchFilters;
  createdAt: string;
  updatedAt: string;
}

const EMPTY_FILTERS: TaskSearchFilters = {
  query: "",
  status: "all",
  tags: [],
  archived: false
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && TASK_STATUSES.includes(value as TaskStatus);
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(value.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean))
  );
}

export function normalizeTaskSearchFilters(value: unknown): TaskSearchFilters {
  if (!isRecord(value)) {
    return { ...EMPTY_FILTERS, tags: [] };
  }

  return {
    query: typeof value.query === "string" ? value.query : "",
    status: isTaskStatus(value.status) ? value.status : "all",
    ...(typeof value.project === "string" ? { project: value.project } : {}),
    ...(typeof value.group === "string" ? { group: value.group } : {}),
    tags: normalizeTags(value.tags),
    archived: value.archived === true
  };
}
