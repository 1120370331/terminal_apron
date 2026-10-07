export interface TaskProcessingTime {
  processedDurationMs?: number | null;
  processedVerifiedDurationMs?: number | null;
  processingStartedAt?: string | null;
  processedTimingCoverage?: "complete" | "partial";
  processedTimingSince?: string | null;
  processedRecoveredDurationMs?: number;
}

/** Use only the server's accumulated intervals and current interval start. */
export function taskProcessedDuration(processing: TaskProcessingTime | null | undefined, now = Date.now()): number | undefined {
  const elapsed = processing?.processedVerifiedDurationMs ?? processing?.processedDurationMs;
  if (elapsed != null && (!Number.isFinite(elapsed) || elapsed < 0)) return undefined;
  if (!processing?.processingStartedAt) return elapsed ?? undefined;
  const startedAt = Date.parse(processing.processingStartedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return elapsed ?? undefined;
  return (elapsed ?? 0) + Math.max(0, now - startedAt);
}

export function hasTaskProcessingClock(processing: TaskProcessingTime | null | undefined): boolean {
  return !!processing?.processingStartedAt && Number.isFinite(Date.parse(processing.processingStartedAt));
}

export function taskProcessedTimeView(processing: TaskProcessingTime | null | undefined, now = Date.now()) {
  const duration = taskProcessedDuration(processing, now);
  const partial = processing?.processedTimingCoverage === "partial" || (processing?.processedTimingCoverage !== "complete" && processing?.processedDurationMs == null);
  const known = duration !== undefined && (duration > 0 || !partial || hasTaskProcessingClock(processing));
  const scope = "累计规划、执行和自动检查时间，不计暂停、阻塞及人工等待。";
  let title = partial ? "历史记录不完整，显示可核实处理时间的下限，并非完整总时长。" : scope;
  if (partial && (processing?.processedRecoveredDurationMs ?? 0) > 0) title += "历史部分取已结束命令的最长执行时长作为保守下限，不相加可能重叠的命令。";
  if (partial && processing?.processedTimingSince) title += `后续累计自 ${processing.processedTimingSince} 起的实际处理区间。${scope}`;
  if (!known) title += "没有可核实的执行区间，未按任务创建时间估算；后续执行会开始记录。";
  const formatted = partial && duration !== undefined && duration > 0 && duration < 1000 ? `${Math.floor(duration)}ms` : formatTaskProcessedTime(duration);
  return { partial, title, label: known ? partial ? "已核实" : "已处理" : "暂无可核实时长", value: known ? `${partial ? "≥" : ""}${formatted}` : "" };
}

export function formatTaskProcessedTime(durationMs: number | null | undefined): string {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) return "—";
  let seconds = Math.floor(durationMs / 1000);
  const parts: string[] = [];
  for (const [size, unit] of [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]] as const) {
    const value = Math.floor(seconds / size);
    seconds %= size;
    if (value) parts.push(`${value}${unit}`);
    if (parts.length === 2) break;
  }
  return parts.join("") || "0s";
}
