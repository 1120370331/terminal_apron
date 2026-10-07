import type { TaskConversationItem } from "../../shared/taskConversationTypes.js";
import type { TaskExecutionJob } from "../../shared/taskModeTypes.js";
import { hasTaskActionGuidance } from "../../shared/taskActionGuidance.js";

export class TaskOutputParseError extends Error {
  constructor(role: TaskExecutionJob["role"]) {
    super(`${({ plan: "任务分工", worker: "Worker 汇报", review: "代理检查结论", steer: "追加指示转发" })[role]}缺少有效的结构化结果，原始消息已保留`);
  }
}

/** A turn can have several final messages; prose and the structured result are separate items. */
export function parseTaskJobOutput(items: TaskConversationItem[], role: TaskExecutionJob["role"]): Record<string, unknown> {
  const messages = items.filter((item): item is Extract<TaskConversationItem, { kind: "assistant" }> => item.kind === "assistant" && item.phase !== "commentary");
  const ordered = [...messages.filter(item => item.phase === "final").reverse(), ...messages.filter(item => item.phase === undefined).reverse()];
  for (const message of ordered) {
    const text = message.text.trim();
    const candidates = [text, ...Array.from(text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi), match => match[1].trim())];
    for (const candidate of candidates) {
      try { const value: unknown = JSON.parse(candidate); if (validOutput(value, role)) return value; }
      catch { /* Keep checking other complete messages; never join unrelated text or invent fields. */ }
    }
  }
  throw new TaskOutputParseError(role);
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const list = (value: unknown, predicate: (item: unknown) => boolean): boolean => Array.isArray(value) && value.every(predicate);

function validOutput(value: unknown, role: TaskExecutionJob["role"]): value is Record<string, unknown> {
  if (!record(value)) return false;
  if (value.userUpdate !== undefined && (typeof value.userUpdate !== "string" || !value.userUpdate.trim())) return false;
  if (role === "plan") return typeof value.understanding === "string" && Array.isArray(value.workers) && value.workers.length > 0 && value.workers.every(worker => record(worker) && typeof worker.name === "string" && typeof worker.objective === "string" && strings(worker.ownedPaths));
  if (role === "steer") return typeof value.understanding === "string" && strings(value.workerIds) && typeof value.instructions === "string"
    && (value.deliveryMode === undefined || ["steer", "reply_only"].includes(String(value.deliveryMode)))
    && (value.deliveryMode !== "reply_only" || value.workerIds.length === 0 && !value.instructions.trim() && Boolean(value.userUpdate || value.understanding.trim()));
  if (role === "review") return ["done", "continue", "blocked", "needs_confirmation"].includes(String(value.status)) && typeof value.summary === "string" && strings(value.risks)
    && (["stopReason", "humanActions", "agentNextSteps"].every(key => value[key] === undefined) || hasTaskActionGuidance({...value,status:value.pauseCategory==="none"&&typeof value.acceptanceReady==="boolean"?(value.acceptanceReady?"done":"in_progress"):value.status==="continue"?"in_progress":value.status} as unknown as Parameters<typeof hasTaskActionGuidance>[0]))
    && (value.acceptanceReady===undefined||typeof value.acceptanceReady==="boolean"&&["none","blocked","unclear_requirement","exception"].includes(String(value.pauseCategory))&&strings(value.remainingWork)&&list(value.nextWorkers,worker=>record(worker)&&typeof worker.workerId==="string"&&typeof worker.name==="string"&&typeof worker.objective==="string"&&strings(worker.ownedPaths)));
  return typeof value.summary === "string" && strings(value.changedFiles) && strings(value.risks) && strings(value.blockers)
    && list(value.verification, check => record(check) && typeof check.command === "string" && ["passed", "failed", "not_run"].includes(String(check.result)) && (check.details === undefined || typeof check.details === "string"))
    && list(value.artifacts, artifact => record(artifact) && typeof artifact.path === "string" && typeof artifact.title === "string");
}
