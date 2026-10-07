import type { TaskConversationDetail, TaskConversationEvent, TaskConversationItem, TaskTurnStatus } from "../../shared/taskConversationTypes";

export function reduceTaskConversationEvent(detail: TaskConversationDetail, event: TaskConversationEvent): TaskConversationDetail {
  if (event.threadId && event.threadId !== detail.conversation.threadId) return detail;
  if (event.kind === "token_usage_updated" && event.payload.usage) return { ...detail, conversation: { ...detail.conversation, usage: event.payload.usage as NonNullable<TaskConversationDetail["conversation"]["usage"]> } };
  if (event.kind === "assistant_delta" && event.turnId && event.itemId) return upsertItem(detail,event.turnId,{kind:"assistant",id:event.itemId,text:String(event.payload.delta??""),phase:"commentary"},true);
  if (event.kind === "plan_delta" && event.turnId && event.itemId) return upsertItem(detail,event.turnId,{kind:"plan",id:event.itemId,text:String(event.payload.delta??"")},true);
  if (event.kind === "command_output_delta" && event.turnId && event.itemId) {
    const previous=detail.turns.find(turn=>turn.id===event.turnId)?.items.find(item=>item.id===event.itemId);
    const command=previous?.kind==="command"?previous:{kind:"command" as const,id:event.itemId,command:"",cwd:"",status:"inProgress"};
    const output=(command.output??"")+String(event.payload.delta??"");
    return upsertItem(detail,event.turnId,{...command,output:output.slice(-80000),outputTruncated:command.outputTruncated||output.length>80000},false);
  }
  if ((event.kind === "item_started" || event.kind === "item_completed") && event.turnId && event.payload.item) return upsertItem(detail,event.turnId,event.payload.item as TaskConversationItem,false);
  if (event.kind === "turn_started" && event.turnId) {
    const turn=event.payload.turn as {startedAt?:string}|undefined;
    return {...detail,conversation:{...detail.conversation,status:"active",activeTurnId:event.turnId},turns:detail.turns.some(value=>value.id===event.turnId)?detail.turns:[...detail.turns,{id:event.turnId,status:"in_progress",startedAt:typeof turn?.startedAt==="string"?turn.startedAt:event.occurredAt,items:[]}]};
  }
  if (event.kind === "turn_completed" && event.turnId) {
    const raw=event.payload.turn as {status?:string;completedAt?:string;error?:{message?:string}}|undefined;
    const status:TaskTurnStatus=/interrupt/i.test(raw?.status??"")?"interrupted":/fail|error/i.test(raw?.status??"")?"failed":"completed";
    const turns=detail.turns.map(turn=>turn.id===event.turnId?{...turn,status,completedAt:typeof raw?.completedAt==="string"?raw.completedAt:event.occurredAt,error:raw?.error?.message?{code:"CODEX_TURN_FAILED",message:raw.error.message,retryable:false}:turn.error}:turn);
    const active=turns.find(turn=>turn.status==="in_progress");
    return {...detail,conversation:{...detail.conversation,status:active?"active":"idle",activeTurnId:active?.id},turns};
  }
  if(event.kind==="thread_status"){
    const status=String(event.payload.status??"");
    if(status==="active"||status==="idle")return {...detail,conversation:{...detail.conversation,status}};
  }
  return detail;
}

function upsertItem(detail:TaskConversationDetail,turnId:string,item:TaskConversationItem,append:boolean):TaskConversationDetail {
  const turns=detail.turns.some(turn=>turn.id===turnId)?detail.turns:[...detail.turns,{id:turnId,status:"in_progress" as const,items:[]}];
  return {...detail,turns:turns.map(turn=>{
    if(turn.id!==turnId)return turn;
    const index=turn.items.findIndex(current=>current.id===item.id);
    if(index<0)return {...turn,items:[...turn.items,item]};
    const items=[...turn.items],previous=items[index];
    if(append&&previous.kind==="assistant"&&item.kind==="assistant")items[index]={...previous,text:previous.text+item.text};
    else if(append&&previous.kind==="plan"&&item.kind==="plan")items[index]={...previous,text:previous.text+item.text};
    else items[index]=item;
    return {...turn,items};
  })};
}

/** Polling must not discard older history that a user explicitly loaded. */
export function retainLoadedConversationHistory(current:TaskConversationDetail|undefined,next:TaskConversationDetail):TaskConversationDetail {
  if(!current||current.conversation.threadId!==next.conversation.threadId||!next.turns.length)return next;
  const boundary=current.turns.findIndex(turn=>turn.id===next.turns[0].id);
  return boundary>0?{...next,turns:[...current.turns.slice(0,boundary),...next.turns]}:next;
}

/** A delayed HTTP snapshot must not erase text or terminal events already received through SSE. */
export function reconcileLiveConversationSnapshot(current:TaskConversationDetail|undefined,next:TaskConversationDetail):TaskConversationDetail {
  if(!current||current.conversation.threadId!==next.conversation.threadId)return next;
  const remoteIds=new Set(next.turns.map(turn=>turn.id));
  const turns=next.turns.map(turn=>{
    const previous=current.turns.find(value=>value.id===turn.id);if(!previous)return turn;
    const ids=new Set(turn.items.map(item=>item.id));
    const items=turn.items.map(item=>{
      const live=previous.items.find(value=>value.id===item.id);
      if(live?.kind==="activity"&&item.kind==="activity"&&item.activityType==="contextCompaction"&&item.status===undefined&&live.status)return live;
      if(live?.kind==="assistant"&&item.kind==="assistant"&&live.text.length>item.text.length&&live.text.startsWith(item.text))return {...item,text:live.text};
      if(live?.kind==="plan"&&item.kind==="plan"&&live.text.length>item.text.length&&live.text.startsWith(item.text))return {...item,text:live.text};
      if(live?.kind==="command"&&item.kind==="command"&&live.output&&live.output.length>(item.output?.length??0)&&live.output.startsWith(item.output??""))return {...item,output:live.output};
      return item;
    });
    items.push(...previous.items.filter(item=>!ids.has(item.id)));
    return turn.status==="in_progress"&&previous.status!=="in_progress"?{...previous,items}:{...turn,items};
  });
  const boundary=current.turns.findIndex(turn=>turn.id===next.turns.at(-1)?.id);
  if(boundary>=0)turns.push(...current.turns.slice(boundary+1).filter(turn=>!remoteIds.has(turn.id)));
  const active=turns.find(turn=>turn.status==="in_progress");
  const ended=Boolean(next.conversation.activeTurnId&&turns.some(turn=>turn.id===next.conversation.activeTurnId&&turn.status!=="in_progress"));
  return {...next,conversation:{...next.conversation,status:active?"active":ended?"idle":next.conversation.status,activeTurnId:active?.id??(ended?undefined:next.conversation.activeTurnId)},turns};
}
