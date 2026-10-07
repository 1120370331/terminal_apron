import assert from "node:assert/strict";
import test from "node:test";
import { formatTaskProcessedTime, hasTaskProcessingClock, taskProcessedDuration, taskProcessedTimeView } from "../../src/client/task-mode/taskProcessedTime.js";

const start = "2026-10-07T10:00:00Z", clock = Date.parse(start);
test("new canonical values remain visible while the legacy field is safely null", () => {
  const partial = { processedDurationMs: null, processedVerifiedDurationMs: 569138, processedTimingCoverage: "partial" as const };
  assert.equal(taskProcessedTimeView(partial).value, "≥9m29s");
  assert.equal(taskProcessedDuration({ ...partial, processingStartedAt: start }, clock + 2000), 571138);
  assert.equal(taskProcessedTimeView({ processedDurationMs: 51680, processedVerifiedDurationMs: 51680, processedTimingCoverage: "complete" }).value, "51s");
  // The deployed old calculator returns no numeric total, even with a live start.
  const oldCalculator = (value: typeof partial) => value.processedDurationMs == null ? undefined : value.processedDurationMs;
  assert.equal(oldCalculator(partial), undefined);
});
test("a legacy null total still displays and ticks the authoritative live interval", () => {
  const legacy = { processedDurationMs: null, processingStartedAt: start };
  assert.equal(hasTaskProcessingClock(legacy), true);
  assert.equal(taskProcessedDuration(legacy, clock + 3000), 3000);
  assert.equal(taskProcessedTimeView(legacy, clock + 3000).value, "≥3s");
  assert.equal(taskProcessedTimeView(legacy, clock + 4000).value, "≥4s");
  assert.equal(taskProcessedTimeView(legacy, clock + 4000).partial, true);
});
test("partial history is explicitly a lower bound and missing records are never presented as total zero", () => {
  const partial = { processedDurationMs: 187386, processedTimingCoverage: "partial" as const, processedRecoveredDurationMs: 187386, processedTimingSince: start };
  const view = taskProcessedTimeView(partial, clock);
  assert.equal(view.value, "≥3m7s"); assert.equal(view.label, "已核实");
  assert.match(view.title, /最长执行时长/); assert.match(view.title, /并非完整总时长/); assert.match(view.title, /2026-10-07/);
  assert.equal(taskProcessedTimeView({ processedDurationMs: 951, processedTimingCoverage: "partial" }).value, "≥951ms");
  for (const value of [null, 0]) {
    const absent = taskProcessedTimeView({ processedDurationMs: value, processedTimingCoverage: "partial" });
    assert.equal(absent.value, ""); assert.equal(absent.label, "暂无可核实时长");
  }
});
test("new and already valid tasks retain exact duration formatting through pause, resume and refresh", () => {
  assert.equal(taskProcessedTimeView({ processedDurationMs: 0 }).value, "0s");
  assert.equal(taskProcessedTimeView({ processedDurationMs: 51680 }).value, "51s");
  const paused = { processedDurationMs: 8000, processedTimingCoverage: "partial" as const };
  assert.equal(taskProcessedDuration(paused, clock + 500000), 8000);
  const resumed = { ...paused, processingStartedAt: start };
  assert.equal(taskProcessedDuration(JSON.parse(JSON.stringify(resumed)), clock + 2000), 10000);
  assert.equal(formatTaskProcessedTime(9000000), "2h30m");
});
test("invalid starts preserve verified closed time while invalid totals cannot fabricate a number", () => {
  assert.equal(hasTaskProcessingClock({ processingStartedAt: "invalid" }), false);
  assert.equal(taskProcessedDuration({ processedDurationMs: 51680, processingStartedAt: "invalid" }), 51680);
  for (const total of [-1, NaN, Infinity]) assert.equal(taskProcessedDuration({ processedDurationMs: total, processingStartedAt: start }, clock + 1000), undefined);
  assert.equal(taskProcessedDuration({ processedDurationMs: null, processingStartedAt: "invalid" }), undefined);
});
