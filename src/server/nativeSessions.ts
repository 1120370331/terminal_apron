import fs from "node:fs";
import os from "node:os";
import type { Socket } from "socket.io";
import Headless from "@xterm/headless";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SessionRuntime, TerminalSession } from "../shared/types.js";
import { loadPty, type PtyProcess } from "./pty.js";

interface NativeEntry {
  session: TerminalSession;
  term: PtyProcess;
  screen: HeadlessTerminal;
  screenQueue: Promise<void>;
  output: string;
  clients: Set<Socket>;
  currentPath: string;
  command: string;
  exited: boolean;
}

const MAX_PREVIEW_CHARS = 240_000;

export class NativeSessionManager {
  private readonly sessions = new Map<string, NativeEntry>();

  async ensure(session: TerminalSession, cols = 120, rows = 36): Promise<NativeEntry> {
    const existing = this.sessions.get(session.id);
    if (existing && !existing.exited) {
      existing.session = session;
      return existing;
    }

    const pty = await loadPty();
    const command = resolveShell(session.shell);
    const cwd = resolveCwd(session.cwd);
    const term = pty.spawn(command.file, command.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        TWM_SESSION_ID: session.id,
        TWM_SESSION_NAME: session.name
      }
    });

    const entry: NativeEntry = {
      session,
      term,
      screen: new Headless.Terminal({
        allowProposedApi: true,
        cols,
        rows,
        scrollback: 10000
      }),
      screenQueue: Promise.resolve(),
      output: "",
      clients: new Set(),
      currentPath: cwd,
      command: [command.file, ...command.args].join(" "),
      exited: false
    };

    term.onData((data) => {
      entry.screenQueue = entry.screenQueue
        .then(
          () =>
            new Promise<void>((resolve) => {
              entry.screen.write(data, resolve);
            })
        )
        .catch(() => undefined);
      entry.output = tail(entry.output + data, MAX_PREVIEW_CHARS);
      for (const client of entry.clients) {
        client.emit("terminal:data", data);
      }
    });

    term.onExit((event) => {
      entry.exited = true;
      for (const client of entry.clients) {
        client.emit("terminal:exit", event);
      }
      entry.clients.clear();
      this.sessions.delete(session.id);
    });

    this.sessions.set(session.id, entry);
    return entry;
  }

  async attach(session: TerminalSession, socket: Socket, cols: number, rows: number): Promise<void> {
    const entry = await this.ensure(session, cols, rows);
    entry.clients.add(socket);
    entry.term.resize(cols, rows);
    entry.screen.resize(cols, rows);

    socket.emit("terminal:ready", {
      backend: "native",
      persistent: false,
      tmuxName: session.tmuxName,
      attachCommand: null
    });

    if (entry.output) {
      socket.emit("terminal:data", entry.output);
    }

    socket.on("terminal:input", (data: string) => {
      entry.term.write(data);
    });

    socket.on("terminal:resize", (size: { cols?: number; rows?: number }) => {
      const nextCols = clampDimension(size.cols, cols, 20, 300);
      const nextRows = clampDimension(size.rows, rows, 10, 120);
      entry.term.resize(nextCols, nextRows);
      entry.screen.resize(nextCols, nextRows);
    });

    socket.on("disconnect", () => {
      entry.clients.delete(socket);
    });
  }

  async kill(session: TerminalSession): Promise<void> {
    const entry = this.sessions.get(session.id);
    if (!entry) {
      return;
    }
    entry.term.kill();
    entry.clients.clear();
    this.sessions.delete(session.id);
  }

  async write(session: TerminalSession, data: string, enter = false, submitKey: "enter" | "enhanced-enter" = "enter"): Promise<void> {
    const entry = await this.ensure(session);
    entry.term.write(data);
    if (enter) {
      entry.term.write(submitKey === "enhanced-enter" ? "\u001b[13u" : "\r");
    }
  }

  async preview(session: TerminalSession, lines = 500): Promise<string> {
    const entry = this.sessions.get(session.id);
    if (!entry) {
      return "";
    }
    await entry.screenQueue;
    const buffer = entry.screen.buffer.active;
    const start = Math.max(0, buffer.length - lines);
    const rows: string[] = [];
    for (let index = start; index < buffer.length; index += 1) {
      rows.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    const rendered = rows.join("\n").trimEnd();
    return rendered.trim() ? rendered : renderPlainPreview(entry.output, lines);
  }

  runtime(session: TerminalSession): SessionRuntime {
    const entry = this.sessions.get(session.id);
    return {
      exists: Boolean(entry && !entry.exited),
      backend: "native",
      persistent: false,
      attached: entry?.clients.size ?? 0,
      currentPath: entry?.currentPath ?? session.cwd,
      currentCommand: entry?.command ?? session.shell ?? defaultShellName(),
      windows: 1,
      lastAttached: null
    };
  }
}

function resolveShell(shell: string | undefined): { file: string; args: string[] } {
  if (shell?.trim()) {
    const parts = splitCommand(shell.trim());
    return { file: parts[0], args: parts.slice(1) };
  }

  if (process.platform === "win32") {
    return { file: "powershell.exe", args: ["-NoLogo"] };
  }

  return { file: process.env.SHELL || "/bin/sh", args: [] };
}

function defaultShellName(): string {
  if (process.platform === "win32") {
    return "powershell.exe";
  }
  return process.env.SHELL || "/bin/sh";
}

function resolveCwd(cwd: string): string {
  if (cwd && fs.existsSync(cwd)) {
    return cwd;
  }
  return os.homedir();
}

function splitCommand(value: string): string[] {
  const matches = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [value];
  return matches.map((part) => part.replace(/^["']|["']$/g, ""));
}

function tail(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(value.length - maxChars);
}

function clampDimension(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function renderPlainPreview(value: string, linesToKeep: number): string {
  const lines: string[][] = [[]];
  let row = 0;
  let col = 0;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "\u001b") {
      const end = consumeEscape(value, index, lines[row], col);
      index = end.index;
      col = end.col;
      continue;
    }
    if (char === "\r") {
      col = 0;
      continue;
    }
    if (char === "\n") {
      row += 1;
      lines[row] = lines[row] ?? [];
      col = 0;
      continue;
    }
    if (char === "\b") {
      col = Math.max(0, col - 1);
      continue;
    }
    if (char >= " ") {
      lines[row][col] = char;
      col += 1;
    }
  }

  return lines
    .map((line) => collapseProgressiveEcho(line.join("").trimEnd()))
    .filter((line, index, all) => line || index > all.length - linesToKeep)
    .slice(-linesToKeep)
    .join("\n")
    .trimEnd();
}

function collapseProgressiveEcho(line: string): string {
  const promptMatch = line.match(/^(.*[>#$]\s)(.+)$/);
  const prefix = promptMatch?.[1] ?? "";
  const body = promptMatch?.[2] ?? line;
  const firstToken = body.match(/[A-Za-z0-9_.:/\\-]+/)?.[0];
  if (!firstToken || firstToken.length < 2) {
    return line;
  }
  const last = body.lastIndexOf(firstToken);
  if (last <= 0) {
    return line;
  }
  return `${prefix}${body.slice(last)}`;
}

function consumeEscape(
  value: string,
  start: number,
  line: string[],
  col: number
): { index: number; col: number } {
  const next = value[start + 1];
  if (next === "]") {
    for (let index = start + 2; index < value.length; index += 1) {
      if (value[index] === "\u0007" || (value[index] === "\\" && value[index - 1] === "\u001b")) {
        return { index, col };
      }
    }
    return { index: value.length - 1, col };
  }
  if (next !== "[") {
    return { index: start + 1, col };
  }

  let index = start + 2;
  for (; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) {
      break;
    }
  }

  const final = value[index];
  if (final === "K") {
    line.splice(col);
    return { index, col: Math.min(col, line.length) };
  }
  return { index, col };
}
