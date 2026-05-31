import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { WidthProvider, Responsive, type Layout } from "react-grid-layout";
import {
  Archive,
  Activity,
  Boxes,
  Cpu,
  FolderOpen,
  Laptop,
  LayoutGrid,
  LogOut,
  MemoryStick,
  MonitorUp,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Type
} from "lucide-react";
import type {
  AuthUser,
  HealthStatus,
  SessionPreview,
  SystemMetrics,
  TerminalPreviewGrid,
  TerminalSession
} from "../shared/types";
import { api, ApiError } from "./api";
import { Login } from "./components/Login";
import { FileTransferPanel } from "./components/FileTransferPanel";
import { SessionCard } from "./components/SessionCard";
import { SessionEditor } from "./components/SessionEditor";
import { TerminalDock } from "./components/TerminalDock";

const ResponsiveGrid = WidthProvider(Responsive);
const FILTER_STATE_KEY = "terminal-web-monitor.filters.v1";
const SETTINGS_STATE_KEY = "terminal-web-monitor.settings.v1";
const DEFAULT_BROWSER_TITLE = "Terminal Web Monitor";
const DEFAULT_ROW_HEIGHT = 48;
const DEFAULT_CARD_ROWS = 12;
const MIN_CARD_ROWS = 6;
const SESSION_REFRESH_MS = 1000;
const SYSTEM_METRICS_REFRESH_MS = 1000;
const SYSTEM_METRICS_HISTORY_LIMIT = 120;
const DEFAULT_PREVIEW_LINES = 600;
const MAX_LIST_PREVIEW_LINES = 1200;
const FULL_PREVIEW_REFRESH_MS = 10_000;
const REMOTE_SESSION_REFRESH_MS = 2500;
const REMOTE_SYSTEM_METRICS_REFRESH_MS = 5000;
const REMOTE_PREVIEW_MIN_REFRESH_MS = 2500;
const REMOTE_FULL_PREVIEW_REFRESH_MS = 30_000;
const LOCAL_PREVIEW_MAX_CHARS = 500_000;
const REMOTE_PREVIEW_MAX_CHARS = 120_000;
const PREVIEW_REVEAL_TIMEOUT_MS = 1500;
const DESKTOP_INITIAL_PREVIEW_CARDS = 3;
const MOBILE_INITIAL_PREVIEW_CARDS = 2;
const MOBILE_QUERY = "(max-width: 720px)";
const LEGACY_GRID_COLUMNS = 12;
const GRID_COLUMNS = 24;
const CARD_COLUMNS = 8;
const MIN_CARD_COLUMNS = 4;
const MIN_LAYOUT_ROWS = 5;
const GRID_MARGIN: [number, number] = [14, 14];
const GRID_RESIZE_HANDLES: Array<"s" | "w" | "e" | "n" | "sw" | "nw" | "se" | "ne"> = [
  "s",
  "w",
  "e",
  "n",
  "sw",
  "nw",
  "se",
  "ne"
];
type ThemeMode = "system" | "light" | "dark";

interface PanelSettings {
  browserTitle: string;
  rowHeight: number;
  defaultCardRows: number;
  minCardRows: number;
  previewMinHeight: number;
  previewLines: number;
  previewRefreshMs: number;
  maxPreviewCards: number;
  listTerminalFontSize: number;
  listTerminalScale: number;
  inlineSubmitKey: "enter";
  themeMode: ThemeMode;
}

interface FilterState {
  query: string;
  groupFilter: string;
  tagFilter: string;
  showArchived: boolean;
}

const DEFAULT_SETTINGS: PanelSettings = {
  browserTitle: DEFAULT_BROWSER_TITLE,
  rowHeight: DEFAULT_ROW_HEIGHT,
  defaultCardRows: DEFAULT_CARD_ROWS,
  minCardRows: MIN_CARD_ROWS,
  previewMinHeight: 500,
  previewLines: DEFAULT_PREVIEW_LINES,
  previewRefreshMs: 1000,
  maxPreviewCards: 24,
  listTerminalFontSize: 16,
  listTerminalScale: 100,
  inlineSubmitKey: "enter",
  themeMode: "system"
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseThemeMode(value: unknown): ThemeMode {
  return value === "light" || value === "dark" || value === "system" ? value : DEFAULT_SETTINGS.themeMode;
}

function normalizeBrowserTitle(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_SETTINGS.browserTitle;
  }
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function effectiveBrowserTitle(value: string): string {
  return value.trim() || DEFAULT_BROWSER_TITLE;
}

function isRemoteBrowserHost(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const hostname = window.location.hostname.toLowerCase();
  return !["localhost", "127.0.0.1", "::1", ""].includes(hostname);
}

function isTerminalInputFocused(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    return false;
  }
  return Boolean(active.closest(".quick-input, .terminal-dock"));
}

function resolveThemeMode(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system" || typeof window === "undefined") {
    return mode === "dark" ? "dark" : "light";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function nextThemeMode(mode: ThemeMode): ThemeMode {
  if (mode === "system") {
    return "dark";
  }
  if (mode === "dark") {
    return "light";
  }
  return "system";
}

function useMediaQuery(query: string): boolean {
  const getMatches = () => (typeof window === "undefined" ? false : window.matchMedia(query).matches);
  const [matches, setMatches] = useState(getMatches);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const media = window.matchMedia(query);
    const updateMatches = () => setMatches(media.matches);
    updateMatches();
    media.addEventListener("change", updateMatches);
    return () => media.removeEventListener("change", updateMatches);
  }, [query]);

  return matches;
}

function userStorageKey(base: string, userName: string): string {
  const safeUser = userName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_") || "user";
  return `${base}.${safeUser}`;
}

function loadPanelSettings(storageKey = SETTINGS_STATE_KEY): PanelSettings {
  if (typeof window === "undefined") {
    return DEFAULT_SETTINGS;
  }

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) {
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(stored) as Partial<PanelSettings>;
    return {
      browserTitle: normalizeBrowserTitle(parsed.browserTitle),
      rowHeight: clampNumber(parsed.rowHeight, DEFAULT_SETTINGS.rowHeight, 24, 180),
      defaultCardRows: clampNumber(parsed.defaultCardRows, DEFAULT_SETTINGS.defaultCardRows, 3, 32),
      minCardRows: clampNumber(parsed.minCardRows, DEFAULT_SETTINGS.minCardRows, 3, 32),
      previewMinHeight: clampNumber(parsed.previewMinHeight, DEFAULT_SETTINGS.previewMinHeight, 160, 1400),
      previewLines: clampNumber(parsed.previewLines, DEFAULT_SETTINGS.previewLines, 20, MAX_LIST_PREVIEW_LINES),
      previewRefreshMs: clampNumber(parsed.previewRefreshMs, DEFAULT_SETTINGS.previewRefreshMs, 1000, 30000),
      maxPreviewCards: clampNumber(parsed.maxPreviewCards, DEFAULT_SETTINGS.maxPreviewCards, 1, 100),
      listTerminalFontSize: clampNumber(parsed.listTerminalFontSize, DEFAULT_SETTINGS.listTerminalFontSize, 12, 24),
      listTerminalScale: clampNumber(parsed.listTerminalScale, DEFAULT_SETTINGS.listTerminalScale, 80, 140),
      inlineSubmitKey: "enter",
      themeMode: parseThemeMode(parsed.themeMode)
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadFilterState(storageKey = FILTER_STATE_KEY): FilterState {
  if (typeof window === "undefined") {
    return {
      query: "",
      groupFilter: "all",
      tagFilter: "all",
      showArchived: false
    };
  }

  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) {
      throw new Error("missing stored filters");
    }
    const parsed = JSON.parse(stored) as Partial<FilterState>;
    return {
      query: typeof parsed.query === "string" ? parsed.query : "",
      groupFilter: typeof parsed.groupFilter === "string" ? parsed.groupFilter : "all",
      tagFilter: typeof parsed.tagFilter === "string" ? parsed.tagFilter : "all",
      showArchived: typeof parsed.showArchived === "boolean" ? parsed.showArchived : false
    };
  } catch {
    return {
      query: "",
      groupFilter: "all",
      tagFilter: "all",
      showArchived: false
    };
  }
}

function sameSessionList(previous: TerminalSession[], next: TerminalSession[]): boolean {
  if (previous.length !== next.length) {
    return false;
  }

  for (let index = 0; index < previous.length; index += 1) {
    if (sessionSignature(previous[index]) !== sessionSignature(next[index])) {
      return false;
    }
  }
  return true;
}

function mergeLocalLayoutsIntoSessions(
  sessions: TerminalSession[],
  localLayout: Layout[],
  offsetY: number
): TerminalSession[] {
  if (localLayout.length === 0) {
    return sessions;
  }

  const localById = new Map(localLayout.map((item) => [item.i, layoutToSessionLayout(item, offsetY)]));
  return sessions.map((session) => {
    const layout = localById.get(session.id);
    return layout ? { ...session, layout } : session;
  });
}

function sessionSignature(session: TerminalSession): string {
  const runtime = session.runtime;
  const layout = session.layout;
  return [
    session.id,
    session.name,
    session.group,
    session.tags.join(","),
    session.cwd,
    session.shell ?? "",
    session.backend,
    session.tmuxName,
    session.color,
    String(session.archived),
    session.updatedAt,
    session.archivedAt ?? "",
    session.stoppedAt ?? "",
    layout ? `${layout.x},${layout.y},${layout.w},${layout.h},${layout.minW ?? ""},${layout.minH ?? ""}` : "",
    runtime?.backend ?? "",
    String(runtime?.exists ?? ""),
    String(runtime?.attached ?? ""),
    runtime?.currentPath ?? "",
    runtime?.currentCommand ?? "",
    String(runtime?.windows ?? ""),
    runtime?.zellijVersion ?? "",
    runtime?.tmuxVersion ?? ""
  ].join("\u001f");
}

function emptyPreview(sessionId: string): SessionPreview {
  return {
    sessionId,
    text: "",
    signature: "",
    capturedAt: new Date(0).toISOString()
  };
}

function quickSubmitDelayMs(value: string): number {
  return Math.max(140, Math.min(600, 140 + Math.ceil(value.length / 80)));
}

function samePreview(previous: SessionPreview | undefined, next: SessionPreview): boolean {
  return previewContentSignature(previous) === previewContentSignature(next);
}

function previewContentSignature(preview?: SessionPreview): string {
  if (!preview) {
    return "";
  }
  return preview.signature || [preview.text, gridContentSignature(preview.grid)].join("\u001f");
}

function gridContentSignature(grid?: TerminalPreviewGrid): string {
  if (!grid) {
    return "";
  }
  const rows = grid.rows.map((row) =>
    row.segments
      .map((segment) =>
        [
          segment.text,
          segment.cols,
          segment.fg ?? "",
          segment.bg ?? "",
          segment.bold ? "1" : "",
          segment.italic ? "1" : "",
          segment.underline ? "1" : "",
          segment.dim ? "1" : ""
        ].join("\u001e")
      )
      .join("\u001d")
  );
  return [grid.cols, grid.rows.length, ...rows].join("\u001c");
}

function mergeFastPreview(previous: SessionPreview | undefined, next: SessionPreview, rowsToKeep: number): SessionPreview {
  if (!previous?.grid || !next.grid) {
    return next;
  }

  const fastRows = next.grid.rows;
  const historyRowsToKeep = Math.max(0, rowsToKeep - fastRows.length);
  const historyRows = historyRowsToKeep > 0 ? previous.grid.rows.slice(-historyRowsToKeep) : [];
  return {
    ...next,
    text: previous.text,
    grid: {
      cols: next.grid.cols || previous.grid.cols,
      rows: [...historyRows, ...fastRows].slice(-rowsToKeep)
    }
  };
}

function buildSessionLayout(session: TerminalSession, index: number, settings: PanelSettings): Layout {
  const storedLayout = normalizeStoredLayout(session.layout);
  const width = Math.max(MIN_CARD_COLUMNS, Math.min(GRID_COLUMNS, storedLayout?.w ?? CARD_COLUMNS));
  return {
    i: session.id,
    x: storedLayout?.x ?? (index % 3) * CARD_COLUMNS,
    y: storedLayout?.y ?? Math.floor(index / 3) * settings.defaultCardRows,
    w: width,
    h: Math.max(storedLayout?.h ?? settings.defaultCardRows, MIN_LAYOUT_ROWS),
    minW: MIN_CARD_COLUMNS,
    minH: MIN_LAYOUT_ROWS
  };
}

function normalizeStoredLayout(layout: TerminalSession["layout"]): Layout | null {
  if (!layout) {
    return null;
  }

  const sourceColumns = Math.max(1, Number(layout.gridColumns) || LEGACY_GRID_COLUMNS);
  const columnScale = GRID_COLUMNS / sourceColumns;
  return clampLayoutItem({
    i: "",
    x: Math.round(layout.x * columnScale),
    y: layout.y,
    w: Math.round(layout.w * columnScale),
    h: layout.h,
    minW: layout.minW ? Math.round(layout.minW * columnScale) : MIN_CARD_COLUMNS,
    minH: layout.minH ?? MIN_LAYOUT_ROWS
  });
}

function buildTopSessionLayout(sessionId: string, settings: PanelSettings): Layout {
  return {
    i: sessionId,
    x: 0,
    y: 0,
    w: CARD_COLUMNS,
    h: Math.max(settings.defaultCardRows, settings.minCardRows),
    minW: MIN_CARD_COLUMNS,
    minH: MIN_LAYOUT_ROWS
  };
}

function buildOrganizedLayout(sessions: TerminalSession[], settings: PanelSettings): Layout[] {
  const cardsPerRow = Math.max(1, Math.floor(GRID_COLUMNS / CARD_COLUMNS));
  return sessions.map((session, index) => ({
    i: session.id,
    x: (index % cardsPerRow) * CARD_COLUMNS,
    y: Math.floor(index / cardsPerRow) * settings.defaultCardRows,
    w: CARD_COLUMNS,
    h: Math.max(settings.defaultCardRows, settings.minCardRows),
    minW: MIN_CARD_COLUMNS,
    minH: MIN_LAYOUT_ROWS
  }));
}

function compareSessionsForDisplay(a: TerminalSession, b: TerminalSession): number {
  const ay = a.layout?.y ?? Number.MAX_SAFE_INTEGER;
  const by = b.layout?.y ?? Number.MAX_SAFE_INTEGER;
  if (ay !== by) {
    return ay - by;
  }

  const ax = a.layout?.x ?? Number.MAX_SAFE_INTEGER;
  const bx = b.layout?.x ?? Number.MAX_SAFE_INTEGER;
  if (ax !== bx) {
    return ax - bx;
  }

  const createdDelta = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (createdDelta !== 0 && Number.isFinite(createdDelta)) {
    return createdDelta;
  }

  return a.id.localeCompare(b.id);
}

function normalizeVisibleLayout(layout: Layout[]): { layout: Layout[]; offsetY: number } {
  if (layout.length === 0) {
    return { layout, offsetY: 0 };
  }

  const offsetY = Math.min(...layout.map((item) => item.y));
  return {
    offsetY,
    layout: layout.map((item) => {
      const w = Math.max(item.minW ?? MIN_CARD_COLUMNS, Math.min(GRID_COLUMNS, item.w));
      return {
        ...item,
        w,
        h: Math.max(item.minH ?? MIN_LAYOUT_ROWS, item.h),
        x: Math.max(0, Math.min(GRID_COLUMNS - w, item.x)),
        y: Math.max(0, item.y - offsetY),
        minW: MIN_CARD_COLUMNS,
        minH: MIN_LAYOUT_ROWS
      };
    })
  };
}

function sameLayoutIdSet(previous: Layout[], next: Layout[]): boolean {
  if (previous.length !== next.length) {
    return false;
  }
  const nextIds = new Set(next.map((item) => item.i));
  return previous.every((item) => nextIds.has(item.i));
}

function sameLayout(previous: Layout[], next: Layout[]): boolean {
  if (previous.length !== next.length) {
    return false;
  }
  const nextById = new Map(next.map((item) => [item.i, item]));
  return previous.every((item) => {
    const nextItem = nextById.get(item.i);
    return (
      item.i === nextItem?.i &&
      item.x === nextItem.x &&
      item.y === nextItem.y &&
      item.w === nextItem.w &&
      item.h === nextItem.h &&
      item.minW === nextItem.minW &&
      item.minH === nextItem.minH
    );
  });
}

function clampLayoutItem(item: Layout): Layout {
  const minW = item.minW ?? MIN_CARD_COLUMNS;
  const minH = item.minH ?? MIN_LAYOUT_ROWS;
  const w = Math.max(minW, Math.min(GRID_COLUMNS, item.w));
  return {
    ...item,
    minW,
    minH,
    w,
    h: Math.max(minH, item.h),
    x: Math.max(0, Math.min(GRID_COLUMNS - w, item.x)),
    y: Math.max(0, item.y)
  };
}

function layoutToSessionLayout(item: Layout, offsetY = 0) {
  return {
    x: item.x,
    y: item.y + offsetY,
    w: item.w,
    h: item.h,
    minW: item.minW,
    minH: item.minH,
    gridColumns: GRID_COLUMNS
  };
}

export function App() {
  const initialFilters = useMemo(loadFilterState, []);
  const initialSettings = useMemo(loadPanelSettings, []);
  const [auth, setAuth] = useState<AuthUser | null | undefined>(undefined);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [previews, setPreviews] = useState<Record<string, SessionPreview>>({});
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [metricsHistory, setMetricsHistory] = useState<SystemMetrics[]>([]);
  const [query, setQuery] = useState(initialFilters.query);
  const [groupFilter, setGroupFilter] = useState(initialFilters.groupFilter);
  const [tagFilter, setTagFilter] = useState(initialFilters.tagFilter);
  const [showArchived, setShowArchived] = useState(initialFilters.showArchived);
  const [settings, setSettings] = useState<PanelSettings>(initialSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [editorSession, setEditorSession] = useState<TerminalSession | "new" | null>(null);
  const [activeTerminal, setActiveTerminal] = useState<TerminalSession | null>(null);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [previewRevealTimedOut, setPreviewRevealTimedOut] = useState(false);
  const [loading, setLoading] = useState(false);
  const [localLayout, setLocalLayout] = useState<Layout[]>([]);
  const layoutDirtyRef = useRef(false);
  const localLayoutRef = useRef<Layout[]>([]);
  const layoutOriginYRef = useRef(0);
  const layoutProtectUntilRef = useRef(0);
  const layoutSaveSeqRef = useRef(0);
  const previewsRef = useRef<Record<string, SessionPreview>>({});
  const previewInFlightRef = useRef<Set<string>>(new Set());
  const lastFullPreviewAtRef = useRef<Record<string, number>>({});
  const userStorageReadyRef = useRef<string | null>(null);
  const isMobile = useMediaQuery(MOBILE_QUERY);
  const remoteBrowserHost = useMemo(isRemoteBrowserHost, []);
  const sessionRefreshMs = remoteBrowserHost ? REMOTE_SESSION_REFRESH_MS : SESSION_REFRESH_MS;
  const systemMetricsRefreshMs = remoteBrowserHost ? REMOTE_SYSTEM_METRICS_REFRESH_MS : SYSTEM_METRICS_REFRESH_MS;
  const previewRefreshMs = remoteBrowserHost
    ? Math.max(settings.previewRefreshMs, REMOTE_PREVIEW_MIN_REFRESH_MS)
    : settings.previewRefreshMs;
  const fullPreviewRefreshMs = remoteBrowserHost ? REMOTE_FULL_PREVIEW_REFRESH_MS : FULL_PREVIEW_REFRESH_MS;
  const previewMaxChars = remoteBrowserHost ? REMOTE_PREVIEW_MAX_CHARS : LOCAL_PREVIEW_MAX_CHARS;

  const loadSessions = useCallback(async () => {
    try {
      const loaded = await api.sessions(showArchived);
      const next =
        layoutDirtyRef.current || Date.now() < layoutProtectUntilRef.current
          ? mergeLocalLayoutsIntoSessions(loaded, localLayoutRef.current, layoutOriginYRef.current)
          : loaded;
      setSessions((current) => (sameSessionList(current, next) ? current : next));
      setSessionsLoaded(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuth(null);
      }
    }
  }, [showArchived]);

  useEffect(() => {
    void api.me().then(setAuth).catch(() => setAuth(null));
    void api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);

  useEffect(() => {
    if (!auth) {
      userStorageReadyRef.current = null;
      setSessionsLoaded(false);
      return;
    }
    const userName = auth.name;
    userStorageReadyRef.current = null;
    const nextFilters = loadFilterState(userStorageKey(FILTER_STATE_KEY, userName));
    const nextSettings = loadPanelSettings(userStorageKey(SETTINGS_STATE_KEY, userName));
    setQuery(nextFilters.query);
    setGroupFilter(nextFilters.groupFilter);
    setTagFilter(nextFilters.tagFilter);
    setShowArchived(nextFilters.showArchived);
    setSettings(nextSettings);
    window.setTimeout(() => {
      userStorageReadyRef.current = userName;
    }, 0);
  }, [auth]);

  useEffect(() => {
    if (!auth || userStorageReadyRef.current !== auth.name) {
      return;
    }
    window.localStorage.setItem(
      userStorageKey(FILTER_STATE_KEY, auth.name),
      JSON.stringify({
        query,
        groupFilter,
        tagFilter,
        showArchived
      })
    );
  }, [auth, groupFilter, query, showArchived, tagFilter]);

  useEffect(() => {
    if (!auth || userStorageReadyRef.current !== auth.name) {
      return;
    }
    window.localStorage.setItem(userStorageKey(SETTINGS_STATE_KEY, auth.name), JSON.stringify(settings));
  }, [auth, settings]);

  useEffect(() => {
    document.title = effectiveBrowserTitle(settings.browserTitle);
  }, [settings.browserTitle]);

  useEffect(() => {
    const applyTheme = () => {
      const resolved = resolveThemeMode(settings.themeMode);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themeMode = settings.themeMode;
      document.documentElement.style.colorScheme = resolved;
    };

    applyTheme();
    if (settings.themeMode !== "system") {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [settings.themeMode]);

  useEffect(() => {
    if (!auth) {
      return;
    }
    void loadSessions();
    const timer = window.setInterval(() => {
      if (isTerminalInputFocused()) {
        return;
      }
      void loadSessions();
    }, sessionRefreshMs);
    return () => window.clearInterval(timer);
  }, [auth, loadSessions, sessionRefreshMs]);

  useEffect(() => {
    if (!auth) {
      return;
    }

    let cancelled = false;
    const loadMetrics = async () => {
      if (isTerminalInputFocused()) {
        return;
      }
      try {
        const metrics = await api.systemMetrics();
        if (!cancelled) {
          setMetricsHistory((current) => [...current.slice(-(SYSTEM_METRICS_HISTORY_LIMIT - 1)), metrics]);
        }
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          setAuth(null);
        }
      }
    };

    void loadMetrics();
    const timer = window.setInterval(loadMetrics, systemMetricsRefreshMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [auth, systemMetricsRefreshMs]);

  const groups = useMemo(
    () => ["all", ...Array.from(new Set(sessions.map((session) => session.group))).sort()],
    [sessions]
  );
  const tags = useMemo(
    () => ["all", ...Array.from(new Set(sessions.flatMap((session) => session.tags))).sort()],
    [sessions]
  );

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return sessions
      .filter((session) => {
        const matchesQuery =
          !normalizedQuery ||
          [session.name, session.group, session.cwd, session.runtime?.currentPath, ...session.tags]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(normalizedQuery);
        const matchesGroup = groupFilter === "all" || session.group === groupFilter;
        const matchesTag = tagFilter === "all" || session.tags.includes(tagFilter);
        return matchesQuery && matchesGroup && matchesTag;
      })
      .sort(compareSessionsForDisplay);
  }, [groupFilter, query, sessions, tagFilter]);

  const previewTargets = useMemo(
    () =>
      filtered.slice(0, settings.maxPreviewCards).map((session) => ({
        id: session.id,
        exists: Boolean(session.runtime?.exists)
      })),
    [filtered, settings.maxPreviewCards]
  );
  const previewTargetKey = useMemo(
    () => previewTargets.map((target) => `${target.id}:${target.exists ? "1" : "0"}`).join("|"),
    [previewTargets]
  );
  const previewRevealTargets = useMemo(
    () => previewTargets.slice(0, isMobile ? MOBILE_INITIAL_PREVIEW_CARDS : DESKTOP_INITIAL_PREVIEW_CARDS),
    [isMobile, previewTargets]
  );
  const previewRevealTargetKey = useMemo(
    () => previewRevealTargets.map((target) => `${target.id}:${target.exists ? "1" : "0"}`).join("|"),
    [previewRevealTargets]
  );
  const previewRevealReady = useMemo(
    () => previewRevealTargets.every((target) => !target.exists || Boolean(previews[target.id])),
    [previewRevealTargets, previews]
  );
  const terminalListLoading =
    !sessionsLoaded ||
    (filtered.length > 0 &&
      previewRevealTargets.length > 0 &&
      !previewRevealReady &&
      !previewRevealTimedOut);

  useEffect(() => {
    setPreviewRevealTimedOut(false);
    if (!auth || !sessionsLoaded || previewRevealTargets.length === 0 || previewRevealReady) {
      return;
    }

    const timer = window.setTimeout(() => {
      setPreviewRevealTimedOut(true);
    }, PREVIEW_REVEAL_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [auth, sessionsLoaded, previewRevealReady, previewRevealTargetKey, previewRevealTargets.length]);

  useEffect(() => {
    if (!auth || activeTerminal || previewTargets.length === 0) {
      return;
    }

    let cancelled = false;
    const timers: number[] = [];
    const visibleIds = new Set(previewTargets.map((target) => target.id));
    setPreviews((current) => {
      let next = current;
      for (const target of previewTargets) {
        if (target.exists) {
          continue;
        }
        if (current[target.id]?.text === "") {
          continue;
        }
        next = next === current ? { ...current } : next;
        next[target.id] = emptyPreview(target.id);
      }
      return next;
    });

    const pollPreview = async (sessionId: string) => {
      if (previewInFlightRef.current.has(sessionId) || isTerminalInputFocused()) {
        return;
      }

      previewInFlightRef.current.add(sessionId);
      try {
        const now = Date.now();
        const previous = previewsRef.current[sessionId];
        const lastFullAt = lastFullPreviewAtRef.current[sessionId] ?? 0;
        const shouldLoadFull = Boolean(previous?.grid) && now - lastFullAt >= fullPreviewRefreshMs;
        const preview = await api.preview(sessionId, settings.previewLines, previewMaxChars, shouldLoadFull);
        if (cancelled || !visibleIds.has(sessionId)) {
          return;
        }

        if (shouldLoadFull) {
          lastFullPreviewAtRef.current[sessionId] = Date.now();
        }

        setPreviews((current) => {
          const nextPreview = shouldLoadFull
            ? preview
            : mergeFastPreview(current[sessionId], preview, settings.previewLines);
          return samePreview(current[sessionId], nextPreview) ? current : { ...current, [sessionId]: nextPreview };
        });
      } catch {
        if (!cancelled) {
          setPreviews((current) =>
            current[sessionId]?.text === "" ? current : { ...current, [sessionId]: emptyPreview(sessionId) }
          );
        }
      } finally {
        previewInFlightRef.current.delete(sessionId);
      }
    };

    for (const target of previewTargets) {
      if (!target.exists) {
        previewInFlightRef.current.delete(target.id);
        delete lastFullPreviewAtRef.current[target.id];
        continue;
      }
      void pollPreview(target.id);
      timers.push(window.setInterval(() => void pollPreview(target.id), previewRefreshMs));
    }

    return () => {
      cancelled = true;
      timers.forEach((timer) => window.clearInterval(timer));
    };
  }, [activeTerminal, auth, fullPreviewRefreshMs, previewMaxChars, previewRefreshMs, previewTargetKey, settings.previewLines]);

  const desktopLayoutState = useMemo(
    () => normalizeVisibleLayout(filtered.map((session, index) => buildSessionLayout(session, index, settings))),
    [filtered, settings.defaultCardRows, settings.minCardRows]
  );
  const desktopLayout = desktopLayoutState.layout;

  useEffect(() => {
    layoutOriginYRef.current = desktopLayoutState.offsetY;
  }, [desktopLayoutState.offsetY]);

  useEffect(() => {
    localLayoutRef.current = localLayout;
  }, [localLayout]);

  useEffect(() => {
    setLocalLayout((current) => {
      if (layoutDirtyRef.current && sameLayoutIdSet(current, desktopLayout)) {
        return current;
      }

      layoutDirtyRef.current = false;
      layoutProtectUntilRef.current = 0;
      return sameLayout(current, desktopLayout) ? current : desktopLayout;
    });
  }, [desktopLayout]);

  const gridLayout = sameLayoutIdSet(localLayout, desktopLayout) ? localLayout : desktopLayout;
  const layouts = useMemo(() => ({ lg: gridLayout }), [gridLayout]);

  const saveLayout = useCallback(
    async (layout: Layout[]) => {
      const saveSeq = ++layoutSaveSeqRef.current;
      const byId = new Map(layout.map((item) => [item.i, item]));
      const offsetY = layoutOriginYRef.current;
      layoutProtectUntilRef.current = Date.now() + 5000;
      try {
        await Promise.all(
          filtered.map((session) => {
            const item = byId.get(session.id);
            if (!item) {
              return Promise.resolve();
            }
            return api.updateSession(session.id, {
              layout: layoutToSessionLayout(item, offsetY)
            });
          })
        );
        if (saveSeq !== layoutSaveSeqRef.current) {
          return;
        }
        setSessions((current) =>
          current.map((session) => {
            const item = byId.get(session.id);
            return item ? { ...session, layout: layoutToSessionLayout(item, offsetY) } : session;
          })
        );
        layoutDirtyRef.current = false;
        layoutProtectUntilRef.current = Date.now() + 2500;
      } catch (error) {
        console.error("Failed to save terminal layout", error);
      }
    },
    [filtered]
  );

  const handleLayoutStart = useCallback(
    () => {
      if (isMobile) {
        return;
      }
      layoutDirtyRef.current = true;
      layoutProtectUntilRef.current = Date.now() + 5000;
    },
    [isMobile]
  );

  const handleLayoutMove = useCallback(
    (layout: Layout[]) => {
      if (isMobile) {
        return;
      }
      layoutDirtyRef.current = true;
      layoutProtectUntilRef.current = Date.now() + 5000;
      localLayoutRef.current = layout;
      setLocalLayout(layout);
    },
    [isMobile]
  );

  const handleLayoutStop = useCallback(
    (layout: Layout[]) => {
      if (isMobile) {
        return;
      }
      const next = layout.map(clampLayoutItem);
      layoutDirtyRef.current = true;
      layoutProtectUntilRef.current = Date.now() + 5000;
      localLayoutRef.current = next;
      setLocalLayout(next);
      void saveLayout(next);
    },
    [isMobile, saveLayout]
  );

  const organizeLayout = useCallback(() => {
    if (isMobile) {
      return;
    }

    const organized = buildOrganizedLayout(filtered, settings);
    layoutDirtyRef.current = true;
    layoutProtectUntilRef.current = Date.now() + 5000;
    localLayoutRef.current = organized;
    setLocalLayout(organized);
    void saveLayout(organized);
  }, [filtered, isMobile, saveLayout, settings]);

  const renderSessionCard = (session: TerminalSession) => (
    <SessionCard
      session={session}
      preview={previews[session.id]}
      previewFontSize={settings.listTerminalFontSize}
      previewScale={settings.listTerminalScale / 100}
      onOpen={() => setActiveTerminal(session)}
      onEdit={() => setEditorSession(session)}
      onDuplicate={async () => {
        await api.duplicateSession(session.id);
        await loadSessions();
      }}
      onQuickInput={async (value) => {
        const input = {
          data: value,
          enter: true,
          submitKey: "enter" as const,
          mode: "paste" as const,
          submitDelayMs: quickSubmitDelayMs(value)
        };
        const result = await api.sendInput(session.id, input);
        if (result.preview !== undefined) {
          setPreviews((current) => ({
            ...current,
            [session.id]: {
              ...emptyPreview(session.id),
              text: result.preview || current[session.id]?.text || "",
              grid: result.grid,
              signature: result.signature
            }
          }));
        }
        await loadSessions();
        window.setTimeout(() => {
          void api
            .preview(session.id, settings.previewLines, previewMaxChars)
            .then((preview) => setPreviews((current) => ({ ...current, [session.id]: preview })))
            .catch(() => undefined);
        }, 900);
      }}
      onPasteFiles={async (files) => {
        const result = await api.uploadSessionFiles(session.id, files);
        return result.terminalText;
      }}
      onArchive={async () => {
        await api.archiveSession(session.id);
        await loadSessions();
      }}
      onRestore={async () => {
        await api.restoreSession(session.id);
        await loadSessions();
      }}
      onKill={async () => {
        if (window.confirm(`Stop ${session.name} terminal session?`)) {
          await api.killSession(session.id);
          await loadSessions();
        }
      }}
    />
  );

  const refresh = async () => {
    setLoading(true);
    try {
      await Promise.all([loadSessions(), api.health().then(setHealth)]);
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    await api.logout();
    setAuth(null);
  };

  if (auth === undefined) {
    return <div className="boot-screen">Loading terminal monitor...</div>;
  }

  if (!auth) {
    return <Login onAuthenticated={setAuth} />;
  }

  const shellStyle = {
    "--session-card-min-height": `${settings.previewMinHeight + 120}px`,
    "--session-preview-min-height": `${settings.previewMinHeight}px`
  } as CSSProperties;

  return (
    <main className="app-shell" style={shellStyle}>
      <header className="topbar">
        <div className="brand">
          <MonitorUp size={24} />
          <div>
            <h1>Terminal Web Monitor</h1>
            <span>{sessions.length} sessions · {auth.name}</span>
          </div>
        </div>
        <div className="topbar-actions">
          <HealthPill health={health} />
          <button
            className="icon-button"
            type="button"
            onClick={() => setSettings((current) => ({ ...current, themeMode: nextThemeMode(current.themeMode) }))}
            title={`Theme: ${settings.themeMode}`}
          >
            <ThemeModeIcon mode={settings.themeMode} />
          </button>
          <button className="icon-button desktop-only-action" type="button" onClick={() => setSettingsOpen(true)} title="配置">
            <Settings size={18} />
          </button>
          <button className="icon-button" type="button" onClick={() => setTransferOpen(true)} title="文件传输">
            <FolderOpen size={18} />
          </button>
          <button className="icon-button" type="button" onClick={refresh} title="刷新">
            <RefreshCw size={18} className={loading ? "spin" : ""} />
          </button>
          <button className="icon-button" type="button" onClick={logout} title="退出登录">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <section className="toolbar">
        <label className="searchbox">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索名称、路径、标签"
          />
        </label>
        <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
          {groups.map((group) => (
            <option key={group} value={group}>
              {group === "all" ? "全部分组" : group}
            </option>
          ))}
        </select>
        <select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
          {tags.map((tag) => (
            <option key={tag} value={tag}>
              {tag === "all" ? "全部标签" : tag}
            </option>
          ))}
        </select>
        <button
          className={showArchived ? "toggle active" : "toggle"}
          type="button"
          onClick={() => setShowArchived((value) => !value)}
        >
          <Archive size={16} />
          归档
        </button>
        <button
          className="secondary-button desktop-only-action"
          type="button"
          onClick={organizeLayout}
          disabled={filtered.length === 0}
          title="一键整理当前列表"
        >
          <LayoutGrid size={16} />
          整理
        </button>
        <label className="density desktop-only-action">
          <SlidersHorizontal size={16} />
          <input
            type="range"
            min="24"
            max="180"
            step="4"
            value={settings.rowHeight}
            onChange={(event) =>
              setSettings((current) => ({ ...current, rowHeight: Number(event.target.value) }))
            }
          />
        </label>
        <label className="density desktop-only-action" title="List terminal font size">
          <Type size={16} />
          <input
            type="range"
            min="12"
            max="24"
            step="1"
            value={settings.listTerminalFontSize}
            onChange={(event) =>
              setSettings((current) => ({ ...current, listTerminalFontSize: Number(event.target.value) }))
            }
          />
        </label>
        <button className="primary-button" type="button" onClick={() => setEditorSession("new")}>
          <Plus size={17} />
          新建
        </button>
      </section>

      {terminalListLoading ? (
        <TerminalListLoader />
      ) : filtered.length === 0 ? (
        <section className="empty-state">
          <Boxes size={42} />
          <h2>没有匹配的 terminal</h2>
          <button className="primary-button" type="button" onClick={() => setEditorSession("new")}>
            <Plus size={17} />
            新建 terminal
          </button>
        </section>
      ) : isMobile ? (
        <section className="mobile-session-list" aria-label="terminal sessions">
          {filtered.map((session) => (
            <div className="mobile-session-item" key={session.id}>
              {renderSessionCard(session)}
            </div>
          ))}
        </section>
      ) : (
        <ResponsiveGrid
          className="session-grid"
          layouts={layouts}
          breakpoints={{ lg: 0 }}
          cols={{ lg: GRID_COLUMNS }}
          rowHeight={settings.rowHeight}
          margin={GRID_MARGIN}
          compactType={null}
          allowOverlap
          preventCollision={false}
          resizeHandles={GRID_RESIZE_HANDLES}
          draggableHandle=".session-card-header"
          draggableCancel=".preview,.quick-input,.card-actions,.preview-tools,input,select,a"
          onDragStart={handleLayoutStart}
          onDrag={handleLayoutMove}
          onResizeStart={handleLayoutStart}
          onResize={handleLayoutMove}
          onDragStop={handleLayoutStop}
          onResizeStop={handleLayoutStop}
        >
          {filtered.map((session) => (
            <div key={session.id} data-session-id={session.id}>
              {renderSessionCard(session)}
            </div>
          ))}
        </ResponsiveGrid>
      )}

      <SystemMonitor history={metricsHistory} />

      {editorSession && (
        <SessionEditor
          session={editorSession === "new" ? null : editorSession}
          initialGroup={groupFilter === "all" ? undefined : groupFilter}
          initialTags={tagFilter === "all" ? [] : [tagFilter]}
          onClose={() => setEditorSession(null)}
          onSave={async (input) => {
            let terminalToOpen: TerminalSession | null = null;
            if (editorSession === "new") {
              const created = await api.createSession(input);
              const topLayout = buildTopSessionLayout(created.id, settings);
              terminalToOpen = await api.updateSession(created.id, {
                layout: layoutToSessionLayout(topLayout)
              });
            } else {
              await api.updateSession(editorSession.id, input);
            }
            setEditorSession(null);
            await loadSessions();
            if (terminalToOpen) {
              setActiveTerminal(terminalToOpen);
            }
          }}
        />
      )}

      {activeTerminal && (
        <TerminalDock
          session={activeTerminal}
          onClose={() => {
            setActiveTerminal(null);
            void loadSessions();
          }}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
          onReset={() => setSettings(DEFAULT_SETTINGS)}
        />
      )}

      {transferOpen && <FileTransferPanel onClose={() => setTransferOpen(false)} />}
    </main>
  );
}

function TerminalListLoader() {
  return (
    <section className="terminal-list-loader" aria-busy="true" aria-live="polite">
      <div className="terminal-loader-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="terminal-loader-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}

function SettingsModal({
  settings,
  onChange,
  onClose,
  onReset
}: {
  settings: PanelSettings;
  onChange: (settings: PanelSettings) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  const update = <K extends keyof PanelSettings>(key: K, value: PanelSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <div className="modal-backdrop">
      <section className="modal-panel settings-panel">
        <header className="modal-header">
          <h2>全局配置</h2>
          <button className="icon-button small" type="button" onClick={onClose} title="关闭">
            ×
          </button>
        </header>
        <div className="settings-form">
          <label className="settings-form-wide">
            <span>浏览器标签名称</span>
            <input
              type="text"
              maxLength={80}
              placeholder={DEFAULT_BROWSER_TITLE}
              value={settings.browserTitle}
              onChange={(event) => update("browserTitle", event.target.value.slice(0, 80))}
            />
          </label>
          <label>
            <span>Theme mode</span>
            <select value={settings.themeMode} onChange={(event) => update("themeMode", parseThemeMode(event.target.value))}>
              <option value="system">Follow system</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label>
            <span>网格行高</span>
            <input
              type="number"
              min="24"
              max="180"
              step="4"
              value={settings.rowHeight}
              onChange={(event) => update("rowHeight", clampNumber(event.target.value, DEFAULT_SETTINGS.rowHeight, 24, 180))}
            />
          </label>
          <label>
            <span>默认卡片行数</span>
            <input
              type="number"
              min="3"
              max="32"
              value={settings.defaultCardRows}
              onChange={(event) =>
                update("defaultCardRows", clampNumber(event.target.value, DEFAULT_SETTINGS.defaultCardRows, 3, 32))
              }
            />
          </label>
          <label>
            <span>最小卡片行数</span>
            <input
              type="number"
              min="3"
              max="32"
              value={settings.minCardRows}
              onChange={(event) =>
                update("minCardRows", clampNumber(event.target.value, DEFAULT_SETTINGS.minCardRows, 3, 32))
              }
            />
          </label>
          <label>
            <span>输出区最小高度 px</span>
            <input
              type="number"
              min="160"
              max="1400"
              step="20"
              value={settings.previewMinHeight}
              onChange={(event) =>
                update("previewMinHeight", clampNumber(event.target.value, DEFAULT_SETTINGS.previewMinHeight, 160, 1400))
              }
            />
          </label>
          <label>
            <span>预览保留行数</span>
            <input
              type="number"
              min="20"
              max={MAX_LIST_PREVIEW_LINES}
              step="100"
              value={settings.previewLines}
              onChange={(event) =>
                update("previewLines", clampNumber(event.target.value, DEFAULT_SETTINGS.previewLines, 20, MAX_LIST_PREVIEW_LINES))
              }
            />
          </label>
          <label>
            <span>预览刷新间隔 ms</span>
            <input
              type="number"
              min="1000"
              max="30000"
              step="500"
              value={settings.previewRefreshMs}
              onChange={(event) =>
                update("previewRefreshMs", clampNumber(event.target.value, DEFAULT_SETTINGS.previewRefreshMs, 1000, 30000))
              }
            />
          </label>
          <label>
            <span>最多刷新卡片数</span>
            <input
              type="number"
              min="1"
              max="100"
              value={settings.maxPreviewCards}
              onChange={(event) =>
                update("maxPreviewCards", clampNumber(event.target.value, DEFAULT_SETTINGS.maxPreviewCards, 1, 100))
              }
            />
          </label>
          <label>
            <span>List terminal font px</span>
            <input
              type="number"
              min="12"
              max="24"
              value={settings.listTerminalFontSize}
              onChange={(event) =>
                update("listTerminalFontSize", clampNumber(event.target.value, DEFAULT_SETTINGS.listTerminalFontSize, 12, 24))
              }
            />
          </label>
          <label>
            <span>List terminal scale %</span>
            <input
              type="number"
              min="80"
              max="140"
              step="5"
              value={settings.listTerminalScale}
              onChange={(event) =>
                update("listTerminalScale", clampNumber(event.target.value, DEFAULT_SETTINGS.listTerminalScale, 80, 140))
              }
            />
          </label>
          <label>
            <span>List terminal submit key</span>
            <select
              value={settings.inlineSubmitKey}
              onChange={() => update("inlineSubmitKey", "enter")}
            >
              <option value="enter">Enter</option>
            </select>
          </label>
        </div>
        <footer className="modal-actions">
          <button className="secondary-button" type="button" onClick={onReset}>
            重置
          </button>
          <button className="primary-button" type="button" onClick={onClose}>
            完成
          </button>
        </footer>
      </section>
    </div>
  );
}

function SystemMonitor({ history }: { history: SystemMetrics[] }) {
  const latest = history[history.length - 1] ?? null;
  const cpuSamples = history.map((item) => item.cpu.usagePercent);
  const memorySamples = history.map((item) => item.memory.usagePercent);
  const processSamples = history.map((item) =>
    item.memory.processHeapTotalBytes > 0
      ? (item.memory.processHeapUsedBytes / item.memory.processHeapTotalBytes) * 100
      : 0
  );

  return (
    <section className="system-monitor">
      <header className="system-monitor-header">
        <div>
          <h2>System Monitor</h2>
          <span>{latest ? `Updated ${new Date(latest.capturedAt).toLocaleTimeString()}` : "Waiting for metrics"}</span>
        </div>
        <div className="system-monitor-meta">
          <Activity size={16} />
          <span>{latest ? formatUptime(latest.uptimeSec) : "uptime --"}</span>
        </div>
      </header>
      <div className="metric-grid">
        <MetricTile
          icon={<Cpu size={18} />}
          label="CPU"
          value={latest ? `${formatPercent(latest.cpu.usagePercent)}%` : "--"}
          detail={latest ? `${latest.cpu.cores} cores · ${latest.cpu.model}` : "No sample yet"}
          color="#2f80ed"
          samples={cpuSamples}
        />
        <MetricTile
          icon={<MemoryStick size={18} />}
          label="Memory"
          value={latest ? `${formatPercent(latest.memory.usagePercent)}%` : "--"}
          detail={
            latest
              ? `${formatBytes(latest.memory.usedBytes)} / ${formatBytes(latest.memory.totalBytes)}`
              : "No sample yet"
          }
          color="#00a676"
          samples={memorySamples}
        />
        <MetricTile
          icon={<Activity size={18} />}
          label="Node Heap"
          value={latest ? `${formatBytes(latest.memory.processHeapUsedBytes)}` : "--"}
          detail={latest ? `RSS ${formatBytes(latest.memory.processRssBytes)}` : "No sample yet"}
          color="#b7791f"
          samples={processSamples}
        />
      </div>
    </section>
  );
}

function MetricTile({
  icon,
  label,
  value,
  detail,
  samples,
  color
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
  samples: number[];
  color: string;
}) {
  return (
    <article className="metric-tile">
      <div className="metric-heading">
        <span className="metric-icon">{icon}</span>
        <span>{label}</span>
      </div>
      <strong>{value}</strong>
      <span className="metric-detail" title={detail}>
        {detail}
      </span>
      <WaveChart samples={samples} color={color} />
    </article>
  );
}

function WaveChart({ samples, color }: { samples: number[]; color: string }) {
  const values = samples.length ? samples : [0];
  const points = values
    .map((value, index) => {
      const x = values.length === 1 ? 100 : (index / (values.length - 1)) * 100;
      const y = 38 - (Math.max(0, Math.min(100, value)) / 100) * 34;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  const area = `0,40 ${points} 100,40`;

  return (
    <svg className="wave-chart" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <polyline className="wave-fill" points={area} style={{ fill: `${color}22` }} />
      <polyline className="wave-line" points={points} style={{ stroke: color }} />
    </svg>
  );
}

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let next = Math.max(0, value);
  let unitIndex = 0;
  while (next >= 1024 && unitIndex < units.length - 1) {
    next /= 1024;
    unitIndex += 1;
  }
  const digits = next >= 10 || unitIndex === 0 ? 0 : 1;
  return `${next.toFixed(digits)} ${units[unitIndex]}`;
}

function formatPercent(value: number): string {
  return Number.isFinite(value) ? value.toFixed(value >= 10 ? 0 : 1) : "0";
}

function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) {
    return `${days}d ${hours}h uptime`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m uptime`;
  }
  return `${minutes}m uptime`;
}

function HealthPill({ health }: { health: HealthStatus | null }) {
  const ok = Boolean(health?.ok);
  return (
    <div className={ok ? "health-pill ok" : "health-pill warn"} title={health?.dataDir ?? ""}>
      <ShieldCheck size={16} />
      {ok ? health?.backend.default ?? "ready" : "setup"}
    </div>
  );
}

function ThemeModeIcon({ mode }: { mode: ThemeMode }) {
  if (mode === "dark") {
    return <Moon size={18} />;
  }
  if (mode === "light") {
    return <Sun size={18} />;
  }
  return <Laptop size={18} />;
}
