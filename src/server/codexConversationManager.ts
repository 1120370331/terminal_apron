import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { TaskConversationApproval, TaskConversationEvent, TaskConversationModel } from "../shared/taskConversationTypes.js";
import { CodexAppServerClient, type CodexServerRequest } from "./codexAppServerClient.js";
import { projectThreadItem } from "./codexConversationProjection.js";
import type { TaskThreadUsage } from "../shared/taskUsageTypes.js";

const EVENT_RING_LIMIT = 1_000;
const APPROVAL_TTL_MS = 600_000;
export interface CodexConversationManagerOptions { eventRingLimit?: number; approvalTtlMs?: number }

interface PendingApproval { approval: TaskConversationApproval; request: CodexServerRequest; timer: NodeJS.Timeout; generation: number }

export interface CodexDraftToolCall { threadId: string; turnId: string; callId: string; tool: string; namespace?: string | null; arguments: unknown }
export interface CodexDraftToolResult { contentItems: Array<{ type: "inputText"; text: string }>; success: boolean }

export class CodexConversationManager extends EventEmitter {
  private sequence = 0;
  private readonly ring: TaskConversationEvent[] = [];
  private readonly threadTasks = new Map<string, string>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly draftThreads = new Map<string, { draftId: string; tool: (call: CodexDraftToolCall) => Promise<CodexDraftToolResult> }>();

  constructor(readonly client = new CodexAppServerClient({ experimentalApi: true }),private readonly options:CodexConversationManagerOptions={}) {
    super();
    client.on("notification", (event) => this.handleNotification(event as { method: string; params: unknown; generation: number }));
    client.on("serverRequest", (request) => this.handleServerRequest(request as CodexServerRequest));
    client.on("exit", () => {
      this.expireAllApprovals();
      for (const [threadId, binding] of this.draftThreads) this.emit("draftEvent", { draftId: binding.draftId, threadId, eventKind: "manager_unavailable", payload: { code: "CODEX_UNAVAILABLE" } });
    });
    client.on("protocolWarning", (payload) => this.publish({ kind: "warning", taskId: "", payload: payload as Record<string, unknown> }));
  }

  bindThread(taskId: string, threadId: string): void {
    if (this.draftThreads.has(threadId)) throw new Error("Thread already belongs to a draft");
    this.threadTasks.set(threadId, taskId);
  }
  unbindThread(threadId: string): void { this.threadTasks.delete(threadId); }
  bindDraftThread(draftId: string, threadId: string, tool: (call: CodexDraftToolCall) => Promise<CodexDraftToolResult>): void {
    if (this.threadTasks.has(threadId)) throw new Error("Thread already belongs to a task");
    const prior = this.draftThreads.get(threadId);
    if (prior && prior.draftId !== draftId) throw new Error("Thread already belongs to another draft");
    this.draftThreads.set(threadId, { draftId, tool });
  }
  unbindDraftThread(threadId: string): void { this.draftThreads.delete(threadId); }
  notifyUsage(taskId: string, threadId: string, usage: TaskThreadUsage): void {
    if (this.threadTasks.get(threadId) !== taskId) return;
    this.publish({ kind: "token_usage_updated", taskId, threadId, payload: { usage, cached: true } });
  }
  eventsAfter(sequence: number, taskId: string): { events: TaskConversationEvent[]; gap: boolean } {
    const floor = this.ring[0]?.sequence ?? this.sequence + 1;
    return { gap: sequence > this.sequence || sequence > 0 && sequence < floor - 1, events: this.ring.filter((event) => event.sequence > sequence && event.taskId === taskId) };
  }

  async request<T>(method: string, params?: unknown): Promise<T> { return this.client.request<T>(method, params); }
  pendingApprovals(taskId: string, threadId: string): TaskConversationApproval[] {
    return [...this.approvals.values()]
      .map((entry) => entry.approval)
      .filter((approval) => approval.taskId === taskId && approval.threadId === threadId);
  }
  async models(): Promise<TaskConversationModel[]> {
    const raw = await this.request<unknown>("model/list", {});
    const models = array(object(raw)?.data ?? object(raw)?.models ?? raw);
    return models.map((entry) => {
      const model = object(entry) ?? {};
      const id = string(model.id ?? model.model);
      const efforts = array(model.supportedReasoningEfforts ?? model.efforts).map((effort) => string(object(effort)?.reasoningEffort ?? effort)).filter(isEffort);
      return { id, displayName: string(model.displayName) || id, isDefault: Boolean(model.isDefault), efforts, defaultEffort: efforts.find((value) => value === string(model.defaultReasoningEffort)) };
    }).filter((model) => model.id);
  }

  resolveApproval(token: string, taskId: string, threadId: string, decision: "accept" | "accept_for_session" | "decline"): void {
    const pending = this.approvals.get(token);
    if (!pending || pending.approval.taskId !== taskId || pending.approval.threadId !== threadId) throw new Error("APPROVAL_STALE");
    if (pending.generation !== this.client.currentGeneration || Date.parse(pending.approval.expiresAt) <= Date.now()) { this.expireApproval(token); throw new Error("APPROVAL_STALE"); }
    clearTimeout(pending.timer); this.approvals.delete(token);
    const mapped = decision === "accept_for_session" ? "acceptForSession" : decision;
    pending.request.reply({ decision: mapped });
    this.publish({ kind: "approval_resolved", taskId, threadId, turnId: pending.approval.turnId, itemId: pending.approval.itemId, payload: { token, resolution: decision } });
  }

  close(): void { this.expireAllApprovals(); this.client.close(); }

  private handleNotification(event: { method: string; params: unknown }): void {
    const params = object(event.params) ?? {};
    const threadId = string(params.threadId ?? object(params.thread)?.id);
    const draft = this.draftThreads.get(threadId);
    if (draft) {
      const eventKind = notificationKind(event.method);
      if (eventKind) this.emit("draftEvent", { draftId: draft.draftId, threadId, eventKind, turnId: string(params.turnId ?? object(params.turn)?.id) || undefined, itemId: string(params.itemId ?? object(params.item)?.id) || undefined, payload: projectEventPayload(event.method, params) });
      return;
    }
    const taskId = this.threadTasks.get(threadId);
    if (!taskId) return;
    const kind = notificationKind(event.method);
    if (!kind) return;
    this.publish({ kind, taskId, threadId, turnId: string(params.turnId ?? object(params.turn)?.id) || undefined, itemId: string(params.itemId ?? object(params.item)?.id) || undefined, payload: projectEventPayload(event.method, params) });
  }

  private handleServerRequest(request: CodexServerRequest): void {
    const params = object(request.params) ?? {};
    const threadId = string(params.threadId);
    const draft = this.draftThreads.get(threadId);
    if (draft) {
      if (request.method === "item/tool/call") {
        if (!string(params.callId) || !string(params.turnId) || !string(params.tool)) { request.reject(-32602, "Invalid dynamic tool call"); return; }
        void draft.tool(params as unknown as CodexDraftToolCall).then(result => request.reply(result), () => request.reply({ contentItems: [{ type: "inputText", text: "Draft tool unavailable" }], success: false }));
      } else if (request.method === "item/tool/requestUserInput") request.reply({ answers: {} });
      else if (request.method === "item/permissions/requestApproval") request.reply({ permissions: {}, scope: "turn", strictAutoReview: true });
      else if (request.method === "mcpServer/elicitation/request") request.reply({ action: "cancel", content: null, _meta: null });
      else if (/Approval$/.test(request.method)) request.reply({ decision: "decline" });
      else request.reject(-32601, "Draft sessions support only controlled requirement tools");
      return;
    }
    const taskId = this.threadTasks.get(threadId);
    if (!taskId) { request.reject(-32602, "Unbound conversation"); return; }
    if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
      const token = crypto.randomBytes(32).toString("base64url");
      const requestedAt = new Date(); const approvalTtlMs=this.options.approvalTtlMs??APPROVAL_TTL_MS;const expiresAt = new Date(requestedAt.getTime() + approvalTtlMs);
      const kind = request.method.includes("commandExecution") ? "command" : "file_change";
      const approval: TaskConversationApproval = {
        token, kind, taskId, threadId, turnId: string(params.turnId), itemId: string(params.itemId), requestedAt: requestedAt.toISOString(), expiresAt: expiresAt.toISOString(), source: "codex_app_server", decisions: ["accept", "accept_for_session", "decline"],
        command: kind === "command" ? { argv: array(params.command).map(string), display: array(params.command).map(string).join(" ") || string(params.command), cwd: string(params.cwd), reason: string(params.reason) || undefined } : undefined,
        fileChange: kind === "file_change" ? { paths: array(params.paths ?? params.changes).map((entry) => string(object(entry)?.path ?? entry)).filter(Boolean), reason: string(params.reason) || undefined } : undefined
      };
      const timer = setTimeout(() => this.expireApproval(token), approvalTtlMs); timer.unref();
      this.approvals.set(token, { approval, request, timer, generation: this.client.currentGeneration });
      this.publish({ kind: "approval_requested", taskId, threadId, turnId: approval.turnId, itemId: approval.itemId, payload: approval as unknown as Record<string, unknown> });
      return;
    }
    if (request.method === "item/permissions/requestApproval") { request.reply({ permissions: {}, scope: "turn", strictAutoReview: true }); this.warning(taskId, threadId, request.method); return; }
    if (request.method === "item/tool/requestUserInput") { request.reply({ answers: {} }); this.warning(taskId, threadId, request.method); return; }
    if (request.method === "mcpServer/elicitation/request") { request.reply({ action: "cancel", content: null, _meta: null }); this.warning(taskId, threadId, request.method); return; }
    if (request.method === "item/tool/call") { request.reply({ contentItems: [], success: false }); this.warning(taskId, threadId, request.method); return; }
    if (request.method === "applyPatchApproval" || request.method === "execCommandApproval") { request.reply({ decision: "decline" }); this.warning(taskId, threadId, request.method); return; }
    request.reject(-32601, "Method not supported by Terminal Apron"); this.warning(taskId, threadId, request.method);
  }

  private warning(taskId: string, threadId: string, method: string): void { this.publish({ kind: "warning", taskId, threadId, payload: { code: "UNSUPPORTED_SERVER_REQUEST", method } }); }
  private expireApproval(token: string): void {
    const pending = this.approvals.get(token); if (!pending) return;
    clearTimeout(pending.timer); this.approvals.delete(token);
    if (pending.generation === this.client.currentGeneration) pending.request.reply({ decision: "cancel" });
    this.publish({ kind: "approval_resolved", taskId: pending.approval.taskId, threadId: pending.approval.threadId, turnId: pending.approval.turnId, itemId: pending.approval.itemId, payload: { token, resolution: "expired" } });
  }
  private expireAllApprovals(): void { for (const token of [...this.approvals.keys()]) this.expireApproval(token); }
  private publish(input: Omit<TaskConversationEvent, "sequence" | "occurredAt">): void {
    const event = { ...input, sequence: ++this.sequence, occurredAt: new Date().toISOString() };
    this.ring.push(event); if (this.ring.length > (this.options.eventRingLimit??EVENT_RING_LIMIT)) this.ring.shift(); this.emit("event", event);
  }
}

function notificationKind(method: string): TaskConversationEvent["kind"] | undefined {
  if (method === "thread/tokenUsage/updated") return "token_usage_updated";
  if (method === "turn/started") return "turn_started"; if (method === "turn/completed") return "turn_completed";
  if (method === "item/started") return "item_started"; if (method === "item/completed") return "item_completed";
  if (method === "item/agentMessage/delta") return "assistant_delta"; if (method === "item/plan/delta") return "plan_delta";
  if (method.includes("command") && method.endsWith("outputDelta")) return "command_output_delta";
  if (method.startsWith("item/fileChange/")) return "file_change_delta"; if (method === "thread/status/changed") return "thread_status";
  if (method === "guardianWarning") return "warning";
  if (method === "warning" || method === "error") return method; return undefined;
}
function projectEventPayload(method: string, params: Record<string, unknown>): Record<string, unknown> {
  if (method === "error") {
    const error = object(params.error) ?? {};
    return { code: string(error.codexErrorInfo ?? error.code) || "CODEX_ERROR", message: string(error.message ?? params.message).slice(0, 2000), retryable: params.willRetry === true };
  }
  if (method === "thread/tokenUsage/updated") {
    const total = object(object(params.tokenUsage)?.total) ?? {};
    return { tokenUsage: { total: Object.fromEntries(["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens"].filter(key => typeof total[key] === "number" && Number.isFinite(total[key]) && Number(total[key]) >= 0).map(key => [key, total[key]])) } };
  }
  if (method === "guardianWarning") return { code: "CODEX_AUTO_REVIEW_WARNING", message: string(params.message).slice(0, 2000) };
  if (method.endsWith("/delta") || method.endsWith("Delta")) return { delta: string(params.delta).slice(0, 80_000) };
  if (params.item) { const item=object(params.item);return {item:projectThreadItem(item?.type==="contextCompaction"?{...item,status:method==="item/started"?"inProgress":"completed"}:params.item)}; }
  if (params.turn) return { turn: object(params.turn) };
  return { status: typeof params.status === "string" ? params.status : object(params.status)?.type };
}
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function isEffort(value: string): value is TaskConversationModel["efforts"][number] { return ["minimal","low","medium","high","xhigh"].includes(value); }
