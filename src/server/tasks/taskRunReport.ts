import type { TaskItem } from "../../shared/taskTypes.js";
import type { TaskExecutionRun, TaskModeState, TaskRunResult } from "../../shared/taskModeTypes.js";
import { taskArtifactLink, type TaskRunReportDocument } from "../../shared/taskArtifactTypes.js";
import { hasTaskActionGuidance } from "../../shared/taskActionGuidance.js";

const statuses = { done: "已完成", blocked: "尚未完成，已暂停", needs_confirmation: "已具备验收条件，等待人工确认", in_progress: "阶段进展，仍在继续执行" };
const checkLabels = { passed: "通过", failed: "未通过", not_run: "未执行" };
const jobLabels = { pending: "待执行", active: "执行中", completed: "已完成", failed: "失败", interrupted: "已中断" };
const line = (value: string) => value.replace(/\s+/g, " ").trim();
const bullets = (items: string[]) => items.map(item => `- ${item}`).join("\n");

function code(value: string) {
  const longest = Math.max(2, ...Array.from(value.matchAll(/`+/g), match => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${value}\n${fence}`;
}

export function formatTaskRunReport(task: TaskItem, state: TaskModeState, run: TaskExecutionRun, result: TaskRunResult): TaskRunReportDocument {
  const title = `${task.key} · ${task.title} · 结果汇总`;
  const paused = result.status === "in_progress" && run.id === state.activeRunId && state.phase === "paused";
  const parts = [`# ${line(title)}`, `任务：${task.key} · 第 ${state.runs.findIndex(item => item.id === run.id) + 1} 轮\n\n开始时间：${run.createdAt}${run.completedAt ? `\n\n本轮结束时间：${run.completedAt}` : ""}`, `## 结论\n\n${paused ? "阶段进展，任务已手动暂停" : statuses[result.status]}${result.status === "in_progress" ? "。此文档仅记录当前阶段，任务尚未完成。" : "。"}`];
  const initial=state.instructions.find(entry=>run.instructionIds.includes(entry.id));
  parts.push(`执行方式：${run.settings.executionMode==="quick"?"快速模式 · 消息代理直接修改、验证并汇报，不分配 Worker":"协作模式 · 代理安排 Worker 实施"}`);
  if(initial?.snapshot.descriptionMd)parts.push(`## 任务目标\n\n${initial.snapshot.descriptionMd}`);
  if (result.stopReason) parts.push(`## 停下原因\n\n${result.stopReason}`);
  parts.push(/^\s*#{1,4}\s+/m.test(result.summary) ? result.summary : `## 进展说明\n\n${result.summary || "尚未提供进展说明。"}`);
  parts.push(`## 验证情况\n\n${result.verification.length ? result.verification.map((check, index) => `### ${index + 1}. ${checkLabels[check.result]}\n\n${check.details || "未提供验证说明。"}\n\n验证命令：\n\n${code(check.command)}`).join("\n\n") : "本轮尚未提供验证记录。"}`);
  parts.push(`## 未完成与风险\n\n${result.risks.length ? bullets([...new Set(result.risks)]) : "本轮汇报未列出风险。"}`);
  if (hasTaskActionGuidance(result)) {
    parts.push(`## 你需要做什么\n\n${result.humanActions!.length ? result.humanActions!.map((item, index) => `${index + 1}. **${item.action}**\n\n   原因：${item.reason}\n\n   完成后：${item.unblocks}`).join("\n\n") : result.status === "needs_confirmation" ? "审查本轮结果和材料，在任务中确认通过或提出修改。" : "当前无需提供材料或决定。"}`);
    parts.push(`## 代理下一步\n\n${result.agentNextSteps!.length ? bullets(result.agentNextSteps!.filter(step=>step.length<=240).slice(0,3)) : result.status === "in_progress" ? "代理仍在继续推进，尚未给出下一步清单。" : "本轮未列出后续工作。"}`);
  } else parts.push("## 你需要做什么\n\n这份汇报缺少具体行动说明。请回到任务，要求代理补齐停下原因、所需条件和下一步。");
  if (result.artifacts.length) parts.push(`## 重要审查材料\n\n${bullets(result.artifacts.map(file => {
    const current = task.attachments.find(item => item.id === file.id);
    if (!current) return `${line(file.name)}（已删除）`;
    const image = ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(current.mimeType);
    const preview = Boolean(current.previewFormat) || image;
    const url = current.previewFormat ? current.previewUrl ?? taskArtifactLink(task.id, {attachmentId: current.id}) : image ? current.url : `${current.url}${current.url.includes("?") ? "&" : "?"}download=1`;
    return `[${preview ? "预览" : "下载"} · ${line(current.name).replace(/[\[\]\\]/g, "\\$&")}](${url})`;
  }))}`);
  if (result.changedFiles.length) parts.push(`## 代码改动\n\n${bullets(result.changedFiles.map(file => line(file)))}`);
  parts.push(`## 本轮需求原文\n\n${state.instructions.filter(entry => run.instructionIds.includes(entry.id)).map(entry => `### 第 ${state.instructions.findIndex(item => item.id === entry.id) + 1} 条指示\n\n${entry.text}\n\n发送时的任务：${line(entry.snapshot.title)}（版本 ${entry.snapshot.revision}）`).join("\n\n")}`);
  parts.push(`## 执行过程\n\n${bullets(run.jobs.map(job => `${line(job.name)} · ${jobLabels[job.status]}${job.error ? ` · ${line(job.error)}` : ""}`))}`);
  const internal=[...new Set([...(result.internalNextSteps??[]),...(result.agentNextSteps??[]).filter((step,index)=>step.length>240||index>=3)])];
  if(internal.length)parts.push(`## 附录：内部执行安排\n\n${bullets(internal)}`);
  if (result.reviewedAt) parts.push(`人工确认时间：${result.reviewedAt}`);
  return { taskId: task.id, taskKey: task.key, taskTitle: task.title, runId: run.id, title, markdown: parts.filter(Boolean).join("\n\n") + "\n" };
}
