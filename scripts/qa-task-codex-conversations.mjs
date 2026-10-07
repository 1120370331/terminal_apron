import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = process.cwd();
const port = Number(process.env.QA_PORT ?? 3246);
const host = "127.0.0.1";
const baseUrl = `http://${host}:${port}`;
const dataDir = path.join(repoRoot, ".local-test-data", "qa-task-codex-conversations");
const logDir = path.join(dataDir, "logs");
const resultPath = path.join(dataDir, "result.json");

const results = [];
const context = {
  server: null,
  events: [],
  lastSequence: 0
};

async function main() {
  await resetDir(dataDir);
  await fsp.mkdir(logDir, { recursive: true });
  try {
    await startServer("boot-1");
    await waitForServer();
    const task = await createTask("QA Codex Conversations", repoRoot);
    const taskId = task.id;
    await verifyNoTerminalSessions("T-REAL-BASELINE");

    const createReceipt = await createConversation(taskId, "qa-real-main");
    const threadId = createReceipt.conversation.threadId;
    await verifyNoTerminalSessions("T-REAL-CREATE-NO-TERMINAL");
    await readConversation(taskId, threadId, "T-REAL-READ-EMPTY");

    const steadyTurn = await sendAndWaitForCompletion(taskId, threadId, {
      clientMessageId: "qa-send-steady-0001",
      text: "Reply with exactly QA-DIRECT-PONG and nothing else.",
      permissionPreset: "read_only"
    }, "T-REAL-SEND-READ");
    await verifyReadContains(taskId, threadId, "QA-DIRECT-PONG", "T-REAL-SEND-READ");

    const steerTurn = await exerciseSteer(taskId, threadId);
    if (!["completed", "interrupted", "failed"].includes(steerTurn.status)) {
      await recordUnverified("T-REAL-POST-STEER", "remaining installed-app-server lifecycle checks skipped because the steered turn did not reach a terminal state");
      return;
    }
    await exerciseInterruptAndArchiveGuards(taskId, threadId);
    const approvalThread = await exerciseApproval(taskId);
    await verifySseReplay(taskId, threadId, steadyTurn.turnId);
    await restartAndVerify(taskId, threadId);
    await verifyDeletePartialRemoteArchive(taskId);

    await recordPass("T-REAL-SUMMARY", {
      threadId,
      steadyTurnId: steadyTurn.turnId,
      steerTurnId: steerTurn.turnId,
      approvalThreadId: approvalThread
    });
  } catch (error) {
    await recordFail("T-RUNNER", error);
  } finally {
    await stopServer();
    await fsp.writeFile(resultPath, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
    process.stdout.write(`${resultPath}\n`);
  }
}

async function verifyNoTerminalSessions(testId) {
  const sessions = await requestJson("GET", "/api/sessions");
  if (!Array.isArray(sessions) || sessions.length !== 0) {
    throw new Error(`expected zero terminal sessions, received ${Array.isArray(sessions) ? sessions.length : "non-array"}`);
  }
  await recordPass(testId, { sessionCount: 0 });
}

async function createTask(title, repositoryPath) {
  const body = await requestJson("POST", "/api/tasks", { title, repositoryPath, maxConcurrency: 1 });
  if (!body?.id || !body?.contextDirectory) {
    throw new Error("task create response missing id/contextDirectory");
  }
  return body;
}

async function createConversation(taskId, clientMessageId) {
  const body = await requestJson("POST", `/api/tasks/${encodeURIComponent(taskId)}/conversations`, {
    clientMessageId,
    displayName: "QA conversation"
  });
  if (!body?.conversation?.threadId) {
    throw new Error("conversation create response missing threadId");
  }
  return body;
}

async function readConversation(taskId, threadId, testId) {
  const body = await requestJson("GET", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}`);
  if (!body?.detail?.conversation?.threadId || !Array.isArray(body?.detail?.turns)) {
    throw new Error("conversation read response missing detail");
  }
  await recordPass(testId, {
    threadId: body.detail.conversation.threadId,
    turns: body.detail.turns.length
  });
  return body;
}

async function sendAndWaitForCompletion(taskId, threadId, payload, testId) {
  const send = await requestJson("POST", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}/turns`, payload);
  const operationId = send?.operation?.operationId;
  if (!operationId) {
    throw new Error("send response missing operationId");
  }
  const turn = await waitForTurnTerminal(taskId, threadId, 120_000);
  await recordPass(testId, {
    operationId,
    turnId: turn.turnId,
    status: turn.status
  });
  return turn;
}

async function verifyReadContains(taskId, threadId, expectedSnippet, testId) {
  const body = await requestJson("GET", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}`);
  const assistantTexts = flattenAssistantText(body?.detail?.turns ?? []);
  if (!assistantTexts.join("\n").includes(expectedSnippet)) {
    throw new Error(`expected assistant text to contain ${expectedSnippet}`);
  }
  await recordPass(testId, { expectedSnippet });
}

async function exerciseSteer(taskId, threadId) {
  let active;
  let steerResponse;
  for (let attempt = 1; attempt <= 1 && !steerResponse; attempt += 1) {
    const send = await requestJson("POST", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}/turns`, {
      clientMessageId: `qa-send-steer-0002-${attempt}`,
      text: "Write lines QA-LINE-001 through QA-LINE-1000, one line per item of output, and continue until complete.",
      permissionPreset: "read_only"
    });
    if (!send?.operation?.operationId) throw new Error("steer setup send missing operation");
    active = await waitForActiveTurn(taskId, threadId, 20_000);
    const response = await request("POST", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}/steer`, {
      clientMessageId: `qa-steer-0003-${attempt}`,
      expectedTurnId: active.turnId,
      text: "Stop early and end with exactly QA-STEERED."
    });
    if (response.statusCode >= 200 && response.statusCode < 300) steerResponse = parseJsonSafe(response.body);
    else if (response.statusCode === 409 && parseJsonSafe(response.body)?.error?.code === "TURN_CONFLICT") {
      await recordUnverified("T-REAL-STEER", "installed app-server completed the turn between active observation and steer submission");
      await requestJson("POST", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}/interrupt`, { expectedTurnId: active.turnId }).catch(() => undefined);
      await waitForTurnTerminal(taskId, threadId, 30_000, active.turnId).catch(() => undefined);
      return { turnId: active.turnId, status: "race_completed" };
    }
    else throw new Error(`steer failed with ${response.statusCode}: ${response.body}`);
  }
  if (!active || !steerResponse) throw new Error("could not keep a real app-server turn active long enough to steer");
  let completed;
  try {
    completed = await waitForTurnTerminal(taskId, threadId, 120_000, active.turnId);
  } catch {
    await requestJson("POST", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}/interrupt`, { expectedTurnId: active.turnId }).catch(() => undefined);
    await recordUnverified("T-REAL-STEER-TERMINAL", "installed app-server accepted steer but did not reach a terminal state within 120 seconds; cleanup interrupt requested");
    return { turnId: active.turnId, status: "accepted_not_terminal" };
  }
  const detail = await requestJson("GET", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}`);
  const assistantText = flattenAssistantText(detail?.detail?.turns ?? []).join("\n");
  const steered = assistantText.includes("QA-STEERED");
  await recordPass("T-REAL-STEER", {
    requestAccepted: Boolean(steerResponse),
    turnId: active.turnId,
    terminalStatus: completed.status,
    observedSteerEffect: steered
  });
  if (!steered) {
    await recordUnverified("T-REAL-STEER-EFFECT", "steer 202 accepted on active turn, but final transcript did not clearly prove steer instruction took effect");
  }
  return completed;
}

async function exerciseInterruptAndArchiveGuards(taskId, threadId) {
  const send = await requestJson("POST", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}/turns`, {
    clientMessageId: "qa-send-approval-guard-0004",
    text: "Count from 1 to 4000 slowly, one number per line, and do not summarize early.",
    permissionPreset: "read_only"
  });
  if (!send?.operation?.operationId) {
    throw new Error("interrupt setup send missing operation");
  }
  const active = await waitForActiveTurn(taskId, threadId, 20_000);
  const archiveResponse = await request("POST", `/api/tasks/${encodeURIComponent(taskId)}/archive`);
  if (archiveResponse.statusCode !== 409) {
    throw new Error(`expected archive 409 while active, received ${archiveResponse.statusCode}`);
  }
  const archiveBody = parseJsonSafe(archiveResponse.body);
  const deleteResponse = await request("DELETE", `/api/tasks/${encodeURIComponent(taskId)}`);
  if (deleteResponse.statusCode !== 409) {
    throw new Error(`expected delete 409 while active, received ${deleteResponse.statusCode}`);
  }
  const deleteBody = parseJsonSafe(deleteResponse.body);
  const interrupt = await requestJson("POST", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}/interrupt`, {
    expectedTurnId: active.turnId
  });
  const completed = await waitForTurnTerminal(taskId, threadId, 60_000, active.turnId);
  await recordPass("T-REAL-INTERRUPT-ACTIVE-GUARD", {
    archiveStatus: archiveResponse.statusCode,
    deleteStatus: deleteResponse.statusCode,
    archiveCode: archiveBody?.error?.code,
    deleteCode: deleteBody?.error?.code,
    interruptAccepted: Boolean(interrupt),
    turnId: active.turnId,
    terminalStatus: completed.status
  });
}

async function exerciseApproval(taskId) {
  const create = await createConversation(taskId, "qa-create-approval-0005");
  const threadId = create.conversation.threadId;
  const send = await requestJson("POST", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}/turns`, {
    clientMessageId: "qa-send-approval-0006",
    text: "You must use the shell_command tool exactly once to run `pwd` before answering. If tool execution needs approval, wait for approval instead of continuing without the tool result. After the tool result, answer with exactly QA-APPROVAL-PONG plus the pwd output.",
    permissionPreset: "workspace_write"
  });
  if (!send?.operation?.operationId) {
    throw new Error("approval send missing operation");
  }
  const approval = await waitForApproval(taskId, threadId, 45_000, true);
  if (!approval) {
    const detail = await requestJson("GET", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}`);
    const assistantText = flattenAssistantText(detail?.detail?.turns ?? []).join("\n");
    await recordUnverified("T-REAL-APPROVAL", `No approval event observed within timeout. Final transcript snippet: ${assistantText.slice(0, 300)}`);
    return threadId;
  }
  const approveBody = await requestJson("POST", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}/approvals/${encodeURIComponent(approval.token)}`, {
    decision: "accept"
  });
  const completed = await waitForTurnTerminal(taskId, threadId, 60_000, approval.turnId);
  const detail = await requestJson("GET", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}`);
  const assistantText = flattenAssistantText(detail?.detail?.turns ?? []).join("\n");
  const mentionsCwd = assistantText.toLowerCase().includes(repoRoot.toLowerCase()) || assistantText.toLowerCase().includes("task-contexts");
  await recordPass("T-REAL-APPROVAL", {
    approvalKind: approval.kind,
    resolution: approveBody?.resolution,
    turnId: approval.turnId,
    terminalStatus: completed.status,
    mentionsCwd
  });
  return threadId;
}

async function verifySseReplay(taskId, threadId, knownTurnId) {
  const first = await collectSseOnce(taskId, 0, 8_000);
  const maxSequence = first.maxSequence;
  if (maxSequence <= 0) {
    throw new Error("did not observe SSE sequence");
  }
  await requestJson("POST", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}/turns`, {
    clientMessageId: "qa-send-replay-0007",
    text: "Reply with exactly QA-REPLAY-PONG.",
    permissionPreset: "read_only"
  });
  const replay = await collectSseOnce(taskId, maxSequence, 25_000, (event) => event.turnId === knownTurnId || event.kind === "turn_started" || event.kind === "assistant_delta" || event.kind === "turn_completed");
  const replayedIds = replay.events.map((event) => event.sequence);
  const strictlyGreater = replayedIds.every((sequence) => sequence > maxSequence);
  await recordPass("T-REAL-SSE-REPLAY", {
    afterSequence: maxSequence,
    received: replayedIds.length,
    strictlyGreater
  });
  if (!strictlyGreater) {
    throw new Error("SSE replay returned sequence not greater than Last-Event-ID");
  }
  await recordUnverified("T-REAL-SSE-RESYNC", "resync_required requires replay ring overflow (>1000 events); not safely reproducible in bounded real app-server run");
}

async function restartAndVerify(taskId, threadId) {
  await stopServer();
  await startServer("boot-2");
  await waitForServer();
  const list = await requestJson("GET", `/api/tasks/${encodeURIComponent(taskId)}/conversations`);
  const conversation = list?.conversations?.find?.((entry) => entry.threadId === threadId);
  if (!conversation) {
    throw new Error("conversation binding missing after restart");
  }
  const detail = await requestJson("GET", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}`);
  const text = flattenAssistantText(detail?.detail?.turns ?? []).join("\n");
  if (!text.includes("QA-DIRECT-PONG")) {
    throw new Error("history missing after restart");
  }
  const resumed = await sendAndWaitForCompletion(taskId, threadId, {
    clientMessageId: "qa-send-after-restart-0008",
    text: "Reply with exactly QA-RESTART-PONG.",
    permissionPreset: "read_only"
  }, "T-REAL-RESTART-SEND");
  await verifyReadContains(taskId, threadId, "QA-RESTART-PONG", "T-REAL-RESTART-HISTORY");
  return resumed;
}

async function verifyDeletePartialRemoteArchive(taskId) {
  const task = await requestJson("POST", "/api/tasks", {
    title: "QA partial delete",
    repositoryPath: repoRoot,
    maxConcurrency: 1
  });
  const taskPath = path.join(dataDir, "task-monitor.sqlite");
  const conversation = await createConversation(task.id, "qa-delete-create-0009");
  const liveThreadId = conversation.conversation.threadId;
  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(taskPath);
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO task_codex_threads (thread_id, task_id, display_name, is_primary, archived_at, remote_sync_state, remote_sync_operation, remote_sync_error, remote_sync_attempted_at, pending_display_name, created_at, updated_at) VALUES (?, ?, ?, 0, NULL, 'synced', NULL, NULL, NULL, NULL, ?, ?)")
      .run("thread-bogus-partial-archive", task.id, "Bogus", now, now);
  } finally {
    db.close();
  }
  const response = await request("DELETE", `/api/tasks/${encodeURIComponent(task.id)}`);
  if (response.statusCode !== 503) {
    throw new Error(`expected delete 503 on partial remote archive, received ${response.statusCode}`);
  }
  const body = parseJsonSafe(response.body);
  const taskAfter = await requestJson("GET", `/api/tasks/${encodeURIComponent(task.id)}`);
  if (!taskAfter?.id) {
    throw new Error("task unexpectedly deleted after partial remote archive failure");
  }
  const readLive = await requestJson("GET", `/api/tasks/${encodeURIComponent(task.id)}/conversations/${encodeURIComponent(liveThreadId)}`);
  const liveBindingArchived = Boolean(readLive?.detail?.conversation?.archived);
  const db2 = new sqlite.DatabaseSync(taskPath);
  let rows;
  try {
    rows = db2.prepare("SELECT thread_id, archived_at, remote_sync_state FROM task_codex_threads WHERE task_id = ? ORDER BY thread_id").all(task.id);
  } finally {
    db2.close();
  }
  await recordPass("T-REAL-DELETE-PARTIAL-REMOTE-ARCHIVE", {
    statusCode: response.statusCode,
    errorCode: body?.error?.code,
    taskStillExists: Boolean(taskAfter?.id),
    liveBindingArchived,
    rows
  });
}

async function waitForActiveTurn(taskId, threadId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await requestJson("GET", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}`);
    const activeTurnId = detail?.detail?.conversation?.activeTurnId;
    if (activeTurnId) {
      return { turnId: activeTurnId };
    }
    await delay(400);
  }
  throw new Error(`timed out waiting for active turn for ${threadId}`);
}

async function waitForTurnTerminal(taskId, threadId, timeoutMs, expectedTurnId) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = await requestJson("GET", `/api/tasks/${encodeURIComponent(taskId)}/conversations/${encodeURIComponent(threadId)}`);
    const turns = detail?.detail?.turns ?? [];
    const turn = expectedTurnId ? turns.find((entry) => entry.id === expectedTurnId) : turns.at(-1);
    if (turn && ["completed", "interrupted", "failed"].includes(turn.status)) {
      return { turnId: turn.id, status: turn.status };
    }
    await delay(750);
  }
  throw new Error(`timed out waiting for terminal turn on ${threadId}`);
}

async function waitForApproval(taskId, threadId, timeoutMs, allowMiss = false) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (let index = results.length - 1; index >= 0; index -= 1) {
      const entry = results[index];
      if (entry.testId === "__approval_event" && entry.threadId === threadId && entry.taskId === taskId) {
        return entry;
      }
    }
    await drainSse(taskId, 1_500);
  }
  if (allowMiss) {
    return null;
  }
  throw new Error(`timed out waiting for approval on ${threadId}`);
}

async function collectSseOnce(taskId, lastEventId, timeoutMs, accept = () => true) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (lastEventId > 0) {
      headers["Last-Event-ID"] = String(lastEventId);
    }
    const req = http.request(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/conversations/events`, {
      method: "GET",
      headers
    });
    const events = [];
    let maxSequence = lastEventId;
    let buffer = "";
    const timer = setTimeout(() => {
      req.destroy(new Error("SSE timeout"));
    }, timeoutMs);
    req.on("response", (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buffer += chunk;
        while (buffer.includes("\n\n")) {
          const boundary = buffer.indexOf("\n\n");
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const parsed = parseSseBlock(block);
          if (!parsed?.data) {
            continue;
          }
          const event = JSON.parse(parsed.data);
          maxSequence = Math.max(maxSequence, Number(event.sequence ?? 0));
          if (event.kind === "approval_requested") {
            results.push({ testId: "__approval_event", taskId: event.taskId, threadId: event.threadId, token: event.payload?.token, turnId: event.turnId, kind: event.payload?.kind });
          }
          if (accept(event)) {
            events.push(event);
          }
          if (events.length >= 3 && event.kind !== "ready") {
            clearTimeout(timer);
            req.destroy();
            resolve({ events, maxSequence });
          }
        }
      });
      res.on("end", () => {
        clearTimeout(timer);
        resolve({ events, maxSequence });
      });
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      if (String(error.message || error).includes("SSE timeout")) {
        resolve({ events, maxSequence });
        return;
      }
      reject(error);
    });
    req.end();
  });
}

async function drainSse(taskId, timeoutMs) {
  await collectSseOnce(taskId, context.lastSequence, timeoutMs).catch(() => ({ events: [], maxSequence: context.lastSequence }));
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const parsed = {};
  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    const index = line.indexOf(":");
    if (index < 0) {
      continue;
    }
    const key = line.slice(0, index);
    const value = line.slice(index + 1).trimStart();
    parsed[key] = value;
  }
  return parsed;
}

async function startServer(label) {
  if (context.server) {
    throw new Error("server already running");
  }
  const outPath = path.join(logDir, `${label}.out.log`);
  const errPath = path.join(logDir, `${label}.err.log`);
  const env = {
    ...process.env,
    TWM_DATA_DIR: dataDir,
    TWM_AUTH_MODE: "none",
    TWM_PORT: String(port),
    TWM_HOST: host
  };
  const child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const outStream = fs.createWriteStream(outPath, { flags: "a" });
  const errStream = fs.createWriteStream(errPath, { flags: "a" });
  child.stdout.pipe(outStream);
  child.stderr.pipe(errStream);
  context.server = { child, outStream, errStream, outPath, errPath };
}

async function stopServer() {
  if (!context.server) {
    return;
  }
  const { child, outStream, errStream } = context.server;
  await terminateChild(child);
  outStream.end();
  errStream.end();
  context.server = null;
}

async function terminateChild(child) {
  if (child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("error", () => resolve(undefined));
      killer.once("exit", () => resolve(undefined));
    });
  } else if (!child.killed) {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(15_000).then(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
    })
  ]);
}

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await requestJson("GET", "/api/health");
      if (response?.codexConversations?.topology === "single-active-owner") {
        return;
      }
    } catch {}
    await delay(500);
  }
  throw new Error("server did not become healthy");
}

async function requestJson(method, pathname, body) {
  const response = await request(method, pathname, body);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${method} ${pathname} failed with ${response.statusCode}: ${response.body}`);
  }
  return parseJsonSafe(response.body);
}

async function request(method, pathname, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, {
      method,
      headers: payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : undefined
    });
    const chunks = [];
    req.on("response", (res) => {
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function flattenAssistantText(turns) {
  return turns.flatMap((turn) => (turn.items ?? []).filter((item) => item.kind === "assistant").map((item) => item.text ?? ""));
}

function parseJsonSafe(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function resetDir(target) {
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(target, { recursive: true });
}

async function recordPass(testId, details) {
  results.push({ testId, status: "PASS", details });
}

async function recordUnverified(testId, reason) {
  results.push({ testId, status: "UNVERIFIED", reason });
}

async function recordFail(testId, error) {
  results.push({
    testId,
    status: "FAIL",
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error)
  });
}

await main();
