import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionStore } from "./db.js";

test("persists optional task links and allows a terminal to be unlinked", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-session-store-"));
  const taskId = "10a2aad4-9eaf-4458-9f0a-90b655be66c9";
  try {
    let store = new SessionStore(directory);
    await store.init();
    const linked = await store.create({
      name: "TA-2 implementation",
      taskId,
      taskKey: "ta-2",
      cwd: directory
    });
    const ordinary = await store.create({ name: "ordinary terminal", cwd: directory });

    assert.equal(linked.taskId, taskId);
    assert.equal(linked.taskKey, "TA-2");
    assert.equal(ordinary.taskId, undefined);

    store = new SessionStore(directory);
    assert.equal((await store.get(linked.id))?.taskId, taskId);
    const unlinked = await store.update(linked.id, { taskId: null, taskKey: null });
    assert.equal(unlinked?.taskId, undefined);
    assert.equal(unlinked?.taskKey, undefined);

    store = new SessionStore(directory);
    assert.equal((await store.get(linked.id))?.taskId, undefined);
    assert.equal((await store.get(ordinary.id))?.name, "ordinary terminal");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("drops malformed task metadata while loading legacy session data", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-session-store-"));
  try {
    const store = new SessionStore(directory);
    await store.init();
    const session = await store.create({
      name: "invalid assignment",
      taskId: "not-a-task",
      taskKey: "issue-1",
      cwd: directory
    });
    assert.equal(session.taskId, undefined);
    assert.equal(session.taskKey, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("restoring a stopped session clears its stopped marker", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-apron-session-store-"));
  try {
    const store = new SessionStore(directory);
    await store.init();
    const session = await store.create({ name: "stopped terminal", cwd: directory });
    const stopped = await store.markStopped(session.id);

    assert.equal(stopped?.archived, true);
    assert.ok(stopped?.stoppedAt);

    const restored = await store.update(session.id, { archived: false });
    assert.equal(restored?.archived, false);
    assert.equal(restored?.stoppedAt, undefined);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
