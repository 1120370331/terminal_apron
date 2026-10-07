import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cliScript = path.join(
  repositoryRoot,
  ".agents",
  "skills",
  "manage-terminal-apron-tasks",
  "scripts",
  "task-monitor.mjs"
);

test("TaskMonitor tag tools query project catalogs and merge labels without replacing unrelated fields",async()=>{
  const requests:Array<{method?:string;url?:string;body?:unknown}>=[];
  const server=http.createServer(async(req,res)=>{const body=await readJson(req);requests.push({method:req.method,url:req.url,body});res.setHeader("Content-Type","application/json");if(req.url==="/api/tasks/TA-7")res.end(JSON.stringify({id:"task-7",key:"TA-7",revision:9,tags:["人工标签"]}));else if(req.method==="PATCH")res.end(JSON.stringify({id:"task-7",key:"TA-7",project:"NanoPPT",revision:10,tags:["人工标签","前端"]}));else res.end(JSON.stringify({tags:[]}));});
  const base=await listen(server);try{
    const catalog=await runCli(["tags","--project","NanoPPT"],base);assert.equal(catalog.code,0,catalog.stderr);assert.match(requests[0].url!,/project=NanoPPT/);assert.match(requests[0].url!,/catalog=true/);
    const mutation=await runCli(["tag","TA-7","--add","前端","--remove","待验收"],base);assert.equal(mutation.code,0,mutation.stderr);assert.deepEqual(requests.at(-1),{method:"PATCH",url:"/api/tasks/task-7/tags",body:{add:["前端"],remove:["待验收"]}});assert.deepEqual(JSON.parse(mutation.stdout).tags,["人工标签","前端"]);assert.doesNotMatch(mutation.stdout,/TASK_MONITOR_STATE/);
    const clear=await runCli(["tag","TA-7","--clear"],base);assert.equal(clear.code,0,clear.stderr);assert.deepEqual(requests.at(-1)?.body,{tags:[],revision:9});
  }finally{await close(server);}
});

test("TaskMonitor CLI manages task records with filters and optimistic revisions", async () => {
  const requests: Array<{ method?: string; url?: string; body?: unknown }> = [];
  const server = http.createServer(async (request, response) => {
    const body = await readJson(request);
    requests.push({ method: request.method, url: request.url, body });
    response.setHeader("Content-Type", "application/json");

    if (request.method === "GET" && request.url === "/api/tasks/TA-7") {
      response.end(JSON.stringify({ id: "task-7", key: "TA-7", revision: 9, attachments: [] }));
      return;
    }
    response.statusCode = request.method === "POST" ? 201 : 200;
    response.end(JSON.stringify({ ok: true }));
  });
  const baseUrl = await listen(server);

  try {
    const list = await runCli(["list", "--group", "Release train", "--tag", "codex", "--tag", "urgent"], baseUrl);
    assert.equal(list.code, 0, list.stderr);
    assert.match(requests[0]?.url ?? "", /group=Release\+train/);
    assert.match(requests[0]?.url ?? "", /tag=codex/);
    assert.match(requests[0]?.url ?? "", /tag=urgent/);

    const create = await runCli(
      ["create", "--title", "Repair task CLI", "--project", "Terminal Apron", "--tag", "codex", "--tag", "cli"],
      baseUrl
    );
    assert.equal(create.code, 0, create.stderr);
    assert.deepEqual(requests[1], {
      method: "POST",
      url: "/api/tasks",
      body: { title: "Repair task CLI", project: "Terminal Apron", tags: ["codex", "cli"] }
    });

    const update = await runCli(["update", "TA-7", "--status", "in_progress", "--priority", "P1"], baseUrl);
    assert.equal(update.code, 0, update.stderr);
    assert.deepEqual(requests[3], {
      method: "PATCH",
      url: "/api/tasks/task-7",
      body: { status: "in_progress", priority: "P1", revision: 9 }
    });
  } finally {
    await close(server);
  }
});

test("TaskMonitor CLI uploads content-validated images and guards permanent deletion", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-cli-"));
  const imagePath = path.join(directory, "evidence.png");
  fs.writeFileSync(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const requests: Array<{ method?: string; url?: string; contentType?: string; body: Buffer }> = [];
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    requests.push({ method: request.method, url: request.url, contentType: request.headers["content-type"], body });
    response.setHeader("Content-Type", "application/json");
    if (request.method === "GET" && request.url === "/api/tasks/TA-8") {
      response.end(JSON.stringify({ id: "task-8", key: "TA-8", revision: 1, attachments: [] }));
      return;
    }
    response.statusCode = request.method === "POST" ? 201 : 200;
    response.end(JSON.stringify({ ok: true }));
  });
  const baseUrl = await listen(server);

  try {
    const missingConfirmation = await runCli(["delete", "TA-8"], baseUrl);
    assert.notEqual(missingConfirmation.code, 0);
    assert.match(missingConfirmation.stderr, /repeat with --yes/);
    assert.equal(requests.length, 1, "task lookup is allowed, but no DELETE request is sent");

    const upload = await runCli(["upload", "TA-8", "--file", imagePath], baseUrl);
    assert.equal(upload.code, 0, upload.stderr);
    const uploadRequest = requests.at(-1);
    assert.equal(uploadRequest?.method, "POST");
    assert.equal(uploadRequest?.url, "/api/tasks/task-8/attachments");
    assert.match(uploadRequest?.contentType ?? "", /^multipart\/form-data; boundary=/);
    assert.match(uploadRequest?.body.toString("utf8") ?? "", /Content-Type: image\/png/);
  } finally {
    await close(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function readBody(request: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  return body.length ? JSON.parse(body.toString("utf8")) : undefined;
}

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Test server did not provide an address"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
    server.once("error", reject);
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function runCli(args: string[], baseUrl: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliScript, ...args], {
      env: {
        ...process.env,
        TASK_MONITOR_URL: baseUrl,
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
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}
