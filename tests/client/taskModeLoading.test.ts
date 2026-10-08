import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Server, ServerResponse } from "node:http";
import express from "express";
import { chromium, expect } from "@playwright/test";
import { TaskStore } from "../../src/server/tasks/taskStore.js";
import { TaskConversationService } from "../../src/server/tasks/taskConversationService.js";
import { TaskModeService } from "../../src/server/tasks/taskModeService.js";
import { createTaskRouter } from "../../src/server/tasks/taskRouter.js";
import { createTaskModeRouter } from "../../src/server/tasks/taskModeRouter.js";
import type { CodexConversationManager } from "../../src/server/codexConversationManager.js";
import { DEFAULT_TASK_MODE_SETTINGS, DEFAULT_TASK_MODE_VIEW } from "../../src/shared/taskModeTypes.js";
import { ControlledExecutor } from "../fixtures/taskModeQuickExecutor.js";

// Build once in isolation:
// npx vite build --config vite.task-monitor.config.ts --outDir data/task-contexts/TA-8/loading-performance/frontend/build
// TASK_MODE_LOADING_BUILD_DIR and TASK_MODE_LOADING_EVIDENCE_DIR override the default build/evidence directories.
// node --import tsx --test tests/client/taskModeLoading.test.ts
test("main task area loads independently and refreshes safely with delayed auxiliary catalogs", {timeout:150000}, async()=>{
  const root=path.resolve(import.meta.dirname,"../..");
  const build=path.resolve(process.env.TASK_MODE_LOADING_BUILD_DIR??path.join(root,"data/task-contexts/TA-8/loading-performance/frontend/build"));
  assert.ok(fs.existsSync(path.join(build,"task-monitor.html")),"Build the isolated TaskMonitor bundle first");
  const evidence=path.resolve(process.env.TASK_MODE_LOADING_EVIDENCE_DIR??path.join(root,"data/task-contexts/TA-8/loading-performance/frontend/evidence"));
  fs.mkdirSync(evidence,{recursive:true});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"apron-loading-isolated-"));
  const store=new TaskStore(directory),manager=new ControlledExecutor();
  const conversations=new TaskConversationService(store,manager as unknown as CodexConversationManager),mode=new TaskModeService(conversations,{pollMs:10000});
  const project="Loading isolated project";
  store.createProject({name:project,rootDirectory:directory,descriptionMd:"Controlled auxiliary catalog"});
  const first=store.create({title:"First loading task",descriptionMd:"First original requirement",project,repositoryPath:directory});
  const second=store.create({title:"Second loading task",descriptionMd:"Second original requirement",project,repositoryPath:directory});
  const archived=store.create({title:"Archived loading task",descriptionMd:"Archived original requirement",project,repositoryPath:directory});store.archive(archived.id);
  const defaults={...DEFAULT_TASK_MODE_SETTINGS,executionMode:"quick" as const,permissionPreset:"read_only" as const,maxWorkers:1};
  mode.data.saveSettings(defaults);mode.data.saveView({...structuredClone(DEFAULT_TASK_MODE_VIEW),layout:"desk"});
  const doc=mode.data.saveDocument({title:"Late document",markdown:"Late document content"});
  type Gate="ok"|"hold"|"500"|"401";
  const gates=new Map<string,Gate>([["/api/tasks/projects","hold"],["/api/task-mode/documents","hold"],["/api/task-mode/settings","hold"],["/api/task-mode/view","hold"]]);
  const pending=new Map<string,Array<()=>void>>(),counts=new Map<string,number>(),sse=new Set<ServerResponse>();
  const checks:Array<{scenario:string;result:string;details:unknown}>=[],timings:Record<string,number>={};
  const writes:Array<{path:string;body:any}>=[];
  const release=(key:string)=>{gates.set(key,"ok");for(const send of pending.get(key)??[])send();pending.delete(key);};
  const count=(key:string)=>counts.get(key)??0;
  const app=express();app.use(express.json({limit:"1mb"}));
  app.use((req,res,next)=>{
    res.locals.user={name:"loading-isolated",method:"none"};
    const key=req.path==="/api/task-mode/"?"/api/task-mode":req.path;
    if(req.method!=="GET"){writes.push({path:key,body:req.body});next();return;}
    counts.set(key,count(key)+1);
    if(key==="/api/task-mode/events"){sse.add(res);res.once("close",()=>sse.delete(res));}
    const gate=gates.get(key)??"ok";
    if(gate==="500"||gate==="401"){res.status(Number(gate)).json({error:{message:`controlled ${gate} ${key}`}});return;}
    if(gate!=="hold"){next();return;}
    // Snapshot at receipt makes old list/detail responses genuinely stale when released.
    const snapshot=key==="/api/tasks/projects"?store.projects():key==="/api/task-mode/documents"?{documents:mode.data.documents()}:key==="/api/task-mode/settings"?mode.data.settings():key==="/api/task-mode/view"?mode.data.view():key==="/api/task-mode"?mode.list(req.query.archived==="true"):key.startsWith("/api/task-mode/tasks/")?mode.detail(key.split("/").at(-1)!,req.query.view==="workspace"):undefined;
    const requests=pending.get(key)??[];requests.push(()=>{if(!res.destroyed)res.json(snapshot);});pending.set(key,requests);
  });
  app.get("/api/me",(_req,res)=>res.json({name:"loading-isolated",method:"none"}));
  app.get("/api/auth/config",(_req,res)=>res.json({methods:["password"],user:"loading-isolated"}));
  app.use("/api/tasks",createTaskRouter(async()=>store));app.use("/api/task-mode",createTaskModeRouter(async()=>mode));
  app.use("/task-monitor",express.static(build,{dotfiles:"allow"}));app.get("/task-monitor/",(_req,res)=>res.sendFile(path.join(build,"task-monitor.html"),{dotfiles:"allow"}));
  let server:Server|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    server=await new Promise<Server>((resolve,reject)=>{const value=app.listen(0,"127.0.0.1",()=>resolve(value));value.once("error",reject);});
    const port=(server.address() as {port:number}).port;assert.notEqual(port,3131);
    browser=await chromium.launch({headless:true,channel:"msedge"});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors:string[]=[];page.on("pageerror",error=>errors.push(error.message));
    const url=`http://127.0.0.1:${port}/task-monitor/?mode=task-mode&task=${first.id}`;
    const start=performance.now();await page.goto(url);
    await expect.poll(()=>count("/api/task-mode/view")).toBeGreaterThan(0);
    await expect(page.getByRole("heading",{name:first.title,exact:true})).toBeVisible();
    await page.getByRole("textbox",{name:"下一步指示",exact:true}).fill("Task is interactive before settings and view respond");
    await expect(page.getByRole("button",{name:"工作台",exact:true})).toBeDisabled();
    assert.equal(writes.filter(entry=>entry.path.endsWith("/instructions")).length,0);
    release("/api/task-mode/settings");
    await expect(page.getByRole("heading",{name:first.title,exact:true})).toBeVisible();
    release("/api/task-mode/view");
    await expect(page.getByRole("heading",{name:first.title,exact:true})).toBeVisible();
    await page.getByRole("textbox",{name:"下一步指示",exact:true}).fill("Main area is interactive before auxiliary response");
    timings.detailInteractiveFromNavigationMs=performance.now()-start;
    assert.ok((pending.get("/api/tasks/projects")?.length??0)>0);
    assert.ok((pending.get("/api/task-mode/documents")?.length??0)>0);
    await expect(page.locator("#tp-task-mode")).toHaveAttribute("data-layout","desk");
    await page.getByRole("button",{name:"引用",exact:true}).click();
    await expect(page.locator(".tm-reference-picker")).toHaveCount(0);
    await expect(page.getByText("关联文档尚未就绪",{exact:false})).toBeVisible();
    await page.getByRole("button",{name:"编辑需求",exact:true}).click();
    await expect(page.getByRole("dialog",{name:"编辑任务",exact:true})).toBeVisible();
    await expect(page.getByRole("textbox",{name:"任务名称",exact:true})).toHaveCount(0);
    await page.getByRole("dialog",{name:"编辑任务",exact:true}).getByRole("button",{name:"关闭",exact:true}).click();
    // Actual click + subsequent editor fill are the timing end points, not fetch dispatch.
    await page.locator(`[data-task-id="${second.id}"]`).click();
    await expect(page.getByRole("heading",{name:second.title,exact:true})).toBeVisible();
    await page.getByRole("textbox",{name:"下一步指示",exact:true}).fill("Second detail also interactive");
    timings.listAndSecondDetailInteractiveFromNavigationMs=performance.now()-start;
    await page.getByRole("button",{name:"新建任务",exact:true}).click();
    await expect(page.getByRole("dialog",{name:"新建任务",exact:true})).toBeVisible();
    await expect(page.getByRole("textbox",{name:"任务名称",exact:true})).toHaveCount(0);
    assert.equal(writes.filter(entry=>entry.path.endsWith("/instructions")).length,0);
    await page.screenshot({path:path.join(evidence,"slow-catalogs-main-ready.png"),fullPage:true});
    timings.projectsReleasedFromNavigationMs=performance.now()-start;release("/api/tasks/projects");
    await expect(page.getByRole("textbox",{name:"任务名称",exact:true})).toHaveCount(0);
    timings.documentsReleasedFromNavigationMs=performance.now()-start;release("/api/task-mode/documents");
    await expect(page.getByRole("textbox",{name:"任务名称",exact:true})).toBeVisible();
    await expect(page.getByLabel("执行模式",{exact:true})).toHaveValue("quick");
    await expect(page.getByLabel("归属项目",{exact:true}).locator("option",{hasText:project})).toHaveCount(1);
    timings.formReadyAfterCatalogReleaseFromNavigationMs=performance.now()-start;
    await page.getByRole("dialog",{name:"新建任务",exact:true}).getByRole("button",{name:"关闭",exact:true}).click();
    await page.getByRole("button",{name:"引用",exact:true}).click();
    await expect(page.getByRole("button",{name:`文档 · ${doc.title}`,exact:true})).toBeVisible();
    await page.getByRole("button",{name:`文档 · ${doc.title}`,exact:true}).click();
    checks.push({scenario:"slow catalogs and settings/view do not block task reads; editor/reference retain catalog gates",result:"passed",details:{timings,pendingAuxiliaryRequestsAtInteractive:true,layout:"desk",executionMode:"quick"}});

    // A real updated requirement reaches the current detail while list and projects are held.
    await expect.poll(()=>pending.get("/api/task-mode")?.length??0).toBe(0);
    gates.set("/api/task-mode","hold");gates.set("/api/tasks/projects","hold");
    await page.locator(".tm-original-fold > summary").click();
    const updateStart=performance.now();store.update(second.id,{descriptionMd:"Actual refreshed requirement version",revision:store.get(second.id)!.revision});
    await expect(page.getByText("Actual refreshed requirement version",{exact:true})).toBeVisible();
    timings.detailVersionInteractiveDuringHeldListMs=performance.now()-updateStart;
    await expect.poll(()=>pending.get("/api/task-mode")?.length??0).toBeGreaterThan(0);
    checks.push({scenario:"current detail refresh applies independently of held list",result:"passed",details:{ms:timings.detailVersionInteractiveDuringHeldListMs,revision:store.get(second.id)!.revision}});
    release("/api/task-mode");release("/api/tasks/projects");

    // Rapid selections release an old first-detail snapshot only after second detail is usable.
    gates.set(`/api/task-mode/tasks/${first.id}`,"hold");
    await page.locator(`[data-task-id="${first.id}"]`).click();
    await expect.poll(()=>pending.get(`/api/task-mode/tasks/${first.id}`)?.length??0).toBeGreaterThan(0);
    await expect(page.getByRole("heading",{name:first.title,exact:true})).toBeVisible();
    await page.getByRole("textbox",{name:"下一步指示",exact:true}).fill("Cached task remains interactive while validation is held");
    await page.locator(`[data-task-id="${second.id}"]`).click();
    await expect(page.getByRole("heading",{name:second.title,exact:true})).toBeVisible();
    release(`/api/task-mode/tasks/${first.id}`);
    await page.waitForTimeout(250);
    await expect(page.getByRole("heading",{name:second.title,exact:true})).toBeVisible();
    checks.push({scenario:"late detail cannot overwrite newer selection",result:"passed",details:{selected:second.id}});

    // Capture stale current-list requests; switch archives before allowing any to return.
    gates.set("/api/task-mode","hold");mode.emit("change",{taskId:second.id});
    await expect.poll(()=>pending.get("/api/task-mode")?.length??0).toBeGreaterThan(0);
    await page.locator(".tp-sidebar").getByRole("button",{name:"归档任务",exact:true}).click();
    await expect.poll(()=>pending.get("/api/task-mode")?.length??0).toBeGreaterThan(1);
    release("/api/task-mode");
    await expect(page.locator(`[data-task-id="${archived.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-task-id="${first.id}"]`)).toHaveCount(0);
    await page.locator(".tp-sidebar").getByRole("button",{name:/^任务板/}).click();
    await expect(page.locator(`[data-task-id="${first.id}"]`)).toBeVisible();
    checks.push({scenario:"late active list cannot overwrite archived list",result:"passed",details:{archivedTask:archived.id}});

    // Generic notifications keep core refresh/coalescing but don't re-read the project catalog.
    await page.waitForTimeout(500);const projectsBefore=count("/api/tasks/projects"),listsBefore=count("/api/task-mode");
    for(let index=0;index<15;index++)mode.emit("change",{taskId:second.id});
    await expect.poll(()=>count("/api/task-mode")).toBeGreaterThan(listsBefore);await page.waitForTimeout(350);
    assert.equal(count("/api/tasks/projects"),projectsBefore);
    assert.ok(count("/api/task-mode")-listsBefore<=2,"burst notifications must stay coalesced");
    store.updateProject(project,{descriptionMd:"Changed real project description"});
    await expect.poll(()=>count("/api/tasks/projects")).toBeGreaterThan(projectsBefore);
    await page.getByRole("button",{name:/^项目/}).first().click();
    await expect(page.getByText("Changed real project description",{exact:true})).toBeVisible();
    checks.push({scenario:"generic SSE coalesces without projects; real project change refreshes",result:"passed",details:{genericEvents:15,projectsDuringBurst:0}});

    const reconnectProjects=count("/api/tasks/projects"),connections=count("/api/task-mode/events");
    for(const response of sse)response.end();
    await expect.poll(()=>count("/api/task-mode/events"),{timeout:10000}).toBeGreaterThan(connections);
    await expect.poll(()=>count("/api/tasks/projects")).toBeGreaterThan(reconnectProjects);
    await expect(page.getByText("任务实时同步",{exact:true})).toBeVisible();
    checks.push({scenario:"SSE disconnect/reconnect refreshes catalogs and resumes connected UI",result:"passed",details:{connectionsBefore:connections,connectionsAfter:count("/api/task-mode/events")}});
    const fallbackBefore=count("/api/task-mode/documents");
    const fallbackDoc=mode.data.saveDocument({title:"Fallback document",markdown:"No SSE emitted for this saved document"});
    await expect.poll(()=>count("/api/task-mode/documents"),{timeout:35000}).toBeGreaterThan(fallbackBefore);
    await page.getByRole("button",{name:"关联文档",exact:true}).click();
    await expect(page.getByRole("button",{name:fallbackDoc.title,exact:true})).toBeVisible();
    checks.push({scenario:"30-second catalog fallback retrieves document without SSE",result:"passed",details:{documentId:fallbackDoc.id}});

    // A save must read again after an older in-flight catalog response completes.
    gates.set("/api/task-mode/documents","hold");
    await page.evaluate(()=>window.dispatchEvent(new Event("focus")));
    await expect.poll(()=>pending.get("/api/task-mode/documents")?.length??0).toBeGreaterThan(0);
    await page.getByRole("button",{name:doc.title,exact:true}).click();
    await page.getByRole("textbox",{name:"文档名称",exact:true}).fill("Renamed after in-flight catalog");
    await page.getByRole("button",{name:"保存文档",exact:true}).click();
    await expect.poll(()=>mode.data.document(doc.id)?.title).toBe("Renamed after in-flight catalog");
    release("/api/task-mode/documents");
    await expect(page.getByRole("button",{name:"Renamed after in-flight catalog",exact:true})).toBeVisible();
    checks.push({scenario:"document save re-reads after stale in-flight catalog",result:"passed",details:{documentId:doc.id}});

    // Fresh navigation with independently failed catalogs must show tasks + retryable errors.
    gates.set("/api/tasks/projects","500");gates.set("/api/task-mode/documents","500");
    await page.goto(url);await expect(page.getByRole("heading",{name:first.title,exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"重试项目目录",exact:true})).toBeVisible();
    await expect(page.getByRole("button",{name:"重试关联文档",exact:true})).toBeVisible();
    await page.getByRole("button",{name:"新建任务",exact:true}).click();
    await expect(page.getByRole("textbox",{name:"任务名称",exact:true})).toHaveCount(0);
    gates.set("/api/tasks/projects","ok");
    await page.getByRole("dialog",{name:"新建任务",exact:true}).getByRole("button",{name:"重试项目目录",exact:true}).click();
    await expect(page.getByRole("textbox",{name:"任务名称",exact:true})).toHaveCount(0);
    gates.set("/api/task-mode/documents","ok");
    await page.getByRole("dialog",{name:"新建任务",exact:true}).getByRole("button",{name:"重试关联文档",exact:true}).click();
    await expect(page.getByRole("textbox",{name:"任务名称",exact:true})).toBeVisible();
    checks.push({scenario:"auxiliary 500 leaves main usable; independent retries unlock form",result:"passed",details:{projectsRetry:true,documentsRetry:true}});

    // Exercise real publish persistence with restored quick + read-only defaults.
    await page.getByRole("textbox",{name:"任务名称",exact:true}).fill("Published after loading gates");
    await page.getByLabel("归属项目",{exact:true}).selectOption(project);
    await page.getByRole("dialog",{name:"新建任务",exact:true}).locator(".tiptap").fill("Persist correct settings before publishing");
    await expect(page.getByLabel("执行模式",{exact:true})).toHaveValue("quick");
    const publishWrites=writes.length;await page.getByRole("button",{name:"创建并开始执行",exact:true}).click();
    await expect(page.getByRole("heading",{name:"Published after loading gates",exact:true})).toBeVisible();
    const created=store.list().tasks.find(task=>task.title==="Published after loading gates")!;
    const state=mode.data.get(created.id)!;
    assert.equal(state.settings.executionMode,"quick");assert.equal(state.settings.permissionPreset,"read_only");
    assert.equal(state.instructions.length,1);assert.equal(state.instructions[0].snapshot.project?.rootDirectory,directory);
    const publishRequests=writes.slice(publishWrites),settingsIndex=publishRequests.findIndex(entry=>entry.path.endsWith("/settings")),instructionIndex=publishRequests.findIndex(entry=>entry.path.endsWith("/instructions"));
    assert.ok(settingsIndex>=0&&settingsIndex<instructionIndex);
    checks.push({scenario:"real publish persists restored settings before instruction",result:"passed",details:{taskId:created.id,executionMode:state.settings.executionMode,permissionPreset:state.settings.permissionPreset,settingsIndex,instructionIndex}});

    gates.set("/api/task-mode","hold");gates.set(`/api/task-mode/tasks/${created.id}`,"401");
    mode.emit("change",{taskId:created.id});
    await expect(page.locator('input[type="password"]')).toBeVisible();
    assert.ok((pending.get("/api/task-mode")?.length??0)>0);
    release("/api/task-mode");gates.set(`/api/task-mode/tasks/${created.id}`,"ok");
    checks.push({scenario:"detail refresh 401 revokes UI while sibling list remains held",result:"passed",details:{taskId:created.id}});

    // Both API error classes must revoke the page on 401 (including late auxiliary results).
    for(const endpoint of ["/api/tasks/projects","/api/task-mode/documents","/api/task-mode/settings","/api/task-mode/view","/api/task-mode",`/api/task-mode/tasks/${first.id}`]){
      gates.set(endpoint,"401");await page.goto(url);
      await expect(page.locator("#tp-task-mode")).toHaveCount(0);
      await expect(page.locator('input[type="password"]')).toBeVisible();
      gates.set(endpoint,"ok");checks.push({scenario:`401 ${endpoint} revokes task page`,result:"passed",details:{endpoint}});
    }
    assert.deepEqual(errors,[]);
    const source=fs.readFileSync(path.join(root,"src/client/task-mode/TaskModePage.tsx"));
    fs.writeFileSync(path.join(evidence,"loading-evidence.json"),JSON.stringify({result:"passed",port,build,directory,sourceSha256:createHash("sha256").update(source).digest("hex"),timings,checks,counts:Object.fromEntries(counts),errors,boundary:"Real production React bundle + real Express routers/services + isolated temporary SQLite. Auth and Codex app-server are fixtures. Held/failed API responses are controlled middleware; timings prove interaction before release, not production speedup."},null,2));
    console.log(JSON.stringify({result:"passed",port,evidence,timings,scenarios:checks.length}));
  }catch(error){
    fs.writeFileSync(path.join(evidence,"loading-failure.json"),JSON.stringify({error:String(error),checks,timings,counts:Object.fromEntries(counts)},null,2));throw error;
  }finally{
    await browser?.close();for(const response of sse)response.end();server?.closeAllConnections();
    await new Promise<void>(resolve=>server?server.close(()=>resolve()):resolve());
    mode.close();conversations.close();store.close();
    // Retain the isolated synthetic data directory for diagnosis; never touch production data.
  }
});
