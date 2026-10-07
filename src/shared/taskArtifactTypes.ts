export type TaskArtifactFormat = "html" | "markdown";
export const TASK_HTML_PREVIEW_POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

export function taskArtifactFormat(filename: string, mimeType = ""): TaskArtifactFormat | undefined {
  if (/\.html?$/i.test(filename) || mimeType.split(";")[0] === "text/html") return "html";
  if (/\.(md|markdown)$/i.test(filename) || mimeType.split(";")[0] === "text/markdown") return "markdown";
  return undefined;
}

export function taskArtifactLink(taskId: string, source: { attachmentId: string } | { runId: string }): string {
  const params = new URLSearchParams({ mode: "artifact", task: taskId });
  if ("attachmentId" in source) params.set("attachment", source.attachmentId);
  else params.set("run", source.runId);
  return `/task-monitor/?${params}`;
}

export interface TaskRunReportDocument {
  taskId: string;
  taskKey: string;
  taskTitle: string;
  runId: string;
  title: string;
  markdown: string;
}
