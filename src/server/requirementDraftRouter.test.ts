import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import type { Server } from "node:http";
import { CodexConversationManager } from "./codexConversationManager.js";
import { RequirementDraftStore } from "./tasks/requirementDraftStore.js";
import { RequirementDraftService } from "./tasks/requirementDraftService.js";
import { createRequirementDraftRouter } from "./tasks/requirementDraftRouter.js";

test("real HTTP router isolates users, returns conflict snapshots and replays an SSE reconnect", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "draft-http-"));
  const manager = new CodexConversationManager();
  const users = new Map(["alice", "bob"].map(name => [name, new RequirementDraftService(new RequirementDraftStore(directory, name), manager)]));
  const app = express(); app.use(express.json());
  // Test-only identity adapter; production uses requireAuth and never trusts this header.
  app.use((req, res, next) => { const name = req.header("x-test-user"); if (name && users.has(name)) res.locals.user = { name, method: "password" }; next(); });
  app.use("/api/requirement-drafts", createRequirementDraftRouter(async user => users.get(user.name)!));
  let server: Server | undefined; let stream: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    server = await new Promise<Server>(resolve => { const running = app.listen(0, "127.0.0.1", () => resolve(running)); });
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}/api/requirement-drafts`;
    const request = (url: string, user = "alice", body?: unknown) => fetch(`${base}${url}`, { method: body ? "POST" : "GET", headers: { "x-test-user": user, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await fetch(base)).status, 401);
    const created = await request("", "alice", { operationId: "create-http-1", fields: { title: "", descriptionMd: "Unsaved", acceptanceCriteriaMd: "" } }); assert.equal(created.status, 201);
    const draft = await created.json() as any;
    for (const url of [`/${draft.draftId}`, `/${draft.draftId}/events`, `/${draft.draftId}/conversation`]) assert.equal((await request(url, "bob")).status, 404);
    assert.equal((await request(`/${draft.draftId}/operations`, "bob", { operationId: "foreign-write", baseVersion: 1, patch: { title: "Foreign" } })).status, 404);
    assert.equal((await request(`/${draft.draftId}/conversation`, "bob", {})).status, 404);
    const first = await request(`/${draft.draftId}/operations`, "alice", { operationId: "http-update-1", baseVersion: 1, patch: { title: "First" } }); const result = await first.json() as any;
    const second = await request(`/${draft.draftId}/operations`, "alice", { operationId: "http-update-2", baseVersion: 1, patch: { title: "Stale" } }); assert.equal(second.status, 409);
    const conflict = await second.json() as any; assert.equal(conflict.error.current.fields.title, "First");
    const event = await fetch(`${base}/${draft.draftId}/events?after=0`, { headers: { "x-test-user": "alice" } });
    stream = event.body!.getReader(); const initial = new TextDecoder().decode((await stream.read()).value);
    assert.match(initial, /draft-event/); assert.match(initial, /draft_updated/); assert.match(initial, /ready/); await stream.cancel();
    await request(`/${draft.draftId}/operations`, "alice", { operationId: "http-update-3", baseVersion: 2, patch: { title: "After disconnect" } });
    const resumed = await fetch(`${base}/${draft.draftId}/events`, { headers: { "x-test-user": "alice", "Last-Event-ID": String(result.eventId) } });
    stream = resumed.body!.getReader(); const replay = new TextDecoder().decode((await stream.read()).value);
    assert.match(replay, /After disconnect/); assert.doesNotMatch(replay, /http-update-1/); await stream.cancel();
    const bad = await request(`/${draft.draftId}/events?after=not-a-number`); assert.equal(bad.status, 400);
  } finally {
    await stream?.cancel().catch(() => undefined);
    for (const service of users.values()) service.close(); manager.close();
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
