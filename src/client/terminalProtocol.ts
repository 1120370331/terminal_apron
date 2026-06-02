export const TERMINAL_PROTOCOL_VERSION = 2;

export type TerminalProtocolVersion = 1 | 2;
export type TerminalClientProfile = "desktop" | "mobile";
export type TerminalDataKind = "live" | "history";
export type TerminalConnectionState = "starting" | "live" | "detached" | "reconnecting" | "error";

export interface TerminalReadyFrame {
  sessionId?: string;
  streamId?: string;
  backend?: string;
  persistent?: boolean;
  cols?: number;
  rows?: number;
  newestSeq?: number;
  canResumeFromSeq?: boolean;
  canLoadOlderHistory?: boolean;
  attachCommand?: string | null;
}

export interface TerminalDataFrame {
  sessionId?: string;
  streamId?: string;
  seq?: number;
  kind: TerminalDataKind;
  data: string;
  byteLength?: number;
  emittedAt?: number;
}

export interface TerminalHistoryInitFrame {
  sessionId?: string;
  streamId?: string;
  snapshotSeq?: number;
  viewportAnsi: string;
  tailAnsi?: string;
  oldestLine?: number;
  newestLine?: number;
  tailFromOffset?: number;
  tailToOffset?: number;
  newestOffset?: number;
  byteLength?: number;
  lineCount?: number;
  hasMoreBefore: boolean;
}

export interface TerminalHistoryChunkFrame {
  sessionId?: string;
  requestId?: string;
  fromLine?: number;
  toLine?: number;
  fromOffset?: number;
  toOffset?: number;
  byteLength?: number;
  lineCount?: number;
  ansi: string;
  hasMoreBefore: boolean;
}

export interface TerminalStateFrame {
  sessionId?: string;
  state: TerminalConnectionState;
  latencyMs?: number;
  updatedAt?: string;
}

export interface TerminalFlowFrame {
  sessionId?: string;
  streamId?: string;
  paused: boolean;
  reason?: "client-backpressure" | "history-loading" | "network";
}

export interface TerminalInputAckFrame {
  sessionId?: string;
  inputId?: string;
  accepted: boolean;
  inputSeq?: number;
  message?: string;
}

export interface TerminalErrorFrame {
  sessionId?: string;
  code?: string;
  message: string;
  recoverable?: boolean;
}

export function normalizeTerminalReady(payload: unknown): TerminalReadyFrame {
  if (!isRecord(payload)) {
    return {};
  }

  return {
    sessionId: stringOrUndefined(payload.sessionId),
    streamId: stringOrUndefined(payload.streamId),
    backend: stringOrUndefined(payload.backend),
    persistent: booleanOrUndefined(payload.persistent),
    cols: finiteNumberOrUndefined(payload.cols),
    rows: finiteNumberOrUndefined(payload.rows),
    newestSeq: finiteNumberOrUndefined(payload.newestSeq),
    canResumeFromSeq: booleanOrUndefined(payload.canResumeFromSeq),
    canLoadOlderHistory: booleanOrUndefined(payload.canLoadOlderHistory),
    attachCommand: payload.attachCommand === null ? null : stringOrUndefined(payload.attachCommand)
  };
}

export function isProtocolV2Ready(payload: TerminalReadyFrame): boolean {
  return Boolean(payload.streamId || payload.persistent || typeof payload.newestSeq === "number");
}

export function normalizeTerminalData(payload: unknown): TerminalDataFrame | null {
  if (typeof payload === "string") {
    return {
      kind: "live",
      data: payload
    };
  }

  if (!isRecord(payload) || typeof payload.data !== "string") {
    return null;
  }

  return {
    sessionId: stringOrUndefined(payload.sessionId),
    streamId: stringOrUndefined(payload.streamId),
    seq: finiteNumberOrUndefined(payload.seq),
    kind: payload.kind === "history" ? "history" : "live",
    data: payload.data,
    byteLength: finiteNumberOrUndefined(payload.byteLength),
    emittedAt: finiteNumberOrUndefined(payload.emittedAt)
  };
}

export function normalizeTerminalHistoryInit(payload: unknown): TerminalHistoryInitFrame | null {
  if (!isRecord(payload)) {
    return null;
  }

  const viewportAnsi = typeof payload.viewportAnsi === "string" ? payload.viewportAnsi : "";
  const tailAnsi = typeof payload.tailAnsi === "string" ? payload.tailAnsi : undefined;
  return {
    sessionId: stringOrUndefined(payload.sessionId),
    streamId: stringOrUndefined(payload.streamId),
    snapshotSeq: finiteNumberOrUndefined(payload.snapshotSeq),
    viewportAnsi,
    tailAnsi,
    oldestLine: finiteNumberOrUndefined(payload.oldestLine),
    newestLine: finiteNumberOrUndefined(payload.newestLine),
    tailFromOffset: finiteNumberOrUndefined(payload.tailFromOffset),
    tailToOffset: finiteNumberOrUndefined(payload.tailToOffset),
    newestOffset: finiteNumberOrUndefined(payload.newestOffset),
    byteLength: finiteNumberOrUndefined(payload.byteLength),
    lineCount: finiteNumberOrUndefined(payload.lineCount),
    hasMoreBefore: payload.hasMoreBefore === true
  };
}

export function normalizeTerminalHistoryChunk(payload: unknown): TerminalHistoryChunkFrame | null {
  if (!isRecord(payload)) {
    return null;
  }

  return {
    sessionId: stringOrUndefined(payload.sessionId),
    requestId: stringOrUndefined(payload.requestId),
    fromLine: finiteNumberOrUndefined(payload.fromLine),
    toLine: finiteNumberOrUndefined(payload.toLine),
    fromOffset: finiteNumberOrUndefined(payload.fromOffset),
    toOffset: finiteNumberOrUndefined(payload.toOffset),
    byteLength: finiteNumberOrUndefined(payload.byteLength),
    lineCount: finiteNumberOrUndefined(payload.lineCount),
    ansi: typeof payload.ansi === "string" ? payload.ansi : "",
    hasMoreBefore: payload.hasMoreBefore === true
  };
}

export function normalizeTerminalState(payload: unknown): TerminalStateFrame | null {
  if (!isRecord(payload) || !isTerminalConnectionState(payload.state)) {
    return null;
  }

  return {
    sessionId: stringOrUndefined(payload.sessionId),
    state: payload.state,
    latencyMs: finiteNumberOrUndefined(payload.latencyMs),
    updatedAt: stringOrUndefined(payload.updatedAt)
  };
}

export function normalizeTerminalFlow(payload: unknown): TerminalFlowFrame | null {
  if (!isRecord(payload) || typeof payload.paused !== "boolean") {
    return null;
  }

  const reason =
    payload.reason === "client-backpressure" || payload.reason === "history-loading" || payload.reason === "network"
      ? payload.reason
      : undefined;
  return {
    sessionId: stringOrUndefined(payload.sessionId),
    streamId: stringOrUndefined(payload.streamId),
    paused: payload.paused,
    reason
  };
}

export function normalizeTerminalInputAck(payload: unknown): TerminalInputAckFrame | null {
  if (!isRecord(payload) || typeof payload.accepted !== "boolean") {
    return null;
  }

  return {
    sessionId: stringOrUndefined(payload.sessionId),
    inputId: stringOrUndefined(payload.inputId),
    accepted: payload.accepted,
    inputSeq: finiteNumberOrUndefined(payload.inputSeq),
    message: stringOrUndefined(payload.message)
  };
}

export function normalizeTerminalError(payload: unknown): TerminalErrorFrame {
  if (typeof payload === "string") {
    return { message: payload };
  }
  if (isRecord(payload)) {
    return {
      sessionId: stringOrUndefined(payload.sessionId),
      code: stringOrUndefined(payload.code),
      message: typeof payload.message === "string" ? payload.message : "terminal error",
      recoverable: booleanOrUndefined(payload.recoverable)
    };
  }
  return { message: "terminal error" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function finiteNumberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isTerminalConnectionState(value: unknown): value is TerminalConnectionState {
  return value === "starting" || value === "live" || value === "detached" || value === "reconnecting" || value === "error";
}
