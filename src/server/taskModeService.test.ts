import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import crypto from "node:crypto";
import type { Server } from "node:http";
import { createTaskModeRouter } from "./tasks/taskModeRouter.js";
import { createTaskRouter } from "./tasks/taskRouter.js";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { TaskStore } from "./tasks/taskStore.js";
import { TaskConversationService } from "./tasks/taskConversationService.js";
import { TaskModeService, validateSettings } from "./tasks/taskModeService.js";
import { TaskModeStore } from "./tasks/taskModeStore.js";
import { LEGACY_TASK_OUTPUT_ERROR } from "../shared/taskOutputRecovery.js";
import { CodexRpcError } from "./codexAppServerClient.js";
import { attachmentDelivery } from "./tasks/taskRouter.js";
import type { CodexConversationManager } from "./codexConversationManager.js";
import type { TaskExecutionJob } from "../shared/taskModeTypes.js";

class ControlledManager extends EventEmitter {
  threads=new Map<string,any>();calls:Array<{method:string;params:any}>=[];sequence=0;
  failReads=0;
  bindThread(){} unbindThread(){} close(){} pendingApprovals(){return [];}
  async models(){return [{id:"gpt-6.1-sol",displayName:"GPT-6.1 Sol",isDefault:true,efforts:["medium"],defaultEffort:"medium"}];}
  async request(method:string,params:any):Promise<any>{
    this.calls.push({method,params});
    if(method==="thread/list")return {data:[...this.threads.values()].filter(thread=>thread.cwd===params.cwd).map(thread=>({id:thread.id})),nextCursor:null};
    if(method==="thread/start"){const thread={id:`thread-${++this.sequence}`,cwd:params.cwd,status:{type:"idle"},turns:[]};this.threads.set(thread.id,thread);return {thread};}
    if(method==="thread/read"){
      if(this.failReads>0){this.failReads--;throw new CodexRpcError("Codex request timed out: thread/read");}
      return {thread:structuredClone(this.threads.get(params.threadId))};
    }
    if(method==="turn/start"){const thread=this.threads.get(params.threadId);const turn={id:`turn-${++this.sequence}`,status:"inProgress",items:[{id:`user-${this.sequence}`,type:"userMessage",clientId:params.clientUserMessageId,content:[{type:"text",text:params.input[0].text}]}]};thread.turns.push(turn);return {turn};}
    if(method==="turn/interrupt"){const turn=this.threads.get(params.threadId).turns.find((turn:any)=>turn.id===params.turnId);turn.status="interrupted";this.emit("event",{kind:"turn_completed",threadId:params.threadId,turnId:turn.id,taskId:this.taskId,payload:{turn}});return {};}
    return {};
  }
  taskId="";
  complete(job:TaskExecutionJob,output:unknown){const turn=this.threads.get(job.threadId!).turns.find((turn:any)=>turn.id===job.turnId);assert.equal(turn.status,"inProgress");turn.status="completed";turn.items.push({id:`assistant-${++this.sequence}`,type:"agentMessage",phase:"final",text:JSON.stringify(output)});if(job.role==="worker")turn.items.push({id:`change-${this.sequence}`,type:"fileChange",status:"completed",changes:[{path:"src/a.ts",diff:"+ export const value = 1;"}]});this.emit("event",{kind:"turn_completed",threadId:job.threadId,turnId:job.turnId,taskId:this.taskId,payload:{turn}});}
}
const workerOutput={summary:"实现完成",changedFiles:["src/a.ts"],verification:[{command:"node --test",result:"passed",details:"通过"}],risks:[],blockers:[],artifacts:[]};

test("new artifact imports retain the actual basename and suffix instead of the report title", () => {
  const f = setup();
  try {
    fs.mkdirSync(f.store.attachmentDirectory(f.task.id), { recursive: true });
    const documents = [
      { name: "Report.HTML", title: "HTML 审查标题", bytes: "<h1>Review</h1>", type: "text/html" },
      { name: "验收记录.md", title: "与文件名不同的标题", bytes: "# Evidence", type: "text/markdown" },
      { name: "report.v2.pdf", title: "汇总文件无后缀", bytes: "%PDF-1.7", type: "application/pdf" },
      { name: `${"a".repeat(196)}.txt`, title: "长文件名", bytes: "trace", type: "text/plain" }
    ];
    for (const document of documents) {
      fs.writeFileSync(path.join(f.directory, document.name), document.bytes);
      const attachment = (f.mode as any).importArtifact(f.task.id, "new-import-run", document.name, document.title);
      const expectedName=document.name.length<=180?document.name:document.name.slice(0,176)+".txt";
      assert.equal(attachment.name, expectedName); assert.equal(attachment.mimeType, document.type);
      const stored = f.store.attachment(f.task.id, attachment.id)!;
      const delivery = attachmentDelivery(attachment.name, stored.storageName, attachment.mimeType, true);
      assert.equal(delivery.filename, expectedName);
      assert.match(delivery.disposition, /attachment;/);
      assert.equal(decodeURIComponent(delivery.disposition.split("UTF-8''")[1]), expectedName);
      assert.equal((f.mode as any).importArtifact(f.task.id, "new-import-run", document.name, "Another title").id, attachment.id);
    }
  } finally { f.close(); }
});
async function waitFor<T>(read:()=>T,predicate:(value:T)=>boolean):Promise<T>{const deadline=Date.now()+5000;let result=read();while(!predicate(result)){if(Date.now()>deadline)throw new Error(`Timed out: ${JSON.stringify(result)}`);await new Promise(resolve=>setTimeout(resolve,10));result=read();}return result;}
function setup(options:{recoveryBaseMs?:number;maxRecoveryAttempts?:number}={}){const directory=fs.mkdtempSync(path.join(os.tmpdir(),"apron-task-mode-"));const store=new TaskStore(directory);const task=store.create({title:"Task Mode contract",repositoryPath:directory,descriptionMd:"需求原文",acceptanceCriteriaMd:"测试通过"});const manager=new ControlledManager();manager.taskId=task.id;const conversations=new TaskConversationService(store,manager as unknown as CodexConversationManager);const mode=new TaskModeService(conversations,{pollMs:20,...options});return {directory,store,task,manager,conversations,mode,close(){mode.close();conversations.close();store.close();fs.rmSync(directory,{recursive:true,force:true});}};}
const activeJob=(mode:TaskModeService,taskId:string,role:string)=>mode.detail(taskId).state.runs.at(-1)?.jobs.find(job=>job.role===role&&job.status==="active");
const decision=(overrides:Record<string,unknown>={})=>({status:"continue",summary:"## 阶段进展\n实现已返回，继续安装和验证",risks:[],stopReason:"",humanActions:[],agentNextSteps:["完成安装和回归验证"],acceptanceReady:false,pauseCategory:"none",remainingWork:["安装和回归验证"],nextWorkers:[],...overrides});

test("new worker aliases create an executor and a legacy blocked saved plan resumes without asking the agent to plan again",async()=>{
  const f=setup();let resumed:TaskModeService|undefined;try{
    await f.mode.submit(f.task.id,{clientMessageId:"initial-alias-worker-001",text:"修复左侧布局",timing:"now"});const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    f.manager.complete(planner!,{understanding:"布局修复",workers:[{workerId:"worker-1",name:"布局实现",objective:"贴左并浮动控件",ownedPaths:["frontend/"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);assert.equal(worker!.planWorkerId,"worker-1");assert.equal(f.mode.detail(f.task.id).state.error,undefined);
    await f.mode.action(f.task.id,"pause");const saved=f.mode.data.get(f.task.id)!;saved.runs[0].jobs=saved.runs[0].jobs.filter(job=>job.role==="plan");saved.runs[0].jobs[0].processed=false;saved.phase="blocked";saved.error="后续分工引用了不可复用的 Worker，请代理重新明确负责人";f.mode.data.save(saved);f.mode.close();
    const agentCalls=f.manager.calls.filter(call=>call.method==="turn/start"&&call.params.threadId===planner!.threadId).length;
    resumed=new TaskModeService(f.conversations,{pollMs:20});await waitFor(()=>activeJob(resumed!,f.task.id,"worker"),Boolean);
    const state=resumed.detail(f.task.id).state;assert.equal(state.phase,"working");assert.equal(state.error,undefined);assert.equal(state.instructions.length,1);assert.equal(state.runs.length,1);
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/start"&&call.params.threadId===planner!.threadId).length,agentCalls);
  }finally{resumed?.close();f.close();}
});

test("continuation resolves known aliases and merges multiple assignments to one reusable thread",async()=>{
  const f=setup();try{
    await f.mode.submit(f.task.id,{clientMessageId:"reuse-alias-worker-001",text:"修复布局并验收",timing:"now"});const plan=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);f.manager.complete(plan!,{understanding:"布局",workers:[{workerId:"worker-1",name:"实现",objective:"布局实现",ownedPaths:["frontend/"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);f.manager.complete(worker!,workerOutput);const review=await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);
    f.manager.complete(review!,decision({nextWorkers:[{workerId:"worker-1",name:"原负责人",objective:"验证列表贴左",ownedPaths:["frontend/list.tsx"]},{workerId:worker!.threadId,name:"同一负责人",objective:"验证 header 悬浮",ownedPaths:["frontend/header.tsx"]}]}));
    const follow=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),job=>Boolean(job&&job.id!==worker!.id));assert.equal(follow!.threadId,worker!.threadId);assert.equal(follow!.ownerId,worker!.id);assert.match(follow!.text,/验证列表贴左/);assert.match(follow!.text,/验证 header 悬浮/);
    assert.equal(f.mode.detail(f.task.id).state.runs[0].jobs.filter(job=>job.role==="worker"&&job.cycle===1).length,1);assert.equal(f.manager.calls.filter(call=>call.method==="thread/start").length,2);
  }finally{f.close();}
});

test("a progress question gets a direct task reply without steering workers or becoming an implementation goal",async()=>{
  const f=setup();try{
    const state=f.mode.data.ensure(f.task.id);state.settings.agentPrompt="旧版调度提示词";f.mode.data.save(state);
    await f.mode.submit(f.task.id,{clientMessageId:"task-progress-001",text:"降低库存导入耗时",timing:"now"});const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    f.manager.complete(planner!,{userUpdate:"正在定位库存导入的主要耗时，暂未测得收益。",understanding:"内部明确范围",workers:[{name:"性能实施",objective:"优化导入性能",ownedPaths:["src/"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean),runId=f.mode.detail(f.task.id).state.activeRunId;
    await f.mode.submit(f.task.id,{clientMessageId:"task-progress-question-002",text:"我要的性能优化实施得怎么样了？",timing:"now"});const steer=await waitFor(()=>activeJob(f.mode,f.task.id,"steer"),Boolean);
    const resume=f.manager.calls.filter(call=>call.method==="thread/resume"&&call.params.threadId===steer!.threadId).at(-1)!;
    assert.match(resume.params.developerInstructions,/负责员工/);assert.match(resume.params.developerInstructions,/当前负责的任务：Task Mode contract/);assert.match(steer!.text,/已有阶段汇报/);
    const reply="本地导入已从 4.99 秒降至 4.27 秒，完整流程收益还待验证，尚未上线。";
    f.manager.complete(steer!,{userUpdate:reply,deliveryMode:"reply_only",understanding:"用户仅询问当前效果",workerIds:[],instructions:""});
    const after=await waitFor(()=>f.mode.detail(f.task.id).state,state=>state.instructions[1].replyOnly===true);
    assert.equal(after.phase,"working");assert.equal(after.activeRunId,runId);assert.equal(after.instructions[1].agentReply,reply);assert.equal(after.instructions[1].status,"completed");assert.equal(after.instructions[1].deliveries.length,0);assert.equal(after.runs[0].instructionIds.length,1);
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/steer").length,0);
    f.manager.complete(worker!,workerOutput);const review=await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);assert.doesNotMatch(review!.text,/我要的性能优化实施得怎么样了/);
    f.manager.complete(review!,decision({status:"done",summary:"性能优化和完整验证均已完成",acceptanceReady:true,remainingWork:[],agentNextSteps:[]}));
    const finished=await waitFor(()=>f.mode.detail(f.task.id).state,state=>state.phase==="completed");assert.equal(finished.instructions[1].agentReply,reply);assert.equal(finished.instructions[1].result,undefined);
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/start"&&call.params.threadId===worker!.threadId).length,1);
  }finally{f.close();}
});

test("worker dispatch instructions stay out of public next steps while continuation keeps the full assignment",async()=>{
  const f=setup();try{
    await f.mode.submit(f.task.id,{clientMessageId:"public-report-001",text:"优化导入耗时",timing:"now"});const plan=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);f.manager.complete(plan!,{understanding:"实施优化",workers:[{name:"实施",objective:"优化导入",ownedPaths:["src/"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);f.manager.complete(worker!,workerOutput);const review=await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);
    const internal="INTERNAL_DISPATCH：核对文件所有权、fixture、源码指纹并在独占数据库修复剩余测试。";
    f.manager.complete(review!,decision({summary:"导入优化已实施，正在验证完整流程的实际收益。",agentNextSteps:["验证完整导入耗时和数据正确性"],nextWorkers:[{workerId:worker!.id,name:"补齐验证",objective:internal,ownedPaths:["src/"]}]}));
    const next=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),job=>Boolean(job&&job.id!==worker!.id));const result=f.mode.detail(f.task.id).state.instructions[0].result!;
    assert.deepEqual(result.agentNextSteps,["验证完整导入耗时和数据正确性"]);assert.ok(result.internalNextSteps!.includes(internal));assert.match(next!.text,/INTERNAL_DISPATCH/);assert.equal(next!.threadId,worker!.threadId);
  }finally{f.close();}
});

test("archived and deleted queued requirements stay excluded after restart; restore requeues only its original requirement",async()=>{
  const f=setup();let resumed:TaskModeService|undefined;
  try{
    const initial=f.mode.data.ensure(f.task.id);initial.phase="paused";f.mode.data.save(initial);
    for(const [clientMessageId,text] of [["archive-queued-001","ARCHIVED_REQUIREMENT"],["delete-queued-002","DELETED_REQUIREMENT"],["active-queued-003","ACTIVE_REQUIREMENT"]])await f.mode.submit(f.task.id,{clientMessageId,text,timing:"now"});
    const [archived,deleted,active]=f.mode.detail(f.task.id).state.instructions;
    await f.mode.instructionAction(f.task.id,archived.id,"archive");await f.mode.instructionAction(f.task.id,deleted.id,"delete");
    await assert.rejects(f.mode.submit(f.task.id,{clientMessageId:deleted.clientMessageId,text:deleted.text,timing:"now"}),/已删除/);
    await assert.rejects(f.mode.instructionAction(f.task.id,deleted.id,"restore"),/已删除/);
    f.mode.close();resumed=new TaskModeService(f.conversations,{pollMs:20});await resumed.action(f.task.id,"resume");
    const plan=await waitFor(()=>activeJob(resumed!,f.task.id,"plan"),Boolean);
    assert.deepEqual(resumed.detail(f.task.id).state.runs[0].instructionIds,[active.id]);
    assert.match(plan!.text,/ACTIVE_REQUIREMENT/);assert.doesNotMatch(plan!.text,/ARCHIVED_REQUIREMENT|DELETED_REQUIREMENT/);
    await resumed.instructionAction(f.task.id,archived.id,"restore");
    const state=await waitFor(()=>resumed!.detail(f.task.id).state,state=>state.instructions[0].status==="agent_received");
    assert.equal(state.instructions.length,3);assert.deepEqual(state.runs[0].instructionIds,[active.id,archived.id]);
    assert.equal(state.instructions[0].archivedAt,undefined);assert.ok(state.instructions[1].deletedAt);
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/steer").length,1);
  }finally{resumed?.close();f.close();}
});

test("organizing sent requirements preserves snapshots, delivery receipts and the running worker's final result",async()=>{
  const f=setup();try{
    await f.mode.submit(f.task.id,{clientMessageId:"sent-requirement-001",text:"SENT_ORIGINAL_REQUIREMENT",timing:"now"});
    const plan=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);f.manager.complete(plan!,{understanding:"原需求",workers:[{name:"实现",objective:"实现",ownedPaths:["src/"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);
    const original=structuredClone(f.mode.detail(f.task.id).state.instructions[0]);
    await f.mode.instructionAction(f.task.id,original.id,"archive");await f.mode.instructionAction(f.task.id,original.id,"restore");await f.mode.instructionAction(f.task.id,original.id,"delete");
    const removed=f.mode.detail(f.task.id).state.instructions[0];assert.equal(removed.runId,original.runId);assert.equal(removed.text,original.text);assert.deepEqual(removed.snapshot,original.snapshot);assert.deepEqual(removed.deliveries,original.deliveries);
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/interrupt").length,0);assert.equal(f.mode.detail(f.task.id).state.phase,"working");
    f.manager.complete(worker!,workerOutput);const review=await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);assert.match(review!.text,/SENT_ORIGINAL_REQUIREMENT/);
    f.manager.complete(review!,decision({status:"done",summary:"全部验收完成",acceptanceReady:true,remainingWork:[],agentNextSteps:[]}));
    const state=await waitFor(()=>f.mode.detail(f.task.id).state,state=>state.phase==="completed");
    assert.ok(state.instructions[0].deletedAt);assert.equal(state.instructions[0].result?.acceptanceReady,true);assert.equal(state.runs[0].result?.acceptanceReady,true);assert.equal(f.mode.list().states[0].instructionCount,0);
  }finally{f.close();}
});

test("archived tasks cannot submit or resume; restore keeps the paused run and delete cascades its state",async()=>{
  const f=setup();try{
    await f.mode.submit(f.task.id,{clientMessageId:"archive-task-001",text:"继续原有任务",timing:"now"});await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    await f.mode.action(f.task.id,"pause");const before=f.mode.detail(f.task.id).state;f.store.archive(f.task.id);
    assert.equal(f.mode.list().tasks.length,0);assert.equal(f.mode.list(true).tasks[0].id,f.task.id);
    await assert.rejects(f.mode.action(f.task.id,"resume"),/先恢复已归档任务/);await assert.rejects(f.mode.action(f.task.id,"retry"),/先恢复已归档任务/);
    await assert.rejects(f.mode.submit(f.task.id,{clientMessageId:"archived-submit-002",text:"新需求",timing:"now"}),/先恢复已归档任务/);
    assert.equal(f.mode.detail(f.task.id).state.phase,"paused");assert.equal(f.mode.detail(f.task.id).state.activeRunId,before.activeRunId);
    f.store.restore(f.task.id);assert.equal(f.mode.detail(f.task.id).state.phase,"paused");await f.mode.action(f.task.id,"resume");await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    assert.equal(f.mode.detail(f.task.id).state.runs.length,1);assert.equal(f.manager.calls.filter(call=>call.method==="thread/start").length,1);
    await f.mode.action(f.task.id,"pause");f.store.delete(f.task.id);assert.equal(f.mode.data.get(f.task.id),null);
  }finally{f.close();}
});

test("partial results and preview artifacts continue with the original worker and only ready results await acceptance",async()=>{
  const f=setup();let restored:TaskModeService|undefined;
  try{
    fs.writeFileSync(path.join(f.directory,"preview.md"),"阶段预览");
    await f.mode.submit(f.task.id,{clientMessageId:"autonomous-loop-001",text:"完成实现、安装和真实回归后再交付",timing:"now"});
    const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);f.manager.complete(planner!,{understanding:"完整验收",workers:[{name:"实现",objective:"实现和验证",ownedPaths:["src/"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);
    f.manager.complete(worker!,{...workerOutput,verification:[{command:"实际回归",result:"failed",details:"尚需修复"}],artifacts:[{path:"preview.md",title:"阶段预览"}]});
    const reviewer=await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);
    f.manager.complete(reviewer!,decision({status:"needs_confirmation",nextWorkers:[{workerId:worker!.id,name:"补齐验收",objective:"只修复并补齐安装回归",ownedPaths:["src/"]}]}));
    const follow=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),job=>Boolean(job&&job.id!==worker!.id));
    assert.equal(follow!.threadId,worker!.threadId);assert.equal(f.mode.detail(f.task.id).state.runs.length,1);assert.equal(f.mode.detail(f.task.id).state.instructions.length,1);
    assert.equal(f.mode.detail(f.task.id).state.instructions[0].result?.status,"in_progress");assert.equal(f.store.get(f.task.id)?.status,"in_progress");assert.equal(f.store.get(f.task.id)?.latestReport?.status,"progress");
    assert.equal(f.manager.calls.filter(call=>call.method==="thread/start").length,2);
    await f.mode.action(f.task.id,"pause");f.mode.close();restored=new TaskModeService(f.conversations,{pollMs:20});
    assert.equal(restored.detail(f.task.id).state.phase,"paused");await restored.action(f.task.id,"resume");
    const resumed=await waitFor(()=>activeJob(restored!,f.task.id,"worker"),Boolean);f.manager.complete(resumed!,{...workerOutput,artifacts:[{path:"preview.md",title:"最终材料"}]});
    const finalReview=await waitFor(()=>activeJob(restored!,f.task.id,"review"),Boolean);
    f.manager.complete(finalReview!,decision({status:"done",summary:"所有目标与验收验证已通过",acceptanceReady:true,remainingWork:[],agentNextSteps:[]}));
    const ready=await waitFor(()=>restored!.detail(f.task.id).state,state=>state.phase==="needs_confirmation");
    assert.equal(ready.runs[0].result?.acceptanceReady,true);assert.ok(ready.runs[0].result!.verification.every(item=>item.result==="passed"));
    await restored.action(f.task.id,"approve");assert.equal(restored.detail(f.task.id).state.phase,"completed");
  }finally{restored?.close();f.close();}
});

test("human-readable run reports include exact evidence and scoped originals without mutating execution",async()=>{
  const f=setup();try{
    fs.writeFileSync(path.join(f.directory,"results.html"),"<h1>实验结果</h1>");fs.writeFileSync(path.join(f.directory,"results.md"),"# 实施结果\n\n完整验证证据");
    await f.mode.submit(f.task.id,{clientMessageId:"document-report-001",text:"汇总实验与实施结果",timing:"now"});
    const plan=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);f.manager.complete(plan!,{understanding:"汇总",workers:[{name:"实现",objective:"实施并整理实验结果",ownedPaths:["src/"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);assert.match(worker!.text,/自包含 HTML/);
    f.manager.complete(worker!,{...workerOutput,artifacts:[{path:"results.html",title:"实验结果"},{path:"results.md",title:"实施结果"}]});
    const review=await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);f.manager.complete(review!,decision({status:"done",summary:"## 已完成\n实施和实验结果已汇总\n\n## 验证结论\n必要验证通过",acceptanceReady:true,remainingWork:[],agentNextSteps:[]}));
    const state=await waitFor(()=>f.mode.detail(f.task.id).state,state=>state.phase==="needs_confirmation"),run=state.runs[0];
    const before=JSON.stringify(state),calls=f.manager.calls.length,report=f.mode.runReport(f.task.id,run.id);
    assert.match(report.markdown,/## 结论/);assert.match(report.markdown,/## 验证情况/);assert.match(report.markdown,/node --test/);assert.match(report.markdown,/汇总实验与实施结果/);assert.match(report.markdown,/审查本轮结果和材料/);assert.match(report.markdown,/mode=artifact/);
    assert.deepEqual(run.result!.artifacts.map(file=>file.mimeType),["text/html","text/markdown"]);
    assert.equal(JSON.stringify(f.mode.data.get(f.task.id)),before);assert.equal(f.manager.calls.length,calls);assert.throws(()=>f.mode.runReport(f.task.id,"wrong-run"),/执行记录不存在/);
    f.store.archive(f.task.id);assert.equal(f.mode.runReport(f.task.id,run.id).runId,run.id);
  }finally{f.close();}
});

test("true external blockers, unclear requirements and exceptions pause with an explicit category",async()=>{
  for(const category of ["blocked","unclear_requirement","exception"]){
    const f=setup();try{
      await f.mode.submit(f.task.id,{clientMessageId:`pause-category-${category}`,text:"推进至可验收",timing:"now"});const plan=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);f.manager.complete(plan!,{understanding:"需求",workers:[{name:"实现",objective:"实现",ownedPaths:["src/"]}]});
      const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);f.manager.complete(worker!,workerOutput);const review=await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);
      f.manager.complete(review!,decision({status:"blocked",pauseCategory:category,stopReason:"需要外部条件或决定",humanActions:[{action:"补充必要条件",reason:"代理无法自行取得该条件",unblocks:"剩余验收"}]}));
      const stopped=await waitFor(()=>f.mode.detail(f.task.id).state,state=>state.phase==="blocked");assert.equal(stopped.runs[0].result?.pauseCategory,category);assert.equal(stopped.runs[0].result?.acceptanceReady,false);
    }finally{f.close();}
  }
});

test("repeated identical evidence becomes an explicit no-progress exception instead of an endless loop",async()=>{
  const f=setup();try{
    await f.mode.submit(f.task.id,{clientMessageId:"stalled-loop-001",text:"完成验收",timing:"now"});const plan=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);f.manager.complete(plan!,{understanding:"需求",workers:[{name:"实现",objective:"修复",ownedPaths:["src/"]}]});
    for(let index=0;index<4;index++){
      const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);f.manager.complete(worker!,workerOutput);const review=await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);
      f.manager.complete(review!,decision({nextWorkers:[{workerId:worker!.id,name:"修复",objective:"安装和回归验证",ownedPaths:["src/"]}]}));
      if(index<3)await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),job=>Boolean(job&&job.id!==worker!.id));
    }
    const stopped=await waitFor(()=>f.mode.detail(f.task.id).state,state=>state.phase==="blocked");assert.equal(stopped.runs[0].result?.pauseCategory,"exception");assert.match(stopped.runs[0].result?.stopReason??"",/重复空转/);
  }finally{f.close();}
});

test("an oversized review uses complete file-backed evidence and leaves finished workers untouched",async()=>{
  const f=setup();
  try{
    await f.mode.submit(f.task.id,{clientMessageId:"large-review-001",text:"检查全部改动，保留原文",timing:"now"});
    const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    f.manager.complete(planner!,{understanding:"检查",workers:[{name:"实现",objective:"实现",ownedPaths:["src/"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);f.manager.complete(worker!,workerOutput);
    const native=f.manager.threads.get(worker!.threadId!).turns.find((turn:any)=>turn.id===worker!.turnId);
    native.items.find((item:any)=>item.type==="fileChange").changes=[{path:"src/a.ts",diff:"+change\n".repeat(10000)},{path:"src/b.ts",diff:"+change\n".repeat(10000)}];
    const review=await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);
    assert.ok(review!.text.length>100000);assert.ok(review!.contextPacket);
    const request=f.manager.calls.filter(call=>call.method==="turn/start"&&call.params.threadId===review!.threadId).at(-1)!;
    assert.ok(request.params.input[0].text.length<60000);assert.equal(fs.readFileSync(review!.contextPacket!.path,"utf8"),review!.text);
    const evidence=JSON.parse(fs.readFileSync(review!.contextPacket!.evidencePath,"utf8"));
    assert.equal(evidence.requirements[0].text,"检查全部改动，保留原文");assert.equal(evidence.workers[0].result.summary,"实现完成");
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/start"&&call.params.threadId===worker!.threadId).length,1);
    assert.equal(f.mode.detail(f.task.id).state.phase,"reviewing");
  }finally{f.close();}
});

test("startup resumes a legacy oversized pending review without starting completed workers again",async()=>{
  const f=setup();let restored:TaskModeService|undefined;
  try{
    const state=f.mode.data.ensure(f.task.id);
    const worker:TaskExecutionJob={id:"done-worker",role:"worker",name:"已完成 Worker",objective:"实现",ownedPaths:["src/"],status:"completed",attempt:0,text:"完成",model:"gpt-6.1-sol",items:[],output:workerOutput,processed:true};
    const review:TaskExecutionJob={...worker,id:"blocked-review",role:"review",name:"检查",status:"pending",text:"待检查的完整材料\n".repeat(15000),output:undefined,processed:undefined};
    state.runs=[{id:"legacy-run",instructionIds:[],createdAt:new Date().toISOString(),settings:state.settings,jobs:[worker,review],reviewAttempt:0}];state.activeRunId="legacy-run";state.phase="blocked";state.error="本轮上下文过长，请减少引用文档或拆分指示";f.mode.data.save(state);f.mode.close();
    restored=new TaskModeService(f.conversations,{pollMs:20});
    const resumed=await waitFor(()=>activeJob(restored!,f.task.id,"review"),Boolean);
    assert.ok(resumed!.contextPacket);assert.equal(restored.detail(f.task.id).state.error,undefined);
    assert.equal(restored.detail(f.task.id).state.runs[0].jobs[0].status,"completed");
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/start").length,1);
  }finally{restored?.close();f.close();}
});

test("clarifies a blocked legacy report in a read-only review without rerunning workers or discarding evidence",async()=>{
  const f=setup();
  try{
    await f.mode.submit(f.task.id,{clientMessageId:"report-guidance-001",text:"保留已发布候选，核验主题",timing:"now"});
    const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    f.manager.complete(planner!,{understanding:"主题验收",workers:[{name:"核验",objective:"核验主题",ownedPaths:["src/"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);
    f.manager.complete(worker!,{...workerOutput,blockers:["认证元数据返回 403"]});
    const review=await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);
    f.manager.complete(review!,{status:"blocked",summary:"已发布，尚未安装验收",risks:["缺少测试权限"],stopReason:"缺少测试权限",humanActions:[{action:"登录测试账号",reason:"403",unblocks:"认证接口验证"}],agentNextSteps:["登录后验证接口"]});
    const before=await waitFor(()=>f.mode.detail(f.task.id).state,state=>state.phase==="blocked");
    const original=structuredClone(before.runs.at(-1)!.result!);
    delete original.humanActions;delete original.agentNextSteps;delete original.stopReason;
    before.runs.at(-1)!.result=original;for(const entry of before.instructions)entry.result=original;f.mode.data.save(before);
    const turnStarts=f.manager.calls.filter(call=>call.method==="turn/start").length;
    await assert.rejects(()=>f.mode.action(f.task.id,"retry"),/补齐行动说明/);
    await f.mode.action(f.task.id,"clarify_report");
    await assert.rejects(()=>f.mode.action(f.task.id,"clarify_report"),/等待当前执行结束/);
    let clarify=await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);
    assert.equal(clarify!.purpose,"clarify_report");
    const request=f.manager.calls.filter(call=>call.method==="turn/start").at(-1)!;
    assert.equal(request.params.sandboxPolicy.type,"readOnly");
    assert.deepEqual(request.params.outputSchema.required,["status","summary","risks","stopReason","humanActions","agentNextSteps","acceptanceReady","pauseCategory","remainingWork","nextWorkers"]);
    await f.mode.action(f.task.id,"pause");
    await f.mode.action(f.task.id,"resume");
    clarify=await waitFor(()=>activeJob(f.mode,f.task.id,"review"),job=>Boolean(job&&job.turnId!==clarify!.turnId));
    f.manager.complete(clarify!,{status:"done",summary:"## 已完成\n发布核验通过\n## 未完成\n认证接口待验收",risks:[],stopReason:"缺少 beta 测试账号权限",humanActions:[{action:"在 RPBox 登录具备 beta 权限的账号，在任务中回复已登录",reason:"更新接口返回 403，代理无法授予权限",unblocks:"认证更新元数据验收"}],agentNextSteps:["用独立浏览器上下文继续主题回归","获得授权登录状态后校验认证更新接口"]});
    const after=await waitFor(()=>f.mode.detail(f.task.id).state,state=>state.phase==="blocked"&&Boolean(state.runs.at(-1)!.result?.humanActions));
    const result=after.runs.at(-1)!.result!;
    assert.equal(result.status,"blocked");assert.deepEqual(result.changes,original.changes);assert.deepEqual(result.artifacts,original.artifacts);assert.deepEqual(result.verification,original.verification);
    assert.equal(after.runs.length,1);assert.equal(after.instructions.length,1);assert.equal(after.instructions[0].deliveries.length,1);
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/start").length,turnStarts+2);
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/start"&&call.params.threadId===worker!.threadId).length,1);
    const report=f.store.get(f.task.id)!.latestReport!;
    assert.match(report.blockers.join(" "),/beta/);assert.match(report.nextStep,/你需要做什么/);assert.match(report.nextStep,/代理下一步/);assert.match(report.nextStep,/403/);
    const replayStarts=f.manager.calls.filter(call=>call.method==="turn/start").length;
    await f.mode.action(f.task.id,"reread_output");
    const replayed=await waitFor(()=>f.mode.detail(f.task.id).state,state=>state.phase==="blocked"&&state.runs.at(-1)!.jobs.find(job=>job.id===clarify!.id)?.processed===true);
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/start").length,replayStarts);
    assert.deepEqual(replayed.runs.at(-1)!.result!.risks,[]);
    assert.deepEqual(replayed.runs.at(-1)!.result!.humanActions,result.humanActions);
  }finally{f.close();}
});

test("separate final prose and JSON advance to review without rerunning the Worker",async()=>{
  const f=setup();
  try{
    await f.mode.submit(f.task.id,{clientMessageId:"output-messages-001",text:"准备发布候选",timing:"now"});
    const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    f.manager.complete(planner!,{understanding:"候选",workers:[{name:"发布",objective:"准备候选",ownedPaths:["client/"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);
    const rawTurn=f.manager.threads.get(worker!.threadId!).turns.find((turn:any)=>turn.id===worker!.turnId);
    rawTurn.items.push({id:"pre-report",type:"agentMessage",phase:"final",text:"候选已准备，请代理检查再继续。"});
    f.manager.complete(worker!,workerOutput);
    await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/start"&&call.params.threadId===worker!.threadId).length,1);
    assert.equal(f.mode.detail(f.task.id).state.runs.at(-1)?.jobs.find(job=>job.id===worker!.id)?.output?.summary,"实现完成");
  }finally{f.close();}
});

test("restarts a legacy blocked parse failure by rereading the original turn, retaining evidence and delivery receipts",async()=>{
  const f=setup();let resumed:TaskModeService|undefined;let data:TaskModeStore|undefined;
  try{
    await f.mode.submit(f.task.id,{clientMessageId:"output-legacy-001",text:"重读已有候选",timing:"now"});
    const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    f.manager.complete(planner!,{understanding:"候选",workers:[{name:"发布",objective:"准备候选",ownedPaths:["client/"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);
    f.manager.complete(worker!,workerOutput);f.mode.close();
    data=new TaskModeStore(f.store.dbPath);const old=data.get(f.task.id)!;const failed=old.runs.at(-1)!.jobs.find(job=>job.id===worker!.id)!;
    failed.status="failed";failed.error=LEGACY_TASK_OUTPUT_ERROR;old.phase="blocked";old.error=LEGACY_TASK_OUTPUT_ERROR;old.heartbeat.status="needs_attention";data.save(old);data.close();data=undefined;
    resumed=new TaskModeService(f.conversations,{pollMs:20,recoveryBaseMs:10});
    await waitFor(()=>activeJob(resumed!,f.task.id,"review"),Boolean);
    const state=resumed.detail(f.task.id).state;const recovered=state.runs.at(-1)!.jobs.find(job=>job.id===worker!.id)!;
    assert.equal(recovered.status,"completed");assert.equal(recovered.turnId,worker!.turnId);assert.equal(recovered.attempt,worker!.attempt);
    assert.equal(state.instructions[0].deliveries.length,1);assert.equal(state.error,undefined);
    assert.equal(f.store.get(f.task.id)?.status,"in_progress");
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/start"&&call.params.threadId===worker!.threadId).length,1);
    assert.ok(recovered.items.some(item=>item.kind==="file_change"));
  }finally{data?.close();resumed?.close();f.close();}
});

test("rechecks delayed structured output without starting another execution turn",async()=>{
  const f=setup({recoveryBaseMs:80,maxRecoveryAttempts:2});
  try{
    await f.mode.submit(f.task.id,{clientMessageId:"output-delayed-001",text:"等待完整汇报",timing:"now"});
    const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    f.manager.complete(planner!,{understanding:"候选",workers:[{name:"执行",objective:"准备候选",ownedPaths:["src/"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);
    f.manager.complete(worker!,{summary:"尚未持久化完整字段"});
    await waitFor(()=>f.mode.detail(f.task.id).state.heartbeat,heartbeat=>heartbeat.status==="recovering"&&Boolean(heartbeat.message?.includes("读取")));
    const turn=f.manager.threads.get(worker!.threadId!).turns.find((turn:any)=>turn.id===worker!.turnId);turn.items.find((item:any)=>item.type==="agentMessage").text=JSON.stringify(workerOutput);
    await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/start"&&call.params.threadId===worker!.threadId).length,1);
  }finally{f.close();}
});

test("bounds invalid-output rereads and a manual retry rereads without repeating implementation",async()=>{
  const f=setup({recoveryBaseMs:10,maxRecoveryAttempts:2});
  try{
    await f.mode.submit(f.task.id,{clientMessageId:"output-invalid-001",text:"验证格式失败恢复",timing:"now"});
    const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    f.manager.complete(planner!,{understanding:"候选",workers:[{name:"执行",objective:"准备候选",ownedPaths:["src/"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);f.manager.complete(worker!,{unrecognized:true});
    const blocked=await waitFor(()=>f.mode.detail(f.task.id).state,state=>state.phase==="blocked");
    const failed=blocked.runs.at(-1)!.jobs.find(job=>job.id===worker!.id)!;
    assert.equal(failed.errorCode,"invalid_structured_output");assert.equal(failed.outputReadAttempts,3);assert.match(failed.error??"",/已重读 2 次/);
    const turn=f.manager.threads.get(worker!.threadId!).turns.find((turn:any)=>turn.id===worker!.turnId);turn.items.find((item:any)=>item.type==="agentMessage").text=JSON.stringify(workerOutput);
    await f.mode.action(f.task.id,"reread_output");await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/start"&&call.params.threadId===worker!.threadId).length,1);
    assert.equal(f.mode.detail(f.task.id).state.heartbeat.status,"healthy");
  }finally{f.close();}
});

test("rereading one failed report preserves a different Worker that is still running",async()=>{
  const f=setup({recoveryBaseMs:10,maxRecoveryAttempts:1});
  try{
    await f.mode.submit(f.task.id,{clientMessageId:"output-parallel-001",text:"两个独立工作",timing:"now"});
    const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    f.manager.complete(planner!,{understanding:"独立执行",workers:[{name:"A",objective:"A",ownedPaths:["a/"]},{name:"B",objective:"B",ownedPaths:["b/"]}]});
    const workers=await waitFor(()=>f.mode.detail(f.task.id).state.runs.at(-1)!.jobs.filter(job=>job.role==="worker"&&job.status==="active"),jobs=>jobs.length===2);
    await assert.rejects(()=>f.mode.action(f.task.id,"reread_output"),/没有需要重新读取/);
    f.manager.complete(workers[0],{unrecognized:true});await waitFor(()=>f.mode.detail(f.task.id).state,state=>state.phase==="blocked");
    const turn=f.manager.threads.get(workers[0].threadId!).turns.find((turn:any)=>turn.id===workers[0].turnId);turn.items.find((item:any)=>item.type==="agentMessage").text=JSON.stringify(workerOutput);
    await f.mode.action(f.task.id,"reread_output");
    const state=await waitFor(()=>f.mode.detail(f.task.id).state,state=>state.runs.at(-1)!.jobs.find(job=>job.id===workers[0].id)?.status==="completed");
    assert.equal(state.phase,"working");assert.equal(state.runs.at(-1)!.jobs.find(job=>job.id===workers[1].id)?.turnId,workers[1].turnId);
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/start"&&call.params.threadId===workers[1].threadId).length,1);
    assert.equal(f.manager.calls.some(call=>call.method==="turn/interrupt"),false);
  }finally{f.close();}
});

test("uses native Codex auto-review and freezes review settings until the next run",async()=>{
  const f=setup();
  try{
    await f.mode.submit(f.task.id,{clientMessageId:"approval-default-001",text:"测试执行审批策略",timing:"now"});
    const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    for(const method of ["thread/start","thread/resume","turn/start"]){
      const request=f.manager.calls.find(call=>call.method===method);
      assert.equal(request?.params.approvalsReviewer,"auto_review");
      assert.equal(request?.params.approvalPolicy,"on-request");
    }
    await f.mode.settings({...f.mode.detail(f.task.id).state.settings,approvalsReviewer:"user"},f.task.id);
    f.manager.complete(planner!,{understanding:"检查手动模式",workers:[{name:"实现",objective:"执行授权范围",ownedPaths:["src/a.ts"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);
    const turn=f.manager.calls.find(call=>call.method==="turn/start"&&call.params.threadId===worker!.threadId);
    assert.equal(turn?.params.approvalsReviewer,"auto_review");
    assert.equal(turn?.params.approvalPolicy,"on-request");
    assert.equal(turn?.params.sandboxPolicy.type,"workspaceWrite");
    assert.equal(f.mode.detail(f.task.id).state.runs.at(-1)?.settings.approvalsReviewer,"auto_review");
    assert.equal(f.mode.detail(f.task.id).state.settings.approvalsReviewer,"user");
    assert.throws(()=>validateSettings({...f.mode.detail(f.task.id).state.settings,approvalsReviewer:"approve_all"}),/无效选项/);
  }finally{f.close();}
});

test("hydrates legacy saved settings and running snapshots with auto-review while keeping an explicit manual choice",async()=>{
  const f=setup();let data:TaskModeStore|undefined;
  try{
    await f.mode.submit(f.task.id,{clientMessageId:"approval-legacy-001",text:"旧任务审批迁移",timing:"now"});
    await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    const settings=f.mode.detail(f.task.id).state.settings;
    f.mode.data.saveSettings(settings);
    f.mode.close();
    const database=new DatabaseSync(f.store.dbPath);
    database.exec("UPDATE task_mode_state SET data=json_remove(data,'$.settings.approvalsReviewer','$.runs[0].settings.approvalsReviewer'); UPDATE task_mode_preferences SET data=json_remove(data,'$.approvalsReviewer') WHERE key='settings';");
    database.close();
    data=new TaskModeStore(f.store.dbPath);
    assert.equal(data.settings().approvalsReviewer,"auto_review");
    const restored=data.get(f.task.id)!;
    assert.equal(restored.settings.approvalsReviewer,"auto_review");
    assert.equal(restored.runs[0].settings.approvalsReviewer,"auto_review");
    restored.settings.approvalsReviewer="user";restored.runs[0].settings.approvalsReviewer="user";data.save(restored);
    data.close();data=new TaskModeStore(f.store.dbPath);
    assert.equal(data.get(f.task.id)?.settings.approvalsReviewer,"user");
    assert.equal(data.get(f.task.id)?.runs[0].settings.approvalsReviewer,"user");
  }finally{data?.close();f.close();}
});

test("heartbeats confirm the live turn and recover after a transient Codex read failure",async()=>{
  const f=setup({recoveryBaseMs:30,maxRecoveryAttempts:2});
  try{
    await f.mode.submit(f.task.id,{clientMessageId:"heartbeat-task-001",text:"检查心跳",timing:"now"});
    await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    await waitFor(()=>f.mode.detail(f.task.id).state.heartbeat,value=>value.status==="healthy"&&Boolean(value.checkedAt));
    f.manager.failReads=1;
    const waiting=await waitFor(()=>f.mode.detail(f.task.id).state.heartbeat,value=>value.status==="recovering");
    assert.equal(waiting.recoveryAttempts,1);
    assert.ok(waiting.nextRetryAt);
    const recovered=await waitFor(()=>f.mode.detail(f.task.id).state.heartbeat,value=>value.status==="healthy"&&Boolean(value.lastRecoveredAt));
    assert.equal(recovered.recoveryAttempts,0);
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/start").length,1);
  }finally{f.close();}
});

test("a restarted scheduler attaches to the active Codex turn without starting it twice",async()=>{
  const f=setup({recoveryBaseMs:20});let resumed:TaskModeService|undefined;
  try{
    await f.mode.submit(f.task.id,{clientMessageId:"heartbeat-restart-001",text:"检查重启后的会话",timing:"now"});
    const first=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    f.mode.close();
    resumed=new TaskModeService(f.conversations,{pollMs:20,recoveryBaseMs:20});
    await waitFor(()=>resumed!.detail(f.task.id).state.heartbeat,value=>value.status==="healthy"&&Boolean(value.checkedAt));
    const attached=activeJob(resumed,f.task.id,"plan");
    assert.equal(attached?.turnId,first?.turnId);
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/start").length,1);
  }finally{resumed?.close();f.close();}
});

test("an unexpectedly interrupted turn resumes in the same thread after checking prior work",async()=>{
  const f=setup({recoveryBaseMs:20,maxRecoveryAttempts:2});
  try{
    await f.mode.submit(f.task.id,{clientMessageId:"heartbeat-interrupt-001",text:"恢复中断的回合",timing:"now"});
    const first=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    await f.manager.request("turn/interrupt",{threadId:first!.threadId,turnId:first!.turnId});
    const resumed=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),job=>Boolean(job&&job.turnId!==first!.turnId));
    assert.equal(resumed?.threadId,first!.threadId);
    assert.equal(resumed?.attempt,1);
    assert.match(resumed?.text??"",/先检查已有文件/);
    assert.equal(f.mode.detail(f.task.id).state.heartbeat.status,"healthy");
  }finally{f.close();}
});

test("stops automatic recovery after the configured bound and shows the blocker",async()=>{
  const f=setup({recoveryBaseMs:10,maxRecoveryAttempts:2});
  try{
    await f.mode.submit(f.task.id,{clientMessageId:"heartbeat-failure-001",text:"模拟持续断线",timing:"now"});
    await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    f.manager.failReads=100;
    const state=await waitFor(()=>f.mode.detail(f.task.id).state,value=>value.phase==="blocked");
    assert.equal(state.heartbeat.status,"needs_attention");
    assert.match(state.error??"",/自动恢复已尝试 2 次/);
    assert.equal(f.manager.calls.filter(call=>call.method==="turn/start").length,1);
  }finally{f.close();}
});

test("recovers an instruction durably queued immediately before the scheduler restarted",async()=>{
  const f=setup();let resumed:TaskModeService|undefined;
  try{await f.mode.submit(f.task.id,{clientMessageId:"queued-before-restart",text:"已持久保存但尚未分配的需求",timing:"after"});f.mode.close();resumed=new TaskModeService(f.conversations,{pollMs:20});await waitFor(()=>activeJob(resumed!,f.task.id,"plan"),Boolean);assert.equal(resumed.detail(f.task.id).state.instructions.length,1);assert.equal(f.manager.calls.filter(call=>call.method==="thread/start").length,1);}
  finally{resumed?.close();f.close();}
});

test("durably deduplicates instructions, preserves snapshots and waits for agent review",async()=>{
  const f=setup();try{
    const input={clientMessageId:"same-submission-001",text:"请实现功能",timing:"now" as const};
    await Promise.all([f.mode.submit(f.task.id,input),f.mode.submit(f.task.id,input)]);
    assert.equal(f.mode.detail(f.task.id).state.instructions.length,1);
    f.store.update(f.task.id,{descriptionMd:"后续编辑的需求"});
    assert.equal(f.mode.detail(f.task.id).state.instructions[0].snapshot.descriptionMd,"需求原文");
    await assert.rejects(()=>f.mode.submit(f.task.id,{...input,text:"不同内容"}),/相同请求标识/);
    const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    assert.equal(f.mode.detail(f.task.id).state.instructions[0].status,"agent_received");
    f.manager.complete(planner!,{understanding:"理解原文",workers:[{name:"实现",objective:"实现功能",ownedPaths:["src/a.ts"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);
    assert.notEqual(worker!.threadId,planner!.threadId);
    assert.match(worker!.text,/需求原文/);
    assert.equal(f.mode.detail(f.task.id).state.instructions[0].deliveries.length,1);
    f.manager.complete(worker!,workerOutput);
    const reviewer=await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);
    assert.equal(f.store.get(f.task.id)?.status,"in_progress");
    f.manager.complete(reviewer!,{status:"done",summary:"代码与验证通过",risks:[]});
    const state=await waitFor(()=>f.mode.detail(f.task.id).state,value=>value.phase==="completed");
    assert.equal(state.instructions[0].result?.changes[0].diff,"+ export const value = 1;");
    assert.equal(f.store.get(f.task.id)?.status,"done");assert.ok(f.store.get(f.task.id)?.completedAt);
  }finally{f.close();}
});

test("caps parallel work, routes live additions through the agent, and keeps per-instruction delivery receipts",async()=>{
  const f=setup();try{
    await f.mode.submit(f.task.id,{clientMessageId:"parallel-request-001",text:"实现两个独立模块",timing:"now"});
    const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    f.manager.complete(planner!,{understanding:"两个模块",workers:[{name:"A",objective:"A",ownedPaths:["src/a.ts"]},{name:"B",objective:"B",ownedPaths:["src/b.ts"]}]});
    await waitFor(()=>f.mode.detail(f.task.id).state.runs.at(-1)!.jobs.filter(job=>job.role==="worker"&&job.status==="active"),jobs=>jobs.length===2);
    await f.mode.submit(f.task.id,{clientMessageId:"parallel-addition-002",text:"A 增加输入校验",timing:"now"});
    const steering=await waitFor(()=>activeJob(f.mode,f.task.id,"steer"),Boolean);
    const target=f.mode.detail(f.task.id).state.runs.at(-1)!.jobs.find(job=>job.role==="worker")!;
    f.manager.complete(steering!,{understanding:"给 A 增加校验",workerIds:[target.id],instructions:"只调整 A 的输入校验"});
    const state=await waitFor(()=>f.mode.detail(f.task.id).state,value=>value.instructions[1].status==="worker_received");
    assert.equal(state.instructions[1].deliveries[0].workerId,target.id);
    const forward=f.manager.calls.find(call=>call.method==="turn/steer"&&call.params.threadId===target.threadId);
    assert.ok(forward);assert.match(forward.params.input[0].text,/A 增加输入校验/);
  }finally{f.close();}
});

test("pause preserves pending instructions; restart and resume do not duplicate completed jobs",async()=>{
  const f=setup();let resumed:TaskModeService|undefined;try{
    await f.mode.submit(f.task.id,{clientMessageId:"pause-request-001",text:"开始执行",timing:"now"});
    const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);
    f.manager.complete(planner!,{understanding:"开始",workers:[{name:"A",objective:"A",ownedPaths:["a.ts"]}]});
    await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);
    await f.mode.action(f.task.id,"pause");
    await f.mode.submit(f.task.id,{clientMessageId:"queued-request-002",text:"暂停期间的新需求",timing:"after"});
    assert.equal(f.mode.detail(f.task.id).state.instructions[1].status,"queued");
    f.mode.close();resumed=new TaskModeService(f.conversations,{pollMs:20});
    assert.equal(resumed.detail(f.task.id).state.phase,"paused");
    await resumed.action(f.task.id,"resume");
    await waitFor(()=>activeJob(resumed!,f.task.id,"worker"),Boolean);
    assert.equal(resumed.detail(f.task.id).state.runs[0].jobs.filter(job=>job.role==="plan").length,1);
    assert.equal(f.manager.calls.filter(call=>call.method==="thread/start").length,2);
  }finally{resumed?.close();f.conversations.close();f.store.close();fs.rmSync(f.directory,{recursive:true,force:true});}
});

test("failed verification continues with a new plan instead of claiming completion",async()=>{
  const f=setup();try{
    await f.mode.submit(f.task.id,{clientMessageId:"failure-request-001",text:"验证失败用例",timing:"now"});
    const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);f.manager.complete(planner!,{understanding:"检查",workers:[{name:"A",objective:"A",ownedPaths:["a.ts"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);f.manager.complete(worker!,{...workerOutput,verification:[{command:"node --test",result:"failed",details:"仍有失败"}]});
    const reviewer=await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);f.manager.complete(reviewer!,{status:"done",summary:"完成",risks:[]});
    const state=await waitFor(()=>f.mode.detail(f.task.id).state,value=>value.phase==="planning"&&Boolean(value.runs.at(-1)?.jobs.some(job=>job.purpose==="continuation_plan")));assert.equal(state.instructions[0].result?.status,"in_progress");assert.equal(f.store.get(f.task.id)?.status,"in_progress");
  }finally{f.close();}
});


test("attachment HTTP contract accepts more than 32/64 files, isolates users and preserves deleted snapshot bytes",async()=>{
  const f=setup(), foreign=setup();let server:Server|undefined;
  try {
    for(const fixture of [f,foreign]){const state=fixture.mode.data.ensure(fixture.task.id);state.phase="paused";fixture.mode.data.save(state);}
    const add=(fixture:ReturnType<typeof setup>,index:number,source:"input"|"feedback")=>{
      const storageName=`${source}-${index}.txt`,content=`${source} bytes ${index}`;
      fs.writeFileSync(fixture.store.attachmentFilePath(fixture.task.id,storageName),content);
      return fixture.store.addAttachment(fixture.task.id,{name:storageName,storageName,mimeType:"text/plain",size:Buffer.byteLength(content),source})!.attachments.at(-1)!;
    };
    fs.mkdirSync(f.store.attachmentDirectory(f.task.id),{recursive:true});
    fs.mkdirSync(foreign.store.attachmentDirectory(foreign.task.id),{recursive:true});
    const inputs=Array.from({length:70},(_,i)=>add(f,i,"input"));
    const feedback=Array.from({length:70},(_,i)=>add(f,i,"feedback"));
    const other=add(foreign,0,"input");
    const app=express();app.use(express.json());app.use((req,res,next)=>{res.locals.user={name:req.headers["x-test-user"]==="foreign"?"foreign":"local",method:"none"};next();});
    app.use("/api/task-mode",createTaskModeRouter(async user=>user.name==="foreign"?foreign.mode:f.mode));
    app.use("/api/tasks",createTaskRouter(async user=>user.name==="foreign"?foreign.store:f.store));
    server=app.listen(0,"127.0.0.1");await new Promise<void>(resolve=>server!.once("listening",resolve));
    const address=server.address();assert.ok(address&&typeof address==="object");const base=`http://127.0.0.1:${address.port}`;
    const submit=(value:Record<string,unknown>,taskId=f.task.id,headers:Record<string,string>={})=>fetch(`${base}/api/task-mode/tasks/${taskId}/instructions`,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify({clientMessageId:crypto.randomUUID(),text:"  原文及换行\n保留  ",timing:"after",...value})});
    for(const count of [0,33,65,70]){
      const response=await submit({attachmentIds:feedback.slice(0,count).map(file=>file.id)});assert.equal(response.status,202);
      const detail=await response.json() as ReturnType<typeof f.mode.detail>;const instruction=detail.state.instructions.at(-1)!;
      assert.equal(instruction.text,"  原文及换行\n保留  ");assert.equal(instruction.snapshot.attachments.length,70+count);
    }
    assert.equal((await submit({referenceTaskIds:Array(33).fill(f.task.id)})).status,400);
    assert.equal((await submit({documentIds:Array(33).fill("missing")})).status,400);
    assert.equal((await submit({attachmentIds:[123]})).status,400);
    assert.equal((await submit({attachmentIds:[other.id]})).status,400);
    assert.equal((await submit({},f.task.id,{"x-test-user":"foreign"})).status,404);
    assert.equal((await fetch(`${base}/api/tasks/${f.task.id}/attachments/${inputs[0].id}`,{method:"DELETE",headers:{"x-test-user":"foreign"}})).status,404);
    const snapshot=f.mode.detail(f.task.id).state.instructions.at(-1)!;
    const snapshotFile=snapshot.snapshot.attachments.find(file=>file.id===feedback[0].id)!;
    assert.equal((await fetch(`${base}/api/tasks/${f.task.id}/attachments/${feedback[0].id}`,{method:"DELETE"})).status,200);
    assert.equal((await fetch(`${base}/api/tasks/${f.task.id}/attachments/${feedback[0].id}/content`)).status,404);
    const bytes=await fetch(`${base}/api/task-mode/tasks/${f.task.id}/instructions/${snapshot.id}/attachments/${feedback[0].id}`);
    assert.equal(bytes.status,200);assert.equal(await bytes.text(),"feedback bytes 0");
    assert.equal(fs.readFileSync(snapshotFile.snapshotPath,"utf8"),"feedback bytes 0");
    assert.equal((await fetch(`${base}/api/tasks/${f.task.id}/attachments/${inputs[0].id}`,{method:"DELETE"})).status,200);
    const inputBytes=await fetch(`${base}/api/task-mode/tasks/${f.task.id}/instructions/${snapshot.id}/attachments/${inputs[0].id}`);
    assert.equal(inputBytes.status,200);assert.equal(await inputBytes.text(),"input bytes 0");
    const persisted=new TaskModeStore(f.store.dbPath);try{assert.equal(persisted.get(f.task.id)!.instructions.at(-1)!.snapshot.attachments.length,140);}finally{persisted.close();}
    assert.equal((await fetch(`${base}/api/tasks/${f.task.id}`).then(response=>response.json()) as {attachments:unknown[]}).attachments.length,138);
    assert.equal((await submit({})).status,202);
    const form=new FormData();form.append("files",new Blob(["uploaded user input"],{type:"text/plain"}),"user.md");
    const uploaded=await fetch(`${base}/api/task-mode/tasks/${f.task.id}/attachments`,{method:"POST",body:form});assert.equal(uploaded.status,201);assert.equal((await uploaded.json() as {attachments:Array<{source:string}>}).attachments[0].source,"input");
    const current=f.store.get(f.task.id)!;
    assert.equal(JSON.parse(fs.readFileSync(path.join(current.contextDirectory,"input-attachments.json"),"utf8")).length,70);
    assert.equal(JSON.parse(fs.readFileSync(path.join(current.contextDirectory,"feedback-artifacts.json"),"utf8")).length,69);
    assert.equal(JSON.parse(fs.readFileSync(path.join(current.contextDirectory,"attachments.json"),"utf8")).length,139);
  } finally {if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));f.close();foreign.close();}
});

test("worker artifact imports are feedback and deleting them suppresses repeated imports and stale report links",async()=>{
  const f=setup();try{
    fs.writeFileSync(path.join(f.directory,"review.md"),"# Feedback evidence");
    await f.mode.submit(f.task.id,{clientMessageId:"feedback-import-001",text:"实施并反馈",timing:"now"});
    const planner=await waitFor(()=>activeJob(f.mode,f.task.id,"plan"),Boolean);f.manager.complete(planner!,{understanding:"附件来源",workers:[{name:"实现",objective:"实施",ownedPaths:["src/"]}]});
    const worker=await waitFor(()=>activeJob(f.mode,f.task.id,"worker"),Boolean);f.manager.complete(worker!,{...workerOutput,artifacts:[{path:"review.md",title:"反馈材料"}]});
    const review=await waitFor(()=>activeJob(f.mode,f.task.id,"review"),Boolean);
    f.manager.complete(review!,decision({status:"done",summary:"实施已通过",acceptanceReady:true,remainingWork:[],agentNextSteps:[]}));
    await waitFor(()=>f.mode.detail(f.task.id).state,state=>state.phase==="needs_confirmation");
    const material=f.store.get(f.task.id)!.attachments[0];assert.equal(material.source,"feedback");
    const paused=f.mode.data.get(f.task.id)!;paused.phase="paused";f.mode.data.save(paused);
    await f.mode.submit(f.task.id,{clientMessageId:"feedback-exclude-002",text:"继续纯文本",timing:"after"});
    assert.equal(f.mode.detail(f.task.id).state.instructions.at(-1)!.snapshot.attachments.length,0);
    const stored=f.store.attachment(f.task.id,material.id)!;f.store.removeAttachment(f.task.id,material.id);fs.unlinkSync(stored.filePath);
    // Exercise the exact importer with a different run identity to guard automatic rediscovery of unchanged material.
    assert.equal((f.mode as any).importArtifact(f.task.id,"different-run","review.md","重复材料"),undefined);
    assert.equal(f.mode.data.get(f.task.id)!.runs[0].result!.artifacts[0].url,material.url);
    const result=f.mode.detail(f.task.id).state.runs[0].result!;assert.equal(result.artifacts[0].deleted,true);assert.equal(result.artifacts[0].url,"");
    const report=f.mode.runReport(f.task.id,f.mode.detail(f.task.id).state.runs[0].id);assert.match(report.markdown,/review\.md（已删除）/);assert.doesNotMatch(report.markdown,/mode=artifact.*attachment=/);
    fs.writeFileSync(path.join(f.directory,"legacy-review.md"),"# Legacy feedback");
    const legacyName=`tm-${"d".repeat(64)}.md`;fs.writeFileSync(f.store.attachmentFilePath(f.task.id,legacyName),"# Legacy feedback");
    const legacy=f.store.addAttachment(f.task.id,{name:"旧反馈",storageName:legacyName,mimeType:"text/markdown",size:17,source:"feedback"})!.attachments[0];
    f.store.removeAttachment(f.task.id,legacy.id);
    assert.equal((f.mode as any).importArtifact(f.task.id,"new-legacy-run","legacy-review.md","旧材料"),undefined);
    const disk=new DatabaseSync(f.store.dbPath);try{assert.equal(disk.prepare("SELECT source FROM task_attachments").all().length,0);assert.equal(disk.prepare("SELECT COUNT(*) AS n FROM task_attachment_tombstones").get()!.n,2);}finally{disk.close();}
  } finally {f.close();}
});
