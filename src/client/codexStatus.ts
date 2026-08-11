import type { SessionPreview, TerminalSession } from "../shared/types.js";

export type CodexSessionState =
  | "not_started"
  | "ready"
  | "working"
  | "needs_confirmation"
  | "reconnecting"
  | "completed"
  | "error";

export interface CodexSessionStatus {
  state: CodexSessionState;
  label: string;
  detail?: string;
}

const CODEX_SURFACE_PATTERN =
  /OpenAI Codex|codex-cli|codex resume|YOLO mode|esc to interrupt|Implement \{feature\}|gpt-[\w.-]+\s+(?:low|medium|high)/i;
const WORKING_PATTERN = /esc to interrupt|running tool|thinking|working(?:\s|\.)|处理中|工作中/i;
const RECONNECTING_PATTERN =
  /reconnecting|trying to reconnect|connection (?:lost|closed|reset)|stream disconnected|retrying(?: in)?|网络重连|正在重连/i;
const ERROR_PATTERN =
  /MCP startup incomplete|MCP client for .* timed out|thread panicked|failed to initialize|authentication required|not logged in|rate limit exceeded|unexpectedly exited|fatal error|Codex.*(?:fatal|error)/i;
const STATE_MARKER_PATTERN =
  /TASK_MONITOR_STATE:\s*(working|needs_confirmation|completed|reconnecting|error)(?:\s*\|\s*([^\r\n]+))?/gi;

export function detectCodexStatus(session: TerminalSession, preview?: SessionPreview): CodexSessionStatus {
  const currentCommand = session.runtime?.currentCommand || "";
  const output = stripAnsi(preview?.text || "").slice(-16_000);
  const marker = latestStateMarker(output);
  const outputAfterMarker = marker ? output.slice(marker.index) : output;
  const codexVisible = isCodexProcessCommand(currentCommand) || CODEX_SURFACE_PATTERN.test(output);

  if (ERROR_PATTERN.test(outputAfterMarker)) {
    return { state: "error", label: "Codex 异常" };
  }
  if (marker && ["needs_confirmation", "completed", "error"].includes(marker.state)) {
    return markerStatus(marker.state, marker.detail);
  }
  if (!session.runtime?.exists) {
    return { state: "not_started", label: "Codex 未启动" };
  }
  if (RECONNECTING_PATTERN.test(outputAfterMarker)) {
    return { state: "reconnecting", label: "Codex 重连中" };
  }
  if (marker) {
    return markerStatus(marker.state, marker.detail);
  }
  if (!codexVisible) {
    return { state: "not_started", label: "Codex 未启动" };
  }
  if (WORKING_PATTERN.test(output)) {
    return { state: "working", label: "Codex 工作中" };
  }
  if (/›\s*$|Type to terminal|review changes|tokens left/i.test(output)) {
    return { state: "completed", label: "Codex 已完成/待命" };
  }
  return { state: "ready", label: "Codex 已启动" };
}

export function isCodexProcessCommand(value: string): boolean {
  return (
    /(?:^|[\s"';&|])(?:[^\s"';&|]*[\\/])?codex(?:\.(?:exe|cmd|ps1|js))?(?=$|[\s"';&|])/i.test(value) ||
    /[\\/]@openai[\\/]codex[\\/][^\s"']*codex\.js(?=$|[\s"'])/i.test(value)
  );
}

export function isInteractiveShellCommand(value: string): boolean {
  const command = value.trim();
  if (!command) {
    return true;
  }
  return /(?:^|[\\/])(?:cmd|powershell|pwsh|bash|zsh|fish|sh|nu)(?:\.exe)?(?:\s|$)/i.test(command);
}

function latestStateMarker(output: string): {
  state: "working" | "needs_confirmation" | "completed" | "reconnecting" | "error";
  detail?: string;
  index: number;
} | null {
  let latest: ReturnType<typeof latestStateMarker> = null;
  STATE_MARKER_PATTERN.lastIndex = 0;
  for (const match of output.matchAll(STATE_MARKER_PATTERN)) {
    latest = {
      state: match[1].toLowerCase() as "working" | "needs_confirmation" | "completed" | "reconnecting" | "error",
      detail: match[2]?.trim(),
      index: match.index ?? 0
    };
  }
  return latest;
}

function markerStatus(
  state: "working" | "needs_confirmation" | "completed" | "reconnecting" | "error",
  detail?: string
): CodexSessionStatus {
  if (state === "needs_confirmation") {
    return { state, label: "Codex 需确认", detail };
  }
  if (state === "completed") {
    return { state, label: "Codex 已完成", detail };
  }
  if (state === "reconnecting") {
    return { state, label: "Codex 重连中", detail };
  }
  if (state === "error") {
    return { state, label: "Codex 异常", detail };
  }
  return { state, label: "Codex 工作中", detail };
}

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r(?!\n)/g, "\n")
    .replace(/\u0000/g, "");
}
