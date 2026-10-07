import type { TaskAttachment, TaskItem, TaskVerification } from "./taskTypes.js";
import type { TaskApprovalsReviewer, TaskConversationApproval, TaskConversationItem, TaskPermissionPreset, TaskReasoningEffort } from "./taskConversationTypes.js";
import type { TaskUsageSummary } from "./taskUsageTypes.js";

export type WorkerPolicy = "auto" | "parallel" | "single";
export type TaskModePhase = "idle" | "planning" | "working" | "reviewing" | "paused" | "blocked" | "needs_confirmation" | "completed";
export type TaskModeAction = "pause" | "resume" | "retry" | "approve" | "reread_output" | "clarify_report";
export interface TaskModeHeartbeat {
  status: "idle" | "healthy" | "recovering" | "needs_attention";
  checkedAt?: string;
  lastEventAt?: string;
  lastRecoveredAt?: string;
  recoveryAttempts: number;
  nextRetryAt?: string;
  message?: string;
}
export type InstructionStatus = "queued" | "submitted" | "agent_received" | "worker_received" | "completed" | "blocked";
export interface TaskModeSettings {
  executionMode?: "collaborative" | "quick";
  agentModel: string;
  workerModel: string;
  effort: TaskReasoningEffort;
  workerPolicy: WorkerPolicy;
  maxWorkers: number;
  permissionPreset: TaskPermissionPreset;
  approvalsReviewer: TaskApprovalsReviewer;
  reviewPolicy: "agent" | "artifacts" | "always";
  agentPrompt: string;
  workerPrompt: string;
}
export const DEFAULT_TASK_MODE_SETTINGS: TaskModeSettings = {
  executionMode: "collaborative",
  agentModel: "gpt-6.1-sol", workerModel: "gpt-6.1-sol", effort: "medium", workerPolicy: "auto", maxWorkers: 3,
  permissionPreset: "workspace_write", approvalsReviewer: "auto_review", reviewPolicy: "artifacts",
  agentPrompt: "你是向用户负责的任务负责人，先清楚汇报任务目标完成到哪里、实际效果、未完成原因和下一步，内部调度留在执行记录中。持续推动整个任务直到满足验收条件。保留用户原文、附件和引用。理解目标后拆分明确、互不重叠的工作交给 Worker；你不直接实现。及时处理追加指示。检查 Worker 的证据，发现可处理的剩余工作就继续安排原负责人修复并复查。只在真实阻塞、影响实现的需求不明确或异常时暂停，说明具体原因及所需条件。阶段汇报、预览材料、某个 Worker 完成均不是整个任务的完成标准。达到验收条件后再提交最终审查，不把工具调用成功或 Worker 自报完成等同于验收通过。",
  workerPrompt: "你是执行 Worker，按代理给出的范围完成工作。你不独占工作区，禁止覆盖或撤销其他人的修改。不要自行创建子代理。接到追加指示后纳入执行，发现冲突及时报告。返回真实的总结、代码改动、验证命令与结果，以及需要审查的文件路径；不能伪造完成或验证证据。"
};
export const QUICK_TASK_MODE_AGENT_PROMPT = "你是向用户负责的消息代理，直接完成代码更改、验证和汇报，全程不分配 Worker 或创建子代理。保留用户原文、附件和引用，及时处理追加指示，沿用已有成果。遵守本轮权限、审批及用户自定义限制。未完成时亲自继续执行；全部验收具备真实证据后才汇报完成。";
export interface TaskModeDocument { id: string; title: string; markdown: string; revision: number; createdAt: string; updatedAt: string }
export interface RequirementSnapshot {
  title: string; descriptionMd: string; acceptanceCriteriaMd: string; revision: number; repositoryPath: string;
  project?: { name: string; rootDirectory: string; descriptionMd: string };
  attachments: Array<TaskAttachment & { snapshotPath: string }>;
  references: Array<{ id: string; title: string; markdown: string; revision: number }>;
}
export interface TaskInstruction {
  id: string; clientMessageId: string; text: string; timing: "now" | "after"; status: InstructionStatus; createdAt: string;
  archivedAt?: string;
  deletedAt?: string;
  agentReply?: string;
  replyOnly?: boolean;
  agentReceivedAt?: string; workerReceivedAt?: string; completedAt?: string; runId?: string; result?: TaskRunResult;
  snapshot: RequirementSnapshot; deliveries: Array<{ workerId: string; turnId: string; receivedAt: string }>;
}
export interface TaskRunResult {
  status: "done" | "blocked" | "needs_confirmation" | "in_progress"; summary: string; changedFiles: string[];
  verification: TaskVerification[]; risks: string[]; artifacts: TaskAttachment[];
  changes: Array<{ path: string; diff: string }>; reviewedAt?: string;
  stopReason?: string;
  humanActions?: Array<{ action: string; reason: string; unblocks: string }>;
  agentNextSteps?: string[];
  internalNextSteps?: string[];
  acceptanceReady?: boolean;
  pauseCategory?: "blocked" | "unclear_requirement" | "exception";
}
export interface TaskExecutionJob {
  id: string; role: "plan" | "worker" | "review" | "steer" | "execute"; name: string; objective: string; ownedPaths: string[];
  threadId?: string; turnId?: string; status: "pending" | "active" | "completed" | "failed" | "interrupted";
  attempt: number; text: string; model: string; output?: Record<string, unknown>; items: TaskConversationItem[]; error?: string; processed?: boolean;
  errorCode?: "invalid_structured_output"; outputReadAttempts?: number;
  purpose?: "clarify_report" | "continuation_plan" | "continuation_review";
  cycle?: number;
  ownerId?: string;
  planWorkerId?: string;
  contextPacket?: { path:string; evidencePath:string; sha256:string; originalCharacters:number; submittedCharacters:number };
}
export interface TaskExecutionRun {
  id: string; instructionIds: string[]; createdAt: string; completedAt?: string; settings: TaskModeSettings;
  jobs: TaskExecutionJob[]; result?: TaskRunResult; reviewAttempt: number;
  iteration?: number;
  progressFingerprint?: string;
  noProgressCount?: number;
}
export interface TaskModeState {
  taskId: string; phase: TaskModePhase; settings: TaskModeSettings; agentThreadId?: string;
  instructions: TaskInstruction[]; runs: TaskExecutionRun[]; activeRunId?: string;
  events: Array<{ id: string; at: string; text: string }>; heartbeat: TaskModeHeartbeat; error?: string; revision: number; updatedAt: string;
  /** Closed processing intervals in milliseconds. null/absent means historical timing is unknown, including an unclosed interval from a crashed runtime. */
  processedDurationMs?: number | null;
  /** Start of the single currently counted interval; null/absent when stopped. Never task.createdAt. */
  processingStartedAt?: string | null;
}
export interface TaskModeDetail { task: TaskItem; state: TaskModeState; approvals: TaskConversationApproval[]; usage?: TaskUsageSummary }
export interface TaskModeList { tasks: TaskItem[]; states: Array<{ taskId: string; phase: TaskModePhase; settings: TaskModeSettings; instructionCount: number; heartbeat: TaskModeHeartbeat; updatedAt: string; processedDurationMs?: number | null; processingStartedAt?: string | null }>; usage?: Record<string,TaskUsageSummary> }
export interface SubmitTaskInstruction { clientMessageId: string; text: string; timing: "now" | "after"; attachmentIds?: string[]; referenceTaskIds?: string[]; documentIds?: string[] }

export interface TaskModeViewPreferences {
  layout: "board" | "desk" | "document"; board: "status" | "free"; taskOrder: string[]; columnOrder: string[];
  masterWidth: number; executionWidth: number;
  filters: { query: string; status: string; project: string; tag:string; policy: string; material: string; dateField: "createdAt" | "updatedAt" | "completedAt"; period: string; start: string; end: string; sort: string };
}
export const DEFAULT_TASK_MODE_VIEW: TaskModeViewPreferences = {
  layout: "board", board: "status", taskOrder: [], columnOrder: [], masterWidth: 300, executionWidth: 390,
  filters: { query: "", status: "all", project: "all", tag:"", policy: "all", material: "all", dateField: "updatedAt", period: "all", start: "", end: "", sort: "manual" }
};
