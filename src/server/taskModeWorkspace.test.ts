import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { TaskStore } from "./tasks/taskStore.js";
import { TaskModeStore } from "./tasks/taskModeStore.js";
import { projectTaskWorkspace } from "./tasks/taskModeWorkspace.js";

function cacheFixture() {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"apron-cache-generation-"));
  const tasks=new TaskStore(directory),task=tasks.create({title:"Cache generation"}),db=new DatabaseSync(tasks.dbPath);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
  const seed=new TaskModeStore(tasks.dbPath),state=seed.ensure(task.id);
  state.phase="paused";state.heartbeat.message="original";
  state.settings.authorizationType="full_authorization";state.settings.permissionPreset="full_access";
  state.runs=[{id:"run",instructionIds:[],createdAt:state.updatedAt,settings:state.settings,reviewAttempt:0,jobs:[{id:"job",role:"execute",name:"Execution",objective:"Preserve history",ownedPaths:[],status:"completed",attempt:0,text:"immutable history",model:"model",items:[{id:"command",kind:"command",command:"verify",cwd:directory,status:"completed",durationMs:8000}],writerRecovery:{sourceThreadId:"original-thread",clientMessageId:"recovery-request"}}]}];
  seed.save(state);seed.close();
  const reader=new TaskModeStore(tasks.dbPath);
  return {directory,tasks,task,db,reader,close(){reader.close();db.close();tasks.close();fs.rmSync(directory,{recursive:true,force:true});}};
}

/** A second SQLite connection in a real thread commits at a reader-selected boundary.
 * Atomics makes the two race windows deterministic, without sleeps or app test hooks. */
async function concurrentWriter(dbPath:string,taskId:string) {
  const signal=new Int32Array(new SharedArrayBuffer(4));
  const worker=new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const {DatabaseSync}=require('node:sqlite'),db=new DatabaseSync(workerData.dbPath);
    const signal=new Int32Array(workerData.signal);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000;');
    parentPort.on('message',message=>{
      if(message==='stop'){db.close();parentPort.close();return;}
      try {db.exec('BEGIN IMMEDIATE');db.prepare("UPDATE task_mode_state SET data=json_set(data,'$.heartbeat.message',?) WHERE task_id=?").run(message,workerData.taskId);db.exec('COMMIT');Atomics.store(signal,0,1);}
      catch(error){try{db.exec('ROLLBACK');}catch{}Atomics.store(signal,0,2);}
      Atomics.notify(signal,0);
    });parentPort.postMessage('ready');
  `,{eval:true,workerData:{dbPath,taskId,signal:signal.buffer}});
  await new Promise<void>((resolve,reject)=>{worker.once("message",()=>resolve());worker.once("error",reject);});
  return {commit(message:string){Atomics.store(signal,0,0);worker.postMessage(message);assert.notEqual(Atomics.wait(signal,0,0,5000),"timed-out","independent writer must commit while reader is between statements");assert.equal(Atomics.load(signal,0),1,"independent SQLite transaction must succeed");},async close(){const exit=new Promise<void>(resolve=>worker.once("exit",()=>resolve()));worker.postMessage("stop");await exit;}};
}

test("cache generation: cold state never adopts a later writer token",async()=>{
  const f=cacheFixture(),writer=await concurrentWriter(f.tasks.dbPath,f.task.id);
  const db=(f.reader as any).db as DatabaseSync,prepare=db.prepare.bind(db);let armed=true;
  db.prepare=((sql:string)=>{
    const statement=prepare(sql),get=statement.get.bind(statement);
    statement.get=((...args:any[])=>{const row=get(...args);if(armed&&row&&"data" in row&&sql.includes("task_mode_state")){armed=false;writer.commit("external-cold-read");}return row;}) as typeof statement.get;
    return statement;
  }) as typeof db.prepare;
  try{
    assert.equal(f.reader.get(f.task.id)!.heartbeat.message,"original","first read retains its valid earlier snapshot");
    assert.equal(armed,false,"writer window must actually be exercised");
    assert.equal(f.reader.get(f.task.id)!.heartbeat.message,"external-cold-read","next read must invalidate the old snapshot");
    assert.equal(f.reader.workspace(f.task.id)!.heartbeat.message,"external-cold-read");
  }finally{db.prepare=prepare;await writer.close();f.close();}
});

test("cache generation: saved state never adopts a post-COMMIT writer token",async()=>{
  const f=cacheFixture(),writer=await concurrentWriter(f.tasks.dbPath,f.task.id);
  const db=(f.reader as any).db as DatabaseSync,exec=db.exec.bind(db);let armed=false;
  db.exec=((sql:string)=>{const result=exec(sql);if(armed&&sql==="COMMIT"){armed=false;writer.commit("external-after-save");}return result;}) as typeof db.exec;
  try{
    const state=f.reader.get(f.task.id)!;state.heartbeat.message="local-save";armed=true;f.reader.save(state);
    assert.equal(armed,false,"writer must commit after the real save COMMIT");
    assert.equal(f.reader.get(f.task.id)!.heartbeat.message,"external-after-save");
    assert.equal(f.reader.summaries()[0].heartbeat.message,"external-after-save");
  }finally{db.exec=exec;await writer.close();f.close();}
});

test("cache generation: failed COMMIT, state deletion/recreation and mutable callers preserve authority",()=>{
  const f=cacheFixture();
  try{
    const original=f.reader.get(f.task.id)!;
    f.db.exec(`CREATE TABLE cache_guard_targets(id TEXT PRIMARY KEY);
      CREATE TABLE cache_commit_guard(id TEXT REFERENCES cache_guard_targets(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_cache_commit AFTER UPDATE ON task_mode_state BEGIN INSERT INTO cache_commit_guard VALUES('missing'); END;`);
    const failed=f.reader.get(f.task.id)!;failed.heartbeat.message="must roll back";
    assert.throws(()=>f.reader.save(failed),/FOREIGN KEY constraint failed/);
    assert.equal(f.reader.get(f.task.id)!.heartbeat.message,"original");
    assert.equal((f.db.prepare("SELECT data FROM task_mode_state WHERE task_id=?").get(f.task.id) as {data:string}).data.includes("must roll back"),false);
    f.db.exec("DROP TRIGGER fail_cache_commit;");
    const recreated={...original,heartbeat:{...original.heartbeat,message:"recreated same revision"}};
    f.db.prepare("DELETE FROM task_mode_state WHERE task_id=?").run(f.task.id);
    assert.equal(f.reader.get(f.task.id),null);
    f.db.prepare("INSERT INTO task_mode_state(task_id,data) VALUES(?,?)").run(f.task.id,JSON.stringify(recreated));
    const current=f.reader.get(f.task.id)!;assert.equal(current.heartbeat.message,"recreated same revision");
    current.settings.authorizationType="pending_approval";current.runs[0].jobs[0].writerRecovery!.sourceThreadId="caller mutation";current.runs[0].jobs[0].items.length=0;
    const isolated=f.reader.get(f.task.id)!;
    assert.equal(isolated.settings.authorizationType,"full_authorization");assert.equal(isolated.runs[0].jobs[0].writerRecovery!.sourceThreadId,"original-thread");
    const item=isolated.runs[0].jobs[0].items[0];assert.ok(item.kind==="command");assert.equal(item.durationMs,8000);
    assert.equal(isolated.processedVerifiedDurationMs,original.processedVerifiedDurationMs);
    f.reader.save(isolated);isolated.heartbeat.message="unsaved mutation after save";
    assert.equal(f.reader.get(f.task.id)!.heartbeat.message,"recreated same revision");
  }finally{f.close();}
});

test("workspace reads stay small and cached while complete execution evidence remains authoritative",()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"apron-workspace-view-")),tasks=new TaskStore(directory),task=tasks.create({title:"Large evidence"}),store=new TaskModeStore(tasks.dbPath);
  try{
    const state=store.ensure(task.id),large="unrendered-evidence-marker".repeat(100000);
    state.phase="paused";
    const result={status:"done" as const,summary:"Verified result",changedFiles:["file.ts"],verification:[],risks:[],artifacts:[],changes:[{path:"file.ts",diff:large}]};
    state.runs=[{id:"run",instructionIds:[],createdAt:state.updatedAt,settings:state.settings,reviewAttempt:0,result,jobs:[{id:"job",role:"execute",name:"Execution",objective:"Implement",ownedPaths:["file.ts"],status:"completed",attempt:0,text:large,model:"model",processed:true,output:{summary:result.summary,rawEvidence:large},items:[{id:"item",kind:"command",command:"verify",cwd:directory,status:"completed",output:large,durationMs:1234}]}]}];
    store.save(state);const complete=store.get(task.id)!,workspace=store.workspace(task.id)!;
    assert.ok(JSON.stringify(workspace).length<JSON.stringify(complete).length/100);
    assert.equal(workspace.runs[0].jobs[0].itemsDeferred,true);assert.deepEqual(workspace.runs[0].jobs[0].items,[]);
    assert.deepEqual(workspace.runs[0].jobs[0].output,{summary:"Verified result"});
    assert.equal(workspace.runs[0].result!.changesDeferred,true);assert.deepEqual(workspace.runs[0].result!.changes,[]);
    assert.equal(complete.runs[0].result!.changes[0].diff,large);assert.equal(complete.runs[0].jobs[0].text,large);
    assert.equal(workspace.processedVerifiedDurationMs,complete.processedVerifiedDurationMs);
    const parse=JSON.parse;
    try{
      JSON.parse=((value:string,...args:any[])=>{assert.ok(!value.includes("unrendered-evidence-marker"),"a warm workspace read must not parse full history");return parse(value,...args);}) as typeof JSON.parse;
      store.workspace(task.id);store.workspace(task.id);store.get(task.id);store.get(task.id);
    }finally{JSON.parse=parse;}
    const isolated=store.get(task.id)!;isolated.runs[0].result!.summary="Unsaved caller mutation";isolated.runs[0].jobs[0].items.length=0;
    assert.equal(store.get(task.id)!.runs[0].result!.summary,"Verified result");
    assert.equal(store.get(task.id)!.runs[0].jobs[0].items[0].kind,"command");
    const unchanged=JSON.stringify(complete);projectTaskWorkspace(complete);assert.equal(JSON.stringify(complete),unchanged);
    const writer=new DatabaseSync(tasks.dbPath);
    try{
      const updated=store.get(task.id)!;updated.phase="completed";updated.runs[0].result!.summary="New authoritative result";
      writer.prepare("UPDATE task_mode_state SET data=? WHERE task_id=?").run(JSON.stringify(updated),task.id);
      assert.equal(store.workspace(task.id)!.phase,"completed");assert.equal(store.workspace(task.id)!.runs[0].result!.summary,"New authoritative result");
      assert.equal(store.get(task.id)!.runs[0].result!.changes[0].diff,large);
      assert.equal(store.get(task.id)!.runs[0].result!.summary,"New authoritative result");
    }finally{writer.close();}
  }finally{store.close();tasks.close();fs.rmSync(directory,{recursive:true,force:true});}
});
