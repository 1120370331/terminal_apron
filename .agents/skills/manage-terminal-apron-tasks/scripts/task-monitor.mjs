#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const baseUrl = (process.env.TASK_MONITOR_URL || "http://127.0.0.1:3131").replace(/\/+$/, "");
let sessionCookie = (process.env.TASK_MONITOR_COOKIE || "").trim();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function main() {
  const command = process.argv[2] || "help";
  const parsed = parseArguments(process.argv.slice(3));

  if (["help", "--help", "-h"].includes(command)) {
    printHelp();
    return;
  }

  if (command === "list") {
    const params = new URLSearchParams();
    const status = option(parsed, "status");
    const query = option(parsed, "query");
    const project = option(parsed, "project");
    if (status) params.set("status", status);
    if (query) params.set("q", query);
    if (project !== undefined) params.set("project", project);
    if (flag(parsed, "archived")) params.set("archived", "true");
    const suffix = params.size ? `?${params}` : "";
    print(await request(`/api/tasks${suffix}`));
    return;
  }

  if (command === "projects") {
    const suffix = flag(parsed, "archived") ? "?archived=true" : "";
    print(await request(`/api/tasks/projects${suffix}`));
    return;
  }

  const taskReference = parsed.positionals[0] || process.env.TASK_MONITOR_TASK_ID;
  if (!taskReference) {
    throw new Error("A task UUID/key is required, or set TASK_MONITOR_TASK_ID.");
  }
  const task = await resolveTask(taskReference);

  if (command === "context") {
    const history = await request(`/api/tasks/${encodeURIComponent(task.id)}/reports?limit=50`);
    const attachmentContext = await downloadTaskAttachments(task);
    print({
      task: { ...task, attachments: attachmentContext.attachments },
      attachmentDirectory: attachmentContext.directory,
      reports: history.reports
    });
    return;
  }

  if (!["start", "report", "confirm", "block", "complete"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const summary = requiredOption(parsed, "summary");
  const status =
    command === "start"
      ? "started"
      : command === "block"
        ? "blocked"
        : command === "complete"
          ? "completed"
          : command === "confirm"
            ? "note"
          : option(parsed, "report-status") || "progress";
  const blockers = options(parsed, "blocker");
  if (command === "block" && blockers.length === 0) {
    throw new Error("block requires at least one --blocker.");
  }

  const verification = [
    ...options(parsed, "passed").map((value) => ({ command: value, result: "passed" })),
    ...options(parsed, "failed").map((value) => ({ command: value, result: "failed" })),
    ...options(parsed, "not-run").map((value) => ({ command: value, result: "not_run" }))
  ];
  if (command === "complete" && verification.length === 0) {
    throw new Error("complete requires --passed, --failed, or --not-run verification evidence.");
  }

  const taskStatus = option(parsed, "task-status");
  const payload = {
    status,
    summary,
    changedFiles: options(parsed, "changed-file"),
    verification,
    risks: options(parsed, "risk"),
    blockers,
    nextStep: option(parsed, "next") || "",
    ...(taskStatus === undefined ? {} : { taskStatus })
  };

  const result = await request(`/api/tasks/${encodeURIComponent(task.id)}/reports`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  print(result);
  if (command === "start" || command === "report") {
    printStateMarker("working", summary);
  } else if (command === "confirm" || command === "block") {
    printStateMarker("needs_confirmation", summary);
  } else if (command === "complete") {
    printStateMarker("completed", summary);
  }
}

async function resolveTask(reference) {
  try {
    return await request(`/api/tasks/${encodeURIComponent(reference)}`);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error;
  }

  const [active, archived] = await Promise.all([
    request("/api/tasks"),
    request("/api/tasks?archived=true")
  ]);
  const normalized = String(reference).toLowerCase();
  const matches = [...active.tasks, ...archived.tasks].filter(
    (task) => task.id.toLowerCase() === normalized || task.key.toLowerCase() === normalized
  );
  if (matches.length !== 1) {
    throw new Error(`Task ${reference} was not found by exact UUID/key.`);
  }
  return matches[0];
}

async function request(path, init = {}, allowLogin = true) {
  const headers = new Headers(init.headers || {});
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (sessionCookie) headers.set("Cookie", sessionCookie);

  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  } catch (error) {
    throw new Error(`TaskMonitor is unavailable at ${baseUrl}: ${error instanceof Error ? error.message : error}`);
  }
  if (response.status === 401 && allowLogin) {
    await login();
    return request(path, init, false);
  }
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      message = body.error || message;
    } catch {
      // Keep the HTTP status text.
    }
    throw new HttpError(response.status, `TaskMonitor ${response.status}: ${message}`);
  }
  return response.status === 204 ? null : response.json();
}

async function login() {
  const password = process.env.TASK_MONITOR_PASSWORD;
  if (!password) {
    throw new HttpError(
      401,
      "TaskMonitor authentication required. Set TASK_MONITOR_COOKIE or TASK_MONITOR_USER/TASK_MONITOR_PASSWORD."
    );
  }
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.TASK_MONITOR_USER || "admin", password })
  });
  if (!response.ok) {
    throw new HttpError(response.status, "TaskMonitor login failed.");
  }
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
  sessionCookie = setCookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
  if (!sessionCookie) throw new HttpError(401, "TaskMonitor login returned no session cookie.");
}

async function downloadTaskAttachments(task) {
  if (!Array.isArray(task.attachments) || task.attachments.length === 0) {
    return { directory: null, attachments: [] };
  }
  const directory = path.join(os.tmpdir(), "terminal-apron-task-monitor", safeFileName(task.key || task.id));
  await fs.mkdir(directory, { recursive: true });
  const attachments = [];
  for (const [index, attachment] of task.attachments.entries()) {
    const fileName = `${String(index + 1).padStart(2, "0")}-${safeFileName(attachment.name || attachment.id)}`;
    const localPath = path.join(directory, fileName);
    try {
      await fs.writeFile(localPath, await requestBinary(attachment.url));
      attachments.push({ ...attachment, localPath });
    } catch (error) {
      attachments.push({
        ...attachment,
        localPath: null,
        downloadError: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return { directory, attachments };
}

async function requestBinary(resourcePath, allowLogin = true) {
  const headers = new Headers();
  if (sessionCookie) headers.set("Cookie", sessionCookie);
  let response;
  try {
    response = await fetch(new URL(resourcePath, `${baseUrl}/`), { headers });
  } catch (error) {
    throw new Error(`Attachment download failed: ${error instanceof Error ? error.message : error}`);
  }
  if (response.status === 401 && allowLogin) {
    await login();
    return requestBinary(resourcePath, false);
  }
  if (!response.ok) {
    throw new HttpError(response.status, `attachment download returned ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function safeFileName(value) {
  return String(value)
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "attachment";
}

function parseArguments(values) {
  const positionals = [];
  const valuesByName = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const token = values[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equalIndex = token.indexOf("=");
    const name = token.slice(2, equalIndex === -1 ? undefined : equalIndex);
    let value = equalIndex === -1 ? undefined : token.slice(equalIndex + 1);
    if (value === undefined && values[index + 1] && !values[index + 1].startsWith("--")) {
      value = values[index + 1];
      index += 1;
    }
    const nextValue = value === undefined ? true : value;
    valuesByName.set(name, [...(valuesByName.get(name) || []), nextValue]);
  }
  return { positionals, valuesByName };
}

function option(parsed, name) {
  const values = parsed.valuesByName.get(name) || [];
  const value = values[values.length - 1];
  return typeof value === "string" ? value : value === true ? "true" : undefined;
}

function options(parsed, name) {
  return (parsed.valuesByName.get(name) || []).filter((value) => typeof value === "string");
}

function requiredOption(parsed, name) {
  const value = option(parsed, name);
  if (!value || value === "true") throw new Error(`--${name} is required.`);
  return value;
}

function flag(parsed, name) {
  return parsed.valuesByName.has(name);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printStateMarker(state, detail) {
  const safeDetail = String(detail || "")
    .replace(/[\r\n|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  process.stdout.write(`TASK_MONITOR_STATE: ${state}${safeDetail ? ` | ${safeDetail}` : ""}\n`);
}

function printHelp() {
  process.stdout.write(`TaskMonitor CLI

Usage:
  task-monitor.mjs list [--query text] [--status status] [--project name] [--archived]
  task-monitor.mjs projects [--archived]
  task-monitor.mjs context <task-id-or-key>
  task-monitor.mjs start <task> --summary text
  task-monitor.mjs report <task> --summary text [report options]
  task-monitor.mjs confirm <task> --summary text --next text
  task-monitor.mjs block <task> --summary text --blocker text [--next text]
  task-monitor.mjs complete <task> --summary text --passed command [report options]

Report options:
  --report-status status  started|progress|blocked|completed|note
  --task-status status    not_started|in_progress|pending_auto_acceptance|pending_manual_acceptance|done|blocked
  --changed-file path     Repeat for each materially changed file
  --passed command        Repeat for each passed verification
  --failed command        Repeat for each failed verification
  --not-run command       Repeat for each verification not run
  --risk text             Repeat for each known risk
  --blocker text          Repeat for each blocker
  --next text             Next executable step
`);
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`
  );
  process.exitCode = 1;
});
