import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { TaskExecutionJob, TaskExecutionRun, TaskModeState } from "../../shared/taskModeTypes.js";

export const TASK_MODE_INLINE_CHAR_LIMIT=60000;

/** Keep the immutable full input and evidence on disk; Codex reads large material on demand. */
export function prepareTaskModeInput(contextDirectory:string,state:TaskModeState,run:TaskExecutionRun,job:TaskExecutionJob) {
  if(job.text.length<=TASK_MODE_INLINE_CHAR_LIMIT)return {text:job.text};
  const digest=crypto.createHash("sha256").update(job.text).digest("hex");
  const key=crypto.createHash("sha256").update(`${run.id}:${job.id}`).digest("hex").slice(0,20);
  const directory=path.join(contextDirectory,"execution-contexts",`${key}-${digest.slice(0,16)}`);
  fs.mkdirSync(directory,{recursive:true});
  const inputPath=path.join(directory,"original-input.md"),evidencePath=path.join(directory,"evidence.json");
  fs.writeFileSync(inputPath,job.text,"utf8");
  const instructions=state.instructions.filter(entry=>run.instructionIds.includes(entry.id));
  const workers=run.jobs.filter(entry=>entry.role==="worker");
  fs.writeFileSync(evidencePath,JSON.stringify({taskId:state.taskId,runId:run.id,jobId:job.id,role:job.role,requirements:instructions.map(entry=>({id:entry.id,text:entry.text,snapshot:entry.snapshot})),workers:workers.map(worker=>({id:worker.id,name:worker.name,status:worker.status,cycle:worker.cycle??0,ownerId:worker.ownerId??worker.id,objective:worker.objective,ownedPaths:worker.ownedPaths,result:worker.output,fileChanges:worker.items.filter(item=>item.kind==="file_change"),commands:worker.items.filter(item=>item.kind==="command")}))},null,2),"utf8");
  const preview=job.text.slice(0,16000);
  const summaries=workers.slice(0,8).map(worker=>`${worker.name.slice(0,160)} · ${worker.status}\n${typeof worker.output?.summary==="string"?worker.output.summary.slice(0,1600):"完整结果见证据文件"}`).join("\n\n");
  const text=[
    "本次输入包含大段任务材料，已完整保存在任务上下文目录。下面的预览不是全部需求或全部证据。",
    `你的角色：${job.role} · ${job.name.slice(0,200)}`,
    `完整原始输入（UTF-8 Markdown）：${JSON.stringify(inputPath)}`,
    `结构化原文、需求快照与 Worker 完整证据（UTF-8 JSON）：${JSON.stringify(evidencePath)}`,
    `原始输入 SHA256：${digest}；原始输入 ${job.text.length} 字符。`,
    "先读取完整原始输入的角色要求及 evidence.json 的 requirements，保留全部用户原文、附件和引用。优先检查 workers 中每个 ownerId 的最新 cycle 结果、验证、风险、阻塞、文件改动和命令证据，较早结果用于追溯。可用 JSON 解析按 Worker 和字段分批读取，再直接检查实际代码与证据文件；不要一次输出整个大文件，也不要把全部 Diff 重新复制进会话。",
    "已有任务记录、代码和发布产物沿用。只执行当前角色尚未完成的步骤，不重做已通过的内容；需要修复或补验时交回原负责人。持续推进整个任务到可验收，只有真实阻塞、关键需求不明确或异常才暂停。继续使用本线程，由 Codex 管理历史上下文与自动压缩。",
    "角色要求与输入前缀预览：\n"+preview,
    "Worker 结果概览（完整证据以上述文件为准）：\n"+summaries
  ].join("\n\n");
  return {text,packet:{path:inputPath,evidencePath,sha256:digest,originalCharacters:job.text.length,submittedCharacters:text.length}};
}
