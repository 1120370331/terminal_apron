import { ArrowDown, Bot, ChevronRight, CircleStop, LoaderCircle, Plus, Send, Settings2, Shield, TerminalSquare, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { TaskItem } from "../../shared/taskTypes";
import type { TaskConversationApproval, TaskConversationDetail, TaskConversationItem, TaskConversationSummary } from "../../shared/taskConversationTypes";
import { newClientMessageId, taskConversationApi } from "../taskConversationApi";
import { groupConversationItems } from "../conversationItemGroups";
import { TaskUsageBadge } from "../task-mode/TaskUsage";
import { reduceTaskConversationEvent, retainLoadedConversationHistory, reconcileLiveConversationSnapshot } from "./taskConversationState";
import { createLiveRefreshLoop } from "../liveRefresh";
import { ConversationActivity } from "../ConversationActivity";
import { isConversationItemRunning } from "../conversationActivityState";
import { TaskConversationDefaults, TaskConversationDefaultsDialog } from "./TaskConversationDefaults";

export interface TaskConversationLaunch {
  id: string;
  taskId: string;
  prompt: string;
  stage: "creating" | "sending" | "completed" | "failed";
  conversation?: TaskConversationSummary;
  error?: string;
}

interface OptimisticUser {
  id: string;
  text: string;
  threadId?: string;
  baselineUserItemIds: string[];
  settled: boolean;
}

export function TaskConversationPanel({ task, initialError = "", launch, onLaunchConsumed, onClose, onTerminal }: { task: TaskItem; initialError?: string; launch?: TaskConversationLaunch; onLaunchConsumed?:(launchId:string)=>void; onClose:()=>void; onTerminal:()=>void }) {
  const [conversations,setConversations]=useState<TaskConversationSummary[]>([]); const [threadId,setThreadId]=useState<string>(); const [detail,setDetail]=useState<TaskConversationDetail>();
  const [text,setText]=useState(""); const [busy,setBusy]=useState(false); const [creating,setCreating]=useState(false); const [preparing,setPreparing]=useState(true); const [error,setError]=useState(""); const [launchError,setLaunchError]=useState(initialError);
  const timelineRef=useRef<HTMLDivElement>(null); const followLatest=useRef(true); const [showJumpToLatest,setShowJumpToLatest]=useState(false);
  const [optimisticUsers,setOptimisticUsers]=useState<OptimisticUser[]>([]);
  const [compactComposer,setCompactComposer]=useState(()=>window.matchMedia("(max-width: 760px)").matches);
  const [defaultsOpen,setDefaultsOpen]=useState(false);
  const [approvals,setApprovals]=useState<TaskConversationApproval[]>([]);
  const [nextBeforeTurnId,setNextBeforeTurnId]=useState<string>();
  const [historySlow,setHistorySlow]=useState(false);const historyRequest=useRef(0);const defaultEnsureRequest=useRef<ReturnType<typeof taskConversationApi.ensureDefault>>();
  const detailRef=useRef(detail);detailRef.current=detail;
  const streamVersion=useRef(0);const [connected,setConnected]=useState(false),[lastEventAt,setLastEventAt]=useState<string>();
  const loadList=useCallback(async()=>{setError("");const list=await taskConversationApi.list(task.id);if(list.conversations.length){setConversations(list.conversations);setThreadId((current)=>current&&list.conversations.some((entry)=>entry.threadId===current)?current:list.primaryThreadId||list.conversations[0]?.threadId);setPreparing(false);return;}setConversations([]);setThreadId(undefined);setDetail(undefined);if(launch&&launch.stage!=="failed"){setPreparing(false);return;}setPreparing(true);try{const ensured=await(defaultEnsureRequest.current??=taskConversationApi.ensureDefault(task.id).finally(()=>{defaultEnsureRequest.current=undefined;}));setConversations([ensured.conversation]);setThreadId(ensured.conversation.threadId);}finally{setPreparing(false);}},[launch,task.id]);
  const loadDetail=useCallback(async(id:string)=>{
    const requestId=++historyRequest.current,version=streamVersion.current;setError("");setHistorySlow(false);
    const slow=setTimeout(()=>{if(historyRequest.current===requestId)setHistorySlow(true);},750);
    try{
      const page=await taskConversationApi.read(task.id,id);if(historyRequest.current!==requestId)return false;
      if(version!==streamVersion.current&&detailRef.current?.conversation.threadId===id)return false;
      const merged=retainLoadedConversationHistory(detailRef.current,reconcileLiveConversationSnapshot(detailRef.current,page.detail));
      setDetail(merged);setApprovals(page.approvals);setNextBeforeTurnId(previous=>merged.turns.length>page.detail.turns.length?previous:page.page.nextBeforeTurnId);return true;
    }catch(e){if(historyRequest.current===requestId)setError(e instanceof Error?e.message:"对话加载失败");return false;}
    finally{clearTimeout(slow);if(historyRequest.current===requestId)setHistorySlow(false);}
  },[task.id]);
  const loadOlder=async()=>{if(!threadId||!nextBeforeTurnId)return;setBusy(true);try{const page=await taskConversationApi.read(task.id,threadId,nextBeforeTurnId);setDetail((current)=>current?{...current,turns:[...page.detail.turns.filter(turn=>!current.turns.some(existing=>existing.id===turn.id)),...current.turns]}:page.detail);setNextBeforeTurnId(page.page.nextBeforeTurnId);}catch(e){setError(e instanceof Error?e.message:"更早历史加载失败");}finally{setBusy(false);}};
  useEffect(()=>{void loadList().catch((e)=>{setPreparing(false);setError(e instanceof Error?e.message:"对话加载失败");});},[loadList]);
  useEffect(()=>{setLaunchError(initialError);},[initialError]);
  useEffect(()=>{if(threadId)void loadDetail(threadId);else setDetail(undefined);},[loadDetail,threadId]);
  useEffect(()=>{
    if(!launch)return;
    const baselineUserItemIds:string[]=[];
    setOptimisticUsers((current)=>{
      const existing=current.find((entry)=>entry.id===launch.id);
      if(launch.stage==="failed")return current.filter((entry)=>entry.id!==launch.id);
      if(existing)return current.map((entry)=>entry.id===launch.id?{...entry,threadId:launch.conversation?.threadId??entry.threadId,settled:launch.stage==="completed"||entry.settled}:entry);
      return [...current,{id:launch.id,text:launch.prompt,threadId:launch.conversation?.threadId,baselineUserItemIds,settled:launch.stage==="completed"}];
    });
    if(launch.conversation){
      setConversations((current)=>[launch.conversation!,...current.filter((entry)=>entry.threadId!==launch.conversation!.threadId)]);
      setThreadId(launch.conversation.threadId);
    }
    if(launch.stage==="failed"){
      setLaunchError(launch.error??"新建 Codex 对话失败");
      if(launch.conversation)setText(launch.prompt);
      onLaunchConsumed?.(launch.id);
      return;
    }
    if(launch.stage==="completed"&&launch.conversation){
      void loadDetail(launch.conversation.threadId).then(()=>{
        onLaunchConsumed?.(launch.id);
      });
    }
  },[launch,loadDetail,onLaunchConsumed]);
  useEffect(()=>{
    let alive=true;setConnected(false);setLastEventAt(undefined);
    const updates=createLiveRefreshLoop(async()=>{if(threadId)await loadDetail(threadId);},{intervalMs:3000});
    const source=taskConversationApi.subscribe(task.id,event=>{
      if(!alive)return;
      if(event.kind==="ready"||event.kind==="resync_required"){updates.request(true);return;}
      if(event.kind==="approval_requested")setApprovals(current=>[...current.filter(entry=>entry.token!==event.payload.token),event.payload as unknown as TaskConversationApproval]);
      if(event.kind==="approval_resolved")setApprovals(current=>current.filter(entry=>entry.token!==event.payload.token));
      if(event.threadId&&event.threadId!==threadId)return;
      streamVersion.current++;
      if(event.payload.cached!==true&&event.kind!=="token_usage_updated")setLastEventAt(event.occurredAt);
      setDetail(current=>current?reduceTaskConversationEvent(current,event):current);
      updates.request(event.kind==="turn_completed");
    });
    source.onopen=()=>{if(alive){setConnected(true);updates.request(true);}};
    source.onerror=()=>{if(alive){setConnected(false);updates.request(true);}};
    return()=>{alive=false;historyRequest.current++;updates.dispose();source.close();};
  },[loadDetail,task.id,threadId]);
  useEffect(()=>{if(detail)setOptimisticUsers((current)=>current.filter((entry)=>!hasCanonicalUser(detail,entry)));},[detail]);
  useEffect(()=>{const media=window.matchMedia("(max-width: 760px)");const update=()=>setCompactComposer(media.matches);media.addEventListener("change",update);return()=>media.removeEventListener("change",update);},[]);
  const updateScrollPosition=()=>{const timeline=timelineRef.current;if(!timeline)return;const away=timeline.scrollHeight-timeline.clientHeight-timeline.scrollTop>48;followLatest.current=!away;setShowJumpToLatest(away);};
  const jumpToLatest=()=>{const timeline=timelineRef.current;if(!timeline)return;followLatest.current=true;timeline.scrollTop=timeline.scrollHeight;setShowJumpToLatest(false);};
  useLayoutEffect(()=>{followLatest.current=true;setShowJumpToLatest(false);},[threadId]);
  useLayoutEffect(()=>{const timeline=timelineRef.current;if(!timeline)return;if(followLatest.current)timeline.scrollTop=timeline.scrollHeight;updateScrollPosition();},[detail,optimisticUsers,threadId]);
  const create=async()=>{setBusy(true);setCreating(true);setError("");try{const result=await taskConversationApi.create(task.id,{clientMessageId:newClientMessageId()});setConversations((current)=>[result.conversation,...current]);setThreadId(result.conversation.threadId);}catch(e){setError(e instanceof Error?e.message:"创建失败");}finally{setCreating(false);setBusy(false);}};
  const send=async()=>{if(!threadId||!text.trim())return; const message=text.trim();const optimisticId=newClientMessageId();const baselineUserItemIds=detail?.turns.flatMap((turn)=>turn.items.filter((item)=>item.kind==="user").map((item)=>item.id))??[];setOptimisticUsers((current)=>[...current,{id:optimisticId,text:message,threadId,baselineUserItemIds,settled:false}]);setBusy(true);setText("");try{const clientMessageId=newClientMessageId();if(detail?.conversation.activeTurnId)await taskConversationApi.steer(task.id,threadId,{clientMessageId,expectedTurnId:detail.conversation.activeTurnId,text:message});else await taskConversationApi.send(task.id,threadId,{clientMessageId,text:message});setOptimisticUsers((current)=>current.map((entry)=>entry.id===optimisticId?{...entry,settled:true}:entry));await loadDetail(threadId);}catch(e){setOptimisticUsers((current)=>current.filter((entry)=>entry.id!==optimisticId));setText(message);setError(e instanceof Error?e.message:"发送失败");}finally{setBusy(false);}};
  const interrupt=async()=>{if(!threadId||!detail?.conversation.activeTurnId)return;setBusy(true);setError("");try{await taskConversationApi.interrupt(task.id,threadId,detail.conversation.activeTurnId);await loadDetail(threadId);}catch(e){setError(e instanceof Error?e.message:"中断失败");}finally{setBusy(false);}};
  const resolve=async(approval:TaskConversationApproval,decision:"accept"|"accept_for_session"|"decline")=>{try{await taskConversationApi.resolveApproval(task.id,approval.threadId,approval.token,decision);setApprovals((current)=>current.filter((entry)=>entry.token!==approval.token));}catch(e){setError(e instanceof Error?e.message:"审批失败");}};
  const launchPending=launch?.stage==="creating"||launch?.stage==="sending";
  const visibleOptimisticUsers=optimisticUsers.filter((entry)=>(!entry.threadId||entry.threadId===threadId)&&!hasCanonicalUser(detail,entry));
  return <div className="task-conversation-overlay" role="dialog" aria-modal="true" aria-label={`${task.key} Codex 对话`}>
    <section className="task-conversation-panel">
      <header className="task-conversation-header"><div><Bot size={20}/><span><strong>{task.key} · Codex</strong><small>{task.contextDirectory}</small></span></div><div><button onClick={onTerminal} title="高级终端"><TerminalSquare size={17}/>高级终端</button><button onClick={onClose} aria-label="关闭"><X size={19}/></button></div></header>
      <div className="task-conversation-layout"><nav className="task-conversation-list"><button className="task-conversation-new" onClick={()=>void create()} disabled={busy||preparing||launchPending}>{creating?<LoaderCircle className="spin" size={15}/>:<Plus size={15}/>} {creating?"正在创建…":"新对话"}</button>{conversations.map((conversation)=><div className={conversation.threadId===threadId?"task-conversation-list-item active":"task-conversation-list-item"} key={conversation.threadId}><button onClick={()=>setThreadId(conversation.threadId)}><strong>{conversation.displayName||"Codex 对话"}</strong><span>{conversation.preview||conversation.status}</span></button><span><button title="重命名" onClick={()=>{const name=window.prompt("对话名称",conversation.displayName);if(name)void taskConversationApi.rename(task.id,conversation.threadId,name).then(()=>loadList()).catch((e)=>setError(e.message));}}>✎</button><button title="归档" onClick={()=>{if(window.confirm("归档这个 Codex 对话？"))void taskConversationApi.archive(task.id,conversation.threadId).then(()=>{setThreadId(undefined);return loadList();}).catch((e)=>setError(e.message));}}>×</button></span></div>)}</nav>
      <main className="task-conversation-main"><div className="task-conversation-usage"><span>当前对话用量</span><TaskUsageBadge usage={detail?.conversation.usage}/><small>{connected?"实时同步":"正在重新连接"}</small></div><ConversationActivity detail={detail} connected={connected} lastEventAt={lastEventAt} approvalCount={approvals.filter(entry=>entry.threadId===threadId).length}/>{(launchError||error)&&<div className="task-conversation-error">{launchError||error}<button onClick={()=>{if(launchError){setLaunchError("");return;}threadId?void loadDetail(threadId):void loadList();}}>{launchError?"知道了":threadId?"重新加载":"重新连接"}</button></div>}{!threadId&&!visibleOptimisticUsers.length?<div className="task-conversation-empty">{preparing?<LoaderCircle className="spin" size={34}/>:<Bot size={34}/>}<h3>{preparing?"正在准备默认对话":"默认对话暂时不可用"}</h3><p>{preparing?"正在连接本机 Codex，通常需要几秒；无需手动创建。":"没有创建临时占位对话；请重新连接 Codex。"}</p>{!preparing&&!error&&!launchError&&<button onClick={()=>void loadList()}>重新连接</button>}</div>:<><div className="task-conversation-viewport"><div className="task-conversation-timeline" ref={timelineRef} onScroll={updateScrollPosition}>{nextBeforeTurnId&&<button className="task-load-older" onClick={()=>void loadOlder()} disabled={busy}>加载更早历史</button>}{!detail&&!visibleOptimisticUsers.length?<div className="task-conversation-skeleton">{historySlow?<><strong>历史加载较慢</strong><span>可以继续等待、重新加载，或使用高级终端。</span><div><button onClick={()=>threadId&&void loadDetail(threadId)}>重新加载</button><button onClick={onTerminal}>高级终端</button></div></>:"正在加载历史…"}</div>:<>{renderConversationItems(detail)}{visibleOptimisticUsers.map((entry)=><article className={`task-message user${entry.settled?"":" pending"}`} data-optimistic-user={entry.settled?"submitted":"pending"} key={entry.id}><span>{entry.settled?"你":"你 · 发送中"}</span><ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown></article>)}</>}</div>{showJumpToLatest&&<button className="task-conversation-jump" type="button" aria-label="跳到最新消息" onClick={jumpToLatest}><ArrowDown size={16}/>跳到最新</button>}</div>
      <footer className="task-composer">{approvals.filter((entry)=>entry.threadId===threadId).map((approval)=><div className="task-approval-card" key={approval.token}><div><Shield size={15}/><span><strong>{approval.kind==="command"?"Codex 请求执行命令":"Codex 请求修改文件"}</strong><code>{approval.command?.display||approval.fileChange?.paths.join(", ")||"未提供受影响文件，请拒绝并要求 Codex 重新说明"}</code></span></div><div><button onClick={()=>void resolve(approval,"decline")}>拒绝</button><button disabled={approval.kind==="file_change"&&!approval.fileChange?.paths.length} onClick={()=>void resolve(approval,"accept_for_session")}>本会话允许</button><button disabled={approval.kind==="file_change"&&!approval.fileChange?.paths.length} onClick={()=>void resolve(approval,"accept")}>允许一次</button></div></div>)}
        <div className="task-composer-settings">{compactComposer?<button type="button" onClick={()=>setDefaultsOpen(true)}><Settings2 size={14}/>默认设置</button>:<TaskConversationDefaults taskId={task.id} taskLabel={task.key}/>}{detail?.conversation.activeTurnId&&<button onClick={()=>void interrupt()} disabled={busy}><CircleStop size={14}/>中断</button>}</div>
        <div className="task-composer-box"><textarea value={text} disabled={!detail||launchPending} onChange={(e)=>setText(e.target.value)} onKeyDown={(e)=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void send();}}} placeholder="给 Codex 发送任务；Enter 发送，Shift+Enter 换行"/><button onClick={()=>void send()} disabled={!detail||busy||launchPending||!text.trim()}><Send size={17}/></button></div><small>推理强度和权限是此任务的默认值，保存后用于后续新回合。</small>
      </footer></>}{compactComposer&&defaultsOpen&&<TaskConversationDefaultsDialog taskId={task.id} taskLabel={task.key} onClose={()=>setDefaultsOpen(false)}/>}</main></div>
    </section></div>;
}

function hasCanonicalUser(detail:TaskConversationDetail|undefined,entry:OptimisticUser):boolean{
  if(!detail||!entry.threadId||detail.conversation.threadId!==entry.threadId)return false;
  const baseline=new Set(entry.baselineUserItemIds);
  const expected=normalizeOptimisticText(entry.text);
  return detail.turns.some((turn)=>turn.items.some((item)=>item.kind==="user"&&!baseline.has(item.id)&&normalizeOptimisticText(item.text)===expected));
}

function normalizeOptimisticText(value:string):string{return value.replace(/\r\n/g,"\n").trim();}

type CommandItem=Extract<TaskConversationItem,{kind:"command"}>;

function renderConversationItems(detail:TaskConversationDetail|undefined){
  return detail?.turns.flatMap(turn=>groupConversationItems(turn.items).map(group=>{
    const key=`${turn.id}:${group.key}`;
    if(group.kind==="commands")return <details className="task-command-group" key={key}>
      <summary><ChevronRight size={15}/><TerminalSquare size={15}/><strong>连续执行 {group.items.length} 条命令</strong><code title={group.items[0].command}>{group.items[0].command}</code></summary>
      <div>{group.items.map(item=><TaskCommandView item={item} key={item.id}/>)}</div>
    </details>;
    const item=group.item;
    if(item.kind==="user"||item.kind==="assistant")return <article className={`task-message ${item.kind}`} data-streaming={item.kind==="assistant"&&item.phase!=="final"&&turn.status==="in_progress"&&item.id===turn.items.at(-1)?.id} key={key}><span>{item.kind==="user"?"你":"Codex"}</span><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>{item.kind==="assistant"&&item.phase!=="final"&&turn.status==="in_progress"&&item.id===turn.items.at(-1)?.id&&<span className="task-stream-cursor" aria-hidden="true">▍</span>}</article>;
    if(item.kind==="command")return <TaskCommandView item={item} key={key}/>;
    return <article className="task-activity" key={key}>{item.kind==="file_change"?`文件变更 · ${item.paths.join(", ")}`:item.kind==="tool"?`工具 · ${item.server}/${item.tool}`:item.kind==="plan"?item.text:item.kind==="reasoning"?item.summary.join(" · "):item.label}</article>;
  }))??[];
}

function TaskCommandView({item}:{item:CommandItem}){
  return <details className="task-activity task-command" data-running={isConversationItemRunning(item.status)}>
    <summary><ChevronRight size={15}/>{isConversationItemRunning(item.status)?<LoaderCircle className="spin" size={15}/>:<TerminalSquare size={15}/>}<span>命令 · {item.status||"执行中"}</span><code title={item.command}>{item.command}</code></summary>
    <pre>{item.command}</pre>
    {item.output&&<pre>{item.output}</pre>}
    {item.outputTruncated&&<small>输出已截断</small>}
    {item.exitCode!==undefined&&<small>退出码：{item.exitCode}</small>}
  </details>;
}
