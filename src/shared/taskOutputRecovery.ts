import type { TaskExecutionJob } from "./taskModeTypes.js";

export const LEGACY_TASK_OUTPUT_ERROR = "代理返回了无法解析的结构化结果，原始输出已保留";

export function isTaskOutputFailure(job: TaskExecutionJob): boolean {
  return job.status === "failed" && (job.errorCode === "invalid_structured_output" || job.error === LEGACY_TASK_OUTPUT_ERROR);
}
