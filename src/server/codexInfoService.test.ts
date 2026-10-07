import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { CodexInfoService, projectUsage } from "./codexInfoService.js";
import { CodexRpcError } from "./codexAppServerClient.js";
import { createTaskModeRouter } from "./tasks/taskModeRouter.js";
import { dailyTokens, monthDays, shiftDay, shiftMonth, windowLabel } from "../client/task-mode/codexUsageView.js";

class Manager {
  calls: Array<{ method: string; params: any }> = [];
  fail = "";
  version = "v1";
  config: Record<string, unknown> = { model: "gpt-6.1-sol", model_reasoning_effort: "high", approvals_reviewer: "auto_review", service_tier: "default", secret_api_key: "NEVER_RETURN" };
  async models() { return [{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol", isDefault: true, efforts: ["medium", "high"], defaultEffort: "high" }]; }
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === this.fail) throw new CodexRpcError("PRIVATE_ERROR_SECRET", -32601);
    if (method === "account/read") return { account: { type: "chatgpt", email: "test@example.com", planType: "pro", accessToken: "NEVER_RETURN" } };
    if (method === "account/rateLimits/read") return { rateLimitsByLimitId: { codex: { limitId: "codex", primary: { usedPercent: 74, windowDurationMins: 10080, resetsAt: 1791584130 } } } };
    if (method === "account/usage/read") return { summary: { lifetimeTokens: 1000, currentStreakDays: 2 }, dailyUsageBuckets: [{ startDate: "2026-10-05", tokens: 300 }], threadUsage: [{ text: "NEVER_RETURN" }] };
    if (method === "config/read") return { config: this.config, layers: [{ name: { type: "user" }, version: this.version, config: { password: "NEVER_RETURN" } }] };
    if (method === "config/batchWrite") { for (const edit of params.edits) this.config[edit.keyPath] = edit.value; this.version = "v2"; return { status: "ok", version: this.version }; }
    return {};
  }
}
const settings = { model: "gpt-6.1-sol", effort: "medium", approvalsReviewer: "user", serviceTier: "default", expectedVersion: "v1" };

test("projects official account windows and daily usage without exposing secrets or inventing a daily limit", async () => {
  const manager = new Manager(); const service = new CodexInfoService(manager as any);
  const [a, b] = await Promise.all([service.read(), service.read()]);
  assert.equal(a, b); assert.equal(manager.calls.length, 4);
  assert.equal(a.quotas?.[0].primary?.windowMinutes, 10080);
  assert.equal(a.quotas?.[0].primary?.usedPercent, 74);
  assert.equal(a.usage?.latestDate, "2026-10-05");
  assert.equal(dailyTokens(a.usage!.daily, "2026-10-06"), null);
  assert.equal(a.settings?.version, "v1");
  assert.equal(JSON.stringify(a).includes("NEVER_RETURN"), false);
  await service.read(); assert.equal(manager.calls.length, 4);
});

test("a missing quota endpoint preserves available account and usage data with a safe explanation", async () => {
  const manager = new Manager(); manager.fail = "account/rateLimits/read";
  const info = await new CodexInfoService(manager as any).read();
  assert.equal(info.quotas, null); assert.equal(info.usage?.lifetimeTokens, 1000);
  assert.equal(info.errors[0].section, "quotas");
  assert.equal(JSON.stringify(info.errors).includes("PRIVATE_ERROR_SECRET"), false);
});

test("keeps zero separate from unavailable dates and does not double-count duplicate daily buckets", () => {
  const usage = projectUsage({ dailyUsageBuckets: [{ startDate: "2026-10-05", tokens: 200 }, { startDate: "2026-10-05", tokens: 200 }, { startDate: "2026-10-04", tokens: 0 }, { startDate: "invalid", tokens: 500 }, { startDate: "2026-10-03", tokens: -2 }], summary: { lifetimeTokens: null } });
  assert.deepEqual(usage.daily, [{ date: "2026-10-04", tokens: 0 }, { date: "2026-10-05", tokens: 200 }]);
  assert.equal(dailyTokens(usage.daily, "2026-10-04"), 0);
  assert.equal(dailyTokens(usage.daily, "2026-10-03"), null);
  assert.equal(projectUsage({ dailyUsageBuckets: null }).daily, null);
});

test("saves only permitted Codex defaults through an atomic versioned config edit", async () => {
  const manager = new Manager(); const service = new CodexInfoService(manager as any);
  const saved = await service.save(settings);
  const request = manager.calls.find(call => call.method === "config/batchWrite")!;
  assert.equal(request.params.expectedVersion, "v1");
  assert.equal(request.params.reloadUserConfig, false);
  assert.equal(request.params.filePath, undefined);
  assert.deepEqual(request.params.edits.map((edit: any) => edit.keyPath), ["model", "model_reasoning_effort", "approval_policy", "approvals_reviewer", "service_tier"]);
  assert.equal(saved.version, "v2"); assert.equal(saved.values.approvalsReviewer, "user");
  assert.equal(manager.config.secret_api_key, "NEVER_RETURN");
});

test("rejects stale revisions, arbitrary config paths and incompatible model effort before writing", async () => {
  const manager = new Manager(); const service = new CodexInfoService(manager as any);
  await assert.rejects(() => service.save({ ...settings, expectedVersion: "old" }), /其他地方修改/);
  await assert.rejects(() => service.save({ ...settings, filePath: "other.toml" }), /不支持/);
  await assert.rejects(() => service.save({ ...settings, effort: "xhigh" }), /不支持该推理强度/);
  assert.equal(manager.calls.some(call => call.method === "config/batchWrite"), false);
});

test("only the Apron admin can change machine-wide Codex defaults", async () => {
  const manager = new Manager(); const codexInfo = new CodexInfoService(manager as any);
  const app = express(); app.use(express.json()); app.use((_req, res, next) => { res.locals.user = { name: "guest", method: "password" }; next(); });
  app.use("/api/task-mode", createTaskModeRouter(async () => ({ codexInfo } as any)));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const read = await fetch(`${origin}/api/task-mode/codex-info`); assert.equal(read.status, 200); assert.equal((await read.json() as { canEditSettings: boolean }).canEditSettings, false);
    const write = await fetch(`${origin}/api/task-mode/codex-info/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
    assert.equal(write.status, 403); assert.equal(manager.calls.some(call => call.method === "config/batchWrite"), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("usage calendar handles leap years and month/year boundaries", () => {
  assert.equal(monthDays("2024-02").filter(Boolean).length, 29);
  assert.equal(monthDays("2026-10")[3], "2026-10-01");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftDay("2026-01-01", -1), "2025-12-31");
  assert.equal(windowLabel(1440), "每日额度"); assert.equal(windowLabel(10080), "7 天额度");
});
