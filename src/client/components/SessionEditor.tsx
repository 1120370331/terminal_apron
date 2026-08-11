import { X } from "lucide-react";
import { FormEvent, useState } from "react";
import type { CreateSessionInput, TerminalBackgroundMode, TerminalSession } from "../../shared/types";
import { BackgroundImagePicker } from "./BackgroundImagePicker";

interface Props {
  session: TerminalSession | null;
  defaults?: Partial<CreateSessionInput>;
  initialGroup?: string;
  initialTags?: string[];
  defaultBackgroundImage: string | null;
  onClose: () => void;
  onSave: (input: CreateSessionInput) => Promise<void>;
}

export function SessionEditor({
  session,
  defaults,
  initialGroup,
  initialTags = [],
  defaultBackgroundImage,
  onClose,
  onSave
}: Props) {
  const [name, setName] = useState(session?.name ?? defaults?.name ?? "");
  const [group, setGroup] = useState(session?.group ?? defaults?.group ?? initialGroup ?? "default");
  const [tags, setTags] = useState(
    session?.tags.join(", ") ?? defaults?.tags?.join(", ") ?? initialTags.join(", ")
  );
  const [cwd, setCwd] = useState(session?.cwd ?? defaults?.cwd ?? "");
  const [shell, setShell] = useState(session?.shell ?? defaults?.shell ?? "");
  const [color, setColor] = useState(session?.color ?? defaults?.color ?? "#2f80ed");
  const [backgroundMode, setBackgroundMode] = useState<TerminalBackgroundMode>(
    session?.backgroundMode ?? defaults?.backgroundMode ?? "inherit"
  );
  const [backgroundImage, setBackgroundImage] = useState<string | null>(
    session?.backgroundImage ?? defaults?.backgroundImage ?? null
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    setError("");
    if (backgroundMode === "image" && !backgroundImage) {
      setError("请先选择该 terminal 的背景图");
      return;
    }
    setBusy(true);
    try {
      await onSave({
        name,
        group,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        cwd,
        shell,
        backend: "zellij",
        color,
        backgroundMode,
        backgroundImage: backgroundMode === "image" ? backgroundImage ?? undefined : undefined
      });
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal-panel editor" onSubmit={submit}>
        <header className="modal-header">
          <h2>{session ? "编辑 terminal" : "新建 terminal"}</h2>
          <button className="icon-button" type="button" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <label>
          名称
          <input required value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          分组
          <input value={group} onChange={(event) => setGroup(event.target.value)} />
        </label>
        <label>
          标签
          <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="project, codex" />
        </label>
        <label>
          路径
          <input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="/home/me/project" />
        </label>
        <label>
          Shell
          <input value={shell} onChange={(event) => setShell(event.target.value)} placeholder="bash / zsh / pwsh" />
        </label>
        <label>
          颜色
          <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
        </label>
        <label>
          Terminal 背景
          <select
            value={backgroundMode}
            onChange={(event) => setBackgroundMode(event.target.value as TerminalBackgroundMode)}
          >
            <option value="inherit">继承全局默认</option>
            <option value="image">使用自定义图片</option>
            <option value="none">不使用背景图</option>
          </select>
        </label>
        {backgroundMode === "inherit" && defaultBackgroundImage && (
          <div className="editor-background-inherited">
            <span>当前继承效果</span>
            <div style={{ backgroundImage: `url("${defaultBackgroundImage}")` }} />
          </div>
        )}
        {backgroundMode === "image" && (
          <div className="editor-background-picker">
            <BackgroundImagePicker value={backgroundImage} onChange={setBackgroundImage} />
          </div>
        )}

        {error && <div className="form-error editor-error">{error}</div>}

        <footer className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "保存中..." : "保存"}
          </button>
        </footer>
      </form>
    </div>
  );
}
