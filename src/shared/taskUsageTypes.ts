export type TaskBillingMode = "subscription" | "relay" | "unknown";
export interface TaskTokenCounts {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}
export interface TaskQuotaSnapshot { usedPercent: number; windowMinutes: number | null; resetsAt: string | null }
export interface RelayUsageRates { currency: "USD" | "CNY"; inputPerMillion: number; cachedInputPerMillion: number; outputPerMillion: number }
export interface RelayUsageCost { amount: number; currency: "USD" | "CNY"; source: "codex" | "configured_rates" }
export interface TaskThreadUsage {
  threadId: string;
  name: string;
  mode: TaskBillingMode;
  tokens: TaskTokenCounts | null;
  estimatedCredits: number | null;
  estimatedUsd: number | null;
  relayCost: RelayUsageCost | null;
  accountQuota: TaskQuotaSnapshot | null;
  updatedAt: string | null;
}
export interface TaskUsageSummary {
  mode: TaskBillingMode | "mixed";
  tokens: TaskTokenCounts | null;
  estimatedCredits: number | null;
  estimatedUsd: number | null;
  relayCost: RelayUsageCost | null;
  accountQuota: TaskQuotaSnapshot | null;
  complete: boolean;
  updatedAt: string | null;
  threads: TaskThreadUsage[];
}
