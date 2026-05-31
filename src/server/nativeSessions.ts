import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Socket } from "socket.io";
import Headless from "@xterm/headless";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import type { SessionRuntime, TerminalSession } from "../shared/types.js";
import { config } from "./config.js";
import { loadPty, type PtyProcess } from "./pty.js";
import { emitTerminalData } from "./terminalData.js";

const MAX_TERMINAL_COLS = 4096;
const MAX_TERMINAL_ROWS = 2048;

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
  transcriptPath: string;
  transcriptQueue: Promise<void>;
  pendingTranscriptBytes: number;
  lastTranscriptTrimAt: number;
}

const TRANSCRIPT_TRIM_BYTES = 256_000;
const TRANSCRIPT_TRIM_INTERVAL_MS = 5000;

export class NativeSessionManager {
  private readonly sessions = new Map<string, NativeEntry>();

  async ensure(session: TerminalSession, dataDir = config.dataDir, cols = 120, rows = 36): Promise<NativeEntry> {
    const sessionKey = sessionKeyForDataDir(dataDir, session.id);
    const existing = this.sessions.get(sessionKey);
    if (existing && !existing.exited) {
      existing.session = session;
      return existing;
    }

    const pty = await loadPty();
    const command = resolveShell(session.shell);
    const cwd = resolveCwd(session.cwd);
    const initialOutput = await loadTranscript(dataDir, session.id);
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
        scrollback: config.nativeScreenScrollback
      }),
      screenQueue: Promise.resolve(),
      output: initialOutput,
      clients: new Set(),
      currentPath: cwd,
      command: [command.file, ...command.args].join(" "),
      exited: false,
      transcriptPath: transcriptPathForSession(dataDir, session.id),
      transcriptQueue: Promise.resolve(),
      pendingTranscriptBytes: 0,
      lastTranscriptTrimAt: Date.now()
    };

    if (initialOutput) {
      entry.screenQueue = writeHeadless(entry.screen, initialOutput);
    }

    term.onData((data) => {
      entry.screenQueue = entry.screenQueue
        .then(
          () =>
            new Promise<void>((resolve) => {
              entry.screen.write(data, resolve);
            })
        )
        .catch(() => undefined);
      entry.output = tailByUtf8Bytes(entry.output + data, config.nativeHistoryBytes);
      queueTranscriptWrite(entry, data);
      for (const client of entry.clients) {
        emitTerminalData(client, data);
      }
    });

    term.onExit((event) => {
      entry.exited = true;
      for (const client of entry.clients) {
        client.emit("terminal:exit", event);
      }
      entry.clients.clear();
      this.sessions.delete(sessionKey);
    });

    this.sessions.set(sessionKey, entry);
    return entry;
  }

  async attach(session: TerminalSession, socket: Socket, dataDir: string, cols: number, rows: number): Promise<void> {
    const entry = await this.ensure(session, dataDir, cols, rows);
    entry.clients.add(socket);
    entry.term.resize(cols, rows);
    entry.screen.resize(cols, rows);

    socket.emit("terminal:ready", {
      backend: "native",
      persistent: false,
      tmuxName: session.tmuxName,
      attachCommand: null
    });
    socket.emit("terminal:resized", { cols, rows, seq: 0 });

    const attachHistory = await loadTranscript(dataDir, session.id);
    if (attachHistory) {
      emitTerminalData(socket, attachHistory);
    }

    socket.on("terminal:input", (data: string) => {
      entry.term.write(data);
    });

    socket.on("terminal:resize", (size: { cols?: number; rows?: number; seq?: number }) => {
      const nextCols = clampDimension(size.cols, cols, 20, MAX_TERMINAL_COLS);
      const nextRows = clampDimension(size.rows, rows, 10, MAX_TERMINAL_ROWS);
      entry.term.resize(nextCols, nextRows);
      entry.screen.resize(nextCols, nextRows);
      socket.emit("terminal:resized", { cols: nextCols, rows: nextRows, seq: size.seq });
    });

    socket.on("disconnect", () => {
      entry.clients.delete(socket);
    });
  }

  async kill(session: TerminalSession, dataDir = config.dataDir): Promise<void> {
    const sessionKey = sessionKeyForDataDir(dataDir, session.id);
    const entry = this.sessions.get(sessionKey);
    if (!entry) {
      return;
    }
    entry.term.kill();
    entry.clients.clear();
    this.sessions.delete(sessionKey);
  }

  async write(
    session: TerminalSession,
    data: string,
    enter = false,
    dataDir = config.dataDir,
    submitDelayMs = 0
  ): Promise<void> {
    const entry = await this.ensure(session, dataDir);
    entry.term.write(data);
    if (enter) {
      await delay(submitDelayMs);
      entry.term.write("\r");
    }
  }

  async preview(session: TerminalSession, lines = 500, dataDir = config.dataDir): Promise<string> {
    const entry = this.sessions.get(sessionKeyForDataDir(dataDir, session.id));
    if (!entry) {
      return renderPlainPreview(await loadTranscript(dataDir, session.id), lines);
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

  runtime(session: TerminalSession, dataDir = config.dataDir): SessionRuntime {
    const entry = this.sessions.get(sessionKeyForDataDir(dataDir, session.id));
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

function writeHeadless(screen: HeadlessTerminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    screen.write(data, resolve);
  });
}

function delay(ms: number): Promise<void> {
  const duration = Math.max(0, Math.min(1000, Math.floor(ms)));
  if (duration === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function sessionKeyForDataDir(dataDir: string, sessionId: string): string {
  return `${path.resolve(dataDir)}:${sessionId}`;
}

function transcriptPathForSession(dataDir: string, sessionId: string): string {
  return path.join(dataDir, "transcripts", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.ansi`);
}

async function loadTranscript(dataDir: string, sessionId: string): Promise<string> {
  return readTailFile(transcriptPathForSession(dataDir, sessionId), config.nativeHistoryBytes).catch(() => "");
}

function queueTranscriptWrite(entry: NativeEntry, data: string): void {
  entry.transcriptQueue = entry.transcriptQueue
    .then(async () => {
      await fs.promises.mkdir(path.dirname(entry.transcriptPath), { recursive: true });
      await fs.promises.appendFile(entry.transcriptPath, data, "utf8");
      entry.pendingTranscriptBytes += Buffer.byteLength(data, "utf8");
      const now = Date.now();
      if (
        entry.pendingTranscriptBytes >= TRANSCRIPT_TRIM_BYTES ||
        now - entry.lastTranscriptTrimAt >= TRANSCRIPT_TRIM_INTERVAL_MS
      ) {
        await trimTranscript(entry.transcriptPath, config.nativeHistoryBytes);
        entry.pendingTranscriptBytes = 0;
        entry.lastTranscriptTrimAt = now;
      }
    })
    .catch(() => undefined);
}

async function trimTranscript(filePath: string, maxBytes: number): Promise<void> {
  const retained = await readTailFile(filePath, maxBytes);
  await fs.promises.writeFile(filePath, retained, "utf8");
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

function tailByUtf8Bytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }

  let retained = value.slice(Math.max(0, value.length - maxBytes));
  while (Buffer.byteLength(retained, "utf8") > maxBytes) {
    retained = retained.slice(Math.max(1, Math.ceil((Buffer.byteLength(retained, "utf8") - maxBytes) / 4)));
  }
  return retained;
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
