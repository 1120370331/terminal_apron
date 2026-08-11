import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import type { TerminalSession } from "../shared/types.js";

const CODEX_TITLE_CONFIG = "tui.terminal_title=['session-id']";
const CODEX_THREAD_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{5,12}$/i;
const CODEX_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOLVE_RETRY_DELAYS_MS = [0, 250, 1_000, 3_000, 10_000, 30_000];
const PROMPT_RESOLVE_RETRY_DELAYS_MS = [100, 500, 1_500, 3_000, 8_000];
const INTENT_RESOLVE_RETRY_DELAYS_MS = [100, 300, 800, 1_500, 3_000, 8_000, 15_000];
const INTENT_CLOCK_SKEW_MS = 3_000;
const HISTORY_TAIL_BYTES = 2 * 1024 * 1024;

export type CodexThreadChangeHandler = (threadId: string | null) => void | Promise<void>;
export type CodexThreadIntentKind = "start" | "new" | "fork" | "resume";

export interface CodexLocalThread {
  id: string;
  cwd: string;
  source: string;
  threadSource?: string;
  createdAt: number;
  updatedAt: number;
  recencyAt?: number;
}

export interface CodexThreadIntent {
  kind: CodexThreadIntentKind;
  expectedThreadId?: string;
}

export class CodexTerminalTitleTracker {
  private pending = "";
  private candidatePrefix: string | null = null;
  private retryGeneration = 0;
  private disposed = false;

  constructor(
    private readonly onChange: CodexThreadChangeHandler,
    private readonly codexHome = resolveCodexHome()
  ) {}

  push(data: string): void {
    if (this.disposed || !data) {
      return;
    }

    const combined = `${this.pending}${data}`;
    this.pending = "";
    let cursor = 0;
    while (cursor < combined.length) {
      const titleStart = findOscTitleStart(combined, cursor);
      if (!titleStart) {
        this.pending = incompleteOscPrefix(combined.slice(cursor));
        break;
      }
      const { start, payloadStart } = titleStart;
      const bel = combined.indexOf("\x07", payloadStart);
      const st = combined.indexOf("\x1b\\", payloadStart);
      const end =
        bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
      if (end === -1) {
        this.pending = combined.slice(start);
        return;
      }

      this.handleTitle(combined.slice(payloadStart, end));
      cursor = end + (end === st ? 2 : 1);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.retryGeneration += 1;
    this.pending = "";
    this.candidatePrefix = null;
  }

  private handleTitle(title: string): void {
    const normalized = title.trim();
    const threadPrefix = normalizeThreadPrefix(normalized);
    if (threadPrefix) {
      this.candidatePrefix = threadPrefix;
      this.retryGeneration += 1;
      void this.resolveCandidate(this.retryGeneration).catch((error) => {
        console.warn("Failed to persist Codex thread switch", error);
      });
    }
  }

  private async resolveCandidate(generation: number): Promise<void> {
    for (const delayMs of RESOLVE_RETRY_DELAYS_MS) {
      if (delayMs > 0) {
        await delay(delayMs);
      }
      if (this.disposed || generation !== this.retryGeneration || !this.candidatePrefix) {
        return;
      }
      const resolved = await resolveCodexThreadId(this.candidatePrefix, this.codexHome);
      if (!resolved) {
        continue;
      }
      if (generation === this.retryGeneration && !this.disposed) {
        await this.onChange(resolved);
      }
      return;
    }
  }
}

export function addCodexSessionTrackingToEnvironment(
  env: Record<string, string>,
  runtimeDataDir: string,
  codexBin = "codex"
): Record<string, string> {
  const realCodex = resolveCodexExecutable(codexBin, env);
  if (!realCodex) {
    return env;
  }

  const wrapperDir = path.join(runtimeDataDir, ".terminal-apron", "bin");
  try {
    fs.mkdirSync(wrapperDir, { recursive: true });
    writeCodexWrappers(wrapperDir, realCodex);
  } catch (error) {
    console.warn("Failed to prepare Codex session tracking wrapper", error);
    return env;
  }

  return {
    ...env,
    PATH: [wrapperDir, env.PATH || env.Path || ""].filter(Boolean).join(path.delimiter),
    Path: [wrapperDir, env.Path || env.PATH || ""].filter(Boolean).join(path.delimiter)
  };
}

export type CodexBootstrapFailure =
  | "database-locked"
  | "model-provider-missing"
  | "resume-failed"
  | null;

export function codexResumeCommand(
  threadId: string,
  options: { modelProvider?: string } = {}
): string[] | null {
  if (!CODEX_THREAD_ID.test(threadId)) {
    return null;
  }
  const provider = options.modelProvider?.trim();
  const providerOverride =
    provider && /^[A-Za-z0-9_-]{1,64}$/.test(provider)
      ? ` -c model_provider=${provider}`
      : "";
  if (process.platform === "win32") {
    return [
      process.env.ComSpec || "cmd.exe",
      "/d",
      "/s",
      "/c",
      `codex -c "${CODEX_TITLE_CONFIG}"${providerOverride} resume --yolo ${threadId}`
    ];
  }
  return [
    process.env.SHELL || "/bin/sh",
    "-lc",
    `exec codex -c ${quotePosix(CODEX_TITLE_CONFIG)}${providerOverride} resume --yolo ${quotePosix(threadId)}`
  ];
}

export function isCodexProcessCommand(value: string): boolean {
  const command = value.trim();
  if (!command) {
    return false;
  }
  return (
    /(?:^|[\s"';&|])(?:[^\s"';&|]*[\\/])?codex(?:\.(?:exe|cmd|ps1|js))?(?=$|[\s"';&|])/i.test(command) ||
    /[\\/]@openai[\\/]codex[\\/][^\s"']*codex\.js(?=$|[\s"'])/i.test(command)
  );
}

export function codexThreadIdFromProcessCommand(value: string): string | null {
  if (!isCodexProcessCommand(value)) {
    return null;
  }
  const threadId = value.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
  )?.[0];
  return threadId && CODEX_THREAD_ID.test(threadId) ? threadId.toLowerCase() : null;
}

export function isCodexYoloProcessCommand(value: string): boolean {
  return (
    isCodexProcessCommand(value) &&
    /(?:^|\s)--(?:yolo|dangerously-bypass-approvals-and-sandbox)(?=$|\s)/i.test(value)
  );
}

export async function resolveCodexThreadFromTerminalTitle(
  title: string,
  codexHome = resolveCodexHome()
): Promise<string | null> {
  const candidate =
    title.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{5,12}(?:\.\.\.)?/i
    )?.[0] ?? "";
  return candidate ? resolveCodexThreadId(candidate, codexHome) : null;
}

export function classifyCodexBootstrapFailure(value: string): CodexBootstrapFailure {
  const normalized = value.replace(/\s+/g, " ");
  if (
    /failed to (?:open log DB|initialize sqlite local db)[\s\S]{0,1200}database is\s*locked/i.test(
      normalized
    ) ||
    /another Codex process is using its local data/i.test(normalized)
  ) {
    return "database-locked";
  }
  if (/Model provider [`'"][^`'"]*[`'"] not found/i.test(normalized)) {
    return "model-provider-missing";
  }
  if (
    /thread\/resume failed during TUI bootstrap/i.test(normalized) ||
    /Error:\s*Failed to resume session/i.test(normalized)
  ) {
    return "resume-failed";
  }
  return null;
}

export function codexTerminalTitleMatchesThread(
  title: string,
  threadId: string
): boolean {
  if (!CODEX_THREAD_ID.test(threadId)) {
    return false;
  }
  const candidate =
    title.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{5,12}(?:\.\.\.)?/i
    )?.[0] ?? "";
  const prefix = normalizeThreadPrefix(candidate);
  return Boolean(prefix && threadId.toLowerCase().startsWith(prefix));
}

export async function resolveCodexThreadId(prefix: string, codexHome = resolveCodexHome()): Promise<string | null> {
  const normalized = normalizeThreadPrefix(prefix.trim());
  if (!normalized) {
    return null;
  }
  if (CODEX_THREAD_ID.test(normalized)) {
    return normalized;
  }

  const matches = new Set<string>();
  collectStateDatabaseIds(codexHome, normalized, matches);
  await collectJsonlIds(path.join(codexHome, "session_index.jsonl"), normalized, matches, false);
  await collectJsonlIds(path.join(codexHome, "history.jsonl"), normalized, matches, true);
  return matches.size === 1 ? Array.from(matches)[0] : null;
}

export function parseCodexThreadIntent(
  prompt: string,
  _currentThreadId?: string
): CodexThreadIntent | null {
  const normalized = prompt.trim();
  if (!normalized) {
    return null;
  }

  const slash = /^\/(new|clear|fork|branch|resume)(?:\s|$)/i.exec(normalized)?.[1]?.toLowerCase();
  if (slash === "new" || slash === "clear") {
    return { kind: "new" };
  }
  if (slash === "fork" || slash === "branch") {
    return { kind: "fork" };
  }
  if (slash === "resume") {
    return { kind: "resume" };
  }

  const command = /(?:^|[;&|]\s*|(?:cmd(?:\.exe)?\s+\/[a-z]\s+\/[a-z]\s+\/c\s+)|(?:exec\s+))(?:call\s+)?(?:"[^"]*[\\/]codex(?:\.(?:cmd|exe|ps1))?"|'[^']*[\\/]codex'|codex)(?=\s|$)([\s\S]*)/i.exec(
    normalized
  );
  if (!command) {
    return null;
  }

  const args = command[1] ?? "";
  const resume = /\bresume(?:\s+--[a-z-]+(?:[=\s]\S+)?)?\s+([0-9a-f-]{36})\b/i.exec(args)?.[1];
  if (resume && CODEX_THREAD_ID.test(resume)) {
    return { kind: "resume", expectedThreadId: resume.toLowerCase() };
  }
  const fork = /\bfork(?:\s+--[a-z-]+(?:[=\s]\S+)?)?\s+([0-9a-f-]{36})\b/i.exec(args)?.[1];
  if (fork && CODEX_THREAD_ID.test(fork)) {
    return { kind: "fork", expectedThreadId: fork.toLowerCase() };
  }
  if (/\b(?:fork|branch)\b/i.test(args)) {
    return { kind: "fork" };
  }
  if (/\bresume\b/i.test(args)) {
    return { kind: "resume" };
  }
  return { kind: "start" };
}

export function trackCodexThreadForTerminalPrompt(
  session: Pick<TerminalSession, "id" | "cwd" | "codexThreadId">,
  prompt: string,
  submittedAtMs: number,
  onChange: CodexThreadChangeHandler,
  codexHome = resolveCodexHome()
): boolean {
  const intent = parseCodexThreadIntent(prompt, session.codexThreadId);
  if (intent) {
    void resolveCodexThreadForIntent(
      intent,
      session.cwd,
      session.codexThreadId,
      submittedAtMs,
      codexHome
    )
      .then((threadId) => (threadId ? onChange(threadId) : undefined))
      .catch((error) => {
        console.warn(`Failed to infer Codex thread switch in terminal ${session.id}`, error);
      });
    return true;
  }

  void trackCodexThreadForPrompt(prompt, submittedAtMs, onChange, codexHome).catch((error) => {
    console.warn(`Failed to infer Codex thread from input in terminal ${session.id}`, error);
  });
  return false;
}

export async function resolveCodexThreadForIntent(
  intent: CodexThreadIntent,
  cwd: string,
  currentThreadId: string | undefined,
  submittedAtMs: number,
  codexHome = resolveCodexHome()
): Promise<string | null> {
  const initialThreads = listCodexCliThreads(undefined, codexHome);
  const initialActivity = new Map(
    initialThreads.map((thread) => [thread.id, codexThreadActivity(thread)] as const)
  );
  for (const delayMs of INTENT_RESOLVE_RETRY_DELAYS_MS) {
    await delay(delayMs);
    const thread = selectCodexThreadForIntent(
      intent,
      cwd,
      currentThreadId,
      submittedAtMs,
      listCodexCliThreads(undefined, codexHome),
      initialActivity
    );
    if (thread) {
      return thread.id;
    }
  }
  return null;
}

export function selectCodexThreadForIntent(
  intent: CodexThreadIntent,
  cwd: string,
  currentThreadId: string | undefined,
  submittedAtMs: number,
  threads: readonly CodexLocalThread[],
  initialActivity?: ReadonlyMap<string, number>
): CodexLocalThread | null {
  const currentId = currentThreadId?.toLowerCase();
  if (intent.expectedThreadId) {
    return threads.find((thread) => thread.id === intent.expectedThreadId) ?? null;
  }

  const timestampOf = (thread: CodexLocalThread) =>
    intent.kind === "resume"
      ? Math.max(thread.recencyAt ?? 0, thread.updatedAt)
      : thread.createdAt;
  const candidates = threads.filter((thread) => {
    if (thread.id === currentId) {
      return false;
    }
    const timestamp = timestampOf(thread);
    if (initialActivity?.size) {
      const initialTimestamp = initialActivity.get(thread.id);
      if (intent.kind === "resume") {
        if (initialTimestamp !== undefined && timestamp <= initialTimestamp) {
          return false;
        }
      } else if (initialTimestamp !== undefined) {
        return false;
      }
    }
    return (
      timestamp >= submittedAtMs - INTENT_CLOCK_SKEW_MS &&
      timestamp <= submittedAtMs + INTENT_RESOLVE_RETRY_DELAYS_MS.reduce((sum, value) => sum + value, 0) + 10_000
    );
  });
  const normalizedCwd = normalizeCwd(cwd);
  const sameCwd = candidates.filter((thread) => normalizeCwd(thread.cwd) === normalizedCwd);
  const local = closestThreadToSubmission(sameCwd, timestampOf, submittedAtMs);
  if (local) {
    return local;
  }

  // The shell may have changed directory since the terminal was created.
  // Cross-directory matching is only safe when a single CLI thread appeared.
  return candidates.length === 1 ? candidates[0] : null;
}

function codexThreadActivity(thread: CodexLocalThread): number {
  return Math.max(thread.recencyAt ?? 0, thread.updatedAt, thread.createdAt);
}

function closestThreadToSubmission(
  threads: readonly CodexLocalThread[],
  timestampOf: (thread: CodexLocalThread) => number,
  submittedAtMs: number
): CodexLocalThread | null {
  return (
    [...threads].sort(
      (left, right) =>
        Math.abs(timestampOf(left) - submittedAtMs) - Math.abs(timestampOf(right) - submittedAtMs) ||
        right.updatedAt - left.updatedAt
    )[0] ?? null
  );
}

export function listCodexCliThreads(
  cwd?: string,
  codexHome = resolveCodexHome()
): CodexLocalThread[] {
  const databasePath = path.join(codexHome, "state_5.sqlite");
  if (!fs.existsSync(databasePath)) {
    return [];
  }

  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database
      .prepare(
        `SELECT id, cwd, source, thread_source,
                created_at_ms, updated_at_ms, recency_at_ms,
                created_at, updated_at, recency_at
           FROM threads
          WHERE archived = 0
            AND COALESCE(thread_source, 'user') <> 'subagent'
            AND source NOT LIKE '%"subagent"%'
          ORDER BY MAX(
            COALESCE(recency_at_ms, recency_at * 1000, 0),
            COALESCE(updated_at_ms, updated_at * 1000, 0),
            COALESCE(created_at_ms, created_at * 1000, 0)
          ) DESC
          LIMIT 500`
      )
      .all() as unknown as Array<Record<string, unknown>>;
    const normalizedCwd = cwd ? normalizeCwd(cwd) : null;
    return rows
      .map(toLocalThread)
      .filter((thread): thread is CodexLocalThread => Boolean(thread))
      .filter((thread) => isCliThreadSource(thread.source))
      .filter((thread) => !normalizedCwd || normalizeCwd(thread.cwd) === normalizedCwd);
  } catch {
    return [];
  } finally {
    database?.close();
  }
}

function toLocalThread(row: Record<string, unknown>): CodexLocalThread | null {
  const id = typeof row.id === "string" ? row.id.toLowerCase() : "";
  const cwd = typeof row.cwd === "string" ? normalizeCwd(row.cwd) : "";
  if (!CODEX_THREAD_ID.test(id) || !cwd) {
    return null;
  }
  return {
    id,
    cwd,
    source: typeof row.source === "string" ? row.source : "",
    threadSource: typeof row.thread_source === "string" ? row.thread_source : undefined,
    createdAt: codexTimestamp(row.created_at_ms, row.created_at),
    updatedAt: codexTimestamp(row.updated_at_ms, row.updated_at),
    recencyAt: codexTimestamp(row.recency_at_ms, row.recency_at)
  };
}

function isCliThreadSource(source: string): boolean {
  return source.trim().toLowerCase() === "cli";
}

function codexTimestamp(milliseconds: unknown, seconds: unknown): number {
  const millisecondValue = Number(milliseconds);
  if (Number.isFinite(millisecondValue) && millisecondValue > 0) {
    return millisecondValue;
  }
  const secondValue = Number(seconds);
  return Number.isFinite(secondValue) && secondValue > 0 ? secondValue * 1_000 : 0;
}

export async function trackCodexThreadForPrompt(
  prompt: string,
  submittedAtMs: number,
  onChange: CodexThreadChangeHandler,
  codexHome = resolveCodexHome()
): Promise<void> {
  if (!prompt || prompt.trimStart().startsWith("/")) {
    return;
  }
  for (const delayMs of PROMPT_RESOLVE_RETRY_DELAYS_MS) {
    await delay(delayMs);
    const threadId = await resolveCodexThreadForPrompt(prompt, submittedAtMs, codexHome);
    if (threadId) {
      await onChange(threadId);
      return;
    }
  }
}

export async function resolveCodexThreadForPrompt(
  prompt: string,
  submittedAtMs: number,
  codexHome = resolveCodexHome()
): Promise<string | null> {
  const filePath = path.join(codexHome, "history.jsonl");
  let data = "";
  try {
    const stat = await fs.promises.stat(filePath);
    const start = Math.max(0, stat.size - HISTORY_TAIL_BYTES);
    const handle = await fs.promises.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(stat.size - start);
      const result = await handle.read(buffer, 0, buffer.length, start);
      data = buffer.subarray(0, result.bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }

  const minimumTimestamp = Math.floor(submittedAtMs / 1000) - 3;
  const maximumTimestamp = Math.ceil(submittedAtMs / 1000) + 60;
  const normalizedPrompt = normalizePrompt(prompt);
  const lines = data.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const entry = JSON.parse(lines[index]) as { session_id?: unknown; ts?: unknown; text?: unknown };
      const threadId = typeof entry.session_id === "string" ? entry.session_id.toLowerCase() : "";
      if (
        typeof entry.text === "string" &&
        normalizePrompt(entry.text) === normalizedPrompt &&
        Number(entry.ts) >= minimumTimestamp &&
        Number(entry.ts) <= maximumTimestamp &&
        CODEX_THREAD_ID.test(threadId)
      ) {
        return threadId;
      }
    } catch {
      // A partial first tail line or malformed history entry is not a match.
    }
  }
  return null;
}

function normalizePrompt(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim();
}

function normalizeThreadPrefix(value: string): string | null {
  const normalized = value.trim().replace(/\.{3}$/, "").toLowerCase();
  return CODEX_THREAD_PREFIX.test(normalized) ? normalized : null;
}

function resolveCodexHome(): string {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

function normalizeCwd(value: string): string {
  const withoutDevicePrefix = value.trim().replace(/^\\\\\?\\/, "");
  const resolved = path.resolve(withoutDevicePrefix);
  const withoutTrailingSeparators =
    resolved.length > path.parse(resolved).root.length ? resolved.replace(/[\\/]+$/, "") : resolved;
  return process.platform === "win32" ? withoutTrailingSeparators.toLowerCase() : withoutTrailingSeparators;
}

function collectStateDatabaseIds(codexHome: string, prefix: string, matches: Set<string>): void {
  const databasePath = path.join(codexHome, "state_5.sqlite");
  if (!fs.existsSync(databasePath)) {
    return;
  }
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database
      .prepare(
        `SELECT id
           FROM threads
          WHERE id LIKE ?
            AND archived = 0
            AND COALESCE(thread_source, 'user') <> 'subagent'
            AND source NOT LIKE '%"subagent"%'
          LIMIT 3`
      )
      .all(`${prefix}%`) as unknown as Array<{ id?: unknown }>;
    for (const row of rows) {
      const id = typeof row.id === "string" ? row.id.toLowerCase() : "";
      if (CODEX_THREAD_ID.test(id) && id.startsWith(prefix)) {
        matches.add(id);
      }
    }
  } catch {
    // Older Codex versions may not have state_5.sqlite or the current schema.
  } finally {
    database?.close();
  }
}

async function collectJsonlIds(
  filePath: string,
  prefix: string,
  matches: Set<string>,
  tailOnly: boolean
): Promise<void> {
  let data = "";
  try {
    if (!tailOnly) {
      data = await fs.promises.readFile(filePath, "utf8");
    } else {
      const stat = await fs.promises.stat(filePath);
      const start = Math.max(0, stat.size - HISTORY_TAIL_BYTES);
      const handle = await fs.promises.open(filePath, "r");
      try {
        const buffer = Buffer.alloc(stat.size - start);
        const result = await handle.read(buffer, 0, buffer.length, start);
        data = buffer.subarray(0, result.bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    }
  } catch {
    return;
  }

  for (const line of data.split(/\r?\n/)) {
    const match = line.match(/"(?:id|session_id)"\s*:\s*"([0-9a-f-]{36})"/i);
    const id = match?.[1]?.toLowerCase();
    if (id && CODEX_THREAD_ID.test(id) && id.startsWith(prefix)) {
      matches.add(id);
    }
  }
}

function writeCodexWrappers(wrapperDir: string, realCodex: string): void {
  const shellWrapper = [
    "#!/bin/sh",
    `exec ${quotePosix(realCodex)} -c ${quotePosix(CODEX_TITLE_CONFIG)} "$@"`,
    ""
  ].join("\n");
  const cmdWrapper = [
    "@echo off",
    "setlocal",
    `call "${realCodex.replace(/"/g, "\"\"")}" -c "${CODEX_TITLE_CONFIG}" %*`,
    "exit /b %ERRORLEVEL%",
    ""
  ].join("\r\n");
  const powershellWrapper = [
    `$realCodex = '${realCodex.replace(/'/g, "''")}'`,
    `& $realCodex -c "${CODEX_TITLE_CONFIG}" @args`,
    "exit $LASTEXITCODE",
    ""
  ].join("\r\n");

  writeFileIfChanged(path.join(wrapperDir, "codex"), shellWrapper, 0o755);
  writeFileIfChanged(path.join(wrapperDir, "codex.cmd"), cmdWrapper);
  writeFileIfChanged(path.join(wrapperDir, "codex.ps1"), powershellWrapper);
}

function writeFileIfChanged(filePath: string, content: string, mode?: number): void {
  let current = "";
  try {
    current = fs.readFileSync(filePath, "utf8");
  } catch {
    // Create the wrapper below.
  }
  if (current !== content) {
    fs.writeFileSync(filePath, content, { encoding: "utf8", mode });
  } else if (mode !== undefined) {
    fs.chmodSync(filePath, mode);
  }
}

export function resolveCodexExecutable(command: string, env: Record<string, string>): string | null {
  const expanded = command.trim();
  if (path.isAbsolute(expanded) || expanded.startsWith(".") || expanded.includes("/") || expanded.includes("\\")) {
    const candidate = path.resolve(expanded);
    try {
      return fs.statSync(candidate).isFile() ? candidate : null;
    } catch {
      return null;
    }
  }

  const searchPath = env.PATH || env.Path || "";
  const extensions =
    process.platform === "win32"
      ? [".exe", ".cmd", ".bat", ".ps1", ""]
      : [""];
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory.replace(/^"|"$/g, ""), `${expanded}${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate;
        }
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return null;
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function findOscTitleStart(value: string, fromIndex: number): { start: number; payloadStart: number } | null {
  const match = /\x1b](?:0|1|2);/g;
  match.lastIndex = fromIndex;
  const found = match.exec(value);
  return found ? { start: found.index, payloadStart: found.index + found[0].length } : null;
}

function incompleteOscPrefix(value: string): string {
  for (const prefix of [
    "\x1b]0;",
    "\x1b]1;",
    "\x1b]2;",
    "\x1b]0",
    "\x1b]1",
    "\x1b]2",
    "\x1b]",
    "\x1b"
  ]) {
    if (value.endsWith(prefix)) {
      return prefix;
    }
  }
  return "";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
