import assert from "node:assert/strict";
import { parseCodexRolloutStatus } from "../src/server/codex.js";
import { detectCodexTerminalStatus } from "../src/shared/codexStatus.js";

function event(type: string, payload: Record<string, unknown> = {}, timestamp = "2026-07-16T00:00:00.000Z") {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: { type, ...payload }
  });
}

const cases = [
  {
    name: "turn started",
    input: event("task_started", { turn_id: "turn-1" }),
    expected: { state: "working", turnId: "turn-1" }
  },
  {
    name: "turn completed after working",
    input: [event("task_started"), event("task_complete", {}, "2026-07-16T00:00:02.000Z")].join("\n"),
    expected: { state: "ready" }
  },
  {
    name: "turn interrupted",
    input: event("turn_aborted", { reason: "interrupted" }),
    expected: { state: "error", errorCode: "interrupted" }
  },
  {
    name: "retrying error remains working",
    input: event("error", { willRetry: true, message: "retrying" }),
    expected: { state: "working" }
  },
  {
    name: "non-retrying error",
    input: event("error", {
      willRetry: false,
      error: {
        message: "connection failed",
        codexErrorInfo: { httpConnectionFailed: { httpStatus: 500 } }
      }
    }),
    expected: { state: "error", errorCode: "httpConnectionFailed", errorMessage: "connection failed" }
  }
] as const;

for (const testCase of cases) {
  const actual = parseCodexRolloutStatus(testCase.input);
  assert.equal(actual.state, testCase.expected.state, testCase.name);
  if ("turnId" in testCase.expected) {
    assert.equal(actual.turnId, testCase.expected.turnId, testCase.name);
  }
  if ("errorCode" in testCase.expected) {
    assert.equal(actual.errorCode, testCase.expected.errorCode, testCase.name);
  }
  if ("errorMessage" in testCase.expected) {
    assert.equal(actual.errorMessage, testCase.expected.errorMessage, testCase.name);
  }
}

const terminalCases = [
  {
    name: "active TUI",
    text: ["• Working (9m 48s • esc to interrupt)", "", "› Use /skills to list available skills", "", "gpt-5.6-sol high · ~\\project"].join("\n"),
    expected: "working"
  },
  {
    name: "idle TUI",
    text: ["─ Worked for 3m 46s ─", "", "› Summarize recent commits", "", "gpt-5.6-sol high · ~\\project"].join("\n"),
    expected: "ready"
  },
  {
    name: "error TUI",
    text: ["■ HTTP 500 responseStreamDisconnected", "", "› Continue", "", "gpt-5.6-sol high · ~\\project"].join("\n"),
    expected: "error"
  },
  {
    name: "ordinary shell",
    text: ["C:\\Users\\rog>"],
    expected: "stopped"
  }
] as const;

for (const testCase of terminalCases) {
  const actual = detectCodexTerminalStatus("", {
    sessionId: "test",
    text: testCase.text,
    capturedAt: "2026-07-16T00:00:00.000Z"
  });
  assert.equal(actual.state, testCase.expected, testCase.name);
}

console.log(`verified ${cases.length} rollout and ${terminalCases.length} terminal status cases`);
