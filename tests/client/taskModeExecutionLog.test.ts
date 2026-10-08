import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import { chromium, expect } from "@playwright/test";
import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import type { TaskExecutionJob } from "../../src/shared/taskModeTypes.js";

const root=path.resolve(import.meta.dirname,"../..");
const evidence=path.join(root,"data/task-contexts/TA-8/loading-performance/live-log-refresh");
const baseline=process.env.TASK_LOG_BASELINE==="1";
const sha=(file:string)=>createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const assistant=(id:string,text=id):TaskExecutionJob["items"][number]=>({kind:"assistant",id,text});
const newJob=(id="job-a"):TaskExecutionJob=>({id,role:"execute",name:"Live log fixture",objective:"Controlled append",ownedPaths:[],status:"active",attempt:1,text:"",model:"fixture",items:[],itemsDeferred:true});

test("opened deferred active execution log refreshes without user action and isolates asynchronous reads",{timeout:90000},async()=>{
  fs.mkdirSync(evidence,{recursive:true});
  const harness=path.join(evidence,"harness");fs.mkdirSync(harness,{recursive:true});
  fs.writeFileSync(path.join(harness,"index.html"),'<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>');
  fs.writeFileSync(path.join(harness,"main.tsx"),`
import React, {useEffect,useState} from "react";
import {createRoot} from "react-dom/client";
import {TaskExecutionLog} from "/src/client/task-mode/TaskExecutionLog.tsx";
function App(){
 const [detail,setDetail]=useState(null);
 useEffect(()=>{let alive=true,timer;async function read(){const response=await fetch('/fixture/detail');const value=await response.json();if(alive){setDetail(value);timer=setTimeout(read,200);}}void read();return()=>{alive=false;clearTimeout(timer);};},[]);
 return detail&&<main><p>Detail revision {detail.revision}</p><p>{detail.taskId}/{detail.runId}/{detail.job.id}</p><TaskExecutionLog taskId={detail.taskId} runId={detail.runId} job={detail.job}/></main>;
}
createRoot(document.getElementById('root')).render(<App/>);
`);
  const build=path.join(harness,baseline?"before-build":"after-build");
  await viteBuild({configFile:false,root:harness,plugins:[react()],resolve:{alias:{"/src":path.join(root,"src")}},build:{outDir:build,emptyOutDir:true},logLevel:"warn"});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"apron-live-log-")),dataFile=path.join(directory,"fixture.json");
  let detail={taskId:"task-a",runId:"run-a",job:newJob(),revision:1};
  const key=()=>`${detail.taskId}/${detail.runId}/${detail.job.id}`;
  const records=new Map<string,TaskExecutionJob["items"]>([[key(),[assistant("initial-success")]]]);
  const save=()=>fs.writeFileSync(dataFile,JSON.stringify({detail,records:Object.fromEntries(records)}));save();
  const append=(item:TaskExecutionJob["items"][number])=>{records.get(key())!.push(item);detail.revision++;save();};
  const requests:Array<{key:string;at:number;finishedAt?:number;status?:number}>=[];
  const checks:Array<{scenario:string;details:unknown}>=[];
  let active=0,maxActive=0,detailReads=0,holdNext=false,failNext=false;
  let release:(()=>void)|undefined;
  const app=express();
  app.get("/fixture/detail",(_req,res)=>{detailReads++;const saved=JSON.parse(fs.readFileSync(dataFile,"utf8"));res.json(saved.detail);});
  app.get(/^\/api\/task-mode\/tasks\/([^/]+)\/runs\/([^/]+)\/jobs\/([^/]+)\/items$/, (req,res)=>{
    const id=[req.params[0],req.params[1],req.params[2]].join("/");
    const row={key:id,at:Date.now()} as typeof requests[number];requests.push(row);active++;maxActive=Math.max(maxActive,active);
    const saved=JSON.parse(fs.readFileSync(dataFile,"utf8"));const items=saved.records[id]??[];
    const failure=failNext;failNext=false;
    const send=()=>{active--;row.finishedAt=Date.now();row.status=failure?500:200;if(failure)res.status(500).json({error:{message:"controlled read failure"}});else res.json({items});};
    if(holdNext){holdNext=false;release=send;}else send();
  });
  app.use(express.static(build));
  let server:Server|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  const errors:string[]=[];
  try{
    server=await new Promise<Server>(resolve=>{const value=app.listen(0,"127.0.0.1",()=>resolve(value));});
    const port=(server.address() as {port:number}).port;assert.notEqual(port,3131);
    browser=await chromium.launch({headless:true,channel:"msedge"});const page=await browser.newPage();page.on("pageerror",error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/`);
    const summary=page.locator("main > details > summary");await expect(summary).toBeVisible();
    await page.waitForTimeout(2300);assert.equal(requests.length,0);checks.push({scenario:"unopened evidence reads zero",details:{reads:requests.length,detailReads}});
    await summary.click();await expect(page.getByText("initial-success",{exact:true})).toBeVisible();
    const beforeAppend=requests.length,start=Date.now();
    append({kind:"command",id:"unique-command",command:"echo UNIQUE_LIVE_COMMAND_83280355",cwd:directory,status:"completed",output:"unique command output"});
    append(assistant("unique-assistant","UNIQUE_LIVE_ASSISTANT_83280355"));
    await expect(page.getByText(`Detail revision ${detail.revision}`,{exact:true})).toBeVisible();
    assert.equal(detail.job.status,"active");assert.equal(detail.job.itemsDeferred,true);
    if(baseline){
      await page.waitForTimeout(6500);await expect(page.getByText("UNIQUE_LIVE_ASSISTANT_83280355",{exact:true})).toHaveCount(0);
      await expect(page.getByText("echo UNIQUE_LIVE_COMMAND_83280355",{exact:false})).toHaveCount(0);assert.equal(requests.length,beforeAppend);
      checks.push({scenario:"reproduced missing refresh with unchanged active/deferred",details:{visible:false,waitMs:6500,readsBefore:beforeAppend,readsAfter:requests.length,detailReads,revision:detail.revision}});
      await page.screenshot({path:path.join(evidence,"before-missing-output.png")});
    }else{
      await expect(page.getByText("UNIQUE_LIVE_ASSISTANT_83280355",{exact:true})).toBeVisible({timeout:7000});
      await expect(page.getByText("echo UNIQUE_LIVE_COMMAND_83280355",{exact:false})).toBeVisible();
      checks.push({scenario:"active command and assistant append automatically visible",details:{latencyMs:Date.now()-start,readsBefore:beforeAppend,readsAfter:requests.length,revision:detail.revision}});
      await page.screenshot({path:path.join(evidence,"after-live-output.png")});
      // Hold a real request across active -> completed; the final read must queue rather than overlap.
      holdNext=true;await expect.poll(()=>Boolean(release),{timeout:7000}).toBe(true);
      const heldCount=requests.length;append(assistant("final-data"));detail.job.status="completed";detail.revision++;save();
      await expect(page.getByText(`Detail revision ${detail.revision}`,{exact:true})).toBeVisible();await page.waitForTimeout(250);assert.equal(requests.length,heldCount);
      release!();release=undefined;await expect(page.getByText("final-data",{exact:true})).toBeVisible();
      await page.waitForTimeout(2300);assert.equal(requests.length,heldCount+1);
      checks.push({scenario:"status completion fetches final data once after in-flight read",details:{before:heldCount,after:requests.length,maxActive}});
      // Manual failure retains successful content and the original retry control.
      failNext=true;await page.getByRole("button",{name:"刷新记录",exact:true}).click();
      await expect(page.getByRole("alert")).toHaveText("controlled read failure");await expect(page.getByText("final-data",{exact:true})).toBeVisible();
      await page.getByRole("button",{name:"刷新记录",exact:true}).click();await expect(page.getByRole("alert")).toHaveCount(0);
      checks.push({scenario:"failure retains last success and manual retry recovers",details:{reads:requests.length}});
      // Active failures retry automatically. Close during a held request, reopen, and coalesce reads.
      detail.job.status="active";detail.revision++;failNext=true;save();
      await expect(page.getByRole("alert")).toBeVisible();await expect(page.getByText("final-data",{exact:true})).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0,{timeout:7000});
      checks.push({scenario:"active failure automatically retries",details:{reads:requests.length}});
      holdNext=true;await expect.poll(()=>Boolean(release),{timeout:7000}).toBe(true);
      await summary.click();const closedCount=requests.length;await page.waitForTimeout(2300);assert.equal(requests.length,closedCount);
      await summary.click();await page.waitForTimeout(250);assert.equal(requests.length,closedCount);
      append(assistant("after-reopen"));release!();release=undefined;
      await expect(page.getByText("after-reopen",{exact:true})).toBeVisible();assert.equal(requests.length,closedCount+1);
      checks.push({scenario:"closed stops reads and reopening waits for obsolete read",details:{closedCount,reopenedCount:requests.length,maxActive}});
      // Same mounted component receives a new task, then run, then job. Late snapshots cannot leak.
      for(const field of ["taskId","runId","jobId"] as const){
        holdNext=true;append(assistant(`STALE_${field}`));await expect.poll(()=>Boolean(release),{timeout:7000}).toBe(true);
        const held=requests.length;
        if(field==="jobId")detail.job={...detail.job,id:"job-b"};else detail={...detail,[field]:field==="taskId"?"task-b":"run-b"};
        const fresh=`FRESH_${field}`;records.set(key(),[assistant(fresh)]);detail.revision++;save();
        await expect(page.getByText(`Detail revision ${detail.revision}`,{exact:true})).toBeVisible();
        await expect(page.getByText(`STALE_${field}`,{exact:true})).toHaveCount(0);await page.waitForTimeout(250);assert.equal(requests.length,held);
        release!();release=undefined;await expect(page.getByText(fresh,{exact:true})).toBeVisible();await expect(page.getByText(`STALE_${field}`,{exact:true})).toHaveCount(0);
        checks.push({scenario:`late response isolated after ${field} change`,details:{held,reads:requests.length,key:key()}});
      }
      // Final cleanup has no outstanding timer or new reads, even after another full interval.
      await summary.click();const closed=requests.length;await page.waitForTimeout(2300);assert.equal(requests.length,closed);
      checks.push({scenario:"closed active log timer stops",details:{before:closed,after:requests.length}});
      assert.equal(maxActive,1);
    }
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(evidence,baseline?"before-evidence.json":"after-evidence.json"),JSON.stringify({result:baseline?"defect_reproduced":"passed",port,build,directory,componentSha256:sha(path.join(root,"src/client/task-mode/TaskExecutionLog.tsx")),buildAssets:fs.readdirSync(path.join(build,"assets")).map(name=>({name,sha256:sha(path.join(build,"assets",name))})),checks,requests,detailReads,maxActive,errors,boundary:"Real compiled React component and HTTP route; temporary persisted JSON items, deterministic controlled response delay/failure. No production connections or API changes."},null,2));
    console.log(JSON.stringify({result:baseline?"defect_reproduced":"passed",port,scenarios:checks.length,reads:requests.length,maxActive}));
  }catch(error){fs.writeFileSync(path.join(evidence,baseline?"before-failure.json":"after-failure.json"),JSON.stringify({error:String(error),checks,requests,maxActive},null,2));throw error;}
  finally{release?.();await browser?.close();server?.closeAllConnections();await new Promise<void>(resolve=>server?server.close(()=>resolve()):resolve());}
});
