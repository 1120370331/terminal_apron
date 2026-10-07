import { createClientId } from "./clientId";
import type {
  CreateTaskConversationInput,
  EnsureTaskConversationResult,
  StartTaskTurnInput,
  SteerTaskTurnInput,
  TaskApprovalDecision,
  TaskConversationEvent,
  TaskConversationModel,
  TaskConversationOperationReceipt,
  TaskConversationPage,
  TaskConversationPreferences,
  TaskConversationSummary,
  UpdateTaskConversationPreferencesInput
} from "../shared/taskConversationTypes";

export class TaskConversationApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly details: Record<string, unknown> = {}) { super(message); }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, credentials: "include", headers: { ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers } });
  const body = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } | string } & T;
  if (!response.ok) { const error = typeof body.error === "string" ? { message: body.error } : body.error; throw new TaskConversationApiError(error?.message ?? response.statusText, response.status, error?.code, typeof error === "object" ? error as Record<string, unknown> : {}); }
  return body;
}

const root = (taskId: string) => `/api/tasks/${encodeURIComponent(taskId)}/conversations`;
export const taskConversationApi = {
  list: (taskId: string) => request<{ conversations: TaskConversationSummary[]; primaryThreadId?: string }>(root(taskId)),
  ensureDefault: (taskId:string) => request<EnsureTaskConversationResult>(`${root(taskId)}/default`,{method:"POST"}),
  models: (taskId: string) => request<{ models: TaskConversationModel[] }>(`${root(taskId)}/models`),
  preferences: (taskId: string) => request<TaskConversationPreferences>(`${root(taskId)}/preferences`),
  updatePreferences: (taskId: string, input: UpdateTaskConversationPreferencesInput) => request<TaskConversationPreferences>(`${root(taskId)}/preferences`, { method: "PATCH", body: JSON.stringify(input) }),
  create: (taskId: string, input: CreateTaskConversationInput) => request<{ conversation: TaskConversationSummary; operation: TaskConversationOperationReceipt }>(root(taskId), { method: "POST", body: JSON.stringify(input) }),
  read: (taskId: string, threadId: string, beforeTurnId?: string) => request<TaskConversationPage>(`${root(taskId)}/${encodeURIComponent(threadId)}?limit=50${beforeTurnId ? `&beforeTurnId=${encodeURIComponent(beforeTurnId)}` : ""}`),
  send: (taskId: string, threadId: string, input: StartTaskTurnInput) => request<{ operation: TaskConversationOperationReceipt }>(`${root(taskId)}/${encodeURIComponent(threadId)}/turns`, { method: "POST", body: JSON.stringify(input) }),
  steer: (taskId: string, threadId: string, input: SteerTaskTurnInput) => request<unknown>(`${root(taskId)}/${encodeURIComponent(threadId)}/steer`, { method: "POST", body: JSON.stringify(input) }),
  interrupt: (taskId: string, threadId: string, expectedTurnId: string) => request<unknown>(`${root(taskId)}/${encodeURIComponent(threadId)}/interrupt`, { method: "POST", body: JSON.stringify({ expectedTurnId }) }),
  resolveApproval: (taskId: string, threadId: string, token: string, decision: TaskApprovalDecision) => request<unknown>(`${root(taskId)}/${encodeURIComponent(threadId)}/approvals/${encodeURIComponent(token)}`, { method: "POST", body: JSON.stringify({ decision }) }),
  rename: (taskId:string,threadId:string,displayName:string)=>request<TaskConversationSummary>(`${root(taskId)}/${encodeURIComponent(threadId)}`,{method:"PATCH",body:JSON.stringify({displayName})}),
  archive: (taskId:string,threadId:string)=>request<TaskConversationSummary>(`${root(taskId)}/${encodeURIComponent(threadId)}/archive`,{method:"POST"}),
  subscribe: (taskId: string, onEvent: (event: TaskConversationEvent) => void) => {
    const source = new EventSource(`${root(taskId)}/events`);
    let ready = false, sequence = 0;
    source.addEventListener("open", () => { ready = false; });
    source.addEventListener("error", () => { ready = false; });
    source.addEventListener("conversation-event", (message) => {
      let event: TaskConversationEvent;
      try { event = JSON.parse((message as MessageEvent).data) as TaskConversationEvent; } catch { return; }
      if (event.taskId !== taskId) return;
      // Replay is covered by the snapshot read on ready; applying replayed deltas would duplicate text.
      if (event.kind === "ready") { ready = true; sequence = event.sequence; onEvent(event); return; }
      if (event.kind === "resync_required") { ready = false; onEvent(event); return; }
      if (!ready || event.sequence <= sequence) return;
      sequence = event.sequence; onEvent(event);
    });
    return source;
  }
};

export function newClientMessageId(): string { return createClientId(); }
