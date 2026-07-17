import type { CodexSessionStatus, SessionPreview, TerminalSession } from "./types.js";

const ANSI_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]/g;

export function resolveCodexStatus(session: TerminalSession, preview?: SessionPreview): CodexSessionStatus {
  const terminalStatus = detectCodexTerminalStatus(session.runtime?.currentCommand || "", preview);
  return mergeCodexStatuses(session.codexStatus, terminalStatus);
}

export function mergeCodexStatuses(
  rolloutStatus: CodexSessionStatus | undefined,
  terminalStatus: CodexSessionStatus
): CodexSessionStatus {
  if (terminalStatus.state === "stopped") {
    return rolloutStatus ?? terminalStatus;
  }

  return {
    ...rolloutStatus,
    ...terminalStatus,
    errorCode:
      terminalStatus.state === "error" ? terminalStatus.errorCode ?? rolloutStatus?.errorCode : undefined,
    errorMessage:
      terminalStatus.state === "error" ? terminalStatus.errorMessage ?? rolloutStatus?.errorMessage : undefined
  };
}

export function detectCodexTerminalStatus(currentCommand: string, preview?: SessionPreview): CodexSessionStatus {
  const lines = terminalLines(preview);
  const recent = lines.slice(-24);
  const immediate = lines.slice(-10);
  const commandShowsCodex =
    /(?:^|[\\/\s])codex(?:\.js|\.exe)?(?:\s|$)/i.test(currentCommand) || /@openai[\\/]codex/i.test(currentCommand);
  const hasComposer = recent.some((line) => /^\s*›(?:\s|$)/u.test(line));
  const hasCodexFooter = recent.some(
    (line) => /\bgpt-[\w.-]+(?:\s+[\w.-]+)?\s+·\s+.*(?:[\\/]|~)/iu.test(line)
  );
  const workingLine = [...immediate]
    .reverse()
    .find((line) => /\bWorking\s*\([^)]*esc to interrupt[^)]*\)/iu.test(line));
  const errorLine = [...immediate]
    .reverse()
    .find((line) => /^\s*■\s+\S/u.test(line) || /^\s*(?:fatal|error)(?::|\s)/iu.test(line));
  const codexVisible =
    commandShowsCodex ||
    Boolean(workingLine) ||
    (hasComposer && hasCodexFooter) ||
    recent.some((line) => /OpenAI Codex|YOLO mode|To continue this session, run codex resume/iu.test(line));

  if (!codexVisible) {
    return { state: "stopped", label: "Codex 未启动" };
  }
  if (errorLine) {
    return {
      state: "error",
      label: "Codex 异常",
      errorMessage: errorLine.replace(/^\s*■\s*/u, "").trim()
    };
  }
  if (workingLine) {
    return { state: "working", label: "Codex 工作中" };
  }
  return { state: "ready", label: "Codex 空闲" };
}

function terminalLines(preview?: SessionPreview): string[] {
  if (preview?.grid?.rows.length) {
    return preview.grid.rows.map((row) => row.segments.map((segment) => segment.text).join("").trimEnd());
  }
  return String(preview?.text || "")
    .replace(ANSI_PATTERN, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd());
}
