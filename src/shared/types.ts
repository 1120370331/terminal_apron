export type AuthMethod = "none" | "password" | "ssh";
export type TerminalBackend = "auto" | "native" | "tmux" | "zellij";
export type ResolvedTerminalBackend = "native" | "tmux" | "zellij";
export type TerminalBackgroundMode = "inherit" | "none" | "image";

export interface AuthConfig {
  methods: AuthMethod[];
  user: string | null;
}

export interface AuthUser {
  name: string;
  method: AuthMethod;
}

export interface GridItemLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

export interface SessionRuntime {
  exists: boolean;
  backend: ResolvedTerminalBackend;
  persistent: boolean;
  attached: number;
  currentPath: string;
  currentCommand: string;
  windows: number;
  lastAttached: number | null;
  tmuxVersion?: string;
  zellijVersion?: string;
}

export type CodexSessionState = "stopped" | "ready" | "working" | "error";

export interface CodexSessionStatus {
  state: CodexSessionState;
  label: string;
  conversationId?: string;
  conversationTitle?: string;
  turnId?: string;
  errorCode?: string;
  errorMessage?: string;
  updatedAt?: string;
}

export interface TerminalSession {
  id: string;
  name: string;
  group: string;
  tags: string[];
  cwd: string;
  shell?: string;
  backend: TerminalBackend;
  tmuxName: string;
  color: string;
  backgroundMode: TerminalBackgroundMode;
  backgroundImage?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  stoppedAt?: string;
  codexConversationId?: string;
  codexAutoResume?: boolean;
  layout?: GridItemLayout;
  runtime?: SessionRuntime;
  codexStatus?: CodexSessionStatus;
}

export interface CreateSessionInput {
  name: string;
  group?: string;
  tags?: string[];
  cwd?: string;
  shell?: string;
  backend?: TerminalBackend;
  color?: string;
  backgroundMode?: TerminalBackgroundMode;
  backgroundImage?: string;
}

export interface UpdateSessionInput {
  name?: string;
  group?: string;
  tags?: string[];
  cwd?: string;
  shell?: string;
  backend?: TerminalBackend;
  color?: string;
  backgroundMode?: TerminalBackgroundMode;
  backgroundImage?: string;
  codexConversationId?: string;
  codexAutoResume?: boolean;
  archived?: boolean;
  layout?: GridItemLayout;
}

export interface UserPreferences {
  terminalBackgroundImage: string | null;
}

export interface BackgroundUploadResult {
  url: string;
  name: string;
}

export interface SessionPreview {
  sessionId: string;
  text: string;
  grid?: TerminalPreviewGrid;
  signature?: string;
  capturedAt: string;
}

export interface TerminalPreviewGrid {
  cols: number;
  rows: TerminalPreviewRow[];
}

export interface TerminalPreviewRow {
  segments: TerminalPreviewSegment[];
}

export interface TerminalPreviewSegment {
  text: string;
  cols: number;
  fg?: string;
  bg?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
}

export interface HealthStatus {
  ok: boolean;
  auth: AuthConfig;
  processUser: {
    username: string;
    homedir: string;
    shell?: string | null;
    uid?: number;
    gid?: number;
  };
  backend: {
    default: ResolvedTerminalBackend | null;
    configured: TerminalBackend;
    platform: string;
    error?: string;
  };
  tmux: {
    available: boolean;
    version?: string;
    error?: string;
  };
  zellij: {
    available: boolean;
    version?: string;
    error?: string;
  };
  nodePty: {
    available: boolean;
    error?: string;
  };
  dataDir: string;
}

export interface SystemMetrics {
  capturedAt: string;
  uptimeSec: number;
  cpu: {
    usagePercent: number;
    cores: number;
    model: string;
    loadAverage: number[];
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usagePercent: number;
    processRssBytes: number;
    processHeapUsedBytes: number;
    processHeapTotalBytes: number;
  };
}

export interface CodexConversationSummary {
  id: string;
  title: string;
  summary: string;
  cwd: string;
  source: string;
  model?: string;
  tokensUsed: number;
  createdAt: string;
  updatedAt: string;
}

export interface CodexConversationList {
  cwd: string;
  conversations: CodexConversationSummary[];
}

export interface CodexResumeResult {
  ok: boolean;
  command: string;
  conversation: CodexConversationSummary;
}
