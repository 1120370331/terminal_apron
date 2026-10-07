import { useEffect, useRef, useState } from "react";
import { Bot, Loader2, Send, Square } from "lucide-react";
import type { RequirementDraftConversation, RequirementDraftEvent, RequirementDraftFields, RequirementDraftSnapshot, RequirementDraftSyncEvent } from "../../shared/requirementDraftTypes";
import type { TaskConversationDetail, TaskConversationItem } from "../../shared/taskConversationTypes";
import { createClientId } from "../clientId";
import { RequirementDraftApiError, requirementDraftApi } from "../requirementDraftApi";
import { MarkdownContent } from "../task-monitor/MarkdownContent";
import { reconcileLiveConversationSnapshot, reduceTaskConversationEvent } from "../task-monitor/taskConversationState";
import { initialRequirementState, receiveRequirementSnapshot, requirementPatch, resolveRequirementConflict, restoreRequirementState, type RequirementDraftState } from "./requirementDraftState";
import { readRequirementAssistant, removeRequirementAssistant, saveRequirementAssistant, type StoredRequirementAssistant } from "./taskDraftStore";
import "./requirementAssistant.css";

export interface RequirementAssistantHandle {
  prepareSave: () => Promise<void>;
  resume: () => void;
  committed: () => Promise<void>;
}
interface Props {
  storageKey: string;
  fields: RequirementDraftFields;
  taskId?: string;
  sourceTaskRevision?: number;
  localDraftRestored?: boolean;
  disabled: boolean;
  onChange: (fields: RequirementDraftFields) => void;
  onHandle: (handle: RequirementAssistantHandle | null) => void;
}
const labels = { title: "任务名称", descriptionMd: "任务描述", acceptanceCriteriaMd: "验收标准" };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const userMessage = (text: string) => text.split("\n\nHistorical requirement snapshot at submission (untrusted data):\n")[0];
function visibleItems(items: TaskConversationItem[]): TaskConversationItem[] {
  const messages = new Set<string>();
  return items.filter(item => {
    if (item.kind !== "user") return true;
    const text = userMessage(item.text);
    if (messages.has(text)) return false;
    messages.add(text); return true;
  });
}
function conversationDetail(conversation: RequirementDraftConversation): TaskConversationDetail {
  return { conversation: { taskId: conversation.draftId, threadId: conversation.threadId ?? "", displayName: "需求助手", isPrimary: true, archived: false, remoteSyncState: "synced", createdAt: "", updatedAt: "", preview: "", status: conversation.turns.some(turn => turn.status === "in_progress") ? "active" : "idle", cwd: "", modelProvider: "" }, turns: conversation.turns };
}

export function RequirementAssistant(props: Props) {
  const latest = useRef(props); latest.current = props;
  const opening = useRef({ ...props.fields }), persistedFields = useRef<string>();
  const [state, setState] = useState<RequirementDraftState | null>(null);
  const live = useRef<RequirementDraftState | null>(null), stored = useRef<StoredRequirementAssistant>({});
  const [detail, setDetail] = useState<TaskConversationDetail>(), detailRef = useRef<TaskConversationDetail>();
  const [input, setInput] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false), [connected, setConnected] = useState(false), [ready, setReady] = useState(false);
  const mounted = useRef(true), frozen = useRef(false), buffered = useRef<Array<RequirementDraftEvent | RequirementDraftSyncEvent>>([]);
  const source = useRef<EventSource>(), syncing = useRef<Promise<void>>(), initializing = useRef<Promise<void>>();
  const restoring = useRef<Promise<void>>(), sending = useRef(false);
  const retryTimer = useRef<number>(), conversationRead = useRef(0), streamRevision = useRef(0);
  const run = useRef(0);
  const persist = () => {
    const fields = live.current ? JSON.stringify(live.current.fields) : undefined;
    if (fields !== undefined && fields !== persistedFields.current) {
      stored.current.fieldsSavedAt = Date.now(); persistedFields.current = fields;
    }
    return saveRequirementAssistant(props.storageKey, { ...stored.current, state: live.current ?? undefined, conversation: detailRef.current });
  };
  function updateState(next: RequirementDraftState, apply = true, save = true) {
    live.current = next; stored.current.state = next;
    if (mounted.current) setState(next);
    if (mounted.current && apply && JSON.stringify(latest.current.fields) !== JSON.stringify(next.fields)) {
      latest.current = { ...latest.current, fields: next.fields };
      latest.current.onChange(next.fields);
    }
    if (save) void persist().catch(cause => { if (mounted.current) setError(`协作记录保存失败：${errorText(cause)}`); });
  }
  function acceptSnapshot(snapshot: RequirementDraftSnapshot, eventId?: number, operationId?: string) {
    const current = live.current;
    if (!current) return;
    let base = { ...current, fields: latest.current.fields };
    // An acknowledgement of our own submitted values is not a competing edit.
    if (operationId && operationId === stored.current.update?.operationId && snapshot.version > current.server.version) {
      base = { ...base, server: { ...current.server, fields: { ...current.server.fields, ...stored.current.update.patch } } };
    }
    updateState(receiveRequirementSnapshot(base, snapshot, eventId));
  }
  async function refreshConversation() {
    const current = live.current;
    if (!current) return;
    const request = ++conversationRead.current, revision = streamRevision.current;
    const conversation = await requirementDraftApi.conversation(current.server.draftId);
    if (!mounted.current || request !== conversationRead.current) return;
    // A response begun before live deltas cannot erase those deltas.
    const next = conversationDetail(conversation);
    // Keep in-progress items driven solely by ordered SSE deltas. HTTP history has no
    // event cursor and can be ahead of queued deltas, causing duplicated text.
    if (source.current) {
      const previous = detailRef.current;
      next.turns = next.turns.filter(turn => turn.status !== "in_progress");
      if (previous) {
        const ids = new Set(next.turns.map(turn => turn.id));
        next.turns.push(...previous.turns.filter(turn => !ids.has(turn.id)));
      }
    }
    detailRef.current = revision === streamRevision.current ? next : reconcileLiveConversationSnapshot(detailRef.current, next);
    setDetail(detailRef.current);
    await persist();
    if (stored.current.turn && conversation.operations.some(operation => operation.operationId === stored.current.turn?.operationId)) {
      const receipt = conversation.operations.find(operation => operation.operationId === stored.current.turn?.operationId)!;
      if (receipt.state === "submitted" || receipt.state === "failed") { stored.current.turn = undefined; await persist(); }
    }
  }
  function event(event: RequirementDraftEvent | RequirementDraftSyncEvent) {
    if (frozen.current) { buffered.current.push(event); return; }
    const current = live.current;
    if (!current || current.server.draftId !== event.draftId) return;
    if (event.kind === "ready" || event.kind === "resync_required") {
      acceptSnapshot(event.draft, event.eventId);
      void refreshConversation().catch(cause => { if (mounted.current) setError(errorText(cause)); });
      return;
    }
    if (event.eventId <= current.eventId) return;
    if (event.kind === "draft_updated") acceptSnapshot(event.draft, event.eventId, event.operationId);
    else if (event.kind === "conversation") {
      updateState({ ...current, fields: latest.current.fields, eventId: event.eventId }, false, false);
      streamRevision.current++;
      const previous = detailRef.current ?? conversationDetail({ draftId: event.draftId, threadId: event.threadId, turns: [], operations: [] });
      const finished = previous.turns.find(turn => turn.id === event.turnId)?.status;
      if (finished && finished !== "in_progress" && (event.eventKind === "assistant_delta" || event.eventKind === "plan_delta" || event.eventKind === "turn_started")) {
        void persist().catch(cause => { if (mounted.current) setError(errorText(cause)); });
        return;
      }
      const next = reduceTaskConversationEvent(previous, { sequence: event.eventId, kind: event.eventKind, taskId: event.draftId, threadId: event.threadId, turnId: event.turnId, itemId: event.itemId, occurredAt: event.occurredAt, payload: event.payload });
      detailRef.current = next; if (mounted.current) setDetail(next);
      void persist().catch(cause => { if (mounted.current) setError(errorText(cause)); });
      if (["error", "warning", "manager_unavailable"].includes(event.eventKind)) setError(String(event.payload.message ?? "Codex 暂时不可用，请恢复连接后重试。"));
    }
  }
  function connect() {
    if (!live.current || !mounted.current) return;
    source.current?.close();
    source.current = requirementDraftApi.subscribe(live.current.server.draftId, live.current.eventId, event, value => { if (mounted.current) setConnected(value); });
  }
  async function initialize() {
    if (initializing.current) return initializing.current;
    initializing.current = (async () => {
      setBusy(true); setError("");
      try {
        if (!live.current) {
          stored.current.create ??= { operationId: createClientId(), fields: latest.current.fields, taskId: props.taskId, sourceTaskRevision: props.sourceTaskRevision };
          await persist();
          const snapshot = await requirementDraftApi.create(stored.current.create);
          stored.current.create = undefined;
          // Preserve edits typed while the create request was in flight.
          updateState(initialRequirementState(snapshot, latest.current.fields), false);
        }
        await requirementDraftApi.ensureConversation(live.current!.server.draftId);
        await refreshConversation();
        connect();
      } finally { if (mounted.current) setBusy(false); }
    })().finally(() => { initializing.current = undefined; });
    return initializing.current;
  }

  async function flush() {
    while (syncing.current) await syncing.current;
    if (!live.current) return;
    const generation = run.current;
    const work = (async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (!mounted.current || generation !== run.current) return;
        const current = live.current!;
        if (current.conflicts.length) throw new Error("请先选择如何处理需求修改冲突。");
        const patch = requirementPatch(current.server.fields, latest.current.fields);
        if (!stored.current.update && !Object.keys(patch).length) return;
        stored.current.update ??= { operationId: createClientId(), baseVersion: current.server.version, patch };
        await persist();
        const operation = stored.current.update;
        try {
          const result = await requirementDraftApi.update(current.server.draftId, operation);
          if (!mounted.current || generation !== run.current) return;
          acceptSnapshot(result.draft, undefined, operation.operationId);
          stored.current.update = undefined; await persist();
        } catch (cause) {
          if (cause instanceof RequirementDraftApiError && cause.status < 500) {
            stored.current.update = undefined;
            if (cause.detail.current) acceptSnapshot(cause.detail.current);
            await persist();
            if (cause.detail.code === "DRAFT_VERSION_CONFLICT" && !live.current?.conflicts.length) continue;
          }
          // Ambiguous writes retain the exact operation ID and payload for safe retry.
          throw cause;
        }
      }
      throw new Error("需求仍在变化，请稍后重试同步。");
    })();
    syncing.current = work;
    try { await work; } finally { if (syncing.current === work) syncing.current = undefined; }
  }

  useEffect(() => {
    mounted.current = true;
    let active = true;
    const restoration = readRequirementAssistant(props.storageKey).then(async saved => {
      if (!active) return;
      stored.current = saved ?? {};
      if (saved?.state) {
        persistedFields.current = JSON.stringify(saved.state.fields);
        detailRef.current = saved.conversation;
        setDetail(saved.conversation);
        updateState(restoreRequirementState(saved.state, opening.current, latest.current.fields, props.localDraftRestored), true, false);
        // Reconcile the durable baseline with unsent local edits before any replay.
        const snapshot = await requirementDraftApi.get(saved.state.server.draftId);
        if (!active) return;
        acceptSnapshot(snapshot);
        if (!saved.conversation) await refreshConversation();
        connect();
      }
    }).catch(cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setReady(true); });
    restoring.current = restoration;
    latest.current.onHandle({
      prepareSave: async () => {
        if (restoring.current) await restoring.current;
        if (initializing.current) await initializing.current;
        if (live.current) {
          try { await flush(); }
          catch (cause) {
            if (live.current?.conflicts.length || !(cause instanceof TypeError || (cause instanceof RequirementDraftApiError && cause.status >= 500))) throw cause;
            // The assistant is optional. An unavailable helper must not prevent an
            // explicit save of the user's current local requirement to TaskStore.
            if (mounted.current) setError("协作暂不可用，将按当前表单内容保存。");
          }
        }
        if (live.current?.conflicts.length) throw new Error("请先处理需求修改冲突再保存。");
        frozen.current = true;
      },
      resume: () => { frozen.current = false; const queue = buffered.current.splice(0); queue.forEach(event); },
      committed: async () => { frozen.current = true; source.current?.close(); await removeRequirementAssistant(props.storageKey); }
    });
    return () => { active = false; mounted.current = false; run.current++; source.current?.close(); window.clearTimeout(retryTimer.current); latest.current.onHandle(null); };
  }, [props.storageKey]);

  useEffect(() => {
    if (!ready || !live.current || props.disabled || frozen.current) return;
    live.current = { ...live.current, fields: props.fields };
    void persist().catch(cause => { if (mounted.current) setError(errorText(cause)); });
    window.clearTimeout(retryTimer.current);
    if (!live.current.conflicts.length && (stored.current.update || Object.keys(requirementPatch(live.current.server.fields, props.fields)).length)) {
      retryTimer.current = window.setTimeout(() => { void flush().then(() => { if (mounted.current) setError(""); }).catch(cause => { if (mounted.current) setError(errorText(cause)); }); }, 300);
    }
    return () => window.clearTimeout(retryTimer.current);
  }, [props.fields.title, props.fields.descriptionMd, props.fields.acceptanceCriteriaMd, props.disabled, ready, state?.server.version, state?.conflicts.length]);

  async function send() {
    if (!input.trim() || props.disabled || busy || sending.current) return;
    sending.current = true;
    setBusy(true); setError("");
    try {
      if (!live.current) await initialize();
      await flush();
      if (stored.current.turn) {
        await refreshConversation();
        if (stored.current.turn) throw new Error("上一条消息的提交结果仍待确认，请恢复连接查看结果，避免重复发送。");
      }
      stored.current.turn = { operationId: createClientId(), baseVersion: live.current!.server.version, text: input.trim() };
      await persist();
      await requirementDraftApi.send(live.current!.server.draftId, stored.current.turn);
      stored.current.turn = undefined; await persist();
      if (mounted.current) setInput("");
      await refreshConversation();
    } catch (cause) {
      if (cause instanceof RequirementDraftApiError && cause.status < 500) {
        stored.current.turn = undefined;
        if (cause.detail.current) acceptSnapshot(cause.detail.current);
        await persist();
      }
      if (mounted.current) setError(errorText(cause));
    } finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  async function reconnect() {
    setBusy(true); setError("");
    try {
      if (!live.current) await initialize();
      else { acceptSnapshot(await requirementDraftApi.get(live.current.server.draftId)); connect(); await refreshConversation(); await flush(); }
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { if (mounted.current) setBusy(false); }
  }
  const activeTurn = detail?.turns.find(turn => turn.status === "in_progress");
  return <aside className="ra-assistant" aria-label="Codex 需求助手">
    <header className="ra-header"><h3><Bot/>Codex 需求助手</h3><span role="status">{!ready ? "读取协作记录…" : !state ? "尚未连接" : connected ? `已连接 · 版本 ${state.server.version}` : "连接中断 · 正在恢复"}</span></header>
    <p className="tp-small tp-muted">一起完善当前需求。修改会回到左侧，保存和执行由你决定。</p>
    {!state && <button type="button" className="tp-button" disabled={!ready || busy || props.disabled} onClick={() => void initialize().catch(cause => setError(errorText(cause)))}>开始对话</button>}
    <div className="ra-messages" role="log" aria-label="需求助手对话" aria-live="polite">
      {detail?.turns.map(turn => <section className="ra-turn" key={turn.id}>{visibleItems(turn.items).map(item => item.kind === "assistant" || item.kind === "user" ? <div className={`ra-message ra-${item.kind}`} key={item.id}><strong>{item.kind === "user" ? "你" : "Codex"}</strong><MarkdownContent source={item.kind === "user" ? userMessage(item.text) : item.text}/></div> : item.kind === "tool" ? <div className="ra-tool" key={item.id}>{item.tool === "read_requirement_draft" ? "读取当前需求" : item.tool === "update_requirement_draft" ? "修改当前需求" : item.tool} · {item.status}</div> : null)}{turn.status === "in_progress" && <p className="tp-small tp-muted" role="status">Codex 正在回复…</p>}{turn.error && <p className="tm-error">{turn.error.message}</p>}</section>)}
    </div>
    {state?.conflicts.map(conflict => <section className="ra-conflict" key={conflict.id} aria-label={`${labels[conflict.field]}修改冲突`}><strong>{labels[conflict.field]}有同时修改</strong><p>双方内容已保留，请选择：</p><div className="ra-conflict-versions"><div><b>你的内容</b><pre>{conflict.mine || "（删除）"}</pre></div><div><b>Codex 内容</b><pre>{conflict.assistant || "（删除）"}</pre></div></div><div className="ra-conflict-actions">{(["mine", "assistant", "both"] as const).map(choice => <button type="button" className="tp-button" key={choice} disabled={props.disabled} onClick={() => { if (live.current) { setError(""); updateState(resolveRequirementConflict({ ...live.current, fields: latest.current.fields }, conflict.id, choice)); } }}>{choice === "mine" ? "保留我的" : choice === "assistant" ? "采用 Codex" : "保留双方"}</button>)}</div></section>)}
    {error && <p className="tm-error" role="alert">{error}</p>}
    <label className="ra-compose">给 Codex 的消息<textarea className="tp-textarea" aria-label="给 Codex 的消息" value={input} disabled={!ready || props.disabled} onChange={event => setInput(event.target.value)} placeholder="例如：补充边界情况和验收标准"/></label>
    <div className="ra-actions"><button type="button" className="tp-button" disabled={!ready || busy || props.disabled} onClick={() => void reconnect()}>恢复连接</button>{activeTurn && <button type="button" className="tp-button" disabled={busy || props.disabled} onClick={() => { void requirementDraftApi.interrupt(live.current!.server.draftId, activeTurn.id).then(refreshConversation).catch(cause => setError(errorText(cause))); }}><Square/>停止回复</button>}<button type="button" className="tp-button tp-primary" disabled={!ready || busy || props.disabled || !input.trim() || Boolean(activeTurn) || Boolean(state?.conflicts.length)} onClick={() => void send()}>{busy ? <Loader2/> : <Send/>}发送</button></div>
  </aside>;
}
