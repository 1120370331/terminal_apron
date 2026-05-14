import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
  pane_cwd?: string;
  current_working_directory?: string;
  command?: string | string[] | { name?: string; args?: string[] };
  pane_command?: string | string[] | { name?: string; args?: string[] };
  terminal_command?: string | string[] | { name?: string; args?: string[] };
  title?: string;
}

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
    return;
  }

  await bootstrapZellijSession(session);
}

export async function killZellijSession(session: Pick<TerminalSession, "tmuxName">): Promise<void> {
  if (!(await hasZellijSession(session.tmuxName))) {
    return;
  }

  await runZellij(["kill-session", session.tmuxName], { timeoutMs: 5000 }).catch(() =>
    runZellij(["kill-sessions", session.tmuxName], { timeoutMs: 5000 })
  );
}

export async function captureZellijPreview(
  session: Pick<TerminalSession, "id" | "tmuxName">,
  lines = 500
): Promise<string> {
  if (!(await hasZellijSession(session.tmuxName))) {
    return tailPlainTranscript(await loadZellijTranscript(session.id), lines);
  }

  const paneId = await activeTerminalPaneId(session.tmuxName).catch(() => null);
  const args = ["--session", session.tmuxName, "action", "dump-screen", "--full"];
  if (paneId) {
    args.push("--pane-id", paneId);
  }
  const result = await runZellij(args, {
    timeoutMs: 5000
  }).catch(() => ({ stdout: "", stderr: "" }));
  const rendered = tailLines(result.stdout.replace(/\s+$/g, ""), Math.max(20, Math.min(lines, config.previewMaxLines)));
  return rendered.trim() ? rendered : tailPlainTranscript(await loadZellijTranscript(session.id), lines);
}

export function appendZellijTranscript(sessionId: string, data: string): Promise<void> {
  return appendTranscript(zellijTranscriptPath(sessionId), data, config.nativeHistoryBytes);
}

export async function sendZellijInput(
  session: Pick<TerminalSession, "tmuxName" | "cwd" | "shell">,
  data: string,
  enter = false,
  submitKey: "enter" | "enhanced-enter" = "enter"
): Promise<void> {
  await ensureZellijSession(session);
  if (!(await hasZellijSession(session.tmuxName))) {
    throw new Error("zellij session is not running yet; open the terminal once before sending inline input");
  }
  const paneId = await activeTerminalPaneId(session.tmuxName).catch(() => null);
  const target = paneId ? ["--pane-id", paneId] : [];
  await runZellij(["--session", session.tmuxName, "action", "paste", ...target, data], { timeoutMs: 5000 });
  if (!enter) {
    return;
  }
  if (submitKey === "enhanced-enter") {
    await runZellij(["--session", session.tmuxName, "action", "write", ...target, "27", "91", "49", "51", "117"], {
      timeoutMs: 5000
    });
    return;
  }
  await runZellij(["--session", session.tmuxName, "action", "write", ...target, "13"], { timeoutMs: 5000 });
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
  return ["attach", "--create", session.tmuxName, ...zellijOptions(session)];
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
  const panes = await listZellijPanes(sessionName);
  const pane = panes.find((item) => !item.is_plugin && (item.focused || item.is_focused)) ??
    panes.find((item) => !item.is_plugin && !item.exited) ??
    panes.find((item) => !item.is_plugin);
  if (!pane) {
    return null;
  }
  const id = pane.pane_id ?? pane.id;
  return typeof id === "number" ? `terminal_${id}` : null;
}

async function loadZellijTranscript(sessionId: string): Promise<string> {
  return readTailFile(zellijTranscriptPath(sessionId), config.nativeHistoryBytes).catch(() => "");
}

function zellijTranscriptPath(sessionId: string): string {
  return path.join(config.dataDir, "transcripts", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.ansi`);
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
    "--serialize-pane-viewport",
    "true",
    "--scrollback-lines-to-serialize",
    String(config.zellijScrollback),
    "--show-startup-tips",
    "false",
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

function tailPlainTranscript(value: string, lines: number): string {
  return tailLines(value, Math.max(20, Math.min(lines, config.previewMaxLines)));
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
