import crypto from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";

const threads = new Map();
const approvals = new Map();
let threadCounter = 0;
let turnCounter = 0;
let itemCounter = 0;
let requestCounter = 0;

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  void handleMessage(message);
});

async function handleMessage(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    reply(id, { capabilities: { experimentalApi: false } });
    return;
  }
  if (method === "initialized") {
    return;
  }
  if (method === "model/list") {
    reply(id, { models: [{ id: "fake-codex", displayName: "Fake Codex", isDefault: true, supportedReasoningEfforts: ["minimal", "low", "medium", "high"] }] });
    return;
  }
  if (method === "thread/start") {
    const threadId = nextId("thread", ++threadCounter);
    const thread = { id: threadId, cwd: params.cwd ?? "", name: "", status: { type: "idle" }, turns: [] };
    threads.set(threadId, thread);
    reply(id, { thread });
    return;
  }
  if (method === "test/seed") {
    const threadCount = boundedInteger(params.threadCount, 1, 100, 20);
    const turnCount = boundedInteger(params.turnCount, 1, 200, 50);
    const itemsPerTurn = boundedInteger(params.itemsPerTurn, 1, 50, 10);
    const cwd = String(params.cwd ?? "");
    let selectedThreadId = "";
    for (let threadIndex = 0; threadIndex < threadCount; threadIndex += 1) {
      const threadId = nextId("thread", ++threadCounter);
      const thread = { id: threadId, cwd, name: `Seeded ${threadIndex + 1}`, status: { type: "idle" }, turns: [] };
      for (let turnIndex = 0; turnIndex < turnCount; turnIndex += 1) {
        const turn = { id: nextId("turn", ++turnCounter), status: "completed", startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), items: [] };
        for (let itemIndex = 0; itemIndex < itemsPerTurn; itemIndex += 1) {
          const item = createItem(itemIndex % 2 === 0 ? "userMessage" : "agentMessage");
          item.text = `seed-${threadIndex + 1}-${turnIndex + 1}-${itemIndex + 1}`;
          if (item.type === "agentMessage") item.phase = "final";
          turn.items.push(item);
        }
        thread.turns.push(turn);
      }
      threads.set(threadId, thread);
      if (threadIndex === 0) selectedThreadId = threadId;
    }
    reply(id, { selectedThreadId, threadCount, turnCount, itemsPerTurn });
    return;
  }
  if (method === "thread/list") {
    const cwd = String(params.cwd ?? "");
    const data = [...threads.values()].filter((thread) => !thread.archived && (!cwd || thread.cwd === cwd)).map(cloneThread);
    reply(id, { data, nextCursor: null });
    return;
  }
  if (method === "thread/resume") {
    const thread = requireThread(params.threadId);
    thread.cwd = params.cwd ?? thread.cwd;
    reply(id, { thread });
    return;
  }
  if (method === "thread/read") {
    const thread = requireThread(params.threadId);
    const configuredDelay = readConfiguredDelay();
    if (configuredDelay > 0 || thread.name.includes("SLOW_HISTORY")) await sleep(configuredDelay > 0 ? configuredDelay : 1_000);
    reply(id, { thread: cloneThread(thread) });
    return;
  }
  if (method === "thread/name/set") {
    const thread = requireThread(params.threadId);
    thread.name = String(params.name ?? "");
    reply(id, { thread });
    return;
  }
  if (method === "thread/archive") {
    const thread = requireThread(params.threadId);
    thread.archived = true;
    reply(id, { ok: true });
    return;
  }
  if (method === "turn/start") {
    const thread = requireThread(params.threadId);
    const inputText = extractInputText(params.input);
    const turn = {
      id: nextId("turn", ++turnCounter),
      status: "inProgress",
      startedAt: new Date().toISOString(),
      completedAt: undefined,
      omitCompletionNotification: inputText.includes("SILENT_INTERRUPT"),
      items: []
    };
    thread.turns.push(turn);
    thread.status = { type: "active" };
    reply(id, { turn: cloneTurn(turn) });
    notify("turn/started", { threadId: thread.id, turnId: turn.id, turn: cloneTurn(turn) });
    if (inputText.includes("NEED_APPROVAL_COMMAND")) {
      await emitApprovalTurn(thread, turn, inputText);
      return;
    }
    if (inputText.includes("MANY_EVENTS")) {
      await emitManyEvents(thread, turn);
      return;
    }
    if (inputText.includes("SEED_HISTORY_500")) {
      await emitSeededHistory(thread, turn);
      return;
    }
    if (inputText.includes("LONG_RUNNING")) {
      await emitLongRunning(thread, turn);
      return;
    }
    await emitAssistantTurn(thread, turn, scriptedResponse(inputText));
    return;
  }
  if (method === "turn/steer") {
    const thread = requireThread(params.threadId);
    const turn = requireTurn(thread, params.expectedTurnId);
    const text = extractInputText(params.input);
    turn.steerText = text;
    reply(id, { ok: true });
    return;
  }
  if (method === "turn/interrupt") {
    const thread = requireThread(params.threadId);
    const turn = requireTurn(thread, params.turnId);
    finalizeTurn(thread, turn, "interrupted", undefined, !turn.omitCompletionNotification);
    reply(id, { ok: true });
    return;
  }
  replyError(id, -32601, `Unsupported method: ${method}`);
}

async function emitAssistantTurn(thread, turn, text) {
  const assistantItem = createItem("agentMessage");
  assistantItem.phase = "final";
  assistantItem.text = "";
  turn.items.push(assistantItem);
  notify("item/started", { threadId: thread.id, turnId: turn.id, itemId: assistantItem.id, item: cloneItem(assistantItem) });
  const segments = chunkText(text, 18);
  for (const segment of segments) {
    if (turn.status !== "inProgress") return;
    assistantItem.text += segment;
    notify("item/agentMessage/delta", { threadId: thread.id, turnId: turn.id, itemId: assistantItem.id, delta: segment });
    await sleep(40);
  }
  notify("item/completed", { threadId: thread.id, turnId: turn.id, itemId: assistantItem.id, item: cloneItem(assistantItem) });
  finalizeTurn(thread, turn, "completed");
}

async function emitLongRunning(thread, turn) {
  const assistantItem = createItem("agentMessage");
  assistantItem.phase = "commentary";
  assistantItem.text = "";
  turn.items.push(assistantItem);
  notify("item/started", { threadId: thread.id, turnId: turn.id, itemId: assistantItem.id, item: cloneItem(assistantItem) });
  for (let index = 1; index <= 200; index += 1) {
    if (turn.status !== "inProgress") return;
    const segment = `${index}\n`;
    assistantItem.text += segment;
    notify("item/agentMessage/delta", { threadId: thread.id, turnId: turn.id, itemId: assistantItem.id, delta: segment });
    await sleep(25);
  }
  assistantItem.phase = "final";
  notify("item/completed", { threadId: thread.id, turnId: turn.id, itemId: assistantItem.id, item: cloneItem(assistantItem) });
  finalizeTurn(thread, turn, "completed");
}

async function emitApprovalTurn(thread, turn, inputText) {
  const item = createItem("commandExecution");
  item.command = ["pwd"];
  item.cwd = thread.cwd;
  item.status = "awaiting_approval";
  turn.items.push(item);
  notify("item/started", { threadId: thread.id, turnId: turn.id, itemId: item.id, item: cloneItem(item) });
  const requestId = `approval-${++requestCounter}`;
  approvals.set(requestId, { threadId: thread.id, turnId: turn.id, itemId: item.id, mode: inputText.includes("FILE_CHANGE") ? "file" : "command" });
  const method = inputText.includes("FILE_CHANGE") ? "item/fileChange/requestApproval" : "item/commandExecution/requestApproval";
  const params = inputText.includes("FILE_CHANGE")
    ? { threadId: thread.id, turnId: turn.id, itemId: item.id, paths: ["src/example.txt"], reason: "Need to apply deterministic change" }
    : { threadId: thread.id, turnId: turn.id, itemId: item.id, command: ["pwd"], cwd: thread.cwd, reason: "Need workspace cwd" };
  serverRequest(requestId, method, params, async (result) => {
    const decision = String(result?.decision ?? "");
    if (decision === "accept" || decision === "acceptForSession") {
      item.status = "completed";
      item.output = thread.cwd;
      notify("item/completed", { threadId: thread.id, turnId: turn.id, itemId: item.id, item: cloneItem(item) });
      await emitAssistantTurn(thread, turn, `APPROVAL_OK ${decision} ${thread.cwd}`);
      return;
    }
    item.status = "failed";
    notify("item/completed", { threadId: thread.id, turnId: turn.id, itemId: item.id, item: cloneItem(item) });
    finalizeTurn(thread, turn, "failed", { code: "APPROVAL_DECLINED", message: "approval declined" });
  });
}

async function emitManyEvents(thread, turn) {
  const plan = createItem("plan");
  plan.text = "";
  turn.items.push(plan);
  notify("item/started", { threadId: thread.id, turnId: turn.id, itemId: plan.id, item: cloneItem(plan) });
  for (let index = 1; index <= 1205; index += 1) {
    plan.text += `step-${index}\n`;
    notify("item/plan/delta", { threadId: thread.id, turnId: turn.id, itemId: plan.id, delta: `step-${index}\n` });
    if (index % 50 === 0) {
      await sleep(2);
    }
  }
  notify("item/completed", { threadId: thread.id, turnId: turn.id, itemId: plan.id, item: cloneItem(plan) });
  finalizeTurn(thread, turn, "completed");
}

async function emitSeededHistory(thread, activeTurn) {
  thread.turns = [];
  for (let turnIndex = 1; turnIndex <= 50; turnIndex += 1) {
    const turn = {
      id: turnIndex === 50 ? activeTurn.id : nextId("turn", ++turnCounter),
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      items: []
    };
    for (let itemIndex = 1; itemIndex <= 10; itemIndex += 1) {
      const item = createItem(itemIndex % 2 === 0 ? "agentMessage" : "userMessage");
      item.text = `seed-${turnIndex}-${itemIndex}`;
      if (item.type === "agentMessage") item.phase = "final";
      turn.items.push(item);
    }
    thread.turns.push(turn);
  }
  activeTurn.status = "completed";
  activeTurn.completedAt = new Date().toISOString();
  thread.status = { type: "idle" };
  notify("turn/completed", { threadId: thread.id, turnId: activeTurn.id, turn: cloneTurn(thread.turns.at(-1)) });
}

function finalizeTurn(thread, turn, status, error, emitCompletionNotification = true) {
  if (turn.status !== "inProgress") return;
  turn.status = status;
  turn.completedAt = new Date().toISOString();
  if (error) {
    turn.error = error;
  }
  thread.status = { type: "idle" };
  if (emitCompletionNotification) {
    notify("turn/completed", { threadId: thread.id, turnId: turn.id, turn: cloneTurn(turn) });
  }
}

function serverRequest(id, method, params, onReply) {
  const payload = { id, method, params };
  write(payload);
  approvals.set(id, { ...(approvals.get(id) ?? {}), onReply });
}

// Responses to server-initiated requests arrive without a method.
rl.prependListener("line",(line)=>{try{const message=JSON.parse(line);if(message.id&&!message.method&&approvals.has(message.id)){const pending=approvals.get(message.id);if(pending?.onReply){pending.onReply(message.result??{});approvals.delete(message.id);}}}catch{}});

function reply(id, result) {
  write({ id, result });
}

function replyError(id, code, message) {
  write({ id, error: { code, message } });
}

function notify(method, params) {
  write({ method, params });
}

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function requireThread(threadId) {
  const thread = threads.get(String(threadId));
  if (!thread) {
    throw new Error(`thread not found: ${threadId}`);
  }
  return thread;
}

function requireTurn(thread, turnId) {
  const turn = thread.turns.find((entry) => entry.id === String(turnId));
  if (!turn) {
    throw new Error(`turn not found: ${turnId}`);
  }
  return turn;
}

function createItem(type) {
  return { id: nextId("item", ++itemCounter), type };
}

function cloneThread(thread) {
  return {
    id: thread.id,
    cwd: thread.cwd,
    name: thread.name,
    status: thread.status,
    turns: thread.turns.map(cloneTurn)
  };
}

function cloneTurn(turn) {
  return {
    id: turn.id,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    error: turn.error,
    items: turn.items.map(cloneItem)
  };
}

function cloneItem(item) {
  return JSON.parse(JSON.stringify(item));
}

function extractInputText(input) {
  if (!Array.isArray(input)) return "";
  return input.map((entry) => String(entry?.text ?? "")).join("\n");
}

function scriptedResponse(inputText) {
  if (inputText.includes("QA-DIRECT-PONG")) return "QA-DIRECT-PONG";
  if (inputText.includes("QA-RESTART-PONG")) return "QA-RESTART-PONG";
  if (inputText.includes("older history")) return "OLDER-HISTORY-READY";
  return inputText.includes("QA-STEERED") ? "QA-STEERED" : "FAKE-CODEX-PONG";
}

function nextId(prefix, counter) {
  return `${prefix}-${counter}-${crypto.randomUUID().slice(0, 8)}`;
}

function chunkText(text, size) {
  const chunks = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function readConfiguredDelay() {
  const controlFile = process.env.TWM_FAKE_DELAY_CONTROL_FILE;
  if (!controlFile) return Number(process.env.TWM_FAKE_THREAD_READ_DELAY_MS ?? 0);
  try { return Number(fs.readFileSync(controlFile, "utf8").trim() || 0); } catch { return 0; }
}

process.on("uncaughtException", (error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
});

rl.on("close", () => process.exit(0));
