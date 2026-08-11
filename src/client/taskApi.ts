import type {
  CreateTaskProjectInput,
  CreateTaskReportInput,
  CreateTaskInput,
  TaskAttachmentUploadResponse,
  TaskItem,
  TaskListResponse,
  TaskProjectListResponse,
  TaskProjectSummary,
  TaskReportListResponse,
  TaskStatus,
  UpdateTaskInput,
  UpdateTaskProjectInput
} from "../shared/taskTypes";
import type { AuthConfig, AuthUser, DirectoryBrowserResult } from "../shared/types";

export class TaskApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function taskRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include"
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      message = body.error ?? message;
    } catch {
      // Keep the response status text.
    }
    throw new TaskApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export const taskApi = {
  list: (options: { query?: string; status?: TaskStatus | "all"; project?: string; archived?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (options.query?.trim()) {
      params.set("q", options.query.trim());
    }
    if (options.status && options.status !== "all") {
      params.set("status", options.status);
    }
    if (options.project !== undefined) {
      params.set("project", options.project);
    }
    if (options.archived) {
      params.set("archived", "true");
    }
    const suffix = params.size ? `?${params.toString()}` : "";
    return taskRequest<TaskListResponse>(`/api/tasks${suffix}`);
  },
  projects: (archived = false) =>
    taskRequest<TaskProjectListResponse>(`/api/tasks/projects${archived ? "?archived=true" : ""}`),
  createProject: (input: CreateTaskProjectInput) =>
    taskRequest<TaskProjectSummary>("/api/tasks/projects", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  updateProject: (name: string, input: UpdateTaskProjectInput) =>
    taskRequest<TaskProjectSummary>(`/api/tasks/projects/${encodeURIComponent(name)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  browseDirectory: (directoryPath?: string, signal?: AbortSignal) => {
    const query = directoryPath ? `?path=${encodeURIComponent(directoryPath)}` : "";
    return taskRequest<DirectoryBrowserResult>(`/api/filesystem/directories${query}`, { signal });
  },
  get: (id: string) => taskRequest<TaskItem>(`/api/tasks/${encodeURIComponent(id)}`),
  create: (input: CreateTaskInput) =>
    taskRequest<TaskItem>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  update: (id: string, input: UpdateTaskInput) =>
    taskRequest<TaskItem>(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  archive: (id: string) =>
    taskRequest<TaskItem>(`/api/tasks/${encodeURIComponent(id)}/archive`, { method: "POST" }),
  restore: (id: string) =>
    taskRequest<TaskItem>(`/api/tasks/${encodeURIComponent(id)}/restore`, { method: "POST" }),
  reports: (id: string, limit = 50) =>
    taskRequest<TaskReportListResponse>(
      `/api/tasks/${encodeURIComponent(id)}/reports?limit=${encodeURIComponent(String(limit))}`
    ),
  addReport: (id: string, input: CreateTaskReportInput) =>
    taskRequest<TaskItem>(`/api/tasks/${encodeURIComponent(id)}/reports`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  uploadAttachments: (id: string, files: File[]) => {
    const form = new FormData();
    files.forEach((file) => form.append("files", file, file.name || "screenshot.png"));
    return taskRequest<TaskAttachmentUploadResponse>(`/api/tasks/${encodeURIComponent(id)}/attachments`, {
      method: "POST",
      body: form
    });
  },
  deleteAttachment: (taskId: string, attachmentId: string) =>
    taskRequest<TaskItem>(
      `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { method: "DELETE" }
    )
};

export const taskAuthApi = {
  config: () => taskRequest<AuthConfig>("/api/auth/config"),
  me: () => taskRequest<AuthUser>("/api/me"),
  login: (username: string, password: string) =>
    taskRequest<AuthUser>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    }),
  logout: () => taskRequest<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  sshChallenge: (username: string) =>
    taskRequest<{ id: string; username: string; namespace: string; value: string; expiresAt: number }>(
      "/api/auth/ssh/challenge",
      {
        method: "POST",
        body: JSON.stringify({ username })
      }
    ),
  sshVerify: (input: { challengeId: string; username: string; publicKey: string; signature: string }) =>
    taskRequest<AuthUser>("/api/auth/ssh/verify", {
      method: "POST",
      body: JSON.stringify(input)
    })
};
