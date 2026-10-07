import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "./tasks/taskStore.js";
import { TaskConversationService } from "./tasks/taskConversationService.js";
import { TaskModeService, validateSettings } from "./tasks/taskModeService.js";
import { DEFAULT_TASK_MODE_SETTINGS, type TaskExecutionJob } from "../shared/taskModeTypes.js";
import type { CodexConversationManager } from "./codexConversationManager.js";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
/** Protocol fixture, not an LLM: real filesystem/child-process execution only after actual turn/start permission. */
export class ControlledExecutor extends EventEmitter {
  threads=new Map<string,any>(); calls:Array<{method:string;params:any}>=[]; sequence=0; taskId="";
  autoExecute=false; approvals:any[]=[];
  bindThread(){} unbindThread(){} close(){} pendingApprovals(){return this.approvals;}
  async models(){return [{id:"gpt-6.1-sol",displayName:"GPT-6.1 Sol",isDefault:true,efforts:["medium"],defaultEffort:"medium"}];}
  async request(method:string,params:any):Promise<any>{
    this.calls.push({method,params:structuredClone(params)});
    if(method==="thread/list")return {data:[...this.threads.values()].filter(thread=>thread.cwd===params.cwd).map(thread=>({id:thread.id})),nextCursor:null};
    if(method==="thread/start"){const thread={id:`thread-${++this.sequence}`,cwd:params.cwd,status:{type:"idle"},turns:[]};this.threads.set(thread.id,thread);return {thread};}
    if(method==="thread/read")return {thread:structuredClone(this.threads.get(params.threadId))};
    if(method==="turn/start"){
      const thread=this.threads.get(params.threadId),turn={id:`turn-${++this.sequence}`,status:"inProgress",items:[{id:`user-${this.sequence}`,type:"userMessage",clientId:params.clientUserMessageId,content:params.input}]};thread.turns.push(turn);
      if(this.autoExecute)setTimeout(()=>this.execute(params,turn),30);
      return {turn};
    }
    if(method==="turn/interrupt"){const turn=this.threads.get(params.threadId).turns.find((turn:any)=>turn.id===params.turnId);turn.status="interrupted";return {};}
    return {};
  }
  execute(params:any,turn:any){
    assert.equal(params.sandboxPolicy.type,"workspaceWrite");
    assert.ok(params.sandboxPolicy.writableRoots.includes(params.cwd));
    assert.equal(params.model,"gpt-6.1-sol");
    assert.ok(params.outputSchema.properties.changedFiles&&params.outputSchema.properties.acceptanceReady);
    const filename=path.join(params.cwd,"quick-result.cjs");
    assert.equal(fs.existsSync(filename),false,"must be a real execution, not a prewritten candidate");
    const source="module.exports = 42;\n";
    const writeCode="require('node:fs').writeFileSync(process.argv[1], process.argv[2], {flag:'wx'})";
    const write=spawnSync(process.execPath,["-e",writeCode,filename,source],{cwd:params.cwd,encoding:"utf8"});assert.equal(write.status,0,write.stderr);
    const verifyCode="require('node:assert/strict').equal(require('./quick-result.cjs'),42);console.log('quick result = 42')";
    const check=spawnSync(process.execPath,["-e",verifyCode],{cwd:params.cwd,encoding:"utf8"});assert.equal(check.status,0,check.stderr);
    const command=`node -e ${JSON.stringify(verifyCode)}`;
    fs.writeFileSync(path.join(params.cwd,"execution-review.md"),`# 直接执行结果\n\n实际由子进程创建 quick-result.cjs；值为42。\n\n验证：${command}\n\n退出码：${check.status}\n\n${check.stdout}`);
    turn.items.push({id:`change-${++this.sequence}`,type:"fileChange",status:"completed",changes:[{path:filename,diff:"+module.exports = 42;"}]},{id:`command-${++this.sequence}`,type:"commandExecution",command,cwd:params.cwd,status:"completed",aggregatedOutput:check.stdout,exitCode:check.status});
    this.complete({threadId:params.threadId,turnId:turn.id},directOutput({changedFiles:[filename],verification:[{command,result:"passed",details:check.stdout}],artifacts:[{path:"execution-review.md",title:"真实执行验证"}]}));
  }
  complete(job:Pick<TaskExecutionJob,"threadId"|"turnId">,output:unknown){const turn=this.threads.get(job.threadId!).turns.find((turn:any)=>turn.id===job.turnId);assert.equal(turn.status,"inProgress");turn.status="completed";turn.items.push({id:`assistant-${++this.sequence}`,type:"agentMessage",phase:"final",text:typeof output==="string"?output:JSON.stringify(output)});this.emit("event",{kind:"turn_completed",threadId:job.threadId,turnId:job.turnId,taskId:this.taskId,payload:{turn}});}
}
export function directOutput(overrides:Record<string,unknown>={}){return {status:"done",summary:"消息代理已直接完成代码更改与验证",changedFiles:[],verification:[{command:"node --test",result:"passed",details:"fixture"}],risks:[],blockers:[],artifacts:[],stopReason:"",humanActions:[],agentNextSteps:[],acceptanceReady:true,pauseCategory:"none",remainingWork:[],instructionReplies:[],...overrides};}


function setup(){const directory=fs.mkdtempSync(path.join(os.tmpdir(),"apron-quick-"));const store=new TaskStore(directory),task=store.create({title:"Quick",repositoryPath:directory,descriptionMd:"直接执行",maxConcurrency:1});const manager=new ControlledExecutor();manager.taskId=task.id;const conversations=new TaskConversationService(store,manager as unknown as CodexConversationManager),mode=new TaskModeService(conversations,{pollMs:15,recoveryBaseMs:5,maxRecoveryAttempts:1});return {directory,store,task,manager,conversations,mode,close(){mode.close();conversations.close();store.close();fs.rmSync(directory,{recursive:true,force:true});}};}
async function wait<T>(get:()=>T,ok:(value:T)=>boolean){const deadline=Date.now()+7000;while(true){const value=get();if(ok(value))return value;if(Date.now()>deadline)throw new Error(`Timeout ${JSON.stringify(value)}`);await new Promise(resolve=>setTimeout(resolve,10));}}
const active=(f:ReturnType<typeof setup>)=>f.mode.detail(f.task.id).state.runs.at(-1)?.jobs.find(job=>job.role==="execute"&&job.status==="active");
const submit=(f:ReturnType<typeof setup>)=>f.mode.submit(f.task.id,{clientMessageId:"quick-first-message",text:"直接修改验证",timing:"now"});
async function quick(f:ReturnType<typeof setup>,overrides={}){await f.mode.settings({...DEFAULT_TASK_MODE_SETTINGS,executionMode:"quick",reviewPolicy:"agent",...overrides},f.task.id);}
const noWorkers=(f:ReturnType<typeof setup>)=>assert.ok(f.mode.detail(f.task.id).state.runs.every(run=>run.jobs.every(job=>!["worker","plan","steer"].includes(job.role))));

test("legacy defaults still plan Workers; invalid mode and unconfirmed full access are rejected",async()=>{const f=setup();try{assert.equal(validateSettings({}).executionMode,"collaborative");assert.throws(()=>validateSettings({executionMode:"fast"}));await assert.rejects(quick(f,{permissionPreset:"full_access"}),/确认/);await submit(f);const plan=await wait(()=>f.mode.detail(f.task.id).state.runs[0]?.jobs[0],job=>job?.status==="active");assert.ok(plan);assert.equal(plan.role,"plan");f.manager.complete(plan,{understanding:"实施",workers:[{name:"实施",objective:"改动",ownedPaths:["a.ts"]}]});await wait(()=>f.mode.detail(f.task.id).state.runs[0].jobs.some(job=>job.role==="worker"&&job.status==="active"),Boolean);}finally{f.close();}});

test("quick dispatches agent with configured permissions, immutable settings, and no worker receipts",async()=>{const f=setup();try{await quick(f,{workerModel:"unavailable-worker",agentPrompt:"自定义：不能删除文件",approvalsReviewer:"user"});await submit(f);const job=await wait(()=>active(f),Boolean);const turn=f.manager.calls.find(call=>call.method==="turn/start")!;assert.equal(turn.params.sandboxPolicy.type,"workspaceWrite");assert.equal(turn.params.approvalsReviewer,"user");assert.equal(turn.params.model,DEFAULT_TASK_MODE_SETTINGS.agentModel);assert.equal(f.store.get(f.task.id)!.maxConcurrency,1);assert.match(f.manager.calls.find(call=>call.method==="thread/resume")!.params.developerInstructions,/自定义：不能删除文件/);await f.mode.settings({...DEFAULT_TASK_MODE_SETTINGS,executionMode:"collaborative",permissionPreset:"read_only"},f.task.id);f.manager.complete(job!,directOutput({status:"continue",acceptanceReady:false,remainingWork:["剩余验证"],agentNextSteps:["直接验证"]}));const next=await wait(()=>active(f),job2=>!!job2&&job2.id!==job!.id);assert.equal(next!.threadId,job!.threadId);assert.equal(f.manager.calls.filter(call=>call.method==="turn/start").at(-1)!.params.approvalsReviewer,"user");assert.equal(f.manager.calls.filter(call=>call.method==="turn/start").at(-1)!.params.sandboxPolicy.type,"workspaceWrite");f.manager.complete(next!,directOutput());await wait(()=>f.mode.detail(f.task.id).state.phase,value=>value==="completed");assert.equal(f.mode.detail(f.task.id).state.instructions[0].deliveries.length,0);assert.equal(f.mode.detail(f.task.id).state.instructions[0].workerReceivedAt,undefined);noWorkers(f);}finally{f.close();}});

test("quick respects read only; additional instructions and reply-only stay on the same executor",async()=>{const f=setup();try{await quick(f,{permissionPreset:"read_only"});await submit(f);const job=await wait(()=>active(f),Boolean);assert.equal(f.manager.calls.find(call=>call.method==="turn/start")!.params.sandboxPolicy.type,"readOnly");for(const [clientMessageId,text] of [["quick-extra-implementation","还需要验证导出"],["quick-progress-question","现在进度如何"]])await f.mode.submit(f.task.id,{clientMessageId,text,timing:"now"});await wait(()=>f.manager.calls.filter(call=>call.method==="turn/steer").length,value=>value===2);const question=f.mode.detail(f.task.id).state.instructions[2];f.manager.complete(job!,directOutput({instructionReplies:[{instructionId:question.id,replyOnly:true,userUpdate:"验证中"}]}));const state=await wait(()=>f.mode.detail(f.task.id).state,value=>value.phase==="completed");assert.equal(state.instructions[2].replyOnly,true);assert.equal(state.instructions[2].result,undefined);assert.equal(state.instructions[2].agentReply,"验证中");assert.equal(state.runs[0].instructionIds.length,2);assert.equal(f.manager.calls.filter(call=>call.method==="turn/start").length,1);noWorkers(f);}finally{f.close();}});

test("pause/resume and restart consume completed output without repeating execution",async()=>{const f=setup();let restarted:TaskModeService|undefined;try{await quick(f);await submit(f);const job=await wait(()=>active(f),Boolean);await f.mode.action(f.task.id,"pause");await f.mode.action(f.task.id,"resume");const next=await wait(()=>active(f),j=>!!j&&j.turnId!==job!.turnId);assert.equal(next!.threadId,job!.threadId);assert.match(next!.text,/避免重复副作用/);await f.mode.action(f.task.id,"pause");const turn=f.manager.threads.get(next!.threadId!).turns.find((turn:any)=>turn.id===next!.turnId);turn.status="inProgress";f.manager.complete(next!,directOutput());const count=f.manager.calls.filter(call=>call.method==="turn/start").length;f.mode.close();restarted=new TaskModeService(f.conversations,{pollMs:15});await restarted.action(f.task.id,"resume");await wait(()=>restarted!.detail(f.task.id).state.phase,value=>value==="completed");assert.equal(f.manager.calls.filter(call=>call.method==="turn/start").length,count);assert.equal(restarted.detail(f.task.id).state.runs[0].jobs.filter(job=>job.role==="worker").length,0);}finally{restarted?.close();f.close();}});

test("failed verification cannot complete; continuation remains direct",async()=>{const f=setup();try{await quick(f);await submit(f);const job=await wait(()=>active(f),Boolean);f.manager.complete(job!,directOutput({verification:[{command:"node --test",result:"failed",details:"actual failure"}]}));const next=await wait(()=>active(f),j=>!!j&&j.id!==job!.id);assert.equal(f.mode.detail(f.task.id).state.runs[0].result,undefined);assert.equal(f.mode.detail(f.task.id).state.instructions[0].result!.acceptanceReady,false);f.manager.complete(next!,directOutput({status:"blocked",acceptanceReady:false,pauseCategory:"blocked",stopReason:"缺少外部条件",humanActions:[{action:"提供缺失输入",reason:"缺少输入",unblocks:"恢复验证"}],remainingWork:["验证"]}));await wait(()=>f.mode.detail(f.task.id).state.phase,value=>value==="blocked");noWorkers(f);}finally{f.close();}});

test("reread quick output never starts another turn; final artifacts, commands and diffs are persisted",async()=>{const f=setup();try{await quick(f);await submit(f);const job=await wait(()=>active(f),Boolean);f.manager.complete(job!,"malformed output");await wait(()=>f.mode.detail(f.task.id).state.phase,value=>value==="blocked");const turn=f.manager.threads.get(job!.threadId!).turns.find((turn:any)=>turn.id===job!.turnId);turn.items.at(-1).text=JSON.stringify(directOutput());const count=f.manager.calls.filter(call=>call.method==="turn/start").length;await f.mode.action(f.task.id,"reread_output");await wait(()=>f.mode.detail(f.task.id).state.phase,value=>value==="completed");assert.equal(f.manager.calls.filter(call=>call.method==="turn/start").length,count);noWorkers(f);}finally{f.close();}});

test("real controlled executor receives scheduler permissions, creates code and runs verification",async()=>{const f=setup();try{await quick(f,{reviewPolicy:"artifacts"});f.manager.autoExecute=true;await submit(f);const state=await wait(()=>f.mode.detail(f.task.id).state,value=>value.phase==="needs_confirmation");assert.equal(fs.readFileSync(path.join(f.directory,"quick-result.cjs"),"utf8"),"module.exports = 42;\n");const result=state.runs[0].result!;assert.equal(result.artifacts.length,1);assert.equal(result.verification[0].result,"passed");assert.equal(result.changes.length,1);assert.ok(state.runs[0].jobs[0].items.some(item=>item.kind==="command"&&item.exitCode===0));await f.mode.action(f.task.id,"approve");assert.equal(f.mode.detail(f.task.id).state.phase,"completed");assert.match(f.mode.runReport(f.task.id,state.runs[0].id).markdown,/直接执行/);noWorkers(f);}finally{f.close();}});

test("mode transitions replace the agent thread; quick report clarification stays read only",async()=>{const f=setup();try{
  await quick(f);await submit(f);const direct=await wait(()=>active(f),Boolean);f.manager.complete(direct!,directOutput());await wait(()=>f.mode.detail(f.task.id).state.phase,value=>value==="completed");
  await f.mode.action(f.task.id,"clarify_report");const review=await wait(()=>f.mode.detail(f.task.id).state.runs[0].jobs.find(job=>job.role==="review"&&job.status==="active"),Boolean);assert.equal(review!.threadId,direct!.threadId);assert.equal(f.manager.calls.filter(call=>call.method==="turn/start").at(-1)!.params.sandboxPolicy.type,"readOnly");f.manager.complete(review!,{status:"done",summary:"补充真实结果",risks:[],stopReason:"",humanActions:[],agentNextSteps:[]});await wait(()=>f.mode.detail(f.task.id).state.phase,value=>value==="completed");noWorkers(f);
  await f.mode.settings({...DEFAULT_TASK_MODE_SETTINGS,reviewPolicy:"agent"},f.task.id);await f.mode.submit(f.task.id,{clientMessageId:"switch-to-collaboration",text:"下一轮协作实施",timing:"now"});const plan=await wait(()=>f.mode.detail(f.task.id).state.runs.at(-1)?.jobs[0],job=>!!job&&job.status==="active");assert.ok(plan);assert.equal(plan.role,"plan");assert.notEqual(plan.threadId,direct!.threadId);assert.match(f.manager.calls.filter(call=>call.method==="thread/resume").at(-1)!.params.developerInstructions,/你不直接实现/);
}finally{f.close();}});

test("quick command failure contradicting a success report cannot complete and repeated material is deduplicated",async()=>{const f=setup();try{
  await quick(f);await submit(f);const direct=await wait(()=>active(f),Boolean);const turn=f.manager.threads.get(direct!.threadId!).turns.find((turn:any)=>turn.id===direct!.turnId);turn.items.push({id:"failed-command",type:"commandExecution",command:"node --test",cwd:f.directory,status:"completed",exitCode:1,aggregatedOutput:"failure"});
  fs.writeFileSync(path.join(f.directory,"material.md"),"# immutable report");const artifacts=[{path:"material.md",title:"重复材料"}];f.manager.complete(direct!,directOutput({artifacts}));const next=await wait(()=>active(f),j=>!!j&&j.id!==direct!.id);assert.equal(f.mode.detail(f.task.id).state.instructions[0].result!.acceptanceReady,false);f.manager.complete(next!,directOutput({artifacts}));const state=await wait(()=>f.mode.detail(f.task.id).state,value=>value.phase==="completed");assert.equal(f.store.get(f.task.id)!.attachments.length,1);assert.equal(state.runs[0].result!.artifacts.length,1);noWorkers(f);
}finally{f.close();}});

test("quick cannot finish while an earlier failed required check remains unresolved",async()=>{const f=setup();try{
  await quick(f);await submit(f);const first=await wait(()=>active(f),Boolean);f.manager.complete(first!,directOutput({verification:[{command:"required-check",result:"failed",details:"initial failure"}]}));
  const second=await wait(()=>active(f),job=>!!job&&job.id!==first!.id);f.manager.complete(second!,directOutput({verification:[{command:"unrelated-check",result:"passed",details:"does not repair required check"}]}));
  const third=await wait(()=>active(f),job=>!!job&&job.id!==second!.id);assert.equal(f.mode.detail(f.task.id).state.instructions[0].result!.verification.find(check=>check.command==="required-check")!.result,"failed");
  f.manager.complete(third!,directOutput({verification:[{command:"required-check",result:"passed",details:"fixed and rerun"}]}));const state=await wait(()=>f.mode.detail(f.task.id).state,value=>value.phase==="completed");assert.ok(state.runs[0].result!.verification.every(check=>check.result==="passed"));noWorkers(f);
}finally{f.close();}});
