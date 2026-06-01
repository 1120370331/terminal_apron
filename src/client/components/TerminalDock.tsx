import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { io, type Socket } from "socket.io-client";
import { ArrowDownToLine, Check, Clipboard, ClipboardPaste, History, RefreshCw, X } from "lucide-react";
import type { TerminalSession } from "../../shared/types";
import { api } from "../api";
import { filesFromClipboardData, readClipboardFiles, readClipboardText, writeClipboardText } from "../clipboard";
import {
  TERMINAL_PROTOCOL_VERSION,
  type TerminalDataKind,
  type TerminalProtocolVersion,
  isProtocolV2Ready,
  normalizeTerminalData,
  normalizeTerminalError,
  normalizeTerminalFlow,
  normalizeTerminalHistoryChunk,
  normalizeTerminalHistoryInit,
  normalizeTerminalInputAck,
  normalizeTerminalReady,
  normalizeTerminalState
} from "../terminalProtocol";

interface Props {
  session: TerminalSession;
  visible: boolean;
  onClose: () => void;
}

const MOBILE_QUERY = "(max-width: 720px)";
const ZELLIJ_WEB_COLS = 120;
const ZELLIJ_WEB_ROWS = 36;
const TERMINAL_SCROLLBACK_ROWS = 200_000;
const TERMINAL_INPUT_BATCH_MS = 12;
const TERMINAL_WRITE_CHUNK_CHARS = 8192;
const TERMINAL_HISTORY_REQUEST_LINES = 800;
const TERMINAL_HISTORY_REQUEST_MAX_BYTES = 256_000;
const TERMINAL_HISTORY_PREVIEW_MAX_CHARS = 80_000;

type LatestHistoryStatus = "waiting" | "loading" | "ready" | "error";
type OlderHistoryStatus = "idle" | "loading" | "ready" | "exhausted" | "error";
type TerminalWriteKind = "latest" | TerminalDataKind;

interface TerminalHistoryMeta {
  latest: LatestHistoryStatus;
  older: OlderHistoryStatus;
  canLoadOlder: boolean;
  hasMoreBefore: boolean;
  olderLoadedBytes: number;
}

interface TerminalFlowMeta {
  paused: boolean;
  reason?: string;
}

interface TerminalHistoryCursor {
  oldestLine?: number;
  newestLine?: number;
  beforeOffset?: number;
}

interface TerminalWriteItem {
  chunks: string[];
  chunkIndex: number;
  kind: TerminalWriteKind;
  seq?: number;
  streamId?: string;
  onComplete?: () => void;
}

export function TerminalDock({ session, visible, onClose }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const clientIdRef = useRef(makeTerminalClientId(session.id));
  const protocolVersionRef = useRef<TerminalProtocolVersion>(1);
  const streamIdRef = useRef<string | null>(null);
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeSeqRef = useRef(0);
  const resizeAckSeqRef = useRef(0);
  const lastAckSeqRef = useRef(0);
  const resizeRetryRef = useRef(0);
  const copiedTimerRef = useRef<number | null>(null);
  const inputBufferRef = useRef("");
  const inputFlushTimerRef = useRef<number | null>(null);
  const latestWriteQueueRef = useRef<TerminalWriteItem[]>([]);
  const liveWriteQueueRef = useRef<TerminalWriteItem[]>([]);
  const historyWriteQueueRef = useRef<TerminalWriteItem[]>([]);
  const currentWriteRef = useRef<TerminalWriteItem | null>(null);
  const writeInProgressRef = useRef(false);
  const writeTimerRef = useRef<number | null>(null);
  const writeQueueBytesRef = useRef(0);
  const uploadingRef = useRef(false);
  const inputSeqRef = useRef(0);
  const pendingInputIdsRef = useRef<Set<string>>(new Set());
  const historyCursorRef = useRef<TerminalHistoryCursor>({});
  const activeHistoryRequestRef = useRef<string | null>(null);
  const hasMoreBeforeRef = useRef(false);
  const historyLoadingRef = useRef(false);
  const atBottomRef = useRef(true);
  const receivedHistoryInitRef = useRef(false);
  const [attachCommand, setAttachCommand] = useState<string | null>(null);
  const [backend, setBackend] = useState(session.runtime?.backend ?? session.backend);
  const [status, setStatus] = useState("connecting");
  const [copied, setCopied] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [writeQueueBytes, setWriteQueueBytes] = useState(0);
  const [pendingInputCount, setPendingInputCount] = useState(0);
  const [newOutputAvailable, setNewOutputAvailable] = useState(false);
  const [historyPreviewOpen, setHistoryPreviewOpen] = useState(false);
  const [olderHistoryPreview, setOlderHistoryPreview] = useState("");
  const [flowMeta, setFlowMeta] = useState<TerminalFlowMeta>({ paused: false });
  const [historyMeta, setHistoryMeta] = useState<TerminalHistoryMeta>({
    latest: "waiting",
    older: "idle",
    canLoadOlder: false,
    hasMoreBefore: false,
    olderLoadedBytes: 0
  });
  const isMobileClient = typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches;
  const usesStableZellijWidth =
    !isMobileClient && (backend === "zellij" || session.backend === "zellij" || session.backend === "auto");

  const updateWriteQueueBytes = useCallback((delta: number) => {
    writeQueueBytesRef.current = Math.max(0, writeQueueBytesRef.current + delta);
    setWriteQueueBytes(writeQueueBytesRef.current);
  }, []);

  const sendTerminalAck = useCallback(
    (seq?: number, streamId?: string) => {
      if (typeof seq !== "number") {
        return;
      }

      lastAckSeqRef.current = Math.max(lastAckSeqRef.current, seq);
      const socket = socketRef.current;
      if (!socket?.connected) {
        return;
      }

      socket.emit("terminal:ack", {
        sessionId: session.id,
        streamId: streamId || streamIdRef.current || "",
        seq,
        renderedAt: Date.now(),
        writeQueueBytes: writeQueueBytesRef.current
      });
    },
    [session.id]
  );

  const emitTerminalInput = useCallback(
    (data: string, mode: "type" | "paste" = "type") => {
      const socket = socketRef.current;
      if (!socket?.connected) {
        setStatus("disconnected");
        return;
      }

      if (protocolVersionRef.current >= TERMINAL_PROTOCOL_VERSION) {
        inputSeqRef.current += 1;
        const inputId = `${clientIdRef.current}-${inputSeqRef.current}`;
        pendingInputIdsRef.current.add(inputId);
        setPendingInputCount(pendingInputIdsRef.current.size);
        socket.emit("terminal:input", {
          sessionId: session.id,
          inputId,
          data,
          mode
        });
        return;
      }

      socket.emit("terminal:input", data);
    },
    [session.id]
  );

  const cancelHistoryRequest = useCallback(
    (nextStatus: OlderHistoryStatus = "idle") => {
      const requestId = activeHistoryRequestRef.current;
      if (!requestId) {
        return;
      }

      activeHistoryRequestRef.current = null;
      historyLoadingRef.current = false;
      socketRef.current?.emit("terminal:history:cancel", {
        sessionId: session.id,
        requestId
      });
      setHistoryMeta((current) => ({ ...current, older: nextStatus }));
    },
    [session.id]
  );

  const requestOlderHistory = useCallback(
    (source: "button" | "scroll" = "button") => {
      const socket = socketRef.current;
      if (!socket?.connected || historyLoadingRef.current || !hasMoreBeforeRef.current) {
        return;
      }

      const requestId = `${clientIdRef.current}-history-${Date.now()}-${source}`;
      activeHistoryRequestRef.current = requestId;
      historyLoadingRef.current = true;
      setHistoryMeta((current) => ({ ...current, older: "loading" }));
      if (source === "button") {
        setHistoryPreviewOpen(true);
      }
      socket.emit("terminal:history:request", {
        sessionId: session.id,
        requestId,
        beforeLine: historyCursorRef.current.oldestLine,
        beforeOffset: historyCursorRef.current.beforeOffset,
        limitLines: TERMINAL_HISTORY_REQUEST_LINES,
        maxBytes: TERMINAL_HISTORY_REQUEST_MAX_BYTES,
        format: "ansi"
      });
    },
    [session.id]
  );

  const jumpToLiveOutput = useCallback(() => {
    const terminal = termRef.current;
    if (!terminal) {
      return;
    }
    terminal.scrollToBottom();
    atBottomRef.current = true;
    setNewOutputAvailable(false);
    terminal.focus();
    socketRef.current?.emit("terminal:visibility", {
      sessionId: session.id,
      visible,
      atBottom: true
    });
  }, [session.id, visible]);

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

  const flushTerminalInput = useCallback(() => {
    if (inputFlushTimerRef.current) {
      window.clearTimeout(inputFlushTimerRef.current);
      inputFlushTimerRef.current = null;
    }

    const data = inputBufferRef.current;
    if (!data) {
      return;
    }

    inputBufferRef.current = "";
    emitTerminalInput(data, "type");
  }, [emitTerminalInput]);

  const sendTerminalInput = useCallback(
    (data: string) => {
      if (!data) {
        return;
      }

      if (shouldSendTerminalInputImmediately(data)) {
        flushTerminalInput();
        emitTerminalInput(data, data.length > 1 ? "paste" : "type");
        return;
      }

      inputBufferRef.current += data;
      if (!inputFlushTimerRef.current) {
        inputFlushTimerRef.current = window.setTimeout(flushTerminalInput, TERMINAL_INPUT_BATCH_MS);
      }
    },
    [emitTerminalInput, flushTerminalInput]
  );

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
          sendTerminalInput(result.terminalText);
        }
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error));
      } finally {
        uploadingRef.current = false;
        setUploading(false);
        termRef.current?.focus();
      }
    },
    [sendTerminalInput, session.id]
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
        sendTerminalInput(text);
      }
    } finally {
      termRef.current?.focus();
    }
  }, [pasteFilesToTerminal, sendTerminalInput]);

  const recordOlderHistoryPreview = useCallback((ansi: string) => {
    if (!ansi) {
      return 0;
    }

    const byteLength = utf8ByteLength(ansi);
    const plain = stripAnsiForHistoryPreview(ansi);
    setOlderHistoryPreview((current) => trimHistoryPreview(`${current}${plain}`));
    return byteLength;
  }, []);

  const pumpTerminalWrites = useCallback(
    function pump(terminal: Terminal): void {
      let item = currentWriteRef.current;
      if (!item) {
        item =
          latestWriteQueueRef.current.shift() ??
          liveWriteQueueRef.current.shift() ??
          historyWriteQueueRef.current.shift() ??
          null;
        currentWriteRef.current = item;
      }

      if (!item) {
        writeInProgressRef.current = false;
        return;
      }

      const chunk = item.chunks[item.chunkIndex];
      if (!chunk) {
        currentWriteRef.current = null;
        item.onComplete?.();
        sendTerminalAck(item.seq, item.streamId);
        writeTimerRef.current = window.setTimeout(() => {
          writeTimerRef.current = null;
          pump(terminal);
        }, 0);
        return;
      }

      item.chunkIndex += 1;
      try {
        terminal.write(chunk, () => {
          updateWriteQueueBytes(-utf8ByteLength(chunk));

          if (item.chunkIndex >= item.chunks.length) {
            currentWriteRef.current = null;
            item.onComplete?.();
            sendTerminalAck(item.seq, item.streamId);
          } else if (
            item.kind === "history" &&
            (latestWriteQueueRef.current.length > 0 || liveWriteQueueRef.current.length > 0)
          ) {
            currentWriteRef.current = null;
            historyWriteQueueRef.current.unshift(item);
          }

          writeTimerRef.current = window.setTimeout(() => {
            writeTimerRef.current = null;
            pump(terminal);
          }, 0);
        });
      } catch {
        latestWriteQueueRef.current = [];
        liveWriteQueueRef.current = [];
        historyWriteQueueRef.current = [];
        currentWriteRef.current = null;
        writeInProgressRef.current = false;
        updateWriteQueueBytes(-writeQueueBytesRef.current);
      }
    },
    [sendTerminalAck, updateWriteQueueBytes]
  );

  const enqueueTerminalWrite = useCallback(
    (
      terminal: Terminal,
      data: string,
      options: { kind?: TerminalWriteKind; seq?: number; streamId?: string; onComplete?: () => void } = {}
    ) => {
      if (!data) {
        options.onComplete?.();
        sendTerminalAck(options.seq, options.streamId);
        return;
      }

      const item: TerminalWriteItem = {
        chunks: chunkTerminalWrite(data),
        chunkIndex: 0,
        kind: options.kind ?? "live",
        seq: options.seq,
        streamId: options.streamId,
        onComplete: options.onComplete
      };
      updateWriteQueueBytes(utf8ByteLength(data));

      if (item.kind === "latest") {
        latestWriteQueueRef.current.push(item);
      } else if (item.kind === "history") {
        historyWriteQueueRef.current.push(item);
      } else {
        liveWriteQueueRef.current.push(item);
      }

      if (!writeInProgressRef.current) {
        writeInProgressRef.current = true;
        pumpTerminalWrites(terminal);
      }
    },
    [pumpTerminalWrites, sendTerminalAck, updateWriteQueueBytes]
  );

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current) {
        window.clearTimeout(copiedTimerRef.current);
      }
      if (inputFlushTimerRef.current) {
        window.clearTimeout(inputFlushTimerRef.current);
      }
      if (writeTimerRef.current) {
        window.clearTimeout(writeTimerRef.current);
      }
      latestWriteQueueRef.current = [];
      liveWriteQueueRef.current = [];
      historyWriteQueueRef.current = [];
      currentWriteRef.current = null;
      writeQueueBytesRef.current = 0;
      writeInProgressRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!visible) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && hostRef.current?.contains(active)) {
        active.blur();
      }
      cancelHistoryRequest("idle");
      socketRef.current?.emit("terminal:visibility", {
        sessionId: session.id,
        visible: false,
        atBottom: atBottomRef.current
      });
      return;
    }

    socketRef.current?.emit("terminal:visibility", {
      sessionId: session.id,
      visible: true,
      atBottom: atBottomRef.current
    });
    refitTerminal(true);
    termRef.current?.focus();
    const timers = [
      window.setTimeout(() => refitTerminal(true), 80),
      window.setTimeout(() => refitTerminal(true), 260)
    ];
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [cancelHistoryRequest, refitTerminal, session.id, visible]);

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
      scrollback: TERMINAL_SCROLLBACK_ROWS
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
      transports: ["websocket", "polling"],
      rememberUpgrade: true,
      query: {
        protocolVersion: String(TERMINAL_PROTOCOL_VERSION),
        sessionId: session.id,
        clientId: clientIdRef.current,
        cols: terminal.cols,
        rows: terminal.rows,
        clientProfile: isMobileClient ? "mobile" : "desktop",
        mode: "interactive",
        lastAckSeq: String(lastAckSeqRef.current),
        historyPolicy: "viewport",
        tailLines: "500"
      }
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setStatus("connected");
      socket.emit("terminal:visibility", {
        sessionId: session.id,
        visible,
        atBottom: atBottomRef.current
      });
      refitTerminal(true);
    });
    socket.on("terminal:ready", (payload: unknown) => {
      const frame = normalizeTerminalReady(payload);
      protocolVersionRef.current = isProtocolV2Ready(frame) ? 2 : 1;
      streamIdRef.current = frame.streamId ?? streamIdRef.current;
      setAttachCommand(frame.attachCommand ?? null);
      if (frame.backend) {
        setBackend(frame.backend as "zellij");
      }
      hasMoreBeforeRef.current = Boolean(frame.canLoadOlderHistory);
      setHistoryMeta((current) => ({
        ...current,
        latest: protocolVersionRef.current >= 2 ? "loading" : "ready",
        canLoadOlder: Boolean(frame.canLoadOlderHistory),
        hasMoreBefore: Boolean(frame.canLoadOlderHistory)
      }));
      setStatus(protocolVersionRef.current >= 2 ? "loading latest screen" : "connected");
      window.setTimeout(() => refitTerminal(true), 0);
    });
    socket.on("terminal:history:init", (payload: unknown) => {
      const frame = normalizeTerminalHistoryInit(payload);
      if (!frame) {
        return;
      }
      streamIdRef.current = frame.streamId ?? streamIdRef.current;
      historyCursorRef.current = {
        oldestLine: frame.oldestLine,
        newestLine: frame.newestLine
      };
      hasMoreBeforeRef.current = frame.hasMoreBefore;
      receivedHistoryInitRef.current = true;
      setHistoryMeta((current) => ({
        ...current,
        latest: "loading",
        canLoadOlder: current.canLoadOlder || frame.hasMoreBefore,
        hasMoreBefore: frame.hasMoreBefore,
        older: frame.hasMoreBefore ? current.older : "exhausted"
      }));

      const latestAnsi = `${frame.tailAnsi ?? ""}${frame.viewportAnsi}`;
      terminal.clear();
      enqueueTerminalWrite(terminal, latestAnsi, {
        kind: "latest",
        seq: frame.snapshotSeq,
        streamId: frame.streamId,
        onComplete: () => {
          setHistoryMeta((current) => ({ ...current, latest: "ready" }));
          setStatus("live");
          terminal.scrollToBottom();
          atBottomRef.current = true;
          setNewOutputAvailable(false);
        }
      });
    });
    socket.on("terminal:history:chunk", (payload: unknown) => {
      const frame = normalizeTerminalHistoryChunk(payload);
      if (!frame) {
        return;
      }
      if (frame.requestId && activeHistoryRequestRef.current && frame.requestId !== activeHistoryRequestRef.current) {
        return;
      }

      const loadedBytes = recordOlderHistoryPreview(frame.ansi);
      historyCursorRef.current = {
        ...historyCursorRef.current,
        oldestLine: frame.fromLine ?? historyCursorRef.current.oldestLine,
        beforeOffset: frame.fromOffset ?? historyCursorRef.current.beforeOffset
      };
      activeHistoryRequestRef.current = null;
      historyLoadingRef.current = false;
      hasMoreBeforeRef.current = frame.hasMoreBefore;
      setHistoryMeta((current) => ({
        ...current,
        olderLoadedBytes: current.olderLoadedBytes + loadedBytes,
        older: frame.hasMoreBefore ? "ready" : "exhausted",
        hasMoreBefore: frame.hasMoreBefore,
        canLoadOlder: current.canLoadOlder || frame.hasMoreBefore
      }));
    });
    socket.on("terminal:data", (payload: unknown) => {
      const frame = normalizeTerminalData(payload);
      if (!frame) {
        return;
      }

      streamIdRef.current = frame.streamId ?? streamIdRef.current;
      if (frame.kind === "history") {
        const loadedBytes = recordOlderHistoryPreview(frame.data);
        setHistoryMeta((current) => ({
          ...current,
          olderLoadedBytes: current.olderLoadedBytes + loadedBytes,
          older: "ready"
        }));
        return;
      }

      if (!atBottomRef.current) {
        setNewOutputAvailable(true);
      }
      setStatus("live");
      setHistoryMeta((current) => ({
        ...current,
        latest: receivedHistoryInitRef.current ? current.latest : "ready"
      }));
      enqueueTerminalWrite(terminal, frame.data, {
        kind: "live",
        seq: frame.seq,
        streamId: frame.streamId
      });
    });
    socket.on("terminal:state", (payload: unknown) => {
      const frame = normalizeTerminalState(payload);
      if (!frame) {
        return;
      }
      setStatus(frame.state);
    });
    socket.on("terminal:flow", (payload: unknown) => {
      const frame = normalizeTerminalFlow(payload);
      if (!frame) {
        return;
      }
      setFlowMeta({ paused: frame.paused, reason: frame.reason });
      setHistoryMeta((current) => ({
        ...current,
        older: frame.paused && current.older === "loading" ? "idle" : current.older
      }));
    });
    socket.on("terminal:input:ack", (payload: unknown) => {
      const frame = normalizeTerminalInputAck(payload);
      if (!frame) {
        return;
      }
      if (frame.inputId) {
        pendingInputIdsRef.current.delete(frame.inputId);
        setPendingInputCount(pendingInputIdsRef.current.size);
      }
      if (!frame.accepted) {
        setStatus(frame.message || "input rejected");
      }
    });
    socket.on("terminal:resized", (size: { cols?: number; rows?: number; seq?: number }) => {
      if (typeof size.seq === "number") {
        if (size.seq < resizeAckSeqRef.current) {
          return;
        }
        resizeAckSeqRef.current = size.seq;
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
    socket.on("terminal:error", (payload: unknown) => {
      const error = normalizeTerminalError(payload);
      setStatus(error.message);
      setHistoryMeta((current) => ({ ...current, latest: current.latest === "ready" ? "ready" : "error" }));
      terminal.writeln(`\r\n[terminal error] ${error.message}`);
    });
    socket.on("terminal:exit", () => {
      setStatus("detached");
    });
    socket.on("disconnect", () => {
      setStatus("disconnected");
      setFlowMeta({ paused: false });
    });

    const inputFilter = createTerminalInputFilter();
    const disposable = terminal.onData((data) => {
      const filtered = inputFilter(data);
      if (filtered) {
        sendTerminalInput(filtered);
      }
    });
    const resizeDisposable = terminal.onResize(() => {
      if (socket.connected) {
        emitResize(socket, terminal);
      }
    });
    const scrollDisposable = terminal.onScroll((viewportY) => {
      const atBottom = isTerminalScrolledToBottom(terminal);
      if (atBottomRef.current !== atBottom) {
        atBottomRef.current = atBottom;
        socket.emit("terminal:visibility", {
          sessionId: session.id,
          visible,
          atBottom
        });
      }
      if (atBottom) {
        setNewOutputAvailable(false);
      }
      if (!atBottom && viewportY <= 2) {
        requestOlderHistory("scroll");
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
      scrollDisposable.dispose();
      flushTerminalInput();
      cancelHistoryRequest("idle");
      if (writeTimerRef.current) {
        window.clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
      }
      latestWriteQueueRef.current = [];
      liveWriteQueueRef.current = [];
      historyWriteQueueRef.current = [];
      currentWriteRef.current = null;
      writeQueueBytesRef.current = 0;
      writeInProgressRef.current = false;
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
  }, [
    enqueueTerminalWrite,
    flushTerminalInput,
    isMobileClient,
    pasteFilesToTerminal,
    refitTerminal,
    sendTerminalInput,
    session.id,
    usesStableZellijWidth
  ]);

  return (
    <div
      className={[
        "terminal-dock",
        isMobileClient ? "mobile-terminal" : "",
        usesStableZellijWidth ? "stable-width-terminal" : "",
        visible ? "" : "terminal-dock-cached"
      ]
        .filter(Boolean)
        .join(" ")}
      aria-hidden={!visible}
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
          <span className="terminal-status" title={flowMeta.paused ? `flow paused: ${flowMeta.reason ?? "backpressure"}` : status}>
            {uploading ? "uploading" : flowMeta.paused ? "paused" : status}
          </span>
          {pendingInputCount > 0 && <span className="terminal-meta">{pendingInputCount} input</span>}
          {writeQueueBytes > 0 && <span className="terminal-meta">{Math.ceil(writeQueueBytes / 1024)}KB queue</span>}
          <button
            className="icon-button"
            type="button"
            title={
              historyMeta.older === "loading"
                ? "Loading older history"
                : historyMeta.hasMoreBefore
                  ? "Load older history"
                  : "No older history"
            }
            disabled={historyMeta.older === "loading" || !historyMeta.hasMoreBefore}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => requestOlderHistory("button")}
          >
            <History size={17} />
          </button>
          {newOutputAvailable && (
            <button
              className="icon-button terminal-live-jump"
              type="button"
              title="Jump to latest output"
              onMouseDown={(event) => event.preventDefault()}
              onClick={jumpToLiveOutput}
            >
              <ArrowDownToLine size={17} />
            </button>
          )}
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
          <button
            className="icon-button"
            type="button"
            title="关闭"
            onClick={() => {
              if (document.activeElement instanceof HTMLElement) {
                document.activeElement.blur();
              }
              onClose();
            }}
          >
            <X size={18} />
          </button>
        </div>
      </header>
      <div className="terminal-host" ref={hostRef} />
      {historyPreviewOpen && olderHistoryPreview && (
        <aside className="terminal-history-panel">
          <header>
            <span>
              older history
              {historyMeta.olderLoadedBytes > 0 ? ` / ${Math.ceil(historyMeta.olderLoadedBytes / 1024)}KB` : ""}
            </span>
            <button className="icon-button small" type="button" title="Close history" onClick={() => setHistoryPreviewOpen(false)}>
              <X size={15} />
            </button>
          </header>
          <pre>{olderHistoryPreview}</pre>
        </aside>
      )}
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
      rows: Math.max(10, value.rows || ZELLIJ_WEB_ROWS)
    };
  }

  return {
    cols: value.cols,
    rows: value.rows
  };
}

function makeTerminalClientId(sessionId: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${sessionId}-${random}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function stripAnsiForHistoryPreview(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function trimHistoryPreview(value: string): string {
  if (value.length <= TERMINAL_HISTORY_PREVIEW_MAX_CHARS) {
    return value;
  }
  const tail = value.slice(-TERMINAL_HISTORY_PREVIEW_MAX_CHARS);
  const firstLineBreak = tail.indexOf("\n");
  return firstLineBreak >= 0 ? tail.slice(firstLineBreak + 1) : tail;
}

function isTerminalScrolledToBottom(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  const viewportEnd = buffer.viewportY + terminal.rows;
  return viewportEnd >= buffer.baseY + terminal.rows - 1;
}

function shouldSendTerminalInputImmediately(data: string): boolean {
  return data.length > 1 || /[\r\n\x03\x04\x1a]/.test(data);
}

function chunkTerminalWrite(data: string): string[] {
  if (data.length <= TERMINAL_WRITE_CHUNK_CHARS) {
    return [data];
  }

  const chunks: string[] = [];
  for (let index = 0; index < data.length; index += TERMINAL_WRITE_CHUNK_CHARS) {
    let end = Math.min(data.length, index + TERMINAL_WRITE_CHUNK_CHARS);
    if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) {
      end -= 1;
    }
    chunks.push(data.slice(index, Math.max(index + 1, end)));
  }
  return chunks;
}

function pumpTerminalWrites(
  terminal: Terminal,
  queueRef: { current: string[] },
  inProgressRef: { current: boolean },
  timerRef: { current: number | null }
): void {
  const chunk = queueRef.current.shift();
  if (!chunk) {
    inProgressRef.current = false;
    return;
  }

  try {
    terminal.write(chunk, () => {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        pumpTerminalWrites(terminal, queueRef, inProgressRef, timerRef);
      }, 0);
    });
  } catch {
    queueRef.current = [];
    inProgressRef.current = false;
  }
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
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
