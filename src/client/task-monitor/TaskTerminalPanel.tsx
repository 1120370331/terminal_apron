import {
  Bot,
  Link2,
  LoaderCircle,
  Plus,
  TerminalSquare,
  Unlink,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent
} from "react";
import type {
  CreateSessionInput,
  SessionPreview,
  TerminalPreviewGrid,
  TerminalSession,
  UserPreferences
} from "../../shared/types";
import type { TaskItem } from "../../shared/taskTypes";
import { api, ApiError, type SessionInputResponse } from "../api";
import { detectCodexStatus, isCodexProcessCommand } from "../codexStatus";
import { SessionCard, type QuickInputPhase, type QuickInputStatus } from "../components/SessionCard";
import { SessionEditor } from "../components/SessionEditor";
import { TerminalDock } from "../components/TerminalDock";

interface Props {
  task: TaskItem;
  linkedSessions: TerminalSession[];
  userName: string;
  onClose: () => void;
  onSessionsLoaded: (sessions: TerminalSession[]) => void;
  onUnauthorized: () => void;
}

interface PreviewSettings {
  lines: number;
  refreshMs: number;
  fontSize: number;
  scale: number;
  minHeight: number;
}

const DEFAULT_PREVIEW_SETTINGS: PreviewSettings = {
  lines: 600,
  refreshMs: 1_000,
  fontSize: 16,
  scale: 1,
  minHeight: 500
};

const DEFAULT_PREFERENCES: UserPreferences = {
  terminalBackgroundImage: null,
  terminalProxyEnabled: false,
  terminalProxyUrl: "http://127.0.0.1:7890"
};

const QUICK_INPUT_ECHO_DELAY_MS = 180;
const QUICK_INPUT_REFRESH_RETRY_MS = 900;
const QUICK_INPUT_UPDATED_CLEAR_MS = 1_800;
const QUICK_INPUT_ERROR_CLEAR_MS = 4_000;
const PREVIEW_MAX_CHARS = 500_000;

export function TaskTerminalPanel({
  task,
  linkedSessions,
  userName,
  onClose,
  onSessionsLoaded,
  onUnauthorized
}: Props) {
  const settings = useMemo(() => terminalMonitorPreviewSettings(userName), [userName]);
  const [sessions, setSessions] = useState<TerminalSession[]>(linkedSessions);
  const [previews, setPreviews] = useState<Record<string, SessionPreview>>({});
  const [quickInputStatuses, setQuickInputStatuses] = useState<Record<string, QuickInputStatus>>({});
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_PREFERENCES);
  const [selectedExistingId, setSelectedExistingId] = useState("");
  const [editorSession, setEditorSession] = useState<TerminalSession | "new" | null>(null);
  const [activeTerminal, setActiveTerminal] = useState<TerminalSession | null>(null);
  const [cachedTerminals, setCachedTerminals] = useState<TerminalSession[]>([]);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [restartingSessionIds, setRestartingSessionIds] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const previewsRef = useRef(previews);
  const previewInFlightRef = useRef<Set<string>>(new Set());
  const quickInputTimersRef = useRef<Record<string, number[]>>({});

  useEffect(() => {
    previewsRef.current = previews;
  }, [previews]);

  useEffect(() => {
    return () => {
      Object.values(quickInputTimersRef.current).forEach((timers) => {
        timers.forEach((timer) => window.clearTimeout(timer));
      });
      quickInputTimersRef.current = {};
    };
  }, []);

  const handleApiError = useCallback(
    (caught: unknown, fallback: string) => {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      setError(caught instanceof Error ? caught.message : fallback);
    },
    [onUnauthorized]
  );

  const refreshSessions = useCallback(async () => {
    try {
      const loaded = await api.sessions(false);
      const loadedById = new Map(loaded.map((session) => [session.id, session]));
      setSessions(loaded);
      setCachedTerminals((current) =>
        current.map((session) => loadedById.get(session.id) ?? session)
      );
      setActiveTerminal((current) => (current ? loadedById.get(current.id) ?? current : null));
      onSessionsLoaded(loaded);
    } catch (caught) {
      handleApiError(caught, "Terminal 列表加载失败");
    }
  }, [handleApiError, onSessionsLoaded]);

  useEffect(() => {
    void refreshSessions();
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void refreshSessions();
      }
    }, Math.max(2_500, settings.refreshMs));
    return () => window.clearInterval(timer);
  }, [refreshSessions, settings.refreshMs]);

  useEffect(() => {
    void api.preferences().then(setPreferences).catch((caught) => handleApiError(caught, "Terminal 配置加载失败"));
  }, [handleApiError]);

  useEffect(() => {
    if (activeTerminal || editorSession) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [activeTerminal, editorSession, onClose]);

  const taskSessions = useMemo(
    () => sessions.filter((session) => session.taskId === task.id && !session.archived),
    [sessions, task.id]
  );
  const codexStatuses = useMemo(
    () => taskSessions.map((session) => detectCodexStatus(session, previews[session.id])),
    [previews, taskSessions]
  );
  const workingSessionCount = codexStatuses.filter((status) => status.state === "working").length;
  const confirmationSessionCount = codexStatuses.filter((status) => status.state === "needs_confirmation").length;
  const availableSessions = useMemo(
    () => sessions.filter((session) => !session.archived && !session.taskId),
    [sessions]
  );
  const runningCodexCount = taskSessions.filter((session) =>
    isCodexProcessCommand(session.runtime?.currentCommand ?? "")
  ).length;
  const atCodexCapacity = runningCodexCount >= task.maxConcurrency;
  const selectedExistingSession = availableSessions.find((session) => session.id === selectedExistingId);
  const selectedExistingConsumesCodexSlot = Boolean(
    selectedExistingSession && isCodexProcessCommand(selectedExistingSession.runtime?.currentCommand ?? "")
  );

  const applySessionPreview = useCallback((sessionId: string, preview: SessionPreview) => {
    if (preview.unchanged) {
      return;
    }
    setPreviews((current) =>
      samePreview(current[sessionId], preview) ? current : { ...current, [sessionId]: preview }
    );
  }, []);

  const refreshSessionPreview = useCallback(
    async (sessionId: string, force = false): Promise<SessionPreview | null> => {
      if (previewInFlightRef.current.has(sessionId)) {
        return null;
      }
      previewInFlightRef.current.add(sessionId);
      try {
        const knownSignature = force ? "" : previewContentSignature(previewsRef.current[sessionId]);
        const preview = await api.preview(sessionId, settings.lines, PREVIEW_MAX_CHARS, true, force, knownSignature);
        if (preview.unchanged) {
          return previewsRef.current[sessionId] ?? null;
        }
        applySessionPreview(sessionId, preview);
        return preview;
      } finally {
        previewInFlightRef.current.delete(sessionId);
      }
    },
    [applySessionPreview, settings.lines]
  );

  const taskSessionKey = taskSessions
    .map((session) => `${session.id}:${session.runtime?.exists ? "1" : "0"}`)
    .join("|");

  useEffect(() => {
    if (activeTerminal) {
      return;
    }
    let cancelled = false;
    const refreshPreviews = () => {
      if (document.hidden || isTerminalInputFocused()) {
        return;
      }
      taskSessions.forEach((session) => {
        if (!session.runtime?.exists) {
          setPreviews((current) =>
            current[session.id]?.text === "" ? current : { ...current, [session.id]: emptyPreview(session.id) }
          );
          return;
        }
        void refreshSessionPreview(session.id).catch(() => {
          if (!cancelled) {
            // Keep the last successful frame during a transient terminal capture failure.
          }
        });
      });
    };
    refreshPreviews();
    const timer = window.setInterval(refreshPreviews, settings.refreshMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeTerminal, refreshSessionPreview, settings.refreshMs, taskSessionKey]);

  const clearQuickInputTimers = useCallback((sessionId: string) => {
    const timers = quickInputTimersRef.current[sessionId] ?? [];
    timers.forEach((timer) => window.clearTimeout(timer));
    delete quickInputTimersRef.current[sessionId];
  }, []);

  const scheduleQuickInputTimer = useCallback((sessionId: string, callback: () => void, delayMs: number) => {
    const timer = window.setTimeout(callback, delayMs);
    quickInputTimersRef.current[sessionId] = [...(quickInputTimersRef.current[sessionId] ?? []), timer];
  }, []);

  const setQuickInputPhase = useCallback(
    (
      sessionId: string,
      inputId: string,
      phase: QuickInputPhase,
      details: { inputSeq?: number; message?: string } = {}
    ) => {
      setQuickInputStatuses((current) => {
        const previous = current[sessionId];
        if (phase !== "sending" && previous && previous.inputId !== inputId) {
          return current;
        }
        if (previous?.inputId === inputId && quickInputPhaseRank(phase) < quickInputPhaseRank(previous.phase)) {
          return current;
        }
        return {
          ...current,
          [sessionId]: {
            inputId,
            phase,
            inputSeq: details.inputSeq ?? (previous?.inputId === inputId ? previous.inputSeq : undefined),
            message: details.message,
            updatedAt: Date.now()
          }
        };
      });
    },
    []
  );

  const clearQuickInputStatus = useCallback((sessionId: string, inputId: string) => {
    setQuickInputStatuses((current) => {
      if (current[sessionId]?.inputId !== inputId) {
        return current;
      }
      return removeRecordKey(current, sessionId);
    });
  }, []);

  const sendQuickInput = useCallback(
    async (session: TerminalSession, value: string) => {
      if (!session.runtime?.exists) {
        const message = "请先打开并启动这个 Terminal，再发布指令";
        setError(message);
        throw new Error(message);
      }

      const inputId = createQuickInputId(session.id);
      clearQuickInputTimers(session.id);
      setQuickInputPhase(session.id, inputId, "sending");
      let result: SessionInputResponse;
      try {
        result = await api.sendInput(session.id, {
          inputId,
          data: value,
          enter: true,
          submitKey: "enter",
          mode: "paste",
          submitDelayMs: quickSubmitDelayMs(value, session, previewsRef.current[session.id]),
          lines: settings.lines,
          maxChars: PREVIEW_MAX_CHARS,
          includePreview: false
        });
      } catch (caught) {
        setQuickInputPhase(session.id, inputId, "error", {
          message: caught instanceof Error ? caught.message : "send failed"
        });
        scheduleQuickInputTimer(
          session.id,
          () => clearQuickInputStatus(session.id, inputId),
          QUICK_INPUT_ERROR_CLEAR_MS
        );
        handleApiError(caught, "指令发送失败");
        throw caught;
      }

      setQuickInputPhase(session.id, inputId, "sent", { inputSeq: result.inputSeq });
      const preview = previewFromInputResponse(session.id, result, previewsRef.current[session.id]);
      if (preview) {
        applySessionPreview(session.id, preview);
      }
      void refreshSessions();
      scheduleQuickInputTimer(session.id, () => {
        setQuickInputPhase(session.id, inputId, "echoing", { inputSeq: result.inputSeq });
      }, QUICK_INPUT_ECHO_DELAY_MS);
      scheduleQuickInputTimer(session.id, () => {
        void refreshSessionPreview(session.id, true)
          .then(() => {
            setQuickInputPhase(session.id, inputId, "updated", { inputSeq: result.inputSeq });
            scheduleQuickInputTimer(
              session.id,
              () => clearQuickInputStatus(session.id, inputId),
              QUICK_INPUT_UPDATED_CLEAR_MS
            );
          })
          .catch((caught) => {
            setQuickInputPhase(session.id, inputId, "error", {
              inputSeq: result.inputSeq,
              message: caught instanceof Error ? caught.message : "preview refresh failed"
            });
            scheduleQuickInputTimer(
              session.id,
              () => clearQuickInputStatus(session.id, inputId),
              QUICK_INPUT_ERROR_CLEAR_MS
            );
          });
      }, QUICK_INPUT_REFRESH_RETRY_MS);
    },
    [
      applySessionPreview,
      clearQuickInputStatus,
      clearQuickInputTimers,
      handleApiError,
      refreshSessionPreview,
      refreshSessions,
      scheduleQuickInputTimer,
      setQuickInputPhase,
      settings.lines
    ]
  );

  const linkExisting = async () => {
    const session = availableSessions.find((item) => item.id === selectedExistingId);
    if (!session || busySessionId) {
      return;
    }
    if (selectedExistingConsumesCodexSlot && atCodexCapacity) {
      setError(`此任务最多同时运行 ${task.maxConcurrency} 个 Codex；可以关联未启动 Codex 的 Terminal`);
      return;
    }
    setBusySessionId(session.id);
    setError("");
    try {
      await api.updateSession(session.id, { taskId: task.id, taskKey: task.key });
      setSelectedExistingId("");
      await refreshSessions();
    } catch (caught) {
      handleApiError(caught, "Terminal 关联失败");
    } finally {
      setBusySessionId(null);
    }
  };

  const unlinkTerminal = async (session: TerminalSession) => {
    if (
      busySessionId ||
      !window.confirm(`将 ${session.name} 从 ${task.key} 移除？Terminal 本身和正在运行的进程都会保留。`)
    ) {
      return;
    }
    setBusySessionId(session.id);
    setError("");
    try {
      setActiveTerminal((current) => (current?.id === session.id ? null : current));
      setCachedTerminals((current) => current.filter((item) => item.id !== session.id));
      await api.updateSession(session.id, { taskId: null, taskKey: null });
      await refreshSessions();
    } catch (caught) {
      handleApiError(caught, "Terminal 取消关联失败");
    } finally {
      setBusySessionId(null);
    }
  };

  const duplicateTerminal = async (session: TerminalSession) => {
    setBusySessionId(session.id);
    setError("");
    try {
      const duplicate = await api.duplicateSession(session.id);
      await api.updateSession(duplicate.id, { taskId: task.id, taskKey: task.key });
      await refreshSessions();
    } catch (caught) {
      handleApiError(caught, "Terminal 复制失败");
    } finally {
      setBusySessionId(null);
    }
  };

  const restartTerminal = async (session: TerminalSession) => {
    const prompt = session.runtime?.exists
      ? `重启 ${session.name}？当前进程会被终止；如果检测到 Codex，将用 resume --yolo 恢复当前会话。`
      : `启动并重建 ${session.name} terminal？`;
    if (!window.confirm(prompt)) {
      return;
    }
    setRestartingSessionIds((current) => ({ ...current, [session.id]: true }));
    setActiveTerminal((current) => (current?.id === session.id ? null : current));
    setCachedTerminals((current) => current.filter((item) => item.id !== session.id));
    setPreviews((current) => removeRecordKey(current, session.id));
    setError("");
    try {
      await api.restartSession(session.id);
      await refreshSessions();
    } catch (caught) {
      handleApiError(caught, `${session.name} 重启失败`);
    } finally {
      setRestartingSessionIds((current) => removeRecordKey(current, session.id));
    }
  };

  const cacheTerminal = (session: TerminalSession) => {
    setCachedTerminals((current) => [session, ...current.filter((item) => item.id !== session.id)].slice(0, 3));
    setActiveTerminal(session);
  };

  const closeTerminal = (session: TerminalSession) => {
    setActiveTerminal(null);
    void refreshSessionPreview(session.id, true);
    void refreshSessions();
  };

  const editorDefaults = useMemo<CreateSessionInput>(
    () => ({
      name: nextTaskTerminalName(task, taskSessions, sessions),
      group: task.project || "TaskMonitor",
      tags: Array.from(new Set(["task", task.key, ...task.tags])).slice(0, 12),
      taskId: task.id,
      taskKey: task.key,
      cwd: task.repositoryPath || undefined,
      backend: "zellij",
      backgroundMode: "inherit"
    }),
    [sessions, task, taskSessions]
  );

  const closeFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const gridStyle = {
    "--session-card-min-height": `${settings.minHeight + 120}px`,
    "--session-preview-min-height": `${settings.minHeight}px`
  } as CSSProperties;

  return (
    <div className="task-terminal-backdrop" role="presentation" onMouseDown={closeFromBackdrop}>
      <section className="task-terminal-panel" role="dialog" aria-modal="true" aria-labelledby="task-terminal-title">
        <header className="task-terminal-header">
          <div className="task-terminal-heading-mark" aria-hidden="true">
            <TerminalSquare size={21} />
          </div>
          <div>
            <span>{task.key} · Terminal Monitor infrastructure</span>
            <h2 id="task-terminal-title">{task.title}</h2>
            <small title={task.repositoryPath || undefined}>
              {task.project || "未归属项目"} · {task.repositoryPath || "未设置代码库目录"}
            </small>
          </div>
          <div
            className="task-terminal-capacity"
            title="正在运行的 Codex 数 / 最大并发；关联 Terminal 的数量不受此值限制"
          >
            <span className={workingSessionCount > 0 ? "task-terminal-orbit active" : "task-terminal-orbit"}>
              <i />
            </span>
            <div>
              <strong>{runningCodexCount}/{task.maxConcurrency}</strong>
              <span>
                {confirmationSessionCount > 0
                  ? `${confirmationSessionCount} 需确认 · ${taskSessions.length} Terminal`
                  : `${workingSessionCount} 工作中 · ${taskSessions.length} Terminal`}
              </span>
            </div>
          </div>
          <button className="task-terminal-close" type="button" onClick={onClose} title="关闭 Terminal 列表">
            <X size={19} />
          </button>
        </header>

        <div className="task-terminal-toolbar">
          <button
            className="task-terminal-create"
            type="button"
            onClick={() => {
              setError("");
              setEditorSession("new");
            }}
            title="使用 Terminal Monitor 编辑器新建；只有启动 Codex 时才占用并发名额"
          >
            <Plus size={16} />
            新建 Task Terminal
          </button>
          <div className="task-terminal-linker">
            <Link2 size={15} />
            <select
              value={selectedExistingId}
              onChange={(event) => setSelectedExistingId(event.target.value)}
              aria-label="选择尚未关联任务的 Terminal"
            >
              <option value="">关联已有 Terminal…</option>
              {availableSessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name} · {session.runtime?.exists ? "运行中" : "未运行"}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void linkExisting()}
              disabled={
                !selectedExistingId ||
                Boolean(busySessionId) ||
                (selectedExistingConsumesCodexSlot && atCodexCapacity)
              }
            >
              关联
            </button>
          </div>
          <span className="task-terminal-toolbar-note">
            下方直接使用 Terminal Monitor 的 ANSI/Canvas 预览、Quick Input、文件粘贴和 xterm 实际终端
          </span>
        </div>

        {error && (
          <div className="task-terminal-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")} title="关闭错误提示">×</button>
          </div>
        )}

        <div className="task-terminal-body">
          {taskSessions.length === 0 ? (
            <div className="task-terminal-empty">
              <span className="task-terminal-orbit"><i /></span>
              <h3>还没有分配 Terminal</h3>
              <p>新建时会自动填入任务名称、项目标签和代码库目录；也可以关联 Terminal Monitor 中已有的会话。</p>
              <button type="button" onClick={() => setEditorSession("new")}>
                <Plus size={16} /> 新建第一个 Task Terminal
              </button>
            </div>
          ) : (
            <div className="task-terminal-session-grid" style={gridStyle}>
              {taskSessions.map((session) => {
                const codexStatus = detectCodexStatus(session, previews[session.id]);
                const canSendTask = codexStatus.state === "ready" || codexStatus.state === "completed";
                return (
                <div className="task-terminal-session-slot" key={session.id}>
                  <div className="task-terminal-task-strip">
                    <span>
                      <TerminalSquare size={14} />
                      {task.key} · 已关联任务
                    </span>
                    <div>
                      <button
                        type="button"
                        onClick={() => void sendQuickInput(session, suggestedTaskPrompt(task))}
                        disabled={busySessionId === session.id || !canSendTask}
                        title={canSendTask ? "通过同一套 Quick Input 通道发送任务启动指令" : codexStatus.label}
                      >
                        {busySessionId === session.id ? <LoaderCircle className="spin" size={13} /> : <Bot size={13} />}
                        发送任务说明
                      </button>
                      <button
                        type="button"
                        onClick={() => void unlinkTerminal(session)}
                        disabled={Boolean(busySessionId)}
                        title="只解除任务关联，不停止 Terminal"
                      >
                        <Unlink size={13} />
                        从任务移除
                      </button>
                    </div>
                  </div>
                  <SessionCard
                    session={session}
                    preview={previews[session.id]}
                    backgroundImage={resolveTerminalBackground(session, preferences)}
                    quickInputStatus={quickInputStatuses[session.id]}
                    previewFontSize={settings.fontSize}
                    previewScale={settings.scale}
                    onOpen={() => cacheTerminal(session)}
                    onEdit={() => setEditorSession(session)}
                    onDuplicate={() => void duplicateTerminal(session)}
                    onQuickInput={(value) => sendQuickInput(session, value)}
                    onPasteFiles={async (files) => {
                      try {
                        const result = await api.uploadSessionFiles(session.id, files);
                        return result.terminalText;
                      } catch (caught) {
                        handleApiError(caught, "文件上传失败");
                        throw caught;
                      }
                    }}
                    onArchive={async () => {
                      try {
                        await api.archiveSession(session.id);
                        await refreshSessions();
                      } catch (caught) {
                        handleApiError(caught, "Terminal 归档失败");
                      }
                    }}
                    onRestore={async () => {
                      try {
                        await api.restoreSession(session.id);
                        await refreshSessions();
                      } catch (caught) {
                        handleApiError(caught, "Terminal 恢复失败");
                      }
                    }}
                    onRestart={() => void restartTerminal(session)}
                    restarting={Boolean(restartingSessionIds[session.id])}
                    onKill={async () => {
                      if (!window.confirm(`停止 ${session.name} terminal session？`)) {
                        return;
                      }
                      try {
                        await api.killSession(session.id);
                        await refreshSessions();
                      } catch (caught) {
                        handleApiError(caught, "Terminal 停止失败");
                      }
                    }}
                  />
                </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {editorSession && (
        <SessionEditor
          key={editorSession === "new" ? `new-${task.id}` : editorSession.id}
          session={editorSession === "new" ? null : editorSession}
          defaults={editorSession === "new" ? editorDefaults : undefined}
          defaultBackgroundImage={preferences.terminalBackgroundImage}
          onClose={() => setEditorSession(null)}
          onSave={async (input) => {
            try {
              if (editorSession === "new") {
                await api.createSession({ ...input, taskId: task.id, taskKey: task.key });
              } else {
                await api.updateSession(editorSession.id, input);
              }
              setEditorSession(null);
              await refreshSessions();
            } catch (caught) {
              handleApiError(caught, "Terminal 保存失败");
              throw caught;
            }
          }}
        />
      )}

      {cachedTerminals.map((session) => (
        <TerminalDock
          key={session.id}
          session={session}
          backgroundImage={resolveTerminalBackground(session, preferences)}
          visible={activeTerminal?.id === session.id}
          onClose={() => closeTerminal(session)}
          onRestart={() => void restartTerminal(session)}
          restarting={Boolean(restartingSessionIds[session.id])}
        />
      ))}
    </div>
  );
}

function terminalMonitorPreviewSettings(userName: string): PreviewSettings {
  try {
    const safeUser = userName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_") || "user";
    const stored = window.localStorage.getItem(`terminal-web-monitor.settings.v1.${safeUser}`);
    if (!stored) {
      return DEFAULT_PREVIEW_SETTINGS;
    }
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    return {
      lines: clampNumber(parsed.previewLines, 600, 20, 1_200),
      refreshMs: clampNumber(parsed.previewRefreshMs, 1_000, 1_000, 30_000),
      fontSize: clampNumber(parsed.listTerminalFontSize, 16, 12, 24),
      scale: clampNumber(parsed.listTerminalScale, 100, 80, 140) / 100,
      minHeight: clampNumber(parsed.previewMinHeight, 500, 160, 1_400)
    };
  } catch {
    return DEFAULT_PREVIEW_SETTINGS;
  }
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function nextTaskTerminalName(task: TaskItem, linked: TerminalSession[], all: TerminalSession[]): string {
  const base = `${task.key} · ${task.title}`.slice(0, 72).trim();
  const existing = new Set(all.map((session) => session.name.toLocaleLowerCase()));
  if (linked.length === 0 && !existing.has(base.toLocaleLowerCase())) {
    return base;
  }
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base.slice(0, 72 - String(index).length)} · ${index}`;
    if (!existing.has(candidate.toLocaleLowerCase())) {
      return candidate;
    }
  }
  return `${task.key} · Terminal ${Date.now().toString(36).slice(-4)}`;
}

function suggestedTaskPrompt(task: TaskItem): string {
  return `请使用 $manage-terminal-apron-tasks 读取 ${task.key}，根据任务描述、附件和验收标准开始处理；先汇报开始，完成关键里程碑后持续更新进度。`;
}

function resolveTerminalBackground(session: TerminalSession, preferences: UserPreferences): string | null {
  if (session.backgroundMode === "none") {
    return null;
  }
  if (session.backgroundMode === "image") {
    return session.backgroundImage ?? null;
  }
  return preferences.terminalBackgroundImage;
}

function isTerminalInputFocused(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && Boolean(active.closest(".terminal-dock, .quick-input"));
}

function createQuickInputId(sessionId: string): string {
  return `qi:${sessionId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

function quickSubmitDelayMs(value: string, session: TerminalSession, preview?: SessionPreview): number {
  const output = preview?.text?.slice(-6_000) ?? "";
  const codexRunning =
    /\bcodex(?:\.exe)?\b/i.test(session.runtime?.currentCommand || "") ||
    /OpenAI Codex|codex-cli|codex resume|YOLO mode|esc to interrupt|Implement \{feature\}|gpt-[\w.-]+\s+(?:low|medium|high)/i.test(
      output
    );
  if (codexRunning) {
    return Math.max(5_200, Math.min(10_000, 5_200 + Math.ceil(value.length / 2)));
  }
  return Math.max(140, Math.min(600, 140 + Math.ceil(value.length / 80)));
}

function quickInputPhaseRank(phase: QuickInputPhase): number {
  if (phase === "sending") return 0;
  if (phase === "sent") return 1;
  if (phase === "echoing") return 2;
  if (phase === "updated") return 3;
  return 4;
}

function removeRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) {
    return record;
  }
  const next = { ...record };
  delete next[key];
  return next;
}

function emptyPreview(sessionId: string): SessionPreview {
  return {
    sessionId,
    text: "",
    signature: "",
    capturedAt: new Date(0).toISOString()
  };
}

function previewFromInputResponse(
  sessionId: string,
  result: SessionInputResponse,
  fallback?: SessionPreview
): SessionPreview | null {
  if (result.preview === undefined && !result.grid) {
    return null;
  }
  return {
    ...emptyPreview(sessionId),
    text: result.preview ?? fallback?.text ?? "",
    grid: result.grid,
    signature: result.signature,
    capturedAt: result.capturedAt ?? new Date().toISOString()
  };
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
  return [
    grid.cols,
    ...grid.rows.map((row) =>
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
    )
  ].join("\u001c");
}
