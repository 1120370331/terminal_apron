import assert from "node:assert/strict";
import test from "node:test";
import { createLiveRefreshLoop } from "../../src/client/liveRefresh.js";
import { createClientId } from "../../src/client/clientId.js";
import { reduceTaskConversationEvent, retainLoadedConversationHistory, reconcileLiveConversationSnapshot } from "../../src/client/task-monitor/taskConversationState.js";
import { taskConversationApi } from "../../src/client/taskConversationApi.js";
import { conversationActivity } from "../../src/client/conversationActivityState.js";
import type { TaskConversationDetail, TaskConversationEvent } from "../../src/shared/taskConversationTypes.js";

const wait=(milliseconds:number)=>new Promise(resolve=>setTimeout(resolve,milliseconds));
function fixture():TaskConversationDetail{return {conversation:{taskId:"task",threadId:"thread",displayName:"Codex",isPrimary:true,archived:false,remoteSyncState:"synced",createdAt:"",updatedAt:"",preview:"",status:"active",activeTurnId:"turn",cwd:"",modelProvider:"openai"},turns:[{id:"turn",status:"in_progress",items:[{kind:"command",id:"command",command:"npm test",cwd:"C:/project",status:"inProgress",output:"first\n"}]}]};}
const event=(kind:TaskConversationEvent["kind"],payload:Record<string,unknown>,itemId?:string):TaskConversationEvent=>({kind,payload,itemId,taskId:"task",threadId:"thread",turnId:"turn",occurredAt:new Date().toISOString(),sequence:1});

test("continuous notifications cannot postpone a refresh until the stream stops",async()=>{
  let reads=0;const loop=createLiveRefreshLoop(async()=>{reads++;},{delayMs:20,intervalMs:60000});
  const stream=setInterval(()=>loop.request(),5);
  try{await wait(140);assert.ok(reads>=2,`Only ${reads} reads during a continuous notification burst`);}
  finally{clearInterval(stream);loop.dispose();}
});

test("refresh reads are serialized and in-flight notifications request one follow-up",async()=>{
  let release!:()=>void,reads=0;const gate=new Promise<void>(resolve=>release=resolve);
  const loop=createLiveRefreshLoop(async()=>{reads++;if(reads===1)await gate;},{delayMs:5,intervalMs:60000});
  try{loop.request(true);await wait(20);for(let index=0;index<20;index++)loop.request(true);assert.equal(reads,1);release();await wait(25);assert.equal(reads,2);}
  finally{release();loop.dispose();}
});

test("hidden pages pause polling and visibility, online and focus immediately resynchronize",async()=>{
  const doc=Object.assign(new EventTarget(),{visibilityState:"hidden"}),target=new EventTarget();let reads=0;
  const loop=createLiveRefreshLoop(async()=>{reads++;},{document:doc,window:target,intervalMs:20,delayMs:5});
  try{loop.request(true);await wait(35);assert.equal(reads,0);doc.visibilityState="visible";doc.dispatchEvent(new Event("visibilitychange"));await wait(8);assert.ok(reads>0);doc.visibilityState="hidden";await wait(25);const before=reads;doc.visibilityState="visible";target.dispatchEvent(new Event("online"));await wait(8);assert.ok(reads>before);loop.dispose();const closed=reads;target.dispatchEvent(new Event("focus"));await wait(25);assert.equal(reads,closed);}
  finally{loop.dispose();}
});

test("SSE replay and duplicate sequences do not append already-snapshotted text twice",()=>{
  class FakeSource extends EventTarget{close(){}constructor(_url:string){super();}}
  const original=globalThis.EventSource;globalThis.EventSource=FakeSource as unknown as typeof EventSource;
  try{
    const received:TaskConversationEvent[]=[];const source=taskConversationApi.subscribe("task",item=>received.push(item));
    const dispatch=(item:TaskConversationEvent)=>source.dispatchEvent(new MessageEvent("conversation-event",{data:JSON.stringify(item)}));
    source.dispatchEvent(new Event("open"));dispatch(event("assistant_delta",{delta:"old"},"message"));
    dispatch({...event("ready",{}),sequence:1});dispatch({...event("assistant_delta",{delta:"new"},"message"),sequence:2});dispatch({...event("assistant_delta",{delta:"new"},"message"),sequence:2});
    assert.deepEqual(received.map(item=>item.kind),["ready","assistant_delta"]);
    source.dispatchEvent(new Event("error"));dispatch({...event("assistant_delta",{delta:"replay"},"message"),sequence:3});
    source.dispatchEvent(new Event("open"));dispatch({...event("ready",{}),sequence:3});dispatch({...event("assistant_delta",{delta:"live"},"message"),sequence:4});
    assert.equal(received.filter(item=>item.kind==="assistant_delta").length,2);source.close();
  }finally{globalThis.EventSource=original;}
});

test("command output keeps command metadata and terminal statuses stop execution indicators",()=>{
  const updated=reduceTaskConversationEvent(fixture(),event("command_output_delta",{delta:"second\n"},"command"));
  assert.deepEqual(updated.turns[0].items[0],{kind:"command",id:"command",command:"npm test",cwd:"C:/project",status:"inProgress",output:"first\nsecond\n",outputTruncated:false});
  assert.equal(conversationActivity(updated).mode,"command");
  const ended=reduceTaskConversationEvent(updated,event("turn_completed",{turn:{status:"interrupted"}}));
  assert.equal(ended.turns[0].status,"interrupted");assert.equal(conversationActivity(ended,true).running,false);
  const failed=reduceTaskConversationEvent(fixture(),event("turn_completed",{turn:{status:"failed",error:{message:"connection closed"}}}));
  assert.equal(failed.turns[0].status,"failed");assert.equal(failed.turns[0].error?.message,"connection closed");
});

test("periodic snapshots preserve older history that the user loaded",()=>{
  const fresh=fixture(),current={...fresh,turns:[{id:"old",status:"completed" as const,items:[]},...fresh.turns]};
  assert.deepEqual(retainLoadedConversationHistory(current,fresh).turns.map(turn=>turn.id),["old","turn"]);
});

test("native automatic compaction stays visible across a snapshot and switches back to work on completion",()=>{
  const start={kind:"activity" as const,id:"compact",activityType:"contextCompaction",label:"压缩中",status:"in_progress" as const};
  const active=reduceTaskConversationEvent(fixture(),event("item_started",{item:start},"compact"));
  assert.equal(conversationActivity(active).mode,"compacting");
  const snapshot=structuredClone(active);snapshot.turns[0].items[1]={...start,status:undefined,label:"上下文压缩记录"};
  assert.equal(conversationActivity(reconcileLiveConversationSnapshot(active,snapshot)).mode,"compacting");
  const ended=reduceTaskConversationEvent(active,event("item_completed",{item:{...start,status:"completed"}},"compact"));
  assert.equal(conversationActivity(ended).mode,"command");
});

test("client request IDs work without the HTTPS-only randomUUID method",()=>{
  const source={getRandomValues:(bytes:Uint8Array)=>{for(let index=0;index<bytes.length;index++)bytes[index]=index;return bytes;}};
  assert.equal(createClientId(source),"00010203-0405-4607-8809-0a0b0c0d0e0f");
  assert.match(createClientId({}),/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});


test("stale snapshots cannot remove streamed text or regress a completed turn to running",()=>{
  const stale=fixture();stale.turns[0].items=[{kind:"assistant",id:"message",phase:"commentary",text:"begin:"}];
  const streamed=reduceTaskConversationEvent(stale,event("assistant_delta",{delta:" streamed"},"message"));
  const merged=reconcileLiveConversationSnapshot(streamed,stale);
  assert.equal((merged.turns[0].items[0] as {text:string}).text,"begin: streamed");
  const finished=reduceTaskConversationEvent(streamed,event("turn_completed",{turn:{status:"completed"}}));
  const final=reconcileLiveConversationSnapshot(finished,stale);
  assert.equal(final.turns[0].status,"completed");assert.equal(final.conversation.status,"idle");assert.equal(conversationActivity(final).running,false);
});
