import crypto from "node:crypto";
import type { Server, Socket } from "socket.io";
import { config } from "./config.js";
import { SessionStore } from "./db.js";
import { userFromCookie } from "./auth.js";
import { resolveBackend } from "./backend.js";
import type { NativeSessionManager } from "./nativeSessions.js";
import { getTerminalBroker, type TerminalBrokerSubscribeOptions } from "./terminalBroker.js";
import { terminalProxyConfig } from "./terminalProxy.js";
import type {
  TerminalClientProfile,
  TerminalErrorFrame,
  TerminalHistoryPolicy,
  TerminalSubscriberMode
} from "../shared/terminalProtocol.js";
import { TERMINAL_PROTOCOL_VERSION } from "../shared/terminalProtocol.js";
import type { AuthUser } from "../shared/types.js";

const MAX_TERMINAL_COLS = 4096;
const MAX_TERMINAL_ROWS = 2048;

export function registerTerminalSockets(
  io: Server,
  storeForUser: (user: AuthUser) => Promise<SessionStore>,
  _nativeSessions: NativeSessionManager
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
    void attachTerminal(socket, storeForUser);
  });
}

async function attachTerminal(
  socket: Socket,
  storeForUser: (user: AuthUser) => Promise<SessionStore>
): Promise<void> {
  const protocolVersion = parseProtocolVersion(socket.handshake.query.protocolVersion);
  socket.data.terminalProtocolVersion = protocolVersion;

  const user = socket.data.user as AuthUser | undefined;
  if (!user) {
    emitTerminalError(socket, protocolVersion, "unauthorized", "unauthorized", false);
    socket.disconnect(true);
    return;
  }

  try {
    const store = await storeForUser(user);
    const sessionId = String(socket.handshake.query.sessionId ?? "");
    const session = await store.get(sessionId);
    if (!session) {
      emitTerminalError(socket, protocolVersion, "session-not-found", "session not found", false, sessionId);
      socket.disconnect(true);
      return;
    }

    const backend = await resolveBackend(session);
    if (backend !== "zellij") {
      emitTerminalError(socket, protocolVersion, "backend-unavailable", "zellij backend is required", false, session.id);
      socket.disconnect(true);
      return;
    }

    const broker = getTerminalBroker(
      session,
      store.dataDir,
      terminalProxyConfig(await store.preferences()),
      async (threadId) => {
        await store.updateCodexThread(session.id, threadId);
      }
    );
    broker.subscribe(socket, parseSubscribeOptions(socket));
  } catch (error) {
    emitTerminalError(
      socket,
      protocolVersion,
      "backend-unavailable",
      error instanceof Error ? error.message : String(error),
      false
    );
    socket.disconnect(true);
  }
}

function parseSubscribeOptions(socket: Socket): TerminalBrokerSubscribeOptions {
  const query = socket.handshake.query;
  const clientProfile: TerminalClientProfile = query.clientProfile === "mobile" ? "mobile" : "desktop";
  const protocolVersion = parseProtocolVersion(query.protocolVersion);
  return {
    clientId: typeof query.clientId === "string" && query.clientId ? query.clientId : crypto.randomUUID(),
    protocolVersion,
    clientProfile,
    mode: parseMode(query.mode),
    cols: clampDimension(query.cols, 120, 20, MAX_TERMINAL_COLS),
    rows: clampDimension(query.rows, 36, 10, MAX_TERMINAL_ROWS),
    lastAckSeq: clampDimension(query.lastAckSeq, 0, 0, Number.MAX_SAFE_INTEGER),
    historyPolicy: parseHistoryPolicy(query.historyPolicy, protocolVersion),
    tailLines: clampDimension(query.tailLines, config.terminalHistoryColdTailLines, 20, config.terminalHistoryColdTailLines)
  };
}

function parseProtocolVersion(value: unknown): number {
  return Number(value) >= TERMINAL_PROTOCOL_VERSION ? TERMINAL_PROTOCOL_VERSION : 1;
}

function parseMode(value: unknown): TerminalSubscriberMode {
  return value === "preview" ? "preview" : "interactive";
}

function parseHistoryPolicy(value: unknown, protocolVersion: number): TerminalHistoryPolicy {
  if (value === "none" || value === "viewport" || value === "tail") {
    return value;
  }
  return protocolVersion >= 2 ? "viewport" : "tail";
}

function emitTerminalError(
  socket: Socket,
  protocolVersion: number,
  code: TerminalErrorFrame["code"],
  message: string,
  recoverable: boolean,
  sessionId?: string
): void {
  if (protocolVersion >= 2) {
    socket.emit("terminal:error", {
      version: TERMINAL_PROTOCOL_VERSION,
      sessionId,
      code,
      message,
      recoverable
    });
    return;
  }

  socket.emit("terminal:error", message);
}

function clampDimension(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
