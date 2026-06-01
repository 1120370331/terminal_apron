import type { Socket } from "socket.io";
import type { TerminalDataFrame } from "../shared/terminalProtocol.js";

const MAX_TERMINAL_DATA_EVENT_BYTES = 256 * 1024;

export function emitTerminalData(socket: Socket, data: string | TerminalDataFrame): void {
  if (typeof data === "string") {
    emitTerminalStringData(socket, data);
    return;
  }

  const protocolVersion = Number(socket.data.terminalProtocolVersion ?? 1);
  if (protocolVersion < 2) {
    emitTerminalStringData(socket, data.data);
    return;
  }

  for (const chunk of terminalDataChunks(data.data)) {
    socket.emit("terminal:data", {
      ...data,
      data: chunk,
      byteLength: Buffer.byteLength(chunk, "utf8")
    });
  }
}

function emitTerminalStringData(socket: Socket, data: string): void {
  if (!data) {
    return;
  }

  for (const chunk of terminalDataChunks(data)) {
    socket.emit("terminal:data", chunk);
  }
}

export function terminalDataChunks(data: string): string[] {
  const maxChars = Math.max(1024, Math.floor(MAX_TERMINAL_DATA_EVENT_BYTES / 4));
  const chunks: string[] = [];
  let index = 0;
  while (index < data.length) {
    let end = Math.min(data.length, index + maxChars);
    if (end < data.length && isHighSurrogate(data.charCodeAt(end - 1))) {
      end -= 1;
    }
    if (end <= index) {
      end = Math.min(data.length, index + 1);
    }
    chunks.push(data.slice(index, end));
    index = end;
  }
  return chunks;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}
