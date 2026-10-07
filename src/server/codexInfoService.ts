import type { CodexGlobalSettings, CodexGlobalSettingsSnapshot, CodexInfo, CodexQuotaWindow, CodexUsage, UpdateCodexGlobalSettings } from "../shared/codexInfoTypes.js";
import { TASK_REASONING_EFFORTS } from "../shared/taskConversationTypes.js";
import type { CodexConversationManager } from "./codexConversationManager.js";
import { CodexRpcError } from "./codexAppServerClient.js";
import type { TaskBillingMode, TaskQuotaSnapshot } from "../shared/taskUsageTypes.js";

type InfoSnapshot = Omit<CodexInfo, "canEditSettings">;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;

export class CodexInfoError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Exposes only account metrics and a fixed allowlist of settings; never returns raw config/auth. */
export class CodexInfoService {
  private cached?: InfoSnapshot;
  private inFlight?: Promise<InfoSnapshot>;
  private generation = 0;
  private accountType: string | null = null;
  private defaultProvider = "openai";
  private providerHosts = new Map<string, string | null>();
  constructor(private readonly manager: CodexConversationManager) {}

  async read(force = false): Promise<InfoSnapshot> {
    const age = this.cached ? Date.now() - Date.parse(this.cached.fetchedAt) : Infinity;
    if (this.cached && age < (force ? 5000 : 60000)) return this.cached;
    if (!this.inFlight) {
      const pending = this.fetch(this.generation);
      this.inFlight = pending;
      void pending.finally(() => { if (this.inFlight === pending) this.inFlight = undefined; }).catch(() => undefined);
    }
    return this.inFlight;
  }

  private async fetch(generation: number): Promise<InfoSnapshot> {
    const results = await Promise.allSettled([
      this.manager.request("account/read", { refreshToken: false }),
      this.manager.request("account/rateLimits/read", { excludeResetCreditDetails: true }),
      this.manager.request("account/usage/read", {}),
      this.manager.request("config/read", { includeLayers: true }),
      this.manager.models()
    ]);
    const sections = ["account", "quotas", "usage", "settings", "models"] as const;
    const errors: InfoSnapshot["errors"] = [];
    results.forEach((result, index) => { if (result.status === "rejected") errors.push({ section: sections[index], message: readError(result.reason, sections[index]) }); });
    const raw = (index: number) => results[index].status === "fulfilled" ? object(results[index].value) : null;
    const account = object(raw(0)?.account);
    if(generation===this.generation)this.accountType = string(account.type);
    if (generation===this.generation&&raw(3)) {
      const config = object(raw(3)?.config);
      this.defaultProvider = string(config.model_provider) ?? "openai";
      this.providerHosts.clear();
      for (const [name, value] of Object.entries(object(config.model_providers))) {
        const provider = object(value);
        try { this.providerHosts.set(name, new URL(String(provider.base_url ?? provider.baseUrl)).hostname.toLowerCase()); }
        catch { this.providerHosts.set(name, null); }
      }
      if (string(config.openai_base_url)) try { this.providerHosts.set("openai", new URL(String(config.openai_base_url)).hostname.toLowerCase()); } catch { /* Invalid provider config is not a subscription route. */ }
    }
    const quotaResult = raw(1);
    const quotaMap = object(quotaResult?.rateLimitsByLimitId);
    const buckets = Object.keys(quotaMap).length ? Object.values(quotaMap) : quotaResult?.rateLimits ? [quotaResult.rateLimits] : [];
    const snapshot: InfoSnapshot = {
      fetchedAt: new Date().toISOString(),
      account: string(account.type) ? { type: string(account.type)!, email: string(account.email), plan: string(account.planType) } : null,
      quotas: quotaResult ? buckets.map(value => {
        const bucket = object(value);
        return { id: string(bucket.limitId) ?? "codex", name: string(bucket.limitName) ?? string(bucket.limitId) ?? "Codex", plan: string(bucket.planType), primary: quotaWindow(bucket.primary), secondary: quotaWindow(bucket.secondary) };
      }) : null,
      usage: raw(2) ? projectUsage(raw(2)!) : null,
      settings: raw(3) ? projectSettings(raw(3)!) : null,
      models: results[4].status === "fulfilled" ? results[4].value as CodexInfo["models"] : [],
      errors
    };
    if (generation === this.generation) this.cached = snapshot;
    return snapshot;
  }

  billingContext(provider?: string): { mode: TaskBillingMode; accountQuota: TaskQuotaSnapshot | null } {
    const name = provider || this.defaultProvider;
    const host = this.providerHosts.get(name);
    const official = host ? host === "openai.com" || host.endsWith(".openai.com") || host === "chatgpt.com" || host.endsWith(".chatgpt.com") : name === "openai";
    const mode: TaskBillingMode = !this.cached ? "unknown" : !official ? "relay" : this.accountType && ["chatgpt", "chatgptAuthTokens", "agentIdentity", "personalAccessToken"].includes(this.accountType) ? "subscription" : this.accountType ? "relay" : "unknown";
    const bucket = this.cached?.quotas?.find(quota => quota.id === "codex") ?? this.cached?.quotas?.[0];
    return { mode, accountQuota: mode === "subscription" ? bucket?.primary ?? bucket?.secondary ?? null : null };
  }

  async save(input: unknown): Promise<CodexGlobalSettingsSnapshot> {
    const value = object(input);
    const allowed = new Set(["model", "effort", "approvalsReviewer", "serviceTier", "expectedVersion"]);
    if (Object.keys(value).some(key => !allowed.has(key))) throw new CodexInfoError(400, "包含不支持的 Codex 设置");
    if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 150
      || !TASK_REASONING_EFFORTS.includes(value.effort as CodexGlobalSettings["effort"])
      || !["auto_review", "user"].includes(String(value.approvalsReviewer))
      || !["default", "priority"].includes(String(value.serviceTier))
      || !(value.expectedVersion === null || typeof value.expectedVersion === "string" && value.expectedVersion.length <= 150)) throw new CodexInfoError(400, "Codex 设置无效，请重新选择");
    const models = await this.manager.models();
    const model = models.find(model => model.id === value.model);
    if (!model) throw new CodexInfoError(400, "当前 Codex 未提供所选模型");
    if (model.efforts.length && !model.efforts.includes(value.effort as CodexGlobalSettings["effort"])) throw new CodexInfoError(400, "所选模型不支持该推理强度");
    const current = object(await this.manager.request("config/read", { includeLayers: true }));
    const currentSettings = projectSettings(current);
    if (currentSettings.version !== value.expectedVersion) throw new CodexInfoError(409, "Codex 设置已在其他地方修改，请刷新后再保存");
    const settings = value as unknown as UpdateCodexGlobalSettings;
    try {
      await this.manager.request("config/batchWrite", {
        expectedVersion: currentSettings.version,
        reloadUserConfig: false,
        edits: [
          { keyPath: "model", value: settings.model, mergeStrategy: "replace" },
          { keyPath: "model_reasoning_effort", value: settings.effort, mergeStrategy: "replace" },
          { keyPath: "approval_policy", value: "on-request", mergeStrategy: "replace" },
          { keyPath: "approvals_reviewer", value: settings.approvalsReviewer, mergeStrategy: "replace" },
          { keyPath: "service_tier", value: settings.serviceTier, mergeStrategy: "replace" }
        ]
      });
    } catch (error) {
      if (error instanceof Error && /version|changed|conflict/i.test(error.message)) throw new CodexInfoError(409, "Codex 设置已变化，请刷新后再保存");
      throw new CodexInfoError(400, "Codex 未接受这些设置，请检查本机或管理员的配置限制");
    }
    this.cached = undefined;
    this.generation++;
    this.inFlight = undefined;
    const saved = projectSettings(object(await this.manager.request("config/read", { includeLayers: true })));
    return saved;
  }
}

function quotaWindow(value: unknown): CodexQuotaWindow | null {
  const window = object(value);
  const used = number(window.usedPercent);
  if (used === null) return null;
  const reset = number(window.resetsAt);
  return { usedPercent: Math.min(100, used), windowMinutes: number(window.windowDurationMins), resetsAt: reset !== null && reset < 8.64e12 ? new Date(reset * 1000).toISOString() : null };
}

export function projectUsage(raw: Record<string, unknown>): CodexUsage {
  const summary = object(raw.summary);
  // Duplicate dates describe the same bucket, so do not sum them twice.
  const days = new Map<string, number>();
  if (Array.isArray(raw.dailyUsageBuckets)) for (const entry of raw.dailyUsageBuckets) {
    const bucket = object(entry), date = string(bucket.startDate), tokens = number(bucket.tokens);
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date && tokens !== null) days.set(date, Math.max(days.get(date) ?? 0, tokens));
  }
  const daily = Array.isArray(raw.dailyUsageBuckets) ? [...days].map(([date, tokens]) => ({ date, tokens })).sort((a, b) => a.date.localeCompare(b.date)) : null;
  return { daily, latestDate: daily?.at(-1)?.date ?? null, lifetimeTokens: number(summary.lifetimeTokens), peakDailyTokens: number(summary.peakDailyTokens), currentStreakDays: number(summary.currentStreakDays), longestStreakDays: number(summary.longestStreakDays) };
}

function projectSettings(raw: Record<string, unknown>): CodexGlobalSettingsSnapshot {
  const config = object(raw.config);
  const layers = Array.isArray(raw.layers) ? raw.layers : [];
  const userLayer = layers.map(object).find(layer => object(layer.name).type === "user" && !object(layer.name).profile);
  return { version: string(userLayer?.version), values: {
    model: string(config.model) ?? "",
    effort: TASK_REASONING_EFFORTS.includes(config.model_reasoning_effort as CodexGlobalSettings["effort"]) ? config.model_reasoning_effort as CodexGlobalSettings["effort"] : "medium",
    approvalsReviewer: config.approvals_reviewer === "auto_review" || config.approvals_reviewer === "guardian_subagent" ? "auto_review" : "user",
    serviceTier: config.service_tier === "priority" ? "priority" : "default"
  } };
}

function readError(error: unknown, section: InfoSnapshot["errors"][number]["section"]): string {
  if (error instanceof CodexRpcError && error.code === -32601) return "当前 Codex 版本不支持这项信息，请升级 Codex 后刷新。";
  if (error instanceof Error && /auth|login|sign.?in|token.*expired|401/i.test(error.message)) return "Codex 登录状态不可用，请在本机重新登录后刷新。";
  if (section === "usage" || section === "quotas") return "当前账户暂未返回这项数据，请稍后刷新；API Key 登录可能不提供账户额度和历史用量。";
  return "读取 Codex 信息失败，请刷新或检查本机 Codex 连接。";
}
