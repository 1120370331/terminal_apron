import type { TaskConversationEventKind, TaskConversationTurn } from "./taskConversationTypes.js";

/** Draft versions are independent of TaskItem.revision. No endpoint starts/saves a task. */
export interface RequirementDraftFields {
  title: string;
  descriptionMd: string;
  acceptanceCriteriaMd: string;
}

export interface RequirementDraftSnapshot {
  draftId: string;
  version: number;
  fields: RequirementDraftFields;
  taskId?: string;
  sourceTaskRevision?: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRequirementDraftInput {
  operationId: string;
  fields: RequirementDraftFields;
  taskId?: string;
  sourceTaskRevision?: number;
}

export interface UpdateRequirementDraftInput {
  operationId: string;
  baseVersion: number;
  patch: Partial<RequirementDraftFields>;
}

export interface RequirementDraftUpdateResult {
  operationId: string;
  draft: RequirementDraftSnapshot;
  eventId: number;
  replayed: boolean;
}

export type RequirementDraftEvent = {
  eventId: number;
  draftId: string;
  occurredAt: string;
} & (
  | { kind: "draft_updated"; version: number; operationId: string; actor: "user" | "codex"; draft: RequirementDraftSnapshot }
  | { kind: "conversation"; threadId: string; turnId?: string; itemId?: string; eventKind: TaskConversationEventKind; payload: Record<string, unknown> }
);

/** SSE uses event: draft-event, id: eventId. ready/resync_required carry a current snapshot. */
export interface RequirementDraftSyncEvent {
  kind: "ready" | "resync_required";
  draftId: string;
  eventId: number;
  draft: RequirementDraftSnapshot;
}

export interface StartRequirementDraftTurnInput {
  operationId: string;
  baseVersion: number;
  text: string;
}

export interface RequirementDraftTurnReceipt {
  operationId: string;
  state: "reserved" | "submitted" | "uncertain" | "failed";
  threadId: string;
  turnId?: string;
  /** Immutable requirement snapshot captured when this message was submitted. */
  snapshot: RequirementDraftSnapshot;
}

export interface RequirementDraftConversation {
  draftId: string;
  threadId?: string;
  turns: TaskConversationTurn[];
  operations: RequirementDraftTurnReceipt[];
}

export interface RequirementDraftErrorEnvelope {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    current?: RequirementDraftSnapshot;
    operationId?: string;
  };
}
