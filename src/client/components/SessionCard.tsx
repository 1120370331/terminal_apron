import {
  FormEvent,
  WheelEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
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

const ANSI_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_COLORS = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf"];
const ANSI_BRIGHT_COLORS = ["#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"];

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
  const [displayedPreview, setDisplayedPreview] = useState(preview);
  const [historyPaused, setHistoryPaused] = useState(false);
  const [hasPendingPreview, setHasPendingPreview] = useState(false);
  const previewRef = useRef<HTMLPreElement | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    if (!preview && !displayedPreview) {
      return;
    }

    if (historyPaused) {
      if (preview !== displayedPreview) {
        setHasPendingPreview(true);
      }
      return;
    }

    setDisplayedPreview(preview);
    setHasPendingPreview(false);
  }, [displayedPreview, historyPaused, preview]);

  useLayoutEffect(() => {
    const previewElement = previewRef.current;
    if (!previewElement || !stickToBottomRef.current) {
      return;
    }

    previewElement.scrollTop = previewElement.scrollHeight;
  }, [displayedPreview]);

  const trackPreviewScroll = () => {
    const target = previewRef.current;
    if (!target) {
      return;
    }

    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    const isAtBottom = distanceToBottom < 24;
    stickToBottomRef.current = isAtBottom;
    setHistoryPaused(target.scrollHeight > target.clientHeight && !isAtBottom);
    if (isAtBottom) {
      setHasPendingPreview(false);
    }
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

  const resumeLatestPreview = () => {
    stickToBottomRef.current = true;
    setHistoryPaused(false);
    setDisplayedPreview(preview);
    setHasPendingPreview(false);
    window.setTimeout(() => {
      const previewElement = previewRef.current;
      if (previewElement) {
        previewElement.scrollTop = previewElement.scrollHeight;
      }
    }, 0);
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

  const output = displayedPreview || (isLive ? "" : "terminal is not running");
  const renderedOutput = useMemo(() => renderAnsi(output), [output]);

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
            {session.group} / {backend}
          </span>
        </div>
        <div className={isLive ? "status-dot live" : "status-dot"} title={isLive ? "运行中" : "未运行"} />
      </header>

      <div className="path-line" title={livePath}>
        {livePath}
      </div>

      <div className="preview-wrap">
        <pre
          className="preview ansi-preview"
          ref={previewRef}
          onScroll={trackPreviewScroll}
          onWheel={handlePreviewWheel}
          onMouseDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
        >
          {renderedOutput}
        </pre>
        {historyPaused && hasPendingPreview && (
          <button
            className="preview-latest"
            type="button"
            title="回到最新"
            onClick={resumeLatestPreview}
            onMouseDown={(event) => event.stopPropagation()}
          >
            最新
          </button>
        )}
      </div>

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

function renderAnsi(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let style: CSSProperties = {};
  let buffer = "";
  let cursor = 0;
  let key = 0;

  const push = () => {
    if (!buffer) {
      return;
    }
    const text = buffer;
    buffer = "";
    nodes.push(Object.keys(style).length ? <span key={key++} style={{ ...style }}>{text}</span> : text);
  };

  for (const match of value.matchAll(ANSI_PATTERN)) {
    const index = match.index ?? 0;
    buffer += value.slice(cursor, index);
    push();
    const sequence = match[0];
    if (sequence.endsWith("m") && sequence.startsWith("\u001b[")) {
      style = applySgr(style, sequence);
    }
    cursor = index + sequence.length;
  }

  buffer += value.slice(cursor);
  push();
  return nodes.length ? nodes : [value];
}

function applySgr(current: CSSProperties, sequence: string): CSSProperties {
  const next: CSSProperties = { ...current };
  const body = sequence.slice(2, -1);
  const codes = body.length ? body.split(";").map((item) => Number(item || 0)) : [0];

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) {
      return {};
    }
    if (code === 1) {
      next.fontWeight = 700;
    } else if (code === 3) {
      next.fontStyle = "italic";
    } else if (code === 4) {
      next.textDecoration = "underline";
    } else if (code === 22) {
      delete next.fontWeight;
    } else if (code === 23) {
      delete next.fontStyle;
    } else if (code === 24) {
      delete next.textDecoration;
    } else if (code >= 30 && code <= 37) {
      next.color = ANSI_COLORS[code - 30];
    } else if (code === 39) {
      delete next.color;
    } else if (code >= 40 && code <= 47) {
      next.backgroundColor = ANSI_COLORS[code - 40];
    } else if (code === 49) {
      delete next.backgroundColor;
    } else if (code >= 90 && code <= 97) {
      next.color = ANSI_BRIGHT_COLORS[code - 90];
    } else if (code >= 100 && code <= 107) {
      next.backgroundColor = ANSI_BRIGHT_COLORS[code - 100];
    } else if ((code === 38 || code === 48) && codes[index + 1] === 5) {
      const color = ansi256ToHex(codes[index + 2]);
      if (color) {
        if (code === 38) {
          next.color = color;
        } else {
          next.backgroundColor = color;
        }
      }
      index += 2;
    } else if ((code === 38 || code === 48) && codes[index + 1] === 2) {
      const r = clampByte(codes[index + 2]);
      const g = clampByte(codes[index + 3]);
      const b = clampByte(codes[index + 4]);
      const color = `rgb(${r}, ${g}, ${b})`;
      if (code === 38) {
        next.color = color;
      } else {
        next.backgroundColor = color;
      }
      index += 4;
    }
  }

  return next;
}

function ansi256ToHex(value: number): string | null {
  if (!Number.isFinite(value) || value < 0 || value > 255) {
    return null;
  }
  if (value < 8) {
    return ANSI_COLORS[value];
  }
  if (value < 16) {
    return ANSI_BRIGHT_COLORS[value - 8];
  }
  if (value >= 232) {
    const channel = 8 + (value - 232) * 10;
    return rgbToHex(channel, channel, channel);
  }

  const offset = value - 16;
  const r = Math.floor(offset / 36);
  const g = Math.floor((offset % 36) / 6);
  const b = offset % 6;
  return rgbToHex(cubeChannel(r), cubeChannel(g), cubeChannel(b));
}

function cubeChannel(value: number): number {
  return value === 0 ? 0 : 55 + value * 40;
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((part) => clampByte(part).toString(16).padStart(2, "0")).join("")}`;
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.floor(value)));
}
