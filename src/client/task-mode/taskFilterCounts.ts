import type { TaskItem } from "../../shared/taskTypes";
import type { TaskModeViewPreferences } from "../../shared/taskModeTypes";
import { filterTasks, type ModeSummary } from "./taskModeView";

export type TaskFilterDimension = "status" | "project" | "tag" | "dateField" | "period" | "policy" | "material" | "sort";

/** Predict selecting one option without clearing any other filter. Tasks must
 * come from the same archive scope as the displayed list. No extra requests. */
export function taskFilterCounts(
  tasks: TaskItem[],
  states: Map<string, ModeSummary>,
  view: TaskModeViewPreferences,
  dimension: TaskFilterDimension,
  values: readonly string[],
  today = new Date()
): Map<string, number> {
  if (dimension === "sort") {
    const count = filterTasks(tasks, states, view, today).length;
    return new Map(values.map(value => [value, count]));
  }
  return new Map(values.map(value => [value, filterTasks(tasks, states, {
    ...view,
    filters: { ...view.filters, [dimension]: value }
  }, today).length]));
}
