import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Headless from "@xterm/headless";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SessionInputMode, SessionRuntime, TerminalSession } from "../shared/types.js";
import { config } from "./config.js";
import {
  classifyCodexBootstrapFailure,
  codexResumeCommand,
  codexTerminalTitleMatchesThread,
  codexThreadIdFromProcessCommand,
  isCodexProcessCommand,
  isCodexYoloProcessCommand,
  resolveCodexThreadFromTerminalTitle
} from "./codexSessions.js";
import { loadPty } from "./pty.js";
import {
  DISABLED_TERMINAL_PROXY,
  terminalProcessEnvironment,
  type TerminalProxyConfig
} from "./terminalProxy.js";

interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
}

interface ZellijPane {
  id?: number;
  pane_id?: number;
  focused?: boolean;
  is_focused?: boolean;
  is_plugin?: boolean;
  exited?: boolean;
  is_held?: boolean;
  pane_rows?: number;
  pane_content_rows?: number;
  pane_columns?: number;
  pane_content_columns?: number;
  pane_cwd?: string;
  current_working_directory?: string;
  command?: string | string[] | { name?: string; args?: string[] };
  pane_command?: string | string[] | { name?: string; args?: string[] };
  terminal_command?: string | string[] | { name?: string; args?: string[] };
  title?: string;
}

type ZellijSessionSpec = Pick<TerminalSession, "tmuxName" | "cwd" | "shell"> &
  Partial<Pick<TerminalSession, "codexThreadId">>;

export interface ZellijCodexProcessState {
  running: boolean;
  yolo: boolean;
  threadId: string | null;
  command: string;
  title: string;
}

const ZELLIJ_SINGLE_PANE_LAYOUT = ["layout {", "    pane", "}"].join("\n");
const VIEWPORT_PREVIEW_TTL_MS = 600;
const VIEWPORT_PREVIEW_STALE_MS = 30_000;
const ZELLIJ_SESSION_LIST_TTL_MS = 3_000;
const ZELLIJ_VERSION_TTL_MS = 60_000;
const ZELLIJ_RUNTIME_CACHE_TTL_MS = 10_000;
const ZELLIJ_PREVIEW_MIN_COLS = 120;
const DEFAULT_PASTE_SUBMIT_DELAY_MS = 120;
const MIN_ATTACH_HISTORY_LINES = 5_000;
const ZELLIJ_SERIALIZATION_INTERVAL_SECONDS = 30;
const ZELLIJ_BOOTSTRAP_TIMEOUT_MS = 8_000;
const ZELLIJ_BOOTSTRAP_OBSERVE_MS = 4_000;
const CODEX_LOCK_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 12_000];
const CODEX_GRACEFUL_EXIT_TIMEOUT_MS = 2_500;
const CODEX_INTERRUPT_EXIT_TIMEOUT_MS = 2_500;
const CODEX_INTERRUPT_ATTEMPTS = 2;
const ZELLIJ_MAINTENANCE_DELAY_MS = 1_500;

const zellijMaintenanceTimers = new Map<string, NodeJS.Timeout>();

interface PreviewCacheEntry {
  value: string;
  capturedAt: number;
  inFlight?: Promise<string>;
}

interface RuntimeCacheEntry {
  value: SessionRuntime;
  capturedAt: number;
  inFlight?: Promise<SessionRuntime>;
}

const viewportPreviewCache = new Map<string, PreviewCacheEntry>();
const runtimeInfoCache = new Map<string, RuntimeCacheEntry>();
let sessionListCache: { value: string[]; capturedAt: number; inFlight?: Promise<string[]> } | null = null;
let zellijVersionCache: { value: string; capturedAt: number; inFlight?: Promise<string> } | null = null;
// Codex instances share one local SQLite store, so resurrected sessions must not initialize in parallel.
let zellijBootstrapQueue: Promise<void> = Promise.resolve();

function runZellij(args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      config.zellijBin,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 8000,
        maxBuffer: options.maxBufferBytes ?? 1024 * 1024 * 64
      },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error([stderr, stdout, error.message].filter(Boolean).join("\n"));
          reject(wrapped);
          return;
        }
        resolve({ stdout, stderr });
      }
    );

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
  });
}

export async function zellijVersion(): Promise<string> {
  const now = Date.now();
  if (zellijVersionCache?.value && now - zellijVersionCache.capturedAt < ZELLIJ_VERSION_TTL_MS) {
    return zellijVersionCache.value;
  }
  if (zellijVersionCache?.inFlight) {
    return zellijVersionCache.inFlight;
  }

  const inFlight = runZellij(["--version"], { timeoutMs: 3000 })
    .then((result) => {
      const value = result.stdout.trim();
      zellijVersionCache = { value, capturedAt: Date.now() };
      return value;
    })
    .catch((error) => {
      zellijVersionCache = null;
      throw error;
    });
  zellijVersionCache = { value: zellijVersionCache?.value ?? "", capturedAt: zellijVersionCache?.capturedAt ?? 0, inFlight };
  return inFlight;
}

export async function zellijHealth(): Promise<{ available: boolean; version?: string; error?: string }> {
  try {
    return { available: true, version: await zellijVersion() };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function hasZellijSession(name: string): Promise<boolean> {
  return (await listZellijSessions()).includes(name);
}

export async function ensureZellijSession(
  session: ZellijSessionSpec,
  proxy: TerminalProxyConfig = DISABLED_TERMINAL_PROXY
): Promise<void> {
  if (await hasZellijSession(session.tmuxName)) {
    scheduleZellijSessionMaintenance(session.tmuxName);
    return;
  }

  await queueZellijBootstrap(async () => {
    if (await hasZellijSession(session.tmuxName)) {
      return;
    }
    await bootstrapZellijSession(session, await hasExitedZellijSession(session.tmuxName), proxy);
    invalidateZellijSessionListCache();
  });
  invalidateZellijSessionListCache();
  runtimeInfoCache.delete(session.tmuxName);
  scheduleZellijSessionMaintenance(session.tmuxName);
}

export async function killZellijSession(session: Pick<TerminalSession, "tmuxName">): Promise<void> {
  cancelZellijSessionMaintenance(session.tmuxName);
  if (!(await hasZellijSession(session.tmuxName))) {
    return;
  }

  await runZellij(["kill-session", session.tmuxName], { timeoutMs: 5000 }).catch(() =>
    runZellij(["kill-sessions", session.tmuxName], { timeoutMs: 5000 })
  );
  await runZellij(["delete-session", session.tmuxName], { timeoutMs: 5000 }).catch(() => undefined);
  invalidateZellijSessionListCache();
  runtimeInfoCache.delete(session.tmuxName);
}

export async function restartZellijSession(
  session: ZellijSessionSpec,
  proxy: TerminalProxyConfig = DISABLED_TERMINAL_PROXY
): Promise<void> {
  cancelZellijSessionMaintenance(session.tmuxName);
  await queueZellijBootstrap(async () => {
    if (await hasZellijSession(session.tmuxName)) {
      await saveZellijSessionState(session.tmuxName).catch(() => undefined);
      await runZellij(["kill-session", session.tmuxName], { timeoutMs: 5000 });
      invalidateZellijSessionListCache();
    }
    const resurrecting = await hasExitedZellijSession(session.tmuxName);
    await bootstrapZellijSession(session, resurrecting, proxy);
    invalidateZellijSessionListCache();
  });
  runtimeInfoCache.delete(session.tmuxName);
  scheduleZellijSessionMaintenance(session.tmuxName);
}

export async function zellijCodexProcessState(
  session: Pick<TerminalSession, "tmuxName">
): Promise<ZellijCodexProcessState> {
  if (!(await hasZellijSession(session.tmuxName))) {
    return { running: false, yolo: false, threadId: null, command: "", title: "" };
  }
  const pane = await activeTerminalPane(session.tmuxName).catch(() => null);
  const command = formatCommand(pane?.terminal_command ?? pane?.pane_command ?? pane?.command);
  const title = pane?.title ?? "";
  const running = Boolean(pane && !pane.exited && isCodexProcessCommand(command));
  return {
    running,
    yolo: running && isCodexYoloProcessCommand(command),
    threadId: running
      ? codexThreadIdFromProcessCommand(command) ??
        (await resolveCodexThreadFromTerminalTitle(title).catch(() => null))
      : null,
    command,
    title
  };
}

export async function stopZellijCodexProcess(
  session: Pick<TerminalSession, "tmuxName">
): Promise<{ stopped: boolean; forced: boolean }> {
  const initial = await zellijCodexProcessState(session);
  if (!initial.running) {
    return { stopped: true, forced: false };
  }

  const paneId = await activeTerminalPaneId(session.tmuxName);
  const target = paneId ? ["--pane-id", paneId] : [];
  await writeZellijChars(session.tmuxName, target, "/exit");
  await delay(120);
  await sendZellijEnter(session.tmuxName, target);
  if (await waitForZellijCodexExit(session, CODEX_GRACEFUL_EXIT_TIMEOUT_MS)) {
    return { stopped: true, forced: false };
  }

  for (let attempt = 0; attempt < CODEX_INTERRUPT_ATTEMPTS; attempt += 1) {
    const currentPaneId = await activeTerminalPaneId(session.tmuxName);
    const currentTarget = currentPaneId ? ["--pane-id", currentPaneId] : [];
    await sendZellijInterrupt(session.tmuxName, currentTarget);
    if (await waitForZellijCodexExit(session, CODEX_INTERRUPT_EXIT_TIMEOUT_MS)) {
      return { stopped: true, forced: true };
    }
  }

  return { stopped: false, forced: true };
}

export async function saveZellijSessionState(sessionName: string): Promise<void> {
  if (!(await hasZellijSession(sessionName))) {
    return;
  }

  await runZellij(["--session", sessionName, "action", "save-session"], { timeoutMs: 5000 });
}

export async function captureZellijPreview(
  session: Pick<TerminalSession, "id" | "tmuxName">,
  lines = 500,
  full = true,
  dataDir = config.dataDir
): Promise<string> {
  if (!full) {
    return captureZellijViewportPreview(session, lines, dataDir);
  }

  if (!(await hasZellijSession(session.tmuxName))) {
    return renderPlainTranscript(await loadZellijTranscript(dataDir, session.id), lines);
  }

  const paneId = await activeTerminalPaneId(session.tmuxName).catch(() => null);
  const args = ["--session", session.tmuxName, "action", "dump-screen", "--ansi"];
  if (full) {
    args.push("--full");
  }
  if (paneId) {
    args.push("--pane-id", paneId);
  }
  const result = await runZellij(args, {
    timeoutMs: 5000
  }).catch(() => ({ stdout: "", stderr: "" }));
  const rendered = tailRawLines(result.stdout, Math.max(20, Math.min(lines, config.previewMaxLines)));
  return rendered.trim() ? rendered : renderPlainTranscript(await loadZellijTranscript(dataDir, session.id), lines);
}

async function captureZellijViewportPreview(
  session: Pick<TerminalSession, "id" | "tmuxName">,
  lines: number,
  dataDir: string
): Promise<string> {
  const cacheKey = `${path.resolve(dataDir)}:${session.tmuxName}:${lines}`;
  const cached = viewportPreviewCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.capturedAt < VIEWPORT_PREVIEW_TTL_MS) {
    return cached.value;
  }
  if (cached?.inFlight) {
    if (cached.value && now - cached.capturedAt < VIEWPORT_PREVIEW_STALE_MS) {
      return cached.value;
    }
    return cached.inFlight;
  }

  const inFlight = captureZellijViewportPreviewFresh(session, lines, dataDir)
    .then((value) => {
      viewportPreviewCache.set(cacheKey, { value, capturedAt: Date.now() });
      return value;
    })
    .catch((error) => {
      if (cached?.value) {
        viewportPreviewCache.set(cacheKey, { value: cached.value, capturedAt: cached.capturedAt });
        return cached.value;
      }
      viewportPreviewCache.delete(cacheKey);
      throw error;
    });

  viewportPreviewCache.set(cacheKey, {
    value: cached?.value ?? "",
    capturedAt: cached?.capturedAt ?? 0,
    inFlight
  });
  return inFlight;
}

async function captureZellijViewportPreviewFresh(
  session: Pick<TerminalSession, "id" | "tmuxName">,
  lines: number,
  dataDir: string
): Promise<string> {
  const paneId = await activeTerminalPaneId(session.tmuxName).catch(() => null);
  const args = ["--session", session.tmuxName, "action", "dump-screen", "--ansi"];
  if (paneId) {
    args.push("--pane-id", paneId);
  }
  const result = await runZellij(args, {
    timeoutMs: 2500
  }).catch(() => ({ stdout: "", stderr: "" }));
  const rendered = result.stdout || "";
  return rendered.trim() ? rendered : renderPlainTranscript(await loadZellijTranscript(dataDir, session.id), lines);
}

export async function zellijPreviewSize(
  session: Pick<TerminalSession, "tmuxName">
): Promise<{ cols: number; rows: number } | undefined> {
  if (!(await hasZellijSession(session.tmuxName))) {
    return undefined;
  }

  const pane = await activeTerminalPane(session.tmuxName).catch(() => null);
  if (!pane) {
    return undefined;
  }

  const cols = clampSize(pane.pane_content_columns ?? pane.pane_columns, ZELLIJ_PREVIEW_MIN_COLS, 600);
  const rows = clampSize(pane.pane_content_rows ?? pane.pane_rows, 10, 300);
  if (!cols || !rows) {
    return undefined;
  }
  return { cols, rows };
}

export function appendZellijTranscript(sessionId: string, data: string, dataDir = config.dataDir): Promise<void> {
  return appendTranscript(zellijTranscriptPath(dataDir, sessionId), data, config.nativeHistoryBytes);
}

export async function captureZellijAttachHistory(
  session: Pick<TerminalSession, "id" | "tmuxName">,
  dataDir = config.dataDir,
  lines = config.terminalAttachHistoryLines
): Promise<string> {
  const linesToKeep = Math.max(MIN_ATTACH_HISTORY_LINES, Math.min(config.zellijScrollback, Math.floor(lines)));
  const transcript = stripZellijHistoryHidingSequences(
    tailRawLines(await loadZellijTranscript(dataDir, session.id, linesToKeep), linesToKeep)
  );
  if (countRawLines(transcript) >= linesToKeep) {
    return transcript;
  }

  if (await hasZellijSession(session.tmuxName)) {
    const paneId = await activeTerminalPaneId(session.tmuxName).catch(() => null);
    const args = ["--session", session.tmuxName, "action", "dump-screen", "--ansi", "--full"];
    if (paneId) {
      args.push("--pane-id", paneId);
    }
    const result = await runZellij(args, {
      timeoutMs: 8000,
      maxBufferBytes: Math.max(1024 * 1024 * 16, config.nativeHistoryBytes + 1024 * 1024)
    }).catch(() => ({ stdout: "", stderr: "" }));
    const output = stripZellijHistoryHidingSequences(tailRawLines(result.stdout, linesToKeep));
    if (output.trim()) {
      return longerHistory(output, transcript);
    }
  }
  return transcript;
}

export async function sendZellijInput(
  session: Pick<TerminalSession, "tmuxName" | "cwd" | "shell">,
  data: string,
  enter = false,
  options: { mode?: SessionInputMode; submitDelayMs?: number; proxy?: TerminalProxyConfig } = {}
): Promise<void> {
  await ensureZellijSession(session, options.proxy);
  if (!(await hasZellijSession(session.tmuxName))) {
    throw new Error("zellij session is not running yet; open the terminal once before sending inline input");
  }
  const paneId = await activeTerminalPaneId(session.tmuxName).catch(() => null);
  const target = paneId ? ["--pane-id", paneId] : [];
  if (options.mode === "type") {
    await writeZellijChars(session.tmuxName, target, data);
  } else {
    await pasteZellijText(session.tmuxName, target, data);
  }
  if (!enter) {
    void saveZellijSessionState(session.tmuxName).catch(() => undefined);
    return;
  }
  await delay(
    normalizeSubmitDelayMs(
      options.submitDelayMs,
      options.mode === "type" ? 0 : DEFAULT_PASTE_SUBMIT_DELAY_MS
    )
  );
  await sendZellijEnter(session.tmuxName, target);
  void saveZellijSessionState(session.tmuxName).catch(() => undefined);
}

export async function zellijRuntimeInfo(session: TerminalSession): Promise<SessionRuntime> {
  const value = await zellijRuntimeInfoFresh(session);
  runtimeInfoCache.set(session.tmuxName, { value, capturedAt: Date.now() });
  return value;
}

export async function zellijRuntimeSnapshot(session: TerminalSession): Promise<SessionRuntime> {
  const key = session.tmuxName;
  const cached = runtimeInfoCache.get(key);
  const now = Date.now();
  if (cached && now - cached.capturedAt < ZELLIJ_RUNTIME_CACHE_TTL_MS) {
    return cached.value;
  }

  if (!cached?.inFlight) {
    const fallback = cached?.value ?? (await lightweightZellijRuntimeInfo(session));
    const inFlight = zellijRuntimeInfoFresh(session)
      .then((value) => {
        runtimeInfoCache.set(key, { value, capturedAt: Date.now() });
        return value;
      })
      .catch((error) => {
        if (cached?.value) {
          runtimeInfoCache.set(key, { value: cached.value, capturedAt: cached.capturedAt });
          return cached.value;
        }
        runtimeInfoCache.delete(key);
        throw error;
      });

    runtimeInfoCache.set(key, { value: fallback, capturedAt: cached?.capturedAt ?? 0, inFlight });
    return fallback;
  }

  return cached.value;
}

async function zellijRuntimeInfoFresh(session: TerminalSession): Promise<SessionRuntime> {
  if (!(await hasZellijSession(session.tmuxName))) {
    return {
      exists: false,
      backend: "zellij",
      persistent: true,
      attached: 0,
      currentPath: session.cwd,
      currentCommand: "",
      windows: 0,
      lastAttached: null,
      zellijVersion: await zellijVersion().catch(() => undefined)
    };
  }

  const panes = await listZellijPanes(session.tmuxName).catch(() => []);
  const terminalPanes = panes.filter((pane) => !pane.is_plugin);
  const focused = terminalPanes.find((pane) => pane.focused || pane.is_focused) ?? terminalPanes[0] ?? panes[0];
  return {
    exists: true,
    backend: "zellij",
    persistent: true,
    attached: 0,
    currentPath: focused?.pane_cwd ?? focused?.current_working_directory ?? session.cwd,
    currentCommand: formatCommand(focused?.terminal_command ?? focused?.pane_command ?? focused?.command) || focused?.title || "",
    windows: Math.max(1, terminalPanes.length || 1),
    lastAttached: null,
    zellijVersion: await zellijVersion().catch(() => undefined)
  };
}

async function lightweightZellijRuntimeInfo(session: TerminalSession): Promise<SessionRuntime> {
  const exists = await hasZellijSession(session.tmuxName).catch(() => false);
  return {
    exists,
    backend: "zellij",
    persistent: true,
    attached: 0,
    currentPath: session.cwd,
    currentCommand: "",
    windows: exists ? 1 : 0,
    lastAttached: null
  };
}

export function zellijAttachArgs(session: Pick<TerminalSession, "tmuxName" | "cwd" | "shell">): string[] {
  return [
    "--layout-string",
    ZELLIJ_SINGLE_PANE_LAYOUT,
    "attach",
    "--create",
    "--force-run-commands",
    session.tmuxName,
    ...zellijOptions(session)
  ];
}

export function zellijAttachCommand(session: Pick<TerminalSession, "tmuxName">): string {
  return `${quoteCommand(config.zellijBin)} attach ${quoteCommand(session.tmuxName)}`;
}

async function listZellijSessions(): Promise<string[]> {
  const now = Date.now();
  if (sessionListCache && now - sessionListCache.capturedAt < ZELLIJ_SESSION_LIST_TTL_MS) {
    return sessionListCache.value;
  }
  if (sessionListCache?.inFlight) {
    return sessionListCache.inFlight;
  }

  const inFlight = runZellij(["list-sessions"], { timeoutMs: 5000 })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/no active zellij sessions|no active sessions|no sessions/i.test(message)) {
        return { stdout: "", stderr: "" };
      }
      throw error;
    })
    .then((result) => {
      const value = result.stdout
        .split(/\r?\n/)
        .map(stripAnsi)
        .map((line) => line.trim())
        .filter((line) => line && !/\(EXITED\b/i.test(line))
        .map((line) => line.split(/\s+/)[0])
        .filter(Boolean);
      sessionListCache = { value, capturedAt: Date.now() };
      return value;
    })
    .catch((error) => {
      sessionListCache = null;
      throw error;
    });

  sessionListCache = { value: sessionListCache?.value ?? [], capturedAt: sessionListCache?.capturedAt ?? 0, inFlight };
  return inFlight;
}

export async function listExitedZellijSessions(): Promise<string[]> {
  const result = await runZellij(["list-sessions"], { timeoutMs: 5000 }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/no active zellij sessions|no active sessions|no sessions/i.test(message)) {
      return { stdout: "", stderr: "" };
    }
    throw error;
  });
  return result.stdout
    .split(/\r?\n/)
    .map(stripAnsi)
    .map((line) => line.trim())
    .filter((line) => /\(EXITED\b/i.test(line))
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
}

export async function hasExitedZellijSession(sessionName: string): Promise<boolean> {
  return (await listExitedZellijSessions()).includes(sessionName);
}

function invalidateZellijSessionListCache(): void {
  sessionListCache = null;
}

async function listZellijPanes(sessionName: string): Promise<ZellijPane[]> {
  const result = await runZellij(["--session", sessionName, "action", "list-panes", "--json", "--all", "--state", "--command"], {
    timeoutMs: 5000
  });
  const parsed = JSON.parse(result.stdout) as unknown;
  return Array.isArray(parsed) ? (parsed as ZellijPane[]) : [];
}

async function pruneZellijUiPanes(sessionName: string): Promise<void> {
  const panes = await listZellijPanes(sessionName);
  for (const pane of panes) {
    if (!pane.is_plugin) {
      continue;
    }
    const id = pane.pane_id ?? pane.id;
    if (typeof id !== "number") {
      continue;
    }
    await runZellij(["--session", sessionName, "action", "close-pane", "--pane-id", `plugin_${id}`], {
      timeoutMs: 3000
    }).catch(() => undefined);
  }
}

function scheduleZellijSessionMaintenance(sessionName: string): void {
  if (zellijMaintenanceTimers.has(sessionName)) {
    return;
  }

  const timer = setTimeout(() => {
    zellijMaintenanceTimers.delete(sessionName);
    void pruneZellijUiPanes(sessionName)
      .then(() => saveZellijSessionState(sessionName))
      .catch(() => undefined);
  }, ZELLIJ_MAINTENANCE_DELAY_MS);
  timer.unref();
  zellijMaintenanceTimers.set(sessionName, timer);
}

function cancelZellijSessionMaintenance(sessionName: string): void {
  const timer = zellijMaintenanceTimers.get(sessionName);
  if (!timer) {
    return;
  }
  clearTimeout(timer);
  zellijMaintenanceTimers.delete(sessionName);
}

export async function normalizeZellijSessionUi(sessionName: string): Promise<void> {
  if (await hasZellijSession(sessionName)) {
    await pruneZellijUiPanes(sessionName);
  }
}

async function bootstrapZellijSession(
  session: ZellijSessionSpec,
  resurrecting: boolean,
  proxy: TerminalProxyConfig
): Promise<void> {
  try {
    await launchZellijSession(session, resurrecting, proxy);
  } catch (error) {
    if (!isUnreadableZellijResurrection(error)) {
      throw error;
    }

    const backupPath = await backupUnreadableZellijResurrection(session.tmuxName, error);
    if (!backupPath) {
      throw error;
    }
    console.warn(`Discarding unreadable Zellij resurrection state for ${session.tmuxName}; backup: ${backupPath}`);
    await runZellij(["delete-session", session.tmuxName], { timeoutMs: 5000 });
    invalidateZellijSessionListCache();
    await launchZellijSession(session, false, proxy);
  }
}

async function launchZellijSession(
  session: ZellijSessionSpec,
  observeCodexLock: boolean,
  proxy: TerminalProxyConfig
): Promise<void> {
  const pty = await loadPty();
  const cwd = resolveCwd(session.cwd);
  const term = pty.spawn(config.zellijBin, zellijAttachArgs(session), {
    name: "xterm-256color",
    cols: 120,
    rows: 36,
    cwd,
    env: terminalProcessEnvironment(proxy, {
      TERM: "xterm-256color",
      COLORTERM: "truecolor"
    })
  });
  let output = "";
  let exitEvent: { exitCode: number; signal?: number } | null = null;
  term.onData((data) => {
    output = (output + data).slice(-100_000);
  });
  term.onExit((event) => {
    exitEvent = event;
  });

  try {
    await waitForZellijSession(
      session.tmuxName,
      ZELLIJ_BOOTSTRAP_TIMEOUT_MS,
      () => exitEvent,
      () => output
    );
    if (observeCodexLock) {
      await recoverCodexLocalDataLock(session.tmuxName, {
        read: () => output,
        clear: () => {
          output = "";
        }
      });
    }
    if (session.codexThreadId) {
      output = "";
      const restored = await restoreTrackedCodexThread(session);
      if (restored) {
        await recoverCodexLocalDataLock(session.tmuxName, {
          read: () => output,
          clear: () => {
            output = "";
          }
        }, async () => {
          await restoreTrackedCodexThread(session, "openai", true);
        });
      }
    }
    await saveZellijSessionState(session.tmuxName).catch(() => undefined);
    await runZellij(["--session", session.tmuxName, "action", "detach"], { timeoutMs: 5000 }).catch(() => undefined);
  } finally {
    windowlessKill(term);
  }
}

async function restoreTrackedCodexThread(
  session: ZellijSessionSpec,
  modelProvider?: string,
  force = false
): Promise<boolean> {
  const threadId = session.codexThreadId;
  if (!threadId) {
    return false;
  }
  const command = codexResumeCommand(threadId, { modelProvider });
  if (!command) {
    return false;
  }

  const pane = await activeTerminalPane(session.tmuxName).catch(() => null);
  const paneCommand = formatCommand(pane?.terminal_command ?? pane?.pane_command ?? pane?.command);
  if (
    !force &&
    paneCommand.toLowerCase().includes(threadId.toLowerCase()) &&
    isCodexYoloProcessCommand(paneCommand)
  ) {
    return false;
  }

  await runZellij(
    [
      "--session",
      session.tmuxName,
      "action",
      "new-pane",
      "--in-place",
      "--close-replaced-pane",
      "--cwd",
      resolveCwd(session.cwd),
      "--",
      ...command
    ],
    { timeoutMs: 8000 }
  );
  await waitForTrackedCodexPane(session.tmuxName, threadId, 20_000);
  return true;
}

async function waitForTrackedCodexPane(sessionName: string, threadId: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pane = await activeTerminalPane(sessionName).catch(() => null);
    const command = formatCommand(pane?.terminal_command ?? pane?.pane_command ?? pane?.command);
    if (
      command.toLowerCase().includes(threadId.toLowerCase()) ||
      codexTerminalTitleMatchesThread(pane?.title ?? "", threadId)
    ) {
      return;
    }
    await delay(200);
  }
  throw new Error(`Codex thread ${threadId} did not start in Zellij session ${sessionName}`);
}

function queueZellijBootstrap<T>(operation: () => Promise<T>): Promise<T> {
  const queued = zellijBootstrapQueue.then(operation, operation);
  zellijBootstrapQueue = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}

export function recoverZellijCodexLocalDataLock(
  sessionName: string,
  output: { read: () => string; clear: () => void }
): Promise<void> {
  return queueZellijBootstrap(() => recoverCodexLocalDataLock(sessionName, output));
}

async function recoverCodexLocalDataLock(
  sessionName: string,
  output: { read: () => string; clear: () => void },
  retryWithOpenAi?: () => Promise<void>
): Promise<void> {
  let usedProviderFallback = false;
  for (let attempt = 0; attempt <= CODEX_LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
    const failure = await waitForCodexBootstrapFailure(output.read, ZELLIJ_BOOTSTRAP_OBSERVE_MS);
    if (!failure) {
      return;
    }
    if (failure === "model-provider-missing" && retryWithOpenAi && !usedProviderFallback) {
      usedProviderFallback = true;
      output.clear();
      await delay(500);
      await retryWithOpenAi();
      continue;
    }
    if (failure !== "database-locked") {
      console.error(`Codex failed while restoring Zellij session ${sessionName}: ${failure}`);
      return;
    }
    if (attempt >= CODEX_LOCK_RETRY_DELAYS_MS.length) {
      console.error(`Codex local data remained locked while resurrecting Zellij session ${sessionName}`);
      return;
    }

    if (await codexProcessSurvivedLockReport(sessionName)) {
      return;
    }

    const retryDelay = CODEX_LOCK_RETRY_DELAYS_MS[attempt];
    console.warn(
      `Codex local data was locked while resurrecting Zellij session ${sessionName}; retrying in ${retryDelay}ms`
    );
    const retryCommandOutput = output.read();
    output.clear();
    await delay(retryDelay);
    await rerunFocusedZellijCommand(sessionName, retryCommandOutput);
  }
}

async function waitForCodexBootstrapFailure(
  output: () => string,
  timeoutMs: number
): Promise<Exclude<ReturnType<typeof classifyCodexBootstrapFailure>, null> | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const failure = classifyCodexBootstrapFailure(stripAnsi(output()));
    if (failure) {
      return failure;
    }
    await delay(200);
  }
  return classifyCodexBootstrapFailure(stripAnsi(output()));
}

async function codexProcessSurvivedLockReport(sessionName: string): Promise<boolean> {
  for (let check = 0; check < 5; check += 1) {
    await delay(250);
    if (!(await activePaneRunsCodex(sessionName))) {
      return false;
    }
  }
  return true;
}

async function activePaneRunsCodex(sessionName: string): Promise<boolean> {
  const pane = await activeTerminalPane(sessionName).catch(() => null);
  if (!pane || pane.exited) {
    return false;
  }
  const command = formatCommand(pane?.terminal_command ?? pane?.pane_command ?? pane?.command);
  return isCodexProcessCommand(command);
}

async function rerunFocusedZellijCommand(sessionName: string, bootstrapOutput: string): Promise<void> {
  const pane = await activeTerminalPane(sessionName).catch(() => null);
  const id = pane?.pane_id ?? pane?.id;
  const paneId = typeof id === "number" ? `terminal_${id}` : null;
  const target = paneId ? ["--pane-id", paneId] : [];
  if (pane?.is_held || pane?.exited) {
    await runZellij(["--session", sessionName, "action", "send-keys", ...target, "Enter"], {
      timeoutMs: 5000
    });
    return;
  }

  const command = extractCodexResumeCommand(bootstrapOutput);
  const paneCommand = formatCommand(pane?.terminal_command ?? pane?.pane_command ?? pane?.command);
  if (command && isShellCommand(paneCommand)) {
    await runZellij(["--session", sessionName, "action", "write-chars", ...target, "--", command], {
      timeoutMs: 5000
    });
    await runZellij(["--session", sessionName, "action", "send-keys", ...target, "Enter"], {
      timeoutMs: 5000
    });
    return;
  }

  await runZellij(["--session", sessionName, "action", "send-keys", ...target, "Up", "Enter"], {
    timeoutMs: 5000
  });
}

function extractCodexResumeCommand(value: string): string | null {
  const message = stripAnsi(value).replace(/\s+/g, " ");
  const matches = Array.from(
    message.matchAll(/\bcodex(?:\.exe)?\s+(?:resume|fork)\s+[0-9a-f-]{32,36}(?:\s+--[a-z0-9-]+)*/gi)
  );
  return matches.at(-1)?.[0] ?? null;
}

function isShellCommand(command: string): boolean {
  return /(?:^|[\\/])(?:cmd|powershell|pwsh|bash|zsh|fish)(?:\.exe)?(?:\s|$)/i.test(command);
}

async function waitForZellijSession(
  sessionName: string,
  timeoutMs: number,
  exitEvent: () => { exitCode: number; signal?: number } | null,
  output: () => string
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await hasZellijSession(sessionName)) {
      return;
    }
    const exited = exitEvent();
    if (exited) {
      const detail = stripAnsi(output()).trim();
      throw new Error(
        detail || `zellij client for ${sessionName} exited before the session was created (exit code ${exited.exitCode})`
      );
    }
    await delay(200);
  }
  const detail = stripAnsi(output()).trim();
  throw new Error(detail || `zellij session ${sessionName} was not created`);
}

function isUnreadableZellijResurrection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /failed to parse resurrection layout|kdl(?:de)?serialization error|failed to parse zellij configuration/i.test(message);
}

async function backupUnreadableZellijResurrection(sessionName: string, error: unknown): Promise<string | null> {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/failed to parse resurrection layout file (.+?session-layout\.kdl):/i);
  if (!match) {
    return null;
  }

  const sourceDir = path.dirname(match[1].trim());
  if (path.basename(sourceDir).toLowerCase() !== sessionName.toLowerCase() || !fs.existsSync(sourceDir)) {
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(config.dataDir, "backups", "zellij-corrupt", `${sessionName}-${timestamp}`);
  await fs.promises.mkdir(path.dirname(backupDir), { recursive: true });
  await fs.promises.cp(sourceDir, backupDir, { recursive: true, errorOnExist: true, force: false });
  return backupDir;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function windowlessKill(term: { kill: () => void }): void {
  try {
    term.kill();
  } catch {
    // The attach client may already have exited after detach.
  }
}

async function activeTerminalPaneId(sessionName: string): Promise<string | null> {
  const pane = await activeTerminalPane(sessionName);
  if (!pane) {
    return null;
  }
  const id = pane.pane_id ?? pane.id;
  return typeof id === "number" ? `terminal_${id}` : null;
}

async function writeZellijChars(sessionName: string, target: string[], data: string): Promise<void> {
  for (const chunk of chunkString(data, 2000)) {
    await runZellij(["--session", sessionName, "action", "write-chars", ...target, "--", chunk], {
      timeoutMs: 5000
    }).catch(() => runZellij(["--session", sessionName, "action", "paste", ...target, "--", chunk], { timeoutMs: 5000 }));
  }
}

async function pasteZellijText(sessionName: string, target: string[], data: string): Promise<void> {
  for (const chunk of chunkString(data, 2000)) {
    await runZellij(["--session", sessionName, "action", "paste", ...target, "--", chunk], {
      timeoutMs: 5000
    }).catch(() =>
      runZellij(["--session", sessionName, "action", "write-chars", ...target, "--", chunk], { timeoutMs: 5000 })
    );
  }
}

async function sendZellijEnter(sessionName: string, target: string[]): Promise<void> {
  await runZellij(["--session", sessionName, "action", "send-keys", ...target, "Enter"], {
    timeoutMs: 5000
  }).catch(() => runZellij(["--session", sessionName, "action", "write", ...target, "13"], { timeoutMs: 5000 }));
}

async function sendZellijInterrupt(sessionName: string, target: string[]): Promise<void> {
  await runZellij(["--session", sessionName, "action", "send-keys", ...target, "Ctrl", "c"], {
    timeoutMs: 5000
  }).catch(() => runZellij(["--session", sessionName, "action", "write", ...target, "3"], { timeoutMs: 5000 }));
}

async function waitForZellijCodexExit(
  session: Pick<TerminalSession, "tmuxName">,
  timeoutMs: number
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await zellijCodexProcessState(session)).running) {
      return true;
    }
    await delay(200);
  }
  return !(await zellijCodexProcessState(session)).running;
}

function normalizeSubmitDelayMs(value: number | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(12_000, Math.floor(parsed)));
}

function chunkString(value: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += chunkSize) {
    chunks.push(value.slice(index, index + chunkSize));
  }
  return chunks.length ? chunks : [""];
}

async function activeTerminalPane(sessionName: string): Promise<ZellijPane | null> {
  const panes = await listZellijPanes(sessionName);
  return (
    panes.find((item) => !item.is_plugin && (item.focused || item.is_focused)) ??
    panes.find((item) => !item.is_plugin && !item.exited) ??
    panes.find((item) => !item.is_plugin) ??
    null
  );
}

async function loadZellijTranscript(dataDir: string, sessionId: string, lines?: number): Promise<string> {
  const transcriptPath = zellijTranscriptPath(dataDir, sessionId);
  if (lines !== undefined) {
    return readTailFileLines(transcriptPath, lines, config.nativeHistoryBytes).catch(() => "");
  }
  return readTailFile(transcriptPath, config.nativeHistoryBytes).catch(() => "");
}

export function zellijTranscriptPath(dataDir: string, sessionId: string): string {
  return path.join(dataDir, "transcripts", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.ansi`);
}

async function appendTranscript(filePath: string, data: string, maxBytes: number): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.appendFile(filePath, data, "utf8");
  const stat = await fs.promises.stat(filePath);
  if (stat.size > maxBytes + 256_000) {
    await fs.promises.writeFile(filePath, await readTailFile(filePath, maxBytes), "utf8");
  }
}

async function readTailFile(filePath: string, maxBytes: number): Promise<string> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size <= 0) {
    return "";
  }
  const length = Math.min(stat.size, maxBytes);
  const start = Math.max(0, stat.size - length);
  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const result = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readTailFileLines(filePath: string, linesToKeep: number, maxBytes: number): Promise<string> {
  const stat = await fs.promises.stat(filePath);
  if (stat.size <= 0) {
    return "";
  }

  const chunks: Buffer[] = [];
  const chunkSize = 256 * 1024;
  const targetLines = Math.max(1, Math.floor(linesToKeep));
  const bytesToRead = Math.min(stat.size, maxBytes);
  let remaining = stat.size;
  let bytesRead = 0;
  let lineBreaks = 0;
  const handle = await fs.promises.open(filePath, "r");
  try {
    while (remaining > 0 && bytesRead < bytesToRead && lineBreaks <= targetLines) {
      const length = Math.min(chunkSize, remaining, bytesToRead - bytesRead);
      remaining -= length;
      const buffer = Buffer.alloc(length);
      const result = await handle.read(buffer, 0, length, remaining);
      const chunk = buffer.subarray(0, result.bytesRead);
      chunks.unshift(chunk);
      bytesRead += result.bytesRead;
      lineBreaks += countLineBreakBytes(chunk);
      if (result.bytesRead <= 0) {
        break;
      }
    }
    return tailRawLines(Buffer.concat(chunks).toString("utf8"), targetLines);
  } finally {
    await handle.close();
  }
}

function countLineBreakBytes(value: Buffer): number {
  let count = 0;
  for (const byte of value) {
    if (byte === 10) {
      count += 1;
    }
  }
  return count;
}

function zellijOptions(session: Pick<TerminalSession, "cwd" | "shell">): string[] {
  const args = [
    "options",
    "--on-force-close",
    "detach",
    "--default-cwd",
    resolveCwd(session.cwd),
    "--scroll-buffer-size",
    String(config.zellijScrollback),
    "--session-serialization",
    "true",
    "--serialization-interval",
    String(ZELLIJ_SERIALIZATION_INTERVAL_SECONDS),
    "--serialize-pane-viewport",
    "true",
    "--scrollback-lines-to-serialize",
    String(config.zellijScrollback),
    "--show-startup-tips",
    "false",
    "--simplified-ui",
    "true",
    "--pane-frames",
    "false"
  ];
  if (session.shell?.trim()) {
    args.push("--default-shell", session.shell.trim());
  }
  return args;
}

function resolveCwd(cwd: string): string {
  if (cwd && fs.existsSync(cwd)) {
    return cwd;
  }
  return process.cwd();
}

function tailLines(value: string, linesToKeep: number): string {
  const lines = value.split(/\r?\n/);
  return lines.slice(-linesToKeep).join("\n").trimEnd();
}

function tailRawLines(value: string, linesToKeep: number): string {
  const lines = value.split(/\r?\n/);
  return lines.slice(-linesToKeep).join("\n");
}

function longerHistory(primary: string, fallback: string): string {
  if (!fallback.trim()) {
    return primary;
  }
  if (!primary.trim()) {
    return fallback;
  }
  return countRawLines(fallback) > countRawLines(primary) ? fallback : primary;
}

function countRawLines(value: string): number {
  return value ? value.split(/\r?\n/).length : 0;
}

export function createZellijAttachOutputFilter(): (data: string) => string {
  let pending = "";
  return (data: string) => {
    const result = stripZellijHistoryHidingSequencesChunk(`${pending}${data}`);
    pending = result.pending;
    return result.output;
  };
}

export function stripZellijHistoryHidingSequences(data: string): string {
  const result = stripZellijHistoryHidingSequencesChunk(data);
  return result.output + result.pending;
}

function stripZellijHistoryHidingSequencesChunk(data: string): { output: string; pending: string } {
  let output = "";
  let index = 0;

  while (index < data.length) {
    if (data[index] !== "\x1b" || data[index + 1] !== "[") {
      output += data[index];
      index += 1;
      continue;
    }

    const end = findCsiSequenceEnd(data, index + 2);
    if (end === -1) {
      return { output, pending: data.slice(index) };
    }

    const sequence = data.slice(index, end + 1);
    if (!isHistoryHidingCsi(sequence)) {
      output += sequence;
    }
    index = end + 1;
  }

  return { output, pending: "" };
}

function findCsiSequenceEnd(data: string, start: number): number {
  for (let index = start; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      return index;
    }
  }
  return -1;
}

function isHistoryHidingCsi(sequence: string): boolean {
  const privateMode = /^\x1b\[\?([0-9;]*)([hl])$/.exec(sequence);
  if (privateMode) {
    const modes = privateMode[1].split(";");
    return modes.some((mode) => mode === "47" || mode === "1047" || mode === "1048" || mode === "1049");
  }
  return /^\x1b\[\??3J$/.test(sequence);
}

async function renderPlainTranscript(value: string, lines: number): Promise<string> {
  if (!value) {
    return "";
  }
  const linesToKeep = Math.max(20, Math.min(lines, config.previewMaxLines));
  const screen = new Headless.Terminal({
    allowProposedApi: true,
    cols: 160,
    rows: 40,
    scrollback: Math.max(linesToKeep, 1000)
  });
  try {
    await writeHeadless(screen, value);
    const buffer = screen.buffer.active;
    const start = Math.max(0, buffer.length - linesToKeep);
    const rows: string[] = [];
    for (let index = start; index < buffer.length; index += 1) {
      rows.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    return rows.join("\n").trimEnd();
  } finally {
    screen.dispose();
  }
}

function writeHeadless(screen: HeadlessTerminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    screen.write(data, resolve);
  });
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function formatCommand(command: ZellijPane["command"]): string {
  if (!command) {
    return "";
  }
  if (typeof command === "string") {
    return command;
  }
  if (Array.isArray(command)) {
    return command.join(" ");
  }
  return [command.name, ...(command.args ?? [])].filter(Boolean).join(" ");
}

function quoteCommand(value: string): string {
  return /[\s"'`]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function clampSize(value: unknown, min: number, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
