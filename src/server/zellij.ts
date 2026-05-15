import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Headless from "@xterm/headless";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SessionRuntime, TerminalSession } from "../shared/types.js";
import { config } from "./config.js";
import { loadPty } from "./pty.js";

interface RunOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
}

interface ZellijPane {
  id?: number;
  pane_id?: number;
  focused?: boolean;
  is_focused?: boolean;
  is_plugin?: boolean;
  exited?: boolean;
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

const ZELLIJ_SINGLE_PANE_LAYOUT = ["layout {", "    pane", "}"].join("\n");
const VIEWPORT_PREVIEW_TTL_MS = 600;
const VIEWPORT_PREVIEW_STALE_MS = 30_000;

interface PreviewCacheEntry {
  value: string;
  capturedAt: number;
  inFlight?: Promise<string>;
}

const viewportPreviewCache = new Map<string, PreviewCacheEntry>();

function runZellij(args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      config.zellijBin,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 8000,
        maxBuffer: 1024 * 1024 * 8
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
  const result = await runZellij(["--version"], { timeoutMs: 3000 });
  return result.stdout.trim();
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
  session: Pick<TerminalSession, "tmuxName" | "cwd" | "shell">
): Promise<void> {
  if (await hasZellijSession(session.tmuxName)) {
    await pruneZellijUiPanes(session.tmuxName).catch(() => undefined);
    await saveZellijSessionState(session.tmuxName).catch(() => undefined);
    return;
  }

  await bootstrapZellijSession(session);
  await pruneZellijUiPanes(session.tmuxName).catch(() => undefined);
  await saveZellijSessionState(session.tmuxName).catch(() => undefined);
}

export async function killZellijSession(session: Pick<TerminalSession, "tmuxName">): Promise<void> {
  if (!(await hasZellijSession(session.tmuxName))) {
    return;
  }

  await runZellij(["kill-session", session.tmuxName], { timeoutMs: 5000 }).catch(() =>
    runZellij(["kill-sessions", session.tmuxName], { timeoutMs: 5000 })
  );
  await runZellij(["delete-session", session.tmuxName], { timeoutMs: 5000 }).catch(() => undefined);
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

  const cols = clampSize(pane.pane_content_columns ?? pane.pane_columns, 20, 600);
  const rows = clampSize(pane.pane_content_rows ?? pane.pane_rows, 10, 300);
  if (!cols || !rows) {
    return undefined;
  }
  return { cols, rows };
}

export function appendZellijTranscript(sessionId: string, data: string, dataDir = config.dataDir): Promise<void> {
  return appendTranscript(zellijTranscriptPath(dataDir, sessionId), data, config.nativeHistoryBytes);
}

export async function sendZellijInput(
  session: Pick<TerminalSession, "tmuxName" | "cwd" | "shell">,
  data: string,
  enter = false
): Promise<void> {
  await ensureZellijSession(session);
  if (!(await hasZellijSession(session.tmuxName))) {
    throw new Error("zellij session is not running yet; open the terminal once before sending inline input");
  }
  const paneId = await activeTerminalPaneId(session.tmuxName).catch(() => null);
  const target = paneId ? ["--pane-id", paneId] : [];
  await writeZellijChars(session.tmuxName, target, data);
  if (!enter) {
    void saveZellijSessionState(session.tmuxName).catch(() => undefined);
    return;
  }
  await sendZellijEnter(session.tmuxName, target);
  void saveZellijSessionState(session.tmuxName).catch(() => undefined);
}

export async function zellijRuntimeInfo(session: TerminalSession): Promise<SessionRuntime> {
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
    .map((line) => line.trim().split(/\s+/)[0])
    .filter(Boolean);
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

export async function normalizeZellijSessionUi(sessionName: string): Promise<void> {
  if (await hasZellijSession(sessionName)) {
    await pruneZellijUiPanes(sessionName);
  }
}

async function bootstrapZellijSession(session: Pick<TerminalSession, "tmuxName" | "cwd" | "shell">): Promise<void> {
  const pty = await loadPty();
  const cwd = resolveCwd(session.cwd);
  const term = pty.spawn(config.zellijBin, zellijAttachArgs(session), {
    name: "xterm-256color",
    cols: 120,
    rows: 36,
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor"
    }
  });

  try {
    await waitForZellijSession(session.tmuxName, 8000);
    await saveZellijSessionState(session.tmuxName).catch(() => undefined);
    await runZellij(["--session", session.tmuxName, "action", "detach"], { timeoutMs: 5000 }).catch(() => undefined);
  } finally {
    windowlessKill(term);
  }
}

async function waitForZellijSession(sessionName: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await hasZellijSession(sessionName)) {
      return;
    }
    await delay(200);
  }
  throw new Error(`zellij session ${sessionName} was not created`);
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

async function sendZellijEnter(sessionName: string, target: string[]): Promise<void> {
  await runZellij(["--session", sessionName, "action", "send-keys", ...target, "Enter"], {
    timeoutMs: 5000
  }).catch(() => runZellij(["--session", sessionName, "action", "write", ...target, "13"], { timeoutMs: 5000 }));
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

async function loadZellijTranscript(dataDir: string, sessionId: string): Promise<string> {
  return readTailFile(zellijTranscriptPath(dataDir, sessionId), config.nativeHistoryBytes).catch(() => "");
}

function zellijTranscriptPath(dataDir: string, sessionId: string): string {
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
    "1",
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
