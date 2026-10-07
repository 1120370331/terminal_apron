import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { SessionStore } from "./db.js";
import { createTaskRouter } from "./tasks/taskRouter.js";
import { TaskStore } from "./tasks/taskStore.js";
import { createTaskModeRouter } from "./tasks/taskModeRouter.js";
import type { TaskModeService } from "./tasks/taskModeService.js";

test("report previews enforce task ownership and isolate HTML while original content remains a download", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apron-report-preview-")), store = new TaskStore(directory);
  let server: Server | undefined;
  try {
    const task = store.create({ title: "Document preview" }), other = store.create({ title: "Unrelated task" });
    fs.mkdirSync(store.attachmentDirectory(task.id), { recursive: true });
    const documents = [{ name: "实验汇总", storageName: "report.html", mimeType: "application/octet-stream", content: "<h1>HTML summary</h1><script>document.body.dataset.ready='yes'</script>" }, { name: "实施汇总", storageName: "result.md", mimeType: "text/markdown", content: "# 实施结果\n\n## 验证\n\n全部通过" }, { name: "原始记录", storageName: "trace.txt", mimeType: "text/plain", content: "trace" }];
    for (const document of documents) { fs.writeFileSync(store.attachmentFilePath(task.id, document.storageName), document.content);store.addAttachment(task.id, { ...document, size: Buffer.byteLength(document.content) }); }
    const attachments = store.get(task.id)!.attachments;
    assert.equal(attachments[0].previewFormat, "html");assert.match(attachments[0].previewUrl!, /mode=artifact/);assert.equal(attachments[1].previewFormat, "markdown");assert.equal(attachments[2].previewUrl, undefined);
    const app = express();app.use((_req, res, next) => { res.locals.user = { name: "test", method: "password" };next(); });app.use("/api/tasks", createTaskRouter(async () => store));
    server = await new Promise<Server>(resolve => { const running = app.listen(0, "127.0.0.1", () => resolve(running)); });
    const address = server.address();assert.ok(address && typeof address === "object");const base = `http://127.0.0.1:${address.port}/api/tasks`;
    const html = await fetch(`${base}/${task.id}/attachments/${attachments[0].id}/preview`);assert.equal(html.status, 200);assert.match(html.headers.get("content-type")!, /text\/html/);assert.equal(await html.text(), documents[0].content);
    const policy = html.headers.get("content-security-policy")!;assert.match(policy, /sandbox allow-scripts/);assert.doesNotMatch(policy, /allow-same-origin/);assert.match(policy, /connect-src 'none'/);assert.match(policy, /frame-ancestors 'self'/);
    const original = await fetch(`${base}/${task.id}/attachments/${attachments[0].id}/content`);assert.match(original.headers.get("content-disposition")!, /^attachment/);assert.match(decodeURIComponent(original.headers.get("content-disposition")!), /实验汇总\.html$/);assert.match(original.headers.get("content-type")!, /^text\/html/);assert.equal(await original.text(), documents[0].content);
    const md = await fetch(`${base}/${task.id}/attachments/${attachments[1].id}/preview`);assert.equal(md.status, 200);assert.match(md.headers.get("content-type")!, /text\/plain/);assert.equal(await md.text(), documents[1].content);
    assert.equal((await fetch(`${base}/${other.id}/attachments/${attachments[0].id}/preview`)).status, 404);
    assert.equal((await fetch(`${base}/${task.id}/attachments/${attachments[2].id}/preview`)).status, 415);
  } finally { if (server) await new Promise<void>(resolve => server!.close(() => resolve()));store.close();fs.rmSync(directory, { recursive: true, force: true }); }
});

test("ordinary content and snapshot downloads preserve filenames, suffixes, MIME and bytes", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apron-file-delivery-")), store = new TaskStore(directory);
  let server: Server | undefined;
  try {
    const task = store.create({ title: "File delivery" });
    const documents = [
      { name: "验收原文件.pdf", storageName: "stored.pdf", mimeType: "application/octet-stream", content: "%PDF-1.4\nverified original\n%%EOF" },
      { name: "历史无后缀材料", storageName: "legacy.txt", mimeType: "text/plain", content: "complete download evidence" },
      { name: "截图.png", storageName: "image.png", mimeType: "image/png", content: "image bytes" }
    ];
    fs.mkdirSync(store.attachmentDirectory(task.id), { recursive: true });
    for (const file of documents) { fs.writeFileSync(store.attachmentFilePath(task.id, file.storageName), file.content);store.addAttachment(task.id, {...file, size: Buffer.byteLength(file.content)}); }
    const attachments = store.get(task.id)!.attachments;
    const snapshot = attachments.map(file => ({...file, snapshotPath: store.attachment(file.taskId, file.id)!.filePath}));
    const app = express();app.use((_req,res,next) => {res.locals.user = {name:"test",method:"password"};next();});
    app.use("/api/tasks", createTaskRouter(async () => store));
    app.use("/api/task-mode", createTaskModeRouter(async () => ({conversations:{store},detail:()=>({state:{instructions:[{id:"instruction",snapshot:{attachments:snapshot}}]}})} as unknown as TaskModeService)));
    server = await new Promise<Server>(resolve => {const running = app.listen(0,"127.0.0.1",()=>resolve(running));});
    const address = server.address();assert.ok(address && typeof address === "object");const base = `http://127.0.0.1:${address.port}`;
    for (const [index,file] of attachments.entries()) {
      for (const route of [`/api/tasks/${task.id}/attachments/${file.id}/content?download=1`, `/api/task-mode/tasks/${task.id}/instructions/instruction/attachments/${file.id}?download=1`]) {
        const response = await fetch(base+route);assert.equal(response.status,200);
        const expectedName = index === 1 ? documents[index].name + ".txt" : documents[index].name;
        assert.equal(decodeURIComponent(response.headers.get("content-disposition")!.split("UTF-8''")[1]), expectedName);
        assert.match(response.headers.get("content-disposition")!, /^attachment/);
        assert.equal(response.headers.get("content-type")!.split(";")[0], index === 0 ? "application/pdf" : documents[index].mimeType);
        assert.equal(await response.text(), documents[index].content);
      }
    }
    const inline = await fetch(`${base}/api/tasks/${task.id}/attachments/${attachments[2].id}/content`);assert.match(inline.headers.get("content-disposition")!, /^inline/);
    assert.equal((await fetch(`${base}/api/task-mode/tasks/${task.id}/instructions/missing/attachments/${attachments[0].id}`)).status,404);
  } finally {if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));store.close();fs.rmSync(directory,{recursive:true,force:true});}
});

test("DELETE /api/tasks/:id removes task artifacts and only unlinks associated terminals", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-router-"));
  const taskStore = new TaskStore(directory);
  const sessionStore = new SessionStore(directory);
  let server: Server | undefined;
  try {
    await sessionStore.init();
    const task = taskStore.create({ title: "Disposable API task" });
    const attachmentDirectory = taskStore.attachmentDirectory(task.id);
    const attachmentPath = taskStore.attachmentFilePath(task.id, "evidence.png");
    fs.writeFileSync(attachmentPath, "evidence", "utf8");
    taskStore.addAttachment(task.id, {
      name: "evidence.png",
      storageName: "evidence.png",
      mimeType: "image/png",
      size: 8
    });
    taskStore.addReport(task.id, { status: "progress", summary: "Disposable evidence" });
    const contextDirectory = task.contextDirectory;
    const linked = await sessionStore.create({
      name: `${task.key} worker`,
      taskId: task.id,
      taskKey: task.key,
      cwd: directory
    });
    const unrelated = await sessionStore.create({ name: "Unrelated terminal", cwd: directory });

    const app = express();
    app.use((_req, res, next) => {
      res.locals.user = { name: "test", method: "password" };
      next();
    });
    app.use(
      "/api/tasks",
      createTaskRouter(
        async () => taskStore,
        async () => sessionStore
      )
    );
    const listeningServer = await new Promise<Server>((resolve, reject) => {
      const candidate = app.listen(0, "127.0.0.1", (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(candidate);
      });
      candidate.once("error", reject);
    });
    server = listeningServer;
    const address = listeningServer.address();
    assert.ok(address && typeof address === "object");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/tasks/${task.id}`, { method: "DELETE" });
    const body = (await response.json()) as { ok: boolean; taskId: string; unlinkedTerminalCount: number };

    assert.equal(response.status, 200);
    assert.deepEqual(body, { ok: true, taskId: task.id, unlinkedTerminalCount: 1 });
    assert.equal(taskStore.get(task.id), null);
    assert.equal(fs.existsSync(attachmentDirectory), false);
    assert.equal(fs.existsSync(contextDirectory), false);
    assert.equal((await sessionStore.get(linked.id))?.taskId, undefined);
    assert.equal((await sessionStore.get(linked.id))?.archived, false);
    assert.equal((await sessionStore.get(unrelated.id))?.name, unrelated.name);
    assert.equal((await sessionStore.all()).length, 2);
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    }
    taskStore.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("GET /api/tasks filters groups and tags and lists filter values", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-task-router-"));
  const taskStore = new TaskStore(directory);
  let server: Server | undefined;
  try {
    const matching = taskStore.create({ title: "Deploy API", group: "Release train", tags: ["api", "urgent"] });
    taskStore.create({ title: "Deploy docs", group: "Release train", tags: ["docs"] });
    taskStore.create({ title: "Review API", group: "Quality", tags: ["api"] });

    const app = express();
    app.use((_req, res, next) => {
      res.locals.user = { name: "test", method: "password" };
      next();
    });
    app.use("/api/tasks", createTaskRouter(async () => taskStore));
    const listeningServer = await new Promise<Server>((resolve, reject) => {
      const candidate = app.listen(0, "127.0.0.1", (error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(candidate);
      });
      candidate.once("error", reject);
    });
    server = listeningServer;
    const address = listeningServer.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}/api/tasks`;

    const filteredResponse = await fetch(`${baseUrl}?group=release%20train&tag=API&tag=urgent`);
    const filtered = (await filteredResponse.json()) as { tasks: Array<{ id: string }> };
    assert.equal(filteredResponse.status, 200);
    assert.deepEqual(filtered.tasks.map((task) => task.id), [matching.id]);

    const groupsResponse = await fetch(`${baseUrl}/groups`);
    const groups = (await groupsResponse.json()) as { groups: Array<{ name: string; taskCount: number }> };
    assert.deepEqual(groups.groups, [
      { name: "Quality", taskCount: 1 },
      { name: "Release train", taskCount: 2 }
    ]);

    const tagsResponse = await fetch(`${baseUrl}/tags`);
    const tags = (await tagsResponse.json()) as { tags: Array<{ name: string; taskCount: number }> };
    assert.deepEqual(tags.tags, [
      { name: "api", taskCount: 2 },
      { name: "docs", taskCount: 1 },
      { name: "urgent", taskCount: 1 }
    ]);
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
    }
    taskStore.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
