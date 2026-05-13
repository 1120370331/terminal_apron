import { useCallback, useEffect, useMemo, useState } from "react";
import { WidthProvider, Responsive, type Layout } from "react-grid-layout";
import {
  Archive,
  Boxes,
  LogOut,
  MonitorUp,
  Plus,
  RefreshCw,
  Search,
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

export function App() {
  const [auth, setAuth] = useState<AuthUser | null | undefined>(undefined);
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState("all");
  const [tagFilter, setTagFilter] = useState("all");
  const [showArchived, setShowArchived] = useState(false);
  const [rowHeight, setRowHeight] = useState(72);
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
        filtered.slice(0, 24).map(async (session) => {
          try {
            const preview = await api.preview(session.id);
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
    const timer = window.setInterval(loadPreviews, 4500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [auth, filtered]);

  const layouts = useMemo(
    () => ({
      lg: filtered.map((session, index) => ({
        i: session.id,
        x: session.layout?.x ?? (index % 3) * 4,
        y: session.layout?.y ?? Math.floor(index / 3) * 4,
        w: session.layout?.w ?? 4,
        h: session.layout?.h ?? 4,
        minW: session.layout?.minW ?? 3,
        minH: session.layout?.minH ?? 3
      }))
    }),
    [filtered]
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

  return (
    <main className="app-shell">
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
            min="56"
            max="96"
            step="4"
            value={rowHeight}
            onChange={(event) => setRowHeight(Number(event.target.value))}
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
          rowHeight={rowHeight}
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
                  const result = await api.sendInput(session.id, { data: value, enter: true });
                  if (result.preview !== undefined) {
                    setPreviews((current) => ({ ...current, [session.id]: result.preview || current[session.id] || "" }));
                  }
                  await loadSessions();
                  window.setTimeout(() => {
                    void api
                      .preview(session.id)
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
    </main>
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
