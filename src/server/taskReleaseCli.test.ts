import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("task release CLI sends releaseStatus through the report API", async () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const script = path.join(
    repositoryRoot,
    ".agents",
    "skills",
    "manage-terminal-apron-tasks",
    "scripts",
    "task-monitor.mjs"
  );
  assert.ok(fs.existsSync(script));

  const requests: Array<{ method?: string; url?: string; body?: unknown }> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        body: body ? JSON.parse(body) : undefined
      });
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/tasks/task-1") {
        response.end(JSON.stringify({ id: "task-1", key: "TA-1" }));
        return;
      }
      response.statusCode = 201;
      response.end(
        JSON.stringify({
          id: "task-1",
          key: "TA-1",
          releaseStatus: "local_complete"
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const result = await runNode(
      [
        script,
        "report",
        "task-1",
        "--summary",
        "Local verification passed.",
        "--release-status",
        "local_complete"
      ],
      { TASK_MONITOR_URL: `http://127.0.0.1:${address.port}` }
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /TASK_MONITOR_STATE: working/);
    const report = requests.find((request) => request.url === "/api/tasks/task-1/reports");
    assert.deepEqual(report?.body, {
      status: "progress",
      summary: "Local verification passed.",
      changedFiles: [],
      verification: [],
      risks: [],
      blockers: [],
      nextStep: "",
      releaseStatus: "local_complete"
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

function runNode(
  args: string[],
  environment: Record<string, string>
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
