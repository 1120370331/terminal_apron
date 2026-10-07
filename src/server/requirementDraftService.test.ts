import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { CodexConversationManager } from "./codexConversationManager.js";
import { CodexRpcError } from "./codexAppServerClient.js";
import { RequirementDraftService } from "./tasks/requirementDraftService.js";
import { RequirementDraftError, RequirementDraftStore } from "./tasks/requirementDraftStore.js";

class Client extends EventEmitter {
  currentGeneration = 1; running = true; starts = 0; turnStarts = 0; failTurn = false;
  calls: Array<{ method: string; params: any }> = []; turns: any[] = [];
  async request(method: string, params: any): Promise<any> {
    this.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: `thread-${++this.starts}` } };
    if (method === "thread/read") return { thread: { id: params.threadId, turns: this.turns } };
    if (method === "turn/start") {
      this.turnStarts++;
      const turn = { id: `turn-${this.turnStarts}`, status: "completed", clientUserMessageId: params.clientUserMessageId, items: [] }; this.turns.push(turn);
      if (this.failTurn) throw new CodexRpcError("Codex request timed out: turn/start");
      return { turn };
    }
    return {};
  }
  close() {}
  async tool(threadId: string, callId: string, tool: string, args: unknown): Promise<any> {
    return new Promise((resolve, reject) => this.emit("serverRequest", { method: "item/tool/call", params: { threadId, turnId: "turn-tools", callId, tool, arguments: args }, reply: resolve, reject: (_code: number, message: string) => reject(new Error(message)) }));
  }
}
const initial = { title: "Unsaved", descriptionMd: "First", acceptanceCriteriaMd: "" };
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "requirement-drafts-"));
  const client = new Client(), manager = new CodexConversationManager(client as any), store = new RequirementDraftStore(directory, "alice"), service = new RequirementDraftService(store, manager);
  const draft = service.create({ operationId: "create-0001", fields: initial });
  return { directory, client, manager, store, service, draft, close() { service.close(); manager.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test("separate connections enforce CAS, durable idempotency, and owner isolation", async () => {
  const f = fixture(), second = new RequirementDraftStore(f.directory, "alice"), other = new RequirementDraftStore(f.directory, "bob");
  try {
    const firstInput = { operationId: "update-0001", baseVersion: 1, patch: { title: "Alice edit" } };
    const competing = await Promise.allSettled([
      Promise.resolve().then(() => f.service.update(f.draft.draftId, firstInput)),
      Promise.resolve().then(() => second.update(f.draft.draftId, { operationId: "update-0002", baseVersion: 1, patch: { descriptionMd: "Stale" } }, "user"))
    ]);
    assert.equal(competing.filter(entry => entry.status === "fulfilled").length, 1);
    const rejected = competing.find(entry => entry.status === "rejected") as PromiseRejectedResult;
    assert.equal(rejected.reason.code, "DRAFT_VERSION_CONFLICT"); assert.equal(rejected.reason.details.current.version, 2);
    const replay = second.update(f.draft.draftId, firstInput, "user"); assert.equal(replay.replayed, true); assert.equal(replay.draft.version, 2);
    assert.equal(second.eventsAfter(f.draft.draftId, 0).events.length, 1);
    assert.throws(() => second.update(f.draft.draftId, { ...firstInput, patch: { title: "Different" } }, "user"), (error: any) => error.code === "OPERATION_ID_REUSED");
    for (const action of [() => other.get(f.draft.draftId), () => other.update(f.draft.draftId, firstInput, "user"), () => other.eventsAfter(f.draft.draftId, 0), () => other.thread(f.draft.draftId), () => other.receipts(f.draft.draftId)]) assert.throws(action, (error: any) => error.status === 404);
    assert.equal(other.boundDrafts().length, 0);
    assert.equal(f.service.create({ fields: initial, operationId: "create-0001" }).draftId, f.draft.draftId);
  } finally { other.close(); second.close(); f.close(); }
});

test("controlled dynamic tools read latest content, reject stale writes and replay once", async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([f.service.ensureConversation(f.draft.draftId), f.service.ensureConversation(f.draft.draftId)]);
    assert.equal(a.threadId, b.threadId); assert.equal(f.client.starts, 1);
    f.service.update(f.draft.draftId, { operationId: "manual-0001", baseVersion: 1, patch: { descriptionMd: "Latest user text" } });
    const read = await f.client.tool(a.threadId, "read-1", "read_requirement_draft", {});
    assert.equal(JSON.parse(read.contentItems[0].text).fields.descriptionMd, "Latest user text");
    const stale = await f.client.tool(a.threadId, "stale-1", "update_requirement_draft", { baseVersion: 1, patch: { title: "Overwrite" } });
    assert.equal(stale.success, false); assert.equal(JSON.parse(stale.contentItems[0].text).error.code, "DRAFT_VERSION_CONFLICT");
    const args = { baseVersion: 2, patch: { title: "Codex edit" } };
    const success = await f.client.tool(a.threadId, "edit-1", "update_requirement_draft", args);
    const repeat = await f.client.tool(a.threadId, "edit-1", "update_requirement_draft", args);
    assert.equal(success.success, true); assert.equal(JSON.parse(repeat.contentItems[0].text).replayed, true);
    assert.equal(f.service.get(f.draft.draftId).version, 3);
    assert.equal((await f.client.tool(a.threadId, "bad-1", "update_requirement_draft", { baseVersion: 3, patch: { ownerId: "bob" } })).success, false);
    await assert.rejects(f.client.tool("unbound-thread", "bad-2", "read_requirement_draft", {}), /Unbound/);
    assert.throws(() => f.manager.bindThread("task", a.threadId), /draft/);
    assert.equal(f.manager.eventsAfter(0, f.draft.draftId).events.length, 0);
    const task = f.client.calls.find(call => call.method === "thread/start")!;
    assert.equal(task.params.sandbox, "read-only"); assert.equal(task.params.dynamicTools[0].type, "function");
  } finally { f.close(); }
});

test("reopen restores events, operations, and thread binding without editing sent snapshots", async () => {
  const f = fixture(); let reopened: RequirementDraftService | undefined;
  try {
    const sent = await f.service.send(f.draft.draftId, { operationId: "message-0001", baseVersion: 1, text: "Please help" });
    f.service.update(f.draft.draftId, { operationId: "manual-0002", baseVersion: 1, patch: { title: "New content" } });
    const cursor = f.service.eventsAfter(f.draft.draftId, 0).eventId;
    const repeat = await f.service.send(f.draft.draftId, { operationId: "message-0001", baseVersion: 1, text: "Please help" });
    assert.deepEqual(repeat, sent); assert.equal(f.client.turnStarts, 1);
    assert.equal(repeat.snapshot.fields.title, "Unsaved");
    f.service.close();
    reopened = new RequirementDraftService(new RequirementDraftStore(f.directory, "alice"), f.manager);
    assert.equal(reopened.get(f.draft.draftId).fields.title, "New content");
    assert.equal((await reopened.conversation(f.draft.draftId)).operations[0].snapshot.fields.title, "Unsaved");
    assert.equal(f.client.starts, 1);
    reopened.update(f.draft.draftId, { operationId: "manual-0003", baseVersion: 2, patch: { acceptanceCriteriaMd: "Done" } });
    assert.equal(reopened.eventsAfter(f.draft.draftId, cursor).events.length, 1);
    assert.equal(reopened.eventsAfter(f.draft.draftId, cursor + 1000).gap, true);
  } finally { if (reopened) { reopened.close(); f.manager.close(); fs.rmSync(f.directory, { recursive: true, force: true }); } else f.close(); }
});

test("an uncertain RPC is reconciled from history without sending twice", async () => {
  const f = fixture();
  try {
    f.client.failTurn = true;
    const message = { operationId: "message-unknown", baseVersion: 1, text: "Please help" };
    await assert.rejects(f.service.send(f.draft.draftId, message), (error: any) => error.code === "TURN_OUTCOME_UNKNOWN");
    f.client.failTurn = false;
    const retry = await f.service.send(f.draft.draftId, message);
    assert.equal(retry.state, "submitted"); assert.equal(f.client.turnStarts, 1);
  } finally { f.close(); }
});

test("bounded persistent events declare resync after retention", () => {
  const f = fixture();
  try {
    for (let index = 0; index < 1002; index++) f.store.append(f.draft.draftId, { kind: "conversation", draftId: f.draft.draftId, threadId: "test-thread", eventKind: "assistant_delta", payload: { delta: "x" }, occurredAt: new Date().toISOString() });
    assert.equal(f.service.eventsAfter(f.draft.draftId, 1).gap, true);
    assert.equal(f.service.eventsAfter(f.draft.draftId, 2).gap, false);
    assert.equal(f.service.eventsAfter(f.draft.draftId, 2).events.length, 1000);
  } finally { f.close(); }
});

test("invalid fields, forged task references and non-integer versions do not mutate content", () => {
  const f = fixture();
  try {
    for (const raw of [{ operationId: "invalid-0001", baseVersion: 1, patch: {} }, { operationId: "invalid-0002", baseVersion: "1", patch: { title: "Bad" } }, { operationId: "invalid-0003", baseVersion: 1, patch: { title: null } }]) assert.throws(() => f.service.update(f.draft.draftId, raw), RequirementDraftError);
    assert.throws(() => f.service.create({ operationId: "create-forged", fields: initial, taskId: "task-other-user" }), (error: any) => error.status === 404);
    assert.equal(f.service.get(f.draft.draftId).version, 1);
  } finally { f.close(); }
});

test("unsupported native history falls back to durable streamed turns across reconnect", async () => {
  const f = fixture(); let reopened: RequirementDraftService | undefined;
  const original = f.client.request.bind(f.client);
  f.client.request = async (method, params) => { if (method === "thread/read") throw new CodexRpcError("list_turns is not supported yet", -32601); return original(method, params); };
  try {
    const receipt = await f.service.send(f.draft.draftId, { operationId: "message-streamed", baseVersion: 1, text: "Stream reply" });
    f.client.emit("notification", { method: "item/agentMessage/delta", params: { threadId: receipt.threadId, turnId: receipt.turnId, itemId: "assistant-stream", delta: "Recovered reply" } });
    f.client.emit("notification", { method: "turn/completed", params: { threadId: receipt.threadId, turnId: receipt.turnId, turn: { id: receipt.turnId, status: "completed" } } });
    f.service.close(); reopened = new RequirementDraftService(new RequirementDraftStore(f.directory, "alice"), f.manager);
    const detail = await reopened.conversation(f.draft.draftId);
    assert.equal(detail.turns[0].status, "completed");
    assert.equal((detail.turns[0].items.find(item => item.kind === "assistant") as any).text, "Recovered reply");
    assert.equal(f.client.starts, 1);
    assert.equal(f.client.calls.filter(call => call.method === "thread/resume").at(-1)?.params.excludeTurns, true);
  } finally { if (reopened) { reopened.close(); f.manager.close(); fs.rmSync(f.directory, { recursive: true, force: true }); } else f.close(); }
});

test("thread/start transport uncertainty recovers one exact-cwd thread without duplicate creation", async () => {
  const f = fixture();
  const original = f.client.request.bind(f.client);
  let thread: { id: string; cwd: string } | undefined;
  f.client.request = async (method, params) => {
    if (method === "thread/start") { f.client.starts++; thread = { id: "thread-recovered", cwd: params.cwd }; throw new CodexRpcError("Codex request timed out: thread/start"); }
    if (method === "thread/list") return { data: thread ? [thread] : [], nextCursor: null };
    return original(method, params);
  };
  try {
    await assert.rejects(f.service.ensureConversation(f.draft.draftId), /timed out/);
    const recovered = await f.service.ensureConversation(f.draft.draftId);
    assert.equal(recovered.threadId, "thread-recovered"); assert.equal(f.client.starts, 1);
  } finally { f.close(); }
});

test("simultaneous worker threads racing a version produce exactly one committed update", async () => {
  const f = fixture(), gate = new SharedArrayBuffer(4), workers: Worker[] = [];
  try {
    const arrivals = [0, 1].map(index => new Promise<void>((resolve, reject) => {
      const worker = new Worker(`
        const {parentPort,workerData}=require('node:worker_threads');
        (async()=>{
          const {register}=await import('tsx/esm/api'); register();
          const {RequirementDraftStore}=await import(workerData.moduleUrl);
          const store=new RequirementDraftStore(workerData.directory,'alice');
          parentPort.postMessage({ready:true});
          Atomics.wait(new Int32Array(workerData.gate),0,0);
          try { const result=store.update(workerData.draftId,{operationId:workerData.operationId,baseVersion:1,patch:{title:workerData.operationId}},'user');parentPort.postMessage({result}); }
          catch(error){parentPort.postMessage({code:error.code});}
          finally{store.close();}
        })().catch(error=>{parentPort.postMessage({fatal:String(error.stack)});});`, { eval: true, workerData: { gate, directory: f.directory, draftId: f.draft.draftId, operationId: `race-worker-${index}`, moduleUrl: new URL("./tasks/requirementDraftStore.ts", import.meta.url).href } });
      workers.push(worker); worker.on("error", reject);
      worker.on("message", value => { if (value.ready) resolve(); if (value.fatal) reject(new Error(value.fatal)); });
    }));
    await Promise.all(arrivals);
    const outcomes = workers.map(worker => new Promise<any>((resolve, reject) => { worker.on("message", value => { if (!value.ready) resolve(value); }); worker.on("error", reject); }));
    Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0, 2);
    const results = await Promise.all(outcomes);
    assert.equal(results.filter(result => result.result).length, 1);
    assert.equal(results.filter(result => result.code === "DRAFT_VERSION_CONFLICT").length, 1);
    assert.equal(f.service.get(f.draft.draftId).version, 2);
    assert.equal(f.service.eventsAfter(f.draft.draftId, 0).events.length, 1);
  } finally { for (const worker of workers) await worker.terminate(); f.close(); }
});
