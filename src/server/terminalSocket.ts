import type { Server, Socket } from "socket.io";
import { config } from "./config.js";
import { SessionStore } from "./db.js";
import { ensureTmuxSession } from "./tmux.js";
import {
  appendZellijTranscript,
  captureZellijAttachHistory,
  createZellijAttachOutputFilter,
  ensureZellijSession,
  saveZellijSessionState,
  zellijAttachArgs,
  zellijAttachCommand
} from "./zellij.js";
import { userFromCookie } from "./auth.js";
import { loadPty } from "./pty.js";
import { resolveBackend } from "./backend.js";
import { NativeSessionManager } from "./nativeSessions.js";
import { emitTerminalData } from "./terminalData.js";
import type { AuthUser } from "../shared/types.js";

const MAX_TERMINAL_COLS = 4096;
const MAX_TERMINAL_ROWS = 2048;
const ZELLIJ_WEB_COLS = 120;
const ZELLIJ_WEB_ROWS = 36;
const ZELLIJ_SAVE_DEBOUNCE_MS = 10_000;

export function registerTerminalSockets(
  io: Server,
  storeForUser: (user: AuthUser) => Promise<SessionStore>,
  nativeSessions: NativeSessionManager
): void {
  io.use(async (socket, next) => {
    const user = await userFromCookie(socket.handshake.headers.cookie);
    if (!user) {
      next(new Error("unauthorized"));
      return;
    }
    socket.data.user = user;
    next();
  });

  io.on("connection", (socket) => {
    void attachTerminal(socket, storeForUser, nativeSessions);
  });
}

async function attachTerminal(
  socket: Socket,
  storeForUser: (user: AuthUser) => Promise<SessionStore>,
  nativeSessions: NativeSessionManager
): Promise<void> {
  const user = socket.data.user as AuthUser | undefined;
  if (!user) {
    socket.emit("terminal:error", "unauthorized");
    socket.disconnect(true);
    return;
  }

  try {
    const store = await storeForUser(user);
    const sessionId = String(socket.handshake.query.sessionId ?? "");
    const session = await store.get(sessionId);
    if (!session) {
      socket.emit("terminal:error", "session not found");
      socket.disconnect(true);
      return;
    }

    const cols = clampDimension(socket.handshake.query.cols, 120, 20, MAX_TERMINAL_COLS);
    const rows = clampDimension(socket.handshake.query.rows, 36, 10, MAX_TERMINAL_ROWS);
    const isMobileClient = socket.handshake.query.clientProfile === "mobile";
    const backend = await resolveBackend(session);
    if (backend === "native") {
      await nativeSessions.attach(session, socket, store.dataDir, cols, rows);
      return;
    }
    if (backend === "zellij") {
      await attachZellij(
        socket,
        session,
        store.dataDir,
        isMobileClient ? cols : ZELLIJ_WEB_COLS,
        isMobileClient ? rows : ZELLIJ_WEB_ROWS,
        !isMobileClient
      );
      return;
    }
    await attachTmux(socket, session, cols, rows);
  } catch (error) {
    socket.emit("terminal:error", error instanceof Error ? error.message : String(error));
    socket.disconnect(true);
  }
}

async function attachZellij(
  socket: Socket,
  session: { id: string; tmuxName: string; cwd: string; shell?: string },
  dataDir: string,
  cols: number,
  rows: number,
  stableSize: boolean
): Promise<void> {
  await ensureZellijSession(session);
  const attachHistory = await captureZellijAttachHistory(session, dataDir).catch(() => "");
  const pty = await loadPty();
  let currentCols = cols;
  let currentRows = rows;
  const term = pty.spawn(config.zellijBin, zellijAttachArgs(session), {
    name: "xterm-256color",
    cols: currentCols,
    rows: currentRows,
    cwd: session.cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor"
    }
  });

  socket.emit("terminal:ready", {
    backend: "zellij",
    persistent: true,
    tmuxName: session.tmuxName,
    attachCommand: zellijAttachCommand(session)
  });
  socket.emit("terminal:resized", { cols: currentCols, rows: currentRows, seq: 0 });

  let transcriptQueue = Promise.resolve();
  let replayingHistory = true;
  const pendingLiveData: string[] = [];
  let saveTimer: NodeJS.Timeout | null = null;
  let lastSaveAt = 0;
  let closed = false;
  const saveNow = () => {
    lastSaveAt = Date.now();
    return saveZellijSessionState(session.tmuxName).catch(() => undefined);
  };
  const scheduleSave = () => {
    if (closed) {
      return;
    }

    const elapsed = Date.now() - lastSaveAt;
    if (elapsed >= ZELLIJ_SAVE_DEBOUNCE_MS) {
      void saveNow();
      return;
    }

    if (!saveTimer) {
      saveTimer = setTimeout(() => {
        saveTimer = null;
        void saveNow();
      }, ZELLIJ_SAVE_DEBOUNCE_MS - elapsed);
    }
  };

  const emitLiveData = (data: string) => {
    emitTerminalData(socket, data);
    transcriptQueue = transcriptQueue
      .then(() => appendZellijTranscript(session.id, data, dataDir))
      .catch(() => undefined);
    scheduleSave();
  };
  const outputFilter = createZellijAttachOutputFilter();

  term.onData((data) => {
    if (replayingHistory) {
      pendingLiveData.push(data);
      return;
    }
    const filtered = outputFilter(data);
    if (filtered) {
      emitLiveData(filtered);
    }
  });

  if (attachHistory.trim()) {
    emitTerminalData(socket, normalizeAttachHistory(attachHistory));
  }
  replayingHistory = false;
  for (const data of pendingLiveData) {
    const filtered = outputFilter(data);
    if (filtered) {
      emitLiveData(filtered);
    }
  }
  pendingLiveData.length = 0;

  term.onExit((event) => {
    closed = true;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    socket.emit("terminal:exit", event);
    socket.disconnect(true);
  });

  socket.on("terminal:input", (data: string) => {
    term.write(data);
    scheduleSave();
  });

  socket.on("terminal:resize", (size: { cols?: number; rows?: number; seq?: number }) => {
    if (stableSize) {
      const nextRows = clampDimension(size.rows, currentRows, 10, MAX_TERMINAL_ROWS);
      if (nextRows !== currentRows) {
        currentRows = nextRows;
        term.resize(currentCols, currentRows);
      }
      socket.emit("terminal:resized", { cols: currentCols, rows: currentRows, seq: size.seq });
      return;
    }
    currentCols = clampDimension(size.cols, currentCols, 20, MAX_TERMINAL_COLS);
    currentRows = clampDimension(size.rows, currentRows, 10, MAX_TERMINAL_ROWS);
    term.resize(currentCols, currentRows);
    socket.emit("terminal:resized", { cols: currentCols, rows: currentRows, seq: size.seq });
  });

  socket.on("disconnect", () => {
    if (closed) {
      return;
    }
    closed = true;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }

    void Promise.all([transcriptQueue.catch(() => undefined), saveNow()]).finally(() => {
      try {
        term.kill();
      } catch {
        // The zellij client may already have detached.
      }
    });
  });
}

async function attachTmux(
  socket: Socket,
  session: { tmuxName: string; cwd: string },
  cols: number,
  rows: number
): Promise<void> {
  await ensureTmuxSession(session);
  const pty = await loadPty();
  const term = pty.spawn(config.tmuxBin, ["attach-session", "-t", session.tmuxName], {
    name: "xterm-256color",
    cols,
    rows,
    cwd: session.cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor"
    }
  });

  socket.emit("terminal:ready", {
    backend: "tmux",
    persistent: true,
    tmuxName: session.tmuxName,
    attachCommand: `tmux attach -t ${session.tmuxName}`
  });
  socket.emit("terminal:resized", { cols, rows, seq: 0 });

  term.onData((data) => {
    emitTerminalData(socket, data);
  });

  term.onExit((event) => {
    socket.emit("terminal:exit", event);
    socket.disconnect(true);
  });

  socket.on("terminal:input", (data: string) => {
    term.write(data);
  });

  socket.on("terminal:resize", (size: { cols?: number; rows?: number; seq?: number }) => {
    const nextCols = clampDimension(size.cols, cols, 20, MAX_TERMINAL_COLS);
    const nextRows = clampDimension(size.rows, rows, 10, MAX_TERMINAL_ROWS);
    term.resize(nextCols, nextRows);
    socket.emit("terminal:resized", { cols: nextCols, rows: nextRows, seq: size.seq });
  });

  socket.on("disconnect", () => {
    term.kill();
  });
}

function clampDimension(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeAttachHistory(value: string): string {
  if (!value) {
    return "";
  }
  const normalized = value.replace(/\r?\n/g, "\r\n");
  return normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`;
}
