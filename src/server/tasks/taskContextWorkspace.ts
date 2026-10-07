import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TaskItem, TaskReport } from "../../shared/taskTypes.js";

export interface TaskContextWorkspaceInput {
  task: TaskItem;
  reports: TaskReport[];
}

export interface TaskContextWorkspaceOptions {
  parentDirectory?: string;
  previousDirectory?: string;
}

const CONTEXT_ROOT_NAME = "task-contexts";

export function taskContextRoot(dataDir: string): string {
  return path.resolve(dataDir, CONTEXT_ROOT_NAME);
}

export function taskContextDirectory(dataDir: string, taskKey: string, parentDirectory?: string): string {
  const root = taskContextRoot(dataDir);
  const safeKey = normalizeTaskKey(taskKey);
  const target = parentDirectory ? path.resolve(parentDirectory, "subtasks", safeKey) : path.resolve(root, safeKey);
  assertWithinRoot(root, target);
  return target;
}

export function writeTaskContextWorkspace(
  dataDir: string,
  input: TaskContextWorkspaceInput,
  options: TaskContextWorkspaceOptions = {}
): string {
  const directory = taskContextDirectory(dataDir, input.task.key, options.parentDirectory);
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(taskContextFiles(input))) {
    writeFileAtomic(path.join(directory, name), content);
  }

  const previousDirectory = options.previousDirectory ? path.resolve(options.previousDirectory) : "";
  if (previousDirectory && previousDirectory !== directory) {
    assertWithinRoot(taskContextRoot(dataDir), previousDirectory);
    fs.mkdirSync(previousDirectory, { recursive: true });
    writeFileAtomic(
      path.join(previousDirectory, "context.md"),
      `# Task context moved\n\nThis task moved to: \`${directory}\`\n\nThis directory is retained as a non-destructive handoff marker. Use the new path for current context.\n`
    );
  }
  return directory;
}

export function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function quotePosixLiteral(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function taskContextFiles({ task, reports }: TaskContextWorkspaceInput): Record<string, string> {
  const latestReport = reports[0];
  const childLines = task.subtasks.length
    ? task.subtasks.map((child) => `- ${child.key} · ${child.title}${child.status ? ` · ${child.status}` : ""}`)
    : ["- None"];
  const contextLines = [
    `# ${task.key} · ${task.title}`,
    "",
    "This directory is the durable working root for this task. Read these files before continuing work.",
    "",
    "## Target repository",
    "",
    task.repositoryPath || "No target repository is configured.",
    "",
    ...(task.repositoryPath
      ? [
          "PowerShell:",
          "```powershell",
          `Set-Location -LiteralPath ${quotePowerShellLiteral(task.repositoryPath)}`,
          "```",
          "POSIX shell:",
          "```sh",
          `cd ${quotePosixLiteral(task.repositoryPath)}`,
          "```",
          ""
        ]
      : []),
    "## Current state",
    "",
    `- Group: ${task.group || "Ungrouped"}`,
    `- Tags: ${task.tags.length ? task.tags.join(", ") : "None"}`,
    `- Status: ${task.status}`,
    `- Release: ${task.releaseStatus}`,
    `- Revision: ${task.revision}`,
    `- Updated: ${task.updatedAt}`,
    ...(latestReport
      ? [`- Latest report: ${latestReport.status} · ${latestReport.summary}`, ...(latestReport.nextStep ? [`- Next step: ${latestReport.nextStep}`] : [])]
      : ["- Latest report: None"]),
    "",
    "## Parent",
    "",
    task.parentTask ? `${task.parentTask.key} · ${task.parentTask.title}` : "None",
    "",
    "## Subtasks",
    "",
    ...childLines,
    "",
    "## Canonical artifacts",
    "",
    "- `task.md` — requirements and acceptance criteria",
    "- `project.json` — target project facts",
    "- `reports.json` — full progress history",
    "- `attachments.json` — all attachment metadata with source labels (legacy consumer compatibility)",
    "- `input-attachments.json` — user input attachments included in default requirement snapshots",
    "- `feedback-artifacts.json` — AI feedback material metadata (excluded from default input snapshots)",
    ""
  ];
  return {
    "task.md": [
      `# ${task.key} · ${task.title}`,
      "",
      `- ID: ${task.id}`,
      `- Parent: ${task.parentTask ? `${task.parentTask.key} (${task.parentTask.id})` : "None"}`,
      `- Project: ${task.project || "Unassigned"}`,
      `- Group: ${task.group || "Ungrouped"}`,
      `- Tags: ${task.tags.length ? task.tags.join(", ") : "None"}`,
      `- Status: ${task.status}`,
      `- Priority: ${task.priority}`,
      "",
      "## Description",
      "",
      task.descriptionMd || "No description.",
      "",
      "## Acceptance criteria",
      "",
      task.acceptanceCriteriaMd || "No acceptance criteria.",
      ""
    ].join("\n"),
    "project.json": json({
      project: task.project,
      group: task.group,
      tags: task.tags,
      repositoryPath: task.repositoryPath
    }),
    "context.md": contextLines.join("\n"),
    "reports.json": json(reports),
    "attachments.json": json(task.attachments),
    "input-attachments.json": json(task.attachments.filter(file => file.source !== "feedback")),
    "feedback-artifacts.json": json(task.attachments.filter(file => file.source === "feedback"))
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeFileAtomic(filePath: string, content: string): void {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, filePath);
}

function normalizeTaskKey(taskKey: string): string {
  if (!/^TA-[1-9][0-9]*$/.test(taskKey)) {
    throw new Error(`invalid task key for context workspace: ${taskKey}`);
  }
  return taskKey;
}

function assertWithinRoot(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return;
  }
  throw new Error(`task context path escapes workspace root: ${candidate}`);
}
