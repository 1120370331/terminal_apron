import type {
  TaskConversationDetail,
  TaskConversationItem,
  TaskConversationStatus,
  TaskConversationSummary,
  TaskConversationTurn,
  TaskTurnStatus
} from "../shared/taskConversationTypes.js";

const MAX_TEXT = 200_000;
const MAX_OUTPUT = 80_000;

export function projectThread(raw: unknown, binding: Omit<TaskConversationSummary, "preview" | "status" | "cwd" | "modelProvider">): TaskConversationDetail {
  const thread = object(raw)?.thread ? object(object(raw)?.thread) : object(raw);
  const rawTurns = array(thread?.turns);
  const turns = rawTurns.map(projectTurn);
  const active = turns.find((turn) => turn.status === "in_progress");
  const preview = [...turns].reverse().flatMap((turn) => [...turn.items].reverse()).find((item) => item.kind === "assistant" || item.kind === "user");
  return {
    conversation: {
      ...binding,
      preview: preview && "text" in preview ? truncate(preview.text, 240).text : "",
      status: projectThreadStatus(thread?.status, active),
      cwd: string(thread?.cwd),
      modelProvider: string(thread?.modelProvider),
      activeTurnId: active?.id
    },
    turns
  };
}

export function projectThreadItem(raw: unknown): TaskConversationItem {
  const item = object(raw) ?? {};
  const id = string(item.id) || "unknown";
  const type = string(item.type);
  if(type==="contextCompaction")return {kind:"activity",id,activityType:type,status:item.status==="inProgress"?"in_progress":item.status==="completed"?"completed":undefined,label:item.status==="inProgress"?"Codex 正在自动压缩上下文，任务将继续":item.status==="completed"?"Codex 上下文压缩已完成":"Codex 上下文压缩记录"};
  if (type === "userMessage") return { kind: "user", id, text: truncate(extractText(item), MAX_TEXT).text };
  if (type === "agentMessage") return { kind: "assistant", id, text: truncate(extractText(item), MAX_TEXT).text, phase: item.phase === "commentary" ? "commentary" : "final" };
  if (type === "reasoning") return { kind: "reasoning", id, summary: array(item.summary).map(string).filter(Boolean).slice(0, 50) };
  if (type === "plan") return { kind: "plan", id, text: truncate(extractText(item), MAX_TEXT).text };
  if (type === "commandExecution") {
    const output = truncate(string(item.aggregatedOutput ?? item.output), MAX_OUTPUT);
    return { kind: "command", id, command: commandText(item), cwd: string(item.cwd), status: string(item.status), output: output.text || undefined, outputTruncated: output.truncated || undefined, exitCode: number(item.exitCode), durationMs: number(item.durationMs) };
  }
  if (type === "fileChange") return { kind: "file_change", id, status: string(item.status), paths: array(item.changes).map((change) => string(object(change)?.path)).filter(Boolean).slice(0, 200), changes: array(item.changes).slice(0,200).map(change=>({path:string(object(change)?.path),diff:truncate(string(object(change)?.diff),MAX_OUTPUT).text})) };
  if (type === "mcpToolCall" || type === "dynamicToolCall") return { kind: "tool", id, server: string(item.server ?? item.namespace), tool: string(item.tool), status: string(item.status), summary: truncate(string(item.result ?? item.error), 2_000).text || undefined, durationMs: number(item.durationMs) };
  return { kind: "activity", id, activityType: type || "unknown", label: safeLabel(type || "Codex activity") };
}

function projectTurn(raw: unknown): TaskConversationTurn {
  const turn = object(raw) ?? {};
  return {
    id: string(turn.id) || "unknown",
    status: projectTurnStatus(turn.status),
    startedAt: timestamp(turn.startedAt ?? turn.createdAt),
    completedAt: timestamp(turn.completedAt),
    error: object(turn.error) ? { code: string(object(turn.error)?.code) || "CODEX_TURN_FAILED", message: safeLabel(string(object(turn.error)?.message) || "Codex turn failed"), retryable: false } : undefined,
    items: array(turn.items).map(projectThreadItem)
  };
}

function projectTurnStatus(value: unknown): TaskTurnStatus {
  const status = typeof value === "string" ? value : string(object(value)?.type);
  if (/interrupt/i.test(status)) return "interrupted";
  if (/fail|error/i.test(status)) return "failed";
  if (/complete/i.test(status)) return "completed";
  return "in_progress";
}

function projectThreadStatus(value: unknown, active?: TaskConversationTurn): TaskConversationStatus {
  if (active) return "active";
  const status = typeof value === "string" ? value : string(object(value)?.type);
  if (/error/i.test(status)) return "system_error";
  if (/missing/i.test(status)) return "missing";
  return "idle";
}

function extractText(value: Record<string, unknown>): string {
  if (typeof value.text === "string") return value.text;
  return array(value.content).map((entry) => string(object(entry)?.text ?? entry)).filter(Boolean).join("\n");
}
function commandText(value: Record<string, unknown>): string { return Array.isArray(value.command) ? value.command.map(string).join(" ") : string(value.command); }
function truncate(value: string, limit: number): { text: string; truncated: boolean } { return value.length <= limit ? { text: value, truncated: false } : { text: `${value.slice(0, limit)}\n… output truncated …`, truncated: true }; }
function safeLabel(value: string): string { return truncate(value.replace(/[\r\n]+/g, " "), 500).text; }
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function number(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function timestamp(value: unknown): string | undefined { if (typeof value === "string") return value; if (typeof value === "number") return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString(); return undefined; }
