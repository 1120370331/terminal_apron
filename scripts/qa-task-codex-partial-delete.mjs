import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const repoRoot = process.cwd();
const dataDir = path.join(repoRoot, ".local-test-data", "qa-task-codex-partial-delete");
const port = 3252;
const host = "127.0.0.1";
const baseUrl = `http://${host}:${port}`;
let child = null;

await fs.rm(dataDir, { recursive: true, force: true });
await fs.mkdir(dataDir, { recursive: true });

try {
  await startServer();
  await waitForHealth();
  const task = await requestJson("POST", "/api/tasks", {
    title: "QA partial delete",
    repositoryPath: repoRoot,
    maxConcurrency: 1
  });
  const conversation = await requestJson("POST", `/api/tasks/${encodeURIComponent(task.id)}/conversations`, {
    clientMessageId: "qa-partial-create-0001",
    displayName: "partial"
  });
  const db = new DatabaseSync(path.join(dataDir, "task-monitor.sqlite"));
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO task_codex_threads (thread_id, task_id, display_name, is_primary, archived_at, remote_sync_state, remote_sync_operation, remote_sync_error, remote_sync_attempted_at, pending_display_name, created_at, updated_at) VALUES (?, ?, ?, 0, NULL, 'synced', NULL, NULL, NULL, NULL, ?, ?)")
      .run("thread-bogus-partial-archive", task.id, "Bogus", now, now);
  } finally {
    db.close();
  }

  const deletion = await request("DELETE", `/api/tasks/${encodeURIComponent(task.id)}`);
  const stillExists = await request("GET", `/api/tasks/${encodeURIComponent(task.id)}`);
  const db2 = new DatabaseSync(path.join(dataDir, "task-monitor.sqlite"));
  let rows;
  try {
    rows = db2.prepare("SELECT thread_id, archived_at, remote_sync_state, remote_sync_error FROM task_codex_threads WHERE task_id = ? ORDER BY thread_id").all(task.id);
  } finally {
    db2.close();
  }
  process.stdout.write(JSON.stringify({
    taskId: task.id,
    liveThreadId: conversation.conversation.threadId,
    deleteStatus: deletion.statusCode,
    deleteBody: deletion.body,
    stillExistsStatus: stillExists.statusCode,
    stillExistsBody: stillExists.body,
    rows
  }, null, 2));
} finally {
  await stopServer();
}

async function startServer() {
  child = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TWM_DATA_DIR: dataDir,
      TWM_AUTH_MODE: "none",
      TWM_PORT: String(port),
      TWM_HOST: host
    },
    stdio: "ignore"
  });
}

async function stopServer() {
  if (!child) return;
  const current = child;
  child = null;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(current.pid), "/T", "/F"], { stdio: "ignore" });
      killer.once("exit", () => resolve(undefined));
      killer.once("error", () => resolve(undefined));
    });
  } else {
    current.kill("SIGKILL");
  }
  await delay(1_500);
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const health = await requestJson("GET", "/api/health");
      if (health?.codexConversations?.topology) return;
    } catch {}
    await delay(500);
  }
  throw new Error("health timeout");
}

async function requestJson(method, pathname, body) {
  const response = await request(method, pathname, body);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`${method} ${pathname} -> ${response.statusCode}: ${response.body}`);
  }
  return JSON.parse(response.body);
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
    if (payload) req.write(payload);
    req.end();
  });
}
