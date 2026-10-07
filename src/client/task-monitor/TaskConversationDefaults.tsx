import { Check, LoaderCircle, Settings2, Shield, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  TASK_PERMISSION_PRESETS,
  TASK_REASONING_EFFORTS,
  type TaskConversationModel,
  type TaskConversationPreferences,
  type TaskPermissionPreset,
  type TaskReasoningEffort
} from "../../shared/taskConversationTypes";
import { TaskConversationApiError, taskConversationApi } from "../taskConversationApi";

const EFFORT_LABELS: Record<TaskReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high"
};

const PERMISSION_LABELS: Record<TaskPermissionPreset, string> = {
  read_only: "只读",
  workspace_write: "工作区写入",
  full_access: "完全访问"
};

interface DefaultsProps {
  taskId: string;
  taskLabel: string;
  variant?: "inline" | "dialog";
  onClose?: () => void;
}

export function TaskConversationDefaults({ taskId, taskLabel, variant = "inline", onClose }: DefaultsProps) {
  const [models, setModels] = useState<TaskConversationModel[]>([]);
  const [saved, setSaved] = useState<TaskConversationPreferences>();
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<TaskReasoningEffort>("medium");
  const [permission, setPermission] = useState<TaskPermissionPreset>("read_only");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedNotice, setSavedNotice] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [modelResult, preferences] = await Promise.all([
        taskConversationApi.models(taskId),
        taskConversationApi.preferences(taskId)
      ]);
      setModels(modelResult.models);
      setSaved(preferences);
      setDefaultModel(preferences.defaultModel);
      setEffort(preferences.defaultReasoningEffort);
      setPermission(preferences.defaultPermissionPreset);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Codex 默认设置加载失败");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { void load(); }, [load]);

  const selectedModel = useMemo(
    () => defaultModel === null ? models.find((model) => model.isDefault) : models.find((model) => model.id === defaultModel),
    [defaultModel, models]
  );
  const unavailableModel = defaultModel !== null && !selectedModel;
  const supportedEfforts = selectedModel?.efforts.length ? new Set(selectedModel.efforts) : null;
  const incompatibleEffort = Boolean(supportedEfforts && !supportedEfforts.has(effort));
  const dirty = Boolean(saved && (
    saved.defaultModel !== defaultModel
    || saved.defaultReasoningEffort !== effort
    || saved.defaultPermissionPreset !== permission
  ));

  const changeModel = (value: string) => {
    const nextModel = value || null;
    const model = nextModel === null ? models.find((entry) => entry.isDefault) : models.find((entry) => entry.id === nextModel);
    setDefaultModel(nextModel);
    if (model?.efforts.length && !model.efforts.includes(effort)) {
      setEffort(model.defaultEffort && model.efforts.includes(model.defaultEffort) ? model.defaultEffort : model.efforts[0]);
    }
    setSavedNotice(false);
  };

  const save = async () => {
    if (!saved || unavailableModel || incompatibleEffort || !dirty) return;
    if (permission === "full_access" && !window.confirm("将“完全访问”保存为这个任务的默认权限？Codex 后续可在没有文件系统沙箱的情况下执行命令和修改文件，但仍会按需请求审批。")) return;
    setSaving(true);
    setError("");
    setSavedNotice(false);
    try {
      const updated = await taskConversationApi.updatePreferences(taskId, {
        defaultModel,
        defaultReasoningEffort: effort,
        defaultPermissionPreset: permission,
        revision: saved.revision,
        ...(permission === "full_access" ? { fullAccessConfirmed: true as const } : {})
      });
      setSaved(updated);
      setDefaultModel(updated.defaultModel);
      setEffort(updated.defaultReasoningEffort);
      setPermission(updated.defaultPermissionPreset);
      setSavedNotice(true);
    } catch (saveError) {
      if (saveError instanceof TaskConversationApiError && saveError.status === 409) await load();
      setError(saveError instanceof Error ? saveError.message : "Codex 默认设置保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`task-defaults task-defaults-${variant}`} aria-label={`${taskLabel} Codex 默认设置`}>
      {variant === "dialog" && (
        <header>
          <span className="task-defaults-mark"><Settings2 size={19} /></span>
          <div><small>Task Codex</small><h3>{taskLabel} · 默认设置</h3></div>
          <button type="button" className="task-icon-button" onClick={onClose} aria-label="关闭默认设置"><X size={17} /></button>
        </header>
      )}

      {loading ? (
        <div className="task-defaults-loading"><LoaderCircle className="spin" size={18} />正在读取 Codex 模型和任务默认值…</div>
      ) : error && !saved ? (
        <div className="task-defaults-load-error"><span>{error}</span><button type="button" onClick={() => void load()}>重试</button></div>
      ) : (
        <div className="task-defaults-body">
          <label>
            <span>默认模型</span>
            <select value={defaultModel ?? ""} onChange={(event) => changeModel(event.target.value)} disabled={saving}>
              <option value="">Codex 默认模型</option>
              {unavailableModel && <option value={defaultModel ?? ""}>{defaultModel}（当前不可用）</option>}
              {models.map((model) => <option value={model.id} key={model.id}>{model.displayName}{model.isDefault ? " · 默认" : ""}</option>)}
            </select>
            <small>模型列表来自当前 Codex；不会写入全局配置。</small>
          </label>

          <label>
            <span>默认推理强度</span>
            <select value={effort} onChange={(event) => { setEffort(event.target.value as TaskReasoningEffort); setSavedNotice(false); }} disabled={saving || unavailableModel}>
              {TASK_REASONING_EFFORTS.map((value) => (
                <option value={value} key={value} disabled={Boolean(supportedEfforts && !supportedEfforts.has(value))}>
                  {EFFORT_LABELS[value]}{supportedEfforts && !supportedEfforts.has(value) ? " · 模型不支持" : ""}
                </option>
              ))}
            </select>
            <small>{selectedModel?.efforts.length ? `已按 ${selectedModel.displayName} 的能力限制选项。` : "模型未声明限制，可使用全部推理强度。"}</small>
          </label>

          <label className={`permission-${permission}`}>
            <span><Shield size={13} />默认权限</span>
            <select value={permission} onChange={(event) => { setPermission(event.target.value as TaskPermissionPreset); setSavedNotice(false); }} disabled={saving || unavailableModel}>
              {TASK_PERMISSION_PRESETS.map((value) => <option value={value} key={value}>{PERMISSION_LABELS[value]}</option>)}
            </select>
            <small>{permission === "full_access" ? "完全访问会在保存前再次确认。" : "后续新回合使用此权限；活动回合不受影响。"}</small>
          </label>

          {unavailableModel && <p className="task-defaults-warning">已保存模型当前不可用。请选择 Codex 默认模型或一个可用模型后再保存。</p>}
          {incompatibleEffort && <p className="task-defaults-warning">当前模型不支持已保存的推理强度，请选择可用强度。</p>}
          {permission === "full_access" && <p className="task-defaults-danger"><Shield size={14} />完全访问允许 Codex 在无文件系统沙箱下运行；审批仍为按需确认。</p>}
          {error && saved && <p className="task-defaults-warning">{error}</p>}

          <footer>
            {savedNotice && <span className="task-defaults-saved"><Check size={14} />已保存到此 Task</span>}
            {variant === "dialog" && <button type="button" className="task-secondary-button" onClick={onClose}>取消</button>}
            <button type="button" className="task-defaults-save" onClick={() => void save()} disabled={!dirty || saving || unavailableModel || incompatibleEffort}>
              {saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
              {saving ? "正在保存" : "保存默认设置"}
            </button>
          </footer>
        </div>
      )}
    </section>
  );
}

export function TaskConversationDefaultsDialog({ taskId, taskLabel, onClose }: Omit<DefaultsProps, "variant">) {
  return (
    <div className="task-defaults-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div role="dialog" aria-modal="true" aria-label={`${taskLabel} Codex 默认设置`}>
        <TaskConversationDefaults taskId={taskId} taskLabel={taskLabel} variant="dialog" onClose={onClose} />
      </div>
    </div>
  );
}
