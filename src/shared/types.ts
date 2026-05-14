export type AuthMethod = "none" | "password" | "ssh";
export type TerminalBackend = "auto" | "native" | "tmux" | "zellij";
export type ResolvedTerminalBackend = "native" | "tmux" | "zellij";

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
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  stoppedAt?: string;
  layout?: GridItemLayout;
  runtime?: SessionRuntime;
}

export interface CreateSessionInput {
  name: string;
  group?: string;
  tags?: string[];
  cwd?: string;
  shell?: string;
  backend?: TerminalBackend;
  color?: string;
}

export interface UpdateSessionInput {
  name?: string;
  group?: string;
  tags?: string[];
  cwd?: string;
  shell?: string;
  backend?: TerminalBackend;
  color?: string;
  archived?: boolean;
  layout?: GridItemLayout;
}

export interface SessionPreview {
  sessionId: string;
  text: string;
  grid?: TerminalPreviewGrid;
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
