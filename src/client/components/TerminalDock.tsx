import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { io, type Socket } from "socket.io-client";
import { Check, Clipboard, ClipboardPaste, RefreshCw, Send, TextCursorInput, X } from "lucide-react";
import type { TerminalSession } from "../../shared/types";
import { readClipboardText, writeClipboardText } from "../clipboard";

interface Props {
  session: TerminalSession;
  backgroundImage: string | null;
  onClose: () => void;
}

const MOBILE_QUERY = "(max-width: 720px)";

export function TerminalDock({ session, backgroundImage, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const selectionLayerRef = useRef<HTMLPreElement | null>(null);
  const mobileInputRef = useRef<HTMLTextAreaElement | null>(null);
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeSeqRef = useRef(0);
  const lastAckSeqRef = useRef(0);
  const applyingServerResizeRef = useRef(false);
  const copiedTimerRef = useRef<number | null>(null);
  const selectModeRef = useRef(false);
  const [attachCommand, setAttachCommand] = useState<string | null>(null);
  const [backend, setBackend] = useState(session.runtime?.backend ?? session.backend);
  const [status, setStatus] = useState("connecting");
  const [copied, setCopied] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectionSnapshot, setSelectionSnapshot] = useState("");
  const [mobileInput, setMobileInput] = useState("");
  const [codexState, setCodexState] = useState<"idle" | "active" | "working" | "waiting">(
    /\bcodex(?:\.exe)?\b/i.test(session.runtime?.currentCommand || "") ? "active" : "idle"
  );
  const isMobileClient = typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches;
  const usesStableZellijWidth = backend === "zellij" || session.backend === "zellij" || session.backend === "auto";
  const backgroundStyle = {
    "--terminal-background-image": backgroundImage ? `url("${backgroundImage}")` : "none"
  } as CSSProperties;

  const refitTerminal = useCallback((force = false) => {
    const terminal = termRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit) {
      return;
    }

    try {
      const proposed = fit.proposeDimensions();
      if (proposed && proposed.cols > 0 && proposed.rows > 0) {
        const next = normalizeTerminalDimensions(proposed);
        if (terminal.cols !== next.cols || terminal.rows !== next.rows) {
          terminal.resize(next.cols, next.rows);
        }
      } else {
        fit.fit();
        const next = normalizeTerminalDimensions({ cols: terminal.cols, rows: terminal.rows });
        if (terminal.cols !== next.cols || terminal.rows !== next.rows) {
          terminal.resize(next.cols, next.rows);
        }
      }

      const socket = socketRef.current;
      if (socket?.connected) {
        emitResize(socket, terminal, force);
      } else {
        sizeRef.current = { cols: terminal.cols, rows: terminal.rows };
      }
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const repairDisplay = useCallback(() => {
    refitTerminal(true);
    window.setTimeout(() => refitTerminal(true), 80);
    window.setTimeout(() => refitTerminal(true), 260);
  }, [refitTerminal]);

  const markCopied = useCallback(() => {
    setCopied(true);
    if (copiedTimerRef.current) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1200);
  }, []);

  const copyTerminalSelection = useCallback(async () => {
    const terminal = termRef.current;
    const selectedText = selectMode
      ? selectedTextInside(selectionLayerRef.current) || selectionSnapshot
      : terminal?.getSelection() ?? "";
    if (!selectedText.trim()) {
      terminal?.focus();
      return;
    }

    await writeClipboardText(selectedText);
    markCopied();
    terminal?.focus();
  }, [markCopied, selectMode, selectionSnapshot]);

  const pasteClipboardToTerminal = useCallback(async () => {
    let focusTerminal = true;
    try {
      const text = await readClipboardText();
      if (text) {
        socketRef.current?.emit("terminal:input", text);
      } else if (isMobileClient) {
        focusTerminal = false;
        mobileInputRef.current?.focus();
      }
    } finally {
      if (focusTerminal) {
        termRef.current?.focus();
      }
    }
  }, [isMobileClient]);

  const toggleSelectMode = useCallback(() => {
    setSelectMode((current) => {
      const next = !current;
      selectModeRef.current = next;
      if (next && termRef.current) {
        setSelectionSnapshot(readTerminalBuffer(termRef.current));
      }
      return next;
    });
  }, []);

  const submitMobileInput = useCallback(() => {
    if (!mobileInput || !socketRef.current?.connected) {
      mobileInputRef.current?.focus();
      return;
    }
    socketRef.current.emit("terminal:input", `${mobileInput}\r`);
    setMobileInput("");
    window.requestAnimationFrame(() => mobileInputRef.current?.focus());
  }, [mobileInput]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isMobileClient) {
      return;
    }

    const bodyOverflow = document.body.style.overflow;
    const htmlOverflow = document.documentElement.style.overflow;
    const bodyOverscroll = document.body.style.overscrollBehavior;

    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    document.body.style.overscrollBehavior = "none";

    return () => {
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = htmlOverflow;
      document.body.style.overscrollBehavior = bodyOverscroll;
    };
  }, [isMobileClient]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const terminal = new Terminal({
      cursorBlink: true,
      allowTransparency: Boolean(backgroundImage),
      allowProposedApi: true,
      rescaleOverlappingGlyphs: true,
      windowsMode: true,
      fontFamily:
        '"JetBrains Mono", "Cascadia Mono", "SFMono-Regular", Consolas, "Noto Sans Mono CJK SC", "Microsoft YaHei Mono", NSimSun, monospace',
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: backgroundImage ? "rgba(17, 22, 20, 0.68)" : "#111614",
        foreground: "#eef2ed",
        cursor: "#f2c94c",
        selectionBackground: "#2f80ed66"
      },
      scrollback: 50000
    });
    const fit = new FitAddon();
    const unicode11 = new Unicode11Addon();
    terminal.loadAddon(fit);
    terminal.loadAddon(unicode11);
    terminal.unicode.activeVersion = "11";
    terminal.open(host);
    termRef.current = terminal;
    fitRef.current = fit;
    refitTerminal(true);
    terminal.clear();
    terminal.refresh(0, terminal.rows - 1);
    sizeRef.current = { cols: terminal.cols, rows: terminal.rows };

    const socket = io({
      withCredentials: true,
      query: {
        sessionId: session.id,
        cols: terminal.cols,
        rows: terminal.rows,
        clientProfile: isMobileClient ? "mobile" : "desktop"
      }
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setStatus("connected");
      refitTerminal(true);
    });
    socket.on("terminal:ready", (payload: { attachCommand: string | null; backend?: string }) => {
      setAttachCommand(payload.attachCommand);
      if (payload.backend) {
        setBackend(payload.backend as "zellij");
      }
      window.setTimeout(() => refitTerminal(true), 0);
    });
    socket.on("terminal:data", (data: string) => {
      terminal.write(data, () => {
        const bufferText = readTerminalBuffer(terminal, selectModeRef.current ? 2000 : 120);
        updateCodexState(bufferText);
        if (selectModeRef.current) {
          setSelectionSnapshot(bufferText);
        }
      });
    });
    socket.on("terminal:resized", (size: { cols?: number; rows?: number; seq?: number }) => {
      if (typeof size.seq === "number") {
        if (size.seq < lastAckSeqRef.current) {
          return;
        }
        lastAckSeqRef.current = size.seq;
      }
      const local = sizeRef.current;
      const ackCols = Number(size.cols);
      const ackRows = Number(size.rows);
      if (!Number.isFinite(ackCols) || !Number.isFinite(ackRows)) {
        return;
      }
      if (!local || ackCols !== local.cols || ackRows !== local.rows) {
        applyingServerResizeRef.current = true;
        try {
          terminal.resize(ackCols, ackRows);
        } finally {
          applyingServerResizeRef.current = false;
        }
        sizeRef.current = { cols: ackCols, rows: ackRows };
        terminal.refresh(0, Math.max(0, terminal.rows - 1));
        return;
      }
      terminal.refresh(0, Math.max(0, terminal.rows - 1));
    });
    socket.on("terminal:error", (message: string) => {
      setStatus(message);
      terminal.writeln(`\r\n[terminal error] ${message}`);
    });
    socket.on("terminal:exit", () => {
      setStatus("detached");
    });
    socket.on("disconnect", () => {
      setStatus("disconnected");
    });

    const disposable = terminal.onData((data) => {
      socket.emit("terminal:input", data);
    });
    const resizeDisposable = terminal.onResize(() => {
      if (socket.connected && !applyingServerResizeRef.current) {
        emitResize(socket, terminal);
      }
    });
    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text");
      if (!text) {
        return;
      }
      event.preventDefault();
      socket.emit("terminal:input", text);
    };
    host.addEventListener("paste", handlePaste);

    let disposed = false;
    const timers: number[] = [];
    const later = (delay: number, force = true) => {
      timers.push(
        window.setTimeout(() => {
          if (!disposed) {
            refitTerminal(force);
          }
        }, delay)
      );
    };
    const scheduleResize = () => {
      window.requestAnimationFrame(() => {
        if (disposed) {
          return;
        }
        refitTerminal();
        later(80);
      });
    };
    let lastMeasured = "";
    const checkMeasuredSize = () => {
      const rect = host.getBoundingClientRect();
      const measured = `${Math.round(rect.width)}x${Math.round(rect.height)}@${window.devicePixelRatio}`;
      if (measured !== lastMeasured) {
        lastMeasured = measured;
        scheduleResize();
      }
    };
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(host);
    window.addEventListener("resize", scheduleResize);
    window.visualViewport?.addEventListener("resize", scheduleResize);
    const sizeTimer = window.setInterval(checkMeasuredSize, 500);
    later(120);
    later(350);

    return () => {
      disposed = true;
      timers.forEach((timer) => window.clearTimeout(timer));
      observer.disconnect();
      window.removeEventListener("resize", scheduleResize);
      window.visualViewport?.removeEventListener("resize", scheduleResize);
      window.clearInterval(sizeTimer);
      disposable.dispose();
      resizeDisposable.dispose();
      host.removeEventListener("paste", handlePaste);
      socket.disconnect();
      terminal.dispose();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      if (termRef.current === terminal) {
        termRef.current = null;
      }
      if (fitRef.current === fit) {
        fitRef.current = null;
      }
    };
  }, [backgroundImage, isMobileClient, refitTerminal, session.id, usesStableZellijWidth]);

  return (
    <div
      className={[
        "terminal-dock",
        isMobileClient ? "mobile-terminal" : "",
        usesStableZellijWidth ? "stable-width-terminal" : ""
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <header className="terminal-header">
        <div className="terminal-title">
          <strong>
            <span className={`codex-status-light terminal-codex-light ${codexState}`} title={`Codex: ${codexStateLabel(codexState)}`}>
              <span />
            </span>
            {session.name}
          </strong>
          <span>{session.runtime?.currentPath || session.cwd}</span>
        </div>
        <div className="terminal-actions">
          {attachCommand ? (
            <>
              <code>{attachCommand}</code>
              <button
                className="icon-button attach-command-copy"
                type="button"
                title="复制本机 attach 命令"
                onClick={() => void writeClipboardText(attachCommand)}
              >
                <Clipboard size={17} />
              </button>
            </>
          ) : (
            <code>{backend} pty</code>
          )}
          <span className="terminal-status">{status}</span>
          <button
            className={selectMode ? "icon-button active" : "icon-button"}
            type="button"
            title={selectMode ? "关闭文本选择" : "选择终端文本"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggleSelectMode}
          >
            <TextCursorInput size={17} />
          </button>
          <button
            className="icon-button"
            type="button"
            title={copied ? "Copied" : "Copy selected terminal text"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void copyTerminalSelection()}
          >
            {copied ? <Check size={17} /> : <Clipboard size={17} />}
          </button>
          <button
            className="icon-button"
            type="button"
            title="Paste clipboard to terminal"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void pasteClipboardToTerminal()}
          >
            <ClipboardPaste size={17} />
          </button>
          <button className="icon-button" type="button" title="修复显示" onClick={repairDisplay}>
            <RefreshCw size={17} />
          </button>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
      </header>
      <div className="terminal-host" style={backgroundStyle}>
        <div className="terminal-canvas-host" ref={hostRef} />
        {selectMode && (
          <pre className="terminal-selection-layer" ref={selectionLayerRef}>
            {selectionSnapshot}
          </pre>
        )}
      </div>
      {isMobileClient && (
        <form
          className="mobile-terminal-input"
          onSubmit={(event) => {
            event.preventDefault();
            submitMobileInput();
          }}
        >
          <textarea
            ref={mobileInputRef}
            rows={1}
            value={mobileInput}
            onChange={(event) => setMobileInput(event.target.value)}
            placeholder="输入或长按粘贴"
          />
          <button className="icon-button" type="button" title="粘贴" onClick={() => void pasteClipboardToTerminal()}>
            <ClipboardPaste size={18} />
          </button>
          <button className="icon-button" type="submit" title="发送" disabled={!mobileInput}>
            <Send size={18} />
          </button>
        </form>
      )}
    </div>
  );

  function emitResize(socket: Socket, terminal: Terminal, force = false) {
    const next = normalizeTerminalDimensions({ cols: terminal.cols, rows: terminal.rows });
    const previous = sizeRef.current;
    if (!force && previous?.cols === next.cols && previous?.rows === next.rows) {
      return;
    }
    sizeRef.current = next;
    resizeSeqRef.current += 1;
    socket.emit("terminal:resize", { ...next, seq: resizeSeqRef.current });
  }

  function updateCodexState(data: string) {
    const output = stripAnsi(data).slice(-6000);
    const active =
      codexState !== "idle" ||
      /\bcodex(?:\.exe)?\b/i.test(session.runtime?.currentCommand || "") ||
      /OpenAI Codex|codex-cli|codex resume|YOLO mode|esc to interrupt|Implement \{feature\}|gpt-[\w.-]+\s+(?:low|medium|high)/i.test(
        output
      );
    if (!active) {
      return;
    }
    if (/esc to interrupt|working(?:\s|\.)|running tool|thinking|处理中|工作中/i.test(output)) {
      setCodexState("working");
    } else if (/waiting for|awaiting|等待输入|›\s*$/im.test(output)) {
      setCodexState("waiting");
    } else {
      setCodexState("active");
    }
  }
}

function normalizeTerminalDimensions(value: { cols: number; rows: number }): { cols: number; rows: number } {
  return {
    cols: value.cols,
    rows: value.rows
  };
}

function readTerminalBuffer(terminal: Terminal, maxLines = 2000): string {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.length - maxLines);
  const logicalLines: string[] = [];
  let current = "";
  let started = false;
  for (let index = start; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) {
      continue;
    }
    const text = line.translateToString(true);
    if (line.isWrapped && started) {
      current += text;
    } else {
      if (started) {
        logicalLines.push(current);
      }
      current = text;
      started = true;
    }
  }
  if (started) {
    logicalLines.push(current);
  }
  return logicalLines.join("\n").trimEnd();
}

function selectedTextInside(root: HTMLElement | null): string {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) {
    return "";
  }
  const range = selection.getRangeAt(0);
  return root.contains(range.startContainer) || root.contains(range.endContainer) ? selection.toString() : "";
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function codexStateLabel(state: "idle" | "active" | "working" | "waiting"): string {
  if (state === "working") {
    return "工作中";
  }
  if (state === "waiting") {
    return "等待输入";
  }
  if (state === "active") {
    return "已启动";
  }
  return "未启动";
}
