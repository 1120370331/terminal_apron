import type { Server, Socket } from "socket.io";
import { config } from "./config.js";
import { SessionStore } from "./db.js";
import { ensureTmuxSession } from "./tmux.js";
import { appendZellijTranscript, ensureZellijSession, zellijAttachArgs, zellijAttachCommand } from "./zellij.js";
import { userFromCookie } from "./auth.js";
import { loadPty } from "./pty.js";
import { resolveBackend } from "./backend.js";
import { NativeSessionManager } from "./nativeSessions.js";
import type { AuthUser } from "../shared/types.js";

const MAX_TERMINAL_COLS = 4096;
const MAX_TERMINAL_ROWS = 2048;

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
  const store = await storeForUser(user);
  const sessionId = String(socket.handshake.query.sessionId ?? "");
  const session = await store.get(sessionId);
  if (!session) {
    socket.emit("terminal:error", "session not found");
    socket.disconnect(true);
    return;
  }

  try {
    const cols = clampDimension(socket.handshake.query.cols, 120, 20, MAX_TERMINAL_COLS);
    const rows = clampDimension(socket.handshake.query.rows, 36, 10, MAX_TERMINAL_ROWS);
    const backend = await resolveBackend(session);
    if (backend === "native") {
      await nativeSessions.attach(session, socket, store.dataDir, cols, rows);
      return;
    }
    if (backend === "zellij") {
      await attachZellij(socket, session, store.dataDir, cols, rows);
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
  rows: number
): Promise<void> {
  await ensureZellijSession(session);
  const pty = await loadPty();
  const term = pty.spawn(config.zellijBin, zellijAttachArgs(session), {
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
    backend: "zellij",
    persistent: true,
    tmuxName: session.tmuxName,
    attachCommand: zellijAttachCommand(session)
  });
  socket.emit("terminal:resized", { cols, rows, seq: 0 });

  let transcriptQueue = Promise.resolve();
  term.onData((data) => {
    socket.emit("terminal:data", data);
    transcriptQueue = transcriptQueue
      .then(() => appendZellijTranscript(session.id, data, dataDir))
      .catch(() => undefined);
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
    socket.emit("terminal:data", data);
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
