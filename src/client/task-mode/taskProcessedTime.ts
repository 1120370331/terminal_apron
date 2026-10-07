export interface TaskProcessingTime {
  processedDurationMs?: number | null;
  processingStartedAt?: string | null;
}

/** Use only the server's accumulated intervals and current interval start. */
export function taskProcessedDuration(processing: TaskProcessingTime | null | undefined, now = Date.now()): number | undefined {
  const elapsed = processing?.processedDurationMs;
  if (elapsed == null || !Number.isFinite(elapsed) || elapsed < 0) return undefined;
  if (!processing?.processingStartedAt) return elapsed;
  const startedAt = Date.parse(processing.processingStartedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(now)) return undefined;
  return elapsed + Math.max(0, now - startedAt);
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
