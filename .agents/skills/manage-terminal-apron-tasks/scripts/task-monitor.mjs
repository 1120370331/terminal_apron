#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CREDENTIAL_FILE_NAME = ".task-monitor-credential.json";
const configuredBaseUrl = (process.env.TASK_MONITOR_URL || "").trim();
let baseUrl = (configuredBaseUrl || "http://127.0.0.1:3131").replace(/\/+$/, "");
let sessionCookie = (process.env.TASK_MONITOR_COOKIE || "").trim();
let credentialLoadPromise;

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
    const group = option(parsed, "group");
    const releaseStatus = option(parsed, "release-status");
    if (status) params.set("status", status);
    if (query) params.set("q", query);
    if (project !== undefined) params.set("project", project);
    if (group !== undefined) params.set("group", group);
    if (releaseStatus !== undefined) params.set("releaseStatus", releaseStatus);
    for (const tag of options(parsed, "tag")) params.append("tag", tag);
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

  if (command === "groups" || command === "tags") {
    const params=new URLSearchParams();if(flag(parsed,"archived"))params.set("archived","true");
    if(command==="tags"){const project=option(parsed,"project");if(project!==undefined)params.set("project",project);if(project!==undefined||flag(parsed,"catalog"))params.set("catalog","true");}
    const suffix=params.size?`?${params}`:"";
    print(await request(`/api/tasks/${command}${suffix}`));
    return;
  }

  if (command === "create-project") {
    print(
      await request("/api/tasks/projects", {
        method: "POST",
        body: JSON.stringify({
          name: requiredOption(parsed, "name"),
          rootDirectory: requiredOption(parsed, "root-directory")
        })
      })
    );
    return;
  }

  if (command === "update-project") {
    const projectName = requiredPositional(parsed, "project name");
    const input = compactObject({
      name: option(parsed, "name"),
      rootDirectory: option(parsed, "root-directory")
    });
    if (Object.keys(input).length === 0) {
      throw new Error("update-project requires --name and/or --root-directory.");
    }
    print(
      await request(`/api/tasks/projects/${encodeURIComponent(projectName)}`, {
        method: "PATCH",
        body: JSON.stringify(input)
      })
    );
    return;
  }

  if (command === "create") {
    const input = await taskInput(parsed, { requireTitle: true });
    print(await request("/api/tasks", { method: "POST", body: JSON.stringify(input) }));
    return;
  }

  const taskReference = parsed.positionals[0] || process.env.TASK_MONITOR_TASK_ID;
  if (!taskReference) {
    throw new Error("A task UUID/key is required, or set TASK_MONITOR_TASK_ID.");
  }
  const task = await resolveTask(taskReference);

  if (command === "show") {
    print(task);
    return;
  }

  if(command==="tag"){
    const add=options(parsed,"add"),remove=options(parsed,"remove"),set=options(parsed,"set"),clear=flag(parsed,"clear");
    if((set.length||clear)&&(add.length||remove.length))throw new Error("Use --set/--clear separately from --add/--remove.");
    if(set.length&&clear)throw new Error("Use --set or --clear, not both.");
    if(!add.length&&!remove.length&&!set.length&&!clear)throw new Error("tag requires --add, --remove, --set, or --clear.");
    const input=set.length||clear?{tags:clear?[]:set,revision:integerOption(parsed,"revision")??task.revision}:{add,remove,...(integerOption(parsed,"revision")!==undefined?{revision:integerOption(parsed,"revision")}: {})};
    const updated=await request(`/api/tasks/${encodeURIComponent(task.id)}/tags`,{method:"PATCH",body:JSON.stringify(input)});
    print({taskId:updated.id,key:updated.key,project:updated.project,tags:updated.tags,revision:updated.revision});return;
  }

  if (command === "update") {
    const input = await taskInput(parsed);
    if (Object.keys(input).length === 0) {
      throw new Error("update requires at least one task field option.");
    }
    input.revision = integerOption(parsed, "revision") ?? task.revision;
    print(
      await request(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        body: JSON.stringify(input)
      })
    );
    return;
  }

  if (command === "archive" || command === "restore") {
    print(await request(`/api/tasks/${encodeURIComponent(task.id)}/${command}`, { method: "POST" }));
    return;
  }

  if (command === "delete") {
    if (!flag(parsed, "yes")) {
      throw new Error("delete permanently removes task reports, attachments, and its context workspace; repeat with --yes.");
    }
    print(await request(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" }));
    return;
  }

  if (command === "attachments") {
    print({ taskId: task.id, key: task.key, attachments: task.attachments ?? [] });
    return;
  }

  if (command === "upload") {
    const filePaths = options(parsed, "file");
    if (filePaths.length === 0) throw new Error("upload requires at least one --file path.");
    const form = new FormData();
    for (const filePath of filePaths) {
      const resolvedPath = path.resolve(filePath);
      const file = await fs.readFile(resolvedPath);
      const mimeType = imageMimeType(file);
      if (!mimeType) throw new Error(`upload supports PNG, JPEG, WebP, and GIF only: ${resolvedPath}`);
      form.append("files", new Blob([file], { type: mimeType }), path.basename(resolvedPath));
    }
    print(
      await request(`/api/tasks/${encodeURIComponent(task.id)}/attachments`, {
        method: "POST",
        body: form
      })
    );
    return;
  }

  if (command === "context") {
    const refreshedTask = await request(`/api/tasks/${encodeURIComponent(task.id)}/context/refresh`, { method: "POST" });
    const history = await request(`/api/tasks/${encodeURIComponent(task.id)}/reports?limit=50`);
    const attachmentContext = await downloadTaskAttachments(refreshedTask);
    const workspaceArtifacts = await readWorkspaceArtifacts(refreshedTask.contextDirectory);
    print({
      task: { ...refreshedTask, attachments: attachmentContext.attachments },
      contextDirectory: refreshedTask.contextDirectory,
      workspaceArtifacts,
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
  const releaseStatus = option(parsed, "release-status");
  if (
    releaseStatus !== undefined &&
    !["not_released", "local_complete", "production_complete"].includes(releaseStatus)
  ) {
    throw new Error("--release-status must be not_released, local_complete, or production_complete.");
  }
  const payload = {
    status,
    summary,
    changedFiles: options(parsed, "changed-file"),
    verification,
    risks: options(parsed, "risk"),
    blockers,
    nextStep: option(parsed, "next") || "",
    ...(taskStatus === undefined ? {} : { taskStatus }),
    ...(releaseStatus === undefined ? {} : { releaseStatus })
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

async function readWorkspaceArtifacts(directory) {
  if (!directory) return null;
  const artifacts = {};
  for (const name of ["context.md", "task.md", "project.json", "reports.json", "attachments.json"]) {
    const artifactPath = path.join(directory, name);
    try {
      artifacts[name] = { path: artifactPath, content: await fs.readFile(artifactPath, "utf8") };
    } catch (error) {
      artifacts[name] = { path: artifactPath, readError: error instanceof Error ? error.message : String(error) };
    }
  }
  return artifacts;
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

async function taskInput(parsed, taskInputOptions = {}) {
  const input = compactObject({
    title: option(parsed, "title"),
    project: option(parsed, "project"),
    group: option(parsed, "group"),
    status: option(parsed, "status"),
    releaseStatus: option(parsed, "release-status"),
    priority: option(parsed, "priority"),
    difficulty: integerOption(parsed, "difficulty"),
    repositoryPath: option(parsed, "repository-path"),
    maxConcurrency: integerOption(parsed, "max-concurrency"),
    createdAt: option(parsed, "created-at"),
    descriptionMd: await textValue(parsed, "description", "description-file"),
    acceptanceCriteriaMd: await textValue(parsed, "acceptance", "acceptance-file")
  });
  if (hasOption(parsed, "tag")) input.tags = options(parsed, "tag");
  if (hasOption(parsed, "parent")) {
    const parent = option(parsed, "parent");
    input.parentTaskId = !parent || ["none", "null"].includes(parent.toLowerCase()) ? null : (await resolveTask(parent)).id;
  }
  if (taskInputOptions.requireTitle && !input.title) throw new Error("--title is required.");
  return input;
}

async function textValue(parsed, inlineName, fileName) {
  const inlineValue = option(parsed, inlineName);
  const filePath = option(parsed, fileName);
  if (inlineValue !== undefined && filePath !== undefined) {
    throw new Error(`Use either --${inlineName} or --${fileName}, not both.`);
  }
  return filePath === undefined ? inlineValue : fs.readFile(path.resolve(filePath), "utf8");
}

function integerOption(parsed, name) {
  const value = option(parsed, name);
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) throw new Error(`--${name} must be a non-negative integer.`);
  return Number(value);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function imageMimeType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  return undefined;
}

async function request(path, init = {}, allowLogin = true) {
  await loadCurrentUserCredential();
  const headers = new Headers(init.headers || {});
  if (typeof init.body === "string" && init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
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
      "TaskMonitor authentication required. Open TaskMonitor with the current user, or set TASK_MONITOR_CREDENTIAL_FILE, TASK_MONITOR_COOKIE, or TASK_MONITOR_USER/TASK_MONITOR_PASSWORD."
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
  await loadCurrentUserCredential();
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

async function loadCurrentUserCredential() {
  if (sessionCookie) return;
  credentialLoadPromise ??= discoverCurrentUserCredential();
  await credentialLoadPromise;
}

async function discoverCurrentUserCredential() {
  for (const credentialPath of await credentialCandidates()) {
    try {
      const parsed = JSON.parse(await fs.readFile(credentialPath, "utf8"));
      const cookie = typeof parsed.cookie === "string" ? parsed.cookie.trim() : "";
      const expiresAt = Date.parse(typeof parsed.expiresAt === "string" ? parsed.expiresAt : "");
      const credentialUrl = normalizeLoopbackUrl(parsed.url);
      if (
        parsed.version !== 1 ||
        !/^twm_token=[A-Za-z0-9._~%+-]+$/.test(cookie) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now() ||
        !credentialUrl
      ) {
        continue;
      }
      sessionCookie = cookie;
      if (!configuredBaseUrl) baseUrl = credentialUrl;
      return;
    } catch {
      // Try the next local credential. Never print credential contents or paths.
    }
  }
}

async function credentialCandidates() {
  const candidates = [];
  const explicit = (process.env.TASK_MONITOR_CREDENTIAL_FILE || "").trim();
  if (explicit) candidates.push(path.resolve(explicit));

  addAncestorCandidates(candidates, process.cwd());
  try {
    const realScriptPath = await fs.realpath(fileURLToPath(import.meta.url));
    addAncestorCandidates(candidates, path.dirname(realScriptPath));
  } catch {
    // The cwd and explicit path remain available.
  }
  return [...new Set(candidates.map((candidate) => path.normalize(candidate)))];
}

function addAncestorCandidates(candidates, start) {
  let current = path.resolve(start);
  for (let depth = 0; depth < 12; depth += 1) {
    candidates.push(path.join(current, CREDENTIAL_FILE_NAME));
    candidates.push(path.join(current, "data", ".terminal-apron", CREDENTIAL_FILE_NAME));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function normalizeLoopbackUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    const host = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(host) ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed.origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
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

function requiredPositional(parsed, name) {
  const value = parsed.positionals[0];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function hasOption(parsed, name) {
  return parsed.valuesByName.has(name);
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
  task-monitor.mjs list [task filters] [--archived]
  task-monitor.mjs projects [--archived]
  task-monitor.mjs groups [--archived]
  task-monitor.mjs tags [--project name] [--catalog] [--archived]
  task-monitor.mjs tag <task> --add name [--add name] [--remove name]
  task-monitor.mjs tag <task> --set name [--set name] | --clear [--revision number]
  task-monitor.mjs create-project --name text --root-directory path
  task-monitor.mjs update-project <project-name> [--name text] [--root-directory path]
  task-monitor.mjs create --title text [task fields]
  task-monitor.mjs show <task-id-or-key>
  task-monitor.mjs update <task-id-or-key> [task fields] [--revision number]
  task-monitor.mjs archive|restore <task-id-or-key>
  task-monitor.mjs delete <task-id-or-key> --yes
  task-monitor.mjs attachments <task-id-or-key>
  task-monitor.mjs upload <task-id-or-key> --file image-path [--file image-path]
  task-monitor.mjs context <task-id-or-key>
  task-monitor.mjs start <task> --summary text
  task-monitor.mjs report <task> --summary text [report options]
  task-monitor.mjs confirm <task> --summary text --next text
  task-monitor.mjs block <task> --summary text --blocker text [--next text]
  task-monitor.mjs complete <task> --summary text --passed command [report options]

Task filters:
  --query text --status status --release-status status --project name --group name --tag name

Task fields:
  --title text --parent task-id-or-key|none --project name --group name --tag name
  --description text|--description-file path --acceptance text|--acceptance-file path
  --status status --release-status status --priority P0|P1|P2|P3 --difficulty 1..5
  --repository-path path --max-concurrency number --created-at ISO-8601

Report options:
  --report-status status  started|progress|blocked|completed|note
  --task-status status    not_started|in_progress|pending_auto_acceptance|pending_manual_acceptance|done|blocked
  --release-status status not_released|local_complete|production_complete
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
