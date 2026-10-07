import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ensureTaskMonitorCliCredential,
  TASK_MONITOR_CREDENTIAL_FILE_NAME,
  taskMonitorCredentialPath,
  type TaskMonitorCliCredential
} from "./taskCliCredential.js";

test("backend provisions a private current-user credential globally and in the task context", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-cli-credential-"));
  const contextDirectory = path.join(dataDir, "task-contexts", "TA-1");
  const credential: TaskMonitorCliCredential = {
    version: 1,
    url: "http://127.0.0.1:3131",
    user: "admin",
    cookie: "twm_token=signed-current-user-token",
    expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
  };
  try {
    fs.mkdirSync(contextDirectory, { recursive: true });
    const globalPath = await ensureTaskMonitorCliCredential(
      { name: "admin", method: "password" },
      dataDir,
      contextDirectory,
      { credentialFactory: async () => credential }
    );

    assert.equal(globalPath, taskMonitorCredentialPath(dataDir));
    assert.deepEqual(JSON.parse(fs.readFileSync(globalPath, "utf8")), credential);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(contextDirectory, TASK_MONITOR_CREDENTIAL_FILE_NAME), "utf8")),
      credential
    );
    await assert.rejects(
      ensureTaskMonitorCliCredential(
        { name: "admin", method: "password" },
        dataDir,
        path.join(dataDir, "outside")
      ),
      /outside the task context root/
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("TaskMonitor CLI reuses the authenticated current-user credential and downloads issue attachments", async () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const script = path.join(
    repositoryRoot,
    ".agents",
    "skills",
    "manage-terminal-apron-tasks",
    "scripts",
    "task-monitor.mjs"
  );
  const contextDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-cli-auth-"));
  const downloadedDirectory = path.join(os.tmpdir(), "terminal-apron-task-monitor", "TA-987654");
  const receivedCookies: string[] = [];
  const server = http.createServer((request, response) => {
    const cookie = request.headers.cookie ?? "";
    receivedCookies.push(cookie);
    if (cookie !== "twm_token=current-user-session") {
      response.statusCode = 401;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (request.url === "/api/tasks/task-1" && request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ id: "task-1", key: "TA-987654" }));
      return;
    }
    if (request.url === "/api/tasks/task-1/context/refresh" && request.method === "POST") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          id: "task-1",
          key: "TA-987654",
          contextDirectory,
          attachments: [
            {
              id: "attachment-1",
              name: "issue screenshot.png",
              url: "/api/tasks/task-1/attachments/attachment-1/content"
            }
          ]
        })
      );
      return;
    }
    if (request.url === "/api/tasks/task-1/reports?limit=50" && request.method === "GET") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ reports: [] }));
      return;
    }
    if (request.url === "/api/tasks/task-1/attachments/attachment-1/content" && request.method === "GET") {
      response.setHeader("Content-Type", "image/png");
      response.end(Buffer.from("authenticated-image"));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    for (const name of ["context.md", "task.md", "project.json", "reports.json", "attachments.json"]) {
      fs.writeFileSync(path.join(contextDirectory, name), name.endsWith(".json") ? "{}\n" : `${name}\n`);
    }
    fs.writeFileSync(
      path.join(contextDirectory, ".task-monitor-credential.json"),
      `${JSON.stringify({
        version: 1,
        url: `http://127.0.0.1:${address.port}`,
        user: "admin",
        cookie: "twm_token=current-user-session",
        expiresAt: new Date(Date.now() + 60_000).toISOString()
      })}\n`
    );

    const result = await runNode([script, "context", "task-1"], contextDirectory);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      task: { attachments: Array<{ localPath: string | null; downloadError?: string }> };
    };
    const attachment = payload.task.attachments[0];
    assert.ok(attachment.localPath, attachment.downloadError);
    assert.equal(fs.readFileSync(attachment.localPath, "utf8"), "authenticated-image");
    assert.ok(receivedCookies.length >= 4);
    assert.ok(receivedCookies.every((cookie) => cookie === "twm_token=current-user-session"));
    assert.doesNotMatch(result.stdout, /current-user-session/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    fs.rmSync(contextDirectory, { recursive: true, force: true });
    fs.rmSync(downloadedDirectory, { recursive: true, force: true });
  }
});

function runNode(
  args: string[],
  cwd: string
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
        TASK_MONITOR_URL: "",
        TASK_MONITOR_COOKIE: "",
        TASK_MONITOR_USER: "",
        TASK_MONITOR_PASSWORD: "",
        TASK_MONITOR_CREDENTIAL_FILE: ""
      },
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
