import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import type { RelayUsageCost, RelayUsageRates, TaskThreadUsage, TaskTokenCounts, TaskUsageSummary } from "../../shared/taskUsageTypes.js";
import type { TaskConversationEvent } from "../../shared/taskConversationTypes.js";
import type { CodexConversationManager } from "../codexConversationManager.js";
import type { CodexInfoService } from "../codexInfoService.js";
import type { TaskStore } from "./taskStore.js";
import { TaskUsageStore, type StoredThreadUsage } from "./taskUsageStore.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const emptyTokens = (): TaskTokenCounts => ({ totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });

/** Durable per-thread snapshots. Cumulative notifications replace counts rather than adding them. */
export class TaskUsageService extends EventEmitter {
  private readonly data: TaskUsageStore;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly checked = new Map<string, number>();
  private readonly taskRefreshes = new Map<string, Promise<void>>();
  private readonly taskChecked = new Map<string, number>();
  private readonly codexHome: string;
  private detachStoreClose: () => void = () => undefined;
  private closed = false;
  private readonly onEvent = (event: TaskConversationEvent) => {
    if (this.closed || event.kind !== "token_usage_updated" || !event.threadId || !event.payload.tokenUsage) return;
    if (!this.store.getConversationBinding(event.taskId, event.threadId)) return;
    const tokens = projectTokenCounts(object(event.payload.tokenUsage).total);
    if (!tokens) return;
    const saved = this.row(event.taskId, event.threadId);
    if (!saved.tokens || tokens.totalTokens >= saved.tokens.totalTokens) { saved.tokens = tokens; saved.updatedAt = event.occurredAt; this.data.save(saved); this.emit("change", { taskId: event.taskId, threadId: event.threadId, live: true }); }
  };

  constructor(private readonly store: TaskStore, private readonly manager: CodexConversationManager, private readonly info: CodexInfoService, options: { codexHome?: string } = {}) {
    super(); this.data = new TaskUsageStore(store.dbPath);
    this.codexHome = path.resolve(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
    manager.on("event", this.onEvent);
    this.detachStoreClose = store.onClose(() => this.close());
  }
  close(): void { if (this.closed) return; this.closed = true; this.manager.off("event", this.onEvent); this.detachStoreClose(); this.data.close(); }
  get isClosed(): boolean { return this.closed; }

  observeMetadata(taskId: string, threadId: string, raw: unknown): void {
    if (this.closed || !this.store.getConversationBinding(taskId, threadId)) return;
    const thread = object(object(raw).thread ?? raw);
    const row = this.row(taskId, threadId);
    if (typeof thread.modelProvider === "string") row.provider = thread.modelProvider;
    if (typeof thread.path === "string") row.rolloutPath = thread.path;
    row.metadataCheckedAt = new Date().toISOString();
    this.data.save(row);
  }

  thread(taskId: string, threadId: string): TaskThreadUsage {
    const row = this.data.get(taskId, threadId);
    const context = this.info.billingContext(row?.provider);
    const binding = this.store.getConversationBinding(taskId, threadId);
    return { threadId, name: binding?.displayName || "Codex 会话", mode: context.mode,
      tokens: context.mode === "subscription" ? row?.tokens ?? null : null,
      estimatedCredits: row?.estimatedCreditsMicros === undefined ? null : row.estimatedCreditsMicros / 1e6,
      estimatedUsd: row?.estimatedUsdMicros === undefined ? null : row.estimatedUsdMicros / 1e6,
      relayCost: context.mode === "relay" ? relayCost(row, this.data.rates()) : null,
      accountQuota: context.accountQuota, updatedAt: row?.updatedAt ?? null };
  }

  summary(taskId: string): TaskUsageSummary {
    const bindings = [...this.store.listConversationBindings(taskId), ...this.store.listConversationBindings(taskId, true)];
    const threads = [...new Map(bindings.map(binding => [binding.threadId, this.thread(taskId, binding.threadId)])).values()];
    const modes = new Set(threads.map(thread => thread.mode));
    const mode: TaskUsageSummary["mode"] = modes.size > 1 ? "mixed" : threads[0]?.mode ?? this.info.billingContext().mode;
    const subscription = threads.filter(thread => thread.mode === "subscription");
    const known = subscription.filter(thread => thread.tokens !== null);
    const tokens = mode === "subscription" ? known.reduce((sum, thread) => addTokens(sum, thread.tokens!), emptyTokens()) : null;
    const creditComplete = threads.length > 0 && threads.every(thread => thread.estimatedCredits !== null);
    const usdComplete = threads.length > 0 && threads.every(thread => thread.estimatedUsd !== null);
    const costs = threads.map(thread => thread.relayCost);
    const costComplete = threads.length > 0 && costs.every((cost): cost is RelayUsageCost => cost !== null) && new Set(costs.map(cost => cost!.currency)).size === 1;
    return { mode, tokens: mode === "subscription" && (known.length || !threads.length) ? tokens : null,
      estimatedCredits: creditComplete ? threads.reduce((sum, thread) => sum + thread.estimatedCredits!, 0) : null,
      estimatedUsd: usdComplete ? threads.reduce((sum, thread) => sum + thread.estimatedUsd!, 0) : null,
      relayCost: costComplete ? { amount: costs.reduce((sum, cost) => sum + cost!.amount, 0), currency: costs[0]!.currency, source: costs.some(cost => cost!.source === "configured_rates") ? "configured_rates" : "codex" } : null,
      accountQuota: mode === "subscription" ? threads[0]?.accountQuota ?? this.info.billingContext().accountQuota : null,
      complete: mode === "subscription" ? known.length === threads.length : mode !== "unknown" && costComplete,
      updatedAt: threads.map(thread => thread.updatedAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null, threads };
  }

  rates(): RelayUsageRates | null { return this.data.rates(); }
  saveRates(input: unknown): RelayUsageRates {
    const value = object(input);
    if (Object.keys(value).some(key => !["currency", "inputPerMillion", "cachedInputPerMillion", "outputPerMillion"].includes(key)) || !["USD", "CNY"].includes(String(value.currency)) || ["inputPerMillion", "cachedInputPerMillion", "outputPerMillion"].some(key => number(value[key]) === null || Number(value[key]) > 1000000)) throw new Error("请输入有效的中转币种及每 M Token 的费率");
    const rates = value as unknown as RelayUsageRates;
    this.data.saveRates(rates);
    for (const task of this.store.list().tasks) this.emit("change", { taskId: task.id });
    return rates;
  }

  refreshTask(taskId: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    const existing = this.taskRefreshes.get(taskId); if (existing) return existing;
    if (Date.now() - (this.taskChecked.get(taskId) ?? 0) < 10000) return Promise.resolve();
    this.taskChecked.set(taskId, Date.now());
    const work = (async () => {
      await this.info.read(); if (this.closed) return;
      const bindings = [...this.store.listConversationBindings(taskId), ...this.store.listConversationBindings(taskId, true)];
      const unique = [...new Set(bindings.map(binding => binding.threadId))];
      // Bound native metadata and billing requests; cached cards return immediately.
      for (let index = 0; index < unique.length; index += 3) await Promise.all(unique.slice(index, index + 3).map(threadId => this.refreshThread(taskId, threadId)));
      if (!this.closed) this.emit("change", { taskId });
    })().finally(() => this.taskRefreshes.delete(taskId));
    this.taskRefreshes.set(taskId, work); return work;
  }

  refreshThread(taskId: string, threadId: string): Promise<void> {
    if (this.closed || !this.store.getConversationBinding(taskId, threadId)) return Promise.resolve();
    this.manager.bindThread(taskId, threadId);
    const existing = this.inFlight.get(threadId); if (existing) return existing;
    if (Date.now() - (this.checked.get(threadId) ?? 0) < 5000) return Promise.resolve();
    this.checked.set(threadId, Date.now());
    const work = this.fetchThread(taskId, threadId).catch(() => { /* Retain the last known snapshot when a source is temporarily unavailable. */ }).finally(() => this.inFlight.delete(threadId));
    this.inFlight.set(threadId, work); return work;
  }

  private async fetchThread(taskId: string, threadId: string): Promise<void> {
    await this.info.read(); if (this.closed) return;
    let row = this.row(taskId, threadId);
    if ((!row.rolloutPath || !row.provider) && Date.now() - Date.parse(row.metadataCheckedAt || "1970-01-01") >= 60000) {
      try { this.observeMetadata(taskId, threadId, await this.manager.request("thread/read", { threadId, includeTurns: false })); }
      catch { /* Native billing may still be available without a local rollout. */ }
      if (this.closed) return; row = this.row(taskId, threadId);
    }
    if (row.rolloutPath) {
      try {
        const file = await safeRolloutPath(this.codexHome, row.rolloutPath, threadId);
        if (file) {
          const stats = await fs.stat(file); const signature = `${stats.size}:${stats.mtimeMs}`;
          if (signature !== row.rolloutSignature) {
            const tokens = await readRolloutTokenTail(file, stats.size);
            // Re-read after asynchronous IO so a newer live event is not overwritten.
            row = this.row(taskId, threadId);
            if (tokens && (!row.tokens || tokens.totalTokens >= row.tokens.totalTokens)) { row.tokens = tokens; row.updatedAt = new Date().toISOString(); }
            row.rolloutSignature = signature; this.data.save(row);
          }
        }
      } catch {
        if (!this.closed && Date.now() - Date.parse(row.metadataCheckedAt || "1970-01-01") >= 60000) try { this.observeMetadata(taskId, threadId, await this.manager.request("thread/read", { threadId, includeTurns: false })); } catch { /* Retain archived usage. */ }
      }
    }
    if (Date.now() - Date.parse(row.estimateCheckedAt || "1970-01-01") >= 60000) {
      try {
        const result = object(await this.manager.request("account/usage/read", { threadId }));
        if (this.closed) return; row = this.row(taskId, threadId);
        const usage = object(result.threadUsage);
        if (usage.threadId === threadId) {
          const credits = number(usage.estimatedUsageCreditsMicros), usd = number(usage.estimatedUsageUsdMicros);
          if (credits !== null) row.estimatedCreditsMicros = credits;
          if (usd !== null) row.estimatedUsdMicros = usd;
          if (Array.isArray(usage.groups) && usage.groups.length && usage.groups.every(group => ["totalTokens", "inputTokens", "cachedInputTokens", "outputTokens"].every(key => number(object(group)[key]) !== null))) {
            const tokens = usage.groups.reduce<TaskTokenCounts>((sum, entry) => {
              const group = object(entry);
              return addTokens(sum, { totalTokens: number(group.totalTokens)!, inputTokens: number(group.inputTokens) ?? 0, cachedInputTokens: number(group.cachedInputTokens) ?? 0, outputTokens: number(group.outputTokens) ?? 0, reasoningOutputTokens: 0 });
            }, emptyTokens());
            if (!row.tokens || tokens.totalTokens >= row.tokens.totalTokens) row.tokens = tokens;
          }
          row.updatedAt = new Date().toISOString();
        }
      } catch { /* No invented prices for unsupported billing routes. */ }
      if (this.closed) return; row.estimateCheckedAt = new Date().toISOString(); this.data.save(row);
    }
    if (!this.closed) this.emit("change", { taskId, threadId });
  }

  private row(taskId: string, threadId: string): StoredThreadUsage { return this.data.get(taskId, threadId) ?? { taskId, threadId }; }
}

export function projectTokenCounts(raw: unknown): TaskTokenCounts | null {
  const value = object(raw);
  const total = number(value.totalTokens ?? value.total_tokens);
  const input = number(value.inputTokens ?? value.input_tokens), cached = number(value.cachedInputTokens ?? value.cached_input_tokens), output = number(value.outputTokens ?? value.output_tokens);
  if (total === null || input === null || cached === null || output === null) return null;
  return { totalTokens: total, inputTokens: input, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: number(value.reasoningOutputTokens ?? value.reasoning_output_tokens) ?? 0 };
}
export function estimateRelayCost(tokens: TaskTokenCounts, rates: RelayUsageRates): number {
  const cached = Math.min(tokens.inputTokens, tokens.cachedInputTokens);
  return ((tokens.inputTokens - cached) * rates.inputPerMillion + cached * rates.cachedInputPerMillion + tokens.outputTokens * rates.outputPerMillion) / 1e6;
}
function relayCost(row: StoredThreadUsage | null, rates: RelayUsageRates | null): RelayUsageCost | null {
  if (row?.estimatedUsdMicros !== undefined) return { amount: row.estimatedUsdMicros / 1e6, currency: "USD", source: "codex" };
  if (row?.tokens && rates) return { amount: estimateRelayCost(row.tokens, rates), currency: rates.currency, source: "configured_rates" };
  return null;
}
function addTokens(a: TaskTokenCounts, b: TaskTokenCounts): TaskTokenCounts { return Object.fromEntries(Object.keys(a).map(key => [key, a[key as keyof TaskTokenCounts] + b[key as keyof TaskTokenCounts]])) as unknown as TaskTokenCounts; }

export async function safeRolloutPath(home: string, filename: string, threadId: string): Promise<string | null> {
  try {
    const [root, file] = await Promise.all([fs.realpath(home), fs.realpath(filename)]);
    const relative = path.relative(root, file).replaceAll("\\", "/");
    if (!/^(?:sessions|archived_sessions)\//.test(relative) || relative.split("/").includes("..") || path.isAbsolute(relative) || !file.endsWith(".jsonl") || !path.basename(file).includes(threadId)) return null;
    return file;
  } catch { return null; }
}

export async function readRolloutTokenTail(filename: string, size: number): Promise<TaskTokenCounts | null> {
  const handle = await fs.open(filename, "r");
  try {
    const length = Math.min(size, 256 * 1024); const start = size - length;
    const buffer = Buffer.alloc(length); const result = await handle.read(buffer, 0, length, start);
    const text = buffer.subarray(0, result.bytesRead).toString("utf8");
    const lines = text.split(/\r?\n/); if (start > 0) lines.shift();
    for (const line of lines.reverse()) {
      if (!line.includes('"token_count"')) continue;
      try { const event = JSON.parse(line); if (event.type === "event_msg" && event.payload?.type === "token_count") { const tokens = projectTokenCounts(event.payload.info?.total_token_usage); if (tokens) return tokens; } }
      catch { /* A partially written last line will be retried on the next refresh. */ }
    }
    return null;
  } finally { await handle.close(); }
}
