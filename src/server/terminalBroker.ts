import crypto from "node:crypto";
import path from "node:path";
import type { Socket } from "socket.io";
import type { TerminalSession } from "../shared/types.js";
import {
  TERMINAL_PROTOCOL_VERSION,
  type TerminalAckFrame,
  type TerminalClientProfile,
  type TerminalDataFrame,
  type TerminalErrorCode,
  type TerminalErrorFrame,
  type TerminalFlowFrame,
  type TerminalHistoryCancelFrame,
  type TerminalHistoryPolicy,
  type TerminalHistoryRequestFrame,
  type TerminalInputAckFrame,
  type TerminalInputFrame,
  type TerminalReadyFrame,
  type TerminalResizeFrame,
  type TerminalStateFrame,
  type TerminalSubscriberMode,
  type TerminalVisibilityFrame
} from "../shared/terminalProtocol.js";
import { config } from "./config.js";
import {
  CodexTerminalTitleTracker,
  parseCodexThreadIntent,
  trackCodexThreadForTerminalPrompt,
  type CodexThreadChangeHandler
} from "./codexSessions.js";
import { loadPty, type PtyProcess } from "./pty.js";
import { emitTerminalData } from "./terminalData.js";
import {
  DISABLED_TERMINAL_PROXY,
  terminalProcessEnvironment,
  type TerminalProxyConfig
} from "./terminalProxy.js";
import {
  appendZellijTranscript,
  createZellijAttachOutputFilter,
  ensureZellijSession,
  recoverZellijCodexLocalDataLock,
  saveZellijSessionState,
  zellijAttachArgs,
  zellijAttachCommand
} from "./zellij.js";
import {
  captureTerminalLatestSnapshot,
  loadTerminalHistoryRange,
  terminalHistoryService
} from "./terminalHistory.js";

const MAX_TERMINAL_COLS = 4096;
const MAX_TERMINAL_ROWS = 2048;
const ZELLIJ_WEB_COLS = 120;
const ZELLIJ_WEB_ROWS = 36;
const BROKER_HOT_TTL_MS = 60_000;
const ZELLIJ_SAVE_DEBOUNCE_MS = 10_000;
const RING_MAX_FRAMES = 5000;
const RING_MAX_BYTES = 4 * 1024 * 1024;
const HISTORY_PAUSE_UNACKED_BYTES = 512 * 1024;
const LIVE_FLOW_UNACKED_BYTES = 2 * 1024 * 1024;

export interface TerminalBrokerSubscribeOptions {
  clientId: string;
  protocolVersion: number;
  clientProfile: TerminalClientProfile;
  mode: TerminalSubscriberMode;
  cols: number;
  rows: number;
  lastAckSeq: number;
  historyPolicy: TerminalHistoryPolicy;
  tailLines: number;
}

interface TerminalSubscriber {
  id: string;
  socket: Socket;
  protocolVersion: number;
  clientProfile: TerminalClientProfile;
  mode: TerminalSubscriberMode;
  lastAckSeq: number;
  writeQueueBytes: number;
  unackedBytes: number;
  flowPaused: boolean;
  readySent: boolean;
  closed: boolean;
  visible: boolean;
  atBottom: boolean;
  historySerial: number;
  pendingLiveAfterSeq: number | null;
  canceledHistory: Set<string>;
}

class TerminalFrameRingBuffer {
  private frames: TerminalDataFrame[] = [];
  private totalBytes = 0;

  push(frame: TerminalDataFrame): void {
    this.frames.push(frame);
    this.totalBytes += frame.byteLength;
    while (this.frames.length > RING_MAX_FRAMES || this.totalBytes > RING_MAX_BYTES) {
      const removed = this.frames.shift();
      if (!removed) {
        return;
      }
      this.totalBytes -= removed.byteLength;
    }
  }

  framesAfter(seq: number): TerminalDataFrame[] {
    return this.frames.filter((frame) => frame.seq > seq);
  }

  canReplayFrom(seq: number, newestSeq: number): boolean {
    if (seq >= newestSeq) {
      return true;
    }
    const first = this.frames[0];
    return Boolean(first && seq >= first.seq - 1);
  }

  bytesAfter(seq: number): number {
    return this.frames.reduce((total, frame) => (frame.seq > seq ? total + frame.byteLength : total), 0);
  }
}

const brokers = new Map<string, TerminalBroker>();

export function getTerminalBroker(
  session: TerminalSession,
  dataDir: string,
  proxy: TerminalProxyConfig = DISABLED_TERMINAL_PROXY,
  onCodexThreadChange?: CodexThreadChangeHandler
): TerminalBroker {
  const key = brokerKey(dataDir, session.id);
  const existing = brokers.get(key);
  if (existing) {
    existing.updateSession(session, proxy, onCodexThreadChange);
    return existing;
  }

  const broker = new TerminalBroker(session, dataDir, proxy, onCodexThreadChange, () => {
    if (brokers.get(key) === broker) {
      brokers.delete(key);
    }
  });
  brokers.set(key, broker);
  return broker;
}

export async function closeTerminalBrokers(dataDir: string): Promise<void> {
  const prefix = `${path.resolve(dataDir)}:`;
  const matching = Array.from(brokers.entries())
    .filter(([key]) => key.startsWith(prefix))
    .map(([, broker]) => broker);
  await Promise.allSettled(matching.map((broker) => broker.closeForRefresh()));
}

export async function closeTerminalBroker(dataDir: string, sessionId: string): Promise<void> {
  const broker = brokers.get(brokerKey(dataDir, sessionId));
  if (broker) {
    await broker.closeForRefresh("terminal-restart");
  }
}

export class TerminalBroker {
  readonly streamId = crypto.randomUUID();
  private session: TerminalSession;
  private readonly dataDir: string;
  private proxy: TerminalProxyConfig;
  private readonly onDestroy: () => void;
  private readonly subscribers = new Map<string, TerminalSubscriber>();
  private readonly ringBuffer = new TerminalFrameRingBuffer();
  private readonly outputFilter = createZellijAttachOutputFilter();
  private readonly codexTitleTracker: CodexTerminalTitleTracker;
  private onCodexThreadChange?: CodexThreadChangeHandler;
  private state: TerminalStateFrame["state"] = "detached";
  private term: PtyProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private ttlTimer: NodeJS.Timeout | null = null;
  private saveTimer: NodeJS.Timeout | null = null;
  private transcriptQueue = Promise.resolve();
  private inputQueue = Promise.resolve();
  private terminalInputBuffer = "";
  private bracketedPaste = false;
  private promptTrackingGeneration = 0;
  private currentCols = ZELLIJ_WEB_COLS;
  private currentRows = ZELLIJ_WEB_ROWS;
  private resizeOwnerId: string | null = null;
  private lastSeq = 0;
  private lastSaveAt = 0;
  private closed = false;

  constructor(
    session: TerminalSession,
    dataDir: string,
    proxy: TerminalProxyConfig,
    onCodexThreadChange: CodexThreadChangeHandler | undefined,
    onDestroy: () => void
  ) {
    this.session = session;
    this.dataDir = dataDir;
    this.proxy = proxy;
    this.onCodexThreadChange = onCodexThreadChange;
    this.onDestroy = onDestroy;
    this.codexTitleTracker = new CodexTerminalTitleTracker((threadId) => this.handleCodexThreadChange(threadId));
  }

  updateSession(
    session: TerminalSession,
    proxy: TerminalProxyConfig,
    onCodexThreadChange?: CodexThreadChangeHandler
  ): void {
    this.session = session;
    this.proxy = proxy;
    this.onCodexThreadChange = onCodexThreadChange;
  }

  subscribe(socket: Socket, options: TerminalBrokerSubscribeOptions): void {
    this.cancelTtl();
    socket.data.terminalProtocolVersion = options.protocolVersion;
    socket.data.terminalSessionId = this.session.id;

    const subscriber: TerminalSubscriber = {
      id: options.clientId,
      socket,
      protocolVersion: options.protocolVersion,
      clientProfile: options.clientProfile,
      mode: options.mode,
      lastAckSeq: options.lastAckSeq,
      writeQueueBytes: 0,
      unackedBytes: this.ringBuffer.bytesAfter(options.lastAckSeq),
      flowPaused: false,
      readySent: false,
      closed: false,
      visible: true,
      atBottom: true,
      historySerial: 0,
      pendingLiveAfterSeq: options.protocolVersion >= 2 && options.historyPolicy !== "none" ? this.lastSeq : null,
      canceledHistory: new Set()
    };

    this.subscribers.set(subscriber.id, subscriber);
    if (subscriber.mode === "interactive" && !this.resizeOwnerId) {
      this.resizeOwnerId = subscriber.id;
    }
    this.registerSocketHandlers(subscriber);
    this.emitState(subscriber);

    this.ensureStarted(options)
      .then(() => {
        if (subscriber.closed) {
          return;
        }
        this.emitReady(subscriber);
        this.emitResizeAck(subscriber, 0);
        if (subscriber.protocolVersion >= 2) {
          void this.sendInitialHistory(subscriber, options.historyPolicy, options.tailLines);
        } else {
          this.replayGap(subscriber, options.lastAckSeq);
        }
      })
      .catch((error) => {
        this.fail("attach-failed", error instanceof Error ? error.message : String(error), false);
      });
  }

  private registerSocketHandlers(subscriber: TerminalSubscriber): void {
    const socket = subscriber.socket;

    socket.on("terminal:input", (payload: string | Partial<TerminalInputFrame>) => {
      const input = normalizeInputPayload(this.session.id, payload);
      if (!input) {
        this.emitInputAck(subscriber, {
          version: TERMINAL_PROTOCOL_VERSION,
          sessionId: this.session.id,
          inputId: "invalid",
          accepted: false,
          message: "input data is required"
        });
        return;
      }
      void this.writeInput(subscriber, input);
    });

    socket.on("terminal:resize", (payload: Partial<TerminalResizeFrame>) => {
      this.resizeFromSubscriber(subscriber, payload);
    });

    socket.on("terminal:ack", (payload: Partial<TerminalAckFrame>) => {
      this.handleAck(subscriber, payload);
    });

    socket.on("terminal:history:request", (payload: Partial<TerminalHistoryRequestFrame>) => {
      void this.sendHistoryRange(subscriber, payload);
    });

    socket.on("terminal:history:cancel", (payload: Partial<TerminalHistoryCancelFrame>) => {
      const requestId = typeof payload?.requestId === "string" ? payload.requestId : "";
      if (requestId) {
        subscriber.canceledHistory.add(requestId);
        terminalHistoryService.cancelRequest(this.session.id, requestId);
      }
    });

    socket.on("terminal:visibility", (payload: Partial<TerminalVisibilityFrame>) => {
      subscriber.visible = payload?.visible !== false;
      subscriber.atBottom = payload?.atBottom !== false;
    });

    socket.on("disconnect", () => {
      this.unsubscribe(subscriber.id);
    });
  }

  private ensureStarted(options: TerminalBrokerSubscribeOptions): Promise<void> {
    if (this.term && this.state === "live") {
      return Promise.resolve();
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const size = normalizeInitialSize(options);
    this.currentCols = size.cols;
    this.currentRows = size.rows;
    this.closed = false;
    this.startPromise = this.start().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async start(): Promise<void> {
    this.setState("starting");
    await ensureZellijSession(this.session, this.proxy);
    const pty = await loadPty();
    const term = pty.spawn(config.zellijBin, zellijAttachArgs(this.session), {
      name: "xterm-256color",
      cols: this.currentCols,
      rows: this.currentRows,
      cwd: this.session.cwd,
      env: terminalProcessEnvironment(this.proxy, {
        TERM: "xterm-256color",
        COLORTERM: "truecolor"
      })
    });

    this.term = term;
    let startupOutput = "";
    let captureStartupOutput = true;
    term.onData((data) => {
      if (captureStartupOutput) {
        startupOutput = (startupOutput + data).slice(-100_000);
      }
      this.handlePtyData(data);
    });
    term.onExit((event) => {
      this.closed = true;
      this.term = null;
      this.clearSaveTimer();
      this.setState("detached");
      for (const subscriber of this.subscribers.values()) {
        subscriber.socket.emit("terminal:exit", event);
      }
      if (this.subscribers.size === 0) {
        this.onDestroy();
      }
    });

    this.setState("live");
    this.broadcastReady();
    this.broadcastResizeAck(0);
    void recoverZellijCodexLocalDataLock(this.session.tmuxName, {
      read: () => startupOutput,
      clear: () => {
        startupOutput = "";
      }
    }).catch((error) => {
      console.error(
        `Failed to recover Codex local data lock in Zellij session ${this.session.tmuxName}`,
        error
      );
    }).finally(() => {
      captureStartupOutput = false;
      startupOutput = "";
    });
  }

  private handlePtyData(data: string): void {
    if (this.closed) {
      return;
    }
    this.codexTitleTracker.push(data);
    const filtered = this.outputFilter(data);
    if (!filtered) {
      return;
    }

    const frame = this.createDataFrame("live", filtered, this.nextSeq());
    this.ringBuffer.push(frame);
    this.broadcastData(frame);
    this.transcriptQueue = this.transcriptQueue
      .then(() => appendZellijTranscript(this.session.id, filtered, this.dataDir))
      .catch(() => undefined);
    this.scheduleSave();
  }

  private broadcastData(frame: TerminalDataFrame): void {
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.closed || subscriber.pendingLiveAfterSeq !== null) {
        continue;
      }
      this.emitData(subscriber, frame);
    }
  }

  private emitData(subscriber: TerminalSubscriber, frame: TerminalDataFrame): void {
    emitTerminalData(subscriber.socket, frame);
    if (frame.kind === "live") {
      subscriber.unackedBytes += frame.byteLength;
      this.updateFlow(subscriber);
    }
  }

  private async sendInitialHistory(
    subscriber: TerminalSubscriber,
    policy: TerminalHistoryPolicy,
    tailLines: number
  ): Promise<void> {
    if (policy === "none" || subscriber.closed) {
      const afterSeq = subscriber.pendingLiveAfterSeq ?? subscriber.lastAckSeq;
      subscriber.pendingLiveAfterSeq = null;
      this.replayGap(subscriber, afterSeq);
      return;
    }

    const requestId = `initial:${++subscriber.historySerial}`;
    const snapshotSeq = subscriber.pendingLiveAfterSeq ?? this.lastSeq;
    try {
      const snapshot = await captureTerminalLatestSnapshot({
        session: this.session,
        requestId,
        dataDir: this.dataDir,
        tailLines,
        includeViewport: policy === "viewport"
      });
      if (subscriber.closed || subscriber.canceledHistory.has(requestId)) {
        return;
      }
      subscriber.socket.emit("terminal:history:init", {
        version: TERMINAL_PROTOCOL_VERSION,
        sessionId: this.session.id,
        streamId: this.streamId,
        snapshotSeq,
        viewportAnsi: snapshot.viewportAnsi,
        tailAnsi: snapshot.tailAnsi,
        tailFromOffset: snapshot.tailFromOffset,
        tailToOffset: snapshot.tailToOffset,
        newestOffset: snapshot.cursor.newestOffset,
        byteLength: snapshot.tailByteLength,
        lineCount: snapshot.tailLineCount,
        hasMoreBefore: snapshot.hasMoreBefore
      });
      subscriber.pendingLiveAfterSeq = null;
      this.replayGap(subscriber, snapshotSeq);
      this.emitHistoryDone(subscriber, requestId, false);
    } catch (error) {
      subscriber.pendingLiveAfterSeq = null;
      this.emitError(subscriber, "history-failed", error instanceof Error ? error.message : String(error), true);
      this.replayGap(subscriber, snapshotSeq);
      this.emitHistoryDone(subscriber, requestId, true);
    }
  }

  private async sendHistoryRange(
    subscriber: TerminalSubscriber,
    payload: Partial<TerminalHistoryRequestFrame>
  ): Promise<void> {
    if (subscriber.protocolVersion < 2 || subscriber.closed) {
      return;
    }

    const requestId = typeof payload?.requestId === "string" && payload.requestId ? payload.requestId : crypto.randomUUID();
    subscriber.canceledHistory.delete(requestId);
    try {
      await this.waitForHistoryBackpressure(subscriber, requestId);
      const range = await loadTerminalHistoryRange({
        session: this.session,
        requestId,
        dataDir: this.dataDir,
        beforeOffset: payload?.beforeOffset,
        limitLines: payload?.limitLines,
        maxBytes: payload?.maxBytes
      });
      if (subscriber.closed || subscriber.canceledHistory.has(requestId)) {
        return;
      }
      subscriber.socket.emit("terminal:history:chunk", {
        version: TERMINAL_PROTOCOL_VERSION,
        sessionId: this.session.id,
        requestId,
        fromOffset: range.fromOffset,
        toOffset: range.toOffset,
        byteLength: range.byteLength,
        lineCount: range.lineCount,
        ansi: payload?.format === "plain" ? stripAnsi(range.ansi) : range.ansi,
        hasMoreBefore: range.hasMoreBefore
      });
      this.emitHistoryDone(subscriber, requestId, false);
    } catch (error) {
      this.emitError(subscriber, "history-failed", error instanceof Error ? error.message : String(error), true);
      this.emitHistoryDone(subscriber, requestId, true);
    }
  }

  private async waitForHistoryBackpressure(subscriber: TerminalSubscriber, requestId: string): Promise<void> {
    while (
      subscriber.unackedBytes > HISTORY_PAUSE_UNACKED_BYTES &&
      !subscriber.closed &&
      !subscriber.canceledHistory.has(requestId)
    ) {
      this.sendFlow(subscriber, true, "client-backpressure");
      await delay(50);
    }
    if (subscriber.flowPaused && subscriber.unackedBytes <= HISTORY_PAUSE_UNACKED_BYTES) {
      this.sendFlow(subscriber, false);
    }
  }

  private replayGap(subscriber: TerminalSubscriber, lastSeq: number): void {
    if (subscriber.protocolVersion < 2) {
      return;
    }
    if (!this.ringBuffer.canReplayFrom(lastSeq, this.lastSeq)) {
      this.emitError(subscriber, "resync-required", "terminal stream gap is no longer retained", true);
      return;
    }
    for (const frame of this.ringBuffer.framesAfter(lastSeq)) {
      if (subscriber.closed) {
        return;
      }
      this.emitData(subscriber, frame);
    }
  }

  private writeInput(subscriber: TerminalSubscriber, input: TerminalInputFrame): Promise<void> {
    const inputId = input.inputId || crypto.randomUUID();
    this.inputQueue = this.inputQueue.then(async () => {
      if (!this.term) {
        await this.ensureStarted({
          clientId: subscriber.id,
          protocolVersion: subscriber.protocolVersion,
          clientProfile: subscriber.clientProfile,
          mode: subscriber.mode,
          cols: this.currentCols,
          rows: this.currentRows,
          lastAckSeq: subscriber.lastAckSeq,
          historyPolicy: "none",
          tailLines: 0
        });
      }
      if (!this.term) {
        throw new Error("zellij attach is not ready");
      }
      const inputSeq = this.lastSeq;
      this.trackTerminalInput(input.data);
      this.term.write(input.data);
      this.scheduleSave();
      this.emitInputAck(subscriber, {
        version: TERMINAL_PROTOCOL_VERSION,
        sessionId: this.session.id,
        inputId,
        accepted: true,
        inputSeq
      });
    });

    this.inputQueue = this.inputQueue.catch((error) => {
      this.emitInputAck(subscriber, {
        version: TERMINAL_PROTOCOL_VERSION,
        sessionId: this.session.id,
        inputId,
        accepted: false,
        message: error instanceof Error ? error.message : String(error)
      });
    });
    return this.inputQueue;
  }

  private resizeFromSubscriber(subscriber: TerminalSubscriber, payload: Partial<TerminalResizeFrame>): void {
    if (subscriber.mode !== "interactive") {
      this.emitResizeAck(subscriber, payload?.seq);
      return;
    }
    if (!this.resizeOwnerId) {
      this.resizeOwnerId = subscriber.id;
    }
    if (this.resizeOwnerId !== subscriber.id) {
      this.emitResizeAck(subscriber, payload?.seq);
      return;
    }

    const previousCols = this.currentCols;
    const previousRows = this.currentRows;
    if (subscriber.clientProfile === "mobile") {
      this.currentCols = clampInteger(payload?.cols, this.currentCols, 20, MAX_TERMINAL_COLS);
      this.currentRows = clampInteger(payload?.rows, this.currentRows, 10, MAX_TERMINAL_ROWS);
    } else {
      this.currentCols = ZELLIJ_WEB_COLS;
      this.currentRows = clampInteger(payload?.rows, this.currentRows, 10, MAX_TERMINAL_ROWS);
    }

    if (this.term && (previousCols !== this.currentCols || previousRows !== this.currentRows)) {
      this.term.resize(this.currentCols, this.currentRows);
    }
    this.broadcastResizeAck(payload?.seq);
  }

  private handleAck(subscriber: TerminalSubscriber, payload: Partial<TerminalAckFrame>): void {
    if (payload?.streamId && payload.streamId !== this.streamId) {
      return;
    }
    subscriber.lastAckSeq = Math.max(
      subscriber.lastAckSeq,
      clampInteger(payload?.seq, subscriber.lastAckSeq, 0, Number.MAX_SAFE_INTEGER)
    );
    subscriber.writeQueueBytes = clampInteger(payload?.writeQueueBytes, 0, 0, Number.MAX_SAFE_INTEGER);
    subscriber.unackedBytes = this.ringBuffer.bytesAfter(subscriber.lastAckSeq);
    this.updateFlow(subscriber);
  }

  private updateFlow(subscriber: TerminalSubscriber): void {
    if (subscriber.protocolVersion < 2) {
      return;
    }
    if (subscriber.unackedBytes > LIVE_FLOW_UNACKED_BYTES) {
      this.sendFlow(subscriber, true, "client-backpressure");
      return;
    }
    if (subscriber.flowPaused && subscriber.unackedBytes <= HISTORY_PAUSE_UNACKED_BYTES) {
      this.sendFlow(subscriber, false);
    }
  }

  private emitReady(subscriber: TerminalSubscriber): void {
    if (subscriber.readySent || subscriber.closed) {
      return;
    }
    subscriber.readySent = true;
    const frame: TerminalReadyFrame = {
      version: TERMINAL_PROTOCOL_VERSION,
      sessionId: this.session.id,
      streamId: this.streamId,
      backend: "zellij",
      persistent: true,
      cols: this.currentCols,
      rows: this.currentRows,
      newestSeq: this.lastSeq,
      canResumeFromSeq: this.ringBuffer.canReplayFrom(subscriber.lastAckSeq, this.lastSeq),
      canLoadOlderHistory: true,
      tmuxName: this.session.tmuxName,
      attachCommand: zellijAttachCommand(this.session)
    };
    subscriber.socket.emit("terminal:ready", subscriber.protocolVersion >= 2 ? frame : {
      backend: frame.backend,
      persistent: frame.persistent,
      tmuxName: frame.tmuxName,
      attachCommand: frame.attachCommand
    });
  }

  private broadcastReady(): void {
    for (const subscriber of this.subscribers.values()) {
      this.emitReady(subscriber);
    }
  }

  private emitState(subscriber: TerminalSubscriber): void {
    const frame: TerminalStateFrame = {
      version: TERMINAL_PROTOCOL_VERSION,
      sessionId: this.session.id,
      state: this.state,
      updatedAt: new Date().toISOString()
    };
    subscriber.socket.emit("terminal:state", frame);
  }

  private setState(state: TerminalStateFrame["state"]): void {
    this.state = state;
    for (const subscriber of this.subscribers.values()) {
      this.emitState(subscriber);
    }
  }

  private emitError(subscriber: TerminalSubscriber, code: TerminalErrorCode, message: string, recoverable: boolean): void {
    const frame: TerminalErrorFrame = {
      version: TERMINAL_PROTOCOL_VERSION,
      sessionId: this.session.id,
      code,
      message,
      recoverable
    };
    subscriber.socket.emit("terminal:error", subscriber.protocolVersion >= 2 ? frame : message);
  }

  private fail(code: TerminalErrorCode, message: string, recoverable: boolean): void {
    this.setState("error");
    for (const subscriber of this.subscribers.values()) {
      this.emitError(subscriber, code, message, recoverable);
    }
  }

  private emitInputAck(subscriber: TerminalSubscriber, frame: TerminalInputAckFrame): void {
    subscriber.socket.emit("terminal:input:ack", subscriber.protocolVersion >= 2 ? frame : {
      inputId: frame.inputId,
      accepted: frame.accepted,
      inputSeq: frame.inputSeq,
      message: frame.message
    });
  }

  private emitHistoryDone(subscriber: TerminalSubscriber, requestId: string, canceled: boolean): void {
    subscriber.socket.emit("terminal:history:done", {
      version: TERMINAL_PROTOCOL_VERSION,
      sessionId: this.session.id,
      streamId: this.streamId,
      requestId,
      canceled,
      newestSeq: this.lastSeq
    });
  }

  private emitResizeAck(subscriber: TerminalSubscriber, seq: unknown): void {
    subscriber.socket.emit("terminal:resized", {
      cols: this.currentCols,
      rows: this.currentRows,
      seq
    });
  }

  private broadcastResizeAck(seq: unknown): void {
    for (const subscriber of this.subscribers.values()) {
      this.emitResizeAck(subscriber, seq);
    }
  }

  private sendFlow(subscriber: TerminalSubscriber, paused: boolean, reason?: TerminalFlowFrame["reason"]): void {
    if (subscriber.flowPaused === paused) {
      return;
    }
    subscriber.flowPaused = paused;
    const frame: TerminalFlowFrame = {
      version: TERMINAL_PROTOCOL_VERSION,
      sessionId: this.session.id,
      streamId: this.streamId,
      paused,
      reason
    };
    subscriber.socket.emit("terminal:flow", frame);
  }

  private createDataFrame(kind: TerminalDataFrame["kind"], data: string, seq: number): TerminalDataFrame {
    return {
      version: TERMINAL_PROTOCOL_VERSION,
      sessionId: this.session.id,
      streamId: this.streamId,
      seq,
      kind,
      data,
      byteLength: Buffer.byteLength(data, "utf8"),
      emittedAt: Date.now()
    };
  }

  private nextSeq(): number {
    this.lastSeq += 1;
    return this.lastSeq;
  }

  private scheduleSave(): void {
    if (this.closed) {
      return;
    }
    const elapsed = Date.now() - this.lastSaveAt;
    if (elapsed >= ZELLIJ_SAVE_DEBOUNCE_MS) {
      void this.saveNow();
      return;
    }
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        void this.saveNow();
      }, ZELLIJ_SAVE_DEBOUNCE_MS - elapsed);
    }
  }

  private async handleCodexThreadChange(threadId: string | null): Promise<void> {
    if ((this.session.codexThreadId ?? null) === threadId) {
      return;
    }
    this.session = {
      ...this.session,
      codexThreadId: threadId ?? undefined,
      codexThreadUpdatedAt: new Date().toISOString()
    };
    this.promptTrackingGeneration += 1;
    await this.onCodexThreadChange?.(threadId);
    this.scheduleSave();
  }

  private trackTerminalInput(data: string): void {
    for (let index = 0; index < data.length; index += 1) {
      if (data.startsWith("\x1b[200~", index)) {
        this.bracketedPaste = true;
        index += 5;
        continue;
      }
      if (data.startsWith("\x1b[201~", index)) {
        this.bracketedPaste = false;
        index += 5;
        continue;
      }

      const char = data[index];
      if (char === "\x1b") {
        const sequence = /^\x1b\[[0-9;?]*[A-Za-z~]/.exec(data.slice(index))?.[0];
        if (sequence) {
          index += sequence.length - 1;
        }
        continue;
      }
      if (char === "\x03" || char === "\x15") {
        this.terminalInputBuffer = "";
        continue;
      }
      if (char === "\x17") {
        this.terminalInputBuffer = this.terminalInputBuffer.replace(/\S+\s*$/, "");
        continue;
      }
      if (char === "\x08" || char === "\x7f") {
        this.terminalInputBuffer = Array.from(this.terminalInputBuffer).slice(0, -1).join("");
        continue;
      }
      if (char === "\r" || char === "\n") {
        if (this.bracketedPaste) {
          if (char === "\n" && data[index - 1] === "\r") {
            continue;
          }
          this.terminalInputBuffer += "\n";
          continue;
        }
        const prompt = this.terminalInputBuffer;
        this.terminalInputBuffer = "";
        if (prompt) {
          const submittedAt = Date.now();
          if (parseCodexThreadIntent(prompt, this.session.codexThreadId)) {
            this.promptTrackingGeneration += 1;
          }
          const generation = this.promptTrackingGeneration;
          trackCodexThreadForTerminalPrompt(this.session, prompt, submittedAt, (threadId) => {
            if (generation === this.promptTrackingGeneration) {
              return this.handleCodexThreadChange(threadId);
            }
          });
        }
        continue;
      }
      if (char >= " " && char !== "\x7f") {
        this.terminalInputBuffer += char;
      }
    }
  }

  private saveNow(): Promise<void> {
    this.lastSaveAt = Date.now();
    return saveZellijSessionState(this.session.tmuxName).catch(() => undefined);
  }

  private clearSaveTimer(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  private unsubscribe(subscriberId: string): void {
    const subscriber = this.subscribers.get(subscriberId);
    if (!subscriber) {
      return;
    }
    subscriber.closed = true;
    subscriber.historySerial += 1;
    terminalHistoryService.cancelSession(this.session.id);
    this.subscribers.delete(subscriberId);
    if (this.resizeOwnerId === subscriberId) {
      this.resizeOwnerId = nextInteractiveSubscriberId(this.subscribers);
    }
    if (this.subscribers.size === 0) {
      this.scheduleTtl();
    }
  }

  private scheduleTtl(): void {
    this.cancelTtl();
    this.ttlTimer = setTimeout(() => {
      if (this.subscribers.size === 0) {
        void this.stop();
      }
    }, BROKER_HOT_TTL_MS);
  }

  private cancelTtl(): void {
    if (this.ttlTimer) {
      clearTimeout(this.ttlTimer);
      this.ttlTimer = null;
    }
  }

  private async stop(): Promise<void> {
    this.cancelTtl();
    this.closed = true;
    this.clearSaveTimer();
    terminalHistoryService.cancelSession(this.session.id);
    const term = this.term;
    this.term = null;
    await Promise.all([this.transcriptQueue.catch(() => undefined), this.saveNow()]).catch(() => undefined);
    if (term) {
      try {
        term.kill();
      } catch {
        // The zellij attach client may already have detached.
      }
    }
    this.setState("detached");
    this.codexTitleTracker.dispose();
    this.onDestroy();
  }

  async closeForRefresh(reason = "proxy-refresh"): Promise<void> {
    for (const subscriber of Array.from(this.subscribers.values())) {
      subscriber.closed = true;
      subscriber.socket.emit("terminal:exit", { reason });
      subscriber.socket.disconnect(true);
    }
    this.subscribers.clear();
    await this.stop();
  }
}

function brokerKey(dataDir: string, sessionId: string): string {
  return `${path.resolve(dataDir)}:${sessionId}`;
}

function normalizeInitialSize(options: TerminalBrokerSubscribeOptions): { cols: number; rows: number } {
  if (options.clientProfile === "mobile") {
    return {
      cols: clampInteger(options.cols, ZELLIJ_WEB_COLS, 20, MAX_TERMINAL_COLS),
      rows: clampInteger(options.rows, ZELLIJ_WEB_ROWS, 10, MAX_TERMINAL_ROWS)
    };
  }
  return {
    cols: ZELLIJ_WEB_COLS,
    rows: clampInteger(options.rows, ZELLIJ_WEB_ROWS, 10, MAX_TERMINAL_ROWS)
  };
}

function normalizeInputPayload(sessionId: string, payload: string | Partial<TerminalInputFrame>): TerminalInputFrame | null {
  if (typeof payload === "string") {
    return payload
      ? {
          sessionId,
          inputId: crypto.randomUUID(),
          data: payload,
          mode: "type"
        }
      : null;
  }
  if (!payload || typeof payload.data !== "string" || !payload.data) {
    return null;
  }
  return {
    sessionId: typeof payload.sessionId === "string" ? payload.sessionId : sessionId,
    inputId: typeof payload.inputId === "string" && payload.inputId ? payload.inputId : crypto.randomUUID(),
    data: payload.data,
    mode: payload.mode === "paste" || payload.mode === "quick-send" ? payload.mode : "type"
  };
}

function nextInteractiveSubscriberId(subscribers: Map<string, TerminalSubscriber>): string | null {
  for (const subscriber of subscribers.values()) {
    if (subscriber.mode === "interactive") {
      return subscriber.id;
    }
  }
  return null;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
