import {
  Archive,
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  CircleDot,
  Edit3,
  FolderCog,
  FolderKanban,
  FolderGit2,
  Image as ImageIcon,
  ListFilter,
  ListTodo,
  Layers3,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldAlert,
  Sparkles,
  TerminalSquare,
  TimerReset,
  Tags,
  Trash2,
  X
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionPreview, TerminalSession } from "../../shared/types";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskDashboardStats,
  type TaskDifficulty,
  type TaskGroupSummary,
  type TaskItem,
  type TaskPriority,
  type TaskProjectSummary,
  type TaskReportStatus,
  type TaskStatus,
  type TaskTagSummary,
  type UpdateTaskInput
} from "../../shared/taskTypes";
import { TaskApiError, taskApi } from "../taskApi";
import { newClientMessageId, TaskConversationApiError, taskConversationApi } from "../taskConversationApi";
import { api, ApiError as TerminalApiError } from "../api";
import {
  detectCodexStatus,
  isCodexProcessCommand,
  isInteractiveShellCommand,
  type CodexSessionState,
  type CodexSessionStatus
} from "../codexStatus";
import { MarkdownContent } from "./MarkdownContent";
import { TaskEditor } from "./TaskEditor";
import { ProjectEditor } from "./ProjectEditor";
import { TaskSavedViews } from "./TaskSavedViews";
import type { TaskSearchFilters } from "./taskSearchFilters";
import { TaskTerminalPanel } from "./TaskTerminalPanel";
import { TaskConversationPanel, type TaskConversationLaunch } from "./TaskConversationPanel";
import { TaskConversationDefaultsDialog } from "./TaskConversationDefaults";

interface Props {
  userName: string;
  onUnauthorized: () => void;
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  pending_auto_acceptance: "待自动验收",
  pending_manual_acceptance: "待人工验收",
  done: "已完成",
  blocked: "阻塞"
};

const REPORT_STATUS_LABELS: Record<TaskReportStatus, string> = {
  started: "开始处理",
  progress: "进度汇报",
  blocked: "阻塞汇报",
  completed: "提交验收",
  note: "补充记录"
};

const EMPTY_STATS: TaskDashboardStats = {
  total: 0,
  active: 0,
  blocked: 0,
  done: 0,
  byStatus: {
    not_started: 0,
    in_progress: 0,
    pending_auto_acceptance: 0,
    pending_manual_acceptance: 0,
    done: 0,
    blocked: 0
  }
};

const ALL_PROJECTS_FILTER = "__task_monitor_all_projects__";
const UNASSIGNED_PROJECT_FILTER = "__task_monitor_unassigned__";
const PROJECT_FILTER_PREFIX = "project:";
const ALL_GROUPS_FILTER = "__task_monitor_all_groups__";
const UNGROUPED_GROUP_FILTER = "__task_monitor_ungrouped__";
const GROUP_FILTER_PREFIX = "group:";
const conversationStartsInFlight = new Set<string>();

type LiveSyncState = "connecting" | "live" | "reconnecting";
type ArrangementStage = "creating" | "starting_terminal" | "starting_codex" | "sending_task";
type ConversationStartStage = "creating_conversation" | "sending_task";

interface TaskProjectGroup {
  key: string;
  name: string;
  rootDirectory: string;
  unassigned: boolean;
  tasks: TaskItem[];
}

const LIVE_SYNC_LABELS: Record<LiveSyncState, string> = {
  connecting: "连接实时同步",
  live: "实时同步",
  reconnecting: "实时同步重连中"
};

const ARRANGEMENT_LABELS: Record<ArrangementStage, string> = {
  creating: "正在分配 Terminal",
  starting_terminal: "正在启动 Terminal",
  starting_codex: "正在启动 Codex",
  sending_task: "正在发送任务"
};

export function TaskMonitorPage({ userName, onUnauthorized }: Props) {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [projects, setProjects] = useState<TaskProjectSummary[]>([]);
  const [unassignedCount, setUnassignedCount] = useState(0);
  const [groups, setGroups] = useState<TaskGroupSummary[]>([]);
  const [ungroupedCount, setUngroupedCount] = useState(0);
  const [tagSummaries, setTagSummaries] = useState<TaskTagSummary[]>([]);
  const [stats, setStats] = useState<TaskDashboardStats>(EMPTY_STATS);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS_FILTER);
  const [groupFilter, setGroupFilter] = useState(ALL_GROUPS_FILTER);
  const [tagFilterText, setTagFilterText] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editorTask, setEditorTask] = useState<TaskItem | "new" | null>(null);
  const [projectEditorOpen, setProjectEditorOpen] = useState(false);
  const [projectEditorInitial, setProjectEditorInitial] = useState<string | undefined>();
  const [linkedTerminals, setLinkedTerminals] = useState<TerminalSession[]>([]);
  const [terminalPreviews, setTerminalPreviews] = useState<Record<string, SessionPreview>>({});
  const [terminalPanelTarget, setTerminalPanelTarget] = useState<TaskItem | null>(null);
  const [conversationTarget, setConversationTarget] = useState<TaskItem | null>(null);
  const [conversationSettingsTarget, setConversationSettingsTarget] = useState<TaskItem | null>(null);
  const [conversationInitialError, setConversationInitialError] = useState("");
  const [conversationLaunch, setConversationLaunch] = useState<TaskConversationLaunch | null>(null);
  const [conversationStartingId, setConversationStartingId] = useState<string | null>(null);
  const [conversationStartStage, setConversationStartStage] = useState<ConversationStartStage | null>(null);
  const [arrangingId, setArrangingId] = useState<string | null>(null);
  const [arrangementStage, setArrangementStage] = useState<ArrangementStage | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TaskItem | null>(null);
  const [error, setError] = useState("");
  const [liveSyncState, setLiveSyncState] = useState<LiveSyncState>("connecting");
  const requestSequence = useRef(0);
  const taskUpdateQueues = useRef(new Map<string, Promise<void>>());
  const liveRefreshTimer = useRef<number | null>(null);
  const terminalPreviewsRef = useRef(terminalPreviews);

  useEffect(() => {
    terminalPreviewsRef.current = terminalPreviews;
  }, [terminalPreviews]);

  const tagFilters = useMemo(() => {
    const unique = new Map<string, string>();
    for (const tag of tagFilterText.split(",")) {
      const normalized = tag.trim();
      if (normalized && !unique.has(normalized.toLocaleLowerCase())) {
        unique.set(normalized.toLocaleLowerCase(), normalized);
      }
    }
    return Array.from(unique.values()).slice(0, 12);
  }, [tagFilterText]);

  const currentFilters = useMemo<TaskSearchFilters>(
    () => ({
      query,
      status: statusFilter,
      project: projectFilterValue(projectFilter),
      group: groupFilterValue(groupFilter),
      tags: tagFilters,
      archived: showArchived
    }),
    [groupFilter, projectFilter, query, showArchived, statusFilter, tagFilters]
  );

  const applySavedView = useCallback((filters: TaskSearchFilters) => {
    setQuery(filters.query);
    setStatusFilter(filters.status);
    setProjectFilter(projectFilterKey(filters.project));
    setGroupFilter(groupFilterKey(filters.group));
    setTagFilterText(filters.tags.join(", "));
    setShowArchived(filters.archived);
  }, []);

  const loadTasks = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      const [response, projectResponse, groupResponse, tagResponse] = await Promise.all([
        taskApi.list({
          query,
          status: statusFilter,
          project: projectFilterValue(projectFilter),
          group: groupFilterValue(groupFilter),
          tags: tagFilters,
          archived: showArchived
        }),
        taskApi.projects(showArchived),
        taskApi.groups(showArchived),
        taskApi.tags(showArchived)
      ]);
      if (sequence !== requestSequence.current) {
        return;
      }
      setTasks(response.tasks);
      setStats(response.stats);
      setProjects(projectResponse.projects);
      setUnassignedCount(projectResponse.unassignedCount);
      setGroups(groupResponse.groups);
      setUngroupedCount(groupResponse.ungroupedCount);
      setTagSummaries(tagResponse.tags);
      setError("");
    } catch (loadError) {
      if (loadError instanceof TaskApiError && loadError.status === 401) {
        onUnauthorized();
        return;
      }
      setError(loadError instanceof Error ? loadError.message : "任务列表加载失败");
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
      }
    }
  }, [groupFilter, onUnauthorized, projectFilter, query, showArchived, statusFilter, tagFilters]);

  const loadTasksRef = useRef(loadTasks);
  useEffect(() => {
    loadTasksRef.current = loadTasks;
  }, [loadTasks]);

  const loadLinkedTerminals = useCallback(async () => {
    try {
      setLinkedTerminals((await api.sessions(false, { taskLinked: true })).filter((session) => Boolean(session.taskId)));
    } catch (terminalError) {
      if (terminalError instanceof TerminalApiError && terminalError.status === 401) {
        onUnauthorized();
      }
    }
  }, [onUnauthorized]);

  const handleTerminalSessionsLoaded = useCallback((sessions: TerminalSession[]) => {
    setLinkedTerminals(sessions.filter((session) => Boolean(session.taskId)));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadTasks(), query ? 220 : 0);
    return () => window.clearTimeout(timer);
  }, [loadTasks, query]);

  useEffect(() => {
    const events = new EventSource("/api/tasks/events");
    const scheduleRefresh = () => {
      if (liveRefreshTimer.current !== null) {
        window.clearTimeout(liveRefreshTimer.current);
      }
      liveRefreshTimer.current = window.setTimeout(() => {
        liveRefreshTimer.current = null;
        void loadTasksRef.current();
      }, 100);
    };

    events.onopen = () => {
      setLiveSyncState("live");
      scheduleRefresh();
    };
    events.onerror = () => {
      setLiveSyncState("reconnecting");
    };
    events.addEventListener("task-change", scheduleRefresh);

    return () => {
      events.removeEventListener("task-change", scheduleRefresh);
      events.close();
      if (liveRefreshTimer.current !== null) {
        window.clearTimeout(liveRefreshTimer.current);
        liveRefreshTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    void loadLinkedTerminals();
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void loadLinkedTerminals();
      }
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [loadLinkedTerminals]);

  const linkedTerminalPreviewKey = linkedTerminals
    .map((session) => `${session.id}:${session.runtime?.exists ? "1" : "0"}:${session.runtime?.currentCommand ?? ""}`)
    .join("|");

  useEffect(() => {
    let cancelled = false;
    const visibleIds = new Set(linkedTerminals.map((session) => session.id));
    const refreshPreviews = async () => {
      if (document.hidden) {
        return;
      }
      const results = await Promise.all(
        linkedTerminals.map(async (session) => {
          if (!session.runtime?.exists) {
            return [session.id, emptyTerminalPreview(session.id)] as const;
          }
          try {
            const signature = previewSignature(terminalPreviewsRef.current[session.id]);
            const preview = await api.preview(session.id, 180, 80_000, false, false, signature);
            return [session.id, preview.unchanged ? null : preview] as const;
          } catch {
            return [session.id, null] as const;
          }
        })
      );
      if (cancelled) {
        return;
      }
      setTerminalPreviews((current) => {
        const next = Object.fromEntries(Object.entries(current).filter(([sessionId]) => visibleIds.has(sessionId)));
        results.forEach(([sessionId, preview]) => {
          if (preview) {
            next[sessionId] = preview;
          }
        });
        return next;
      });
    };
    void refreshPreviews();
    const timer = window.setInterval(() => void refreshPreviews(), 2_500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [linkedTerminalPreviewKey]);

  useEffect(() => {
    if (tasks.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !tasks.some((task) => task.id === selectedId)) {
      setSelectedId(tasks[0].id);
    }
  }, [selectedId, tasks]);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedId) ?? null,
    [selectedId, tasks]
  );

  const terminalsByTask = useMemo(() => {
    const grouped = new Map<string, TerminalSession[]>();
    linkedTerminals.forEach((session) => {
      if (!session.taskId) {
        return;
      }
      grouped.set(session.taskId, [...(grouped.get(session.taskId) ?? []), session]);
    });
    return grouped;
  }, [linkedTerminals]);

  const terminalStatusesByTask = useMemo(() => {
    const grouped = new Map<string, CodexSessionStatus[]>();
    linkedTerminals.forEach((session) => {
      if (!session.taskId) {
        return;
      }
      const status = detectCodexStatus(session, terminalPreviews[session.id]);
      grouped.set(session.taskId, [...(grouped.get(session.taskId) ?? []), status]);
    });
    return grouped;
  }, [linkedTerminals, terminalPreviews]);

  const taskProjectGroups = useMemo<TaskProjectGroup[]>(() => {
    const grouped = new Map<string, TaskItem[]>();
    tasks.forEach((task) => {
      const projectName = task.project.trim();
      grouped.set(projectName, [...(grouped.get(projectName) ?? []), task]);
    });
    const projectOrder = new Map(projects.map((project, index) => [project.name, index]));
    const projectByName = new Map(projects.map((project) => [project.name, project]));
    return Array.from(grouped.entries())
      .sort(([left], [right]) => {
        if (!left) return 1;
        if (!right) return -1;
        const leftOrder = projectOrder.get(left) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = projectOrder.get(right) ?? Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.localeCompare(right, "zh-CN");
      })
      .map(([name, projectTasks]) => ({
        key: name || "__unassigned__",
        name: name || "未归属项目",
        rootDirectory: name ? projectByName.get(name)?.rootDirectory ?? "" : "",
        unassigned: !name,
        tasks: projectTasks
      }));
  }, [projects, tasks]);

  const terminalPanelTask = useMemo(
    () =>
      terminalPanelTarget
        ? tasks.find((task) => task.id === terminalPanelTarget.id) ?? terminalPanelTarget
        : null,
    [tasks, terminalPanelTarget]
  );

  const updateTask = (task: TaskItem, patch: UpdateTaskInput) => {
    const previous = taskUpdateQueues.current.get(task.id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      setSavingId(task.id);
      setError("");
      try {
        const current = await taskApi.get(task.id);
        const updated = await taskApi.update(task.id, { ...patch, revision: current.revision });
        replaceTask(updated);
        void loadTasks();
      } catch (updateError) {
        setError(
          updateError instanceof TaskApiError && updateError.status === 409
            ? "任务刚刚被其他操作更新，已重新加载最新内容"
            : updateError instanceof Error
              ? updateError.message
              : "任务更新失败"
        );
        void loadTasks();
      }
    });
    taskUpdateQueues.current.set(task.id, operation);
    void operation.finally(() => {
      if (taskUpdateQueues.current.get(task.id) === operation) {
        taskUpdateQueues.current.delete(task.id);
        setSavingId((current) => (current === task.id ? null : current));
      }
    });
    return operation;
  };

  const archiveTask = async (task: TaskItem) => {
    if (!window.confirm(task.archived ? `恢复 ${task.key}？` : `归档 ${task.key}？任务数据和截图会保留。`)) {
      return;
    }
    setSavingId(task.id);
    try {
      const updated = task.archived ? await taskApi.restore(task.id) : await taskApi.archive(task.id);
      replaceTask(updated);
      await loadTasks();
    } catch (archiveError) {
      setError(archiveError instanceof Error ? archiveError.message : "任务状态更新失败");
    } finally {
      setSavingId(null);
    }
  };

  const deleteTask = async (task: TaskItem) => {
    if (savingId === task.id) {
      return;
    }
    setSavingId(task.id);
    setError("");
    try {
      await taskApi.delete(task.id);
      setTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      setSelectedId((current) => (current === task.id ? null : current));
      setEditorTask((current) => (current && current !== "new" && current.id === task.id ? null : current));
      setTerminalPanelTarget((current) => (current?.id === task.id ? null : current));
      setDeleteTarget(null);
      await Promise.all([loadTasks(), loadLinkedTerminals()]);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "任务删除失败");
    } finally {
      setSavingId(null);
    }
  };

  const replaceTask = (updated: TaskItem) => {
    setTasks((current) => current.map((task) => (task.id === updated.id ? updated : task)));
    setSelectedId(updated.id);
    setEditorTask((current) => (current && current !== "new" && current.id === updated.id ? updated : current));
  };

  const handleSaved = (saved: TaskItem, options?: { close?: boolean }) => {
    setTasks((current) => {
      const exists = current.some((task) => task.id === saved.id);
      return exists ? current.map((task) => (task.id === saved.id ? saved : task)) : [saved, ...current];
    });
    setSelectedId(saved.id);
    setEditorTask(options?.close === false ? saved : null);
    void loadTasks();
  };

  const openProjectEditor = (name?: string) => {
    setProjectEditorInitial(name);
    setProjectEditorOpen(true);
  };

  const handleProjectSaved = (project: TaskProjectSummary, previousName: string | null) => {
    setProjects((current) => {
      const withoutPrevious = current.filter(
        (item) => item.name.toLocaleLowerCase() !== (previousName ?? project.name).toLocaleLowerCase()
      );
      return [...withoutPrevious, project].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    });
    setProjectFilter(`${PROJECT_FILTER_PREFIX}${encodeURIComponent(project.name)}`);
    setProjectEditorInitial(project.name);
    setProjectEditorOpen(false);
    void (async () => {
      if (editorTask && editorTask !== "new") {
        try {
          setEditorTask(await taskApi.get(editorTask.id));
        } catch (refreshError) {
          setError(refreshError instanceof Error ? refreshError.message : "任务刷新失败");
        }
      }
      await loadTasks();
    })();
  };

  const arrangeTask = async (task: TaskItem) => {
    if (arrangingId) {
      return;
    }
    setArrangingId(task.id);
    setArrangementStage("creating");
    setError("");
    try {
      const allSessions = await api.sessions(false);
      const taskSessions = allSessions.filter((session) => session.taskId === task.id && !session.archived);
      const runningCodexCount = taskSessions.filter((session) =>
        isCodexProcessCommand(session.runtime?.currentCommand ?? "")
      ).length;
      const existingCodex = taskSessions.find((session) =>
        isCodexProcessCommand(session.runtime?.currentCommand ?? "")
      );
      if (existingCodex) {
        setTerminalPanelTarget(task);
        return;
      }

      let session = taskSessions.find(
        (candidate) => !candidate.runtime?.exists || isInteractiveShellCommand(candidate.runtime.currentCommand)
      );
      if (!session) {
        if (runningCodexCount >= task.maxConcurrency) {
          throw new Error(`此任务已有 ${runningCodexCount} 个 Codex 在运行，请先释放一个并发名额`);
        }
        session = await api.createSession({
          name: nextArrangementTerminalName(task, allSessions),
          group: task.group || task.project || "TaskMonitor",
          tags: Array.from(new Set(["task", task.key, ...task.tags])).slice(0, 12),
          taskId: task.id,
          taskKey: task.key,
          cwd: task.repositoryPath || undefined,
          backend: "zellij",
          backgroundMode: "inherit"
        });
      }

      setArrangementStage("starting_terminal");
      session = await api.ensureSession(session.id);
      const currentCommand = session.runtime?.currentCommand ?? "";
      if (!isCodexProcessCommand(currentCommand)) {
        if (session.runtime?.exists && !isInteractiveShellCommand(currentCommand)) {
          throw new Error(`${session.name} 正在运行 ${currentCommand || "未知进程"}，未自动接管`);
        }
        setArrangementStage("starting_codex");
        await api.sendInput(session.id, {
          inputId: `arrange-codex-${task.key}-${Date.now().toString(36)}`,
          data: "codex --yolo",
          enter: true,
          mode: "type",
          submitDelayMs: 0,
          includePreview: false
        });
        session = await waitForCodexSession(session.id);
      }

      setArrangementStage("sending_task");
      await api.sendInput(session.id, {
        inputId: `arrange-task-${task.key}-${Date.now().toString(36)}`,
        data: taskArrangementPrompt(task),
        enter: true,
        mode: "paste",
        submitDelayMs: 5_200,
        includePreview: false
      });
      await loadLinkedTerminals();
      setTerminalPanelTarget(task);
    } catch (arrangeError) {
      if (arrangeError instanceof TerminalApiError && arrangeError.status === 401) {
        onUnauthorized();
      } else {
        setError(arrangeError instanceof Error ? arrangeError.message : "Codex 任务安排失败");
      }
      void loadLinkedTerminals();
    } finally {
      setArrangingId(null);
      setArrangementStage(null);
    }
  };

  const openConversation = (task: TaskItem, initialError = "", launch?: TaskConversationLaunch) => {
    setConversationInitialError(initialError);
    if (launch) setConversationLaunch(launch);
    else setConversationLaunch((current) => current?.taskId === task.id ? current : null);
    setConversationTarget(task);
  };

  const startTaskInNewConversation = async (task: TaskItem) => {
    if (conversationStartsInFlight.has(task.id) || conversationStartingId || arrangingId) return;
    conversationStartsInFlight.add(task.id);
    setConversationStartingId(task.id);
    setConversationStartStage("creating_conversation");
    setError("");
    const launchId = newClientMessageId();
    const prompt = taskArrangementPrompt(task);
    const launch: TaskConversationLaunch = { id: launchId, taskId: task.id, prompt, stage: "creating" };
    openConversation(task, "", launch);
    let createdConversation: TaskConversationLaunch["conversation"];
    try {
      const created = await taskConversationApi.create(task.id, { clientMessageId: newClientMessageId() });
      createdConversation = created.conversation;
      setConversationStartStage("sending_task");
      setConversationLaunch((current) => current?.id === launchId ? { ...current, stage: "sending", conversation: created.conversation } : current);
      await taskConversationApi.send(task.id, created.conversation.threadId, {
        clientMessageId: newClientMessageId(),
        text: prompt
      });
      setConversationLaunch((current) => current?.id === launchId ? { ...current, stage: "completed", conversation: created.conversation } : current);
    } catch (startError) {
      const reason = startError instanceof Error ? startError.message : "未知错误";
      const message = createdConversation
        ? `已创建新对话，但任务指令发送失败：${reason === "未知错误" ? "请在对话中重新发送" : reason}`
        : startError instanceof Error ? startError.message : "新建 Codex 对话失败";
      setConversationLaunch((current) => current?.id === launchId
        ? { ...current, stage: "failed", conversation: createdConversation, error: message }
        : current);
      if (startError instanceof TaskConversationApiError && startError.status === 401) {
        onUnauthorized();
      }
    } finally {
      conversationStartsInFlight.delete(task.id);
      setConversationStartingId(null);
      setConversationStartStage(null);
    }
  };

  const consumeConversationLaunch = useCallback((launchId: string) => {
    setConversationLaunch((current) => current?.id === launchId ? null : current);
  }, []);

  return (
    <section className="task-monitor" aria-label="Task Monitor">
      <header className="task-workbench">
        <div className="task-workbench-copy">
          <span className="task-kicker">TaskMonitor · 开发任务工作台</span>
          <h2>从一个问题，走到一条可执行的路线。</h2>
          <p>把需求、截图和验收标准放在同一处，再一键创建 Task Terminal、启动 Codex 并发送执行指令。</p>
        </div>
        <div className="task-horizon" aria-label="任务进度概览">
          <div className="task-horizon-heading">
            <span>当前队列</span>
            <strong>{stats.total}</strong>
            <small>项任务</small>
          </div>
          <div className="task-horizon-track" aria-hidden="true">
            {TASK_STATUSES.map((status) => {
              const count = stats.byStatus[status];
              return count > 0 ? (
                <span
                  className={`status-${status}`}
                  key={status}
                  style={{ flexGrow: count }}
                  title={`${STATUS_LABELS[status]} ${count}`}
                />
              ) : null;
            })}
            {stats.total === 0 && <span className="task-horizon-empty" />}
          </div>
          <div className="task-horizon-metrics">
            <span>
              <CircleDot size={14} /> 活跃 {stats.active}
            </span>
            <span>
              <ShieldAlert size={14} /> 阻塞 {stats.blocked}
            </span>
            <span>
              <CheckCircle2 size={14} /> 完成 {stats.done}
            </span>
            <span>
              <TimerReset size={14} /> 待验收{
                stats.byStatus.pending_auto_acceptance + stats.byStatus.pending_manual_acceptance
              }
            </span>
          </div>
        </div>
        <button className="task-new-button" type="button" onClick={() => setEditorTask("new")}>
          <Plus size={18} />
          新建任务
        </button>
      </header>

      <section className="task-filterbar">
        <label className="task-searchbox">
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索任务、项目、分组、标签或仓库"
          />
        </label>
        <label className="task-filter-select">
          <ListFilter size={16} />
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as TaskStatus | "all")}>
            <option value="all">全部进度</option>
            {TASK_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <div className="task-project-filter-group">
          <label className="task-filter-select task-project-filter">
            <FolderKanban size={16} />
            <select value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}>
              <option value={ALL_PROJECTS_FILTER}>全部项目</option>
              {projects.map((project) => (
                <option key={project.name} value={`${PROJECT_FILTER_PREFIX}${encodeURIComponent(project.name)}`}>
                  {project.name} · {project.taskCount}
                </option>
              ))}
              {unassignedCount > 0 && (
                <option value={UNASSIGNED_PROJECT_FILTER}>未归属 · {unassignedCount}</option>
              )}
            </select>
          </label>
          <button
            className="task-project-manage-button"
            type="button"
            onClick={() => openProjectEditor(projectFilterValue(projectFilter))}
            title="新建或编辑项目"
          >
            <FolderCog size={16} />
          </button>
        </div>
        <label className="task-filter-select task-group-filter">
          <Layers3 size={16} />
          <select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value)}>
            <option value={ALL_GROUPS_FILTER}>全部分组</option>
            {groups.map((group) => (
              <option key={group.name} value={`${GROUP_FILTER_PREFIX}${encodeURIComponent(group.name)}`}>
                {group.name} · {group.taskCount}
              </option>
            ))}
            {ungroupedCount > 0 && <option value={UNGROUPED_GROUP_FILTER}>未分组 · {ungroupedCount}</option>}
          </select>
        </label>
        <label className="task-filter-select task-tag-filter">
          <Tags size={16} />
          <input
            list="task-tag-filter-options"
            value={tagFilterText}
            onChange={(event) => setTagFilterText(event.target.value)}
            placeholder="标签（逗号分隔）"
            aria-label="按标签筛选任务"
          />
          <datalist id="task-tag-filter-options">
            {tagSummaries.map((tag) => (
              <option key={tag.name} value={tag.name} label={`${tag.name} · ${tag.taskCount}`} />
            ))}
          </datalist>
        </label>
        <button
          className={showArchived ? "task-filter-button active" : "task-filter-button"}
          type="button"
          onClick={() => setShowArchived((value) => !value)}
        >
          <Archive size={16} />
          已归档
        </button>
        <TaskSavedViews filters={currentFilters} onApply={applySavedView} />
        <button className="task-filter-button" type="button" onClick={() => void loadTasks()} title="刷新任务">
          <RefreshCw size={16} className={loading ? "spin" : ""} />
          刷新
        </button>
        <div className="task-filter-meta">
          <span
            className={`task-live-sync task-live-${liveSyncState}`}
            role="status"
            title="Codex Skill 或其他客户端更新任务后，当前页面会自动刷新"
          >
            <span aria-hidden="true" />
            {LIVE_SYNC_LABELS[liveSyncState]}
          </span>
          <span className="task-filter-result">当前显示 {tasks.length} 项</span>
        </div>
      </section>

      {error && (
        <div className="task-error-banner" role="alert">
          <ShieldAlert size={17} />
          <span>{error}</span>
          <button type="button" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}

      <div className="task-workspace">
        <div className="task-project-stack">
          {loading && tasks.length === 0 ? (
            <section className="task-table-panel">
              <TaskTableSkeleton />
            </section>
          ) : tasks.length === 0 ? (
            <section className="task-table-panel">
              <div className="task-empty-state">
                <div className="task-empty-symbol">
                  <ListTodo size={31} />
                </div>
                <h3>
                  {query || statusFilter !== "all" || projectFilter !== ALL_PROJECTS_FILTER || groupFilter !== ALL_GROUPS_FILTER || tagFilters.length > 0 || showArchived
                    ? "没有匹配的任务"
                    : "从第一个开发问题开始"}
                </h3>
                <p>
                  {query || statusFilter !== "all" || projectFilter !== ALL_PROJECTS_FILTER || groupFilter !== ALL_GROUPS_FILTER || tagFilters.length > 0 || showArchived
                    ? "换一个筛选条件，或者回到活动任务。"
                    : "填写任务名称、Markdown 描述和截图，创建一条可追踪的执行记录。"}
                </p>
                {!query && statusFilter === "all" && projectFilter === ALL_PROJECTS_FILTER && groupFilter === ALL_GROUPS_FILTER && tagFilters.length === 0 && !showArchived && (
                  <button className="task-primary-button" type="button" onClick={() => setEditorTask("new")}>
                    <Plus size={17} />
                    创建第一个任务
                  </button>
                )}
              </div>
            </section>
          ) : (
            taskProjectGroups.map((group) => (
              <section className={group.unassigned ? "task-table-panel unassigned" : "task-table-panel"} key={group.key}>
                <header className="task-project-panel-header">
                  <div className="task-project-panel-identity">
                    {group.unassigned ? <FolderKanban size={17} /> : <FolderGit2 size={17} />}
                    <div>
                      <strong>{group.name}</strong>
                      <code title={group.rootDirectory || undefined}>
                        {group.rootDirectory || "未选择项目根目录"}
                      </code>
                    </div>
                  </div>
                  <span>{group.tasks.length} 项任务</span>
                </header>
                <header className="task-table-header">
                  <span>任务</span>
                  <span>项目</span>
                  <span>分组</span>
                  <span>标签</span>
                  <span>进度</span>
                  <span>优先级</span>
                  <span>难度</span>
                  <span>创建</span>
                  <span>更新</span>
                </header>
                <div className="task-table-body">
                  {group.tasks.map((task) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      selected={task.id === selectedId}
                      saving={savingId === task.id}
                      onSelect={() => setSelectedId(task.id)}
                      onEdit={() => setEditorTask(task)}
                      onUpdate={(patch) => void updateTask(task, patch)}
                      projects={projects}
                      groups={groups}
                      tagSummaries={tagSummaries}
                      terminalSessions={terminalsByTask.get(task.id) ?? []}
                      terminalStatuses={terminalStatusesByTask.get(task.id) ?? []}
                      onTerminals={() => setTerminalPanelTarget(task)}
                      onConversation={() => openConversation(task)}
                      onSettings={() => setConversationSettingsTarget(task)}
                      onArrange={() => void arrangeTask(task)}
                      arranging={arrangingId === task.id}
                      arrangementLabel={arrangingId === task.id && arrangementStage ? ARRANGEMENT_LABELS[arrangementStage] : undefined}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>

        <aside className={selectedTask ? "task-inspector populated" : "task-inspector"}>
          {selectedTask ? (
            <TaskInspector
              task={selectedTask}
              saving={savingId === selectedTask.id}
              onEdit={() => setEditorTask(selectedTask)}
              onArchive={() => void archiveTask(selectedTask)}
              onDelete={() => setDeleteTarget(selectedTask)}
              onUpdate={(patch) => void updateTask(selectedTask, patch)}
              terminalSessions={terminalsByTask.get(selectedTask.id) ?? []}
              terminalStatuses={terminalStatusesByTask.get(selectedTask.id) ?? []}
              onTerminals={() => setTerminalPanelTarget(selectedTask)}
              onConversation={() => openConversation(selectedTask)}
              onSettings={() => setConversationSettingsTarget(selectedTask)}
              onStartConversation={() => void startTaskInNewConversation(selectedTask)}
              conversationStarting={conversationStartingId === selectedTask.id}
              conversationStartLabel={
                conversationStartingId === selectedTask.id
                  ? conversationStartStage === "creating_conversation"
                    ? "正在新建对话"
                    : "正在发送任务"
                  : undefined
              }
              onArrange={() => void arrangeTask(selectedTask)}
              arranging={arrangingId === selectedTask.id}
              arrangementLabel={arrangingId === selectedTask.id && arrangementStage ? ARRANGEMENT_LABELS[arrangementStage] : undefined}
            />
          ) : (
            <div className="task-inspector-empty">
              <ArrowUpRight size={25} />
              <span>选择一条任务查看完整上下文</span>
            </div>
          )}
        </aside>
      </div>

      {editorTask && (
        <TaskEditor
          task={editorTask === "new" ? null : editorTask}
          projects={projects}
          initialProject={editorTask === "new" ? projectFilterValue(projectFilter) : undefined}
          initialGroup={editorTask === "new" ? groupFilterValue(groupFilter) : undefined}
          onManageProjects={() => openProjectEditor(editorTask === "new" ? projectFilterValue(projectFilter) : editorTask.project)}
          onClose={() => setEditorTask(null)}
          onSaved={handleSaved}
        />
      )}

      {projectEditorOpen && (
        <ProjectEditor
          projects={projects}
          initialProjectName={projectEditorInitial}
          onClose={() => setProjectEditorOpen(false)}
          onSaved={handleProjectSaved}
        />
      )}

      {terminalPanelTask && (
        <TaskTerminalPanel
          task={terminalPanelTask}
          linkedSessions={terminalsByTask.get(terminalPanelTask.id) ?? []}
          userName={userName}
          onClose={() => setTerminalPanelTarget(null)}
          onUnauthorized={onUnauthorized}
          onSessionsLoaded={handleTerminalSessionsLoaded}
        />
      )}

      {conversationTarget && (
        <TaskConversationPanel
          task={tasks.find((task) => task.id === conversationTarget.id) ?? conversationTarget}
          initialError={conversationInitialError}
          launch={conversationLaunch?.taskId === conversationTarget.id ? conversationLaunch : undefined}
          onLaunchConsumed={consumeConversationLaunch}
          onClose={() => {
            setConversationTarget(null);
            setConversationInitialError("");
          }}
          onTerminal={() => {
            setTerminalPanelTarget(conversationTarget);
            setConversationTarget(null);
            setConversationInitialError("");
          }}
        />
      )}

      {conversationSettingsTarget && (
        <TaskConversationDefaultsDialog
          taskId={conversationSettingsTarget.id}
          taskLabel={`${conversationSettingsTarget.key} · ${conversationSettingsTarget.title}`}
          onClose={() => setConversationSettingsTarget(null)}
        />
      )}

      {deleteTarget && (
        <TaskDeleteDialog
          task={deleteTarget}
          deleting={savingId === deleteTarget.id}
          linkedTerminalCount={terminalsByTask.get(deleteTarget.id)?.length ?? 0}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void deleteTask(deleteTarget)}
        />
      )}
    </section>
  );
}

function TaskRow({
  task,
  selected,
  saving,
  onSelect,
  onEdit,
  onUpdate,
  projects,
  groups,
  tagSummaries,
  terminalSessions,
  terminalStatuses,
  onTerminals,
  onConversation,
  onSettings,
  onArrange,
  arranging,
  arrangementLabel
}: {
  task: TaskItem;
  selected: boolean;
  saving: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onUpdate: (patch: UpdateTaskInput) => void;
  projects: TaskProjectSummary[];
  groups: TaskGroupSummary[];
  tagSummaries: TaskTagSummary[];
  terminalSessions: TerminalSession[];
  terminalStatuses: CodexSessionStatus[];
  onTerminals: () => void;
  onConversation: () => void;
  onSettings: () => void;
  onArrange: () => void;
  arranging: boolean;
  arrangementLabel?: string;
}) {
  const codexSummary = summarizeCodexStatuses(terminalStatuses);
  return (
    <article
      className={`task-table-row priority-${task.priority.toLowerCase()} ${selected ? "selected" : ""}`}
      onClick={onSelect}
      onDoubleClick={onEdit}
    >
      <div className="task-row-title">
        <code>{task.key}</code>
        <div className="task-row-copy">
          <strong>{task.title}</strong>
          <span>{taskSummary(task)}</span>
        </div>
        <div className="task-row-signals" onDoubleClick={(event) => event.stopPropagation()}>
          {task.attachments.length > 0 && (
            <small title={`${task.attachments.length} 张截图`}>
              <ImageIcon size={13} /> {task.attachments.length}
            </small>
          )}
          {terminalSessions.length > 0 && (
            <button
              className={`task-row-terminal state-${codexSummary.state}`}
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onTerminals();
              }}
              title={`查看处理 ${task.key} 的 Terminal`}
            >
              <span className={codexSummary.state === "working" ? "task-terminal-orbit active" : "task-terminal-orbit"}><i /></span>
              {codexSummary.label}
            </button>
          )}
          <button
            className="task-row-arrange"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onConversation();
            }}
            title="直接打开 Task Codex 对话"
          >
            <Sparkles size={12} />
            Codex 对话
          </button>
          <button
            className="task-row-settings"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onSettings();
            }}
            title={`设置 ${task.key} 的默认模型、推理强度和权限`}
            aria-label={`${task.key} Codex 默认设置`}
          >
            <Settings2 size={12} />
            默认设置
          </button>
        </div>
      </div>
      <select
        className={task.project ? "task-inline-select task-project-select" : "task-inline-select task-project-select unassigned"}
        value={task.project}
        disabled={saving}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onChange={(event) => onUpdate({ project: event.target.value })}
        aria-label={`${task.key} 项目`}
      >
        <option value="">未归属</option>
        {projects.map((project) => (
          <option key={project.name} value={project.name}>
            {project.name}
          </option>
        ))}
      </select>
      <TaskGroupInlineInput task={task} groups={groups} disabled={saving} onUpdate={onUpdate} />
      <TaskTagsInlineInput
        task={task}
        tags={tagSummaries}
        disabled={saving}
        onUpdate={onUpdate}
      />
      <select
        className={`task-inline-select task-status-select status-${task.status}`}
        value={task.status}
        disabled={saving}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onChange={(event) => onUpdate({ status: event.target.value as TaskStatus })}
        aria-label={`${task.key} 处理进度`}
      >
        {TASK_STATUSES.map((status) => (
          <option key={status} value={status}>
            {STATUS_LABELS[status]}
          </option>
        ))}
      </select>
      <select
        className={`task-inline-select task-priority-select priority-${task.priority.toLowerCase()}`}
        value={task.priority}
        disabled={saving}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onChange={(event) => onUpdate({ priority: event.target.value as TaskPriority })}
        aria-label={`${task.key} 优先级`}
      >
        {TASK_PRIORITIES.map((priority) => (
          <option key={priority} value={priority}>
            {priority}
          </option>
        ))}
      </select>
      <select
        className={`task-inline-select task-difficulty-select difficulty-d${task.difficulty}`}
        value={task.difficulty}
        disabled={saving}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onChange={(event) => onUpdate({ difficulty: Number(event.target.value) as TaskDifficulty })}
        aria-label={`${task.key} 难度`}
      >
        {[1, 2, 3, 4, 5].map((difficulty) => (
          <option key={difficulty} value={difficulty}>
            D{difficulty}
          </option>
        ))}
      </select>
      <time className="task-created-time" dateTime={task.createdAt}>{formatTaskDate(task.createdAt)}</time>
      <time dateTime={task.updatedAt}>{formatTaskDate(task.updatedAt)}</time>
    </article>
  );
}

function TaskTagsInlineInput({
  task,
  tags,
  disabled,
  onUpdate
}: {
  task: TaskItem;
  tags: TaskTagSummary[];
  disabled: boolean;
  onUpdate: (patch: UpdateTaskInput) => void;
}) {
  const [value, setValue] = useState(() => task.tags.join(", "));
  const [editing, setEditing] = useState(false);
  const listId = `task-tag-options-${task.id}`;
  const options = useMemo(() => {
    const values = new Map<string, string>();
    [...task.tags, ...tags.map((tag) => tag.name)].forEach((tag) => {
      const normalized = tag.trim();
      if (normalized && !values.has(normalized.toLocaleLowerCase())) {
        values.set(normalized.toLocaleLowerCase(), normalized);
      }
    });
    return Array.from(values.values());
  }, [tags, task.tags]);

  useEffect(() => {
    if (!editing) {
      setValue(task.tags.join(", "));
    }
  }, [editing, task.tags]);

  const commit = () => {
    const next = normalizeInlineTags(value);
    setValue(next.join(", "));
    if (!sameTags(next, task.tags)) {
      onUpdate({ tags: next });
    }
  };

  return (
    <div
      className="task-inline-tags"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Tags size={13} aria-hidden="true" />
      <input
        list={listId}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false);
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === "Escape") {
            setValue(task.tags.join(", "));
            event.currentTarget.blur();
          }
        }}
        placeholder="添加标签"
        aria-label={`${task.key} 标签，使用逗号分隔`}
        title="从建议中选择，或输入标签后按 Enter 保存"
      />
      <datalist id={listId}>
        {options.map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
    </div>
  );
}

function TaskGroupInlineInput({
  task,
  groups,
  disabled,
  onUpdate
}: {
  task: TaskItem;
  groups: TaskGroupSummary[];
  disabled: boolean;
  onUpdate: (patch: UpdateTaskInput) => void;
}) {
  const [value, setValue] = useState(task.group);
  const [editing, setEditing] = useState(false);
  const listId = `task-group-options-${task.id}`;
  const options = useMemo(() => {
    const values = new Map<string, string>();
    [task.group, ...groups.map((group) => group.name)].forEach((group) => {
      const normalized = normalizeInlineGroup(group);
      if (normalized && !values.has(normalized.toLocaleLowerCase())) {
        values.set(normalized.toLocaleLowerCase(), normalized);
      }
    });
    return Array.from(values.values());
  }, [groups, task.group]);

  useEffect(() => {
    if (!editing) {
      setValue(task.group);
    }
  }, [editing, task.group]);

  const commit = () => {
    const next = normalizeInlineGroup(value);
    setValue(next);
    if (next.toLocaleLowerCase() !== task.group.toLocaleLowerCase()) {
      onUpdate({ group: next });
    }
  };

  return (
    <div
      className={task.group ? "task-inline-group" : "task-inline-group unassigned"}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Layers3 size={13} aria-hidden="true" />
      <input
        list={listId}
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false);
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
        placeholder="添加分组"
        aria-label={`${task.key} 分组`}
        title="从建议中选择，或输入新分组后按 Enter 保存"
      />
      <datalist id={listId}>
        {options.map((group) => (
          <option key={group} value={group} />
        ))}
      </datalist>
    </div>
  );
}

function normalizeInlineTags(value: string): string[] {
  const unique = new Map<string, string>();
  value.split(",").forEach((tag) => {
    const normalized = tag.replace(/\s+/g, " ").trim().slice(0, 40);
    if (normalized && !unique.has(normalized.toLocaleLowerCase())) {
      unique.set(normalized.toLocaleLowerCase(), normalized);
    }
  });
  return Array.from(unique.values()).slice(0, 12);
}

function normalizeInlineGroup(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 80);
}

function sameTags(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((tag, index) => tag.toLocaleLowerCase() === right[index]?.toLocaleLowerCase());
}

function TaskInspector({
  task,
  saving,
  onEdit,
  onArchive,
  onDelete,
  onUpdate,
  terminalSessions,
  terminalStatuses,
  onTerminals,
  onConversation,
  onSettings,
  onStartConversation,
  onArrange,
  arranging,
  arrangementLabel,
  conversationStarting,
  conversationStartLabel
}: {
  task: TaskItem;
  saving: boolean;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onUpdate: (patch: UpdateTaskInput) => void;
  terminalSessions: TerminalSession[];
  terminalStatuses: CodexSessionStatus[];
  onTerminals: () => void;
  onConversation: () => void;
  onSettings: () => void;
  onStartConversation: () => void;
  onArrange: () => void;
  arranging: boolean;
  arrangementLabel?: string;
  conversationStarting: boolean;
  conversationStartLabel?: string;
}) {
  const codexSummary = summarizeCodexStatuses(terminalStatuses);
  return (
    <div className="task-inspector-content">
      <header className="task-inspector-header">
        <div>
          <span className={`task-status-badge status-${task.status}`}>{STATUS_LABELS[task.status]}</span>
          <code>{task.key}</code>
        </div>
        <div className="task-inspector-actions">
          <button className="task-icon-button task-terminal-action" type="button" onClick={onTerminals} title="查看或分配 Task Terminal">
            <TerminalSquare size={17} />
            {codexSummary.count > 0 && <i>{codexSummary.count}</i>}
          </button>
          <button className="task-icon-button" type="button" onClick={onEdit} title="编辑任务">
            <Edit3 size={17} />
          </button>
          <button className="task-icon-button" type="button" onClick={onSettings} title="Codex 默认设置" aria-label={`${task.key} Codex 默认设置`}>
            <Settings2 size={17} />
          </button>
          <button className="task-icon-button" type="button" onClick={onArchive} title={task.archived ? "恢复" : "归档"}>
            {task.archived ? <RotateCcw size={17} /> : <Archive size={17} />}
          </button>
          <button
            className="task-icon-button task-delete-action"
            type="button"
            onClick={onDelete}
            title="永久删除任务"
            aria-label={`永久删除 ${task.key}`}
          >
            <Trash2 size={17} />
          </button>
        </div>
      </header>

      <h3>{task.title}</h3>

      <div className="task-inspector-meta">
        <span className={task.project ? "task-project-meta" : "task-project-meta unassigned"}>
          <FolderKanban size={14} /> {task.project || "未归属项目"}
        </span>
        <span className={task.group ? "task-group-meta" : "task-group-meta unassigned"}>
          <Layers3 size={14} /> {task.group || "未分组"}
        </span>
        <span className={`priority-${task.priority.toLowerCase()}`}>{task.priority}</span>
        <span className={`difficulty-d${task.difficulty}`}>难度 D{task.difficulty}</span>
        <span>
          <CalendarClock size={14} /> {formatTaskDate(task.createdAt)} 创建
        </span>
      </div>

      {task.tags.length > 0 && (
        <div className="task-inspector-tags">
          {task.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      )}

      <section className="task-stage-control">
        <header>
          <span>处理进度</span>
          <strong className={`status-${task.status}`}>{STATUS_LABELS[task.status]}</strong>
        </header>
        <div className="task-stage-options">
          {TASK_STATUSES.map((status) => (
            <button
              className={`status-${status} ${status === task.status ? "active" : ""}`}
              type="button"
              key={status}
              disabled={saving || status === task.status}
              onClick={() => onUpdate({ status })}
            >
              <i />
              {STATUS_LABELS[status]}
            </button>
          ))}
        </div>
      </section>

      {task.repositoryPath && (
        <div className="task-repository-line" title={task.repositoryPath}>
          <FolderGit2 size={16} />
          <code>{task.repositoryPath}</code>
        </div>
      )}

      {task.latestReport && (
        <section className={`task-report-card report-${task.latestReport.status}`}>
          <header>
            <span>
              <TimerReset size={15} /> 最近汇报
            </span>
            <time dateTime={task.latestReport.createdAt}>{formatTaskDate(task.latestReport.createdAt)}</time>
          </header>
          <div className="task-report-heading">
            <b>{REPORT_STATUS_LABELS[task.latestReport.status]}</b>
            <strong>{task.latestReport.summary}</strong>
          </div>
          {(task.latestReport.changedFiles.length > 0 || task.latestReport.verification.length > 0) && (
            <div className="task-report-evidence">
              {task.latestReport.changedFiles.length > 0 && (
                <span>{task.latestReport.changedFiles.length} 个改动文件</span>
              )}
              {task.latestReport.verification.length > 0 && (
                <span>
                  {task.latestReport.verification.filter((item) => item.result === "passed").length}/
                  {task.latestReport.verification.length} 项验证通过
                </span>
              )}
            </div>
          )}
          {task.latestReport.blockers.length > 0 && (
            <p className="task-report-blocker">阻塞：{task.latestReport.blockers.join("；")}</p>
          )}
          {task.latestReport.nextStep && <footer>下一步：{task.latestReport.nextStep}</footer>}
        </section>
      )}

      <section className="task-inspector-section">
        <h4>任务描述</h4>
        <MarkdownContent source={task.descriptionMd} />
      </section>

      <section className="task-inspector-section">
        <h4>验收标准</h4>
        <MarkdownContent source={task.acceptanceCriteriaMd} emptyText="还没有填写验收标准。" />
      </section>

      {task.attachments.length > 0 && (
        <section className="task-inspector-section">
          <h4>任务附件 · {task.attachments.length}</h4>
          <div className="task-attachment-grid">
            {task.attachments.map((attachment) => (
              <a href={attachment.previewUrl??attachment.url} target="_blank" rel="noreferrer" key={attachment.id} title={attachment.name}>
                {attachment.mimeType.startsWith("image/") && <img src={attachment.url} alt={attachment.name} />}
                <span>{attachment.source==="feedback"?"AI 反馈材料":"用户输入附件"} · {attachment.name}</span>
              </a>
            ))}
          </div>
        </section>
      )}

      <button
        className="task-auto-arrange task-conversation-start"
        type="button"
        onClick={onStartConversation}
        disabled={conversationStarting || arranging}
      >
        <div className="task-auto-arrange-icon">
          {conversationStarting ? <RefreshCw className="spin" size={20} /> : <Sparkles size={20} />}
        </div>
        <div>
          <span>Task Codex</span>
          <strong>{conversationStartLabel || "新建对话并开始任务"}</strong>
          <small>创建新的任务对话并立即发送执行指令；使用此 Task 保存的默认推理和权限。</small>
        </div>
        <ArrowUpRight size={17} />
      </button>

      <button
        className="task-auto-arrange task-conversation-launch"
        type="button"
        onClick={onConversation}
        disabled={conversationStarting}
      >
        <div className="task-auto-arrange-icon">
          <Sparkles size={20} />
        </div>
        <div>
          <span>Codex 对话</span>
          <strong>打开任务会话工作台</strong>
          <small>直接加载历史、发送与中断任务，不创建 Terminal；工作目录固定为 Task 上下文。</small>
        </div>
        <ArrowUpRight size={17} />
      </button>

      <button className="task-secondary-arrange" type="button" onClick={onArrange} disabled={arranging || conversationStarting}>
        {arranging ? <RefreshCw className="spin" size={16} /> : <TerminalSquare size={16} />}
        {arrangementLabel || "使用高级 Terminal 执行"}
      </button>

      <button className={`task-launch-foundation state-${codexSummary.state}`} type="button" onClick={onTerminals}>
        <div className="task-launch-icon">
          {codexSummary.state === "working" ? (
            <span className="task-terminal-orbit active"><i /></span>
          ) : (
            <TerminalSquare size={20} />
          )}
        </div>
        <div>
          <span>执行终端</span>
          <strong>
            {terminalSessions.length > 0 ? codexSummary.label : "创建或关联 Terminal"}
          </strong>
          <small>{codexSummary.detail || `查看 Codex 对话、发布指令或进入 Terminal；并发上限 ${task.maxConcurrency}。`}</small>
        </div>
        <Sparkles size={17} />
      </button>
    </div>
  );
}

function TaskDeleteDialog({
  task,
  deleting,
  linkedTerminalCount,
  onCancel,
  onConfirm
}: {
  task: TaskItem;
  deleting: boolean;
  linkedTerminalCount: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !deleting) {
        onCancel();
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [deleting, onCancel]);

  return (
    <div
      className="task-delete-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !deleting) {
          onCancel();
        }
      }}
    >
      <section className="task-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="task-delete-title">
        <header>
          <span className="task-delete-mark"><Trash2 size={20} /></span>
          <div>
            <small>永久操作 · {task.key}</small>
            <h3 id="task-delete-title">删除“{task.title}”？</h3>
          </div>
          <button type="button" className="task-icon-button" onClick={onCancel} disabled={deleting} aria-label="关闭">
            <X size={17} />
          </button>
        </header>
        <div className="task-delete-copy">
          <p>任务记录、{task.attachments.length} 个附件和全部 Codex 进度汇报将被永久删除，无法恢复。</p>
          {linkedTerminalCount > 0 && (
            <p className="terminal-safe">关联的 {linkedTerminalCount} 个 Terminal 会保留运行，只解除任务归属；不会停止或删除 Zellij 会话。</p>
          )}
        </div>
        <footer>
          <button className="task-secondary-button" type="button" onClick={onCancel} disabled={deleting}>取消</button>
          <button
            className="task-delete-confirm"
            type="button"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? <RefreshCw className="spin" size={16} /> : <Trash2 size={16} />}
            {deleting ? "正在删除" : "永久删除任务"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function summarizeCodexStatuses(statuses: CodexSessionStatus[]): {
  state: CodexSessionState;
  label: string;
  count: number;
  detail?: string;
} {
  const priority: CodexSessionState[] = [
    "needs_confirmation",
    "error",
    "reconnecting",
    "working",
    "completed",
    "ready",
    "not_started"
  ];
  const state = priority.find((candidate) => statuses.some((status) => status.state === candidate)) ?? "not_started";
  const matching = statuses.filter((status) => status.state === state);
  const count = matching.length;
  const label =
    state === "needs_confirmation"
      ? `${count} 个 Codex 需确认`
      : state === "error"
        ? `${count} 个 Codex 异常`
        : state === "reconnecting"
          ? `${count} 个 Codex 重连中`
          : state === "working"
            ? `${count} 个 Codex 正在处理`
            : state === "completed"
              ? `${count} 个 Codex 已完成/待命`
              : state === "ready"
                ? `${count} 个 Codex 已启动`
                : statuses.length > 0
                  ? "Codex 未启动"
                  : "尚未分配 Terminal";
  return { state, label, count, detail: matching.find((status) => status.detail)?.detail };
}

function nextArrangementTerminalName(task: TaskItem, sessions: TerminalSession[]): string {
  const base = `${task.key} · ${task.title}`.slice(0, 72).trim();
  const names = new Set(sessions.map((session) => session.name.toLocaleLowerCase()));
  if (!names.has(base.toLocaleLowerCase())) {
    return base;
  }
  for (let index = 2; index < 100; index += 1) {
    const suffix = ` · ${index}`;
    const candidate = `${base.slice(0, 72 - suffix.length)}${suffix}`;
    if (!names.has(candidate.toLocaleLowerCase())) {
      return candidate;
    }
  }
  return `${task.key} · Codex ${Date.now().toString(36).slice(-4)}`;
}

export function taskArrangementPrompt(task: TaskItem): string {
  return [
    `请使用 $manage-terminal-apron-tasks 读取并处理 ${task.key}。`,
    "先执行 Skill 的 context 和 start 流程，检查任务描述、验收标准、项目目录与全部截图，再开始修改代码。",
    "每个关键里程碑都通过 Skill 汇报；需要我做决定或确认时必须使用 Skill 的 confirm 流程并暂停；完成后提交验证证据并进入待自动验收。"
  ].join("\n");
}

async function waitForCodexSession(sessionId: string): Promise<TerminalSession> {
  const deadline = Date.now() + 45_000;
  let knownSignature = "";
  await waitFor(450);
  while (Date.now() < deadline) {
    const sessions = await api.sessions(false);
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      throw new Error("Task Terminal 已不存在");
    }
    if (isCodexProcessCommand(session.runtime?.currentCommand ?? "")) {
      return session;
    }
    if (session.runtime?.exists) {
      let preview: SessionPreview | null = null;
      try {
        preview = await api.preview(session.id, 180, 80_000, false, false, knownSignature);
      } catch {
        preview = null;
      }
      if (preview && !preview.unchanged) {
        knownSignature = previewSignature(preview);
        const status = detectCodexStatus(session, preview);
        if (status.state === "error") {
          throw new Error(status.detail || "Codex 启动异常，请打开 Terminal 查看输出");
        }
        if (["ready", "working", "completed", "needs_confirmation"].includes(status.state)) {
          return session;
        }
      }
    }
    await waitFor(750);
  }
  throw new Error("Codex 在 45 秒内未进入可对话状态，请打开 Task Terminal 查看启动输出");
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function emptyTerminalPreview(sessionId: string): SessionPreview {
  return {
    sessionId,
    text: "",
    signature: "",
    capturedAt: new Date(0).toISOString()
  };
}

function previewSignature(preview?: SessionPreview): string {
  return preview?.signature || preview?.text || "";
}

function TaskTableSkeleton() {
  return (
    <div className="task-table-skeleton" aria-label="正在加载任务">
      {[0, 1, 2, 3].map((row) => (
        <span key={row} />
      ))}
    </div>
  );
}

function taskSummary(task: TaskItem): string {
  const source = task.descriptionMd || task.acceptanceCriteriaMd;
  const plain = source
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]+]\([^)]*\)/g, " ")
    .replace(/[#>*_`~\-\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return plain || (task.repositoryPath ? task.repositoryPath : "尚未补充任务描述");
}

function projectFilterValue(filter: string): string | undefined {
  if (filter === ALL_PROJECTS_FILTER) {
    return undefined;
  }
  if (filter === UNASSIGNED_PROJECT_FILTER) {
    return "";
  }
  if (filter.startsWith(PROJECT_FILTER_PREFIX)) {
    return decodeURIComponent(filter.slice(PROJECT_FILTER_PREFIX.length));
  }
  return undefined;
}

function projectFilterKey(project: string | undefined): string {
  if (project === undefined) {
    return ALL_PROJECTS_FILTER;
  }
  if (!project) {
    return UNASSIGNED_PROJECT_FILTER;
  }
  return `${PROJECT_FILTER_PREFIX}${encodeURIComponent(project)}`;
}

function groupFilterValue(filter: string): string | undefined {
  if (filter === ALL_GROUPS_FILTER) {
    return undefined;
  }
  if (filter === UNGROUPED_GROUP_FILTER) {
    return "";
  }
  if (filter.startsWith(GROUP_FILTER_PREFIX)) {
    return decodeURIComponent(filter.slice(GROUP_FILTER_PREFIX.length));
  }
  return undefined;
}

function groupFilterKey(group: string | undefined): string {
  if (group === undefined) {
    return ALL_GROUPS_FILTER;
  }
  if (!group) {
    return UNGROUPED_GROUP_FILTER;
  }
  return `${GROUP_FILTER_PREFIX}${encodeURIComponent(group)}`;
}

function formatTaskDate(value: string): string {
  const date = new Date(value);
  const elapsed = Date.now() - date.getTime();
  if (Number.isFinite(elapsed) && elapsed >= 0) {
    if (elapsed < 60_000) {
      return "刚刚";
    }
    if (elapsed < 60 * 60_000) {
      return `${Math.floor(elapsed / 60_000)} 分钟前`;
    }
    if (elapsed < 24 * 60 * 60_000) {
      return `${Math.floor(elapsed / (60 * 60_000))} 小时前`;
    }
    if (elapsed < 7 * 24 * 60 * 60_000) {
      return `${Math.floor(elapsed / (24 * 60 * 60_000))} 天前`;
    }
  }
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}
