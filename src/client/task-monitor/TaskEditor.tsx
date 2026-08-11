import {
  Bold,
  CalendarClock,
  Code2,
  Eye,
  FolderKanban,
  FolderCog,
  ImagePlus,
  Italic,
  Link,
  ListChecks,
  Loader2,
  Paperclip,
  PencilLine,
  Save,
  Trash2,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type FormEvent } from "react";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type CreateTaskInput,
  type TaskDifficulty,
  type TaskItem,
  type TaskPriority,
  type TaskProjectSummary,
  type TaskStatus
} from "../../shared/taskTypes";
import { taskApi } from "../taskApi";
import { MarkdownContent } from "./MarkdownContent";

interface Props {
  task: TaskItem | null;
  projects: TaskProjectSummary[];
  initialProject?: string;
  onManageProjects: () => void;
  onClose: () => void;
  onSaved: (task: TaskItem, options?: { close?: boolean }) => void;
}

interface PendingImage {
  id: string;
  file: File;
  previewUrl: string;
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  not_started: "未开始",
  in_progress: "进行中",
  pending_auto_acceptance: "待自动验收",
  pending_manual_acceptance: "待人工验收",
  done: "已完成",
  blocked: "阻塞"
};

export function TaskEditor({ task, projects, initialProject, onManageProjects, onClose, onSaved }: Props) {
  const initialProjectRecord = projects.find((item) => item.name === (task?.project || initialProject));
  const [title, setTitle] = useState(task?.title ?? "");
  const [project, setProject] = useState(task?.project ?? initialProjectRecord?.name ?? "");
  const [descriptionMd, setDescriptionMd] = useState(task?.descriptionMd ?? "");
  const [acceptanceCriteriaMd, setAcceptanceCriteriaMd] = useState(task?.acceptanceCriteriaMd ?? "");
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? "not_started");
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? "P2");
  const [difficulty, setDifficulty] = useState<TaskDifficulty>(task?.difficulty ?? 3);
  const [tags, setTags] = useState(task?.tags.join(", ") ?? "");
  const [repositoryPath, setRepositoryPath] = useState(
    task?.repositoryPath ?? initialProjectRecord?.rootDirectory ?? ""
  );
  const [maxConcurrency, setMaxConcurrency] = useState(task?.maxConcurrency ?? 1);
  const [createdAt, setCreatedAt] = useState(toLocalDateTimeInput(task?.createdAt ?? new Date().toISOString()));
  const [editorMode, setEditorMode] = useState<"write" | "preview">("write");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingImagesRef = useRef<PendingImage[]>([]);

  useEffect(() => {
    pendingImagesRef.current = pendingImages;
  }, [pendingImages]);

  useEffect(
    () => () => pendingImagesRef.current.forEach((image) => URL.revokeObjectURL(image.previewUrl)),
    []
  );

  useEffect(() => {
    if (task || !initialProject) {
      return;
    }
    const selectedProject = projects.find((item) => item.name === initialProject);
    if (selectedProject) {
      setProject(selectedProject.name);
      setRepositoryPath(selectedProject.rootDirectory);
    }
  }, [initialProject]);

  const taskInput = useMemo<CreateTaskInput>(
    () => ({
      title,
      project,
      descriptionMd,
      acceptanceCriteriaMd,
      status,
      priority,
      difficulty,
      tags: tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      repositoryPath,
      maxConcurrency,
      createdAt
    }),
    [
      acceptanceCriteriaMd,
      createdAt,
      descriptionMd,
      difficulty,
      maxConcurrency,
      priority,
      project,
      repositoryPath,
      status,
      tags,
      title
    ]
  );

  const previewDescription = useMemo(
    () =>
      pendingImages.reduce(
        (source, image) => source.replaceAll(`task-image:${image.id}`, image.previewUrl),
        descriptionMd
      ),
    [descriptionMd, pendingImages]
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    if (!title.trim()) {
      setError("请填写任务名称");
      return;
    }
    setBusy(true);
    setError("");
    try {
      let saved = task
        ? await taskApi.update(task.id, { ...taskInput, revision: task.revision })
        : await taskApi.create(taskInput);
      if (pendingImages.length > 0) {
        const uploaded = await taskApi.uploadAttachments(saved.id, pendingImages.map((image) => image.file));
        saved = uploaded.task;
        if (uploaded.attachments.length !== pendingImages.length) {
          throw new Error("部分截图未成功上传，请重新打开任务检查附件");
        }
        const embeddedDescription = pendingImages.reduce(
          (source, image, index) =>
            source.replaceAll(`task-image:${image.id}`, uploaded.attachments[index].url),
          descriptionMd
        );
        if (embeddedDescription !== saved.descriptionMd) {
          saved = await taskApi.update(saved.id, {
            descriptionMd: embeddedDescription,
            revision: saved.revision
          });
        }
      }
      onSaved(saved, { close: true });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "任务保存失败");
    } finally {
      setBusy(false);
    }
  };

  const addImages = (files: File[]) => {
    setError("");
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length !== files.length) {
      setError("这里只接收 PNG、JPEG、WebP 或 GIF 截图");
    }
    const valid = images.filter((file) => {
      if (file.size > 10 * 1024 * 1024) {
        setError(`${file.name || "截图"} 超过 10 MB`);
        return false;
      }
      return true;
    });
    const remaining = Math.max(0, 8 - pendingImages.length);
    const added = valid.slice(0, remaining).map((file) => ({
      id: crypto.randomUUID(),
      file,
      previewUrl: URL.createObjectURL(file)
    }));
    if (valid.length > remaining) {
      setError("每次最多添加 8 张截图");
    }
    if (added.length === 0) {
      return;
    }
    setPendingImages((current) => [...current, ...added]);
    insertImagesIntoDescription(added);
  };

  const insertImagesIntoDescription = (images: PendingImage[]) => {
    const textarea = descriptionRef.current;
    const start = textarea?.selectionStart ?? descriptionMd.length;
    const end = textarea?.selectionEnd ?? start;
    const markdown = images
      .map((image, index) => {
        const label = markdownImageLabel(image.file.name || `剪贴板截图 ${pendingImages.length + index + 1}`);
        return `![${label}](task-image:${image.id})`;
      })
      .join("\n\n");
    const before = descriptionMd.slice(0, start);
    const after = descriptionMd.slice(end);
    const prefix = before && !before.endsWith("\n") ? "\n\n" : "";
    const suffix = after && !after.startsWith("\n") ? "\n\n" : "";
    const insertion = `${prefix}${markdown}${suffix}`;
    setDescriptionMd(`${before}${insertion}${after}`);
    window.setTimeout(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + insertion.length, start + insertion.length);
    }, 0);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const itemFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    const files = (itemFiles.length > 0 ? itemFiles : Array.from(event.clipboardData.files)).filter((file) =>
      file.type.startsWith("image/")
    );
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    addImages(files);
  };

  const removePendingImage = (id: string) => {
    setPendingImages((current) => {
      const target = current.find((image) => image.id === id);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return current.filter((image) => image.id !== id);
    });
    setDescriptionMd((current) =>
      current.replace(new RegExp(`\\n{0,2}!\\[[^\\]]*\\]\\(task-image:${id}\\)\\n{0,2}`, "g"), "\n")
    );
  };

  const deleteExistingAttachment = async (attachmentId: string) => {
    if (!task || busy || !window.confirm("移除这张任务截图？")) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      const attachment = task.attachments.find((item) => item.id === attachmentId);
      let saved = await taskApi.deleteAttachment(task.id, attachmentId);
      if (attachment && descriptionMd.includes(attachment.url)) {
        const nextDescription = removeMarkdownImage(descriptionMd, attachment.url);
        saved = await taskApi.update(saved.id, {
          descriptionMd: nextDescription,
          revision: saved.revision
        });
        setDescriptionMd(nextDescription);
      }
      onSaved(saved, { close: false });
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "截图移除失败");
    } finally {
      setBusy(false);
    }
  };

  const applyMarkdown = (prefix: string, suffix: string, placeholder: string) => {
    const textarea = descriptionRef.current;
    if (!textarea) {
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = descriptionMd.slice(start, end) || placeholder;
    const next = `${descriptionMd.slice(0, start)}${prefix}${selected}${suffix}${descriptionMd.slice(end)}`;
    setDescriptionMd(next);
    window.setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + prefix.length, start + prefix.length + selected.length);
    }, 0);
  };

  return (
    <div className="task-editor-backdrop" role="presentation">
      <form className="task-editor-panel" onSubmit={submit}>
        <header className="task-editor-header">
          <div>
            <span className="task-editor-kicker">{task ? `${task.key} · 编辑任务` : "新建开发任务"}</span>
            <h2>{task ? task.title : "把问题描述清楚，然后交给执行系统"}</h2>
          </div>
          <button className="task-icon-button" type="button" onClick={onClose} title="关闭">
            <X size={19} />
          </button>
        </header>

        <div className="task-editor-body">
          <section className="task-editor-main">
            <label className="task-field task-title-field">
              <span>任务名称</span>
              <input
                autoFocus
                required
                maxLength={160}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="例如：登录成功后偶发跳回登录页"
              />
            </label>

            <section className="task-description-editor">
              <header className="task-description-toolbar">
                <div className="task-editor-tabs">
                  <button
                    className={editorMode === "write" ? "active" : ""}
                    type="button"
                    onClick={() => setEditorMode("write")}
                  >
                    <PencilLine size={15} />
                    编辑
                  </button>
                  <button
                    className={editorMode === "preview" ? "active" : ""}
                    type="button"
                    onClick={() => setEditorMode("preview")}
                  >
                    <Eye size={15} />
                    预览
                  </button>
                </div>
                <div className="task-markdown-actions" aria-label="Markdown 工具栏">
                  <button type="button" onClick={() => applyMarkdown("**", "**", "重点")} title="粗体">
                    <Bold size={15} />
                  </button>
                  <button type="button" onClick={() => applyMarkdown("_", "_", "强调")} title="斜体">
                    <Italic size={15} />
                  </button>
                  <button type="button" onClick={() => applyMarkdown("`", "`", "code")} title="行内代码">
                    <Code2 size={15} />
                  </button>
                  <button type="button" onClick={() => applyMarkdown("[", "](https://)", "链接")} title="链接">
                    <Link size={15} />
                  </button>
                  <button type="button" onClick={() => applyMarkdown("\n- [ ] ", "", "验收项")} title="任务列表">
                    <ListChecks size={15} />
                  </button>
                  <button type="button" onClick={() => fileInputRef.current?.click()} title="添加截图">
                    <ImagePlus size={15} />
                  </button>
                </div>
              </header>
              {editorMode === "write" ? (
                <textarea
                  ref={descriptionRef}
                  value={descriptionMd}
                  onChange={(event) => setDescriptionMd(event.target.value)}
                  onPaste={handlePaste}
                  placeholder={[
                    "## 现象",
                    "描述用户看到的问题。",
                    "",
                    "## 期望",
                    "描述正确行为和边界条件。",
                    "",
                    "可直接 Ctrl+V 粘贴截图。"
                  ].join("\n")}
                />
              ) : (
                <div className="task-description-preview">
                  <MarkdownContent source={previewDescription} emptyText="填写描述后会在这里预览。" />
                </div>
              )}
            </section>

            <label className="task-field">
              <span>验收标准</span>
              <textarea
                className="task-criteria-input"
                value={acceptanceCriteriaMd}
                onChange={(event) => setAcceptanceCriteriaMd(event.target.value)}
                placeholder={"- [ ] 能稳定复现并修复\n- [ ] 补充回归测试\n- [ ] 不影响现有登录流程"}
              />
            </label>

            <section className="task-image-dropzone">
              <div>
                <Paperclip size={18} />
                <span>截图附件</span>
                <small>支持粘贴、选择 PNG/JPEG/WebP/GIF，单张不超过 10 MB</small>
              </div>
              <button className="task-secondary-button" type="button" onClick={() => fileInputRef.current?.click()}>
                <ImagePlus size={16} />
                选择截图
              </button>
              <input
                ref={fileInputRef}
                hidden
                multiple
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(event) => {
                  addImages(Array.from(event.target.files ?? []));
                  event.target.value = "";
                }}
              />
            </section>

            {(task?.attachments.length || pendingImages.length > 0) && (
              <div className="task-editor-image-grid">
                {task?.attachments.map((attachment) => (
                  <figure key={attachment.id}>
                    <img src={attachment.url} alt={attachment.name} />
                    <figcaption title={attachment.name}>{attachment.name}</figcaption>
                    <button type="button" onClick={() => void deleteExistingAttachment(attachment.id)} title="移除截图">
                      <Trash2 size={14} />
                    </button>
                  </figure>
                ))}
                {pendingImages.map((image) => (
                  <figure key={image.id}>
                    <img src={image.previewUrl} alt={image.file.name || "待上传截图"} />
                    <figcaption title={image.file.name}>{image.file.name || "待上传截图"}</figcaption>
                    <button type="button" onClick={() => removePendingImage(image.id)} title="移除截图">
                      <Trash2 size={14} />
                    </button>
                  </figure>
                ))}
              </div>
            )}
          </section>

          <aside className="task-editor-aside">
            <div className="task-field-grid">
              <label className="task-field task-field-wide">
                <span>归属项目</span>
                <div className="task-project-input">
                  <FolderKanban size={16} />
                  <select
                    value={project}
                    onChange={(event) => {
                      const nextProject = projects.find((item) => item.name === event.target.value);
                      setProject(nextProject?.name ?? "");
                      setRepositoryPath(nextProject?.rootDirectory ?? "");
                    }}
                  >
                    <option value="">未归属项目</option>
                    {projects.map((item) => (
                      <option key={item.name} value={item.name}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                  <button type="button" onClick={onManageProjects} title="新建或编辑项目">
                    <FolderCog size={15} />
                  </button>
                </div>
                <small>{project ? "目标仓库已采用所选项目的根目录。" : "没有项目时，可点击右侧按钮先创建。"}</small>
              </label>
              <label className="task-field">
                <span>处理进度</span>
                <select
                  className={`task-tone-select status-${status}`}
                  value={status}
                  onChange={(event) => setStatus(event.target.value as TaskStatus)}
                >
                  {TASK_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {STATUS_LABELS[value]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="task-field">
                <span>优先级</span>
                <select
                  className={`task-tone-select priority-${priority.toLowerCase()}`}
                  value={priority}
                  onChange={(event) => setPriority(event.target.value as TaskPriority)}
                >
                  {TASK_PRIORITIES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="task-field">
                <span>难度</span>
                <select
                  className={`task-tone-select difficulty-d${difficulty}`}
                  value={difficulty}
                  onChange={(event) => setDifficulty(Number(event.target.value) as TaskDifficulty)}
                >
                  {[1, 2, 3, 4, 5].map((value) => (
                    <option key={value} value={value}>
                      {value} · {difficultyLabel(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="task-field task-field-wide">
                <span>标签</span>
                <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="bug, login, frontend" />
              </label>
              <label className="task-field task-field-wide">
                <span>创建时间</span>
                <div className="task-created-at-input">
                  <CalendarClock size={16} />
                  <input
                    type="datetime-local"
                    required
                    value={createdAt}
                    onChange={(event) => setCreatedAt(event.target.value)}
                  />
                </div>
                <small>可以按任务实际提出时间手动调整。</small>
              </label>
              <label className="task-field task-field-wide">
                <span>目标仓库</span>
                <input
                  value={repositoryPath}
                  onChange={(event) => setRepositoryPath(event.target.value)}
                  readOnly={Boolean(project)}
                  placeholder="选择项目后自动填入根目录"
                />
                {project && <small>该路径由项目设置统一管理。</small>}
              </label>
              <label className="task-field task-field-wide">
                <span>最大 Codex 数</span>
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={maxConcurrency}
                  onChange={(event) => setMaxConcurrency(Math.max(1, Math.min(12, Number(event.target.value) || 1)))}
                />
                <small>保存后可从任务列表一键创建对应数量内的 Task Terminal 并启动 Codex。</small>
              </label>
            </div>
          </aside>
        </div>

        {error && <div className="task-editor-error">{error}</div>}

        <footer className="task-editor-footer">
          <span>{pendingImages.length > 0 ? `${pendingImages.length} 张截图将在保存后上传` : "任务会保存到当前用户的数据空间"}</span>
          <div>
            <button className="task-secondary-button" type="button" onClick={onClose} disabled={busy}>
              取消
            </button>
            <button className="task-primary-button" type="submit" disabled={busy}>
              {busy ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
              {busy ? "保存中" : task ? "保存任务" : "创建任务"}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

function difficultyLabel(value: number): string {
  return ["", "很小", "简单", "中等", "复杂", "高风险"][value] ?? "中等";
}

function markdownImageLabel(value: string): string {
  return value.replace(/[\[\]\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "任务截图";
}

function toLocalDateTimeInput(value: string): string {
  const date = new Date(value);
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 16);
}

function removeMarkdownImage(source: string, url: string): string {
  const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return source.replace(new RegExp(`\\n{0,2}!\\[[^\\]]*\\]\\(${escapedUrl}\\)\\n{0,2}`, "g"), "\n");
}
