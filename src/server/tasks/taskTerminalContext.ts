import fs from "node:fs";
import path from "node:path";
import type { TaskItem } from "../../shared/taskTypes.js";
import { TaskValidationError } from "./taskStore.js";

export function selectTaskTerminalCwd(task: Pick<TaskItem, "contextDirectory" | "repositoryPath">): string {
  const directory = path.resolve(task.contextDirectory);
  const contextFile = path.join(directory, "context.md");
  try {
    if (!fs.statSync(directory).isDirectory() || !fs.statSync(contextFile).isFile()) {
      throw new Error("invalid context workspace");
    }
  } catch {
    throw new TaskValidationError("task context workspace is unavailable; refresh it before allocating a terminal");
  }
  return directory;
}
