import {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  WheelEvent,
  memo,
  useCallback,
  useEffect,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import {
  Archive,
  Check,
  Clipboard,
  ClipboardPaste,
  Copy,
  Edit3,
  ExternalLink,
  Grip,
  Paperclip,
  Play,
  RotateCcw,
  Send,
  Square,
  Tag,
  TextCursorInput
} from "lucide-react";
import type { SessionPreview, TerminalPreviewGrid, TerminalPreviewSegment, TerminalSession } from "../../shared/types";
import { filesFromClipboardData, readClipboardFiles, readClipboardText, writeClipboardText } from "../clipboard";

export type QuickInputPhase = "sending" | "sent" | "echoing" | "updated" | "error";

export interface QuickInputStatus {
  inputId: string;
  phase: QuickInputPhase;
  inputSeq?: number;
  message?: string;
  updatedAt: number;
}

interface Props {
  session: TerminalSession;
  preview?: SessionPreview;
  quickInputStatus?: QuickInputStatus;
  previewFontSize: number;
  previewScale: number;
  onOpen: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onQuickInput: (value: string) => Promise<void>;
  onPasteFiles: (files: File[]) => Promise<string>;
  onArchive: () => void;
  onRestore: () => void;
  onKill: () => void;
}

const ANSI_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_COLORS = ["#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf"];
const ANSI_BRIGHT_COLORS = ["#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec"];
const CARD_PREVIEW_MAX_LINES = 360;
const CARD_PREVIEW_MAX_CHARS = 80_000;
const CARD_PREVIEW_MAX_NODES = 2_000;
const DEFAULT_PREVIEW_FONT_SIZE = 16;
const MOBILE_QUERY = "(max-width: 720px)";

function SessionCardComponent({
  session,
  preview,
  quickInputStatus,
  previewFontSize,
  previewScale,
  onOpen,
  onEdit,
  onDuplicate,
  onQuickInput,
  onPasteFiles,
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
  const [uploading, setUploading] = useState(false);
  const [displayedPreview, setDisplayedPreview] = useState<SessionPreview | undefined>(preview);
  const [historyPaused, setHistoryPaused] = useState(false);
  const [hasPendingPreview, setHasPendingPreview] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [copied, setCopied] = useState(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const quickInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const copiedTimerRef = useRef<number | null>(null);
  const composingRef = useRef(false);
  const stickToBottomRef = useRef(true);
  const userPreviewScrollRef = useRef(false);
  const deferredPreview = useDeferredValue(displayedPreview);
  const output = deferredPreview?.text || (isLive ? "" : "terminal is not running");
  const grid = deferredPreview?.grid;
  const showCanvas = Boolean(grid && !selectMode);
  const compactOutput = useMemo(() => compactPreview(output), [output]);
  const plainOutput = useMemo(() => stripAnsi(compactOutput), [compactOutput]);
  const renderedOutput = useMemo(() => renderAnsi(compactOutput), [compactOutput]);
  const terminalFontSize = normalizedPreviewFontSize(previewFontSize);
  const terminalScale = normalizedPreviewScale(previewScale);
  const previewStyle = {
    "--list-terminal-font-size": `${terminalFontSize * terminalScale}px`
  } as CSSProperties;
  const quickInputPhase = quickInputStatus?.phase;
  const inputControlsDisabled = sending || uploading || quickInputPhase === "sending";
  const quickStatusLabel = quickInputPhase ? quickInputStatusLabel(quickInputPhase) : sending ? "sending" : uploading ? "uploading" : "";
  const quickStatusClass = quickInputPhase ?? (sending || uploading ? "sending" : "sent");
  const quickStatusTitle = quickInputStatus
    ? [quickInputStatus.message, quickInputStatus.inputSeq ? `seq ${quickInputStatus.inputSeq}` : quickInputStatus.inputId]
        .filter(Boolean)
        .join(" / ")
    : quickStatusLabel;
  const cardClassName = [
    "session-card",
    session.archived ? "archived" : "",
    quickInputPhase ? `quick-input-${quickInputPhase}` : ""
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    if (!preview && !displayedPreview) {
      return;
    }

    if (historyPaused) {
      if (previewSignature(preview) !== previewSignature(displayedPreview)) {
        setHasPendingPreview(true);
      }
      return;
    }

    setDisplayedPreview(preview);
    setHasPendingPreview(false);
  }, [displayedPreview, historyPaused, preview]);

  useLayoutEffect(() => {
    const previewElement = previewRef.current;
    if (!previewElement || !stickToBottomRef.current || showCanvas) {
      return;
    }

    previewElement.scrollTop = previewElement.scrollHeight;
  }, [displayedPreview, showCanvas]);

  const redrawPreviewCanvas = useCallback(() => {
    if (!showCanvas || !grid || !canvasRef.current) {
      return;
    }
    const previewElement = previewRef.current;
    const availableWidth = previewElement ? contentWidth(previewElement) : undefined;
    drawPreviewCanvas(canvasRef.current, grid, availableWidth, {
      fontSize: terminalFontSize,
      scale: terminalScale
    });
    if (previewElement && stickToBottomRef.current) {
      previewElement.scrollTop = previewElement.scrollHeight;
    }
  }, [grid, showCanvas, terminalFontSize, terminalScale]);

  useLayoutEffect(() => {
    if (!showCanvas) {
      return;
    }

    redrawPreviewCanvas();
    const previewElement = previewRef.current;
    if (!previewElement || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", redrawPreviewCanvas);
      return () => window.removeEventListener("resize", redrawPreviewCanvas);
    }

    const observer = new ResizeObserver(() => redrawPreviewCanvas());
    observer.observe(previewElement);
    window.addEventListener("resize", redrawPreviewCanvas);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", redrawPreviewCanvas);
    };
  }, [showCanvas, redrawPreviewCanvas]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  const trackPreviewScroll = () => {
    const target = previewRef.current;
    if (!target) {
      return;
    }

    const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
    const isAtBottom = distanceToBottom < 24;
    stickToBottomRef.current = isAtBottom;
    if (isAtBottom) {
      userPreviewScrollRef.current = false;
      setHistoryPaused(false);
      setHasPendingPreview(false);
      return;
    }

    const shouldPause = target.scrollHeight > target.clientHeight && (userPreviewScrollRef.current || selectMode);
    setHistoryPaused(shouldPause);
  };

  const handlePreviewWheel = (event: WheelEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    const canScrollY = target.scrollHeight > target.clientHeight;
    const canScrollX = target.scrollWidth > target.clientWidth;
    if (!canScrollY && !canScrollX) {
      return;
    }

    userPreviewScrollRef.current = true;
    event.stopPropagation();
    if (canScrollX && (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY))) {
      event.preventDefault();
      target.scrollLeft += event.shiftKey ? event.deltaY : event.deltaX;
      return;
    }

    if (!canScrollY) {
      return;
    }

    const atTop = target.scrollTop <= 0;
    const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 1;
    if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
      return;
    }

    event.preventDefault();
    target.scrollTop += event.deltaY;
  };

  const resumeLatestPreview = () => {
    userPreviewScrollRef.current = false;
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

  const markCopied = () => {
    setCopied(true);
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
  };

  const copyPreviewText = async () => {
    const selectedText = selectedTextInside(previewRef.current);
    const text = selectedText || plainOutput;
    if (!text.trim()) {
      return;
    }

    await writeClipboardText(text);
    markCopied();
  };

  const toggleSelectMode = () => {
    setSelectMode((current) => {
      const next = !current;
      if (next) {
        stickToBottomRef.current = false;
        setHistoryPaused(true);
        setHasPendingPreview(false);
      }
      return next;
    });
  };

  const insertQuickInputText = useCallback((text: string, pad = false) => {
    if (!text) {
      quickInputRef.current?.focus();
      return;
    }

    const input = quickInputRef.current;
    setQuickInput((current) => {
      const start = input?.selectionStart ?? current.length;
      const end = input?.selectionEnd ?? start;
      const before = current.slice(0, start);
      const after = current.slice(end);
      const prefix = pad && before && !/\s$/.test(before) ? " " : "";
      const suffix = pad && after && !/^\s/.test(after) ? " " : "";
      const next = `${before}${prefix}${text}${suffix}${after}`;
      const cursor = before.length + prefix.length + text.length;
      window.requestAnimationFrame(() => {
        input?.focus();
        input?.setSelectionRange(cursor, cursor);
      });
      return next;
    });
  }, []);

  const appendFilesToQuickInput = async (files: File[]) => {
    if (files.length === 0) {
      quickInputRef.current?.focus();
      return;
    }
    if (inputControlsDisabled) {
      return;
    }

    setUploading(true);
    try {
      const terminalText = await onPasteFiles(files);
      insertQuickInputText(terminalText, true);
    } finally {
      setUploading(false);
      quickInputRef.current?.focus();
    }
  };

  const pasteClipboardToInput = async () => {
    try {
      const files = await readClipboardFiles();
      if (files.length > 0) {
        await appendFilesToQuickInput(files);
        return;
      }
    } catch {
      // Fall back to text clipboard below.
    }

    try {
      const text = await readClipboardText();
      if (text) {
        insertQuickInputText(text);
      } else {
        quickInputRef.current?.focus();
      }
    } catch {
      quickInputRef.current?.focus();
    }
  };

  const pasteFilesToInput = async (event: ClipboardEvent<HTMLInputElement>) => {
    const files = filesFromClipboardData(event.clipboardData);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    await appendFilesToQuickInput(files);
  };

  const selectFilesForInput = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    await appendFilesToQuickInput(files);
  };

  const submitQuickInput = async (event: FormEvent) => {
    event.preventDefault();
    if (composingRef.current) {
      return;
    }
    const value = (quickInputRef.current?.value ?? quickInput).trimEnd();
    if (!value || inputControlsDisabled) {
      return;
    }

    setSending(true);
    try {
      await onQuickInput(value);
      setQuickInput("");
    } catch {
      // Parent owns the visible error state; keep the input so it can be retried.
    } finally {
      setSending(false);
    }
  };

  return (
    <article className={cardClassName}>
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
        <div
          className="preview-tools"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onTouchStart={(event) => event.stopPropagation()}
        >
          <button
            className={selectMode ? "preview-tool active" : "preview-tool"}
            type="button"
            title={selectMode ? "Terminal render mode" : "Select text mode"}
            onClick={toggleSelectMode}
          >
            <TextCursorInput size={14} />
          </button>
          <button
            className={copied ? "preview-tool success" : "preview-tool"}
            type="button"
            title={copied ? "Copied" : "Copy selected text or current preview"}
            onClick={() => void copyPreviewText()}
          >
            {copied ? <Check size={14} /> : <Clipboard size={14} />}
          </button>
        </div>
        <div
          className={showCanvas ? "preview terminal-grid-preview" : "preview ansi-preview selectable-preview"}
          style={previewStyle}
          ref={previewRef}
          onScroll={trackPreviewScroll}
          onWheel={handlePreviewWheel}
          onMouseDown={(event) => {
            event.stopPropagation();
            if (selectMode) {
              userPreviewScrollRef.current = true;
            }
          }}
          onTouchStart={(event) => event.stopPropagation()}
        >
          {showCanvas ? (
            <canvas className="terminal-preview-canvas" ref={canvasRef} />
          ) : (
            <code className="ansi-preview-content">{renderedOutput}</code>
          )}
        </div>
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
            ref={quickInputRef}
            id={`quick-input-${session.id}`}
            name={`quick-input-${session.id}`}
            autoComplete="off"
            spellCheck={false}
            value={quickInput}
            onChange={(event) => setQuickInput(event.target.value)}
            onPaste={(event) => void pasteFilesToInput(event)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            placeholder="Type to terminal..."
            disabled={inputControlsDisabled}
          />
          <input
            ref={fileInputRef}
            className="hidden-file-input"
            type="file"
            multiple
            onChange={(event) => void selectFilesForInput(event)}
          />
          <button
            className="icon-button small"
            type="button"
            disabled={inputControlsDisabled}
            title="Attach image or file"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={15} />
          </button>
          <button
            className="icon-button small"
            type="button"
            disabled={inputControlsDisabled}
            title="Paste clipboard text or image"
            onClick={() => void pasteClipboardToInput()}
          >
            <ClipboardPaste size={15} />
          </button>
          <button className="icon-button small" type="submit" disabled={inputControlsDisabled || !quickInput.trim()} title="Send">
            <Send size={15} />
          </button>
          {quickStatusLabel && (
            <span className={`quick-input-status ${quickStatusClass}`} title={quickStatusTitle} aria-live="polite">
              {quickStatusLabel}
            </span>
          )}
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

export const SessionCard = memo(SessionCardComponent, areSessionCardPropsEqual);

function areSessionCardPropsEqual(previous: Props, next: Props): boolean {
  return (
    previous.previewFontSize === next.previewFontSize &&
    previous.previewScale === next.previewScale &&
    previewSignature(previous.preview) === previewSignature(next.preview) &&
    quickInputStatusSignature(previous.quickInputStatus) === quickInputStatusSignature(next.quickInputStatus) &&
    sessionCardSignature(previous.session) === sessionCardSignature(next.session)
  );
}

function quickInputStatusLabel(phase: QuickInputPhase): string {
  if (phase === "sent") {
    return "sent";
  }
  if (phase === "echoing") {
    return "echoing";
  }
  if (phase === "updated") {
    return "updated";
  }
  if (phase === "error") {
    return "error";
  }
  return "sending";
}

function quickInputStatusSignature(status?: QuickInputStatus): string {
  if (!status) {
    return "";
  }
  return [status.inputId, status.phase, status.inputSeq ?? "", status.message ?? "", status.updatedAt].join("\u001f");
}

function previewSignature(preview?: SessionPreview): string {
  if (!preview) {
    return "";
  }
  if (preview.signature) {
    return preview.signature;
  }
  return [
    preview?.text ?? "",
    gridSignature(preview.grid)
  ].join("\u001f");
}

function selectedTextInside(root: HTMLElement | null): string {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) {
    return "";
  }

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) && !root.contains(range.endContainer)) {
    return "";
  }

  return selection.toString();
}

function gridSignature(grid?: TerminalPreviewGrid): string {
  if (!grid) {
    return "";
  }
  const rows = grid.rows.map((row) =>
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
  );
  return [grid.cols, grid.rows.length, ...rows].join("\u001c");
}

function sessionCardSignature(session: TerminalSession): string {
  const runtime = session.runtime;
  return [
    session.id,
    session.name,
    session.group,
    session.tags.join(","),
    session.cwd,
    session.backend,
    session.color,
    String(session.archived),
    runtime?.backend ?? "",
    String(runtime?.exists ?? ""),
    runtime?.currentPath ?? "",
    runtime?.currentCommand ?? "",
    String(runtime?.windows ?? "")
  ].join("\u001f");
}

function normalizedPreviewFontSize(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_PREVIEW_FONT_SIZE;
  }
  return Math.max(12, Math.min(24, Math.floor(value)));
}

function normalizedPreviewScale(value: number): number {
  const parsed = Number.isFinite(value) ? value : 1;
  const scale = Math.max(0.8, Math.min(1.4, parsed));
  if (typeof window.matchMedia === "function" && window.matchMedia(MOBILE_QUERY).matches) {
    return Math.max(1, Math.min(1.15, scale));
  }
  return scale;
}

function drawPreviewCanvas(
  canvas: HTMLCanvasElement,
  grid: TerminalPreviewGrid,
  availableWidth: number | undefined,
  options: { fontSize: number; scale: number }
): void {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const fontSize = options.fontSize;
  const scale = options.scale;
  const lineHeight = Math.ceil(fontSize * 1.35);
  const fontFamily = '"Cascadia Mono", "SFMono-Regular", Consolas, "Noto Sans Mono CJK SC", "Microsoft YaHei Mono", NSimSun, monospace';
  context.font = `${fontSize}px ${fontFamily}`;
  const cellWidth = Math.max(8, Math.ceil(context.measureText("M").width * 100) / 100);
  const naturalWidth = Math.max(1, grid.cols * cellWidth);
  const naturalHeight = Math.max(lineHeight, grid.rows.length * lineHeight);
  const width = Math.max(1, Math.ceil(naturalWidth * scale));
  const height = Math.max(1, Math.ceil(naturalHeight * scale));
  const dpr = window.devicePixelRatio || 1;

  context.imageSmoothingEnabled = false;
  canvas.width = Math.ceil(width * dpr);
  canvas.height = Math.ceil(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.dataset.previewScale = scale.toFixed(2);
  canvas.dataset.previewFontSize = String(fontSize);
  if (availableWidth && availableWidth > 0) {
    canvas.dataset.previewOverflows = width > availableWidth ? "true" : "false";
  }

  context.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#111614";
  context.fillRect(0, 0, naturalWidth, naturalHeight);

  for (let rowIndex = 0; rowIndex < grid.rows.length; rowIndex += 1) {
    const row = grid.rows[rowIndex];
    let x = 0;
    const y = rowIndex * lineHeight;
    for (const segment of row.segments) {
      const segmentWidth = Math.max(cellWidth, segment.cols * cellWidth);
      drawCanvasSegment(context, segment, x, y, segmentWidth, lineHeight, fontSize, fontFamily, cellWidth);
      x += segmentWidth;
    }
  }
}

function contentWidth(element: HTMLElement): number {
  const style = window.getComputedStyle(element);
  const paddingX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  return Math.max(0, element.clientWidth - paddingX);
}

function drawCanvasSegment(
  context: CanvasRenderingContext2D,
  segment: TerminalPreviewSegment,
  x: number,
  y: number,
  width: number,
  lineHeight: number,
  fontSize: number,
  fontFamily: string,
  cellWidth: number
): void {
  if (segment.bg) {
    context.fillStyle = segment.bg;
    context.fillRect(x, y, width, lineHeight);
  }
  if (!segment.text) {
    return;
  }

  context.save();
  context.beginPath();
  context.rect(x, y, width, lineHeight);
  context.clip();
  context.globalAlpha = segment.dim ? 0.72 : 1;
  context.font = `${segment.italic ? "italic " : ""}${segment.bold ? "700" : "400"} ${fontSize}px ${fontFamily}`;
  context.textBaseline = "top";
  context.fillStyle = segment.fg ?? "#dce9df";
  drawCellAlignedText(context, segment.text, x, y + 1, cellWidth);
  if (segment.underline) {
    context.fillRect(x, y + lineHeight - 2, width, 1);
  }
  context.restore();
}

function drawCellAlignedText(context: CanvasRenderingContext2D, value: string, x: number, y: number, cellWidth: number): void {
  let cursor = x;
  for (const char of Array.from(value)) {
    const columns = charColumns(char);
    if (char !== " ") {
      context.fillText(char, cursor, y);
    }
    cursor += columns * cellWidth;
  }
}

function charColumns(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0) {
    return 0;
  }
  return codePoint > 0xff ? 2 : 1;
}

function compactPreview(value: string): string {
  let output = value;
  let truncated = false;

  if (output.length > CARD_PREVIEW_MAX_CHARS) {
    output = output.slice(-CARD_PREVIEW_MAX_CHARS);
    const firstLineBreak = output.indexOf("\n");
    if (firstLineBreak >= 0) {
      output = output.slice(firstLineBreak + 1);
    }
    truncated = true;
  }

  const lines = output.split("\n");
  if (lines.length > CARD_PREVIEW_MAX_LINES) {
    output = lines.slice(-CARD_PREVIEW_MAX_LINES).join("\n");
    truncated = true;
  }

  return truncated ? `...\n\u001b[0m${output}` : output;
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
    if (nodes.length >= CARD_PREVIEW_MAX_NODES) {
      buffer += stripAnsi(value.slice(index));
      cursor = value.length;
      break;
    }
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

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
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
