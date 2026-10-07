import type { TaskThreadUsage } from "./taskUsageTypes.js";

export const TASK_PERMISSION_PRESETS = ["read_only", "workspace_write", "full_access"] as const;
export const TASK_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export type TaskPermissionPreset = (typeof TASK_PERMISSION_PRESETS)[number];
export type TaskApprovalsReviewer = "auto_review" | "user";
export type TaskReasoningEffort = (typeof TASK_REASONING_EFFORTS)[number];
export type TaskConversationStatus = "not_loaded" | "idle" | "active" | "system_error" | "missing";
export type TaskTurnStatus = "in_progress" | "completed" | "interrupted" | "failed";
export type TaskApprovalDecision = "accept" | "accept_for_session" | "decline";
export type TaskConversationRemoteSyncState = "synced" | "pending_rename" | "pending_archive" | "sync_failed";
export type TaskConversationOperationState = "reserved" | "submitted" | "reconciling" | "completed" | "failed";

export interface TaskConversationBinding {
  taskId: string;
  threadId: string;
  displayName: string;
  isPrimary: boolean;
  archived: boolean;
  remoteSyncState: TaskConversationRemoteSyncState;
  pendingDisplayName?: string;
  remoteSyncError?: { code: string; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
}

export interface TaskConversationSummary extends TaskConversationBinding {
  preview: string;
  status: TaskConversationStatus;
  cwd: string;
  modelProvider: string;
  activeTurnId?: string;
  usage?: TaskThreadUsage;
}

export interface TaskConversationTurn {
  id: string;
  status: TaskTurnStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  error?: { code: string; message: string; retryable: boolean };
  items: TaskConversationItem[];
}

export type TaskConversationItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; phase?: "commentary" | "final" }
  | { kind: "reasoning"; id: string; summary: string[] }
  | { kind: "plan"; id: string; text: string }
  | { kind: "command"; id: string; command: string; cwd: string; status: string; output?: string; outputTruncated?: boolean; exitCode?: number; durationMs?: number }
  | { kind: "file_change"; id: string; status: string; paths: string[]; changes?: Array<{ path: string; diff: string }> }
  | { kind: "tool"; id: string; server: string; tool: string; status: string; summary?: string; durationMs?: number }
  | { kind: "activity"; id: string; activityType: string; label: string; status?: "in_progress" | "completed" };

export interface TaskConversationDetail {
  conversation: TaskConversationSummary;
  turns: TaskConversationTurn[];
}

export interface TaskConversationPage {
  detail: TaskConversationDetail;
  approvals: TaskConversationApproval[];
  page: { nextBeforeTurnId?: string; complete: boolean };
}

export type TaskConversationEventKind =
  | "ready" | "resync_required" | "thread_status" | "turn_started" | "turn_completed"
  | "item_started" | "item_completed" | "assistant_delta" | "plan_delta"
  | "command_output_delta" | "file_change_delta" | "approval_requested"
  | "approval_resolved" | "warning" | "error" | "manager_unavailable" | "token_usage_updated";

export interface TaskConversationEvent {
  sequence: number;
  kind: TaskConversationEventKind;
  taskId: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface TaskConversationApproval {
  token: string;
  kind: "command" | "file_change";
  taskId: string;
  threadId: string;
  turnId: string;
  itemId: string;
  requestedAt: string;
  expiresAt: string;
  source: "codex_app_server";
  decisions: TaskApprovalDecision[];
  command?: { argv: string[]; display: string; cwd: string; reason?: string };
  fileChange?: { paths: string[]; reason?: string };
}

export interface TaskConversationOperationReceipt {
  operationId: string;
  clientMessageId: string;
  state: TaskConversationOperationState;
  threadId?: string;
  turnId?: string;
}

export interface TaskConversationModel {
  id: string;
  displayName: string;
  isDefault: boolean;
  efforts: TaskReasoningEffort[];
  defaultEffort?: TaskReasoningEffort;
}

export interface TaskConversationPreferences {
  taskId: string;
  defaultModel: string | null;
  defaultReasoningEffort: TaskReasoningEffort;
  defaultPermissionPreset: TaskPermissionPreset;
  revision: number;
  updatedAt?: string;
}

export interface UpdateTaskConversationPreferencesInput {
  defaultModel: string | null;
  defaultReasoningEffort: TaskReasoningEffort;
  defaultPermissionPreset: TaskPermissionPreset;
  revision: number;
  fullAccessConfirmed?: true;
}

export interface CreateTaskConversationInput {
  clientMessageId: string;
  displayName?: string;
  model?: string;
}

export interface EnsureTaskConversationResult {
  conversation: TaskConversationSummary;
  created: boolean;
}

export interface StartTaskTurnInput {
  clientMessageId: string;
  text: string;
  model?: string;
  effort?: TaskReasoningEffort;
  permissionPreset?: TaskPermissionPreset;
}

export interface SteerTaskTurnInput {
  clientMessageId: string;
  expectedTurnId: string;
  text: string;
}

export interface TaskConversationErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
    activeTurnId?: string;
    operationId?: string;
    allowedActions?: Array<"open_conversation" | "interrupt" | "retry" | "reload">;
  };
}
