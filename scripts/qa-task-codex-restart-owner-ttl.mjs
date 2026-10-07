import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = process.cwd();
const dataDir = path.join(repoRoot, ".local-test-data", "qa-task-codex-restart-owner-ttl");
const port = 3250;
const host = "127.0.0.1";
const baseUrl = `http://${host}:${port}`;
let child = null;

await fs.rm(dataDir, { recursive: true, force: true });
await fs.mkdir(dataDir, { recursive: true });

try {
  await startServer();
  await waitForHealth();
  const task = await requestJson("POST", "/api/tasks", {
    title: "QA restart TTL",
    repositoryPath: repoRoot,
    maxConcurrency: 1
  });
  const conversation = await requestJson("POST", `/api/tasks/${encodeURIComponent(task.id)}/conversations`, {
    clientMessageId: "qa-restart-create-0001",
    displayName: "restart ttl"
  });
  await stopServer();
  await startServer();
  await waitForHealth();
  const immediate = await request("GET", `/api/tasks/${encodeURIComponent(task.id)}/conversations`);
  await delay(22_000);
  const afterTtl = await request("GET", `/api/tasks/${encodeURIComponent(task.id)}/conversations`);
  process.stdout.write(JSON.stringify({
    threadId: conversation?.conversation?.threadId,
    immediateStatus: immediate.statusCode,
    immediateBody: immediate.body,
    afterTtlStatus: afterTtl.statusCode,
    afterTtlBody: afterTtl.body
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
  await delay(2_000);
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const health = await requestJson("GET", "/api/health");
      if (health?.codexConversations?.topology) {
        return;
      }
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
