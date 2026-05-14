import { FormEvent, UIEvent, WheelEvent, useLayoutEffect, useRef, useState } from "react";
import { Archive, Copy, Edit3, ExternalLink, Grip, Play, RotateCcw, Send, Square, Tag } from "lucide-react";
import type { TerminalSession } from "../../shared/types";

interface Props {
  session: TerminalSession;
  preview: string;
  onOpen: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onQuickInput: (value: string) => Promise<void>;
  onArchive: () => void;
  onRestore: () => void;
  onKill: () => void;
}

export function SessionCard({
  session,
  preview,
  onOpen,
  onEdit,
  onDuplicate,
  onQuickInput,
  onArchive,
  onRestore,
  onKill
}: Props) {
  const runtime = session.runtime;
  const livePath = runtime?.currentPath || session.cwd;
  const isLive = runtime?.exists;
  const backend = runtime?.backend ?? session.backend;
  const [quickInput, setQuickInput] = useState("");
  const [sending, setSending] = useState(false);
  const previewRef = useRef<HTMLPreElement | null>(null);
  const stickToBottomRef = useRef(true);

  useLayoutEffect(() => {
    const previewElement = previewRef.current;
    if (!previewElement || !stickToBottomRef.current) {
      return;
    }

    previewElement.scrollTop = previewElement.scrollHeight;
  }, [preview]);

  const trackPreviewScroll = (event: UIEvent<HTMLPreElement>) => {
    const target = event.currentTarget;
    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    stickToBottomRef.current = distanceToBottom < 24;
  };

  const handlePreviewWheel = (event: WheelEvent<HTMLPreElement>) => {
    const target = event.currentTarget;
    if (target.scrollHeight <= target.clientHeight) {
      return;
    }

    event.stopPropagation();
    const atTop = target.scrollTop <= 0;
    const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 1;
    if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
      return;
    }

    event.preventDefault();
    target.scrollTop += event.deltaY;
  };

  const submitQuickInput = async (event: FormEvent) => {
    event.preventDefault();
    const value = quickInput.trimEnd();
    if (!value || sending) {
      return;
    }

    setSending(true);
    try {
      await onQuickInput(value);
      setQuickInput("");
    } finally {
      setSending(false);
    }
  };

  return (
    <article className={session.archived ? "session-card archived" : "session-card"}>
      <div className="session-accent" style={{ background: session.color }} />
      <header className="session-card-header">
        <button className="drag-handle" type="button" title="拖拽排列">
          <Grip size={15} />
        </button>
        <div className="session-title">
          <h2>{session.name}</h2>
          <span>
            {session.group} · {backend}
          </span>
        </div>
        <div className={isLive ? "status-dot live" : "status-dot"} title={isLive ? "运行中" : "未运行"} />
      </header>

      <div className="path-line" title={livePath}>
        {livePath}
      </div>

      <pre
        className="preview"
        ref={previewRef}
        onScroll={trackPreviewScroll}
        onWheel={handlePreviewWheel}
        onMouseDown={(event) => event.stopPropagation()}
        onTouchStart={(event) => event.stopPropagation()}
      >
        {preview || (isLive ? "" : "terminal is not running")}
      </pre>

      {!session.archived && (
        <form className="quick-input" onSubmit={submitQuickInput} onMouseDown={(event) => event.stopPropagation()}>
          <input
            value={quickInput}
            onChange={(event) => setQuickInput(event.target.value)}
            placeholder="Type to terminal..."
            disabled={sending}
          />
          <button className="icon-button small" type="submit" disabled={sending || !quickInput.trim()} title="Send">
            <Send size={15} />
          </button>
        </form>
      )}

      <footer className="session-footer">
        <div className="tag-row">
          {session.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="tag-chip">
              <Tag size={12} />
              {tag}
            </span>
          ))}
        </div>
        <div className="card-actions">
          {session.archived ? (
            <button className="icon-button small" type="button" onClick={onRestore} title="恢复">
              <RotateCcw size={16} />
            </button>
          ) : (
            <>
              <button className="icon-button small" type="button" onClick={onOpen} title="打开">
                <ExternalLink size={16} />
              </button>
              <button className="icon-button small" type="button" onClick={onEdit} title="编辑">
                <Edit3 size={16} />
              </button>
              <button className="icon-button small" type="button" onClick={onDuplicate} title="复制配置">
                <Copy size={16} />
              </button>
              <button className="icon-button small" type="button" onClick={onArchive} title="归档">
                <Archive size={16} />
              </button>
              <button className="icon-button small danger" type="button" onClick={onKill} title="停止">
                <Square size={15} />
              </button>
            </>
          )}
          {!isLive && !session.archived && (
            <button className="icon-button small" type="button" onClick={onOpen} title="启动并打开">
              <Play size={16} />
            </button>
          )}
        </div>
      </footer>
    </article>
  );
}
