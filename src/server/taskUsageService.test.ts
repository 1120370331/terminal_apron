import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { TaskStore } from "./tasks/taskStore.js";
import { CodexInfoService } from "./codexInfoService.js";
import { TaskUsageService, estimateRelayCost, safeRolloutPath } from "./tasks/taskUsageService.js";

class Manager extends EventEmitter {
  provider = "openai_http"; host = "chatgpt.com"; bill: any = null; calls: Array<{ method: string; params: any }> = []; files = new Map<string,string>();
  bindThread() {}
  async models() { return []; }
  async request(method: string, params: any) {
    this.calls.push({ method, params });
    if (method === "account/read") return { account: { type: "chatgpt", planType: "pro" } };
    if (method === "config/read") return { config: { model_provider: this.provider, model_providers: { [this.provider]: { base_url: `https://${this.host}/v1`, api_key: "NEVER_RETURN" } } } };
    if (method === "account/rateLimits/read") return { rateLimits: { limitId: "codex", primary: { usedPercent: 75.2, windowDurationMins: 10080, resetsAt: 1791584130 } } };
    if (method === "account/usage/read") return params.threadId ? { summary: {}, threadUsage: this.bill && { ...this.bill, threadId: params.threadId } } : { summary: {}, dailyUsageBuckets: [] };
    if (method === "thread/read") return { thread: { id: params.threadId, modelProvider: this.provider, path: this.files.get(params.threadId) } };
    return {};
  }
}
function counts(total = 1000000) { return { totalTokens: total, inputTokens: total - 100000, cachedInputTokens: total - 200000, outputTokens: 100000, reasoningOutputTokens: 10000 }; }
function usageEvent(taskId: string, threadId: string, total = 1000000) { return { kind: "token_usage_updated", taskId, threadId, occurredAt: new Date().toISOString(), payload: { tokenUsage: { total: counts(total) } } }; }
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apron-task-usage-")); const home = path.join(directory, "codex"); fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
  const store = new TaskStore(path.join(directory, "data")); const task = store.create({ title: "Usage contract", repositoryPath: directory }); store.bindConversation(task.id, "thread-agent", "代理", true); store.bindConversation(task.id, "thread-worker", "Worker", false);
  const manager = new Manager(); const info = new CodexInfoService(manager as any); let service = new TaskUsageService(store, manager as any, info, { codexHome: home });
  return { directory, home, store, task, manager, info, get service() { return service; }, reopen() { service.close(); service = new TaskUsageService(store, manager as any, info, { codexHome: home }); }, close() { store.close(); service.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test("cumulative notifications are deduplicated and task totals count archived conversations once", async () => {
  const f = setup(); try {
    await f.info.read();
    f.manager.emit("event", usageEvent(f.task.id, "thread-agent", 1000000)); f.manager.emit("event", usageEvent(f.task.id, "thread-agent", 1000000));
    f.manager.emit("event", usageEvent(f.task.id, "thread-agent", 1200000)); f.manager.emit("event", usageEvent(f.task.id, "thread-agent", 900000));
    f.manager.emit("event", usageEvent(f.task.id, "thread-worker", 500000));
    f.store.completeConversationArchive(f.task.id, "thread-worker", true);
    const summary = f.service.summary(f.task.id); assert.equal(summary.tokens?.totalTokens, 1700000); assert.equal(summary.threads.length, 2); assert.equal(summary.complete, true);
    assert.equal(summary.accountQuota?.usedPercent, 75.2); assert.equal(summary.estimatedCredits, null);
    f.reopen(); assert.equal(f.service.summary(f.task.id).tokens?.totalTokens, 1700000);
  } finally { f.close(); }
});

test("usage updates for an unrelated task cannot overwrite an owned conversation", async () => {
  const f = setup(); try {
    await f.info.read(); f.manager.emit("event", usageEvent("different-task", "thread-agent", 4000000));
    assert.equal(f.service.thread(f.task.id, "thread-agent").tokens, null);
  } finally { f.close(); }
});

test("backfills real cumulative totals from a bounded rollout tail and ignores prompts or partial lines", async () => {
  const f = setup(); try {
    const file = path.join(f.home, "sessions", "rollout-thread-agent.jsonl"); const raw = counts(2400000);
    const event = JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: raw.totalTokens, input_tokens: raw.inputTokens, cached_input_tokens: raw.cachedInputTokens, output_tokens: raw.outputTokens, reasoning_output_tokens: raw.reasoningOutputTokens } } } });
    fs.writeFileSync(file, JSON.stringify({ type: "user_message", text: "SECRET_PROMPT".repeat(30000) }) + "\n" + event + "\n" + event + '\n{"type":"event_msg","payload":{"type":"token_count"');
    f.manager.files.set("thread-agent", file); await f.service.refreshThread(f.task.id, "thread-agent");
    const thread = f.service.thread(f.task.id, "thread-agent"); assert.equal(thread.tokens?.totalTokens, 2400000);
    assert.equal(JSON.stringify(thread).includes("SECRET_PROMPT"), false); assert.equal(JSON.stringify(thread).includes("rollout"), false);
    assert.equal(f.manager.calls.filter(call => call.method === "thread/read").length, 1);
    await f.service.refreshThread(f.task.id, "thread-agent"); assert.equal(f.manager.calls.filter(call => call.method === "thread/read").length, 1);
  } finally { f.close(); }
});

test("rollout lookup rejects files outside Codex session roots and another thread's file", async () => {
  const f = setup(); try {
    const file = path.join(f.directory, "rollout-thread-agent.jsonl"); fs.writeFileSync(file, "{}\n");
    assert.equal(await safeRolloutPath(f.home, file, "thread-agent"), null);
    const inside = path.join(f.home, "sessions", "rollout-thread-worker.jsonl"); fs.writeFileSync(inside, "{}\n");
    assert.equal(await safeRolloutPath(f.home, inside, "thread-agent"), null);
  } finally { f.close(); }
});

test("relay mode exposes monetary consumption only and uses cached input as a subset of input", async () => {
  const f = setup(); try {
    f.manager.provider = "relay"; f.manager.host = "relay.example.com"; await f.info.read();
    f.service.observeMetadata(f.task.id, "thread-agent", { thread: { modelProvider: "relay" } });
    f.service.saveRates({ currency: "USD", inputPerMillion: 1, cachedInputPerMillion: .1, outputPerMillion: 4 });
    f.manager.emit("event", { ...usageEvent(f.task.id, "thread-agent"), payload: { tokenUsage: { total: { totalTokens: 2500000, inputTokens: 2000000, cachedInputTokens: 1000000, outputTokens: 500000, reasoningOutputTokens: 200000 } } } });
    const thread = f.service.thread(f.task.id, "thread-agent"); assert.equal(thread.mode, "relay"); assert.equal(thread.tokens, null); assert.equal(thread.accountQuota, null);
    assert.equal(thread.relayCost?.amount, 3.1); assert.equal(thread.relayCost?.source, "configured_rates");
    f.reopen(); assert.equal(f.service.rates()?.cachedInputPerMillion, .1); assert.equal(f.service.thread(f.task.id, "thread-agent").relayCost?.amount, 3.1);
  } finally { f.close(); }
});

test("uses native estimated credits and USD amounts when the billing route provides them", async () => {
  const f = setup(); try {
    f.manager.bill = { estimatedUsageCreditsMicros: 1234567, estimatedUsageUsdMicros: 7654321, groups: [] };
    await f.service.refreshThread(f.task.id, "thread-agent");
    const thread = f.service.thread(f.task.id, "thread-agent"); assert.equal(thread.estimatedCredits, 1.234567); assert.equal(thread.estimatedUsd, 7.654321);
    assert.equal(f.service.summary(f.task.id).estimatedCredits, null, "partial billing must not look like a complete task total");
  } finally { f.close(); }
});

test("relay native monetary estimates take precedence over a manually configured rate", async () => {
  const f = setup(); try {
    f.manager.provider = "relay"; f.manager.host = "relay.example.com"; f.manager.bill = { estimatedUsageCreditsMicros: 0, estimatedUsageUsdMicros: 2100000, groups: [] };
    f.service.saveRates({ currency: "CNY", inputPerMillion: 8, cachedInputPerMillion: 1, outputPerMillion: 20 });
    await f.service.refreshThread(f.task.id, "thread-agent"); assert.deepEqual(f.service.thread(f.task.id, "thread-agent").relayCost, { amount: 2.1, currency: "USD", source: "codex" });
  } finally { f.close(); }
});

test("unconfigured relay fees remain unavailable and invalid rates are rejected", async () => {
  const f = setup(); try {
    f.manager.provider = "relay"; f.manager.host = "relay.example.com"; await f.info.read();
    f.service.observeMetadata(f.task.id, "thread-agent", { thread: { modelProvider: "relay" } }); f.manager.emit("event", usageEvent(f.task.id, "thread-agent"));
    assert.equal(f.service.thread(f.task.id, "thread-agent").relayCost, null);
    assert.throws(() => f.service.saveRates({ currency: "USD", inputPerMillion: -1, cachedInputPerMillion: 0, outputPerMillion: 1 }), /有效/);
    assert.throws(() => f.service.saveRates({ currency: "USD", inputPerMillion: 1, cachedInputPerMillion: 0, outputPerMillion: 1, url: "https://other" }), /有效/);
    assert.equal(estimateRelayCost({ ...counts(), inputTokens: 1000000, cachedInputTokens: 2000000, outputTokens: 0 }, { currency: "USD", inputPerMillion: 1, cachedInputPerMillion: .1, outputPerMillion: 1 }), .1);
  } finally { f.close(); }
});

test("closing the parent task store closes usage resources and detaches live listeners", () => {
  const f = setup(); f.store.close(); assert.equal(f.service.isClosed, true); assert.equal(f.manager.listenerCount("event"), 0); f.close();
});
