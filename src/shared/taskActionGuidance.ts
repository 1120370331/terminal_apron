import type { TaskRunResult } from "./taskModeTypes.js";

/** Missing legacy guidance is a reporting defect, never proof that no human input is needed. */
export function hasTaskActionGuidance(result: Pick<TaskRunResult, "status" | "stopReason" | "humanActions" | "agentNextSteps">): boolean {
  return typeof result.stopReason === "string" && (["done","in_progress"].includes(result.status) || Boolean(result.stopReason.trim()))
    && Array.isArray(result.humanActions) && result.humanActions.every(item => item && [item.action, item.reason, item.unblocks].every(value => typeof value === "string" && Boolean(value.trim())))
    && Array.isArray(result.agentNextSteps) && result.agentNextSteps.every(value => typeof value === "string" && Boolean(value.trim()))
    && (result.status !== "blocked" || result.humanActions.length > 0 || result.agentNextSteps.length > 0);
}
