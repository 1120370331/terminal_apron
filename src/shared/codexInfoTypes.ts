import type { TaskApprovalsReviewer, TaskConversationModel, TaskReasoningEffort } from "./taskConversationTypes.js";

export interface CodexGlobalSettings {
  model: string;
  effort: TaskReasoningEffort;
  approvalsReviewer: TaskApprovalsReviewer;
  serviceTier: "default" | "priority";
}
export interface CodexGlobalSettingsSnapshot {
  values: CodexGlobalSettings;
  version: string | null;
}
export interface UpdateCodexGlobalSettings extends CodexGlobalSettings { expectedVersion: string | null }
export interface CodexQuotaWindow {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: string | null;
}
export interface CodexQuota {
  id: string;
  name: string;
  plan: string | null;
  primary: CodexQuotaWindow | null;
  secondary: CodexQuotaWindow | null;
}
export interface CodexDailyUsage { date: string; tokens: number }
export interface CodexUsage {
  daily: CodexDailyUsage[] | null;
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  latestDate: string | null;
}
export interface CodexInfo {
  fetchedAt: string;
  account: { type: string; email: string | null; plan: string | null } | null;
  quotas: CodexQuota[] | null;
  usage: CodexUsage | null;
  settings: CodexGlobalSettingsSnapshot | null;
  models: TaskConversationModel[];
  canEditSettings: boolean;
  errors: Array<{ section: "account" | "quotas" | "usage" | "settings" | "models"; message: string }>;
}
