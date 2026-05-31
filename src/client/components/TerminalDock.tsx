import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { io, type Socket } from "socket.io-client";
import { Check, Clipboard, ClipboardPaste, RefreshCw, X } from "lucide-react";
import type { TerminalSession } from "../../shared/types";
import { api } from "../api";
import { filesFromClipboardData, readClipboardFiles, readClipboardText, writeClipboardText } from "../clipboard";

interface Props {
  session: TerminalSession;
  onClose: () => void;
}

const MOBILE_QUERY = "(max-width: 720px)";
const ZELLIJ_WEB_COLS = 120;
const ZELLIJ_WEB_ROWS = 36;

export function TerminalDock({ session, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeSeqRef = useRef(0);
  const lastAckSeqRef = useRef(0);
  const resizeRetryRef = useRef(0);
  const copiedTimerRef = useRef<number | null>(null);
  const uploadingRef = useRef(false);
  const [attachCommand, setAttachCommand] = useState<string | null>(null);
  const [backend, setBackend] = useState(session.runtime?.backend ?? session.backend);
  const [status, setStatus] = useState("connecting");
  const [copied, setCopied] = useState(false);
  const [uploading, setUploading] = useState(false);
  const isMobileClient = typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches;
  const usesStableZellijWidth =
    !isMobileClient && (backend === "zellij" || session.backend === "zellij" || session.backend === "auto");

  const refitTerminal = useCallback((force = false) => {
    const terminal = termRef.current;
    const fit = fitRef.current;
    if (!terminal || !fit) {
      return;
    }

    try {
      const proposed = fit.proposeDimensions();
      if (proposed && proposed.cols > 0 && proposed.rows > 0) {
        const next = normalizeTerminalDimensions(proposed, usesStableZellijWidth);
        if (terminal.cols !== next.cols || terminal.rows !== next.rows) {
          terminal.resize(next.cols, next.rows);
        }
      } else {
        fit.fit();
        const next = normalizeTerminalDimensions({ cols: terminal.cols, rows: terminal.rows }, usesStableZellijWidth);
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
  }, [usesStableZellijWidth]);

  const repairDisplay = useCallback(() => {
    resizeRetryRef.current = 0;
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
    const selectedText = terminal?.getSelection() ?? "";
    if (!selectedText.trim()) {
      terminal?.focus();
      return;
    }

    await writeClipboardText(selectedText);
    markCopied();
    terminal?.focus();
  }, [markCopied]);

  const pasteFilesToTerminal = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || uploadingRef.current) {
        termRef.current?.focus();
        return;
      }

      uploadingRef.current = true;
      setUploading(true);
      try {
        const result = await api.uploadSessionFiles(session.id, files);
        if (result.terminalText) {
          socketRef.current?.emit("terminal:input", result.terminalText);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        uploadingRef.current = false;
        setUploading(false);
        termRef.current?.focus();
      }
    },
    [session.id]
  );

  const pasteClipboardToTerminal = useCallback(async () => {
    try {
      const files = await readClipboardFiles().catch(() => []);
      if (files.length > 0) {
        await pasteFilesToTerminal(files);
        return;
      }

      const text = await readClipboardText();
      if (text) {
        socketRef.current?.emit("terminal:input", text);
      }
    } finally {
      termRef.current?.focus();
    }
  }, [pasteFilesToTerminal]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) {
        window.clearTimeout(copiedTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const handlePaste = (event: ClipboardEvent) => {
      const files = filesFromClipboardData(event.clipboardData);
      if (files.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void pasteFilesToTerminal(files);
    };
    host.addEventListener("paste", handlePaste, true);

    const terminal = new Terminal({
      cursorBlink: true,
      allowProposedApi: true,
      rescaleOverlappingGlyphs: true,
      windowsMode: true,
      fontFamily:
        '"JetBrains Mono", "Cascadia Mono", "SFMono-Regular", Consolas, "Noto Sans Mono CJK SC", "Microsoft YaHei Mono", NSimSun, monospace',
      fontSize: isMobileClient ? 13 : 14,
      lineHeight: isMobileClient ? 1.18 : 1.2,
      theme: {
        background: "#111614",
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
      terminal.write(data);
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
        if (resizeRetryRef.current < 5) {
          resizeRetryRef.current += 1;
          window.setTimeout(() => refitTerminal(true), 80);
        } else if (ackCols > 0 && ackRows > 0) {
          terminal.resize(ackCols, ackRows);
          sizeRef.current = { cols: ackCols, rows: ackRows };
          terminal.refresh(0, Math.max(0, terminal.rows - 1));
        }
        return;
      }
      resizeRetryRef.current = 0;
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

    const inputFilter = createTerminalInputFilter();
    const disposable = terminal.onData((data) => {
      const filtered = inputFilter(data);
      if (filtered) {
        socket.emit("terminal:input", filtered);
      }
    });
    const resizeDisposable = terminal.onResize(() => {
      if (socket.connected) {
        emitResize(socket, terminal);
      }
    });

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
      host.removeEventListener("paste", handlePaste, true);
      window.removeEventListener("resize", scheduleResize);
      window.visualViewport?.removeEventListener("resize", scheduleResize);
      window.clearInterval(sizeTimer);
      disposable.dispose();
      resizeDisposable.dispose();
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
  }, [isMobileClient, pasteFilesToTerminal, refitTerminal, session.id, usesStableZellijWidth]);

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
          <strong>{session.name}</strong>
          <span>{session.runtime?.currentPath || session.cwd}</span>
        </div>
        <div className="terminal-actions">
          {attachCommand ? (
            <>
              <code>{attachCommand}</code>
              <button
                className="icon-button"
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
          <span className="terminal-status">{uploading ? "uploading" : status}</span>
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
      <div className="terminal-host" ref={hostRef} />
    </div>
  );

  function emitResize(socket: Socket, terminal: Terminal, force = false) {
    const next = normalizeTerminalDimensions({ cols: terminal.cols, rows: terminal.rows }, usesStableZellijWidth);
    const previous = sizeRef.current;
    if (!force && previous?.cols === next.cols && previous?.rows === next.rows) {
      return;
    }
    sizeRef.current = next;
    resizeSeqRef.current += 1;
    socket.emit("terminal:resize", { ...next, seq: resizeSeqRef.current });
  }
}

function normalizeTerminalDimensions(
  value: { cols: number; rows: number },
  stableZellijWidth: boolean
): { cols: number; rows: number } {
  if (stableZellijWidth) {
    return {
      cols: ZELLIJ_WEB_COLS,
      rows: ZELLIJ_WEB_ROWS
    };
  }

  return {
    cols: value.cols,
    rows: value.rows
  };
}

function createTerminalInputFilter(): (data: string) => string {
  let pending = "";
  return (data: string) => {
    const result = stripPaletteReports(`${pending}${data}`);
    pending = result.pending;
    return result.output;
  };
}

function stripPaletteReports(data: string): { output: string; pending: string } {
  let output = "";
  let index = 0;

  while (index < data.length) {
    if (data[index] !== "\x1b" || data[index + 1] !== "]") {
      output += data[index];
      index += 1;
      continue;
    }

    const terminator = findOscTerminator(data, index + 2);
    if (!terminator) {
      const rest = data.slice(index);
      if (isPaletteReportPrefix(rest)) {
        return { output, pending: rest };
      }
      output += data[index];
      index += 1;
      continue;
    }

    const sequence = data.slice(index, terminator.end);
    if (!isPaletteReport(sequence)) {
      output += sequence;
    }
    index = terminator.end;
  }

  return { output, pending: "" };
}

function findOscTerminator(data: string, start: number): { end: number } | null {
  for (let index = start; index < data.length; index += 1) {
    if (data[index] === "\x07") {
      return { end: index + 1 };
    }
    if (data[index] === "\x1b" && data[index + 1] === "\\") {
      return { end: index + 2 };
    }
  }
  return null;
}

function isPaletteReportPrefix(value: string): boolean {
  return /^\x1b\](?:4(?:;\d+(?:;rgb:[0-9a-fA-F/]*)?)*|1[012](?:;rgb:[0-9a-fA-F/]*)?)?$/.test(value);
}

function isPaletteReport(sequence: string): boolean {
  const body = sequence.replace(/^\x1b\]/, "").replace(/(?:\x07|\x1b\\)$/, "");
  const rgb = "[0-9a-fA-F]{2,4}/[0-9a-fA-F]{2,4}/[0-9a-fA-F]{2,4}";
  return (
    new RegExp(`^4(?:;\\d+;rgb:${rgb})+$`).test(body) ||
    new RegExp(`^1[012];rgb:${rgb}$`).test(body)
  );
}
