import type {
  AuthConfig,
  AuthUser,
  CreateSessionInput,
  HealthStatus,
  SessionPreview,
  TerminalSession,
  UpdateSessionInput
} from "../shared/types";

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
  if (init.body && !headers.has("Content-Type")) {
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
  updateSession: (id: string, input: UpdateSessionInput) =>
    request<TerminalSession>(`/api/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input)
    }),
  ensureSession: (id: string) =>
    request<TerminalSession>(`/api/sessions/${id}/ensure`, {
      method: "POST"
    }),
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
  preview: (id: string) => request<SessionPreview>(`/api/sessions/${id}/preview`)
};
