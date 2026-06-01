export const TERMINAL_PROTOCOL_VERSION = 2;

export type TerminalBackendName = "zellij";
export type TerminalClientProfile = "desktop" | "mobile";
export type TerminalSubscriberMode = "interactive" | "preview";
export type TerminalHistoryPolicy = "none" | "viewport" | "tail";
export type TerminalDataKind = "history" | "live";
export type TerminalBrokerState = "starting" | "live" | "detached" | "reconnecting" | "error";
export type TerminalInputMode = "type" | "paste" | "quick-send";

export interface TerminalConnectQuery {
  protocolVersion: 2;
  sessionId: string;
  clientId: string;
  clientProfile: TerminalClientProfile;
  mode: TerminalSubscriberMode;
  cols?: number;
  rows?: number;
  lastAckSeq?: number;
  historyPolicy: TerminalHistoryPolicy;
  tailLines?: number;
}

export interface TerminalReadyFrame {
  version: 2;
  sessionId: string;
  streamId: string;
  backend: TerminalBackendName;
  persistent: true;
  cols: number;
  rows: number;
  newestSeq: number;
  canResumeFromSeq: boolean;
  canLoadOlderHistory: boolean;
  tmuxName?: string;
  attachCommand?: string | null;
}

export interface TerminalStateFrame {
  version: 2;
  sessionId: string;
  state: TerminalBrokerState;
  latencyMs?: number;
  updatedAt: string;
}

export interface TerminalDataFrame {
  version: 2;
  sessionId: string;
  streamId: string;
  seq: number;
  kind: TerminalDataKind;
  data: string;
  byteLength: number;
  emittedAt: number;
  requestId?: string;
  hasMoreBefore?: boolean;
}

export interface TerminalHistoryInitFrame {
  version: 2;
  sessionId: string;
  streamId: string;
  snapshotSeq: number;
  viewportAnsi: string;
  tailAnsi?: string;
  oldestLine?: number;
  newestLine?: number;
  hasMoreBefore: boolean;
}

export interface TerminalHistoryChunkFrame {
  version: 2;
  sessionId: string;
  requestId: string;
  fromLine?: number;
  toLine?: number;
  fromOffset?: number;
  toOffset?: number;
  ansi: string;
  hasMoreBefore: boolean;
}

export interface TerminalInputFrame {
  sessionId: string;
  inputId: string;
  data: string;
  mode: TerminalInputMode;
}

export interface TerminalInputAckFrame {
  version: 2;
  sessionId: string;
  inputId: string;
  accepted: boolean;
  inputSeq?: number;
  message?: string;
}

export interface TerminalResizeFrame {
  sessionId: string;
  cols: number;
  rows: number;
  seq: number;
  source: "interactive";
}

export interface TerminalAckFrame {
  sessionId: string;
  streamId: string;
  seq: number;
  renderedAt: number;
  writeQueueBytes: number;
}

export interface TerminalHistoryRequestFrame {
  sessionId: string;
  requestId: string;
  beforeLine?: number;
  beforeOffset?: number;
  limitLines?: number;
  maxBytes?: number;
  format: "ansi" | "plain";
}

export interface TerminalHistoryCancelFrame {
  sessionId: string;
  requestId: string;
}

export interface TerminalVisibilityFrame {
  sessionId: string;
  visible: boolean;
  atBottom: boolean;
}

export interface TerminalFlowFrame {
  version: 2;
  sessionId: string;
  streamId: string;
  paused: boolean;
  reason?: "client-backpressure" | "history-loading" | "network";
}

export type TerminalErrorCode =
  | "unauthorized"
  | "session-not-found"
  | "backend-unavailable"
  | "attach-failed"
  | "history-failed"
  | "resync-required";

export interface TerminalErrorFrame {
  version: 2;
  sessionId?: string;
  code: TerminalErrorCode;
  message: string;
  recoverable: boolean;
}
