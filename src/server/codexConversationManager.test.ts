import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CodexConversationManager } from "./codexConversationManager.js";

class FakeClient extends EventEmitter {
  currentGeneration=1; replies:unknown[]=[];
  async request(){return{};} close(){}
  approval(method="item/commandExecution/requestApproval"){
    const request={id:"approval-1",method,params:{threadId:"thread-1",turnId:"turn-1",itemId:"item-1",command:["pwd"],cwd:"C:/task",paths:["src/a.ts"],reason:"test"},reply:(value:unknown)=>this.replies.push(value),reject:(code:number,message:string)=>this.replies.push({code,message})};
    this.emit("serverRequest",request);return request;
  }
  delta(index:number){this.emit("notification",{method:"item/plan/delta",params:{threadId:"thread-1",turnId:"turn-1",itemId:"item-1",delta:`${index}`},generation:this.currentGeneration});}
}

test("native context compaction lifecycle is projected as explicit progress and completion",()=>{
  const client=new FakeClient(),manager=new CodexConversationManager(client as any);manager.bindThread("task-1","thread-1");
  try{
    for(const method of ["item/started","item/completed"])client.emit("notification",{method,params:{threadId:"thread-1",turnId:"turn-1",item:{id:"compact-1",type:"contextCompaction"}},generation:1});
    const events=manager.eventsAfter(0,"task-1").events;
    assert.equal((events[0].payload.item as any).status,"in_progress");assert.match((events[0].payload.item as any).label,/正在自动压缩/);
    assert.equal((events[1].payload.item as any).status,"completed");assert.match((events[1].payload.item as any).label,/压缩已完成/);
  }finally{manager.close();}
});

test("projects scoped one-shot command approvals and maps accept-for-session exactly",()=>{
  const client=new FakeClient();const manager=new CodexConversationManager(client as any,{approvalTtlMs:1000});const events:any[]=[];manager.bindThread("task-1","thread-1");manager.on("event",(event)=>events.push(event));client.approval();const approval=events.find((event)=>event.kind==="approval_requested").payload;assert.equal(approval.command.display,"pwd");assert.equal(approval.command.cwd,"C:/task");assert.equal(approval.token.length>=40,true);manager.resolveApproval(approval.token,"task-1","thread-1","accept_for_session");assert.deepEqual(client.replies,[{decision:"acceptForSession"}]);assert.throws(()=>manager.resolveApproval(approval.token,"task-1","thread-1","accept"));manager.close();
});

test("lists pending approvals only for the requested task and thread",()=>{const client=new FakeClient();const manager=new CodexConversationManager(client as any);manager.bindThread("task-1","thread-1");manager.bindThread("task-2","thread-2");client.approval();client.emit("serverRequest",{method:"item/commandExecution/requestApproval",params:{threadId:"thread-2",turnId:"turn-2",itemId:"item-2",command:["pwd"]},generation:client.currentGeneration,reply:()=>undefined,reject:()=>undefined});assert.equal(manager.pendingApprovals("task-1","thread-1").length,1);assert.equal(manager.pendingApprovals("task-1","thread-2").length,0);manager.close();});

test("expires approvals once and refuses stale tokens after manager generation changes",async()=>{
  const client=new FakeClient();const manager=new CodexConversationManager(client as any,{approvalTtlMs:10});const events:any[]=[];manager.bindThread("task-1","thread-1");manager.on("event",(event)=>events.push(event));client.approval("item/fileChange/requestApproval");const approval=events.find((event)=>event.kind==="approval_requested").payload;assert.deepEqual(approval.fileChange.paths,["src/a.ts"]);await new Promise((resolve)=>setTimeout(resolve,25));assert.deepEqual(client.replies,[{decision:"cancel"}]);assert.equal(events.filter((event)=>event.kind==="approval_resolved"&&event.payload.resolution==="expired").length,1);assert.throws(()=>manager.resolveApproval(approval.token,"task-1","thread-1","accept"));client.approval();const second=events.filter((event)=>event.kind==="approval_requested").at(-1).payload;client.currentGeneration=2;assert.throws(()=>manager.resolveApproval(second.token,"task-1","thread-1","accept"));assert.deepEqual(client.replies,[{decision:"cancel"}]);manager.close();
});

test("reports an SSE replay gap after the bounded event ring overflows",()=>{
  const client=new FakeClient();const manager=new CodexConversationManager(client as any,{eventRingLimit:3});manager.bindThread("task-1","thread-1");for(let index=0;index<5;index+=1)client.delta(index);const replay=manager.eventsAfter(1,"task-1");assert.equal(replay.gap,true);assert.deepEqual(replay.events.map((event)=>event.sequence),[3,4,5]);manager.close();
});

test("keeps native auto-review warnings visible in the task event stream",()=>{
  const client=new FakeClient();const manager=new CodexConversationManager(client as any);
  manager.bindThread("task-1","thread-1");
  client.emit("notification",{method:"guardianWarning",params:{threadId:"thread-1",message:"Automatic reviewer unavailable"},generation:1});
  const event=manager.eventsAfter(0,"task-1").events[0];
  assert.equal(event.kind,"warning");
  assert.deepEqual(event.payload,{code:"CODEX_AUTO_REVIEW_WARNING",message:"Automatic reviewer unavailable"});
  manager.close();
});

test("streams only numeric cumulative token fields for the bound task",()=>{
  const client=new FakeClient();const manager=new CodexConversationManager(client as any);manager.bindThread("task-1","thread-1");
  client.emit("notification",{method:"thread/tokenUsage/updated",params:{threadId:"thread-1",turnId:"turn-1",tokenUsage:{total:{totalTokens:1000000,inputTokens:900000,cachedInputTokens:800000,outputTokens:100000,reasoningOutputTokens:10000,secret:"NEVER_RETURN"}}},generation:1});
  const event=manager.eventsAfter(0,"task-1").events[0];assert.equal(event.kind,"token_usage_updated");assert.equal((event.payload.tokenUsage as any).total.totalTokens,1000000);assert.equal(JSON.stringify(event).includes("NEVER_RETURN"),false);manager.close();
});
