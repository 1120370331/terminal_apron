import fs from "node:fs";
import path from "node:path";
import type { TerminalSession } from "../shared/types.js";
import { config } from "./config.js";
import { captureZellijPreview, stripZellijHistoryHidingSequences } from "./zellij.js";

const READ_CHUNK_BYTES = 256 * 1024;

export interface TerminalHistoryOffsetCursor {
  beforeOffset: number;
  newestOffset: number;
}

export interface TerminalHistoryRangeOptions {
  session: Pick<TerminalSession, "id" | "tmuxName">;
  requestId?: string;
  dataDir?: string;
  beforeOffset?: number;
  tailLines?: number;
  limitLines?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface TerminalHistoryTailOptions {
  session: Pick<TerminalSession, "id" | "tmuxName">;
  requestId?: string;
  dataDir?: string;
  tailLines?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export interface TerminalHistoryRange {
  sessionId: string;
  requestId?: string;
  ansi: string;
  fromOffset: number;
  toOffset: number;
  cursor: TerminalHistoryOffsetCursor;
  hasMoreBefore: boolean;
  byteLength: number;
  lineCount: number;
}

export interface TerminalLatestSnapshotOptions {
  session: Pick<TerminalSession, "id" | "tmuxName">;
  requestId?: string;
  dataDir?: string;
  viewportLines?: number;
  tailLines?: number;
  maxTailBytes?: number;
  signal?: AbortSignal;
}

export interface TerminalLatestSnapshot {
  sessionId: string;
  requestId?: string;
  backend: "zellij";
  viewportAnsi: string;
  tailAnsi: string;
  cursor: TerminalHistoryOffsetCursor;
  tailFromOffset: number;
  tailToOffset: number;
  tailByteLength: number;
  tailLineCount: number;
  hasMoreBefore: boolean;
  capturedAt: string;
}

export interface TerminalHistoryServiceRangeRequest extends TerminalHistoryRangeOptions {
  requestId: string;
}

export interface TerminalHistoryServiceSnapshotRequest extends TerminalLatestSnapshotOptions {
  requestId: string;
}

export class TerminalHistoryAbortError extends Error {
  constructor(message = "terminal history request was cancelled") {
    super(message);
    this.name = "AbortError";
  }
}

export class TerminalHistoryService {
  private readonly activeRequests = new Map<string, AbortController>();

  requestRange(options: TerminalHistoryServiceRangeRequest): Promise<TerminalHistoryRange> {
    return this.runCancellable(options.session.id, options.requestId, (signal) =>
      loadTerminalHistoryRange({ ...options, signal })
    );
  }

  requestLatestSnapshot(options: TerminalHistoryServiceSnapshotRequest): Promise<TerminalLatestSnapshot> {
    return this.runCancellable(options.session.id, options.requestId, (signal) =>
      captureTerminalLatestSnapshot({ ...options, signal })
    );
  }

  cancelRequest(sessionId: string, requestId: string): boolean {
    const key = historyRequestKey(sessionId, requestId);
    const controller = this.activeRequests.get(key);
    if (!controller) {
      return false;
    }
    controller.abort(new TerminalHistoryAbortError());
    this.activeRequests.delete(key);
    return true;
  }

  cancelSession(sessionId: string): number {
    let cancelled = 0;
    for (const [key, controller] of this.activeRequests) {
      if (!key.startsWith(`${sessionId}:`)) {
        continue;
      }
      controller.abort(new TerminalHistoryAbortError());
      this.activeRequests.delete(key);
      cancelled += 1;
    }
    return cancelled;
  }

  private async runCancellable<T>(
    sessionId: string,
    requestId: string,
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const key = historyRequestKey(sessionId, requestId);
    this.cancelRequest(sessionId, requestId);

    const controller = new AbortController();
    this.activeRequests.set(key, controller);
    try {
      return await run(controller.signal);
    } finally {
      if (this.activeRequests.get(key) === controller) {
        this.activeRequests.delete(key);
      }
    }
  }
}

export const terminalHistoryService = new TerminalHistoryService();

export async function captureTerminalLatestSnapshot(
  options: TerminalLatestSnapshotOptions
): Promise<TerminalLatestSnapshot> {
  const dataDir = options.dataDir ?? config.dataDir;
  const viewportLines = normalizeSnapshotViewportLines(options.viewportLines);
  const tailLines = normalizeColdTailLines(options.tailLines);
  const maxTailBytes = normalizeColdTailBytes(options.maxTailBytes);

  throwIfAborted(options.signal);
  const [viewportAnsi, tailRange] = await Promise.all([
    captureZellijPreview(options.session, viewportLines, false, dataDir),
    loadTerminalHistoryRange({
      session: options.session,
      requestId: options.requestId,
      dataDir,
      tailLines,
      maxBytes: maxTailBytes,
      signal: options.signal
    })
  ]);
  throwIfAborted(options.signal);

  return {
    sessionId: options.session.id,
    requestId: options.requestId,
    backend: "zellij",
    viewportAnsi,
    tailAnsi: tailRange.ansi,
    cursor: tailRange.cursor,
    tailFromOffset: tailRange.fromOffset,
    tailToOffset: tailRange.toOffset,
    tailByteLength: tailRange.byteLength,
    tailLineCount: tailRange.lineCount,
    hasMoreBefore: tailRange.hasMoreBefore,
    capturedAt: new Date().toISOString()
  };
}

export function loadTerminalHistoryTail(options: TerminalHistoryTailOptions): Promise<TerminalHistoryRange> {
  return loadTerminalHistoryRange({
    session: options.session,
    requestId: options.requestId,
    dataDir: options.dataDir,
    tailLines: normalizeColdTailLines(options.tailLines),
    maxBytes: normalizeColdTailBytes(options.maxBytes),
    signal: options.signal
  });
}

export async function loadTerminalHistoryRange(options: TerminalHistoryRangeOptions): Promise<TerminalHistoryRange> {
  const dataDir = options.dataDir ?? config.dataDir;
  const transcriptPath = zellijTranscriptPath(dataDir, options.session.id);
  const stat = await fs.promises.stat(transcriptPath).catch(() => null);
  if (!stat?.isFile() || stat.size <= 0) {
    return emptyHistoryRange(options.session.id, options.requestId);
  }

  const newestOffset = stat.size;
  const toOffset = normalizeOffset(options.beforeOffset, newestOffset);
  if (toOffset <= 0) {
    return emptyHistoryRange(options.session.id, options.requestId, newestOffset);
  }

  const isTailRequest = options.tailLines !== undefined;
  const lineLimit = isTailRequest
    ? normalizeColdTailLines(options.tailLines)
    : normalizeRangeLineLimit(options.limitLines);
  const maxBytes = isTailRequest ? normalizeColdTailBytes(options.maxBytes) : normalizeRangeBytes(options.maxBytes);
  const result = await readTranscriptBeforeOffset(transcriptPath, toOffset, maxBytes, lineLimit, options.signal);
  const ansi = stripZellijHistoryHidingSequences(result.buffer.toString("utf8"));
  const fromOffset = result.fromOffset;

  return {
    sessionId: options.session.id,
    requestId: options.requestId,
    ansi,
    fromOffset,
    toOffset,
    cursor: {
      beforeOffset: fromOffset,
      newestOffset
    },
    hasMoreBefore: fromOffset > 0,
    byteLength: result.buffer.length,
    lineCount: countRawLines(ansi)
  };
}

async function readTranscriptBeforeOffset(
  filePath: string,
  toOffset: number,
  maxBytes: number,
  lineLimit: number,
  signal?: AbortSignal
): Promise<{ buffer: Buffer; fromOffset: number }> {
  const chunks: Buffer[] = [];
  let readStart = toOffset;
  let bytesRead = 0;
  let lineBreaks = 0;
  const chunkSize = Math.min(READ_CHUNK_BYTES, maxBytes);
  const handle = await fs.promises.open(filePath, "r");

  try {
    while (readStart > 0 && bytesRead < maxBytes && lineBreaks < lineLimit) {
      throwIfAborted(signal);
      const length = Math.min(chunkSize, readStart, maxBytes - bytesRead);
      const nextStart = readStart - length;
      const buffer = Buffer.alloc(length);
      const result = await handle.read(buffer, 0, length, nextStart);
      if (result.bytesRead <= 0) {
        break;
      }
      const chunk = buffer.subarray(0, result.bytesRead);
      chunks.unshift(chunk);
      bytesRead += chunk.length;
      lineBreaks += countLineBreakBytes(chunk);
      readStart = nextStart;
    }
  } finally {
    await handle.close();
  }

  throwIfAborted(signal);
  const buffer = Buffer.concat(chunks);
  const lineStart = startIndexForTailLines(buffer, lineLimit);
  const utf8Start = firstUtf8Boundary(buffer, lineStart);
  return {
    buffer: buffer.subarray(utf8Start),
    fromOffset: readStart + utf8Start
  };
}

function emptyHistoryRange(sessionId: string, requestId?: string, newestOffset = 0): TerminalHistoryRange {
  return {
    sessionId,
    requestId,
    ansi: "",
    fromOffset: newestOffset,
    toOffset: newestOffset,
    cursor: {
      beforeOffset: newestOffset,
      newestOffset
    },
    hasMoreBefore: false,
    byteLength: 0,
    lineCount: 0
  };
}

function historyRequestKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`;
}

function normalizeOffset(value: number | undefined, newestOffset: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return newestOffset;
  }
  return Math.max(0, Math.min(newestOffset, Math.floor(parsed)));
}

function normalizeSnapshotViewportLines(value: number | undefined): number {
  return normalizePositiveInteger(value, config.terminalSnapshotViewportLines, config.terminalSnapshotViewportLines);
}

function normalizeColdTailLines(value: number | undefined): number {
  return normalizePositiveInteger(value, config.terminalHistoryColdTailLines, config.terminalHistoryColdTailLines);
}

function normalizeRangeLineLimit(value: number | undefined): number {
  const fallback = Math.min(config.terminalHistoryRangeLines, config.terminalHistoryMaxRangeLines);
  return normalizePositiveInteger(value, fallback, config.terminalHistoryMaxRangeLines);
}

function normalizePositiveInteger(value: number | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(1, Math.min(max, Math.floor(normalized)));
}

function normalizeColdTailBytes(value: number | undefined): number {
  return normalizeMaxBytes(value, config.terminalHistoryColdTailBytes, config.terminalHistoryColdTailBytes);
}

function normalizeRangeBytes(value: number | undefined): number {
  return normalizeMaxBytes(value, config.terminalHistoryRangeBytes, config.terminalHistoryRangeBytes);
}

function normalizeMaxBytes(value: number | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(1, Math.min(config.nativeHistoryBytes, max, Math.floor(normalized)));
}

function zellijTranscriptPath(dataDir: string, sessionId: string): string {
  return path.join(dataDir, "transcripts", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.ansi`);
}

function startIndexForTailLines(buffer: Buffer, lineLimit: number): number {
  let lineBreaks = 0;
  let scanStart = buffer.length - 1;
  while (scanStart >= 0 && (buffer[scanStart] === 10 || buffer[scanStart] === 13)) {
    scanStart -= 1;
  }

  for (let index = scanStart; index >= 0; index -= 1) {
    if (buffer[index] !== 10) {
      continue;
    }
    lineBreaks += 1;
    if (lineBreaks >= lineLimit) {
      return index + 1;
    }
  }
  return 0;
}

function firstUtf8Boundary(buffer: Buffer, startIndex: number): number {
  let index = Math.max(0, Math.min(buffer.length, startIndex));
  while (index < buffer.length && (buffer[index] & 0xc0) === 0x80) {
    index += 1;
  }
  return index;
}

function countLineBreakBytes(value: Buffer): number {
  let count = 0;
  for (const byte of value) {
    if (byte === 10) {
      count += 1;
    }
  }
  return count;
}

function countRawLines(value: string): number {
  return value ? value.split(/\r?\n/).length : 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  const reason = signal.reason;
  if (reason instanceof Error) {
    throw reason;
  }
  throw new TerminalHistoryAbortError();
}
