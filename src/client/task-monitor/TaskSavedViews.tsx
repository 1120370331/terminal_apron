import { useEffect, useState } from "react";
import {
  normalizeTaskSearchFilters,
  type SavedTaskView,
  type TaskSearchFilters
} from "./taskSearchFilters";

const STORAGE_KEY = "terminal-apron.task-monitor.saved-views.v1";

interface Props {
  filters: TaskSearchFilters;
  onApply: (filters: TaskSearchFilters) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSavedTaskView(value: unknown): SavedTaskView | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  const updatedAt = typeof value.updatedAt === "string" ? value.updatedAt : "";

  if (!id || !name || !createdAt || !updatedAt || !isRecord(value.filters)) {
    return null;
  }

  return {
    id,
    name,
    filters: normalizeTaskSearchFilters(value.filters),
    createdAt,
    updatedAt
  };
}

function loadSavedTaskViews(): SavedTaskView[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    const seenIds = new Set<string>();
    return parsed.reduce<SavedTaskView[]>((views, value) => {
      const view = normalizeSavedTaskView(value);
      if (!view || seenIds.has(view.id)) {
        return views;
      }
      seenIds.add(view.id);
      views.push(view);
      return views;
    }, []);
  } catch {
    return [];
  }
}

function createSavedViewId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function TaskSavedViews({ filters, onApply }: Props) {
  const [views, setViews] = useState<SavedTaskView[]>(loadSavedTaskViews);
  const [name, setName] = useState("");
  const [selectedViewId, setSelectedViewId] = useState("");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
    } catch {
      // Local persistence is optional; the current session remains usable.
    }
  }, [views]);

  const saveCurrentView = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      return;
    }

    const timestamp = new Date().toISOString();
    const view: SavedTaskView = {
      id: createSavedViewId(),
      name: trimmedName,
      filters: normalizeTaskSearchFilters(filters),
      createdAt: timestamp,
      updatedAt: timestamp
    };

    setViews((current) => [...current, view]);
    setSelectedViewId(view.id);
    setName("");
  };

  const applySelectedView = (viewId: string) => {
    setSelectedViewId(viewId);
    const view = views.find((candidate) => candidate.id === viewId);
    if (view) {
      onApply(normalizeTaskSearchFilters(view.filters));
    }
  };

  const deleteSelectedView = () => {
    if (!selectedViewId) {
      return;
    }

    setViews((current) => current.filter((view) => view.id !== selectedViewId));
    setSelectedViewId("");
  };

  return (
    <div className="task-saved-views" aria-label="已保存的检索视图">
      <label className="task-saved-views-name">
        <span>视图</span>
        <input
          type="text"
          value={name}
          maxLength={80}
          placeholder="命名当前检索"
          aria-label="保存视图名称"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              saveCurrentView();
            }
          }}
        />
      </label>
      <button
        className="task-secondary-button task-saved-views-save"
        type="button"
        disabled={!name.trim()}
        onClick={saveCurrentView}
      >
        保存
      </button>
      <label className="task-saved-views-picker">
        <span className="task-saved-views-sr-only">选择已保存视图</span>
        <select
          value={selectedViewId}
          aria-label="选择已保存视图"
          disabled={views.length === 0}
          onChange={(event) => applySelectedView(event.target.value)}
        >
          <option value="">{views.length ? "应用已保存视图" : "暂无保存视图"}</option>
          {views.map((view) => (
            <option key={view.id} value={view.id}>
              {view.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className="task-secondary-button task-saved-views-delete"
        type="button"
        disabled={!selectedViewId}
        aria-label="删除选中的已保存视图"
        onClick={deleteSelectedView}
      >
        删除
      </button>
    </div>
  );
}
