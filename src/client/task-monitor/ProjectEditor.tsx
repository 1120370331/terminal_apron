import { FolderGit2, FolderOpen, Loader2, PencilLine, Plus, Save, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { TaskProjectSummary } from "../../shared/taskTypes";
import { taskApi } from "../taskApi";
import { DirectoryPicker } from "./DirectoryPicker";

interface Props {
  projects: TaskProjectSummary[];
  initialProjectName?: string;
  onClose: () => void;
  onSaved: (project: TaskProjectSummary, previousName: string | null) => void;
}

export function ProjectEditor({ projects, initialProjectName, onClose, onSaved }: Props) {
  const initial = useMemo(
    () => projects.find((project) => project.name === initialProjectName) ?? projects[0] ?? null,
    [initialProjectName, projects]
  );
  const [selectedName, setSelectedName] = useState<string | null>(initial?.name ?? null);
  const [creating, setCreating] = useState(projects.length === 0);
  const selected = projects.find((project) => project.name === selectedName) ?? null;
  const [name, setName] = useState(initial?.name ?? "");
  const [rootDirectory, setRootDirectory] = useState(initial?.rootDirectory ?? "");
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!creating && selected) {
      setName(selected.name);
      setRootDirectory(selected.rootDirectory);
      setError("");
    }
  }, [creating, selected?.name, selected?.rootDirectory]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !directoryOpen) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [directoryOpen, onClose]);

  const startCreating = () => {
    setCreating(true);
    setSelectedName(null);
    setName("");
    setRootDirectory("");
    setError("");
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    if (!name.trim()) {
      setError("请填写项目名称");
      return;
    }
    if (!rootDirectory.trim()) {
      setError("请选择项目文件夹根目录");
      return;
    }
    if (!creating && !selected) {
      setError("请选择要编辑的项目");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const saved = creating
        ? await taskApi.createProject({ name, rootDirectory })
        : await taskApi.updateProject(selected!.name, { name, rootDirectory });
      onSaved(saved, creating ? null : selected!.name);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "项目保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="task-project-editor-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="task-project-editor-panel"
        role="dialog"
        aria-modal="true"
        aria-label="项目设置"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="task-project-editor-header">
          <div>
            <span>项目与代码库</span>
            <h2>每个项目对应一个文件夹根目录</h2>
          </div>
          <button className="task-icon-button" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="task-project-editor-body">
          <aside className="task-project-list">
            <button className="task-project-new" type="button" onClick={startCreating}>
              <Plus size={16} />
              新建项目
            </button>
            <div>
              {projects.map((project) => (
                <button
                  className={!creating && project.name === selectedName ? "active" : ""}
                  type="button"
                  key={project.name}
                  onClick={() => {
                    setCreating(false);
                    setSelectedName(project.name);
                  }}
                >
                  <FolderGit2 size={17} />
                  <span>
                    <strong>{project.name}</strong>
                    <small>{project.taskCount} 项任务</small>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section className="task-project-form">
            <div className="task-project-form-title">
              {creating ? <Plus size={18} /> : <PencilLine size={18} />}
              <span>
                <strong>{creating ? "新建项目" : "编辑项目"}</strong>
                <small>任务选择项目后，会自动使用这里的代码库目录。</small>
              </span>
            </div>

            <label className="task-field">
              <span>项目名称</span>
              <input
                autoFocus
                maxLength={160}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：Terminal Apron"
              />
            </label>

            <label className="task-field">
              <span>文件夹根目录</span>
              <div className="task-root-directory-input">
                <FolderGit2 size={16} />
                <input
                  value={rootDirectory}
                  onChange={(event) => setRootDirectory(event.target.value)}
                  placeholder="选择项目代码库所在文件夹"
                  spellCheck={false}
                />
                <button type="button" onClick={() => setDirectoryOpen(true)}>
                  <FolderOpen size={15} />
                  选择
                </button>
              </div>
              <small>保存时会校验该目录确实存在，并且当前服务有权访问。</small>
            </label>

            {error && <div className="task-project-editor-error">{error}</div>}
          </section>
        </div>

        <footer className="task-project-editor-footer">
          <span>{creating ? "创建后会立即选中这个项目" : "重命名会同步更新已有任务归属"}</span>
          <div>
            <button className="task-secondary-button" type="button" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button className="task-primary-button" type="submit" disabled={busy || (!creating && !selected)}>
              {busy ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
              {busy ? "保存中" : "保存项目"}
            </button>
          </div>
        </footer>
      </form>

      {directoryOpen && (
        <DirectoryPicker
          initialPath={rootDirectory}
          onClose={() => setDirectoryOpen(false)}
          onSelect={(selectedPath) => {
            setRootDirectory(selectedPath);
            setDirectoryOpen(false);
          }}
        />
      )}
    </div>
  );
}
