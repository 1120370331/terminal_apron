import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TASK_MONITOR_SKILL_NAME = "manage-terminal-apron-tasks";

export type TaskSkillInstallStatus =
  | "linked"
  | "already_linked"
  | "source_missing"
  | "conflict"
  | "error";

export interface TaskSkillInstallResult {
  status: TaskSkillInstallStatus;
  source: string;
  destination: string;
  message?: string;
}

interface EnsureTaskSkillOptions {
  projectRoot: string;
  homeDir?: string;
}

export function taskSkillSource(projectRoot: string): string {
  return path.resolve(projectRoot, ".agents", "skills", TASK_MONITOR_SKILL_NAME);
}

export function findTaskSkillProjectRoot(candidates: string[]): string | undefined {
  return candidates
    .map((candidate) => path.resolve(candidate))
    .find((candidate) => fs.existsSync(path.join(taskSkillSource(candidate), "SKILL.md")));
}

export function ensureTaskSkillAvailable(options: EnsureTaskSkillOptions): TaskSkillInstallResult {
  const source = taskSkillSource(options.projectRoot);
  const destination = path.resolve(
    options.homeDir ?? os.homedir(),
    ".agents",
    "skills",
    TASK_MONITOR_SKILL_NAME
  );

  if (!fs.existsSync(path.join(source, "SKILL.md"))) {
    return {
      status: "source_missing",
      source,
      destination,
      message: "Bundled TaskMonitor skill is missing"
    };
  }

  try {
    const destinationStat = lstatIfPresent(destination);
    if (destinationStat) {
      if (sameRealPath(source, destination)) {
        return { status: "already_linked", source, destination };
      }
      return {
        status: "conflict",
        source,
        destination,
        message: "A different user-level skill already exists; it was preserved"
      };
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
    return { status: "linked", source, destination };
  } catch (error) {
    return {
      status: "error",
      source,
      destination,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function lstatIfPresent(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function sameRealPath(left: string, right: string): boolean {
  try {
    const normalizedLeft = path.normalize(fs.realpathSync(left));
    const normalizedRight = path.normalize(fs.realpathSync(right));
    return process.platform === "win32"
      ? normalizedLeft.toLocaleLowerCase() === normalizedRight.toLocaleLowerCase()
      : normalizedLeft === normalizedRight;
  } catch {
    return false;
  }
}
