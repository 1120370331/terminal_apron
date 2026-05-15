import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server as SocketServer } from "socket.io";
import { config, dataDirForUser } from "./config.js";
import { SessionStore } from "./db.js";
import {
  authConfig,
  clearAuthCookie,
  createSshChallenge,
  createToken,
  requireAuth,
  setAuthCookie,
  userFromCookie,
  verifyPassword,
  verifySshLogin
} from "./auth.js";
import {
  capturePreview,
  ensureTmuxSession,
  killTmuxSession,
  runtimeInfo,
  sendTmuxInput,
  tmuxHealth
} from "./tmux.js";
import {
  captureZellijPreview,
  ensureZellijSession,
  killZellijSession,
  saveZellijSessionState,
  sendZellijInput,
  zellijHealth,
  zellijPreviewSize,
  zellijRuntimeInfo,
  zellijRuntimeSnapshot
} from "./zellij.js";
import { registerTerminalSockets } from "./terminalSocket.js";
import { nodePtyHealth } from "./pty.js";
import { backendHealth, resolveBackend } from "./backend.js";
import { NativeSessionManager } from "./nativeSessions.js";
import { renderPreviewGrid } from "./previewGrid.js";
import type {
  CreateSessionInput,
  AuthUser,
  SystemMetrics,
  TerminalPreviewGrid,
  TerminalSession,
  UpdateSessionInput
} from "../shared/types.js";

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: {
    origin: true,
    credentials: true
  }
});
const stores = new Map<string, Promise<SessionStore>>();
const restoreQueuedStores = new Set<string>();
const nativeSessions = new NativeSessionManager();
const DEFAULT_PREVIEW_MAX_CHARS = 120_000;

app.use(express.json({ limit: "1mb" }));

async function storeForUser(user: AuthUser): Promise<SessionStore> {
  const userDataDir = path.resolve(dataDirForUser(user.name));
  let storePromise = stores.get(userDataDir);
  if (!storePromise) {
    storePromise = (async () => {
      const store = new SessionStore(userDataDir);
      await store.init();
      queueStoreSessionRestore(store);
      return store;
    })();
    stores.set(userDataDir, storePromise);
  }
  return storePromise;
}

app.get("/api/auth/config", (_req, res) => {
  res.json(authConfig());
});

app.get("/api/me", async (req, res) => {
  const user = await userFromCookie(req.headers.cookie);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.json(user);
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body as { username?: string; password?: string };
  const user = await verifyPassword(username ?? "", password ?? "");
  if (!user) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }
  setAuthCookie(res, await createToken(user));
  res.json(user);
});

app.post("/api/auth/logout", (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.post("/api/auth/ssh/challenge", (req, res) => {
  const { username } = req.body as { username?: string };
  const challenge = createSshChallenge(username ?? config.adminUser);
  res.json({
    id: challenge.id,
    username: challenge.username,
    namespace: config.sshNamespace,
    value: challenge.value,
    expiresAt: challenge.expiresAt
  });
});

app.post("/api/auth/ssh/verify", async (req, res) => {
  const user = await verifySshLogin(req.body as {
    challengeId: string;
    username: string;
    publicKey: string;
    signature: string;
  });
  if (!user) {
    res.status(401).json({ error: "invalid ssh signature" });
    return;
  }
  setAuthCookie(res, await createToken(user));
  res.json(user);
});

app.get("/api/health", async (_req, res) => {
  const [tmux, zellij, nodePty, backend] = await Promise.all([
    tmuxHealth(),
    zellijHealth(),
    nodePtyHealth(),
    backendHealth()
  ]);
  res.json({
    ok: nodePty.available && Boolean(backend.default),
    auth: authConfig(),
    processUser: currentProcessUser(),
    backend,
    tmux,
    zellij,
    nodePty,
    dataDir: config.dataDir
  });
});

app.use("/api", requireAuth);

app.get("/api/system/metrics", (_req, res) => {
  res.json(readSystemMetrics());
});

app.get("/api/sessions", async (req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  const includeArchived = req.query.archived === "true";
  const sessions = await store.all();
  const visible = includeArchived ? sessions : sessions.filter((session) => !session.archived);
  const enriched = await Promise.all(
    visible.map(async (session) => ({
      ...session,
      runtime: await getRuntimeSnapshot(session, store.dataDir).catch(() => fallbackRuntime(session))
    }))
  );
  res.json(enriched);
});

app.post("/api/sessions", async (req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  const session = await store.create(req.body as CreateSessionInput);
  void ensureSession(session, store.dataDir).catch((error) => {
    console.error(`Failed to start session ${session.id}`, error);
  });
  res.status(201).json({
    ...session,
    runtime: await getRuntime(session, store.dataDir).catch(() => fallbackRuntime(session))
  });
});

app.post("/api/sessions/:id/duplicate", async (req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  const source = await store.get(req.params.id);
  if (!source) {
    res.status(404).json({ error: "session not found" });
    return;
  }

  const sessions = await store.all();
  const duplicate = await store.create({
    name: nextCopyName(source.name, sessions.map((session) => session.name)),
    group: source.group,
    tags: source.tags,
    cwd: source.cwd,
    shell: source.shell,
    backend: source.backend,
    color: source.color
  });

  const updated =
    source.layout &&
    (await store.update(duplicate.id, {
      layout: {
        ...source.layout,
        x: source.layout.x + 1,
        y: source.layout.y + 1
      }
    }));

  const copied = updated || duplicate;
  res.status(201).json({
    ...copied,
    runtime: await getRuntime(copied, store.dataDir)
  });
});

app.patch("/api/sessions/:id", async (req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  const updated = await store.update(req.params.id, req.body as UpdateSessionInput);
  if (!updated) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  res.json({
    ...updated,
    runtime: await getRuntime(updated, store.dataDir).catch(() => undefined)
  });
});

app.post("/api/sessions/:id/ensure", async (req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  const session = await store.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  await ensureSession(session, store.dataDir);
  res.json({
    ...session,
    runtime: await getRuntime(session, store.dataDir)
  });
});

app.post("/api/sessions/:id/input", async (req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  const session = await store.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }

  const { data, enter } = req.body as { data?: unknown; enter?: unknown; submitKey?: unknown };
  if (typeof data !== "string" || data.length === 0) {
    res.status(400).json({ error: "input data is required" });
    return;
  }
  if (data.length > 16_000) {
    res.status(413).json({ error: "input data is too large" });
    return;
  }

  await sendSessionInput(session, data, enter !== false, store.dataDir);
  const previewLines = parsePreviewLines(req.body?.lines);
  const previewText = await captureSessionPreview(session, store.dataDir, previewLines, false).catch(() => "");
  const compactPreview = compactPreviewPayload(previewText, parsePreviewMaxChars(req.body?.maxChars));
  const grid = await renderSessionPreviewGrid(session, compactPreview, previewLines, false).catch(() => undefined);
  res.json({
    ok: true,
    runtime: await getRuntime(session, store.dataDir),
    preview: compactPreview,
    grid,
    signature: previewSignature(compactPreview, grid)
  });
});

app.post("/api/sessions/:id/archive", async (req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  const updated = await store.update(req.params.id, { archived: true });
  if (!updated) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  res.json(updated);
});

app.post("/api/sessions/:id/restore", async (req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  const updated = await store.update(req.params.id, { archived: false });
  if (!updated) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  await ensureSession(updated, store.dataDir);
  res.json({
    ...updated,
    runtime: await getRuntime(updated, store.dataDir)
  });
});

app.post("/api/sessions/:id/kill", async (req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  const session = await store.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  await killSession(session, store.dataDir);
  const stopped = await store.markStopped(session.id);
  res.json(stopped);
});

app.get("/api/sessions/:id/preview", async (req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  const session = await store.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  const previewLines = parsePreviewLines(req.query.lines);
  const previewFull = parsePreviewFull(req.query.full);
  const previewText = await captureSessionPreview(session, store.dataDir, previewLines, previewFull).catch(() => "");
  const compactPreview = compactPreviewPayload(previewText, parsePreviewMaxChars(req.query.maxChars));
  const grid = await renderSessionPreviewGrid(session, compactPreview, previewLines, previewFull).catch(() => undefined);
  res.json({
    sessionId: session.id,
    text: compactPreview,
    grid,
    signature: previewSignature(compactPreview, grid),
    capturedAt: new Date().toISOString()
  });
});

registerTerminalSockets(io, storeForUser, nativeSessions);

const dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDir =
  [path.resolve(dirname, "../../client"), path.resolve(dirname, "../client")].find((candidate) =>
    fs.existsSync(path.join(candidate, "index.html"))
  ) ?? path.resolve(dirname, "../client");
app.use(express.static(clientDir));
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/socket.io")) {
    next();
    return;
  }
  res.sendFile(path.join(clientDir, "index.html"));
});

await storeForUser({ name: config.adminUser, method: "password" });
server.listen(config.port, config.host, () => {
  console.log(`terminal-web-monitor listening on http://${config.host}:${config.port}`);
  console.log(`data dir: ${config.dataDir}`);
  console.log(`auth modes: ${authConfig().methods.join(", ")}`);
});

let shutdownStarted = false;
async function shutdown(signal: string) {
  if (shutdownStarted) {
    return;
  }
  shutdownStarted = true;
  console.log(`received ${signal}; saving zellij sessions before shutdown`);
  await saveKnownZellijSessions().catch((error) => {
    console.error("Failed to save zellij sessions during shutdown", error);
  });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function saveKnownZellijSessions() {
  const storeResults = await Promise.allSettled(Array.from(stores.values()));
  const sessionNames = new Set<string>();
  for (const result of storeResults) {
    if (result.status !== "fulfilled") {
      continue;
    }
    const sessions = await result.value.all().catch(() => []);
    sessions.filter((session) => !session.archived).forEach((session) => sessionNames.add(session.tmuxName));
  }

  await Promise.allSettled(Array.from(sessionNames).map((sessionName) => saveZellijSessionState(sessionName)));
}

function queueStoreSessionRestore(store: SessionStore) {
  const key = path.resolve(store.dataDir);
  if (restoreQueuedStores.has(key)) {
    return;
  }
  restoreQueuedStores.add(key);
  setTimeout(() => {
    void restoreActiveSessions(store).catch((error) => {
      console.error(`Failed to restore active sessions in ${store.dataDir}`, error);
    });
  }, 0);
}

async function restoreActiveSessions(store: SessionStore) {
  const sessions = (await store.all()).filter((session) => !session.archived);
  const results = await Promise.allSettled(sessions.map((session) => ensureSession(session, store.dataDir)));
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`Failed to restore session ${sessions[index]?.id}`, result.reason);
    }
  });
}

async function ensureSession(session: TerminalSession, dataDir = config.dataDir) {
  const backend = await resolveBackend(session);
  if (backend === "tmux") {
    await ensureTmuxSession(session);
    return;
  }
  if (backend === "zellij") {
    await ensureZellijSession(session);
    return;
  }
  await nativeSessions.ensure(session, dataDir);
}

async function getRuntime(session: TerminalSession, dataDir = config.dataDir) {
  const backend = await resolveBackend(session);
  if (backend === "tmux") {
    return runtimeInfo(session);
  }
  if (backend === "zellij") {
    return zellijRuntimeInfo(session);
  }
  return nativeSessions.runtime(session, dataDir);
}

async function getRuntimeSnapshot(session: TerminalSession, dataDir = config.dataDir) {
  const backend = await resolveBackend(session);
  if (backend === "zellij") {
    return zellijRuntimeSnapshot(session);
  }
  return getRuntime(session, dataDir);
}

async function captureSessionPreview(session: TerminalSession, dataDir: string, lines = 500, full = true) {
  const backend = await resolveBackend(session);
  if (backend === "tmux") {
    return capturePreview(session, lines);
  }
  if (backend === "zellij") {
    return captureZellijPreview(session, lines, full, dataDir);
  }
  return nativeSessions.preview(session, lines, dataDir);
}

async function renderSessionPreviewGrid(
  session: TerminalSession,
  previewText: string,
  lines: number,
  full: boolean
) {
  const backend = await resolveBackend(session);
  if (backend === "zellij") {
    const size = await zellijPreviewSize(session).catch(() => undefined);
    if (size) {
      return renderPreviewGrid(previewText, {
        cols: size.cols,
        rows: full ? lines : size.rows,
        preserveViewport: true,
        padRows: !full
      });
    }
  }
  return renderPreviewGrid(previewText);
}

async function killSession(session: TerminalSession, dataDir = config.dataDir) {
  const backend = await resolveBackend(session);
  if (backend === "tmux") {
    await killTmuxSession(session);
    return;
  }
  if (backend === "zellij") {
    await killZellijSession(session);
    return;
  }
  await nativeSessions.kill(session, dataDir);
}

async function sendSessionInput(
  session: TerminalSession,
  data: string,
  enter: boolean,
  dataDir = config.dataDir
) {
  const backend = await resolveBackend(session);
  if (backend === "tmux") {
    await sendTmuxInput(session, data, enter);
    return;
  }
  if (backend === "zellij") {
    await sendZellijInput(session, data, enter);
    return;
  }
  await nativeSessions.write(session, data, enter, dataDir);
}

function nextCopyName(name: string, existingNames: string[]): string {
  const names = new Set(existingNames);
  const base = `${name} copy`;
  if (!names.has(base)) {
    return base;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!names.has(candidate)) {
      return candidate;
    }
  }

  return `${base} ${Date.now()}`;
}

function currentProcessUser() {
  const user = os.userInfo();
  return {
    username: user.username,
    homedir: user.homedir,
    shell: user.shell,
    uid: user.uid,
    gid: user.gid
  };
}

function fallbackRuntime(session: TerminalSession) {
  return {
    exists: false,
    backend: "zellij" as const,
    persistent: true,
    attached: 0,
    currentPath: session.cwd,
    currentCommand: "",
    windows: 0,
    lastAttached: null
  };
}

function parsePreviewLines(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 500;
  }
  return Math.max(20, Math.min(config.previewMaxLines, Math.floor(parsed)));
}

function parsePreviewMaxChars(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_PREVIEW_MAX_CHARS;
  }
  return Math.max(20_000, Math.min(500_000, Math.floor(parsed)));
}

function parsePreviewFull(value: unknown): boolean {
  return value !== "false";
}

function compactPreviewPayload(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  let tail = value.slice(-maxChars);
  const firstLineBreak = tail.indexOf("\n");
  if (firstLineBreak >= 0) {
    tail = tail.slice(firstLineBreak + 1);
  }
  return `\u001b[0m${tail}`;
}

function previewSignature(text: string, grid?: TerminalPreviewGrid): string {
  const hash = crypto.createHash("sha1");
  hash.update(text);
  if (grid) {
    hash.update(`\ncols=${grid.cols};rows=${grid.rows.length}`);
    for (const row of grid.rows) {
      hash.update("\n");
      for (const segment of row.segments) {
        hash.update(segment.text);
        hash.update("\u001f");
        hash.update(String(segment.cols));
        hash.update("\u001f");
        hash.update(segment.fg ?? "");
        hash.update("\u001f");
        hash.update(segment.bg ?? "");
        hash.update("\u001f");
        hash.update(segment.bold ? "1" : "0");
        hash.update(segment.italic ? "1" : "0");
        hash.update(segment.underline ? "1" : "0");
        hash.update(segment.dim ? "1" : "0");
      }
    }
  }
  return hash.digest("hex");
}

interface CpuSnapshot {
  idle: number;
  total: number;
}

let previousCpuSnapshot: CpuSnapshot | null = null;

function readSystemMetrics(): SystemMetrics {
  const cpus = os.cpus();
  const currentCpu = readCpuSnapshot(cpus);
  const previousCpu = previousCpuSnapshot;
  previousCpuSnapshot = currentCpu;

  const idleDelta = previousCpu ? currentCpu.idle - previousCpu.idle : 0;
  const totalDelta = previousCpu ? currentCpu.total - previousCpu.total : 0;
  const usagePercent =
    totalDelta > 0 ? clampPercent((1 - Math.max(0, idleDelta) / Math.max(1, totalDelta)) * 100) : 0;
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = Math.max(0, totalMemory - freeMemory);
  const processMemory = process.memoryUsage();

  return {
    capturedAt: new Date().toISOString(),
    uptimeSec: os.uptime(),
    cpu: {
      usagePercent,
      cores: cpus.length,
      model: cpus[0]?.model ?? process.arch,
      loadAverage: os.loadavg()
    },
    memory: {
      totalBytes: totalMemory,
      freeBytes: freeMemory,
      usedBytes: usedMemory,
      usagePercent: totalMemory > 0 ? clampPercent((usedMemory / totalMemory) * 100) : 0,
      processRssBytes: processMemory.rss,
      processHeapUsedBytes: processMemory.heapUsed,
      processHeapTotalBytes: processMemory.heapTotal
    }
  };
}

function readCpuSnapshot(cpus: os.CpuInfo[]): CpuSnapshot {
  return cpus.reduce<CpuSnapshot>(
    (snapshot, cpu) => {
      const times = cpu.times;
      const total = times.user + times.nice + times.sys + times.idle + times.irq;
      return {
        idle: snapshot.idle + times.idle,
        total: snapshot.total + total
      };
    },
    { idle: 0, total: 0 }
  );
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}
