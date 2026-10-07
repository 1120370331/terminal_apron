import { useEffect, useState } from "react";
import { ArrowLeft, Download, FileText, Moon, Sun } from "lucide-react";
import { taskApi, TaskApiError } from "../taskApi";
import { taskModeApi, TaskModeApiError } from "./taskModeApi";
import { taskLink } from "./taskModeView";
import { MarkdownContent } from "../task-monitor/MarkdownContent";
import type { TaskArtifactFormat } from "../../shared/taskArtifactTypes";
import { TASK_HTML_PREVIEW_POLICY } from "../../shared/taskArtifactTypes";
import "./taskArtifact.css";

interface Document { title: string; taskTitle: string; taskKey: string; format: TaskArtifactFormat; content: string; downloadUrl: string }
interface Props { theme: "light" | "dark"; onTheme: () => void; onUnauthorized: () => void }

export function TaskArtifactPage({ theme, onTheme, onUnauthorized }: Props) {
  const params = new URLSearchParams(window.location.search), taskId = params.get("task"), attachmentId = params.get("attachment"), runId = params.get("run");
  const [document, setDocument] = useState<Document | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setDocument(null);setError("");
    void (async () => {
      if (!taskId || (!attachmentId && !runId) || (attachmentId && runId)) throw new Error("汇总文档链接不完整，请从任务中重新打开。");
      let next: Document;
      if (runId) {
        const report = await taskModeApi.runReport(taskId, runId);
        next = { title: report.title, taskTitle: report.taskTitle, taskKey: report.taskKey, format: "markdown", content: report.markdown, downloadUrl: `/api/task-mode/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/report?download=1` };
      } else {
        const task = await taskApi.get(taskId), attachment = task.attachments.find(file => file.id === attachmentId);
        if (!attachment?.previewFormat) throw new Error("材料不存在或不支持预览。请回任务检查附件。");
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachmentId!)}/preview`, { credentials: "include" });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new TaskApiError(typeof body.error === "string" ? body.error : body.error?.message ?? "无法读取材料，请回任务检查附件。", response.status);
        }
        next = { title: attachment.name, taskTitle: task.title, taskKey: task.key, format: attachment.previewFormat, content: await response.text(), downloadUrl: `${attachment.url}${attachment.url.includes("?") ? "&" : "?"}download=1` };
      }
      if (alive) setDocument(next);
    })().catch(error => {
      if (!alive) return;
      if ((error instanceof TaskApiError || error instanceof TaskModeApiError) && error.status === 401) onUnauthorized();
      else setError(error instanceof Error ? error.message : "无法读取汇总文档。");
    });
    return () => { alive = false; };
  }, [taskId, attachmentId, runId, onUnauthorized]);
  useEffect(() => { if (document) window.document.title = document.title + " · Terminal Apron"; }, [document]);
  return <main className="ta-document-page">
    <header className="ta-document-header">
      <a className="ta-document-button" href={taskId ? taskLink(taskId) : "/task-monitor/?mode=task-mode"}><ArrowLeft />返回任务</a>
      <div className="ta-document-heading"><span>{document ? `${document.taskKey} · ${document.taskTitle}` : "任务结果文档"}</span><h1>{document?.title ?? "结果汇总"}</h1></div>
      <div className="ta-document-actions">{document && <a className="ta-document-button" href={document.downloadUrl} download><Download />下载{document.format === "html" ? " HTML" : " Markdown"}</a>}<button className="ta-document-button" onClick={onTheme} aria-label="切换主题">{theme === "dark" ? <Sun /> : <Moon />}</button></div>
    </header>
    {error ? <section className="ta-document-empty" role="alert">{error}</section> : !document ? <section className="ta-document-empty" role="status"><FileText />正在读取汇总文档…</section> : document.format === "html" ? <iframe className="ta-document-html" title={document.title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${TASK_HTML_PREVIEW_POLICY}">` + document.content} /> : <article className="ta-document-markdown"><MarkdownContent source={document.content} /></article>}
  </main>;
}
