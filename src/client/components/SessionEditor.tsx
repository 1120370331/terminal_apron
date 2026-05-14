import { X } from "lucide-react";
import { FormEvent, useState } from "react";
import type { CreateSessionInput, TerminalSession } from "../../shared/types";

interface Props {
  session: TerminalSession | null;
  onClose: () => void;
  onSave: (input: CreateSessionInput) => Promise<void>;
}

export function SessionEditor({ session, onClose, onSave }: Props) {
  const [name, setName] = useState(session?.name ?? "");
  const [group, setGroup] = useState(session?.group ?? "default");
  const [tags, setTags] = useState(session?.tags.join(", ") ?? "");
  const [cwd, setCwd] = useState(session?.cwd ?? "");
  const [shell, setShell] = useState(session?.shell ?? "");
  const [backend, setBackend] = useState(session?.backend ?? "auto");
  const [color, setColor] = useState(session?.color ?? "#2f80ed");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
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
        backend,
        color
      });
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
          后端
          <select
            value={backend}
            onChange={(event) => setBackend(event.target.value as "auto" | "native" | "tmux" | "zellij")}
          >
            <option value="auto">auto</option>
            <option value="zellij">zellij</option>
            <option value="native">native pty</option>
            <option value="tmux">tmux</option>
          </select>
        </label>
        <label>
          颜色
          <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
        </label>

        <footer className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={busy}>
            保存
          </button>
        </footer>
      </form>
    </div>
  );
}
