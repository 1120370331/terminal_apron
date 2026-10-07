import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { TaskItem, TaskStatus, TaskAttachment, TaskVerification } from "../../shared/taskTypes.js";
import { DEFAULT_TASK_MODE_SETTINGS, type RequirementSnapshot, type SubmitTaskInstruction, type TaskExecutionJob, type TaskExecutionRun, type TaskInstruction, type TaskModeAction, type TaskModeDetail, type TaskModeSettings, type TaskModeState, type TaskRunResult } from "../../shared/taskModeTypes.js";
import type { TaskConversationEvent } from "../../shared/taskConversationTypes.js";
import { TaskConversationService, TaskConversationServiceError } from "./taskConversationService.js";
import { CodexRpcError } from "../codexAppServerClient.js";
import { TaskModeStore } from "./taskModeStore.js";
import { CodexInfoService } from "../codexInfoService.js";
import { isTaskOutputFailure } from "../../shared/taskOutputRecovery.js";
import { parseTaskJobOutput, TaskOutputParseError } from "./taskModeOutput.js";
import { hasTaskActionGuidance } from "../../shared/taskActionGuidance.js";
import { prepareTaskModeInput } from "./taskModeContext.js";
import { formatTaskRunReport } from "./taskRunReport.js";
import { TASK_AGENT_COMMUNICATION } from "../../shared/taskAgentCommunication.js";
import { findTaskSkillProjectRoot, taskSkillSource } from "../taskSkill.js";

const stringSchema = { type: "string" };
const stringsSchema = { type: "array", items: stringSchema };
const objectSchema = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const verificationSchema = { type: "array", items: objectSchema({ command:stringSchema, result:{type:"string",enum:["passed","failed","not_run"]}, details:stringSchema }) };
const workerPlanSchema=objectSchema({workerId:stringSchema,name:stringSchema,objective:stringSchema,ownedPaths:stringsSchema});
const PLAN_SCHEMA = objectSchema({ userUpdate:stringSchema, understanding:stringSchema, workers:{type:"array",minItems:1,maxItems:8,items:workerPlanSchema} });
const WORK_SCHEMA = objectSchema({ summary:stringSchema, changedFiles:stringsSchema, verification:verificationSchema, risks:stringsSchema, blockers:stringsSchema, artifacts:{type:"array",items:objectSchema({path:stringSchema,title:stringSchema})} });
const REVIEW_SCHEMA = objectSchema({status:{type:"string",enum:["done","continue","blocked","needs_confirmation"]},summary:stringSchema,risks:stringsSchema,stopReason:stringSchema,humanActions:{type:"array",items:objectSchema({action:stringSchema,reason:stringSchema,unblocks:stringSchema})},agentNextSteps:stringsSchema,acceptanceReady:{type:"boolean"},pauseCategory:{type:"string",enum:["none","blocked","unclear_requirement","exception"]},remainingWork:stringsSchema,nextWorkers:{type:"array",maxItems:8,items:workerPlanSchema}});
const AGENT_MANDATE="你的责任是持续完成整个任务，直到全部约定验收条件具备真实证据。代码完成、某个 Worker 汇报、CI 成功、预览图和一次阶段汇报都不能作为提前停止的理由。阶段结束后检查剩余工作，优先交回原文件负责人修复或完成验证，然后再次检查。你不直接实现，实际写入、构建、安装或发布安排给具备当前已授权权限的 Worker。尊重用户明确的暂停和审批策略。只有真实阻塞、影响实施的需求不明确、或无法继续的异常才暂停；可独立完成的部分先完成，不把自己能解决的环境问题转交用户。";
const REVIEW_DECISION="按整个任务的验收条件作出持续执行决定。acceptanceReady 只有全部目标已完成且必要验证真实通过才为 true；发现未完成项时为 false，remainingWork 列出每项剩余工作。能够继续处理就返回 status=continue、pauseCategory=none，nextWorkers 写本次后续分工，workerId 复用时填写可复用列表里的真实 ID；新执行者填空字符串，不要自拟编号。优先复用原负责人，不重做已通过的内容。确有外部阻塞、关键需求不明确或异常时返回 blocked，pauseCategory 必须分别为 blocked、unclear_requirement、exception，stopReason 和 humanActions 写具体所需条件。不得以‘需要主线程继续’‘待安装验收’‘阶段完成’或‘有预览待审查’为由停下可继续完成的工作。acceptanceReady=true 后才允许 done/needs_confirmation 和最终人工验收。";
const DOCUMENT_GUIDANCE = "涉及实验、方案比较、较多实施结果或验证证据时，把完整内容整理为一个 Markdown 或自包含 HTML 文档，并在 artifacts 中返回实际 path 和清晰 title。文档按结论、目标与方法、实施或实验结果、验证与证据、未完成与风险、用户需要做什么、下一步分章节；用表格比较数据，区分已验证事实与推测。任务内保留简短结论，详细内容放文档。HTML 的样式、脚本和图表内嵌，图片内嵌或使用归档材料，不能依赖外部脚本或网络请求。文档只是审查材料，不能以产出文档为由提前停止未完成任务。";
const REPORT_GUIDANCE = "汇报必须让人类一眼知道任务的实际进展和下一步。summary 先直接回答任务效果，用 ## 本轮结论、## 已完成、## 尚未完成 分章节，通常不超过600字；内部执行安排不出现在摘要或agentNextSteps。stopReason 解释原执行回合实际停下的原因，不得将本次补报告的只读限制说成用户要求停下。若仅有执行提前结束的证据，应明确代理未继续完成剩余验收，不得虚构用户限制。agentNextSteps 中的主线程、验收进程等内部角色统一写作代理负责的工作；不能以等待主线程为由把可继续执行的工作留给用户。stopReason 写实际停下的原因，区分外部条件与代理可自行解决的技术问题。humanActions 仅列确实需要用户处理的事项，每项 action 写具体动作和提交位置，reason 写为什么必须由用户处理，unblocks 写完成后恢复哪项工作；不要要求在任务文本中粘贴密码或令牌。先检查已有授权材料，不得重复索取。若当前无需用户操作，humanActions 返回空数组，并在 agentNextSteps 写代理负责的具体工作。agentNextSteps 列出代理能独立执行及拿到条件后执行的步骤。禁止用‘可先继续推进’‘下一次汇报再明确’等含糊措辞。不要把浏览器配置占用、下载失败等可修复问题转嫁用户。不得用 CI 构建成功代替安装回归或类型检查通过。";
const STEER_SCHEMA = objectSchema({ userUpdate:stringSchema, deliveryMode:{type:"string",enum:["steer","reply_only"]}, understanding:stringSchema, workerIds:stringsSchema, instructions:stringSchema });
const activePhases = new Set(["planning","working","reviewing"]);
const readyPhases = new Set(["idle","completed","needs_confirmation"]);
const queuedInstruction = (entry:TaskInstruction) => entry.status==="queued"&&!entry.archivedAt&&!entry.deletedAt;
const hasScheduledWork = (state:TaskModeState) => activePhases.has(state.phase) || readyPhases.has(state.phase) && state.instructions.some(queuedInstruction);
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const errorText = (error:unknown) => error instanceof Error ? error.message : String(error);
const text = (value:unknown) => typeof value === "string" ? value : "";
const array = (value:unknown): unknown[] => Array.isArray(value) ? value : [];
const object = (value:unknown): Record<string,unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
const strings = (value:unknown) => array(value).map(text).filter(Boolean);

export class TaskModeError extends Error { constructor(readonly status:number,message:string) { super(message); } }

/** Durable, per-user orchestration. Every task mutation and RPC completion is serialized by task. */
export class TaskModeService extends EventEmitter {
  readonly data: TaskModeStore;
  readonly codexInfo: CodexInfoService;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly scheduled = new Set<string>();
  private readonly observedTasks = new Set<string>();
  private readonly lastProgress = new Map<string, string>();
  private readonly lastBroadcast = new Map<string, number>();
  private readonly timer: NodeJS.Timeout;
  private readonly recoveryBaseMs: number;
  private readonly maxRecoveryAttempts: number;
  private closed = false;
  private readonly onUsageChange = (event:{taskId:string}) => { if(!this.closed)this.emit("change",{taskId:event.taskId}); };
  private readonly onEvent = (event:TaskConversationEvent) => {
    if(!this.observedTasks.has(event.taskId))return;
    if(event.kind!=="token_usage_updated"||event.payload.cached!==true)this.lastProgress.set(event.taskId, event.occurredAt);
    if(event.kind==="warning"&&event.payload.code==="CODEX_AUTO_REVIEW_WARNING"&&text(event.payload.message))void this.serial(event.taskId,async()=>{const state=this.data.ensure(event.taskId);this.save(state,`Codex 自动审批提示：${text(event.payload.message)}`);}).catch(()=>undefined);
    if(["turn_completed","approval_requested","approval_resolved"].includes(event.kind))this.schedule(event.taskId);
    if (["approval_requested", "approval_resolved"].includes(event.kind)) {
      const state = this.data.get(event.taskId);
      if (state) this.data.setProcessing(state, this.isProcessing(state));
    }
    const current=Date.now(),last=this.lastBroadcast.get(event.taskId)??0;
    if(["assistant_delta","plan_delta","command_output_delta","file_change_delta"].includes(event.kind)&&current-last<1000)return;
    this.lastBroadcast.set(event.taskId,current);
    this.emit("change", {taskId:event.taskId});
  };
  constructor(readonly conversations:TaskConversationService, options:{pollMs?:number;recoveryBaseMs?:number;maxRecoveryAttempts?:number}={}) {
    super(); this.data=new TaskModeStore(conversations.store.dbPath, { isProcessing: state => this.isProcessing(state), recoverOrphanedProcessing: true });this.codexInfo=conversations.codexInfo;
    this.recoveryBaseMs=options.recoveryBaseMs??2000;
    this.maxRecoveryAttempts=options.maxRecoveryAttempts??3;
    const states=this.data.all();for(const state of states){
      this.observedTasks.add(state.taskId);
      const run=state.runs.find(run=>run.id===state.activeRunId);
      if(state.phase==="blocked"&&state.error==="后续分工引用了不可复用的 Worker，请代理重新明确负责人"&&run&&!run.result&&!run.jobs.some(job=>job.status==="active")&&run.jobs.some(job=>job.role==="plan"&&job.status==="completed"&&!job.processed&&job.output)&&!this.requireTask(state.taskId).archived){
        state.phase="planning";state.error=undefined;state.heartbeat.status="recovering";state.heartbeat.message="正在恢复已保存的任务分工，无需你操作";state.heartbeat.recoveryAttempts=0;state.heartbeat.nextRetryAt=undefined;
        this.save(state,"自动恢复被执行者标识错误拦截的任务，沿用原需求和已保存的分工");this.syncTaskStatus(state);
      }
      if(state.phase==="blocked"&&!state.error&&run?.result?.status==="blocked"&&!run.result.pauseCategory&&run.result.humanActions?.length===0&&run.result.agentNextSteps?.length&&!run.jobs.some(job=>job.status==="active")&&!this.requireTask(state.taskId).archived){
        const previous=run.result;run.result=undefined;run.completedAt=undefined;
        const decision=this.job("review","任务代理 · 继续推进决定",`${run.settings.agentPrompt}\n${AGENT_MANDATE}\n${REPORT_GUIDANCE}\n${REVIEW_DECISION}\n此前阶段汇报：${JSON.stringify(previous)}\n原始需求：${this.runText(state,run)}\nWorker 结果：${JSON.stringify(this.latestWorkers(run).map(worker=>({workerId:worker.id,name:worker.name,ownedPaths:worker.ownedPaths,result:worker.output})))}`,run.settings.agentModel);
        decision.purpose="continuation_review";decision.cycle=run.iteration??0;decision.threadId=state.agentThreadId;run.jobs.push(decision);state.phase="reviewing";
        this.saveMilestone(state,run,{...previous,status:"in_progress",stopReason:"",acceptanceReady:false});this.save(state,"恢复此前尚有代理可执行工作、且不需要用户条件的阶段，持续推进到可验收");
      }
      if(state.phase==="blocked"&&state.error==="本轮上下文过长，请减少引用文档或拆分指示"&&run&&!run.result&&run.jobs.some(job=>job.role==="review"&&job.status==="pending")&&run.jobs.filter(job=>job.role==="worker").every(job=>job.status==="completed")&&!this.requireTask(state.taskId).archived){
        state.phase="reviewing";state.error=undefined;state.heartbeat.status="recovering";state.heartbeat.recoveryAttempts=0;state.heartbeat.nextRetryAt=undefined;state.heartbeat.message="正在恢复大段材料的检查，沿用已完成的 Worker 结果";
        this.save(state,"恢复此前被单次消息字符限制拦截的检查回合；完整材料按需读取，已完成的 Worker 不重跑");this.syncTaskStatus(state);
      }
    }
    conversations.manager.on("event",this.onEvent);
    conversations.usage.on("change",this.onUsageChange);
    this.timer=setInterval(()=>{for(const state of this.data.all())if(hasScheduledWork(state))this.schedule(state.taskId);},options.pollMs??2500);this.timer.unref();
    for(const state of states)if(hasScheduledWork(state)||this.canRecoverOutput(state))this.schedule(state.taskId);
  }
  close() {if(this.closed)return;this.closed=true;clearInterval(this.timer);this.conversations.manager.off("event",this.onEvent);this.conversations.usage.off("change",this.onUsageChange);this.data.stopProcessing();this.data.close();}
  list(archived=false) {const tasks=this.conversations.store.list({archived}).tasks;return {tasks,states:this.data.all().map(state=>({taskId:state.taskId,phase:state.phase,settings:state.settings,instructionCount:state.instructions.filter(entry=>!entry.deletedAt).length,heartbeat:state.heartbeat,updatedAt:state.updatedAt,processedDurationMs:state.processedDurationMs,processingStartedAt:state.processingStartedAt})),usage:Object.fromEntries(tasks.map(task=>{void this.conversations.usage.refreshTask(task.id).catch(()=>undefined);return[task.id,this.conversations.usage.summary(task.id)];}))};}
  private isProcessing(state: TaskModeState): boolean {
    if (!activePhases.has(state.phase) || this.conversations.store.get(state.taskId)?.archived) return false;
    const run = state.runs.find(run => run.id === state.activeRunId);
    const active = run?.jobs.filter(job => job.status === "active" && job.threadId && job.turnId) ?? [];
    const unblocked = active.some(job => !this.conversations.manager.pendingApprovals(state.taskId, job.threadId!).some(approval => approval.turnId === job.turnId));
    if (active.length && !unblocked) return false;
    if (state.heartbeat.nextRetryAt && Date.parse(state.heartbeat.nextRetryAt) > Date.now()) return false;
    return true;
  }
  detail(taskId:string):TaskModeDetail {
    const task=this.requireTask(taskId),state=this.data.ensure(taskId);
    // Enrich historical replies for display without rewriting the saved execution evidence.
    for(const run of state.runs)for(const job of run.jobs.filter(job=>job.role==="steer"&&job.output)){
      let ids:unknown;try{ids=JSON.parse(job.objective);}catch{continue;}
      if(!Array.isArray(ids))continue;
      const reply=text(job.output?.userUpdate).trim()||text(job.output?.understanding).trim();
      if(reply)for(const entry of state.instructions.filter(entry=>ids.includes(entry.id)))entry.agentReply??=reply;
    }
    // Resolve availability against current task metadata, without rewriting saved result evidence.
    const available = new Map(task.attachments.map(file => [file.id, file]));
    for (const result of [...state.runs.map(run => run.result), ...state.instructions.map(entry => entry.result)]) if (result) result.artifacts = result.artifacts.map(file => available.get(file.id) ?? {...file, deleted: true, url: "", previewUrl: undefined});
    this.observedTasks.add(taskId);
    void this.conversations.usage.refreshTask(taskId).catch(()=>undefined);
    const threadIds=new Set(state.runs.flatMap(run=>run.jobs.map(job=>job.threadId)).filter((value):value is string=>Boolean(value)));
    return {task,state,approvals:[...threadIds].flatMap(threadId=>this.conversations.manager.pendingApprovals(taskId,threadId)),usage:this.conversations.usage.summary(taskId)};
  }
  runReport(taskId:string,runId:string) {
    const task=this.requireTask(taskId),state=this.data.get(taskId),run=state?.runs.find(item=>item.id===runId);
    if(!state||!run)throw new TaskModeError(404,"执行记录不存在");
    const result=run.result??[...state.instructions].reverse().find(entry=>entry.runId===run.id&&entry.result)?.result;
    if(!result)throw new TaskModeError(409,"这一轮尚未产生阶段汇报，请等待代理返回结果");
    return formatTaskRunReport(task,state,run,result);
  }
  async settings(input:unknown, taskId?:string) {
    const normalized=validateSettings(input);
    if(normalized.permissionPreset==="full_access"&&object(input).fullAccessConfirmed!==true)throw new TaskModeError(400,"请明确确认完全访问权限后保存");
    if(taskId)return this.serial(taskId,async()=>{this.requireTask(taskId);const state=this.data.ensure(taskId);state.settings=normalized;const activeRun=state.runs.find(run=>run.id===state.activeRunId);if(activeRun&&!activeRun.result)activeRun.settings.approvalsReviewer=normalized.approvalsReviewer;this.save(state,"任务设置已更新；审批策略用于后续 Codex 回合，其余设置用于下一轮执行");return normalized;});
    this.data.saveSettings(normalized);return normalized;
  }
  submit(taskId:string,input:SubmitTaskInstruction) {
    return this.serial(taskId,async()=>{
      const task=this.requireTask(taskId);if(task.archived)throw new TaskModeError(409,"请先恢复已归档任务");
      const clientMessageId=text(input.clientMessageId).trim();const instructionText=text(input.text);
      if(clientMessageId.length<8||clientMessageId.length>128||!instructionText.trim()||instructionText.length>50000)throw new TaskModeError(400,"指示需要包含有效内容和请求标识");
      const state=this.data.ensure(taskId);const duplicate=state.instructions.find(entry=>entry.clientMessageId===clientMessageId);
      this.observedTasks.add(taskId);
      if(duplicate){if(duplicate.deletedAt)throw new TaskModeError(409,"该需求已删除，请使用新的请求标识创建需求");if(duplicate.text!==instructionText)throw new TaskModeError(409,"相同请求标识不能发送不同指示");return this.detail(taskId);}
      const instruction:TaskInstruction={id:id(),clientMessageId,text:instructionText,timing:input.timing==="after"?"after":"now",status:"queued",createdAt:now(),snapshot:this.snapshot(task,input),deliveries:[]};
      state.instructions.push(instruction);
      if(state.phase==="blocked"&&!state.runs.some(run=>run.jobs.some(job=>job.status==="active"))){state.phase="idle";state.error=undefined;}
      this.save(state,`收到第 ${state.instructions.length} 条指示`);
      // A single scheduler owns the next RPC. HTTP submission returns after durable enqueue.
      this.schedule(taskId);return this.detail(taskId);
    });
  }
  instructionAction(taskId:string,instructionId:string,action:"archive"|"restore"|"delete") {
    return this.serial(taskId,async()=>{
      this.requireTask(taskId);const state=this.data.ensure(taskId),entry=state.instructions.find(value=>value.id===instructionId);
      if(!entry||entry.deletedAt)throw new TaskModeError(404,"需求记录不存在或已删除");
      if(action==="archive")entry.archivedAt??=now();
      else if(action==="restore")entry.archivedAt=undefined;
      else entry.deletedAt=now();
      this.save(state,`第 ${state.instructions.indexOf(entry)+1} 条需求已${action==="archive"?"归档":action==="restore"?"恢复":"删除"}；已发送的原文和执行记录保留`);
      if(action==="restore")this.schedule(taskId);
      return this.detail(taskId);
    });
  }
  action(taskId:string,action:TaskModeAction,runId?:string) {
    return this.serial(taskId,async()=>{
      const task=this.requireTask(taskId);if(task.archived&&action!=="pause")throw new TaskModeError(409,"请先恢复已归档任务再执行操作");const state=this.data.ensure(taskId),run=state.runs.find(item=>item.id===(runId??state.activeRunId));
      if(action==="clarify_report"){
        if(!run?.result||run.id!==state.activeRunId||activePhases.has(state.phase)||run.jobs.some(job=>["active","pending"].includes(job.status)))throw new TaskModeError(409,"请等待当前执行结束后补齐本轮行动说明");
        const review=this.job("review","任务代理 · 补齐行动说明",`${REPORT_GUIDANCE}\n这次仅补齐已有报告的行动说明，不重新执行任务，不创建 Worker，不安装、不发布、不改变候选。仅阅读现有需求、汇报和必要的证据。保持已有完成状态、代码改动和产物事实；没有新验收证据不得将未完成改成完成。\n本轮需求：\n${this.runText(state,run)}\n已有报告：\n${JSON.stringify(run.result)}\nWorker 原始汇报：\n${JSON.stringify(run.jobs.filter(job=>job.role==="worker").map(job=>({name:job.name,result:job.output})))}`,run.settings.agentModel);
        review.purpose="clarify_report";review.threadId=state.agentThreadId;run.reviewAttempt++;run.jobs.push(review);
        state.phase="reviewing";state.error=undefined;state.heartbeat.status="recovering";state.heartbeat.recoveryAttempts=0;state.heartbeat.nextRetryAt=undefined;state.heartbeat.message="正在补齐停下原因和行动说明";
        this.save(state,"代理补齐行动说明，保留已有执行结果和发布候选");this.syncTaskStatus(state);this.schedule(taskId);return this.detail(taskId);
      }
      if(action==="reread_output"){
        const failed=run?.jobs.filter(isTaskOutputFailure)??[];
        const savedReview=run?.result?[...run.jobs].reverse().find(job=>job.purpose==="clarify_report"&&job.status==="completed"&&job.processed):undefined;
        if(state.phase!=="blocked"||!run||run.id!==state.activeRunId||(!failed.length&&!savedReview))throw new TaskModeError(409,"当前没有需要重新读取的汇报");
        const reread=failed.length?failed:[savedReview!];
        for(const job of reread){if(!job.threadId||!job.turnId)throw new TaskModeError(409,"原回合记录缺失，请查看 Codex 对话");job.status="active";job.processed=false;job.error=undefined;job.errorCode="invalid_structured_output";job.outputReadAttempts=0;}
        state.phase=this.executionPhase(run);
        state.error=undefined;state.heartbeat.status="recovering";state.heartbeat.recoveryAttempts=0;state.heartbeat.nextRetryAt=undefined;state.heartbeat.message="正在重新读取原回合的汇报";
        this.save(state,"重新读取汇报，沿用已有回合、代码和执行记录");this.syncTaskStatus(state);this.schedule(taskId);return this.detail(taskId);
      }
      if(action==="approve"){
        if(!run?.result||run.result.status!=="needs_confirmation")throw new TaskModeError(409,"该轮结果不需要确认，或已被确认");
        run.result={...run.result,status:"done",reviewedAt:now()};for(const entry of state.instructions.filter(entry=>run.instructionIds.includes(entry.id)))entry.result=run.result;
        if(state.activeRunId===run.id&&!activePhases.has(state.phase))state.phase=this.hasPendingReview(state)?"needs_confirmation":"completed";
        this.save(state,"人工确认了本轮结果");this.syncTaskStatus(state);this.schedule(taskId);return this.detail(taskId);
      }
      if(action==="pause"){
        if(!activePhases.has(state.phase))throw new TaskModeError(409,"当前没有正在执行的任务");
        state.phase="paused";state.heartbeat.status="idle";state.heartbeat.message="任务已暂停，心跳检查等待恢复";state.heartbeat.nextRetryAt=undefined;this.save(state,"已请求暂停；正在中断代理和 Worker");
        const errors:string[]=[];
        for(const job of run?.jobs.filter(job=>job.status==="active")??[]){if(job.threadId&&job.turnId)try{await this.conversations.interrupt(taskId,job.threadId,job.turnId);}catch(error){errors.push(errorText(error));}}
        if(errors.length){state.error=`部分中断未确认：${errors.join("；")}`;this.save(state,state.error);}
        this.syncTaskStatus(state);return this.detail(taskId);
      }
      if(state.phase!=="paused"&&state.phase!=="blocked")throw new TaskModeError(409,"仅暂停或阻塞的任务可以恢复");
      if(run?.result?.status==="blocked"&&!hasTaskActionGuidance(run.result)&&!run.jobs.some(job=>job.purpose==="clarify_report"&&!job.processed))throw new TaskModeError(409,"本轮缺少具体行动说明，请先补齐行动说明，避免重复执行已有工作");
      state.error=undefined;
      state.heartbeat.status="recovering";state.heartbeat.message="正在确认 Codex 会话并恢复任务";state.heartbeat.recoveryAttempts=0;state.heartbeat.nextRetryAt=undefined;
      if(run&&(!run.result||run.jobs.some(job=>job.purpose==="clarify_report"&&!job.processed))){
        for(const job of run.jobs.filter(job=>job.status==="active")){if(!job.threadId||!job.turnId)continue;const page=await this.conversations.read(taskId,job.threadId,100);const turn=page.detail.turns.find(turn=>turn.id===job.turnId);if(turn?.status==="in_progress")throw new TaskModeError(409,"中断尚未完成，请稍后再恢复，避免重复执行");job.status=turn?.status==="completed"?"active":"interrupted";}
        for(const job of run.jobs.filter(job=>isTaskOutputFailure(job)&&job.threadId&&job.turnId)){job.status="active";job.error=undefined;job.errorCode="invalid_structured_output";job.outputReadAttempts=0;}
        for(const job of run.jobs.filter(job=>["failed","interrupted"].includes(job.status))){job.status="pending";job.turnId=undefined;job.attempt++;job.error=undefined;job.text+="\n\n上一次执行中断或失败。请先检查已有改动和验证记录，再继续未完成部分，避免重复副作用。";}
        state.phase=this.executionPhase(run);
      }else{state.phase="idle";if(run&&!state.instructions.some(queuedInstruction)){const previous=[...state.instructions].reverse().find(entry=>entry.runId===run?.id&&!entry.replyOnly);if(!previous)throw new TaskModeError(409,"请添加下一步指示后重新执行");state.instructions.push({...structuredClone(previous),id:id(),clientMessageId:id(),text:`重试上一轮未完成的需求。请先处理阻塞和风险：${run?.result?.risks.join("；")??""}\n原指示：${previous.text}`,status:"queued",timing:"now",createdAt:now(),agentReceivedAt:undefined,workerReceivedAt:undefined,completedAt:undefined,runId:undefined,result:undefined,agentReply:undefined,replyOnly:undefined,archivedAt:undefined,deletedAt:undefined,deliveries:[]});}}
      this.save(state,"继续执行任务");this.syncTaskStatus(state);this.schedule(taskId);return this.detail(taskId);
    });
  }
  private serial<T>(taskId:string,operation:()=>Promise<T>):Promise<T>{const previous=this.queues.get(taskId)??Promise.resolve();const current=previous.catch(()=>undefined).then(()=>{if(this.closed)throw new Error("Task Mode 已关闭");return operation();});this.queues.set(taskId,current);void current.finally(()=>{if(this.queues.get(taskId)===current)this.queues.delete(taskId);}).catch(()=>undefined);return current;}
  private schedule(taskId:string) {
    if(this.closed||this.scheduled.has(taskId))return;this.scheduled.add(taskId);
    setImmediate(()=>{void this.serial(taskId,()=>this.advance(taskId)).catch(error=>{if(this.closed)return;this.handleAdvanceFailure(taskId,error);}).finally(()=>this.scheduled.delete(taskId));});
  }
  private async advance(taskId:string) {
    const task=this.requireTask(taskId),state=this.data.ensure(taskId);if(task.archived||state.phase==="paused"){this.data.setProcessing(state,false);return;}
    let run=state.runs.find(run=>run.id===state.activeRunId);
    if(state.phase==="blocked"){
      if(!this.canRecoverOutput(state)||!run)return;
      for(const job of run.jobs.filter(isTaskOutputFailure)){job.status="active";job.error=undefined;job.errorCode="invalid_structured_output";}
      state.phase=this.executionPhase(run);
      state.error=undefined;state.heartbeat.status="recovering";state.heartbeat.message="正在重新读取已完成回合的汇报";state.heartbeat.nextRetryAt=undefined;
      this.save(state,"发现已保留的汇报读取失败记录，重新读取原回合结果");this.syncTaskStatus(state);
    }
    if(state.heartbeat.status==="recovering"&&state.heartbeat.nextRetryAt&&Date.parse(state.heartbeat.nextRetryAt)>Date.now())return;
    this.data.setProcessing(state, this.isProcessing(state));
    if(!activePhases.has(state.phase)){
      const queued=state.instructions.filter(queuedInstruction);if(!queued.length)return;
      await this.validateExecution(task,state.settings);
      run={id:id(),instructionIds:queued.map(entry=>entry.id),createdAt:now(),settings:structuredClone(state.settings),jobs:[],reviewAttempt:0};
      state.runs.push(run);state.activeRunId=run.id;state.phase="planning";state.error=undefined;
      for(const entry of queued){entry.status="submitted";entry.runId=run.id;}
      const plan=this.job("plan","任务代理 · 理解与拆分",this.planText(state,run),run.settings.agentModel);plan.threadId=state.agentThreadId;run.jobs.push(plan);
      this.save(state,"代理开始理解需求并安排 Worker");this.syncTaskStatus(state);
    }
    if(!run)return;
    // Read the authoritative turn before advancing the durable workflow.
    for(const job of run.jobs.filter(job=>job.status==="active")){
      if(!job.threadId||!job.turnId)continue;
      const page=await this.conversations.readFresh(taskId,job.threadId,100);const turn=page.detail.turns.find(turn=>turn.id===job.turnId);
      if(!turn)throw new Error(`执行记录缺失：${job.name}。请检查 Codex 会话后重试。`);
      job.items=turn.items;
      state.heartbeat.checkedAt=now();state.heartbeat.lastEventAt=this.lastProgress.get(taskId)??state.heartbeat.lastEventAt;
      if(turn.status==="in_progress")continue;
      if(turn.status==="interrupted"){this.retryInterrupted(state,job);return;}
      if(turn.status!=="completed"){job.status="failed";job.error=turn.error?.message??"Codex 执行失败";this.data.save(state);throw new Error(`${job.name}：${job.error}`);}
      try{job.output=parseTaskJobOutput(turn.items,job.role);}catch(error){
        if(!(error instanceof TaskOutputParseError))throw error;
        job.errorCode="invalid_structured_output";job.outputReadAttempts=(job.outputReadAttempts??0)+1;
        if(job.outputReadAttempts<=this.maxRecoveryAttempts){
          state.heartbeat.status="recovering";state.heartbeat.recoveryAttempts=job.outputReadAttempts;state.heartbeat.message=`正在第 ${job.outputReadAttempts} 次重新读取汇报，保留已有执行结果`;state.heartbeat.nextRetryAt=new Date(Date.now()+this.recoveryBaseMs*2**(job.outputReadAttempts-1)).toISOString();
          this.save(state,`${job.name} 汇报暂未识别，稍后重新读取原回合`);return;
        }
        job.status="failed";job.error=`${error.message}。已重读 ${this.maxRecoveryAttempts} 次，可在任务中重新读取汇报`;this.data.save(state);throw new Error(job.error);
      }
      job.error=undefined;job.errorCode=undefined;job.outputReadAttempts=undefined;
      job.status="completed";this.save(state,`${job.name} 已返回结果`);
    }
    for(const job of run.jobs.filter(job=>job.status==="completed"&&!job.processed)){
      if(job.role==="plan")this.acceptPlan(state,run,job);
      if(job.role==="steer")await this.deliverSteer(state,run,job);
      if(job.role==="review"&&(!run.result||job.purpose==="clarify_report"))await this.finishRun(state,run,job);
      job.processed=true;this.data.save(state);
    }
    if(run.result&&!run.jobs.some(job=>job.purpose==="clarify_report"&&!job.processed)){state.heartbeat.status="idle";state.heartbeat.checkedAt=now();state.heartbeat.nextRetryAt=undefined;this.data.save(state);this.syncTaskStatus(state);if(state.instructions.some(queuedInstruction))setTimeout(()=>this.schedule(taskId),0);return;}
    const additions=state.instructions.filter(entry=>queuedInstruction(entry)&&entry.timing==="now");
    if(additions.length&&state.phase==="planning"){
      const planner=run.jobs.find(job=>job.role==="plan"&&job.status==="active");
      if(planner?.threadId&&planner.turnId){for(const entry of additions){await this.conversations.steer(taskId,planner.threadId,{clientMessageId:`tm-steer-${entry.id}`,expectedTurnId:planner.turnId,text:this.instructionText(entry)});entry.status="agent_received";entry.agentReceivedAt=now();entry.runId=run.id;run.instructionIds.push(entry.id);}this.save(state,"追加指示已送达任务代理");}
    }else if(additions.length&&state.phase==="working"&&!run.jobs.some(job=>job.role==="steer"&&["active","pending"].includes(job.status))){
      const activeWorkers=run.jobs.filter(job=>job.role==="worker"&&["active","pending"].includes(job.status));
      if(activeWorkers.length){const steer=this.job("steer","任务代理 · 处理追加指示",`${run.settings.agentPrompt}\n${TASK_AGENT_COMMUNICATION}\n这是用户的追加消息。先直接答复，userUpdate 必须讲当前任务的实际情况；纯进度询问使用 reply_only，不下发实施任务。包含实施变更时才转发给相关 Worker。已有阶段汇报：${JSON.stringify([...state.instructions].reverse().find(entry=>entry.result)?.result??null)}\n相关 Worker 最新结果：${JSON.stringify(this.latestWorkers(run).map(worker=>({name:worker.name,status:worker.status,result:worker.output})))}\n可选 Worker：${JSON.stringify(activeWorkers.map(w=>({id:w.id,name:w.name,objective:w.objective})))}\n${additions.map(entry=>this.instructionText(entry)).join("\n")}`,run.settings.agentModel);steer.threadId=state.agentThreadId;steer.objective=JSON.stringify(additions.map(entry=>entry.id));run.jobs.push(steer);for(const entry of additions){entry.status="submitted";entry.runId=run.id;}this.save(state,"代理正在理解追加指示");}
    }
    const pending=run.jobs.filter(job=>job.status==="pending");
    for(const job of pending){await this.startJob(state,run,job);}
    const workers=run.jobs.filter(job=>job.role==="worker");
    if(state.phase==="working"&&workers.length&&workers.every(job=>job.status==="completed")&&!run.jobs.some(job=>["steer","review"].includes(job.role)&&job.status!=="completed")){
      state.phase="reviewing";const review=this.job("review","任务代理 · 检查与汇报",`${run.settings.agentPrompt}\n${AGENT_MANDATE}\n${REPORT_GUIDANCE}\n${REVIEW_DECISION}\n可复用 Worker：${JSON.stringify(this.latestWorkers(run).map(worker=>({workerId:worker.id,name:worker.name,ownedPaths:worker.ownedPaths})))}\n请检查本轮 Worker 结果是否满足全部需求。可以读取代码与证据，但不要修改实现。返回 done、blocked 或 needs_confirmation，真实总结及风险。不要省略未完成项。Worker 的 blockers、失败或未执行的检查必须逐项说明责任人和下一步。\n本轮需求：\n${this.runText(state,run)}\nWorker 汇报：\n${JSON.stringify(workers.map(job=>({name:job.name,result:job.output,observedChanges:job.items.filter(item=>item.kind==="file_change"),commands:job.items.filter(item=>item.kind==="command").map(item=>({command:item.command,exitCode:item.exitCode}))})))}`,run.settings.agentModel);review.threadId=state.agentThreadId;review.cycle=run.iteration??0;run.jobs.push(review);this.save(state,"Worker 已汇报，代理正在检查结果");await this.startJob(state,run,review);
    }
    this.confirmHeartbeat(state);
    this.data.save(state);this.emit("change",{taskId});
  }
  private canRecoverOutput(state:TaskModeState):boolean {
    const run=state.runs.find(run=>run.id===state.activeRunId);
    return state.phase==="blocked"&&Boolean(run&&(!run.result||run.jobs.some(job=>job.purpose==="clarify_report"&&!job.processed))&&run.jobs.some(job=>isTaskOutputFailure(job)&&job.threadId&&job.turnId&&(job.outputReadAttempts??0)<=this.maxRecoveryAttempts));
  }
  private handleAdvanceFailure(taskId:string,error:unknown):void {
    const state=this.data.get(taskId);if(!state)return;
    if(this.isTransportFailure(error)&&(activePhases.has(state.phase)||state.instructions.some(queuedInstruction))){
      this.deferRecovery(state,`Codex 连接暂时不可用：${errorText(error)}`);
      return;
    }
    state.phase="blocked";state.error=errorText(error);state.heartbeat.status="needs_attention";state.heartbeat.message=state.error;state.heartbeat.nextRetryAt=undefined;
    this.save(state,`执行被阻塞：${state.error}`);this.syncTaskStatus(state);
  }
  private isTransportFailure(error:unknown):boolean {
    if(error instanceof CodexRpcError)return true;
    return error instanceof TaskConversationServiceError && (error.status===429 || error.status>=500 && !["TASK_CONTEXT_UNAVAILABLE","CODEX_PROTOCOL_ERROR"].includes(error.code));
  }
  private deferRecovery(state:TaskModeState,message:string):boolean {
    const heartbeat=state.heartbeat;
    heartbeat.recoveryAttempts++;
    heartbeat.message=message;
    if(heartbeat.recoveryAttempts>this.maxRecoveryAttempts){
      heartbeat.status="needs_attention";heartbeat.nextRetryAt=undefined;
      state.phase="blocked";state.error=`自动恢复已尝试 ${this.maxRecoveryAttempts} 次，仍未确认 Codex 执行状态。请检查会话后手动恢复。${message}`;
      this.save(state,state.error);this.syncTaskStatus(state);
      return false;
    }
    heartbeat.status="recovering";
    heartbeat.nextRetryAt=new Date(Date.now()+this.recoveryBaseMs*2**(heartbeat.recoveryAttempts-1)).toISOString();
    this.save(state,`Codex 连接中断，等待第 ${heartbeat.recoveryAttempts} 次自动恢复`);
    return true;
  }
  private retryInterrupted(state:TaskModeState,job:TaskExecutionJob):void {
    const accepted=this.deferRecovery(state,`${job.name} 的 Codex 回合已中断，准备在确认已有改动后继续`);
    if(!accepted)return;
    job.status="pending";job.turnId=undefined;job.attempt++;job.error=undefined;
    job.text+="\n\n上一次执行意外中断。请先检查已有文件和验证结果，只继续未完成部分，不要重复已产生的副作用。";
    this.data.save(state);
  }
  private confirmHeartbeat(state:TaskModeState):void {
    const heartbeat=state.heartbeat;
    if(heartbeat.status==="recovering"){
      heartbeat.lastRecoveredAt=now();
      this.save(state,"Codex 连接已恢复，任务继续执行");
    }
    heartbeat.status="healthy";heartbeat.checkedAt=now();heartbeat.lastEventAt=this.lastProgress.get(state.taskId)??heartbeat.lastEventAt;
    heartbeat.recoveryAttempts=0;heartbeat.nextRetryAt=undefined;heartbeat.message=undefined;
  }
  private async startJob(state:TaskModeState,run:TaskExecutionRun,job:TaskExecutionJob):Promise<void> {
    const task=this.requireTask(state.taskId);const cwd=task.repositoryPath||task.contextDirectory;
    const toolRoot=findTaskSkillProjectRoot([process.cwd(),path.resolve(import.meta.dirname,"../../.."),path.resolve(import.meta.dirname,"../../../..")]);
    const quote=(value:string)=>`'${value.replaceAll("'",process.platform==="win32"?"''":"'\\''")}'`;
    const tagTools=toolRoot?`\n任务标签工具（当前任务 ${task.id}）：可通过 exec 命令查询项目标签并按明确需求补充当前任务标签。\nnode ${quote(path.join(taskSkillSource(toolRoot),"scripts","task-monitor.mjs"))} tags --project ${quote(task.project)}\nnode ${quote(path.join(taskSkillSource(toolRoot),"scripts","task-monitor.mjs"))} tag ${quote(task.id)} --add '选择的标签名称'\n调用前将占位名称替换为当前任务对应的目录标签；按任务内容选择，不固定套用示例。使用 --remove 移除明确不再适用的标签。优先复用项目目录中的标签，单任务最多12个；保留无关和人工设置的标签，不用标签替代执行状态。CLI 私下加载认证，不读取或打印认证文件。标签变更无需重启任务。`:"";
    const developerInstructions=(job.role==="worker"?run.settings.workerPrompt:`${run.settings.agentPrompt}\n${AGENT_MANDATE}\n${TASK_AGENT_COMMUNICATION}\n当前负责的任务：${task.title}`)+tagTools;
    if(!job.threadId){let created;try{created=await this.conversations.create(task.id,{clientMessageId:`tm-create-${job.id}-${job.attempt}`,displayName:`${task.key} · ${job.name}`,model:job.model},{cwd,approvalsReviewer:run.settings.approvalsReviewer,developerInstructions,primary:job.role!=="worker"});}catch(error){if(error instanceof TaskConversationServiceError&&error.code==="CREATE_FAILED"){job.attempt++;this.data.save(state);return this.startJob(state,run,job);}throw error;}job.threadId=created.conversation.threadId;if(job.role!=="worker")state.agentThreadId=job.threadId;this.data.save(state);}
    const outputSchema=job.role==="plan"?PLAN_SCHEMA:job.role==="worker"?WORK_SCHEMA:job.role==="steer"?STEER_SCHEMA:REVIEW_SCHEMA;
    const prepared=prepareTaskModeInput(task.contextDirectory,state,run,job);
    if(prepared.packet){const changed=job.contextPacket?.sha256!==prepared.packet.sha256;job.contextPacket=prepared.packet;if(changed)this.save(state,`大段任务材料已完整保存（${prepared.packet.originalCharacters} 字符），${job.name} 将按需读取证据；已有 Worker 结果沿用`);}
    const sent=await this.conversations.send(task.id,job.threadId,{clientMessageId:`tm-turn-${job.id}-${job.attempt}`,text:prepared.text,model:job.model,effort:run.settings.effort,permissionPreset:job.role==="worker"?run.settings.permissionPreset:"read_only"},{cwd,outputSchema,approvalsReviewer:run.settings.approvalsReviewer,developerInstructions});
    if(sent.operation.state==="failed"){job.attempt++;this.data.save(state);return this.startJob(state,run,job);}
    const turnId=sent.operation.turnId||text(object(sent.turn).id);if(!turnId)throw new Error("执行请求正在恢复，尚未得到确定的 turnId");
    job.turnId=turnId;job.status="active";job.error=undefined;job.errorCode=undefined;job.outputReadAttempts=undefined;
    for(const entry of state.instructions.filter(entry=>run.instructionIds.includes(entry.id))){if(job.role==="plan"){entry.status="agent_received";entry.agentReceivedAt??=now();}if(job.role==="worker"){entry.status="worker_received";entry.workerReceivedAt??=now();entry.deliveries.push({workerId:job.id,turnId,receivedAt:now()});}}
    this.save(state,`${job.name} 已接收执行请求`);
  }
  private acceptPlan(state:TaskModeState,run:TaskExecutionRun,job:TaskExecutionJob) {
    if(run.jobs.some(job=>job.role==="worker"&&(job.cycle??0)===(run.iteration??0)))return;
    let planned=array(job.output?.workers).map(value=>object(value)).filter(value=>text(value.objective).trim()).map(value=>({name:text(value.name),objective:text(value.objective),ownedPaths:strings(value.ownedPaths),workerId:text(value.workerId)}));
    if(!planned.length)throw new Error("代理未给出可执行的 Worker 分工");
    const limit=run.settings.workerPolicy==="single"?1:run.settings.maxWorkers;
    // Ambiguous or overlapping write scopes run in one worker instead of silently dropping objectives.
    const scopes=planned.map(value=>value.ownedPaths.map(p=>p.replaceAll("\\","/").replace(/\*.*$/,"").toLowerCase()));
    const overlap=scopes.some((paths,i)=>!paths.length||scopes.slice(i+1).some(other=>paths.some(a=>other.some(b=>a.startsWith(b)||b.startsWith(a)))));
    if(planned.length>limit||overlap||limit===1)planned=[{name:"Worker",objective:planned.map(value=>value.objective).join("\n\n"),ownedPaths:[...new Set(planned.flatMap(value=>value.ownedPaths))],workerId:new Set(planned.map(value=>value.workerId)).size===1?planned[0].workerId:""}];
    const additions=planned.map((plan,index)=>{const worker=this.job("worker",`W${index+1} · ${plan.name||"执行"}`,`${run.settings.workerPrompt}\n${DOCUMENT_GUIDANCE}\n代理理解：${text(job.output?.understanding)}\n你的任务：${plan.objective}\n你拥有的修改范围：${plan.ownedPaths.join(", ")||"本轮任务涉及的文件"}\n工作目录：${this.requireTask(state.taskId).repositoryPath}\n请检查引用中的图片。原始需求和全部本轮指示：\n${this.runText(state,run)}\n完成后返回结构化总结、验证、风险与审查材料。artifacts.path 必须是工作目录中的真实文件路径。`,run.settings.workerModel);worker.objective=plan.objective;worker.ownedPaths=plan.ownedPaths;worker.cycle=run.iteration??0;
      if(plan.workerId){
        const matches=[...run.jobs].reverse().filter(value=>value.role==="worker"&&value.status==="completed"&&[value.id,value.ownerId,value.planWorkerId,value.threadId].includes(plan.workerId));
        const owners=new Set(matches.map(value=>value.ownerId??value.id));
        const scopeKey=(paths:string[])=>[...new Set(paths.map(value=>value.replaceAll("\\","/").replace(/\/$/,"").toLocaleLowerCase()))].sort().join("\n");
        const scoped=this.latestWorkers(run).filter(value=>value.status==="completed"&&scopeKey(value.ownedPaths)===scopeKey(plan.ownedPaths));
        const owner=owners.size===1?matches[0]:scoped.length===1?scoped[0]:undefined;
        worker.planWorkerId=owner?.planWorkerId??plan.workerId;
        if(owner){const binding=owner.threadId?this.conversations.store.getConversationBinding(state.taskId,owner.threadId):undefined;worker.threadId=binding&&!binding.archived?owner.threadId:undefined;worker.ownerId=owner.ownerId??owner.id;}
        if(!worker.threadId&&this.latestWorkers(run).length)worker.text+=`\n\n请先检查已有实现和验证，沿用已完成的成果，只处理上述剩余目标，不重复修改、发布或其他副作用。此前执行结果：\n${JSON.stringify(this.latestWorkers(run).map(value=>({name:value.name,ownedPaths:value.ownedPaths,result:value.output,changes:value.items.filter(item=>item.kind==="file_change")})))}`;
      }
      return worker;});
    // Resolve the complete dispatch before publishing any new jobs.
    const dispatches=new Map<string,TaskExecutionJob>();
    for(const worker of additions){
      const key=worker.threadId??worker.id,existing=dispatches.get(key);
      if(!existing){dispatches.set(key,worker);continue;}
      existing.objective+="\n\n"+worker.objective;existing.ownedPaths=[...new Set([...existing.ownedPaths,...worker.ownedPaths])];
      existing.text+=`\n\n同一负责人还需完成以下目标，合并负责范围：${JSON.stringify(existing.ownedPaths)}\n${worker.objective}`;
    }
    run.jobs.push(...dispatches.values());
    state.phase="working";this.save(state,`代理已安排 ${dispatches.size} 个 Worker`);
  }
  private async deliverSteer(state:TaskModeState,run:TaskExecutionRun,job:TaskExecutionJob) {
    const ids=strings(JSON.parse(job.objective));const entries=state.instructions.filter(entry=>ids.includes(entry.id));
    const reply=text(job.output?.userUpdate).trim()||text(job.output?.understanding).trim();
    for(const entry of entries){entry.agentReply=reply;entry.agentReceivedAt=now();}
    if(job.output?.deliveryMode==="reply_only"){
      for(const entry of entries){entry.replyOnly=true;entry.status="completed";entry.completedAt=now();}
      this.save(state,"代理已直接答复任务进展，原执行继续，未向 Worker 增加实施目标");return;
    }
    const targets=strings(job.output?.workerIds);let delivered=0;
    for(const entry of entries){entry.agentReceivedAt=now();entry.status="agent_received";}
    for(const worker of run.jobs.filter(worker=>worker.role==="worker"&&targets.includes(worker.id)&&["active","pending"].includes(worker.status))){
      const message=`代理追加说明：${text(job.output?.instructions)}\n${entries.map(entry=>this.instructionText(entry)).join("\n")}`;
      if(worker.status==="pending"){worker.text+="\n"+message;for(const entry of entries)if(!run.instructionIds.includes(entry.id))run.instructionIds.push(entry.id);continue;}
      if(!worker.threadId||!worker.turnId)continue;
      try{await this.conversations.steer(state.taskId,worker.threadId,{clientMessageId:`tm-forward-${job.id}-${worker.id}`,expectedTurnId:worker.turnId,text:message});
        for(const entry of entries){entry.status="worker_received";entry.workerReceivedAt=now();entry.deliveries.push({workerId:worker.id,turnId:worker.turnId,receivedAt:now()});if(!run.instructionIds.includes(entry.id))run.instructionIds.push(entry.id);}delivered++;
      }catch(error){if(error instanceof TaskConversationServiceError&&error.status===409)continue;throw error;}
    }
    for(const entry of entries)if(!run.instructionIds.includes(entry.id)){entry.status="queued";entry.runId=undefined;entry.timing="after";}
    this.save(state,delivered?"追加指示已送达对应 Worker":"当前 Worker 已结束，追加指示进入下一轮");
  }
  private async finishRun(state:TaskModeState,run:TaskExecutionRun,review:TaskExecutionJob) {
    review.processed=true;
    if(review.purpose==="clarify_report"&&run.result){
      const original=run.result;
      const result:TaskRunResult={...original,...this.actionGuidance(review),summary:text(review.output?.summary),risks:[...new Set(strings(review.output?.risks))]};
      if(!hasTaskActionGuidance(result))throw new Error("代理仍未提供具体行动说明，原汇报和执行结果已保留");
      this.saveRunResult(state,run,result);return;
    }
    const workers=this.latestWorkers(run),cycleWorkers=run.jobs.filter(job=>job.role==="worker"&&(job.cycle??0)===(run.iteration??0));
    const artifacts:TaskAttachment[]=[],artifactRisks:string[]=[];
    for(const worker of workers)for(const entry of array(worker.output?.artifacts).slice(0,12)){try{const attachment=this.importArtifact(state.taskId,`${run.id}:${worker.id}`,text(object(entry).path),text(object(entry).title));if(attachment)artifacts.push(attachment);}catch(error){artifactRisks.push(errorText(error));}}
    const reported=text(review.output?.status);if(!["done","continue","blocked","needs_confirmation"].includes(reported))throw new Error("代理没有返回有效的验收结论");
    const currentFailures=cycleWorkers.some(worker=>strings(worker.output?.blockers).length>0||array(worker.output?.verification).some(check=>object(check).result==="failed"));
    const explicit=typeof review.output?.acceptanceReady==="boolean";
    const remaining=strings(review.output?.remainingWork);
    const nextWorkers=array(review.output?.nextWorkers).map(object).filter(value=>text(value.objective).trim());
    const pause=text(review.output?.pauseCategory);
    const ready=(explicit?review.output!.acceptanceReady===true&&remaining.length===0&&pause==="none":reported==="done"||reported==="needs_confirmation")&&!currentFailures&&!artifactRisks.length;
    const needsReview=run.settings.reviewPolicy==="always"||(run.settings.reviewPolicy==="artifacts"&&artifacts.length>0);
    const result:TaskRunResult={status:"in_progress",summary:text(review.output?.summary),changedFiles:[...new Set(run.jobs.filter(job=>job.role==="worker").flatMap(worker=>[...strings(worker.output?.changedFiles),...worker.items.flatMap(item=>item.kind==="file_change"?item.paths:[])]))],verification:workers.flatMap(worker=>array(worker.output?.verification).map(object).filter(value=>["passed","failed","not_run"].includes(text(value.result))).map(value=>({command:text(value.command),result:text(value.result) as TaskVerification["result"],details:text(value.details)}))),risks:[...new Set([...strings(review.output?.risks),...cycleWorkers.flatMap(worker=>[...strings(worker.output?.risks),...strings(worker.output?.blockers)]),...artifactRisks])],artifacts,changes:run.jobs.filter(job=>job.role==="worker").flatMap(worker=>worker.items.flatMap(item=>item.kind==="file_change"?item.changes??[]:[])),...this.actionGuidance(review),acceptanceReady:ready};
    const human=result.humanActions??[];
    if(ready&&pause!=="blocked"&&pause!=="unclear_requirement"&&pause!=="exception"){
      result.status=reported==="needs_confirmation"||needsReview||human.length>0?"needs_confirmation":"done";
      if(result.status==="needs_confirmation"&&!result.stopReason)result.stopReason="全部目标已达到验收条件，请审查最终结果和材料。";
      this.saveRunResult(state,run,result);return;
    }
    if((explicit&&["blocked","unclear_requirement","exception"].includes(pause))||(!explicit&&human.length>0)){
      result.status="blocked";result.pauseCategory=(pause||"blocked") as TaskRunResult["pauseCategory"];
      result.stopReason||=human.map(item=>item.reason).join("；");
      if(!result.stopReason)throw new Error("暂停任务必须提供具体阻塞、需求不明或异常原因");
      this.saveRunResult(state,run,result);return;
    }
    result.humanActions=[];result.stopReason="";
    result.agentNextSteps=[...new Set(strings(review.output?.agentNextSteps))];
    result.internalNextSteps=[...new Set([...remaining,...nextWorkers.map(value=>text(value.objective))])];
    if(!result.agentNextSteps.length)result.agentNextSteps=[currentFailures?"代理复核未通过的验证，安排原负责人修复并再次检查验收条件":"代理继续核对完整验收条件并安排尚未完成的工作"];
    if(!explicit&&reported==="blocked"&&!hasTaskActionGuidance({...result,status:"blocked",stopReason:text(review.output?.stopReason)})){
      if(review.purpose==="continuation_review")throw new Error("代理仍未提供可执行的持续推进决定，原结果已保留");
      this.saveMilestone(state,run,result);
      const decision=this.job("review","任务代理 · 确认剩余工作",`${run.settings.agentPrompt}\n${AGENT_MANDATE}\n${REPORT_GUIDANCE}\n${REVIEW_DECISION}\n上一检查结果：${JSON.stringify(review.output)}\n原始需求：${this.runText(state,run)}\n现有 Worker 结果：${JSON.stringify(workers.map(worker=>({id:worker.id,name:worker.name,ownedPaths:worker.ownedPaths,result:worker.output})))}`,run.settings.agentModel);
      decision.purpose="continuation_review";decision.cycle=run.iteration??0;decision.threadId=state.agentThreadId;run.jobs.push(decision);state.phase="reviewing";this.save(state,"代理明确剩余工作和继续执行路径，任务没有结束");return;
    }
    const artifactHashes=artifacts.map(attachment=>{const stored=this.conversations.store.attachment(state.taskId,attachment.id);return stored?crypto.createHash("sha256").update(fs.readFileSync(stored.filePath)).digest("hex"):attachment.name;});
    const fingerprint=crypto.createHash("sha256").update(JSON.stringify({evidence:cycleWorkers.map(worker=>({paths:worker.ownedPaths,verification:worker.output?.verification,blockers:worker.output?.blockers,changes:worker.items.flatMap(item=>item.kind==="file_change"?item.changes??item.paths.map(path=>({path,diff:""})):[])})),artifacts:artifactHashes,remaining:result.agentNextSteps})).digest("hex");
    run.noProgressCount=run.progressFingerprint===fingerprint?(run.noProgressCount??0)+1:0;run.progressFingerprint=fingerprint;
    if(run.noProgressCount>=3){
      result.status="blocked";result.pauseCategory="exception";result.stopReason="连续三次复查返回相同的未完成项和技术证据，自动执行重复空转，已暂停以便诊断异常。";
      result.humanActions=[{action:"查看最近几次 Codex 执行记录，补充异常信息或调整执行设置后继续执行",reason:"相同方法连续未产生新的改动、验证结果或审查材料",unblocks:"代理将从最近结果继续诊断和完成验收"}];this.saveRunResult(state,run,result);return;
    }
    this.saveMilestone(state,run,result);run.iteration=(run.iteration??0)+1;
    if(nextWorkers.length){this.acceptPlan(state,run,{...review,purpose:"continuation_plan",output:{understanding:result.summary,workers:nextWorkers}});}
    else{
      const plan=this.job("plan","任务代理 · 继续安排剩余工作",`${this.planText(state,run)}\n最新阶段汇报：${JSON.stringify(result)}\n只安排仍未完成的工作，复用合适的原负责人。Worker 结果：${JSON.stringify(workers.map(worker=>({workerId:worker.id,name:worker.name,ownedPaths:worker.ownedPaths,result:worker.output})))}`,run.settings.agentModel);
      plan.purpose="continuation_plan";plan.cycle=run.iteration;plan.threadId=state.agentThreadId;run.jobs.push(plan);state.phase="planning";
    }
    this.save(state,"阶段检查已完成，代理自动安排剩余工作，持续推进至可验收");this.syncTaskStatus(state);
  }
  private executionPhase(run:TaskExecutionRun):TaskModeState["phase"]{
    const unfinished=run.jobs.filter(job=>job.status!=="completed"||!job.processed);
    if(unfinished.some(job=>job.role==="review"))return "reviewing";
    if(unfinished.some(job=>job.role==="plan"))return "planning";
    return run.jobs.some(job=>job.role==="worker")?"working":"planning";
  }
  private latestWorkers(run:TaskExecutionRun):TaskExecutionJob[]{
    const latest=new Map<string,TaskExecutionJob>();for(const worker of run.jobs.filter(job=>job.role==="worker"))latest.set(worker.ownerId??worker.id,worker);return [...latest.values()];
  }
  private saveMilestone(state:TaskModeState,run:TaskExecutionRun,result:TaskRunResult):void{
    for(const entry of state.instructions.filter(entry=>run.instructionIds.includes(entry.id))){entry.result=result;entry.status="worker_received";entry.completedAt=undefined;}
    this.conversations.store.addReport(state.taskId,{status:"progress",summary:result.summary||"代理正在继续完成剩余工作",changedFiles:result.changedFiles,verification:result.verification,risks:result.risks,nextStep:result.agentNextSteps?.join("\n"),taskStatus:"in_progress"});
    this.save(state,"阶段进展已记录，代理继续执行，尚未提交最终验收");
  }
  private actionGuidance(review:TaskExecutionJob):Pick<TaskRunResult,"stopReason"|"humanActions"|"agentNextSteps"> {
    if(review.output?.humanActions===undefined)return {};
    return {stopReason:text(review.output?.stopReason).trim(),humanActions:array(review.output?.humanActions).map(value=>{const item=object(value);return {action:text(item.action).trim(),reason:text(item.reason).trim(),unblocks:text(item.unblocks).trim()};}),agentNextSteps:strings(review.output?.agentNextSteps).map(value=>value.trim()).filter(Boolean)};
  }
  private saveRunResult(state:TaskModeState,run:TaskExecutionRun,result:TaskRunResult):void {
    run.result=result;run.completedAt=now();
    for(const entry of state.instructions.filter(entry=>run.instructionIds.includes(entry.id))){entry.result=result;entry.status=result.status==="blocked"?"blocked":"completed";entry.completedAt=now();}
    state.phase=result.status==="blocked"?"blocked":this.hasPendingReview(state)?"needs_confirmation":"completed";
    this.save(state,result.summary||"代理已返回本轮结果");
    const guidance=hasTaskActionGuidance(result);
    const nextStep=guidance?[result.humanActions!.length?`你需要做什么：\n${result.humanActions!.map((item,index)=>`${index+1}. ${item.action}\n原因：${item.reason}\n完成后：${item.unblocks}`).join("\n")}`:"你需要做什么：当前无需操作。",result.agentNextSteps!.length?`代理下一步：\n${result.agentNextSteps!.map((step,index)=>`${index+1}. ${step}`).join("\n")}`:""].filter(Boolean).join("\n\n"):"本轮汇报缺少具体行动说明，请点击‘补齐行动说明’；保留已有代码和产物，仅请代理补齐停下原因、用户行动和代理下一步。";
    this.conversations.store.addReport(state.taskId,{status:result.status==="blocked"?"blocked":"completed",summary:result.summary||"本轮执行结束",changedFiles:result.changedFiles,verification:result.verification,risks:result.risks,blockers:result.status==="blocked"?[result.stopReason||"汇报缺少具体停下原因",...(result.humanActions??[]).map(item=>item.reason)]:[],nextStep,taskStatus:result.status==="blocked"?"blocked":this.hasPendingReview(state)?"pending_manual_acceptance":"done"});
  }
  private importArtifact(taskId:string,runId:string,filename:string,title:string):TaskAttachment|undefined {
    if(!filename)return;const task=this.requireTask(taskId),root=fs.realpathSync(task.repositoryPath||task.contextDirectory),candidate=fs.realpathSync(path.resolve(root,filename));
    const relative=path.relative(root,candidate);if(relative.startsWith("..")||path.isAbsolute(relative))throw new Error(`审查附件不在任务工作目录内：${filename}`);
    const stat=fs.statSync(candidate);if(!stat.isFile()||stat.size>10*1024*1024)throw new Error(`审查附件不是文件或超过 10 MB：${filename}`);
    const extension=path.extname(candidate).toLowerCase();const mime=({".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".webp":"image/webp",".gif":"image/gif",".pdf":"application/pdf",".md":"text/markdown",".markdown":"text/markdown",".html":"text/html",".htm":"text/html",".txt":"text/plain"} as Record<string,string>)[extension]??"application/octet-stream";
    const storageName=`tm-${crypto.createHash("sha256").update(runId+candidate).digest("hex")}${extension}`;
    const bytes=fs.readFileSync(candidate),contentHash=crypto.createHash("sha256").update(bytes).digest("hex");
    const importKey=crypto.createHash("sha256").update(candidate).update(bytes).digest("hex");
    if(this.conversations.store.feedbackImportDeleted(taskId,storageName,importKey,contentHash))return;
    const existing=task.attachments.find(attachment=>path.basename(this.conversations.store.attachment(taskId,attachment.id)?.filePath??"")===storageName);if(existing)return existing;
    fs.copyFileSync(candidate,path.join(this.conversations.store.attachmentDirectory(taskId),storageName));
    // A report title is a label, not a filename. Keep the real basename (including suffix).
    // TaskStore caps names at 180 characters; shorten only the stem so it cannot drop the suffix.
    const basename=path.basename(candidate),actualExtension=path.extname(basename);
    const attachmentName=basename.length<=180?basename:basename.slice(0,Math.max(0,180-actualExtension.length))+actualExtension;
    const known=new Set(task.attachments.map(attachment=>attachment.id));const updated=this.conversations.store.addAttachment(taskId,{name:attachmentName,storageName,mimeType:mime,size:stat.size,source:"feedback",importKey});return updated?.attachments.find(attachment=>!known.has(attachment.id));
  }
  private snapshot(task:TaskItem,input:SubmitTaskInstruction):RequirementSnapshot {
    const attachmentIds=[...new Set([...(input.attachmentIds??[]),...task.attachments.filter(entry=>entry.source!=="feedback").map(entry=>entry.id)])];
    const storedFiles=attachmentIds.map(attachmentId=>{const stored=this.conversations.store.attachment(task.id,attachmentId);if(!stored)throw new TaskModeError(400,"附件不存在或不属于当前任务");return stored;});
    const references:RequirementSnapshot["references"]=[];
    for(const referenceId of input.referenceTaskIds??[]){const reference=this.requireTask(referenceId);references.push({id:reference.id,title:reference.title,markdown:reference.descriptionMd+"\n\n"+reference.acceptanceCriteriaMd,revision:reference.revision});}
    for(const referenceId of input.documentIds??[]){const reference=this.data.document(referenceId);if(!reference)throw new TaskModeError(400,"引用文档不存在");references.push({id:reference.id,title:reference.title,markdown:reference.markdown,revision:reference.revision});}
    const directory=path.join(this.conversations.store.attachmentDirectory(task.id),"instruction-snapshots",id());fs.mkdirSync(directory,{recursive:true});
    try {
      const attachments=storedFiles.map(stored=>{const meta=task.attachments.find(entry=>entry.id===stored.id)!;const snapshotPath=path.join(directory,stored.id+path.extname(stored.filePath));fs.copyFileSync(stored.filePath,snapshotPath);return {...meta,snapshotPath};});
      const project = task.project ? this.conversations.store.project(task.project) : null;
      return {title:task.title,descriptionMd:task.descriptionMd,acceptanceCriteriaMd:task.acceptanceCriteriaMd,revision:task.revision,repositoryPath:task.repositoryPath,project:project?{name:project.name,rootDirectory:project.rootDirectory,descriptionMd:project.descriptionMd}:undefined,attachments,references};
    } catch(error) {fs.rmSync(directory,{recursive:true,force:true});throw error;}
  }
  private async validateExecution(task:TaskItem,settings:TaskModeSettings) {
    if(!task.repositoryPath||!fs.existsSync(task.repositoryPath)||!fs.statSync(task.repositoryPath).isDirectory())throw new TaskModeError(422,"请先为任务设置可访问的项目工作目录");
    const models=await this.conversations.manager.models();
    for(const name of new Set([settings.agentModel,settings.workerModel])){const model=models.find(model=>model.id===name);if(!model)throw new TaskModeError(400,`当前 Codex 账号不可用模型 ${name}，请在代理设置中选择可用模型`);if(model.efforts.length&&!model.efforts.includes(settings.effort))throw new TaskModeError(400,`模型 ${name} 不支持所选推理强度`);}
    const slots=(settings.workerPolicy==="single"?1:settings.maxWorkers)+1;
    if(task.maxConcurrency<slots)this.conversations.store.update(task.id,{maxConcurrency:slots});
  }
  private planText(state:TaskModeState,run:TaskExecutionRun) {return `${run.settings.agentPrompt}\n${AGENT_MANDATE}\n${TASK_AGENT_COMMUNICATION}\n可复用 Worker：${JSON.stringify(this.latestWorkers(run).map(worker=>({workerId:worker.id,name:worker.name,ownedPaths:worker.ownedPaths})))}\nworkerId 仅用于复用已有执行者；没有可复用 Worker 时填空字符串，新的标识由系统创建。\n协作策略：${run.settings.workerPolicy}。Worker 上限：${run.settings.workerPolicy==="single"?1:run.settings.maxWorkers}。请输出理解和可独立执行的 Worker 分工。ownedPaths 明确互不重叠的文件或目录；范围不能独立时安排一个 Worker。不要自行启动子代理或修改文件。\n${this.runText(state,run)}`;}
  private runText(state:TaskModeState,run:TaskExecutionRun) {return state.instructions.filter(entry=>run.instructionIds.includes(entry.id)).map(entry=>this.instructionText(entry)).join("\n\n");}
  private instructionText(entry:TaskInstruction) {return `指示 ID: ${entry.id}\n用户原文：\n${entry.text}\n发送时的需求快照（原文、图片文件、附件与引用）：\n${JSON.stringify(entry.snapshot)}`;}
  private job(role:TaskExecutionJob["role"],name:string,prompt:string,model:string):TaskExecutionJob {return {id:id(),role,name,objective:"",ownedPaths:[],status:"pending",attempt:0,text:prompt,model,items:[]};}
  private hasPendingReview(state:TaskModeState) {return state.runs.some(run=>run.result?.status==="needs_confirmation");}
  private requireTask(taskId:string) {const task=this.conversations.store.get(taskId);if(!task)throw new TaskModeError(404,"任务不存在");return task;}
  private save(state:TaskModeState,message?:string) {if(message){state.events.push({id:id(),at:now(),text:message});state.events=state.events.slice(-1000);}this.data.save(state);this.emit("change",{taskId:state.taskId});}
  private syncTaskStatus(state:TaskModeState) {const task=this.requireTask(state.taskId);const status:TaskStatus=activePhases.has(state.phase)?"in_progress":state.phase==="completed"?"done":state.phase==="needs_confirmation"?"pending_manual_acceptance":state.phase==="blocked"||state.phase==="paused"?"blocked":task.status;if(status!==task.status)this.conversations.store.update(task.id,{status});}
}

export function validateSettings(input:unknown):TaskModeSettings {
  const value=object(input);const settings={...DEFAULT_TASK_MODE_SETTINGS,...value} as TaskModeSettings;
  if(!["auto_review","user"].includes(settings.approvalsReviewer)||!["auto","parallel","single"].includes(settings.workerPolicy)||!["agent","artifacts","always"].includes(settings.reviewPolicy)||!["read_only","workspace_write","full_access"].includes(settings.permissionPreset)||!["minimal","low","medium","high","xhigh"].includes(settings.effort))throw new TaskModeError(400,"代理设置包含无效选项");
  if(!Number.isInteger(settings.maxWorkers)||settings.maxWorkers<1||settings.maxWorkers>8)throw new TaskModeError(400,"Worker 数量必须为 1–8");
  for(const key of ["agentModel","workerModel","agentPrompt","workerPrompt"] as const)if(typeof settings[key]!=="string"||!settings[key].trim()||settings[key].length>(key.endsWith("Prompt")?15000:150))throw new TaskModeError(400,`无效的 ${key}`);
  return {agentModel:settings.agentModel.trim(),workerModel:settings.workerModel.trim(),effort:settings.effort,workerPolicy:settings.workerPolicy,maxWorkers:settings.maxWorkers,permissionPreset:settings.permissionPreset,approvalsReviewer:settings.approvalsReviewer,reviewPolicy:settings.reviewPolicy,agentPrompt:settings.agentPrompt,workerPrompt:settings.workerPrompt};
}
