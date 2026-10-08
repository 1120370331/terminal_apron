import crypto from "node:crypto";
import type { BigIntStats } from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";

export interface AuthSecretIO {
  stat(file: string): Promise<BigIntStats>;
  open(file: string): Promise<FileHandle>;
  mkdir(directory: string): Promise<unknown>;
  write(file: string, value: string): Promise<void>;
}

const disk: AuthSecretIO = {
  stat: (file) => fsp.stat(file, { bigint: true }),
  open: (file) => fsp.open(file, "r"),
  mkdir: (directory) => fsp.mkdir(directory, { recursive: true }),
  write: (file, value) => fsp.writeFile(file, value, { flag: "wx", mode: 0o600 })
};

function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function version(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(":");
}

/** Single-flight reads; every new operation checks metadata, with no TTL/auth-result cache. */
export function createAuthSecretStore(secretPath: () => string, io: AuthSecretIO = disk) {
  let cached: { file: string; version: string; secret: string } | undefined;
  let pending: Promise<string> | undefined;
  let generation = 0;

  async function load(file: string) {
    let current: BigIntStats;
    try {
      current = await io.stat(file);
    } catch (error) {
      cached = undefined;
      if (!hasCode(error, "ENOENT")) throw error;
      await io.mkdir(path.dirname(file));
      try {
        await io.write(file, `${crypto.randomBytes(48).toString("base64url")}\n`);
      } catch (writeError) {
        // Another process may initialize first; never overwrite its key.
        if (!hasCode(writeError, "EEXIST")) throw writeError;
      }
      current = await io.stat(file);
    }
    if (cached?.file === file && cached.version === version(current)) return cached;
    cached = undefined;

    // Pair bytes with the opened file's version, then ensure the path still refers to it.
    // A concurrent in-place write or atomic replacement causes a bounded reread.
    for (let attempt = 0; attempt < 3; attempt++) {
      const handle = await io.open(file);
      try {
        const before = version(await handle.stat({ bigint: true }));
        const secret = (await handle.readFile("utf8")).trim();
        const after = version(await handle.stat({ bigint: true }));
        if (before === after && after === version(await io.stat(file))) {
          if (!secret) {
            throw Object.assign(new Error("Authentication secret is empty; restore it and retry"), { code: "EINVAL" });
          }
          return { file, version: after, secret };
        }
      } finally {
        await handle.close();
      }
    }
    throw Object.assign(new Error("Authentication secret changed while reading; retry"), { code: "EAGAIN" });
  }

  function get(): Promise<string> {
    if (pending) return pending;
    const operation = (async () => {
      for (;;) {
        const epoch = generation;
        const file = secretPath();
        const value = await load(file);
        if (epoch !== generation || file !== secretPath()) continue;
        cached = value;
        return value.secret;
      }
    })();
    pending = operation;
    // Both success and failure release the flight; failure must remain retryable.
    void operation.then(clear, clear);
    function clear() {
      if (pending === operation) pending = undefined;
    }
    return operation;
  }

  return {
    get,
    invalidate() {
      generation++;
      cached = undefined;
    }
  };
}
