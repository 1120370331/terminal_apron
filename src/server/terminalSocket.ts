import type { Server, Socket } from "socket.io";
import { config } from "./config.js";
import { SessionStore } from "./db.js";
import { ensureTmuxSession } from "./tmux.js";
import { appendZellijTranscript, ensureZellijSession, zellijAttachArgs, zellijAttachCommand } from "./zellij.js";
import { userFromCookie } from "./auth.js";
import { loadPty } from "./pty.js";
import { resolveBackend } from "./backend.js";
import { NativeSessionManager } from "./nativeSessions.js";

export function registerTerminalSockets(io: Server, store: SessionStore, nativeSessions: NativeSessionManager): void {
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
    void attachTerminal(socket, store, nativeSessions);
  });
}

async function attachTerminal(
  socket: Socket,
  store: SessionStore,
  nativeSessions: NativeSessionManager
): Promise<void> {
  const sessionId = String(socket.handshake.query.sessionId ?? "");
  const session = await store.get(sessionId);
  if (!session) {
    socket.emit("terminal:error", "session not found");
    socket.disconnect(true);
    return;
  }

  try {
    const cols = clampDimension(socket.handshake.query.cols, 120, 20, 300);
    const rows = clampDimension(socket.handshake.query.rows, 36, 10, 120);
    const backend = await resolveBackend(session);
    if (backend === "native") {
      await nativeSessions.attach(session, socket, cols, rows);
      return;
    }
    if (backend === "zellij") {
      await attachZellij(socket, session, cols, rows);
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

  let transcriptQueue = Promise.resolve();
  term.onData((data) => {
    socket.emit("terminal:data", data);
    transcriptQueue = transcriptQueue
      .then(() => appendZellijTranscript(session.id, data))
      .catch(() => undefined);
  });

  term.onExit((event) => {
    socket.emit("terminal:exit", event);
    socket.disconnect(true);
  });

  socket.on("terminal:input", (data: string) => {
    term.write(data);
  });

  socket.on("terminal:resize", (size: { cols?: number; rows?: number }) => {
    const nextCols = clampDimension(size.cols, cols, 20, 300);
    const nextRows = clampDimension(size.rows, rows, 10, 120);
    term.resize(nextCols, nextRows);
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

  socket.on("terminal:resize", (size: { cols?: number; rows?: number }) => {
    const nextCols = clampDimension(size.cols, cols, 20, 300);
    const nextRows = clampDimension(size.rows, rows, 10, 120);
    term.resize(nextCols, nextRows);
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
