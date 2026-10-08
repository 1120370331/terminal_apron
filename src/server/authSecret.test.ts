import assert from "node:assert/strict";
import crypto from "node:crypto";
import fsp, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createAuthSecretStore, type AuthSecretIO } from "./authSecret.js";

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "twm-auth-secret-test-"));
  const file = path.join(root, "nested", "server-secret");
  const counts = { stat: 0, open: 0, mkdir: 0, write: 0, read: 0 };
  const io: AuthSecretIO = {
    stat: async (name) => { counts.stat++; return fsp.stat(name, { bigint: true }); },
    mkdir: async (name) => { counts.mkdir++; return fsp.mkdir(name, { recursive: true }); },
    write: async (name, value) => { counts.write++; await fsp.writeFile(name, value, { flag: "wx", mode: 0o600 }); },
    open: async (name) => {
      counts.open++;
      const handle = await fsp.open(name, "r");
      return new Proxy(handle, {
        get(target, key) {
          if (key === "readFile") return async () => { counts.read++; return target.readFile("utf8"); };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
  };
  return { root, file, counts, io, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

test("concurrent first initialization shares a single key; warm calls only stat", async () => {
  const f = await fixture();
  try {
    const store = createAuthSecretStore(() => f.file, f.io);
    const keys = await Promise.all(Array.from({ length: 64 }, () => store.get()));
    assert.equal(new Set(keys).size, 1);
    assert.equal((await fsp.readFile(f.file, "utf8")).trim(), keys[0]);
    assert.deepEqual(f.counts, { stat: 3, open: 1, mkdir: 1, write: 1, read: 1 });
    for (let i = 0; i < 100; i++) assert.equal(await store.get(), keys[0]);
    assert.deepEqual(f.counts, { stat: 103, open: 1, mkdir: 1, write: 1, read: 1 });
  } finally { await f.cleanup(); }
});

test("permission and I/O errors fail without creating or overwriting, then retry", async () => {
  for (const code of ["EACCES", "EIO"]) {
    const f = await fixture();
    try {
      await fsp.mkdir(path.dirname(f.file), { recursive: true });
      const original = crypto.randomBytes(48).toString("base64url");
      await fsp.writeFile(f.file, original);
      const stat = f.io.stat;
      f.io.stat = async () => { throw Object.assign(new Error("injected"), { code }); };
      const store = createAuthSecretStore(() => f.file, f.io);
      await assert.rejects(store.get(), { code });
      assert.equal(f.counts.write, 0);
      assert.equal(f.counts.mkdir, 0);
      assert.equal(await fsp.readFile(f.file, "utf8"), original);
      f.io.stat = stat;
      assert.equal(await store.get(), original);
      store.invalidate();
      const open = f.io.open;
      f.io.open = async () => { throw Object.assign(new Error("injected"), { code }); };
      await assert.rejects(store.get(), { code });
      assert.equal(f.counts.write, 0);
      f.io.open = open;
      assert.equal(await store.get(), original);
    } finally { await f.cleanup(); }
  }
});

test("failed initialization releases all waiters and permits retry", async () => {
  const f = await fixture();
  try {
    const write = f.io.write;
    f.io.write = async () => { throw Object.assign(new Error("injected"), { code: "EIO" }); };
    const store = createAuthSecretStore(() => f.file, f.io);
    const results = await Promise.allSettled(Array.from({ length: 32 }, () => store.get()));
    assert.ok(results.every((result) => result.status === "rejected"));
    f.io.write = write;
    await store.get();
    assert.equal(f.counts.write, 1);
  } finally { await f.cleanup(); }
});

test("exclusive initialization preserves a different initializer's key", async () => {
  const f = await fixture();
  try {
    const winner = crypto.randomBytes(48).toString("base64url");
    const write = f.io.write;
    f.io.write = async (name, value) => {
      await fsp.writeFile(name, winner, { flag: "wx" });
      await write(name, value);
    };
    const store = createAuthSecretStore(() => f.file, f.io);
    assert.equal(await store.get(), winner);
    assert.equal(await fsp.readFile(f.file, "utf8"), winner);
  } finally { await f.cleanup(); }
});

test("an interrupted write leaving an empty key fails closed and recovers after repair", async () => {
  const f = await fixture();
  try {
    f.io.write = async (name) => {
      await fsp.writeFile(name, "", { flag: "wx", mode: 0o600 });
      throw Object.assign(new Error("injected interrupted write"), { code: "EIO" });
    };
    const store = createAuthSecretStore(() => f.file, f.io);
    await assert.rejects(store.get(), { code: "EIO" });
    await assert.rejects(store.get(), { code: "EINVAL" });
    assert.equal(await fsp.readFile(f.file, "utf8"), "");
    const repaired = crypto.randomBytes(48).toString("base64url");
    await fsp.writeFile(f.file, repaired);
    assert.equal(await store.get(), repaired);
  } finally { await f.cleanup(); }
});

test("in-place, atomic replacement, explicit reload and path changes invalidate", async () => {
  const f = await fixture();
  try {
    let file = f.file;
    const store = createAuthSecretStore(() => file, f.io);
    const first = await store.get();
    const second = crypto.randomBytes(48).toString("base64url");
    await fsp.writeFile(file, second);
    assert.equal(await store.get(), second);
    const third = crypto.randomBytes(48).toString("base64url");
    await fsp.writeFile(`${file}.next`, third);
    await fsp.rename(`${file}.next`, file);
    assert.equal(await store.get(), third);
    const reads = f.counts.read;
    store.invalidate();
    assert.equal(await store.get(), third);
    assert.equal(f.counts.read, reads + 1);
    file = path.join(f.root, "other", "server-secret");
    assert.notEqual(await store.get(), first);
  } finally { await f.cleanup(); }
});

test("rotation during read never pairs old bytes with the new file version", async () => {
  const f = await fixture();
  try {
    const store = createAuthSecretStore(() => f.file, f.io);
    await store.get();
    store.invalidate();
    const open = f.io.open;
    const next = crypto.randomBytes(48).toString("base64url");
    let rotate = true;
    f.io.open = async (name) => {
      const handle = await open(name);
      return new Proxy(handle, {
        get(target, key) {
          if (key === "readFile") return async () => {
            const raw = await target.readFile("utf8");
            if (rotate) {
              rotate = false;
              await fsp.writeFile(name, next);
            }
            return raw;
          };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        }
      }) as FileHandle;
    };
    assert.equal(await store.get(), next);
    assert.equal(await store.get(), next);
    assert.equal(f.counts.read, 3);
  } finally { await f.cleanup(); }
});

test("reload during a cached metadata check forces a reread", async () => {
  const f = await fixture();
  try {
    const store = createAuthSecretStore(() => f.file, f.io);
    const key = await store.get();
    const stat = f.io.stat;
    let reload = true;
    f.io.stat = async (name) => {
      const result = await stat(name);
      if (reload) { reload = false; store.invalidate(); }
      return result;
    };
    assert.equal(await store.get(), key);
    // The interrupted generation is discarded, including its just-read bytes.
    assert.equal(f.counts.read, 3);
  } finally { await f.cleanup(); }
});

test("unstable file exhausts bounded reads without caching and recovers", async () => {
  const f = await fixture();
  try {
    const stat = f.io.stat;
    const store = createAuthSecretStore(() => f.file, f.io);
    await store.get();
    store.invalidate();
    f.io.stat = async (name) => {
      const result = await stat(name);
      return { ...result, mtimeNs: result.mtimeNs + 1n };
    };
    await assert.rejects(store.get(), { code: "EAGAIN" });
    assert.equal(f.counts.read, 4);
    f.io.stat = stat;
    await store.get();
    assert.equal(f.counts.read, 5);
  } finally { await f.cleanup(); }
});

test("real auth accepts valid tokens, rejects invalid/expired tokens and observes rotation", async () => {
  const f = await fixture();
  // Set isolated configuration before importing auth/config; never read the production key.
  process.env.TWM_DATA_DIR = path.dirname(f.file);
  process.env.TWM_AUTH_MODE = "password";
  process.env.TWM_ADMIN_PASSWORD = crypto.randomBytes(24).toString("base64url");
  process.env.TWM_AUTHORIZED_KEYS_FILE = path.join(f.root, "absent-authorized-keys");
  const auth = await import("./auth.js");
  const { config } = await import("./config.js");
  try {
    assert.equal(config.dataDir, path.dirname(f.file));
    const user = { name: "isolated-user", method: "password" as const, permissions: ["read", "write"] };
    const tokens = await Promise.all(Array.from({ length: 64 }, () => auth.createToken(user)));
    assert.deepEqual(await auth.verifyToken(tokens[0]), user);
    assert.equal(await auth.verifyToken(`${tokens[0].split(".")[0]}.${"x".repeat(43)}`), null);
    assert.equal(await auth.verifyToken(undefined), null);
    assert.equal(await auth.verifyToken("malformed"), null);
    const oldSecret = (await fsp.readFile(f.file, "utf8")).trim();
    const payload = Buffer.from(JSON.stringify({ user, exp: Date.now() - 1 })).toString("base64url");
    const expired = `${payload}.${crypto.createHmac("sha256", oldSecret).update(payload).digest("base64url")}`;
    assert.equal(await auth.verifyToken(expired), null);
    const decoded = JSON.parse(Buffer.from(tokens[0].split(".")[0], "base64url").toString());
    assert.ok(Math.abs(decoded.exp - Date.now() - auth.AUTH_TOKEN_TTL_MS) < 1000);
    assert.deepEqual(await auth.userFromCookie(auth.taskMonitorCookieHeader(tokens[0])), user);
    assert.deepEqual(await auth.verifyPassword(config.adminUser, config.adminPassword), { name: config.adminUser, method: "password" });
    assert.equal(await auth.verifyPassword(config.adminUser, "wrong"), null);
    for (const replacement of ["in-place", "rename"] as const) {
      const old = await auth.createToken(user);
      const secret = crypto.randomBytes(48).toString("base64url");
      if (replacement === "in-place") await fsp.writeFile(f.file, `${secret}\n`);
      else { await fsp.writeFile(`${f.file}.next`, `${secret}\n`); await fsp.rename(`${f.file}.next`, f.file); }
      assert.equal(await auth.verifyToken(old), null);
      const next = await auth.createToken(user);
      assert.deepEqual(await auth.verifyToken(next), user);
    }
    auth.reloadAuthSecret();
    assert.deepEqual(await auth.verifyToken(await auth.createToken(user)), user);
    config.authModes = ["none"];
    assert.deepEqual(await auth.userFromCookie(undefined), { name: "local", method: "none" });
  } finally { await f.cleanup(); }
});
