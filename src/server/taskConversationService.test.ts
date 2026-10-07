import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import express from "express";
import { TaskConversationService, TaskConversationServiceError } from "./tasks/taskConversationService.js";
import { TaskConversationConflictError, TaskStore } from "./tasks/taskStore.js";
import { createTaskConversationRouter } from "./tasks/taskConversationRouter.js";

class FakeManager extends EventEmitter {
  starts=0; calls:Array<{method:string;params:any}>=[]; threads:Array<{id:string;cwd:string}>=[]; listPageSize=100; approvals:any[]=[]; modelList:any[]=[];
  bindThread(){} unbindThread(){}
  pendingApprovals(taskId:string,threadId:string){return this.approvals.filter((entry)=>entry.taskId===taskId&&entry.threadId===threadId);}
  async request(method:string,params:any):Promise<any>{this.calls.push({method,params});if(method==="thread/list"){const matching=this.threads.filter((thread)=>thread.cwd===params.cwd);const offset=params.cursor?Number(params.cursor):0;const data=matching.slice(offset,offset+this.listPageSize);return{data,nextCursor:offset+data.length<matching.length?String(offset+data.length):null};}if(method==="thread/start"){this.starts++;const thread={id:`thread-${this.starts}`,turns:[],cwd:params.cwd,status:{type:"idle"}};this.threads.push({id:thread.id,cwd:thread.cwd});return{thread};}if(method==="thread/read")return{thread:{id:params.threadId,turns:[],cwd:"C:/context",status:{type:"idle"}}};if(method==="turn/start")return{turn:{id:"turn-1",status:"inProgress",items:[]}};return{};}
  async models(){return this.modelList;} resolveApproval(){} close(){}
}

class FailingStartManager extends FakeManager { constructor(private readonly failure:"malformed"|"deterministic"){super();} override async request(method:string,params:any):Promise<any>{if(method==="thread/start"){this.calls.push({method,params});if(this.failure==="malformed")return{thread:{cwd:params.cwd}};throw new Error("authentication rejected");}return super.request(method,params);} }

class FailOnceStartManager extends FakeManager { private failed=false;override async request(method:string,params:any):Promise<any>{if(method==="thread/start"&&!this.failed){this.failed=true;this.calls.push({method,params});throw new Error("authentication rejected");}return super.request(method,params);} }

class DelayedStartManager extends FakeManager {
  release!:()=>void;
  private markStarted!:()=>void;
  readonly started=new Promise<void>((resolve)=>{this.markStarted=resolve;});
  override async request(method:string,params:any):Promise<any>{
    if(method!=="thread/start")return super.request(method,params);
    this.calls.push({method,params});this.starts++;this.markStarted();
    await new Promise<void>((resolve)=>{this.release=resolve;});
    const thread={id:`thread-${this.starts}`,turns:[],cwd:params.cwd,status:{type:"idle"}};
    this.threads.push({id:thread.id,cwd:thread.cwd});return{thread};
  }
}

class InterruptedTurnManager extends FakeManager {
  override async request(method:string,params:any):Promise<any>{
    if(method==="thread/read"){
      this.calls.push({method,params});
      return{thread:{id:params.threadId,turns:[{id:"turn-interrupted",status:"interrupted",items:[]}],cwd:"C:/context",status:{type:"idle"}}};
    }
    return super.request(method,params);
  }
}

test("ensures an existing primary conversation without starting another Codex thread",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-default-existing-"));const store=new TaskStore(directory);const manager=new FakeManager();const service=new TaskConversationService(store,manager as any);
  try{const task=store.create({title:"Existing default",repositoryPath:directory});store.bindConversation(task.id,"existing-thread","Existing",true);const result=await service.ensureDefault(task.id);assert.equal(result.created,false);assert.equal(result.conversation.threadId,"existing-thread");assert.equal(manager.starts,0);assert.equal(manager.calls.some((entry)=>entry.method==="thread/start"),false);}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("ensures one real default conversation in the exact Task context",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-default-create-"));const store=new TaskStore(directory);const manager=new FakeManager();const service=new TaskConversationService(store,manager as any);
  try{const task=store.create({title:"Automatic default",repositoryPath:directory});const result=await service.ensureDefault(task.id);assert.equal(result.created,true);assert.equal(store.listConversationBindings(task.id).length,1);assert.equal(store.listConversationBindings(task.id)[0]?.threadId,result.conversation.threadId);assert.equal(manager.starts,1);assert.equal(manager.calls.find((entry)=>entry.method==="thread/start")?.params.cwd,path.resolve(task.contextDirectory));assert.equal(manager.calls.some((entry)=>entry.method==="turn/start"),false);}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("converges overlapping default ensures across stores without a second thread start",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-default-converge-"));const storeA=new TaskStore(directory);const managerA=new DelayedStartManager();const serviceA=new TaskConversationService(storeA,managerA as any,{convergenceWaitMs:500,convergencePollMs:5});let storeB:TaskStore|undefined;
  try{const task=storeA.create({title:"Convergent default",repositoryPath:directory});const first=serviceA.ensureDefault(task.id);await managerA.started;storeB=new TaskStore(directory);const managerB=new FakeManager();const serviceB=new TaskConversationService(storeB,managerB as any,{convergenceWaitMs:500,convergencePollMs:5});const second=serviceB.ensureDefault(task.id);setTimeout(()=>managerA.release(),20);const [winner,loser]=await Promise.all([first,second]);assert.equal(winner.conversation.threadId,loser.conversation.threadId);assert.equal(managerA.starts,1);assert.equal(managerB.starts,0);assert.equal(loser.created,false);
  }finally{storeB?.close();storeA.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("returns the precise pending contract while a live create guard is held",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-default-pending-"));const store=new TaskStore(directory);const manager=new FakeManager();const service=new TaskConversationService(store,manager as any,{convergenceWaitMs:10,convergencePollMs:2,retryAfterMs:7,staleGuardMs:60_000});
  try{const task=store.create({title:"Pending default",repositoryPath:directory});store.beginConversationCreate({taskId:task.id,clientMessageId:"held-create-0001",requestHash:"held",resolvedCwd:task.contextDirectory});await assert.rejects(()=>service.ensureDefault(task.id),(error)=>error instanceof TaskConversationServiceError&&error.status===503&&error.code==="DEFAULT_CONVERSATION_PENDING"&&error.details.retryAfterMs===7&&JSON.stringify(error.details.allowedActions)===JSON.stringify(["retry","reload"]));assert.equal(manager.starts,0);}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("releases a stale snapshot guard and retries with a fresh server id",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-default-stale-"));const store=new TaskStore(directory);const manager=new FakeManager();const service=new TaskConversationService(store,manager as any,{staleGuardMs:0,convergenceWaitMs:10,convergencePollMs:2});
  try{const task=store.create({title:"Stale default",repositoryPath:directory});store.beginConversationCreate({taskId:task.id,clientMessageId:"stale-create-001",requestHash:"held",resolvedCwd:task.contextDirectory});await new Promise((resolve)=>setTimeout(resolve,2));const result=await service.ensureDefault(task.id);assert.equal(result.created,true);assert.equal(manager.starts,1);const failed=store.beginConversationCreate({taskId:task.id,clientMessageId:"stale-create-001",requestHash:"held",resolvedCwd:task.contextDirectory});assert.equal(failed.duplicate,true);assert.equal(failed.receipt.state,"failed");}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("promotes a stale post-snapshot guard and reconciles the one remote thread",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-default-stale-reconcile-"));const store=new TaskStore(directory);const manager=new FakeManager();const service=new TaskConversationService(store,manager as any,{staleGuardMs:0,convergenceWaitMs:10,convergencePollMs:2});
  try{const task=store.create({title:"Stale reconcile",repositoryPath:directory});const cwd=path.resolve(task.contextDirectory);const reservation=store.beginConversationCreate({taskId:task.id,clientMessageId:"stale-reserved-001",requestHash:"held",resolvedCwd:cwd});store.saveConversationCreateSnapshot(reservation.receipt.operationId,cwd,[]);manager.threads.push({id:"recovered-thread",cwd});await new Promise((resolve)=>setTimeout(resolve,2));const result=await service.ensureDefault(task.id);assert.equal(result.created,false);assert.equal(result.conversation.threadId,"recovered-thread");assert.equal(store.listConversationBindings(task.id).length,1);assert.equal(manager.starts,0);}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("reconciles a stale guard owned by another Task on the same cwd before retrying",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-default-cross-task-stale-"));const store=new TaskStore(directory);const manager=new FakeManager();const service=new TaskConversationService(store,manager as any,{staleGuardMs:0,convergenceWaitMs:10,convergencePollMs:2});
  try{const current=store.create({title:"Current default",repositoryPath:directory});const other=store.create({title:"Other stale default",repositoryPath:directory});const sharedCwd=path.resolve(current.contextDirectory);const reservation=store.beginConversationCreate({taskId:other.id,clientMessageId:"other-stale-0001",requestHash:"held",resolvedCwd:sharedCwd});store.saveConversationCreateSnapshot(reservation.receipt.operationId,sharedCwd,[]);manager.threads.push({id:"other-recovered-thread",cwd:sharedCwd});await new Promise((resolve)=>setTimeout(resolve,2));const result=await service.ensureDefault(current.id);assert.equal(result.created,true);assert.equal(manager.starts,1);assert.equal(store.listConversationBindings(other.id)[0]?.threadId,"other-recovered-thread");assert.equal(store.listConversationBindings(current.id)[0]?.threadId,result.conversation.threadId);assert.notEqual(result.conversation.threadId,"other-recovered-thread");}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("fails default creation without a placeholder and retries with a fresh server id",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-default-retry-"));const store=new TaskStore(directory);const manager=new FailOnceStartManager();const service=new TaskConversationService(store,manager as any);
  try{const task=store.create({title:"Retry default",repositoryPath:directory});await assert.rejects(()=>service.ensureDefault(task.id),/authentication rejected/);assert.equal(store.listConversationBindings(task.id).length,0);const result=await service.ensureDefault(task.id);assert.equal(result.created,true);assert.equal(store.listConversationBindings(task.id).length,1);assert.equal(manager.calls.filter((entry)=>entry.method==="thread/start").length,2);}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("preserves task and conversation facts when default context refresh is unavailable",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-default-context-"));const store=new TaskStore(directory);const manager=new FakeManager();const service=new TaskConversationService(store,manager as any);
  try{const task=store.create({title:"Unavailable context",repositoryPath:directory});const original=store.refreshContext.bind(store);store.refreshContext=(()=>null) as typeof store.refreshContext;await assert.rejects(()=>service.ensureDefault(task.id),(error)=>error instanceof TaskConversationServiceError&&error.status===422&&error.code==="TASK_CONTEXT_UNAVAILABLE");store.refreshContext=original;assert.ok(store.get(task.id));assert.equal(store.listConversationBindings(task.id).length,0);assert.equal(manager.starts,0);await assert.rejects(()=>service.ensureDefault("missing-task"),(error)=>error instanceof TaskConversationServiceError&&error.status===404&&error.code==="TASK_NOT_FOUND");}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("serves the literal default route before the dynamic thread route",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-default-route-"));const store=new TaskStore(directory);const manager=new FakeManager();const service=new TaskConversationService(store,manager as any);let server:Server|undefined;
  try{const task=store.create({title:"Default route",repositoryPath:directory});const app=express();app.use(express.json());app.use((_req,res,next)=>{res.locals.user={name:"test",method:"password"};next();});app.use("/api/tasks/:taskId/conversations",createTaskConversationRouter(async()=>service));server=await new Promise<Server>((resolve,reject)=>{const candidate=app.listen(0,"127.0.0.1",()=>resolve(candidate));candidate.once("error",reject);});const address=server.address();assert.ok(address&&typeof address==="object");const response=await fetch(`http://127.0.0.1:${address.port}/api/tasks/${task.id}/conversations/default`,{method:"POST"});assert.equal(response.status,200);const body=await response.json() as any;assert.equal(body.created,true);assert.equal(body.conversation.threadId,"thread-1");assert.equal(manager.starts,1);
  }finally{if(server)await new Promise<void>((resolve,reject)=>server?.close((error)=>error?reject(error):resolve()));store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("creates idempotently without Terminal and sends from exact Task context with read-only default", async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-conversation-service-"));const store=new TaskStore(directory);const manager=new FakeManager();const service=new TaskConversationService(store,manager as any);
  try{const task=store.create({title:"Direct conversation",repositoryPath:directory});const input={clientMessageId:"create-key-0001",displayName:"Direct"};const first=await service.create(task.id,input);const repeat=await service.create(task.id,input);assert.equal(first.conversation.threadId,repeat.conversation.threadId);assert.equal(manager.starts,1);await service.send(task.id,first.conversation.threadId,{clientMessageId:"send-key-000001",text:"hello",permissionPreset:"read_only"});const call=manager.calls.find((entry)=>entry.method==="turn/start");assert.equal(call?.params.cwd,path.resolve(task.contextDirectory));assert.deepEqual(call?.params.sandboxPolicy,{type:"readOnly",networkAccess:false});assert.deepEqual(call?.params.input,[{type:"text",text:"hello",text_elements:[]}]);assert.equal(manager.calls.some((entry)=>entry.method.includes("terminal")),false);}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("persists Task defaults, requires full-access acknowledgement, and resolves omitted turn settings", async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-conversation-preferences-"));const store=new TaskStore(directory);const manager=new FakeManager();const service=new TaskConversationService(store,manager as any);
  try{const task=store.create({title:"Default settings",repositoryPath:directory});store.bindConversation(task.id,"thread-defaults","Defaults",true);manager.threads.push({id:"thread-defaults",cwd:path.resolve(task.contextDirectory)});
    assert.deepEqual(service.preferences(task.id),{taskId:task.id,defaultModel:null,defaultReasoningEffort:"medium",defaultPermissionPreset:"read_only",revision:0});
    await assert.rejects(()=>service.updatePreferences(task.id,{defaultModel:null,defaultReasoningEffort:"xhigh",defaultPermissionPreset:"full_access",revision:0}),(error)=>error instanceof TaskConversationServiceError&&error.code==="FULL_ACCESS_CONFIRMATION_REQUIRED");
    const saved=await service.updatePreferences(task.id,{defaultModel:null,defaultReasoningEffort:"high",defaultPermissionPreset:"workspace_write",revision:0});assert.equal(saved.revision,1);
    await service.send(task.id,"thread-defaults",{clientMessageId:"defaults-send-0001",text:"use saved defaults"});const call=manager.calls.find((entry)=>entry.method==="turn/start");assert.equal(call?.params.effort,"high");assert.equal(call?.params.approvalPolicy,"on-request");assert.equal(call?.params.sandboxPolicy.type,"workspaceWrite");assert.ok(call?.params.sandboxPolicy.writableRoots.includes(path.resolve(task.contextDirectory)));
    const changed=await service.updatePreferences(task.id,{defaultModel:null,defaultReasoningEffort:"low",defaultPermissionPreset:"read_only",revision:saved.revision});assert.equal(changed.revision,2);
    await assert.rejects(()=>service.send(task.id,"thread-defaults",{clientMessageId:"defaults-send-0001",text:"use saved defaults"}),(error)=>error instanceof TaskConversationServiceError&&error.code==="IDEMPOTENCY_KEY_REUSED");assert.equal(manager.calls.filter((entry)=>entry.method==="turn/start").length,1);
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("validates model reasoning compatibility and resolves the saved model for create and send", async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-conversation-model-default-"));const store=new TaskStore(directory);const manager=new FakeManager();manager.modelList=[{id:"fake-codex",displayName:"Fake Codex",isDefault:true,efforts:["minimal","low","medium","high"],defaultEffort:"medium"}];const service=new TaskConversationService(store,manager as any);
  try{const task=store.create({title:"Model defaults",repositoryPath:directory});
    const saved=await service.updatePreferences(task.id,{defaultModel:"fake-codex",defaultReasoningEffort:"high",defaultPermissionPreset:"read_only",revision:0});assert.equal(saved.revision,1);assert.equal(saved.defaultModel,"fake-codex");
    await assert.rejects(()=>service.updatePreferences(task.id,{defaultModel:"fake-codex",defaultReasoningEffort:"xhigh",defaultPermissionPreset:"read_only",revision:1}),(error)=>error instanceof TaskConversationServiceError&&error.status===400&&error.code==="MODEL_EFFORT_NOT_SUPPORTED");assert.equal(service.preferences(task.id).revision,1);
    const created=await service.create(task.id,{clientMessageId:"model-create-0001"});const createCall=manager.calls.find((entry)=>entry.method==="thread/start");assert.equal(createCall?.params.model,"fake-codex");
    await service.send(task.id,created.conversation.threadId,{clientMessageId:"model-send-00001",text:"use model default"});const sendCall=manager.calls.find((entry)=>entry.method==="turn/start");assert.equal(sendCall?.params.model,"fake-codex");assert.equal(sendCall?.params.effort,"high");
    await assert.rejects(()=>service.updatePreferences(task.id,{defaultModel:"missing-codex",defaultReasoningEffort:"high",defaultPermissionPreset:"read_only",revision:1}),(error)=>error instanceof TaskConversationServiceError&&error.code==="MODEL_NOT_AVAILABLE");assert.equal(service.preferences(task.id).revision,1);
  }finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("serves the literal preferences route before the dynamic thread route", async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-conversation-preferences-route-"));const store=new TaskStore(directory);const manager=new FakeManager();const service=new TaskConversationService(store,manager as any);let server:Server|undefined;
  try{const task=store.create({title:"Preferences route"});const app=express();app.use(express.json());app.use((_req,res,next)=>{res.locals.user={name:"test",method:"password"};next();});app.use("/api/tasks/:taskId/conversations",createTaskConversationRouter(async()=>service));server=await new Promise<Server>((resolve,reject)=>{const candidate=app.listen(0,"127.0.0.1",()=>resolve(candidate));candidate.once("error",reject);});const address=server.address();assert.ok(address&&typeof address==="object");const root=`http://127.0.0.1:${address.port}/api/tasks/${task.id}/conversations/preferences`;
    const getResponse=await fetch(root);assert.equal(getResponse.status,200);assert.equal((await getResponse.json() as any).defaultPermissionPreset,"read_only");
    const denied=await fetch(root,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({defaultReasoningEffort:"high",defaultPermissionPreset:"full_access",revision:0})});assert.equal(denied.status,400);assert.equal((await denied.json() as any).error.code,"FULL_ACCESS_CONFIRMATION_REQUIRED");assert.equal(service.preferences(task.id).revision,0);
  }finally{if(server)await new Promise<void>((resolve,reject)=>server?.close((error)=>error?reject(error):resolve()));store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("serializes create recovery by user data root and cwd and snapshots every thread-list page",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-conversation-create-guard-"));const store=new TaskStore(directory);const manager=new FakeManager();manager.listPageSize=1;const service=new TaskConversationService(store,manager as any);
  try{const task=store.create({title:"Guarded create",repositoryPath:directory});manager.threads.push({id:"old-a",cwd:path.resolve(task.contextDirectory)},{id:"old-b",cwd:path.resolve(task.contextDirectory)});const reserved=store.beginConversationCreate({taskId:task.id,clientMessageId:"guard-key-0001",requestHash:"hash-a",resolvedCwd:task.contextDirectory});assert.equal(reserved.snapshotRequired,true);assert.throws(()=>store.beginConversationCreate({taskId:task.id,clientMessageId:"guard-key-0002",requestHash:"hash-b",resolvedCwd:task.contextDirectory}),(error)=>error instanceof TaskConversationConflictError&&error.code==="CREATE_CONFLICT"&&error.details.operationId===reserved.receipt.operationId);store.failConversationRequest(reserved.receipt.operationId,false,"CREATE_NOT_APPLIED");const created=await service.create(task.id,{clientMessageId:"guard-key-0003",displayName:"Paged"});assert.equal(created.conversation.threadId,"thread-1");const listCalls=manager.calls.filter((entry)=>entry.method==="thread/list");assert.equal(listCalls.length,2);assert.deepEqual(listCalls.map((entry)=>entry.params.cursor),[null,"1"]);assert.equal(manager.starts,1);}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("reconciles a lost second create by the persisted prior-thread set without binding an older thread",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-conversation-create-recovery-"));const store=new TaskStore(directory);const manager=new FakeManager();const service=new TaskConversationService(store,manager as any);
  try{const task=store.create({title:"Recover create",repositoryPath:directory});const cwd=path.resolve(task.contextDirectory);manager.threads.push({id:"old-thread",cwd});const reservation=store.beginConversationCreate({taskId:task.id,clientMessageId:"recover-key-001",requestHash:"hash",resolvedCwd:cwd});store.saveConversationCreateSnapshot(reservation.receipt.operationId,cwd,["old-thread"]);manager.threads.push({id:"new-thread",cwd});store.failConversationRequest(reservation.receipt.operationId,true,"CREATE_OUTCOME_UNKNOWN");await service.reconcile(task.id);assert.equal(store.getConversationBinding(task.id,"new-thread")?.threadId,"new-thread");assert.equal(store.getConversationBinding(task.id,"old-thread"),null);const retry=store.beginConversationCreate({taskId:task.id,clientMessageId:"recover-key-001",requestHash:"hash",resolvedCwd:cwd});assert.equal(retry.duplicate,true);assert.equal(retry.receipt.state,"completed");assert.equal(retry.receipt.threadId,"new-thread");}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("caches projected history pages and invalidates before a new turn",async()=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-conversation-cache-"));const store=new TaskStore(directory);const manager=new FakeManager();const service=new TaskConversationService(store,manager as any);try{const task=store.create({title:"Warm history",repositoryPath:directory});store.bindConversation(task.id,"thread-cache","Cached",true);manager.threads.push({id:"thread-cache",cwd:path.resolve(task.contextDirectory)});await service.read(task.id,"thread-cache",50);await service.read(task.id,"thread-cache",50);assert.equal(manager.calls.filter((entry)=>entry.method==="thread/read").length,1);await service.send(task.id,"thread-cache",{clientMessageId:"cache-send-0001",text:"refresh",permissionPreset:"read_only"});await service.read(task.id,"thread-cache",50);assert.equal(manager.calls.filter((entry)=>entry.method==="thread/read").length,2);}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}});

test("overlays durable active lease and pending approvals on a warm projection",async()=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-conversation-overlay-"));const store=new TaskStore(directory);const manager=new FakeManager();const service=new TaskConversationService(store,manager as any);try{const task=store.create({title:"Live overlay",repositoryPath:directory});store.bindConversation(task.id,"thread-live","Live",true);manager.threads.push({id:"thread-live",cwd:path.resolve(task.contextDirectory)});await service.read(task.id,"thread-live",50);const reservation=store.reserveConversationRequestAndLease({taskId:task.id,threadId:"thread-live",operation:"send",clientMessageId:"overlay-send-0001",requestHash:"hash",ownerInstanceId:service.instanceId});store.markConversationRequestSubmitted(reservation.receipt.operationId,"turn-live");manager.approvals=[{token:"approval-token",kind:"command",taskId:task.id,threadId:"thread-live",turnId:"turn-live",itemId:"item-live",requestedAt:"2026-01-01T00:00:00Z",expiresAt:"2099-01-01T00:00:00Z",source:"codex_app_server",decisions:["accept","decline"]}];const page=await service.read(task.id,"thread-live",50);assert.equal(page.detail.conversation.status,"active");assert.equal(page.detail.conversation.activeTurnId,"turn-live");assert.equal(page.approvals[0]?.token,"approval-token");assert.equal(manager.calls.filter((entry)=>entry.method==="thread/read").length,1);}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}});

test("releases a stale active lease when canonical history says the turn was interrupted",async()=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),"task-conversation-interrupted-"));const store=new TaskStore(directory);const manager=new InterruptedTurnManager();const service=new TaskConversationService(store,manager as any);try{const task=store.create({title:"Interrupted continuation",repositoryPath:directory});store.bindConversation(task.id,"thread-interrupted","Interrupted",true);const reservation=store.reserveConversationRequestAndLease({taskId:task.id,threadId:"thread-interrupted",operation:"send",clientMessageId:"interrupted-send-0001",requestHash:"hash",ownerInstanceId:service.instanceId});store.markConversationRequestSubmitted(reservation.receipt.operationId,"turn-interrupted");const page=await service.read(task.id,"thread-interrupted",50);assert.equal(page.detail.turns[0]?.status,"interrupted");assert.equal(page.detail.conversation.status,"idle");assert.equal(page.detail.conversation.activeTurnId,undefined);assert.equal(store.getActiveConversationLease(task.id,"thread-interrupted"),null);await service.send(task.id,"thread-interrupted",{clientMessageId:"interrupted-send-0002",text:"继续"});assert.equal(manager.calls.filter((entry)=>entry.method==="turn/start").length,1);}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}});

for(const failure of ["malformed","deterministic"] as const)test(`releases the create guard after a ${failure} thread-start failure`,async()=>{const directory=fs.mkdtempSync(path.join(os.tmpdir(),`task-conversation-${failure}-`));const store=new TaskStore(directory);const manager=new FailingStartManager(failure);const service=new TaskConversationService(store,manager as any);try{const task=store.create({title:"Fail closed",repositoryPath:directory});await assert.rejects(()=>service.create(task.id,{clientMessageId:`${failure}-key-0001`}),failure==="malformed"?/thread id/:/authentication rejected/);assert.doesNotThrow(()=>store.beginConversationCreate({taskId:task.id,clientMessageId:`${failure}-key-0002`,requestHash:"new",resolvedCwd:task.contextDirectory}));}finally{store.close();fs.rmSync(directory,{recursive:true,force:true});}});
