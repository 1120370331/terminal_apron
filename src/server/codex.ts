import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodexConversationSummary, CodexSessionStatus } from "../shared/types.js";

interface CodexThreadRow {
  id: string;
  cwd: string;
  title: string;
  preview: string;
  first_user_message: string;
  source: string;
  model: string | null;
  tokens_used: number;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  created_at: number;
  updated_at: number;
}

interface CodexStatusThreadRow {
  id: string;
  title: string;
  preview: string;
  first_user_message: string;
  rollout_path: string;
  updated_at_ms: number | null;
  updated_at: number;
}

interface CachedRolloutStatus {
  signature: string;
  status: Omit<CodexSessionStatus, "conversationId" | "conversationTitle">;
}

const RESUMABLE_THREAD_FILTER = `
  COALESCE(thread_source, 'user') <> 'subagent'
  AND source NOT LIKE '%"subagent"%'
`;
const MAX_CONVERSATIONS = 200;
const ROLLOUT_INITIAL_TAIL_BYTES = 512 * 1024;
const ROLLOUT_MAX_TAIL_BYTES = 8 * 1024 * 1024;
const rolloutStatusCache = new Map<string, CachedRolloutStatus>();

export function listCodexConversations(cwd: string): CodexConversationSummary[] {
  const statePath = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "state_5.sqlite");
  const database = new DatabaseSync(statePath, { readOnly: true });
  try {
    const candidates = pathCandidates(cwd);
    const rows = database
      .prepare(
        `SELECT id, cwd, title, preview, first_user_message, source, model, tokens_used,
                created_at_ms, updated_at_ms, created_at, updated_at
           FROM threads
          WHERE archived = 0
            AND ${RESUMABLE_THREAD_FILTER}
            AND (cwd = ? COLLATE NOCASE OR cwd = ? COLLATE NOCASE)
          ORDER BY recency_at_ms DESC, updated_at_ms DESC
          LIMIT ?`
      )
      .all(candidates[0], candidates[1], MAX_CONVERSATIONS) as unknown as CodexThreadRow[];

    return rows.map(toConversationSummary);
  } finally {
    database.close();
  }
}

export function findCodexConversation(cwd: string, conversationId: string): CodexConversationSummary | null {
  return listCodexConversations(cwd).find((conversation) => conversation.id === conversationId) ?? null;
}

export function codexResumeCommand(conversationId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) {
    throw new Error("invalid Codex conversation id");
  }
  return `codex resume ${conversationId} --yolo --no-alt-screen`;
}

export function getCodexSessionStatus(
  cwd: string,
  currentCommand: string,
  processExists: boolean,
  excludedConversationIds: readonly string[] = [],
  minimumConversationCreatedAt?: string
): CodexSessionStatus {
  if (!processExists || !isCodexCommand(currentCommand)) {
    return { state: "stopped", label: "Codex 未启动" };
  }

  const database = new DatabaseSync(codexStatePath(), { readOnly: true });
  try {
    const conversationId = codexConversationIdFromCommand(currentCommand);
    const row = conversationId
      ? (database
          .prepare(
            `SELECT id, title, preview, first_user_message, rollout_path, updated_at_ms, updated_at
              FROM threads
              WHERE id = ? AND ${RESUMABLE_THREAD_FILTER}
              LIMIT 1`
          )
          .get(conversationId) as unknown as CodexStatusThreadRow | undefined)
      : latestThreadForPath(database, cwd, excludedConversationIds, minimumConversationCreatedAt);

    if (!row) {
      return { state: "ready", label: "Codex 空闲" };
    }

    const conversationTitle =
      limitText(compactText(row.title) || compactText(row.preview) || compactText(row.first_user_message), 120) ||
      "未命名对话";
    const rolloutStatus = readRolloutStatus(row.rollout_path);
    return {
      ...rolloutStatus,
      conversationId: row.id,
      conversationTitle,
      updatedAt:
        rolloutStatus.updatedAt ?? timestampToIso(row.updated_at_ms, row.updated_at)
    };
  } catch {
    return { state: "ready", label: "Codex 空闲" };
  } finally {
    database.close();
  }
}

export function parseCodexRolloutStatus(value: string): Omit<CodexSessionStatus, "conversationId" | "conversationTitle"> {
  return parseCodexRolloutTimeline(value).status;
}

function parseCodexRolloutTimeline(value: string): {
  found: boolean;
  status: Omit<CodexSessionStatus, "conversationId" | "conversationTitle">;
} {
  let latest: Omit<CodexSessionStatus, "conversationId" | "conversationTitle"> | null = null;
  for (const line of value.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as {
        timestamp?: string;
        type?: string;
        payload?: Record<string, unknown>;
      };
      const payload = entry.payload;
      const eventType = typeof payload?.type === "string" ? payload.type : "";
      const updatedAt = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
      const turnId = typeof payload?.turn_id === "string" ? payload.turn_id : undefined;

      if (entry.type === "event_msg" && eventType === "task_started") {
        latest = { state: "working", label: "Codex 工作中", turnId, updatedAt };
      } else if (entry.type === "event_msg" && eventType === "task_complete") {
        latest = { state: "ready", label: "Codex 空闲", turnId, updatedAt };
      } else if (entry.type === "event_msg" && eventType === "turn_aborted") {
        const reason = typeof payload?.reason === "string" ? payload.reason : "interrupted";
        latest = {
          state: "error",
          label: "Codex 异常",
          turnId,
          errorCode: reason,
          errorMessage: reason === "interrupted" ? "本轮对话已中断" : `本轮对话异常结束：${reason}`,
          updatedAt
        };
      } else if (isErrorEvent(eventType)) {
        const willRetry = payload?.willRetry === true || payload?.will_retry === true;
        const error = asRecord(payload?.error);
        const errorMessage =
          stringValue(error?.message) || stringValue(payload?.message) || stringValue(payload?.error) || "Codex 发生异常";
        const errorCode = codexErrorCode(error?.codexErrorInfo ?? error?.codex_error_info ?? payload?.codexErrorInfo);
        latest = willRetry
          ? { state: "working", label: "Codex 工作中", turnId, updatedAt }
          : {
              state: "error",
              label: "Codex 异常",
              turnId,
              errorCode,
              errorMessage: limitText(compactText(errorMessage), 300),
              updatedAt
            };
      }
    } catch {
      // A tail read can begin in the middle of a JSON line.
    }
  }
  return {
    found: latest !== null,
    status: latest ?? { state: "ready", label: "Codex 空闲" }
  };
}

function latestThreadForPath(
  database: DatabaseSync,
  cwd: string,
  excludedConversationIds: readonly string[] = [],
  minimumConversationCreatedAt?: string
): CodexStatusThreadRow | undefined {
  const candidates = pathCandidates(cwd);
  const excluded = excludedConversationIds.filter((id) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  );
  const minimumCreatedAt = Date.parse(minimumConversationCreatedAt || "");
  const minimumCondition = Number.isFinite(minimumCreatedAt) ? "AND created_at_ms >= ?" : "";
  const exclusion = excluded.length ? `AND id NOT IN (${excluded.map(() => "?").join(", ")})` : "";
  return database
    .prepare(
      `SELECT id, title, preview, first_user_message, rollout_path, updated_at_ms, updated_at
         FROM threads
        WHERE archived = 0
          AND ${RESUMABLE_THREAD_FILTER}
          AND (cwd = ? COLLATE NOCASE OR cwd = ? COLLATE NOCASE)
          ${minimumCondition}
          ${exclusion}
        ORDER BY recency_at_ms DESC, updated_at_ms DESC
        LIMIT 1`
    )
    .get(
      candidates[0],
      candidates[1],
      ...(Number.isFinite(minimumCreatedAt) ? [minimumCreatedAt] : []),
      ...excluded
    ) as unknown as CodexStatusThreadRow | undefined;
}

function readRolloutStatus(rolloutPath: string): Omit<CodexSessionStatus, "conversationId" | "conversationTitle"> {
  const normalizedPath = rolloutPath.replace(/^\\\\\?\\/, "");
  const stat = fs.statSync(normalizedPath);
  const signature = `${stat.size}:${stat.mtimeMs}`;
  const cached = rolloutStatusCache.get(normalizedPath);
  if (cached?.signature === signature) {
    return cached.status;
  }

  let tailBytes = Math.min(stat.size, ROLLOUT_INITIAL_TAIL_BYTES);
  let status = { state: "ready", label: "Codex 空闲" } as Omit<
    CodexSessionStatus,
    "conversationId" | "conversationTitle"
  >;
  while (tailBytes > 0) {
    const buffer = Buffer.alloc(tailBytes);
    const descriptor = fs.openSync(normalizedPath, "r");
    try {
      fs.readSync(descriptor, buffer, 0, tailBytes, stat.size - tailBytes);
    } finally {
      fs.closeSync(descriptor);
    }
    const text = buffer.toString("utf8");
    const timeline = parseCodexRolloutTimeline(stat.size > tailBytes ? text.slice(text.indexOf("\n") + 1) : text);
    status = timeline.status;
    if (timeline.found || tailBytes >= stat.size) {
      break;
    }
    if (tailBytes >= ROLLOUT_MAX_TAIL_BYTES) {
      status = { state: "working", label: "Codex 工作中", updatedAt: stat.mtime.toISOString() };
      break;
    }
    tailBytes = Math.min(stat.size, tailBytes * 2, ROLLOUT_MAX_TAIL_BYTES);
  }

  rolloutStatusCache.set(normalizedPath, { signature, status });
  if (rolloutStatusCache.size > 500) {
    rolloutStatusCache.delete(rolloutStatusCache.keys().next().value as string);
  }
  return status;
}

function isCodexCommand(value: string): boolean {
  return /(?:^|[\\/\s])codex(?:\.js|\.exe)?(?:\s|$)/i.test(value) || /@openai[\\/]codex/i.test(value);
}

function codexConversationIdFromCommand(value: string): string | null {
  return (
    value.match(
      /\bresume\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
    )?.[1] ?? null
  );
}

function isErrorEvent(value: string): boolean {
  return /^(?:error|stream_error|turn_failed|task_failed)$/i.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function codexErrorCode(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const record = asRecord(value);
  return record ? Object.keys(record)[0] : undefined;
}

function codexStatePath(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "state_5.sqlite");
}

function pathCandidates(value: string): [string, string] {
  const normalized = normalizeWindowsPath(value);
  return [normalized, `\\\\?\\${normalized}`];
}

function normalizeWindowsPath(value: string): string {
  const withoutDevicePrefix = value.trim().replace(/^\\\\\?\\/, "");
  const resolved = path.resolve(withoutDevicePrefix);
  return resolved.length > 3 ? resolved.replace(/[\\/]+$/, "") : resolved;
}

function toConversationSummary(row: CodexThreadRow): CodexConversationSummary {
  const title = compactText(row.title) || compactText(row.first_user_message) || "未命名对话";
  const summarySource = compactText(row.preview) || compactText(row.first_user_message) || title;
  return {
    id: row.id,
    title: limitText(title, 180),
    summary: limitText(summarySource, 360),
    cwd: normalizeWindowsPath(row.cwd),
    source: row.source || "codex",
    model: row.model || undefined,
    tokensUsed: Math.max(0, Number(row.tokens_used) || 0),
    createdAt: timestampToIso(row.created_at_ms, row.created_at),
    updatedAt: timestampToIso(row.updated_at_ms, row.updated_at)
  };
}

function compactText(value: string): string {
  return String(value || "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function limitText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function timestampToIso(milliseconds: number | null, seconds: number): string {
  const value = Number(milliseconds) || Number(seconds) * 1000;
  return new Date(value > 0 ? value : Date.now()).toISOString();
}
