import assert from "node:assert/strict";
import test from "node:test";
import { detectCodexStatus } from "../client/codexStatus.js";
import type { SessionPreview, TerminalSession } from "../shared/types.js";

function session(command = "codex.exe --yolo", exists = true): TerminalSession {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "TA-1",
    group: "tests",
    tags: [],
    cwd: "C:\\repo",
    backend: "zellij",
    tmuxName: "ta-1",
    color: "#2f80ed",
    backgroundMode: "inherit",
    archived: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    runtime: {
      exists,
      backend: "zellij",
      persistent: true,
      attached: 0,
      currentPath: "C:\\repo",
      currentCommand: command,
      windows: 1,
      lastAttached: null
    }
  };
}

function preview(text: string): SessionPreview {
  return {
    sessionId: "00000000-0000-4000-8000-000000000001",
    text,
    capturedAt: new Date().toISOString()
  };
}

test("Codex status distinguishes terminal existence from a running Codex", () => {
  assert.equal(detectCodexStatus(session("pwsh.exe")).state, "not_started");
  assert.equal(detectCodexStatus(session("codex.exe --yolo", false)).state, "not_started");
});

test("Codex status consumes the latest TaskMonitor skill marker", () => {
  assert.equal(
    detectCodexStatus(
      session(),
      preview("TASK_MONITOR_STATE: working | started\nTASK_MONITOR_STATE: needs_confirmation | choose migration")
    ).state,
    "needs_confirmation"
  );
  assert.equal(
    detectCodexStatus(
      session(),
      preview("TASK_MONITOR_STATE: needs_confirmation | choose\nTASK_MONITOR_STATE: working | resumed")
    ).state,
    "working"
  );
  assert.equal(detectCodexStatus(session(), preview("TASK_MONITOR_STATE: completed | verified")).state, "completed");
});

test("Codex status surfaces reconnecting and fatal output after an older marker", () => {
  assert.equal(
    detectCodexStatus(session(), preview("TASK_MONITOR_STATE: working | started\nconnection lost, reconnecting"))
      .state,
    "reconnecting"
  );
  assert.deepEqual(
    detectCodexStatus(session(), preview("TASK_MONITOR_STATE: working | started\nthread panicked")),
    { state: "error", label: "Codex 异常" }
  );
  assert.equal(
    detectCodexStatus(session("codex.exe --yolo", false), preview("unexpectedly exited")).state,
    "error"
  );
});
