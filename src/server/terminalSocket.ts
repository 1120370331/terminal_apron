import type { Server, Socket } from "socket.io";
import { config } from "./config.js";
import { SessionStore } from "./db.js";
import { ensureTmuxSession } from "./tmux.js";
import {
  appendZellijTranscript,
  ensureZellijSession,
  getZellijTrackedCwd,
  saveZellijSessionState,
  setZellijTrackedCwd,
  zellijAttachArgs,
  zellijAttachCommand
} from "./zellij.js";
import { userFromCookie } from "./auth.js";
import { loadPty, type PtyProcess } from "./pty.js";
import { resolveBackend } from "./backend.js";
import { NativeSessionManager } from "./nativeSessions.js";
import type { AuthUser } from "../shared/types.js";
import { createShellCommandTracker } from "./shellCwd.js";

const MAX_TERMINAL_COLS = 4096;
const MAX_TERMINAL_ROWS = 2048;
const ZELLIJ_WEB_COLS = 120;
const ZELLIJ_WEB_ROWS = 36;
const ZELLIJ_WEB_SCROLLBACK_LINES = 10_000;
const ZELLIJ_SAVE_DEBOUNCE_MS = 10_000;
const ZELLIJ_OUTPUT_FLUSH_MS = 12;
const ZELLIJ_OUTPUT_CHUNK_CHARS = 128_000;
const ZELLIJ_TRANSCRIPT_REPLAY_GRACE_MS = 2000;

type TerminalClientProfile = "desktop" | "mobile";

interface TerminalDimensions {
  cols: number;
  rows: number;
}

interface ZellijWebClient {
  socket: Socket;
  term: PtyProcess;
  profile: TerminalClientProfile;
  desired: TerminalDimensions;
  applied: TerminalDimensions;
}

const zellijWebClients = new Map<string, Map<string, ZellijWebClient>>();

export function hasActiveZellijWebClient(sessionName: string): boolean {
  return Boolean(zellijWebClients.get(sessionName)?.size);
}

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
      await attachZellij(
        socket,
        session,
        store,
        cols,
        rows,
        socket.handshake.query.clientProfile === "mobile" ? "mobile" : "desktop"
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
  store: SessionStore,
  cols: number,
  rows: number,
  profile: TerminalClientProfile
): Promise<void> {
  const dataDir = store.dataDir;
  await ensureZellijSession(session);
  const desired = { cols, rows };
  const initialSize = sharedZellijWebSize(session.tmuxName, { profile, desired });
  const pty = await loadPty();
  const term = pty.spawn(config.zellijBin, zellijAttachArgs(session, ZELLIJ_WEB_SCROLLBACK_LINES), {
    name: "xterm-256color",
    cols: initialSize.cols,
    rows: initialSize.rows,
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
  registerZellijWebClient(session.tmuxName, socket, term, profile, desired, initialSize);
  applySharedZellijWebSize(session.tmuxName, socket.id, 0);

  let transcriptQueue = Promise.resolve();
  const transcriptCaptureStartsAt = Date.now() + ZELLIJ_TRANSCRIPT_REPLAY_GRACE_MS;
  let outboundBuffer = "";
  let outboundTimer: NodeJS.Timeout | null = null;
  let saveTimer: NodeJS.Timeout | null = null;
  let lastSaveAt = 0;
  let closed = false;
  const commandTracker = createShellCommandTracker(
    getZellijTrackedCwd(session.tmuxName) ?? session.cwd,
    (cwd) => {
      setZellijTrackedCwd(session.tmuxName, cwd);
      void store.update(session.id, { cwd }).catch(() => undefined);
    },
    () => getZellijTrackedCwd(session.tmuxName)
  );
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
  const flushOutbound = () => {
    outboundTimer = null;
    if (!outboundBuffer || closed) {
      return;
    }
    const chunk = outboundBuffer.slice(0, ZELLIJ_OUTPUT_CHUNK_CHARS);
    outboundBuffer = outboundBuffer.slice(chunk.length);
    socket.emit("terminal:data", chunk);
    if (outboundBuffer) {
      outboundTimer = setTimeout(flushOutbound, ZELLIJ_OUTPUT_FLUSH_MS);
    }
  };

  term.onData((data) => {
    outboundBuffer += data;
    outboundTimer ??= setTimeout(flushOutbound, ZELLIJ_OUTPUT_FLUSH_MS);
    if (Date.now() >= transcriptCaptureStartsAt) {
      transcriptQueue = transcriptQueue
        .then(() => appendZellijTranscript(session.id, data, dataDir))
        .catch(() => undefined);
    }
    scheduleSave();
  });

  term.onExit((event) => {
    closed = true;
    unregisterZellijWebClient(session.tmuxName, socket.id);
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (outboundTimer) {
      clearTimeout(outboundTimer);
      outboundTimer = null;
    }
    socket.emit("terminal:exit", event);
    socket.disconnect(true);
  });

  socket.on("terminal:input", (data: string) => {
    commandTracker.feed(data);
    term.write(data);
    scheduleSave();
  });

  socket.on("terminal:resize", (size: { cols?: number; rows?: number; seq?: number }) => {
    const client = zellijWebClients.get(session.tmuxName)?.get(socket.id);
    if (!client) {
      return;
    }
    client.desired = {
      cols: clampDimension(size.cols, client.desired.cols, 20, MAX_TERMINAL_COLS),
      rows: clampDimension(size.rows, client.desired.rows, 10, MAX_TERMINAL_ROWS)
    };
    applySharedZellijWebSize(session.tmuxName, socket.id, size.seq);
  });

  socket.on("disconnect", () => {
    unregisterZellijWebClient(session.tmuxName, socket.id);
    if (closed) {
      return;
    }
    closed = true;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (outboundTimer) {
      clearTimeout(outboundTimer);
      outboundTimer = null;
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

function registerZellijWebClient(
  sessionName: string,
  socket: Socket,
  term: PtyProcess,
  profile: TerminalClientProfile,
  desired: TerminalDimensions,
  applied: TerminalDimensions
): void {
  let clients = zellijWebClients.get(sessionName);
  if (!clients) {
    clients = new Map();
    zellijWebClients.set(sessionName, clients);
  }
  clients.set(socket.id, { socket, term, profile, desired, applied });
}

function unregisterZellijWebClient(sessionName: string, socketId: string): void {
  const clients = zellijWebClients.get(sessionName);
  if (!clients?.delete(socketId)) {
    return;
  }
  if (clients.size === 0) {
    zellijWebClients.delete(sessionName);
    return;
  }
  applySharedZellijWebSize(sessionName);
}

function applySharedZellijWebSize(sessionName: string, sourceSocketId?: string, seq?: number): void {
  const clients = zellijWebClients.get(sessionName);
  if (!clients?.size) {
    return;
  }
  const next = sharedZellijWebSize(sessionName);
  for (const [socketId, client] of clients) {
    if (client.applied.cols !== next.cols || client.applied.rows !== next.rows) {
      try {
        client.term.resize(next.cols, next.rows);
        client.applied = next;
      } catch {
        // A disconnecting client can disappear while the shared size is being applied.
      }
    }
    client.socket.emit("terminal:resized", {
      ...next,
      ...(socketId === sourceSocketId && typeof seq === "number" ? { seq } : {})
    });
  }
}

function sharedZellijWebSize(
  sessionName: string,
  pending?: { profile: TerminalClientProfile; desired: TerminalDimensions }
): TerminalDimensions {
  const desktopSizes = Array.from(zellijWebClients.get(sessionName)?.values() ?? [])
    .filter((client) => client.profile === "desktop")
    .map((client) => client.desired);
  if (pending?.profile === "desktop") {
    desktopSizes.push(pending.desired);
  }
  if (desktopSizes.length === 0) {
    return { cols: ZELLIJ_WEB_COLS, rows: ZELLIJ_WEB_ROWS };
  }
  return {
    cols: Math.max(...desktopSizes.map((size) => size.cols)),
    rows: Math.max(...desktopSizes.map((size) => size.rows))
  };
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
