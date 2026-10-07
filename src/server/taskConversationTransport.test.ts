import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import { createTaskConversationRouter } from "./tasks/taskConversationRouter.js";
import type { TaskConversationService } from "./tasks/taskConversationService.js";
import { CodexConversationManager } from "./codexConversationManager.js";

test("a cursor from a previous server process requires a fresh snapshot",()=>{
  const manager=new CodexConversationManager();
  try{assert.equal(manager.eventsAfter(9000,"task").gap,true);assert.equal(manager.eventsAfter(0,"task").gap,false);}
  finally{manager.close();}
});

test("SSE ring gaps reset the cursor instead of reconnecting into the same gap repeatedly",async()=>{
  const manager=Object.assign(new EventEmitter(),{eventsAfter:(sequence:number)=>({gap:sequence>0&&sequence<1000,events:[]})});
  const service={store:{get:()=>({id:"task"})},manager} as unknown as TaskConversationService;
  const app=express();app.use("/api/tasks/:taskId/conversations",createTaskConversationRouter(async()=>service));
  const server=app.listen(0,"127.0.0.1");await once(server,"listening");
  try{
    const address=server.address();assert.ok(address&&typeof address!=="string");const url=`http://127.0.0.1:${address.port}/api/tasks/task/conversations/events`;
    const gap=await fetch(url,{headers:{"Last-Event-ID":"1"}});const payload=await gap.text();
    assert.match(payload,/id: 0/);assert.match(payload,/"kind":"resync_required"/);
    const response=await fetch(url,{headers:{"Last-Event-ID":"0"}}),reader=response.body!.getReader();
    const first=await reader.read();const chunk=new TextDecoder().decode(first.value);
    assert.match(chunk,/"kind":"ready"/);assert.doesNotMatch(chunk,/resync_required/);await reader.cancel();
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
