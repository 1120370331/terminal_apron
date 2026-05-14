import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { WidthProvider, Responsive, type Layout } from "react-grid-layout";
import {
  Archive,
  Boxes,
  LogOut,
  MonitorUp,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal
} from "lucide-react";
import type { AuthUser, HealthStatus, TerminalSession } from "../shared/types";
import { api, ApiError } from "./api";
import { Login } from "./components/Login";
import { SessionCard } from "./components/SessionCard";
import { SessionEditor } from "./components/SessionEditor";
import { TerminalDock } from "./components/TerminalDock";

const ResponsiveGrid = WidthProvider(Responsive);
const FILTER_STATE_KEY = "terminal-web-monitor.filters.v1";
const SETTINGS_STATE_KEY = "terminal-web-monitor.settings.v1";
const DEFAULT_ROW_HEIGHT = 100;
const DEFAULT_CARD_ROWS = 7;
const MIN_CARD_ROWS = 7;

interface PanelSettings {
  rowHeight: number;
  defaultCardRows: number;
  minCardRows: number;
  previewMinHeight: number;
  previewLines: number;
  previewRefreshMs: number;
  maxPreviewCards: number;
  inlineSubmitKey: "enhanced-enter" | "enter";
}

interface FilterState {
  query: string;
  groupFilter: string;
  tagFilter: string;
  showArchived: boolean;
}

const DEFAULT_SETTINGS: PanelSettings = {
  rowHeight: DEFAULT_ROW_HEIGHT,
  defaultCardRows: DEFAULT_CARD_ROWS,
  minCardRows: MIN_CARD_ROWS,
  previewMinHeight: 500,
  previewLines: 2000,
  previewRefreshMs: 4500,
  maxPreviewCards: 24,
  inlineSubmitKey: "enter"
};

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function loadPanelSettings(): PanelSettings {
  if (typeof window === "undefined") {
    return DEFAULT_SETTINGS;
  }

  try {
    const stored = window.localStorage.getItem(SETTINGS_STATE_KEY);
    if (!stored) {
      return DEFAULT_SETTINGS;
    }
    const parsed = JSON.parse(stored) as Partial<PanelSettings>;
    return {
      rowHeight: clampNumber(parsed.rowHeight, DEFAULT_SETTINGS.rowHeight, 80, 220),
      defaultCardRows: clampNumber(parsed.defaultCardRows, DEFAULT_SETTINGS.defaultCardRows, 3, 14),
      minCardRows: clampNumber(parsed.minCardRows, DEFAULT_SETTINGS.minCardRows, 3, 14),
      previewMinHeight: clampNumber(parsed.previewMinHeight, DEFAULT_SETTINGS.previewMinHeight, 160, 1400),
      previewLines: clampNumber(parsed.previewLines, DEFAULT_SETTINGS.previewLines, 20, 5000),
      previewRefreshMs: clampNumber(parsed.previewRefreshMs, DEFAULT_SETTINGS.previewRefreshMs, 1000, 30000),
      maxPreviewCards: clampNumber(parsed.maxPreviewCards, DEFAULT_SETTINGS.maxPreviewCards, 1, 100),
      inlineSubmitKey: parsed.inlineSubmitKey === "enhanced-enter" ? "enhanced-enter" : "enter"
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function loadFilterState(): FilterState {
  if (typeof window === "undefined") {
    return {
      query: "",
      groupFilter: "all",
      tagFilter: "all",
      showArchived: false
    };
  }

  try {
    const stored = window.localStorage.getItem(FILTER_STATE_KEY);
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

export function App() {
  const initialFilters = useMemo(loadFilterState, []);
  const initialSettings = useMemo(loadPanelSettings, []);
  const [auth, setAuth] = useState<AuthUser | null | undefined>(undefined);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [query, setQuery] = useState(initialFilters.query);
  const [groupFilter, setGroupFilter] = useState(initialFilters.groupFilter);
  const [tagFilter, setTagFilter] = useState(initialFilters.tagFilter);
  const [showArchived, setShowArchived] = useState(initialFilters.showArchived);
  const [settings, setSettings] = useState<PanelSettings>(initialSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editorSession, setEditorSession] = useState<TerminalSession | "new" | null>(null);
  const [activeTerminal, setActiveTerminal] = useState<TerminalSession | null>(null);
  const [loading, setLoading] = useState(false);

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await api.sessions(showArchived));
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
    window.localStorage.setItem(
      FILTER_STATE_KEY,
      JSON.stringify({
        query,
        groupFilter,
        tagFilter,
        showArchived
      })
    );
  }, [groupFilter, query, showArchived, tagFilter]);

  useEffect(() => {
    window.localStorage.setItem(SETTINGS_STATE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (!auth) {
      return;
    }
    void loadSessions();
    const timer = window.setInterval(() => {
      void loadSessions();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [auth, loadSessions]);

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
    return sessions.filter((session) => {
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
    });
  }, [groupFilter, query, sessions, tagFilter]);

  useEffect(() => {
    if (!auth || filtered.length === 0) {
      return;
    }

    let cancelled = false;
    const loadPreviews = async () => {
      const entries = await Promise.all(
        filtered.slice(0, settings.maxPreviewCards).map(async (session) => {
          try {
            const preview = await api.preview(session.id, settings.previewLines);
            return [session.id, preview.text] as const;
          } catch {
            return [session.id, ""] as const;
          }
        })
      );
      if (!cancelled) {
        setPreviews((current) => ({ ...current, ...Object.fromEntries(entries) }));
      }
    };

    void loadPreviews();
    const timer = window.setInterval(loadPreviews, settings.previewRefreshMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [auth, filtered, settings.maxPreviewCards, settings.previewLines, settings.previewRefreshMs]);

  const layouts = useMemo(
    () => ({
      lg: filtered.map((session, index) => ({
        i: session.id,
        x: session.layout?.x ?? (index % 3) * 4,
        y: session.layout?.y ?? Math.floor(index / 3) * 4,
        w: session.layout?.w ?? 4,
        h: Math.max(session.layout?.h ?? settings.defaultCardRows, settings.minCardRows),
        minW: session.layout?.minW ?? 3,
        minH: Math.max(session.layout?.minH ?? settings.minCardRows, settings.minCardRows)
      }))
    }),
    [filtered, settings.defaultCardRows, settings.minCardRows]
  );

  const saveLayout = useCallback(
    (layout: Layout[]) => {
      const byId = new Map(layout.map((item) => [item.i, item]));
      void Promise.all(
        filtered.map((session) => {
          const item = byId.get(session.id);
          if (!item) {
            return Promise.resolve();
          }
          return api.updateSession(session.id, {
            layout: {
              x: item.x,
              y: item.y,
              w: item.w,
              h: item.h,
              minW: item.minW,
              minH: item.minH
            }
          });
        })
      ).then(loadSessions);
    },
    [filtered, loadSessions]
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
            <span>{sessions.length} sessions</span>
          </div>
        </div>
        <div className="topbar-actions">
          <HealthPill health={health} />
          <button className="icon-button" type="button" onClick={() => setSettingsOpen(true)} title="配置">
            <Settings size={18} />
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
        <label className="density">
          <SlidersHorizontal size={16} />
          <input
            type="range"
            min="100"
            max="180"
            step="4"
            value={settings.rowHeight}
            onChange={(event) =>
              setSettings((current) => ({ ...current, rowHeight: Number(event.target.value) }))
            }
          />
        </label>
        <button className="primary-button" type="button" onClick={() => setEditorSession("new")}>
          <Plus size={17} />
          新建
        </button>
      </section>

      {filtered.length === 0 ? (
        <section className="empty-state">
          <Boxes size={42} />
          <h2>没有匹配的 terminal</h2>
          <button className="primary-button" type="button" onClick={() => setEditorSession("new")}>
            <Plus size={17} />
            新建 terminal
          </button>
        </section>
      ) : (
        <ResponsiveGrid
          className="session-grid"
          layouts={layouts}
          breakpoints={{ lg: 1200, md: 960, sm: 720, xs: 480, xxs: 0 }}
          cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
          rowHeight={settings.rowHeight}
          margin={[14, 14]}
          draggableHandle=".drag-handle"
          onDragStop={saveLayout}
          onResizeStop={saveLayout}
        >
          {filtered.map((session) => (
            <div key={session.id}>
              <SessionCard
                session={session}
                preview={previews[session.id] ?? ""}
                onOpen={() => setActiveTerminal(session)}
                onEdit={() => setEditorSession(session)}
                onDuplicate={async () => {
                  await api.duplicateSession(session.id);
                  await loadSessions();
                }}
                onQuickInput={async (value) => {
                  const input = { data: value, enter: true, submitKey: "enter" as const };
                  const result = await api.sendInput(session.id, input);
                  if (result.preview !== undefined) {
                    setPreviews((current) => ({ ...current, [session.id]: result.preview || current[session.id] || "" }));
                  }
                  await loadSessions();
                  window.setTimeout(() => {
                    void api
                      .preview(session.id, settings.previewLines)
                      .then((preview) =>
                        setPreviews((current) => ({ ...current, [session.id]: preview.text }))
                      )
                      .catch(() => undefined);
                  }, 900);
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
                  if (window.confirm(`停止 ${session.name} 的 terminal 会话？`)) {
                    await api.killSession(session.id);
                    await loadSessions();
                  }
                }}
              />
            </div>
          ))}
        </ResponsiveGrid>
      )}

      {editorSession && (
        <SessionEditor
          session={editorSession === "new" ? null : editorSession}
          onClose={() => setEditorSession(null)}
          onSave={async (input) => {
            if (editorSession === "new") {
              await api.createSession(input);
            } else {
              await api.updateSession(editorSession.id, input);
            }
            setEditorSession(null);
            await loadSessions();
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
    </main>
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
          <label>
            <span>网格行高</span>
            <input
              type="number"
              min="80"
              max="220"
              step="4"
              value={settings.rowHeight}
              onChange={(event) => update("rowHeight", clampNumber(event.target.value, DEFAULT_SETTINGS.rowHeight, 80, 220))}
            />
          </label>
          <label>
            <span>默认卡片行数</span>
            <input
              type="number"
              min="3"
              max="14"
              value={settings.defaultCardRows}
              onChange={(event) =>
                update("defaultCardRows", clampNumber(event.target.value, DEFAULT_SETTINGS.defaultCardRows, 3, 14))
              }
            />
          </label>
          <label>
            <span>最小卡片行数</span>
            <input
              type="number"
              min="3"
              max="14"
              value={settings.minCardRows}
              onChange={(event) =>
                update("minCardRows", clampNumber(event.target.value, DEFAULT_SETTINGS.minCardRows, 3, 14))
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
              max="5000"
              step="100"
              value={settings.previewLines}
              onChange={(event) =>
                update("previewLines", clampNumber(event.target.value, DEFAULT_SETTINGS.previewLines, 20, 5000))
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
            <span>列表发送按键</span>
            <select
              value={settings.inlineSubmitKey}
              onChange={(event) => update("inlineSubmitKey", event.target.value === "enter" ? "enter" : "enhanced-enter")}
            >
              <option value="enhanced-enter">Enhanced Enter</option>
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

function HealthPill({ health }: { health: HealthStatus | null }) {
  const ok = Boolean(health?.ok);
  return (
    <div className={ok ? "health-pill ok" : "health-pill warn"} title={health?.dataDir ?? ""}>
      <ShieldCheck size={16} />
      {ok ? health?.backend.default ?? "ready" : "setup"}
    </div>
  );
}
