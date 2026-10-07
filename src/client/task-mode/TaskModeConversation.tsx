import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Bot, Check, ChevronRight, CircleAlert, Clock3, FileCode2, Loader2, MessageSquare, RefreshCw, TerminalSquare, UserRound } from "lucide-react";
import type { TaskConversationItem, TaskConversationPage, TaskConversationTurn } from "../../shared/taskConversationTypes";
import type { TaskExecutionJob, TaskModeDetail } from "../../shared/taskModeTypes";
import { taskConversationApi } from "../taskConversationApi";
import { groupConversationItems } from "../conversationItemGroups";
import { TaskUsageBadge } from "./TaskUsage";
import { createLiveRefreshLoop } from "../liveRefresh";
import { reduceTaskConversationEvent, reconcileLiveConversationSnapshot } from "../task-monitor/taskConversationState";
import { ConversationActivity } from "../ConversationActivity";
import { isConversationItemRunning } from "../conversationActivityState";
import { MarkdownContent } from "../task-monitor/MarkdownContent";

interface Props { detail: TaskModeDetail; onAddInstruction: () => void }
interface ThreadChoice { id: string; label: string; role: "agent" | "worker"; job?: TaskExecutionJob; runNumber?: number }

const phaseLabels: Record<string, string> = {
  idle: "等待开始", planning: "代理正在理解需求", working: "Worker 正在执行", reviewing: "代理正在检查结果",
  paused: "已暂停", blocked: "已阻塞", needs_confirmation: "等待你的确认", completed: "本轮已完成"
};
const jobLabels: Record<TaskExecutionJob["status"], string> = {
  pending: "等待接取", active: "执行中", completed: "已汇报", failed: "执行失败", interrupted: "已中断"
};
const turnLabels: Record<TaskConversationTurn["status"], string> = {
  in_progress: "正在进行", completed: "已完成", interrupted: "已中断", failed: "执行失败"
};

export function TaskModeConversation({ detail, onAddInstruction }: Props) {
  const { task, state } = detail;
  const conversationRoot=useRef<HTMLElement>(null);
  useLayoutEffect(()=>{if(window.matchMedia("(max-width: 720px)").matches)conversationRoot.current?.scrollIntoView({block:"start",behavior:"instant"});},[task.id]);
  const choices = useMemo<ThreadChoice[]>(() => {
    const found: ThreadChoice[] = [];
    if (state.agentThreadId) {
      const jobs = state.runs.flatMap(run => run.jobs).filter(job => job.threadId === state.agentThreadId);
      found.push({ id: state.agentThreadId, role: "agent", label: "任务代理", job: jobs.at(-1) });
    }
    state.runs.forEach((run, index) => run.jobs.filter(job => job.role === "worker" && job.threadId).forEach(job => {
      found.push({ id: job.threadId!, role: "worker", label: job.name, job, runNumber: index + 1 });
    }));
    const unique=new Map<string,ThreadChoice>();for(const choice of found)unique.set(choice.id,choice);return [...unique.values()];
  }, [state.agentThreadId, state.runs]);
  const [threadId, setThreadId] = useState("");
  const [page, setPage] = useState<TaskConversationPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const sequence = useRef(0);
  const streamVersion = useRef(0);
  const [lastEventAt,setLastEventAt]=useState<string>();
  const [syncedAt,setSyncedAt]=useState<string>();
  const turnsRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [hasNewUpdates,setHasNewUpdates]=useState(false);
  const selected = choices.find(choice => choice.id === threadId);
  const activeChoice = choices.find(choice => choice.role === "agent") ?? choices.find(choice => choice.job?.status === "active") ?? choices[0];

  useEffect(() => {
    if (!choices.some(choice => choice.id === threadId)) setThreadId(activeChoice?.id ?? "");
  }, [choices, threadId, activeChoice?.id]);

  useEffect(() => {
    followLatest.current = true;
    setShowJumpToLatest(false);setHasNewUpdates(false);
  }, [threadId]);

  const updateScrollPosition = () => {
    const element = turnsRef.current;
    if (!element) return;
    const awayFromBottom = element.scrollHeight - element.clientHeight - element.scrollTop > 48;
    followLatest.current = !awayFromBottom;
    setShowJumpToLatest(awayFromBottom);if(!awayFromBottom)setHasNewUpdates(false);
  };
  const jumpToLatest = () => {
    const element = turnsRef.current;
    if (!element) return;
    followLatest.current = true;
    element.scrollTop = element.scrollHeight;
    setShowJumpToLatest(false);
  };

  useLayoutEffect(() => {
    const element = turnsRef.current;
    if (!element) return;
    if (followLatest.current) element.scrollTop = element.scrollHeight;
    updateScrollPosition();
  }, [page, threadId]);

  useEffect(() => {
    if (!threadId) { setPage(null); setLoading(false); return; }
    let alive = true;
    const updates=createLiveRefreshLoop(async()=>{
      const request=++sequence.current,version=streamVersion.current;
      try{
        const next=await taskConversationApi.read(task.id,threadId);
        if(alive&&request===sequence.current){
          setPage(current=>current&&version!==streamVersion.current?current:current?{...next,detail:reconcileLiveConversationSnapshot(current.detail,next.detail)}:next);
          if(version!==streamVersion.current)updates.request();
          setSyncedAt(new Date().toISOString());setError("");
        }
      }catch(cause){if(alive&&request===sequence.current)setError(cause instanceof Error?cause.message:"Codex 对话读取失败");}
      finally{if(alive&&request===sequence.current)setLoading(false);}
    },{intervalMs:3000});
    setPage(null);setLoading(true);setError("");setConnected(false);setLastEventAt(undefined);setSyncedAt(undefined);
    updates.request(true);
    const source=taskConversationApi.subscribe(task.id,event=>{
      if(!alive)return;
      if(event.kind==="ready"||event.kind==="resync_required"){updates.request(true);return;}
      if(event.threadId&&event.threadId!==threadId)return;
      streamVersion.current++;
      if(!followLatest.current&&event.kind!=="token_usage_updated")setHasNewUpdates(true);
      if(event.payload.cached!==true&&event.kind!=="token_usage_updated")setLastEventAt(event.occurredAt);
      setPage(current=>current?{...current,detail:reduceTaskConversationEvent(current.detail,event)}:current);
      updates.request(event.kind==="turn_completed");
    });
    source.onopen=()=>{if(alive){setConnected(true);updates.request(true);}};
    source.onerror=()=>{if(alive){setConnected(false);updates.request(true);}};
    return()=>{alive=false;sequence.current++;updates.dispose();source.close();};
  }, [task.id, threadId, refreshKey]);

  const latestRun = state.runs.at(-1);
  const progress = state.instructions.filter(instruction => !instruction.replyOnly&&instruction.status === "completed").length;
  const turns = page?.detail.turns ?? [];
  return <section className="tm-conversation" ref={conversationRoot} aria-label="Codex 对话和任务进度">
    <header className="tm-conversation-header">
      <div><h2><MessageSquare /> Codex 对话</h2><p>查看代理与 Worker 的原始消息和正在执行的任务。</p></div>
      {!detail.task.archived&&<button className="tp-button" onClick={onAddInstruction}>添加下一步指示</button>}
    </header>
    <div className="tm-conversation-progress" aria-live="polite">
      <span className="tm-conversation-phase">{state.heartbeat?.status === "recovering" ? <RefreshCw className="spin" /> : ["planning","working","reviewing"].includes(state.phase) ? <Loader2 className="spin" /> : state.phase === "completed" ? <Check /> : <Clock3 />}{state.heartbeat?.status === "recovering" ? `Codex 连接中断，正在第 ${state.heartbeat.recoveryAttempts} 次恢复` : phaseLabels[state.phase] ?? state.phase}</span>
      <span>{state.instructions.length} 条指示 · {progress} 条已完成</span>
      <span>第 {state.runs.length || 0} 轮</span>
      {latestRun && <span>{latestRun.jobs.filter(job => job.role === "worker" && job.status === "active").length} 个 Worker 在执行</span>}
    </div>
    {!choices.length ? <div className="tp-empty">开始执行后，这里会显示任务代理和 Worker 的真实对话。</div> :
      <div className="tm-conversation-layout">
        <nav className="tm-conversation-threads" aria-label="选择 Codex 会话">
          {choices.map(choice => <button key={choice.id} className="tm-conversation-thread" data-active={choice.job?.status==="active"} type="button" aria-current={threadId === choice.id ? "true" : undefined} onClick={() => setThreadId(choice.id)}>
            <span className="tm-conversation-avatar">{choice.role === "agent" ? <Bot /> : <TerminalSquare />}</span>
            <span><strong>{choice.label}</strong><small>{choice.role === "agent" ? "持续跟进任务" : `第 ${choice.runNumber} 轮`} · {choice.job ? jobLabels[choice.job.status] : "已创建"}</small></span>
            {choice.job?.status === "active" && <i className="tm-live-dot" aria-label="正在执行" />}
          </button>)}
        </nav>
        <div className="tm-conversation-main">
          <div className="tm-conversation-toolbar"><strong>{selected?.label ?? "Codex 会话"}</strong><TaskUsageBadge usage={page?.detail.conversation.usage}/><span className="tp-small tp-muted">{connected ? "实时连接" : "连接中 · 自动重试"}{syncedAt&&<small className="tm-sync-time">同步于 {new Date(syncedAt).toLocaleTimeString()}</small>}</span><button className="tp-button tp-ghost" type="button" aria-label="刷新对话" onClick={() => setRefreshKey(value => value + 1)}><RefreshCw /></button></div>
          <ConversationActivity detail={page?.detail} fallbackRunning={selected?.job?.status==="active"} connected={connected} lastEventAt={lastEventAt} approvalCount={page?.approvals.length??0}/>
          {error && <div className="tm-error" role="alert">{error}</div>}
          {loading && !page && <p className="tm-conversation-state"><Loader2 className="spin" /> 正在读取 Codex 消息…</p>}
          {!loading && !turns.length && !error && <p className="tm-conversation-state">这个会话还没有消息。</p>}
          <div className="tm-conversation-scroll-area">
          <div className="tm-conversation-turns" ref={turnsRef} onScroll={updateScrollPosition} role="log" aria-live="polite" aria-relevant="additions text">
            {turns.map((turn, index) => <section className="tm-conversation-turn" data-live={turn.status==="in_progress"} key={turn.id} aria-label={`第 ${index + 1} 轮 Codex 对话`}>
              <div className="tm-conversation-turn-head"><span>对话 {index + 1} · {turnLabels[turn.status]}</span>{turn.startedAt && <time dateTime={turn.startedAt}>{new Date(turn.startedAt).toLocaleString()}</time>}</div>
              {groupConversationItems(turn.items).map(group => group.kind === "commands"
                ? <CommandGroupView items={group.items} key={group.key} />
                : <ConversationItemView item={group.item} agent={selected?.role==="agent"} streaming={turn.status==="in_progress"&&group.item.id===turn.items.at(-1)?.id} key={group.key} />)}
              {turn.status === "in_progress" && <p className="tm-conversation-wait"><Loader2 className="spin" /> 正在接收新消息…</p>}
              {turn.error && <p className="tm-error">{turn.error.message}</p>}
            </section>)}
          </div>
          {showJumpToLatest && <button className="tm-conversation-jump" type="button" onClick={jumpToLatest} aria-label="跳到最新消息"><ArrowDown size={16} /> {hasNewUpdates?"有新动态 · 跳到最新":"跳到最新"}</button>}
          </div>
          {page?.page.nextBeforeTurnId && <p className="tp-small tp-muted">显示最近 50 轮对话。更早记录可在旧任务工作台的 Codex 会话中查看。</p>}
        </div>
      </div>}
  </section>;
}

function ConversationItemView({ item,streaming=false,agent=false }: { item: TaskConversationItem;streaming?:boolean;agent?:boolean }) {
  if (item.kind === "user") return <article className="tm-message tm-message-user"><div className="tm-message-label"><UserRound /> 发送给 Codex</div><details><summary>查看本轮输入 · {item.text.length} 字</summary><pre>{item.text}</pre></details></article>;
  if (item.kind === "assistant") {
    const structured = parseMessage(item.text,agent);
    return <article className="tm-message tm-message-assistant" data-streaming={streaming&&item.phase!=="final"}><div className="tm-message-label"><Bot /> Codex {item.phase === "commentary" ? "进度消息" : "回复"}</div>
      {structured?.internal ? <details className="tm-agent-internal"><summary>内部执行安排</summary><pre>{item.text}</pre></details> : structured?.text ? <><div className="tm-message-primary"><MarkdownContent source={structured.text}/></div><details><summary>查看 Codex 原始消息</summary><pre>{item.text}</pre></details></> : agent&&item.text.trim().startsWith("{") ? <><p>代理正在整理任务进展…</p><details><summary>查看生成中的原始消息</summary><pre>{item.text}</pre></details></> : <MarkdownContent source={item.text || "正在生成回复…"}/>} {streaming&&item.phase!=="final"&&<span className="tm-stream-cursor" aria-hidden="true">▍</span>}
    </article>;
  }
  if (item.kind === "reasoning") return item.summary.length ? <details className="tm-message tm-message-tool"><summary>推理概要</summary>{item.summary.map((entry, index) => <p key={index}>{entry}</p>)}</details> : null;
  if (item.kind === "plan") return agent?<details className="tm-message tm-message-tool tm-agent-internal"><summary><FileCode2/>内部执行计划</summary><pre>{item.text}</pre></details>:<article className="tm-message tm-message-tool"><div className="tm-message-label"><FileCode2 /> 执行计划</div><pre>{item.text}</pre></article>;
  if (item.kind === "command") return <CommandItemView item={item} />;
  if (item.kind === "file_change") return <details className="tm-message tm-message-tool"><summary><FileCode2 /> 文件改动 · {item.paths.length} 个文件</summary><p>{item.paths.join("、")}</p>{item.changes?.map((change, index) => <details key={`${change.path}-${index}`}><summary>{change.path}</summary><pre>{change.diff || "Codex 未提供 Diff"}</pre></details>)}</details>;
  if (item.kind === "tool") return <details className="tm-message tm-message-tool"><summary>{item.server || "工具"} / {item.tool} · {item.status}</summary>{item.summary && <pre>{item.summary}</pre>}</details>;
  if (item.kind === "activity") return <p className="tm-conversation-activity"><CircleAlert /> {item.label}</p>;
  return null;
}

type CommandItem = Extract<TaskConversationItem, { kind: "command" }>;

function CommandItemView({ item }: { item: CommandItem }) {
  return <details className="tm-message tm-message-tool tm-command-item" data-running={isConversationItemRunning(item.status)}>
    <summary><ChevronRight className="tm-disclosure-chevron" />{isConversationItemRunning(item.status)?<Loader2 className="spin"/>:<TerminalSquare/>}<span>命令 · {item.status || "执行中"}</span><code className="tm-command-preview" title={item.command}>{item.command}</code></summary>
    <pre className="tm-command-full">{item.command}</pre>
    {item.output && <pre>{item.output}</pre>}
    {item.outputTruncated && <p className="tp-small tp-muted">输出已截断</p>}
    {item.exitCode !== undefined && <p className="tp-small tp-muted">退出码：{item.exitCode}</p>}
  </details>;
}

function CommandGroupView({ items }: { items: CommandItem[] }) {
  return <details className="tm-message tm-message-tool tm-command-group" data-running={items.some(item=>isConversationItemRunning(item.status))}>
    <summary><ChevronRight className="tm-disclosure-chevron" /><TerminalSquare /><span>连续执行 {items.length} 条命令</span><code className="tm-command-preview" title={items[0].command}>{items[0].command}</code></summary>
    <div className="tm-command-group-items">{items.map(item => <CommandItemView item={item} key={item.id} />)}</div>
  </details>;
}

function parseMessage(raw: string,agent:boolean): {text?:string;internal?:boolean} | null {
  if (!raw.trim().startsWith("{")) return null;
  try {
    const message = JSON.parse(raw) as Record<string, unknown>;
    const publicText=[message.userUpdate,message.summary].find(value=>typeof value==="string"&&value.trim()) as string|undefined;
    if(publicText)return {text:publicText};
    if(agent&&Array.isArray(message.workers))return {internal:true};
    const fallback=[message.understanding,message.instructions].find(value=>typeof value==="string"&&value.trim()) as string|undefined;
    return fallback?{text:fallback}:null;
  } catch { return null; }
}
