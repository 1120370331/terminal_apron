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
  gridColumns?: number;
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
  taskId?: string;
  taskKey?: string;
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
  codexThreadId?: string;
  codexThreadUpdatedAt?: string;
  layout?: GridItemLayout;
  runtime?: SessionRuntime;
}

export interface TerminalRestartResult {
  sessionId: string;
  sessionName: string;
  restarted: boolean;
  codexWasRunning: boolean;
  codexThreadId?: string;
  codexResumed: boolean;
  error?: string;
}

export interface TerminalBatchRestartResult {
  total: number;
  succeeded: number;
  failed: number;
  codexResumed: number;
  results: TerminalRestartResult[];
}

export interface CreateSessionInput {
  name: string;
  group?: string;
  tags?: string[];
  taskId?: string;
  taskKey?: string;
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
  taskId?: string | null;
  taskKey?: string | null;
  cwd?: string;
  shell?: string;
  backend?: TerminalBackend;
  color?: string;
  backgroundMode?: TerminalBackgroundMode;
  backgroundImage?: string;
  archived?: boolean;
  layout?: GridItemLayout;
}

export interface UserPreferences {
  terminalBackgroundImage: string | null;
  terminalProxyEnabled: boolean;
  terminalProxyUrl: string;
}

export interface BackgroundUploadResult {
  url: string;
  name: string;
}

export type FilesystemLocationKind = "home" | "desktop" | "documents" | "downloads" | "drive";

export interface FilesystemLocation {
  label: string;
  path: string;
  kind: FilesystemLocationKind;
}

export interface FilesystemDirectory {
  name: string;
  path: string;
}

export interface DirectoryBrowserResult {
  path: string;
  parentPath: string | null;
  locations: FilesystemLocation[];
  directories: FilesystemDirectory[];
}

export type SessionInputMode = "paste" | "type";

export interface SessionInputRequest {
  data: string;
  enter?: boolean;
  submitKey?: "enter";
  mode?: SessionInputMode;
  submitDelayMs?: number;
}

export interface SessionPreview {
  sessionId: string;
  text: string;
  grid?: TerminalPreviewGrid;
  signature?: string;
  capturedAt: string;
  unchanged?: boolean;
  debug?: SessionPreviewDebug;
}

export interface SessionPreviewDebug {
  cache: "hit" | "miss" | "stale" | "refreshing";
  ageMs?: number;
  captureMs?: number;
  renderMs?: number;
  totalMs?: number;
  payloadBytes?: number;
}

export interface SessionUploadFile {
  originalName: string;
  fileName: string;
  mimeType: string;
  size: number;
  path: string;
  terminalText: string;
}

export interface SessionUploadResponse {
  files: SessionUploadFile[];
  terminalText: string;
}

export interface FileTransferEntry {
  name: string;
  relativePath: string;
  path: string;
  terminalText: string;
  size: number;
  modifiedAt: string;
  mimeType: string;
}

export interface FileTransferListResponse {
  rootPath: string;
  terminalText: string;
  files: FileTransferEntry[];
}

export interface FileTransferUploadResponse {
  rootPath: string;
  terminalText: string;
  files: FileTransferEntry[];
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
