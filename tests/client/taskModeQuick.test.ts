import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Server } from "node:http";
import express from "express";
import { chromium } from "@playwright/test";
import { TaskStore } from "../../src/server/tasks/taskStore.js";
import { TaskConversationService } from "../../src/server/tasks/taskConversationService.js";
import { TaskModeService } from "../../src/server/tasks/taskModeService.js";
import { createTaskRouter } from "../../src/server/tasks/taskRouter.js";
import { createTaskModeRouter } from "../../src/server/tasks/taskModeRouter.js";
import type { CodexConversationManager } from "../../src/server/codexConversationManager.js";
import { ControlledExecutor } from "../fixtures/taskModeQuickExecutor.js";

// Clean checkout: npm ci; npm run build:task-monitor;
// node --import tsx --test tests/client/taskModeQuick.test.ts
// Optional TASK_MODE_QUICK_BUILD_DIR selects an independently built directory;
// TASK_MODE_QUICK_EVIDENCE_DIR selects where to archive this run's generated evidence.

test("real publish UI retains quick draft on settings failure, then persists and executes without Workers",{timeout:90000},async()=>{
  const repositoryRoot=path.resolve(import.meta.dirname,"../..");
  const build=path.resolve(process.env.TASK_MODE_QUICK_BUILD_DIR??path.join(repositoryRoot,"dist/task-monitor-client"));
  assert.ok(fs.existsSync(path.join(build,"task-monitor.html")),`TaskMonitor build missing at ${build}. Run npm run build:task-monitor first, or build to a separate directory and set TASK_MODE_QUICK_BUILD_DIR.`);
  const evidence=process.env.TASK_MODE_QUICK_EVIDENCE_DIR?path.resolve(process.env.TASK_MODE_QUICK_EVIDENCE_DIR):fs.mkdtempSync(path.join(os.tmpdir(),"apron-quick-evidence-"));
  fs.mkdirSync(evidence,{recursive:true});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"apron-quick-browser-"));
  const store=new TaskStore(directory),manager=new ControlledExecutor(),conversations=new TaskConversationService(store,manager as unknown as CodexConversationManager),mode=new TaskModeService(conversations,{pollMs:20});
  store.createProject({name:"Quick isolated project",rootDirectory:directory,descriptionMd:"仅验证快速模式"});manager.autoExecute=true;
  const app=express();app.use(express.json({limit:"1mb"}));app.use((_req,res,next)=>{res.locals.user={name:"quick-isolated",method:"none"};next();});app.get("/api/me",(_req,res)=>res.json({name:"quick-isolated",method:"none"}));
  app.use("/api/tasks",createTaskRouter(async()=>store));app.use("/api/task-mode",createTaskModeRouter(async()=>mode));
  app.use("/task-monitor",express.static(build));app.get("/task-monitor/",(_req,res)=>res.sendFile(path.join(build,"task-monitor.html")));
  let server:Server|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    server=await new Promise<Server>((resolve,reject)=>{const value=app.listen(0,"127.0.0.1",()=>resolve(value));value.once("error",reject);});const port=(server.address() as {port:number}).port;assert.notEqual(port,3131);
    browser=await chromium.launch({headless:true,channel:"msedge"});const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const apiRequests:Array<{method:string;path:string;body:unknown}>=[];page.on("request",request=>{if(["POST","PUT"].includes(request.method())&&request.url().includes("/api/"))apiRequests.push({method:request.method(),path:new URL(request.url()).pathname,body:request.postDataJSON()});});
    await page.goto(`http://127.0.0.1:${port}/task-monitor/?mode=task-mode`);
    await page.getByRole("button",{name:"新建任务",exact:true}).first().click();
    await page.getByRole("textbox",{name:"任务名称",exact:true}).fill("Quick published real execution");
    await page.getByLabel("归属项目",{exact:true}).selectOption("Quick isolated project");
    await page.getByRole("dialog",{name:"新建任务",exact:true}).locator('.tiptap').fill("创建 quick-result.cjs，使其导出42，实际运行验证并生成报告，全程不分配Worker。");
    await page.getByLabel("执行模式",{exact:true}).selectOption("quick");
    await page.screenshot({path:path.join(evidence,"browser-publish.png"),fullPage:true});
    let failSettings=true;await page.route("**/api/task-mode/tasks/*/settings",async route=>{if(failSettings){failSettings=false;await route.fulfill({status:500,contentType:"application/json",body:JSON.stringify({error:{message:"isolated settings failure"}})});}else await route.continue();});
    await page.getByRole("button",{name:"创建并开始执行",exact:true}).click();
    await page.getByRole("alert").filter({hasText:"isolated settings failure"}).waitFor();
    assert.equal(manager.calls.filter(call=>call.method==="turn/start").length,0);
    assert.equal(await page.getByLabel("执行模式",{exact:true}).inputValue(),"quick");
    await page.getByRole("dialog",{name:"新建任务",exact:true}).getByRole("button",{name:"关闭",exact:true}).click();
    await page.getByRole("button",{name:"新建任务",exact:true}).first().click();
    await page.waitForFunction(()=>document.querySelector<HTMLSelectElement>('select[aria-label="执行模式"]')?.value==="quick");
    assert.equal(await page.getByLabel("执行模式",{exact:true}).inputValue(),"quick");
    assert.equal(fs.existsSync(path.join(directory,"quick-result.cjs")),false);
    await page.getByRole("button",{name:"创建并开始执行",exact:true}).click();
    await page.getByText("快速模式 · 消息代理直接执行",{exact:true}).waitFor();
    const deadline=Date.now()+15000;let task=store.list().tasks.find(task=>task.title==="Quick published real execution")!;
    while(mode.detail(task.id).state.phase!=="needs_confirmation"){assert.ok(Date.now()<deadline,JSON.stringify(mode.detail(task.id).state));await new Promise(resolve=>setTimeout(resolve,30));}
    await page.reload();await page.getByText("全程不分配 Worker",{exact:true}).waitFor();
    assert.equal(await page.getByText(/最多 \d+ 个 Worker/).count(),0);assert.equal(await page.getByText("Worker 已接收",{exact:true}).count(),0);
    const persisted=mode.data.get(task.id)!;assert.equal(persisted.settings.executionMode,"quick");assert.equal(persisted.runs[0].settings.executionMode,"quick");assert.deepEqual(persisted.runs[0].jobs.map(job=>job.role),["execute"]);
    assert.equal(persisted.instructions[0].deliveries.length,0);assert.equal(persisted.instructions[0].workerReceivedAt,undefined);
    const bindings=store.listConversationBindings(task.id);assert.equal(bindings.length,1);assert.equal(bindings[0].isPrimary,true);
    assert.equal(fs.readFileSync(path.join(directory,"quick-result.cjs"),"utf8"),"module.exports = 42;\n");
    assert.equal(persisted.runs[0].result!.verification[0].result,"passed");assert.equal(persisted.runs[0].result!.changes.length,1);assert.equal(persisted.runs[0].result!.artifacts.length,1);
    const turnCall=manager.calls.find(call=>call.method==="turn/start")!;assert.equal(turnCall.params.sandboxPolicy.type,"workspaceWrite");assert.equal(turnCall.params.approvalsReviewer,"auto_review");
    const settingsIndex=apiRequests.findLastIndex(request=>request.path.endsWith("/settings")),instructionIndex=apiRequests.findIndex(request=>request.path.endsWith("/instructions"));assert.ok(settingsIndex<instructionIndex);assert.equal(manager.calls.filter(call=>call.method==="turn/start").length,1);
    await page.screenshot({path:path.join(evidence,"browser-quick.png"),fullPage:true});
    await page.getByRole("button",{name:"验收通过",exact:true}).click();
    await page.getByText("本轮已完成，可继续追加",{exact:true}).waitFor();
    const final=mode.data.get(task.id)!;
    fs.writeFileSync(path.join(evidence,"browser-evidence.json"),JSON.stringify({result:"passed",port,temporaryProject:directory,taskId:task.id,settingsFailureRetainedDraft:true,restoredSelection:"quick",settingsBeforeSubmission:true,actualSource:fs.readFileSync(path.join(directory,"quick-result.cjs"),"utf8"),persistedState:final,bindings,rpcCalls:manager.calls,threads:[...manager.threads.values()],apiRequests,executorBoundary:"Real React production build + real routers + real scheduler + temporary SQLite. Auth fixture; deterministic app-server protocol fixture actually spawns node to write code and validate, not a real Codex model or OS sandbox."},null,2));
    fs.copyFileSync(path.join(directory,"quick-result.cjs"),path.join(evidence,"executed-quick-result.cjs"));fs.copyFileSync(path.join(directory,"execution-review.md"),path.join(evidence,"executed-review.md"));
    console.log(JSON.stringify({result:"passed",buildDirectory:build,evidenceDirectory:evidence}));
  }finally{
    await browser?.close();
    // Close this fixture's SSE sockets too, so server.close cannot wait indefinitely.
    server?.closeAllConnections();
    await new Promise<void>(resolve=>server?server.close(()=>resolve()):resolve());
    mode.close();conversations.close();store.close();fs.rmSync(directory,{recursive:true,force:true});
  }
});
