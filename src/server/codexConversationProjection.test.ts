import assert from "node:assert/strict";
import test from "node:test";
import { projectThread, projectThreadItem } from "./codexConversationProjection.js";

test("projects history without leaking unknown payloads", () => {
  const detail = projectThread({ id:"thread-1", cwd:"C:/tasks/TA-1", turns:[{ id:"turn-1", status:"completed", items:[{id:"u1",type:"userMessage",text:"hello"},{id:"a1",type:"agentMessage",text:"world"},{id:"secret",type:"futureSecretItem",environment:{TOKEN:"no"}}]}] }, {
    taskId:"task-1",threadId:"thread-1",displayName:"Chat",isPrimary:true,archived:false,remoteSyncState:"synced",createdAt:"2026-01-01T00:00:00Z",updatedAt:"2026-01-01T00:00:00Z"
  });
  assert.equal(detail.conversation.preview,"world");
  assert.deepEqual(detail.turns[0].items[2],{kind:"activity",id:"secret",activityType:"futureSecretItem",label:"futureSecretItem"});
  assert.doesNotMatch(JSON.stringify(detail),/TOKEN|no/);
});

test("bounds command output", () => {
  const item=projectThreadItem({id:"cmd",type:"commandExecution",command:["echo","ok"],cwd:"C:/x",status:"completed",aggregatedOutput:"x".repeat(90_000)});
  assert.equal(item.kind,"command");
  if(item.kind==="command"){assert.equal(item.outputTruncated,true);assert.ok((item.output?.length??0)<81_000);}
});
