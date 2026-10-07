import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import type { TaskExecutionJob } from "../../src/shared/taskModeTypes.js";

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
