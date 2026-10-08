import type { TaskModeState, TaskRunResult } from "../../shared/taskModeTypes.js";

/** Display projection only. Execution and evidence always use the complete state. */
export function projectTaskWorkspace(state: TaskModeState): TaskModeState {
  const result = (value: TaskRunResult | undefined) => value && {
    ...value, changes: [], changesDeferred: (value.changes?.length ?? 0) > 0
  };
  return {
    ...state,
    instructions: state.instructions.map(entry => ({ ...entry, result: result(entry.result) })),
    runs: state.runs.map(run => ({ ...run, result: result(run.result), jobs: run.jobs.map(job => ({
      ...job, text: "", items: [], itemsDeferred: (job.items?.length ?? 0) > 0,
      output: job.output && job.role !== "worker" ? Object.fromEntries(
        ["summary", "userUpdate", "understanding"].filter(key => typeof job.output![key] === "string").map(key => [key, job.output![key]])
      ) : undefined
    })) }))
  };
}
