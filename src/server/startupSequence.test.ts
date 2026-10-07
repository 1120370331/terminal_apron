import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { listenBeforeBootstrap } from "./startupSequence.js";

class FakeServer extends EventEmitter {
  readonly events: string[] = [];
  listenError?: Error;

  listen(): this {
    this.events.push("listen");
    queueMicrotask(() => {
      if (this.listenError) this.emit("error", this.listenError);
      else this.emit("listening");
    });
    return this;
  }
}

test("binds the HTTP listener before bootstrap and waits for bootstrap completion", async () => {
  const server = new FakeServer();
  let releaseBootstrap!: () => void;
  const bootstrapGate = new Promise<void>((resolve) => { releaseBootstrap = resolve; });
  let completed = false;
  const startup = listenBeforeBootstrap(server, 3131, "127.0.0.1", async () => {
    server.events.push("bootstrap");
    await bootstrapGate;
  }).then(() => { completed = true; });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(server.events, ["listen", "bootstrap"]);
  assert.equal(completed, false);
  releaseBootstrap();
  await startup;
  assert.equal(completed, true);
});

test("rejects a listen error without invoking bootstrap", async () => {
  const server = new FakeServer();
  const listenError = new Error("address in use");
  server.listenError = listenError;
  let bootstrapped = false;
  await assert.rejects(
    listenBeforeBootstrap(server, 3131, "127.0.0.1", async () => { bootstrapped = true; }),
    listenError
  );
  assert.equal(bootstrapped, false);
});

test("propagates a bootstrap rejection after the listener is established", async () => {
  const server = new FakeServer();
  const bootstrapError = new Error("store initialization failed");
  await assert.rejects(
    listenBeforeBootstrap(server, 3131, "127.0.0.1", async () => { throw bootstrapError; }),
    bootstrapError
  );
  assert.deepEqual(server.events, ["listen"]);
});
