import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import type { AuthUser } from "../../shared/types.js";
import { DEFAULT_TASK_MODE_VIEW, type SubmitTaskInstruction, type TaskModeViewPreferences } from "../../shared/taskModeTypes.js";
import { TaskModeError, TaskModeService } from "./taskModeService.js";
import { TaskConversationServiceError } from "./taskConversationService.js";
import { attachmentDelivery, validateScreenshot } from "./taskRouter.js";
import { config } from "../config.js";
import { CodexInfoError } from "../codexInfoService.js";
import { projectTaskWorkspace } from "./taskModeWorkspace.js";
import type { TaskModeDetail } from "../../shared/taskModeTypes.js";

type Provider=(user:AuthUser)=>Promise<TaskModeService>;
const upload=multer({storage:multer.memoryStorage(),limits:{files:8,fileSize:10*1024*1024}}).array("files",8);
export function createTaskModeRouter(provider:Provider) {
  const router=Router();
  const route=(handler:(req:Request,res:Response,service:TaskModeService)=>Promise<unknown>|unknown)=>(req:Request,res:Response,next:NextFunction)=>{void provider(res.locals.user as AuthUser).then(service=>handler(req,res,service)).catch(next);};
  router.get("/",route((req,res,service)=>res.json(service.list(req.query.archived==="true"))));
  router.get("/models",route(async(_req,res,service)=>res.json(await service.conversations.models())));
  router.get("/usage-rates",route((_req,res,service)=>res.json(service.conversations.usage.rates())));
  router.put("/usage-rates",route((req,res,service)=>res.json(service.conversations.usage.saveRates(req.body))));
  router.get("/codex-info",route(async(req,res,service)=>res.json({...await service.codexInfo.read(req.query.refresh==="1"),canEditSettings:(res.locals.user as AuthUser).name===config.adminUser})));
  router.put("/codex-info/settings",route(async(req,res,service)=>{
    if((res.locals.user as AuthUser).name!==config.adminUser)throw new CodexInfoError(403,"只有 Apron 管理员可以修改本机 Codex 全局设置");
    res.json(await service.codexInfo.save(req.body));
  }));
  router.get("/settings",route((_req,res,service)=>res.json(service.data.settings())));
  router.put("/settings",route(async(req,res,service)=>res.json(await service.settings(req.body))));
  router.get("/view",route((_req,res,service)=>res.json(service.data.view())));
  router.put("/view",route((req,res,service)=>{const view=validateView(req.body);service.data.saveView(view);res.json(view);}));
  router.get("/documents",route((_req,res,service)=>res.json({documents:service.data.documents()})));
  router.post("/documents",route((req,res,service)=>{const title=String(req.body?.title??"").trim(),markdown=String(req.body?.markdown??"");if(!title||title.length>200||markdown.length>100000)throw new TaskModeError(400,"文档需要标题，正文最多 100000 字符");res.json(service.data.saveDocument({id:typeof req.body.id==="string"?req.body.id:undefined,title,markdown,revision:req.body.revision}));}));
  router.get("/events",route((_req,res,service)=>{
    res.status(200).set({"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-cache, no-transform",Connection:"keep-alive"});res.flushHeaders();res.write("retry: 2000\ndata: {}\n\n");
    const listener=(event:unknown)=>{if(!res.writableEnded)res.write(`data: ${JSON.stringify(event)}\n\n`);};service.on("change",listener);
    const unsubscribe=service.conversations.store.subscribe(listener);const timer=setInterval(()=>res.write(": heartbeat\n\n"),15000);timer.unref();res.once("close",()=>{clearInterval(timer);unsubscribe();service.off("change",listener);});
  }));
  const sendDetail=(req:Request,res:Response,detail:TaskModeDetail)=>res.json(req.query.view==="workspace"?{...detail,state:projectTaskWorkspace(detail.state)}:detail);
  router.get("/tasks/:taskId",route((req,res,service)=>res.json(service.detail(param(req,"taskId"),req.query.view==="workspace"))));
  router.get("/tasks/:taskId/runs/:runId/changes",route((req,res,service)=>res.json(service.runChanges(param(req,"taskId"),param(req,"runId")))));
  router.get("/tasks/:taskId/runs/:runId/jobs/:jobId/items",route((req,res,service)=>res.json(service.executionItems(param(req,"taskId"),param(req,"runId"),param(req,"jobId")))));
  router.get("/tasks/:taskId/runs/:runId/report",route((req,res,service)=>{
    const report=service.runReport(param(req,"taskId"),param(req,"runId"));res.set("Cache-Control","private, no-store");
    if(req.query.download==="1")return res.type("text/markdown; charset=utf-8").set("Content-Disposition",`attachment; filename="${report.taskKey}-result-${report.runId.slice(0,8)}.md"`).send(report.markdown);
    return res.json(report);
  }));
  router.get("/tasks/:taskId/instructions/:instructionId/attachments/:attachmentId",route((req,res,service)=>{
    const taskId=param(req,"taskId"),detail=service.detail(taskId);
    const instruction=detail.state.instructions.find(item=>item.id===param(req,"instructionId"));
    const attachment=instruction?.snapshot.attachments.find(item=>item.id===param(req,"attachmentId"));
    if(!attachment)throw new TaskModeError(404,"需求快照附件不存在");
    const root=fs.realpathSync(service.conversations.store.attachmentDirectory(taskId));
    const target=fs.realpathSync(attachment.snapshotPath),relative=path.relative(root,target);
    if(relative.startsWith("..")||path.isAbsolute(relative))throw new TaskModeError(404,"快照附件不可访问");
    const delivery=attachmentDelivery(attachment.name,attachment.snapshotPath,attachment.mimeType,req.query.download==="1");
    res.set({"Content-Type":delivery.contentType,"X-Content-Type-Options":"nosniff","Content-Disposition":delivery.disposition,"Cache-Control":"private, no-store"});res.sendFile(target);
  }));
  router.put("/tasks/:taskId/settings",route(async(req,res,service)=>res.json(await service.settings(req.body,param(req,"taskId")))));
  router.post("/tasks/:taskId/instructions",route(async(req,res,service)=>{
    const input=req.body as SubmitTaskInstruction;
    for(const key of ["attachmentIds","referenceTaskIds","documentIds"] as const)if(input[key]!==undefined&&(!Array.isArray(input[key])||(key!=="attachmentIds"&&input[key]!.length>32)||input[key]!.some(value=>typeof value!=="string"||value.length>100)))throw new TaskModeError(400,"引用列表无效");
    sendDetail(req,res.status(202),await service.submit(param(req,"taskId"),input));
  }));
  router.post("/tasks/:taskId/instructions/:instructionId/:action",route(async(req,res,service)=>{
    const action=param(req,"action");if(!["archive","restore"].includes(action))throw new TaskModeError(400,"无效需求操作");
    sendDetail(req,res,await service.instructionAction(param(req,"taskId"),param(req,"instructionId"),action as "archive"|"restore"));
  }));
  router.delete("/tasks/:taskId/instructions/:instructionId",route(async(req,res,service)=>sendDetail(req,res,await service.instructionAction(param(req,"taskId"),param(req,"instructionId"),"delete"))));
  router.post("/tasks/:taskId/actions",route(async(req,res,service)=>{const action=req.body?.action;if(!["pause","resume","retry","approve","approve_authorization","reread_output","clarify_report"].includes(action))throw new TaskModeError(400,"无效操作");sendDetail(req,res,await service.action(param(req,"taskId"),action,req.body.runId,req.body));}));
  router.post("/tasks/:taskId/attachments",upload,route((req,res,service)=>{
    const taskId=param(req,"taskId");let task=service.detail(taskId).task;const files=Array.isArray(req.files)?req.files:[];if(!files.length)throw new TaskModeError(400,"请提供附件");
    // Validate the complete batch before writing anything. Active formats download as files.
    const checked=files.map(file=>["image/png","image/jpeg","image/webp","image/gif"].includes(file.mimetype)?validateScreenshot(file):{buffer:file.buffer,extension:path.extname(file.originalname).slice(1).replace(/[^a-zA-Z0-9]/g,"").slice(0,12)||"bin",mimeType:"application/octet-stream",originalName:file.originalname||"attachment"});
    const attachments=[];
    for(const file of checked){const known=new Set(task.attachments.map(a=>a.id));const storageName=`${crypto.randomUUID()}.${file.extension}`,destination=service.conversations.store.attachmentFilePath(taskId,storageName);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,file.buffer,{flag:"wx"});try{task=service.conversations.store.addAttachment(taskId,{name:file.originalName,storageName,mimeType:file.mimeType,size:file.buffer.length})!;attachments.push(task.attachments.find(a=>!known.has(a.id))!);}catch(error){fs.unlinkSync(destination);throw error;}}
    res.status(201).json({task,attachments});
  }));
  router.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{const status=error instanceof TaskModeError||error instanceof TaskConversationServiceError||error instanceof CodexInfoError?error.status:error instanceof multer.MulterError?413:400;res.status(status).json({error:{message:error instanceof Error?error.message:"Task Mode 操作失败",retryable:status>=500}});});
  return router;
}
function param(req:Request,key:string) {const value=req.params[key];return Array.isArray(value)?value[0]:value;}
function validateView(input:unknown):TaskModeViewPreferences {
  if(!input||typeof input!=="object"||Array.isArray(input))throw new TaskModeError(400,"无效的视图设置");
  const value=input as TaskModeViewPreferences;const fallback=structuredClone(DEFAULT_TASK_MODE_VIEW);
  if(!["board","desk","document"].includes(value.layout)||!["status","free"].includes(value.board))throw new TaskModeError(400,"无效版式");
  const list=(items:unknown)=>Array.isArray(items)?[...new Set(items.filter((item):item is string=>typeof item==="string"&&item.length<=100))].slice(0,10000):[];
  const filters=Object.fromEntries(Object.entries(fallback.filters).map(([key,defaultValue])=>[key,typeof value.filters?.[key as keyof typeof fallback.filters]==="string"?value.filters[key as keyof typeof fallback.filters].slice(0,500):defaultValue])) as TaskModeViewPreferences["filters"];
  if(!["createdAt","updatedAt","completedAt"].includes(filters.dateField))filters.dateField="updatedAt";
  return {layout:value.layout,board:value.board,taskOrder:list(value.taskOrder),columnOrder:list(value.columnOrder),masterWidth:Math.max(210,Math.min(480,Number(value.masterWidth)||300)),executionWidth:Math.max(280,Math.min(600,Number(value.executionWidth)||390)),filters};
}
