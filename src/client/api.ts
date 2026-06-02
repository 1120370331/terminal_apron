import type {
  AuthConfig,
  AuthUser,
  CreateSessionInput,
  FileTransferListResponse,
  FileTransferUploadResponse,
  HealthStatus,
  SessionPreview,
  SessionInputRequest,
  SessionUploadResponse,
  SystemMetrics,
  TerminalSession,
  UpdateSessionInput
} from "../shared/types";

export type SessionInputAckStatus = "accepted" | "error";

export type SessionInputRequestBody = SessionInputRequest & {
  inputId?: string;
  lines?: number;
  maxChars?: number;
  includePreview?: boolean;
};

export interface SessionInputResponse {
  ok: boolean;
  inputId: string;
  inputSeq: number;
  status: SessionInputAckStatus;
  message?: string;
  runtime?: TerminalSession["runtime"];
  preview?: string;
  grid?: SessionPreview["grid"];
  signature?: string;
  capturedAt?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
      // Keep the HTTP status text.
    }
    throw new ApiError(message, response.status);
  }

  return (await response.json()) as T;
}

export const api = {
  authConfig: () => request<AuthConfig>("/api/auth/config"),
  me: () => request<AuthUser>("/api/me"),
  health: () => request<HealthStatus>("/api/health"),
  systemMetrics: () => request<SystemMetrics>("/api/system/metrics"),
  fileTransferList: () => request<FileTransferListResponse>("/api/file-transfer/files"),
  uploadTransferFiles: (files: File[]) => {
    const form = new FormData();
    files.forEach((file, index) => {
      form.append("files", file, uploadFileName(file, index));
    });
    return request<FileTransferUploadResponse>("/api/file-transfer/files", {
      method: "POST",
      body: form
    });
  },
  deleteTransferFile: (relativePath: string) =>
    request<{ ok: boolean }>("/api/file-transfer/files", {
      method: "DELETE",
      body: JSON.stringify({ path: relativePath })
    }),
  fileTransferDownloadUrl: (relativePath: string) =>
    `/api/file-transfer/download?path=${encodeURIComponent(relativePath)}`,
  login: (username: string, password: string) =>
    request<AuthUser>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  sshChallenge: (username: string) =>
    request<{
      id: string;
      username: string;
      namespace: string;
      value: string;
      expiresAt: number;
    }>("/api/auth/ssh/challenge", {
      method: "POST",
      body: JSON.stringify({ username })
    }),
  sshVerify: (input: { challengeId: string; username: string; publicKey: string; signature: string }) =>
    request<AuthUser>("/api/auth/ssh/verify", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  sessions: (archived = false) => request<TerminalSession[]>(`/api/sessions?archived=${archived}`),
  createSession: (input: CreateSessionInput) =>
    request<TerminalSession>("/api/sessions", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  duplicateSession: (id: string) =>
    request<TerminalSession>(`/api/sessions/${id}/duplicate`, {
      method: "POST"
    }),
  updateSession: (id: string, input: UpdateSessionInput) =>
    request<TerminalSession>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  ensureSession: (id: string) =>
    request<TerminalSession>(`/api/sessions/${id}/ensure`, {
      method: "POST"
    }),
  sendInput: (id: string, input: SessionInputRequestBody) =>
    request<SessionInputResponse>(`/api/sessions/${id}/input`, {
      method: "POST",
      body: JSON.stringify(input)
    }),
  uploadSessionFiles: (id: string, files: File[]) => {
    const form = new FormData();
    files.forEach((file, index) => {
      form.append("files", file, uploadFileName(file, index));
    });
    return request<SessionUploadResponse>(`/api/sessions/${id}/uploads`, {
      method: "POST",
      body: form
    });
  },
  archiveSession: (id: string) =>
    request<TerminalSession>(`/api/sessions/${id}/archive`, {
      method: "POST"
    }),
  restoreSession: (id: string) =>
    request<TerminalSession>(`/api/sessions/${id}/restore`, {
      method: "POST"
    }),
  killSession: (id: string) =>
    request<TerminalSession>(`/api/sessions/${id}/kill`, {
      method: "POST"
    }),
  preview: (id: string, lines = 500, maxChars = 500_000, full = true, force = false, signature = "") => {
    const params = new URLSearchParams({
      lines: String(lines),
      maxChars: String(maxChars),
      full: String(full),
      force: String(force)
    });
    if (signature) {
      params.set("signature", signature);
    }
    return request<SessionPreview>(`/api/sessions/${id}/preview?${params.toString()}`);
  }
};

function uploadFileName(file: File, index: number): string {
  const name = file.name.trim();
  if (name) {
    return name;
  }
  return `clipboard-${index + 1}${extensionForMimeType(file.type)}`;
}

function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") {
    return ".png";
  }
  if (normalized === "image/jpeg") {
    return ".jpg";
  }
  if (normalized === "image/gif") {
    return ".gif";
  }
  if (normalized === "image/webp") {
    return ".webp";
  }
  if (normalized === "application/pdf") {
    return ".pdf";
  }
  if (normalized.startsWith("text/")) {
    return ".txt";
  }
  return ".bin";
}
