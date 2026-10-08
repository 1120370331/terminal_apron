import type { TaskAttachmentUploadResponse } from "../../shared/taskTypes";
import type { TaskRunReportDocument } from "../../shared/taskArtifactTypes";
import type { TaskExecutionJob, TaskRunResult, TaskModeAction, TaskModeDetail, TaskModeDocument, TaskModeList, TaskModeSettings, TaskModeViewPreferences, SubmitTaskInstruction } from "../../shared/taskModeTypes";
import type { TaskConversationModel } from "../../shared/taskConversationTypes";
import type { CodexInfo, CodexGlobalSettingsSnapshot, UpdateCodexGlobalSettings } from "../../shared/codexInfoTypes";
import type { RelayUsageRates } from "../../shared/taskUsageTypes";

export class TaskModeApiError extends Error { constructor(message:string,readonly status:number){super(message);} }
async function request<T>(path:string,body?:unknown,method=body===undefined?"GET":"POST"):Promise<T> {
  const response=await fetch(`/api/task-mode${path}`,{method,credentials:"include",headers:body instanceof FormData?undefined:body!==undefined?{"Content-Type":"application/json"}:undefined,body:body instanceof FormData?body:body!==undefined?JSON.stringify(body):undefined});
  const result=await response.json();if(!response.ok)throw new TaskModeApiError(typeof result.error==="string"?result.error:result.error?.message??"请求失败",response.status);return result as T;
}
export const taskModeApi={
  list:(archived=false)=>request<TaskModeList>(`/${archived?"?archived=true":""}`),
  detail:(id:string)=>request<TaskModeDetail>(`/tasks/${encodeURIComponent(id)}?view=workspace`),
  executionItems:(taskId:string,runId:string,jobId:string)=>request<{items:TaskExecutionJob["items"]}>(`/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobId)}/items`),
  runChanges:(taskId:string,runId:string)=>request<{changes:TaskRunResult["changes"]}>(`/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/changes`),
  runReport:(taskId:string,runId:string)=>request<TaskRunReportDocument>(`/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/report`),
  settings:()=>request<TaskModeSettings>("/settings"),
  saveSettings:(settings:TaskModeSettings,taskId?:string,fullAccessConfirmed=false)=>request<TaskModeSettings>(taskId?`/tasks/${encodeURIComponent(taskId)}/settings`:"/settings",{...settings,fullAccessConfirmed},"PUT"),
  models:()=>request<{models:TaskConversationModel[]}>("/models"),
  codexInfo:(refresh=false)=>request<CodexInfo>(`/codex-info${refresh?"?refresh=1":""}`),
  saveCodexSettings:(value:UpdateCodexGlobalSettings)=>request<CodexGlobalSettingsSnapshot>("/codex-info/settings",value,"PUT"),
  usageRates:()=>request<RelayUsageRates|null>("/usage-rates"),
  saveUsageRates:(value:RelayUsageRates)=>request<RelayUsageRates>("/usage-rates",value,"PUT"),
  view:()=>request<TaskModeViewPreferences>("/view"),
  saveView:(view:TaskModeViewPreferences)=>request<TaskModeViewPreferences>("/view",view,"PUT"),
  documents:()=>request<{documents:TaskModeDocument[]}>("/documents"),
  saveDocument:(document:{id?:string;title:string;markdown:string;revision?:number})=>request<TaskModeDocument>("/documents",document),
  submit:(id:string,input:SubmitTaskInstruction)=>request<TaskModeDetail>(`/tasks/${encodeURIComponent(id)}/instructions?view=workspace`,input),
  instructionAction:(taskId:string,instructionId:string,action:"archive"|"restore"|"delete")=>request<TaskModeDetail>(`/tasks/${encodeURIComponent(taskId)}/instructions/${encodeURIComponent(instructionId)}${action==="delete"?"":`/${action}`}?view=workspace`,undefined,action==="delete"?"DELETE":"POST"),
  action:(id:string,action:TaskModeAction,runId?:string,expected?:{approvalTokens:string[];authorizationRevision:number})=>request<TaskModeDetail>(`/tasks/${encodeURIComponent(id)}/actions?view=workspace`,{action,runId,...expected}),
  upload:(id:string,files:File[])=>{const form=new FormData();files.forEach(file=>form.append("files",file,file.name||"screenshot.png"));return request<TaskAttachmentUploadResponse>(`/tasks/${encodeURIComponent(id)}/attachments`,form);}
};
