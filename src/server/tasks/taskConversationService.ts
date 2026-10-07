import crypto from "node:crypto";
import path from "node:path";
import type {
  CreateTaskConversationInput,
  EnsureTaskConversationResult,
  StartTaskTurnInput,
  SteerTaskTurnInput,
  TaskConversationBinding,
  TaskConversationDetail,
  TaskConversationOperationReceipt,
  TaskConversationPage,
  TaskConversationPreferences,
  TaskConversationSummary,
  TaskReasoningEffort,
  TaskApprovalsReviewer,
  UpdateTaskConversationPreferencesInput
} from "../../shared/taskConversationTypes.js";
import { projectThread } from "../codexConversationProjection.js";
import { CodexConversationManager } from "../codexConversationManager.js";
import { CodexRpcError } from "../codexAppServerClient.js";
import { TaskStore, TaskConversationConflictError, TaskValidationError } from "./taskStore.js";
import { TaskConversationProjectionCache } from "./taskConversationProjectionCache.js";
import { CodexInfoService } from "../codexInfoService.js";
import { TaskUsageService } from "./taskUsageService.js";

export class TaskConversationServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: Record<string, unknown> = {}) { super(message); }
}

interface TaskConversationServiceOptions {
  convergenceWaitMs?:number;
  convergencePollMs?:number;
  retryAfterMs?:number;
  staleGuardMs?:number;
}

// Internal orchestration options; the public conversation router never accepts these from request bodies.
export interface TaskExecutionOverrides { cwd?: string; developerInstructions?: string; outputSchema?: Record<string, unknown>; primary?: boolean; approvalsReviewer?: TaskApprovalsReviewer }

export class TaskConversationService {
  readonly codexInfo: CodexInfoService;
  readonly usage: TaskUsageService;
  readonly instanceId = crypto.randomUUID();
  private ownerHeartbeat?: NodeJS.Timeout;
  private readonly projections=new TaskConversationProjectionCache();
  private readonly defaultConversationCreates=new Map<string,Promise<EnsureTaskConversationResult>>();
  private readonly convergenceWaitMs:number;
  private readonly convergencePollMs:number;
  private readonly retryAfterMs:number;
  private readonly staleGuardMs:number;
  constructor(readonly store: TaskStore, readonly manager: CodexConversationManager, options:TaskConversationServiceOptions={}) {
    this.codexInfo = new CodexInfoService(manager);
    this.usage = new TaskUsageService(store, manager, this.codexInfo);
    this.usage.on("change", (event: { taskId: string; threadId?: string }) => { if (event.threadId && typeof manager.notifyUsage === "function") queueMicrotask(()=>{if(!this.usage.isClosed)manager.notifyUsage(event.taskId,event.threadId!,this.usage.thread(event.taskId,event.threadId!));}); });
    this.convergenceWaitMs=options.convergenceWaitMs??1_500;
    this.convergencePollMs=options.convergencePollMs??50;
    this.retryAfterMs=options.retryAfterMs??250;
    this.staleGuardMs=options.staleGuardMs??60_000;
    manager.on("event", (event: { kind: string; threadId?: string; turnId?: string; payload: Record<string, unknown> }) => {
      if(event.threadId&&event.kind!=="ready"&&event.kind!=="token_usage_updated")this.projections.invalidateThread(event.threadId);
      if (event.kind === "turn_completed" && event.threadId && event.turnId) this.store.completeConversationTurn(event.threadId, event.turnId, Boolean((event.payload.turn as { status?: string } | undefined)?.status === "failed"));
    });
  }

  async list(taskId: string): Promise<{ conversations: TaskConversationSummary[]; primaryThreadId?: string }> {
    this.requireTask(taskId);
    const bindings = this.store.listConversationBindings(taskId);
    const conversations = bindings.map((binding) => {
      this.manager.bindThread(taskId, binding.threadId);
      return summaryFromBinding(binding, "not_loaded");
    });
    return { conversations, primaryThreadId: bindings.find((binding) => binding.isPrimary)?.threadId };
  }

  async ensureDefault(taskId:string):Promise<EnsureTaskConversationResult>{
    this.requireTask(taskId);
    const existing=this.defaultBinding(taskId);
    if(existing)return{conversation:summaryFromBinding(existing,"not_loaded"),created:false};
    const inFlight=this.defaultConversationCreates.get(taskId);
    if(inFlight)return inFlight;
    const promise=this.createDefaultConversation(taskId).finally(()=>this.defaultConversationCreates.delete(taskId));
    this.defaultConversationCreates.set(taskId,promise);
    return promise;
  }

  private async createDefaultConversation(taskId:string):Promise<EnsureTaskConversationResult>{
    try{
      const created=await this.create(taskId,{clientMessageId:crypto.randomUUID()});
      return{conversation:created.conversation,created:true};
    }catch(error){
      if(!(error instanceof TaskConversationServiceError)||error.code!=="CREATE_CONFLICT")throw error;
      const staleBefore=new Date(Date.now()-this.staleGuardMs).toISOString();
      const recovered=this.store.prepareStaleConversationCreateRecovery(staleBefore);
      if(recovered.promoted>0)await this.reconcile();
      const reconciled=this.defaultBinding(taskId);
      if(reconciled)return{conversation:summaryFromBinding(reconciled,"not_loaded"),created:false};
      if(recovered.released>0||recovered.promoted>0){
        try{
          const created=await this.create(taskId,{clientMessageId:crypto.randomUUID()});
          return{conversation:created.conversation,created:true};
        }catch(retryError){
          if(!(retryError instanceof TaskConversationServiceError)||retryError.code!=="CREATE_CONFLICT")throw retryError;
        }
      }
      const deadline=Date.now()+this.convergenceWaitMs;
      do{
        const binding=this.defaultBinding(taskId);
        if(binding)return{conversation:summaryFromBinding(binding,"not_loaded"),created:false};
        if(Date.now()>=deadline)break;
        await new Promise<void>((resolve)=>setTimeout(resolve,Math.min(this.convergencePollMs,Math.max(0,deadline-Date.now()))));
      }while(true);
      throw new TaskConversationServiceError(503,"DEFAULT_CONVERSATION_PENDING","Default conversation is still being prepared",{retryAfterMs:this.retryAfterMs,allowedActions:["retry","reload"]});
    }
  }

  async read(taskId: string, threadId: string, limit = 50, beforeTurnId?: string): Promise<TaskConversationPage> {
    const binding = this.requireBinding(taskId, threadId); this.manager.bindThread(taskId, threadId);
    let detail:TaskConversationDetail;try{detail=await this.projections.get(taskId,threadId,async()=>{const raw=await this.manager.request("thread/read",{threadId,includeTurns:true});this.usage.observeMetadata(taskId,threadId,raw);return projectThread(raw,bindingBase(binding));});}catch(error){this.projections.invalidate(taskId,threadId);throw mapCodexError(error);}
    let end = detail.turns.length;
    if (beforeTurnId) { const index = detail.turns.findIndex((turn) => turn.id === beforeTurnId); if (index >= 0) end = index; }
    const start = Math.max(0, end - Math.max(1, Math.min(100, limit)));
    const turns = detail.turns.slice(start, end);
    const approvals = this.manager.pendingApprovals(taskId, threadId);
    let lease = this.store.getActiveConversationLease(taskId, threadId);
    if (lease?.turnId) {
      const leasedTurn = detail.turns.find((turn) => turn.id === lease?.turnId);
      if (leasedTurn && leasedTurn.status !== "in_progress") {
        this.store.completeConversationTurn(threadId, lease.turnId, leasedTurn.status === "failed");
        lease = null;
      }
    }
    const liveTurnId = lease?.turnId ?? approvals[0]?.turnId;
    const conversation = lease || approvals.length > 0
      ? { ...detail.conversation, status: "active" as const, activeTurnId: liveTurnId ?? detail.conversation.activeTurnId }
      : detail.conversation;
    void this.usage.refreshThread(taskId,threadId);
    return { detail: { ...detail, conversation:{...conversation,usage:this.usage.thread(taskId,threadId)}, turns }, approvals, page: { nextBeforeTurnId: start > 0 ? turns[0]?.id : undefined, complete: start === 0 } };
  }
  async readFresh(taskId: string, threadId: string, limit = 50): Promise<TaskConversationPage> {
    this.projections.invalidate(taskId, threadId);
    return this.read(taskId, threadId, limit);
  }

  async create(taskId: string, input: CreateTaskConversationInput, execution: TaskExecutionOverrides = {}): Promise<{ conversation: TaskConversationSummary; operation: TaskConversationOperationReceipt }> {
    const task = this.requireTask(taskId); const clientMessageId = validateMessageId(input.clientMessageId);
    const preferences = this.store.getConversationPreferences(taskId);
    const model = input.model ?? preferences.defaultModel;
    const requestHash = hash({ displayName: cleanName(input.displayName || `${task.key} · Codex`), model, execution });
    const refreshed=this.store.refreshContext(taskId);if(!refreshed)throw new TaskConversationServiceError(422,"TASK_CONTEXT_UNAVAILABLE","Task context could not be refreshed");const resolvedCwd=path.resolve(execution.cwd ?? refreshed.contextDirectory);
    let reservation;
    try { reservation = this.store.beginConversationCreate({taskId,clientMessageId,requestHash,resolvedCwd}); } catch(error){throw mapStoreError(error);}
    if(reservation.duplicate){if(reservation.receipt.threadId)return{conversation:(await this.read(taskId,reservation.receipt.threadId,1)).detail.conversation,operation:reservation.receipt};if(reservation.receipt.state==="failed")throw new TaskConversationServiceError(409,"CREATE_FAILED","Previous create attempt was proven unsuccessful; use a new clientMessageId",{operationId:reservation.receipt.operationId,allowedActions:["retry"]});throw new TaskConversationServiceError(503,"CREATE_OUTCOME_UNKNOWN","Conversation creation is being reconciled",{operationId:reservation.receipt.operationId});}
    let priorThreadIds:string[];try{priorThreadIds=await this.listAllThreadIds(resolvedCwd);}catch(error){this.store.failConversationRequest(reservation.receipt.operationId,false,"CREATE_SNAPSHOT_FAILED");const mapped=mapCodexError(error);if(mapped instanceof TaskConversationServiceError)throw mapped;throw new TaskConversationServiceError(503,"CODEX_UNAVAILABLE","Codex thread snapshot failed");}
    this.store.saveConversationCreateSnapshot(reservation.receipt.operationId,resolvedCwd,priorThreadIds);
    let result:Record<string,unknown>;
    try{result = await this.manager.request<Record<string, unknown>>("thread/start", { cwd: resolvedCwd, model, approvalPolicy: "on-request", ...(execution.approvalsReviewer ? { approvalsReviewer: execution.approvalsReviewer } : {}), sandbox: "read-only", ephemeral: false, ...(execution.developerInstructions ? { developerInstructions: execution.developerInstructions, config: { "features.multi_agent": false } } : {}) });}catch(error){const uncertain=error instanceof CodexRpcError&&/timed out|exited/i.test(error.message);this.store.failConversationRequest(reservation.receipt.operationId,uncertain,uncertain?"CREATE_OUTCOME_UNKNOWN":"CREATE_START_FAILED");if(uncertain)throw new TaskConversationServiceError(503,"CREATE_OUTCOME_UNKNOWN","Conversation creation is being reconciled",{operationId:reservation.receipt.operationId});throw mapCodexError(error);}
    const thread = object(result.thread ?? result); const threadId = string(thread?.id);
    if (!threadId){this.store.failConversationRequest(reservation.receipt.operationId,false,"CREATE_PROTOCOL_ERROR");throw new TaskConversationServiceError(503, "CODEX_PROTOCOL_ERROR", "Codex did not return a thread id");}
    this.store.markConversationCreateSubmitted(reservation.receipt.operationId);
    const name = cleanName(input.displayName || `${task.key} · Codex`);
    let binding: TaskConversationBinding;
    try { binding = this.store.bindConversation(taskId, threadId, name, execution.primary ?? true); }
    catch (error) { await this.manager.request("thread/archive", { threadId }).catch(() => undefined);this.store.failConversationRequest(reservation.receipt.operationId,false,"BIND_FAILED");throw error; }
    this.manager.bindThread(taskId, threadId);
    this.store.completeConversationCreate(reservation.receipt.operationId,threadId);
    if (name) await this.manager.request("thread/name/set", { threadId, name }).catch(() => undefined);
    const operation = { operationId: reservation.receipt.operationId, clientMessageId, state: "completed" as const, threadId };
    return { conversation: (await this.read(taskId, threadId, 1)).detail.conversation, operation };
  }

  async send(taskId: string, threadId: string, input: StartTaskTurnInput, execution: TaskExecutionOverrides = {}): Promise<{ operation: TaskConversationOperationReceipt; threadId: string; turn?: unknown }> {
    await this.reconcile(taskId);
    const task = this.requireTask(taskId); this.requireBinding(taskId, threadId); const clientMessageId = validateMessageId(input.clientMessageId); const text = validateText(input.text);
    const preferences = this.store.getConversationPreferences(taskId);
    const model = input.model ?? preferences.defaultModel;
    const effort = input.effort ?? preferences.defaultReasoningEffort;
    const permissionPreset = input.permissionPreset ?? preferences.defaultPermissionPreset;
    this.projections.invalidate(taskId,threadId);
    const requestHash = hash({ text, model, effort, permissionPreset, execution });
    let reservation;
    try { reservation = this.store.reserveConversationRequestAndLease({ taskId, threadId, operation: "send", clientMessageId, requestHash, ownerInstanceId: this.instanceId }); }
    catch (error) { throw mapStoreError(error); }
    if (reservation.duplicate) return { operation: reservation.receipt, threadId };
    try {
      const refreshed = this.store.refreshContext(taskId); if (!refreshed) throw new TaskConversationServiceError(422, "TASK_CONTEXT_UNAVAILABLE", "Task context is unavailable");
      const cwd = path.resolve(execution.cwd ?? refreshed.contextDirectory);
      await this.manager.request("thread/resume", { threadId, cwd, ...(execution.approvalsReviewer ? { approvalPolicy: "on-request", approvalsReviewer: execution.approvalsReviewer } : {}), ...(execution.developerInstructions ? { developerInstructions: execution.developerInstructions } : {}) });
      const result = await this.manager.request<Record<string, unknown>>("turn/start", { threadId, clientUserMessageId: clientMessageId, input: [{ type: "text", text, text_elements: [] }], cwd, approvalPolicy: "on-request", ...(execution.approvalsReviewer ? { approvalsReviewer: execution.approvalsReviewer } : {}), sandboxPolicy: sandboxPolicy(permissionPreset, refreshed.contextDirectory, task.repositoryPath), model, effort, ...(execution.outputSchema ? { outputSchema: execution.outputSchema } : {}) });
      const turn = object(result.turn ?? result); const turnId = string(turn?.id);
      if (!turnId) throw new TaskConversationServiceError(503, "CODEX_PROTOCOL_ERROR", "Codex did not return a turn id");
      return { operation: this.store.markConversationRequestSubmitted(reservation.receipt.operationId, turnId), threadId, turn };
    } catch (error) {
      const uncertain = error instanceof CodexRpcError && /timed out|exited/i.test(error.message);
      this.store.failConversationRequest(reservation.receipt.operationId, uncertain, uncertain ? "TURN_OUTCOME_UNKNOWN" : "TURN_START_FAILED");
      if (uncertain) throw new TaskConversationServiceError(503, "TURN_OUTCOME_UNKNOWN", "Turn outcome is being reconciled", { operationId: reservation.receipt.operationId });
      throw error;
    }
  }

  async steer(taskId: string, threadId: string, input: SteerTaskTurnInput): Promise<{operation:TaskConversationOperationReceipt;threadId:string;turnId:string}> { this.requireBinding(taskId, threadId);this.projections.invalidate(taskId,threadId);const clientMessageId=validateMessageId(input.clientMessageId),text=validateText(input.text),operation=`steer:${input.expectedTurnId}`,requestHash=hash({text,expectedTurnId:input.expectedTurnId});let reservation;try{reservation=this.store.reserveConversationOperation({taskId,threadId,operation,clientMessageId,requestHash});}catch(error){throw mapStoreError(error);}if(reservation.duplicate)return{operation:reservation.receipt,threadId,turnId:input.expectedTurnId};try{await this.manager.request("turn/steer", { threadId, expectedTurnId: input.expectedTurnId, clientUserMessageId: clientMessageId, input: [{ type: "text", text, text_elements: [] }] });return{operation:this.store.completeConversationOperation(reservation.receipt.operationId,input.expectedTurnId),threadId,turnId:input.expectedTurnId};}catch(error){const uncertain=error instanceof CodexRpcError&&/timed out|exited/i.test(error.message);this.store.failConversationRequest(reservation.receipt.operationId,uncertain,uncertain?"STEER_OUTCOME_UNKNOWN":"STEER_FAILED");if(uncertain)throw new TaskConversationServiceError(503,"STEER_OUTCOME_UNKNOWN","Steer outcome is being reconciled",{operationId:reservation.receipt.operationId});throw mapCodexError(error);}}
  async interrupt(taskId: string, threadId: string, expectedTurnId: string): Promise<unknown> { this.requireBinding(taskId, threadId);this.projections.invalidate(taskId,threadId);try{return await this.manager.request("turn/interrupt", { threadId, turnId: expectedTurnId });}catch(error){throw mapCodexError(error);} }
  async models(): Promise<unknown> { return { models: await this.manager.models() }; }
  preferences(taskId: string): TaskConversationPreferences { this.requireTask(taskId); return this.store.getConversationPreferences(taskId); }
  async updatePreferences(taskId: string, input: UpdateTaskConversationPreferencesInput): Promise<TaskConversationPreferences> {
    this.requireTask(taskId);
    if (input.defaultPermissionPreset === "full_access" && input.fullAccessConfirmed !== true) throw new TaskConversationServiceError(400, "FULL_ACCESS_CONFIRMATION_REQUIRED", "Confirm the full-access warning before saving this default");
    const defaultModel = typeof input.defaultModel === "string" && input.defaultModel.trim()
      ? input.defaultModel.trim()
      : input.defaultModel === null || input.defaultModel === ""
        ? null
        : undefined;
    if (defaultModel === undefined) throw new TaskConversationServiceError(400, "INVALID_INPUT", "defaultModel must be a model id or null");
    const models = await this.manager.models();
    const selectedModel = defaultModel === null ? models.find((model) => model.isDefault) : models.find((model) => model.id === defaultModel);
    if (defaultModel !== null && !selectedModel) throw new TaskConversationServiceError(400, "MODEL_NOT_AVAILABLE", "Selected Codex model is not available");
    if (selectedModel?.efforts.length && !selectedModel.efforts.includes(input.defaultReasoningEffort as TaskReasoningEffort)) {
      throw new TaskConversationServiceError(400, "MODEL_EFFORT_NOT_SUPPORTED", `${selectedModel.displayName} does not support ${input.defaultReasoningEffort} reasoning`);
    }
    try {
      return this.store.updateConversationPreferences({
        taskId,
        defaultModel,
        defaultReasoningEffort: input.defaultReasoningEffort,
        defaultPermissionPreset: input.defaultPermissionPreset,
        revision: input.revision
      });
    } catch (error) {
      if (error instanceof TaskConversationConflictError) throw new TaskConversationServiceError(409, error.code, error.message, error.details);
      if (error instanceof TaskValidationError) throw new TaskConversationServiceError(/does not exist/.test(error.message) ? 404 : 400, /does not exist/.test(error.message) ? "TASK_NOT_FOUND" : "INVALID_INPUT", error.message);
      throw error;
    }
  }
  resolveApproval(taskId: string, threadId: string, token: string, decision: "accept" | "accept_for_session" | "decline"): void { this.requireBinding(taskId, threadId); try { this.manager.resolveApproval(token, taskId, threadId, decision); } catch { throw new TaskConversationServiceError(409, "APPROVAL_STALE", "Approval is expired or already resolved"); } }
  async rename(taskId:string,threadId:string,displayName:string):Promise<TaskConversationBinding>{this.requireBinding(taskId,threadId);const name=cleanName(displayName);if(!name)throw new TaskConversationServiceError(400,"INVALID_INPUT","displayName is required");this.projections.invalidate(taskId,threadId);this.store.renameConversationBinding(taskId,threadId,name);try{await this.manager.request("thread/name/set",{threadId,name});return this.store.completeConversationRename(taskId,threadId,true);}catch(error){this.store.completeConversationRename(taskId,threadId,false,error instanceof Error?error.message:"rename failed");throw new TaskConversationServiceError(503,"REMOTE_SYNC_FAILED","Codex conversation rename is pending retry");}}
  async archive(taskId:string,threadId:string):Promise<TaskConversationBinding>{this.requireBinding(taskId,threadId);this.projections.invalidate(taskId,threadId);this.store.beginConversationArchive(taskId,threadId);try{await this.manager.request("thread/archive",{threadId});this.manager.unbindThread(threadId);return this.store.completeConversationArchive(taskId,threadId,true);}catch(error){this.store.completeConversationArchive(taskId,threadId,false,error instanceof Error?error.message:"archive failed");throw new TaskConversationServiceError(503,"REMOTE_SYNC_FAILED","Codex conversation archive is pending retry");}}
  async prepareTaskDeletion(taskId:string):Promise<void>{await this.reconcile(taskId);const bindings=this.store.beginTaskDeletionArchiveBatch(taskId);for(const binding of bindings){try{await this.manager.request("thread/archive",{threadId:binding.threadId});this.store.completeConversationArchive(taskId,binding.threadId,true);}catch(error){this.store.completeConversationArchive(taskId,binding.threadId,false,error instanceof Error?error.message:"archive failed");throw new TaskConversationServiceError(503,"THREAD_ARCHIVE_PENDING","Task is preserved while Codex thread archive is retried");}}}
  async prepareTaskArchive(taskId:string):Promise<void>{await this.reconcile(taskId);}
  ensureRuntimeOwnership():void{const claim=this.store.acquireConversationRuntimeOwner(this.instanceId);if(!claim.acquired)throw new TaskConversationServiceError(503,"CONVERSATION_RUNTIME_OWNED","Codex conversations are owned by another live Terminal Apron instance");if(!this.ownerHeartbeat){void this.reconcile();this.ownerHeartbeat=setInterval(()=>{try{this.store.acquireConversationRuntimeOwner(this.instanceId);}catch{}},5_000);this.ownerHeartbeat.unref();}}
  close():void{if(this.ownerHeartbeat)clearInterval(this.ownerHeartbeat);this.ownerHeartbeat=undefined;this.projections.clear();this.usage.close();this.manager.close();this.store.releaseConversationRuntimeOwner(this.instanceId);}
  async reconcile(taskId?:string):Promise<void>{for(const work of this.store.listConversationRecoveryWork(taskId)){try{if(work.operation==="create"&&!work.threadId){const task=this.store.get(work.taskId),resolvedCwd=typeof work.recoveryData?.resolvedCwd==="string"?path.resolve(work.recoveryData.resolvedCwd):"";if(!task||!resolvedCwd||work.recoveryData?.recoveryVersion!==1){this.store.failConversationRequest(work.requestId,false,"CREATE_SNAPSHOT_FAILED");continue;}const prior=new Set(Array.isArray(work.recoveryData.priorThreadIds)?work.recoveryData.priorThreadIds.map(String):[]),current=await this.listAllThreadIds(resolvedCwd),matches=current.filter((threadId)=>!prior.has(threadId));if(matches.length===1){const threadId=matches[0];this.store.bindConversation(work.taskId,threadId,`${task.key} · Codex`,true);this.store.completeConversationCreate(work.requestId,threadId);}else this.store.failConversationRequest(work.requestId,false,matches.length?"CREATE_RECOVERY_AMBIGUOUS":"CREATE_NOT_APPLIED");continue;}if(!work.threadId){this.store.failConversationRequest(work.requestId,false,"RECOVERY_MISSING_THREAD");continue;}const raw=await this.manager.request<Record<string,unknown>>("thread/read",{threadId:work.threadId,includeTurns:true});const thread=object(raw.thread??raw),turns=Array.isArray(thread?.turns)?thread.turns.map(object).filter(Boolean) as Record<string,unknown>[]:[];const turn=work.turnId?turns.find((entry)=>string(entry.id)===work.turnId):turns.find((entry)=>Array.isArray(entry.items)&&entry.items.some((item)=>string(object(item)?.clientId)===work.clientMessageId));if(turn){const status=string(turn.status);if(work.operation.startsWith("steer:")){this.store.completeConversationOperation(work.requestId,string(turn.id));continue;}if(/complete|interrupt/i.test(status))this.store.reconcileConversationLease(work.requestId,{state:"completed",turnId:string(turn.id)});else if(/fail|error/i.test(status))this.store.reconcileConversationLease(work.requestId,{state:"failed",turnId:string(turn.id)});else this.store.reconcileConversationLease(work.requestId,{state:"active",turnId:string(turn.id)});}else if(work.leaseState==="starting"&&work.leaseExpiresAt&&Date.parse(work.leaseExpiresAt)<=Date.now())this.store.reconcileConversationLease(work.requestId,{state:"failed"});else if(work.operation.startsWith("steer:"))this.store.failConversationRequest(work.requestId,false,"STEER_NOT_APPLIED");else this.store.reconcileConversationLease(work.requestId,{state:"reconciling"});}catch(error){const mapped=mapCodexError(error);if(mapped instanceof TaskConversationServiceError&&mapped.code==="THREAD_MISSING"){if(work.leaseState)this.store.reconcileConversationLease(work.requestId,{state:"failed"});else this.store.failConversationRequest(work.requestId,false,"THREAD_MISSING");}else if(work.leaseState)this.store.reconcileConversationLease(work.requestId,{state:"reconciling"});}}}

  private async listAllThreadIds(resolvedCwd:string):Promise<string[]>{const ids:string[]=[];let cursor:string|undefined;do{const listed=await this.manager.request<Record<string,unknown>>("thread/list",{cwd:resolvedCwd,cursor:cursor??null,limit:100,sortKey:"created_at",sortDirection:"desc",useStateDbOnly:true});const page=Array.isArray(listed.data)?listed.data:[];for(const entry of page){const id=string(object(entry)?.id);if(!id||ids.includes(id))throw new Error("Codex returned an invalid or duplicate thread id");ids.push(id);if(ids.length>10_000)throw new Error("Codex thread snapshot exceeded the safe limit");}cursor=typeof listed.nextCursor==="string"&&listed.nextCursor?listed.nextCursor:undefined;}while(cursor);return ids;}

  private requireTask(taskId: string) { const task = this.store.get(taskId); if (!task) throw new TaskConversationServiceError(404, "TASK_NOT_FOUND", "Task not found"); return task; }
  private defaultBinding(taskId:string):TaskConversationBinding|undefined{const bindings=this.store.listConversationBindings(taskId);const binding=bindings.find((entry)=>entry.isPrimary)??bindings[0];if(binding)this.manager.bindThread(taskId,binding.threadId);return binding;}
  private requireBinding(taskId: string, threadId: string) { this.requireTask(taskId); const binding = this.store.getConversationBinding(taskId, threadId); if (!binding || binding.archived) throw new TaskConversationServiceError(404, "CONVERSATION_NOT_FOUND", "Conversation not found"); return binding; }
}

function summaryFromBinding(binding: TaskConversationBinding, status: TaskConversationSummary["status"]): TaskConversationSummary { return { ...binding, preview: "", status, cwd: "", modelProvider: "" }; }
function bindingBase(binding: TaskConversationBinding) { return { ...binding }; }
function sandboxPolicy(preset: NonNullable<StartTaskTurnInput["permissionPreset"]>, contextDirectory: string, repositoryPath: string) {
  if (preset === "full_access") return { type: "dangerFullAccess" };
  if (preset === "workspace_write") return { type: "workspaceWrite", writableRoots: [...new Set([contextDirectory, repositoryPath && path.resolve(repositoryPath)].filter(Boolean))], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  return { type: "readOnly", networkAccess: false };
}
function validateMessageId(value: string): string { const id = value?.trim(); if (!id || id.length < 8 || id.length > 128) throw new TaskConversationServiceError(400, "INVALID_INPUT", "clientMessageId must be 8..128 characters"); return id; }
function validateText(value: string): string { const text = value?.trim(); if (!text || text.length > 100_000) throw new TaskConversationServiceError(400, "INVALID_INPUT", "text must be 1..100000 characters"); return text; }
function cleanName(value: string): string { return value.trim().slice(0, 120); }
function hash(value: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function mapStoreError(error: unknown): Error { if (error instanceof TaskConversationConflictError) return new TaskConversationServiceError(409, error.code, error.message, error.details); if (error instanceof TaskValidationError) return new TaskConversationServiceError(404, "CONVERSATION_NOT_FOUND", error.message); return error instanceof Error ? error : new Error(String(error)); }
function mapCodexError(error:unknown):Error{if(error instanceof CodexRpcError){const message=error.message.toLowerCase();if(message.includes("not found")||message.includes("missing"))return new TaskConversationServiceError(410,"THREAD_MISSING",error.message);if(message.includes("active turn")||message.includes("does not match")||message.includes("conflict"))return new TaskConversationServiceError(409,"TURN_CONFLICT",error.message);if(message.includes("rate")||error.code===429)return new TaskConversationServiceError(429,"CODEX_RATE_LIMITED",error.message);if(message.includes("auth")||message.includes("login"))return new TaskConversationServiceError(503,"CODEX_AUTH_REQUIRED",error.message);if(error.code===-32001||message.includes("overload"))return new TaskConversationServiceError(503,"CODEX_OVERLOADED",error.message);}return error instanceof Error?error:new Error(String(error));}
