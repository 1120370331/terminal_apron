import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server as SocketServer } from "socket.io";
import multer from "multer";
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
  FileTransferEntry,
  FileTransferListResponse,
  FileTransferUploadResponse,
  SessionInputMode,
  SessionInputRequest,
  SessionPreview,
  SessionPreviewDebug,
  SessionUploadResponse,
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
const PREVIEW_CACHE_FRESH_MS = 1_800;
const PREVIEW_CACHE_STALE_MS = 30_000;
const FULL_PREVIEW_CACHE_FRESH_MS = 15_000;
const FULL_PREVIEW_CACHE_STALE_MS = 60_000;
const PREVIEW_MAX_CONCURRENT = 2;
const MAX_UPLOAD_FILES = 8;
const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
const TRANSFER_DIR_NAME = "file-transfer";
const MAX_TRANSFER_LIST_FILES = 1000;
let acceptedInputSeq = 0;
let activePreviewJobs = 0;
const previewJobQueue: Array<() => void> = [];
const sessionPreviewCache = new Map<string, PreviewCacheEntry>();
const uploadSessionFiles = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: MAX_UPLOAD_FILES,
    fileSize: MAX_UPLOAD_FILE_BYTES
  }
}).array("files", MAX_UPLOAD_FILES);

app.use(express.json({ limit: "1mb" }));

interface PreviewCacheEntry {
  value?: SessionPreview;
  capturedAtMs: number;
  inFlight?: Promise<SessionPreview>;
}

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

app.get("/api/file-transfer/files", async (_req, res) => {
  const user = res.locals.user as AuthUser;
  const rootDir = await ensureTransferRoot(user);
  res.json(await fileTransferListPayload(rootDir));
});

app.post("/api/file-transfer/files", (req, res, next) => {
  uploadSessionFiles(req, res, (error) => {
    if (error) {
      res.status(error instanceof multer.MulterError ? 413 : 400).json({
        error: error instanceof Error ? error.message : "upload failed"
      });
      return;
    }
    void handleFileTransferUpload(req, res).catch(next);
  });
});

app.delete("/api/file-transfer/files", async (req, res) => {
  const user = res.locals.user as AuthUser;
  const rootDir = await ensureTransferRoot(user);
  const relativePath = typeof req.body?.path === "string" ? req.body.path : "";
  const targetPath = resolveTransferFilePathOrRespond(rootDir, relativePath, res);
  if (!targetPath) {
    return;
  }
  const stat = await fs.promises.stat(targetPath).catch(() => null);
  if (!stat?.isFile()) {
    res.status(404).json({ error: "file not found" });
    return;
  }
  await fs.promises.unlink(targetPath);
  res.json({ ok: true });
});

app.get("/api/file-transfer/download", async (req, res) => {
  const user = res.locals.user as AuthUser;
  const rootDir = await ensureTransferRoot(user);
  const relativePath = typeof req.query.path === "string" ? req.query.path : "";
  const targetPath = resolveTransferFilePathOrRespond(rootDir, relativePath, res);
  if (!targetPath) {
    return;
  }
  const stat = await fs.promises.stat(targetPath).catch(() => null);
  if (!stat?.isFile()) {
    res.status(404).json({ error: "file not found" });
    return;
  }
  res.download(targetPath, path.basename(targetPath));
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

  const body = req.body as Partial<SessionInputRequest> & {
    inputId?: unknown;
    maxChars?: unknown;
    lines?: unknown;
    includePreview?: unknown;
  };
  const { data, enter, mode, submitDelayMs } = body;
  const inputId = normalizeInputId(body.inputId);
  if (typeof data !== "string" || data.length === 0) {
    res.status(400).json({ error: "input data is required", inputId, status: "error" });
    return;
  }
  if (data.length > 16_000) {
    res.status(413).json({ error: "input data is too large", inputId, status: "error" });
    return;
  }

  const inputMode = normalizeInputMode(mode);
  const inputSeq = (acceptedInputSeq += 1);
  try {
    await sendSessionInput(
      session,
      data,
      enter !== false,
      store.dataDir,
      inputMode,
      parseSubmitDelayMs(submitDelayMs, inputMode === "paste" ? 120 : 0)
    );
    invalidateSessionPreviewCache(session, store.dataDir);
  } catch (error) {
    res.status(502).json({
      ok: false,
      inputId,
      inputSeq,
      status: "error",
      error: errorMessage(error)
    });
    return;
  }

  if (body.includePreview === false) {
    res.json({
      ok: true,
      inputId,
      inputSeq,
      status: "accepted",
      capturedAt: new Date().toISOString()
    });
    return;
  }

  const preview = await loadSessionPreview(session, store.dataDir, {
    lines: parsePreviewLines(body.lines),
    maxChars: parsePreviewMaxChars(body.maxChars),
    full: false,
    allowStale: false,
    forceRefresh: true
  }).catch(() => emptySessionPreview(session.id));
  res.json({
    ok: true,
    inputId,
    inputSeq,
    status: "accepted",
    runtime: await getRuntime(session, store.dataDir).catch(() => fallbackRuntime(session)),
    preview: preview.text,
    grid: preview.grid,
    signature: preview.signature,
    capturedAt: preview.capturedAt
  });
});

app.post("/api/sessions/:id/uploads", (req, res, next) => {
  uploadSessionFiles(req, res, (error) => {
    if (error) {
      res.status(error instanceof multer.MulterError ? 413 : 400).json({
        error: error instanceof Error ? error.message : "upload failed"
      });
      return;
    }
    void handleSessionUpload(req, res).catch(next);
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
  const preview = await loadSessionPreview(session, store.dataDir, {
    lines: previewLines,
    maxChars: parsePreviewMaxChars(req.query.maxChars),
    full: previewFull,
    allowStale: true,
    forceRefresh: parsePreviewForce(req.query.force)
  });
  const knownSignature = normalizePreviewSignature(req.query.signature);
  if (knownSignature && preview.signature === knownSignature) {
    const unchanged = unchangedSessionPreview(preview);
    setPreviewTimingHeader(res, unchanged.debug);
    res.json(unchanged);
    return;
  }
  setPreviewTimingHeader(res, preview.debug);
  res.json(preview);
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

async function loadSessionPreview(
  session: TerminalSession,
  dataDir: string,
  options: { lines: number; maxChars: number; full: boolean; allowStale: boolean; forceRefresh?: boolean }
): Promise<SessionPreview> {
  const key = previewCacheKey(session, dataDir, options);
  const now = Date.now();
  const cached = sessionPreviewCache.get(key);
  const freshMs = options.full ? FULL_PREVIEW_CACHE_FRESH_MS : PREVIEW_CACHE_FRESH_MS;
  const staleMs = options.full ? FULL_PREVIEW_CACHE_STALE_MS : PREVIEW_CACHE_STALE_MS;

  if (!options.forceRefresh && cached?.value) {
    const ageMs = now - cached.capturedAtMs;
    if (ageMs < freshMs) {
      return withPreviewDebug(cached.value, {
        cache: "hit",
        ageMs,
        payloadBytes: previewPayloadBytes(cached.value)
      });
    }
    if (options.allowStale && ageMs < staleMs) {
      if (!cached.inFlight) {
        const inFlight = refreshSessionPreview(session, dataDir, options, key, cached).catch((error) => {
          sessionPreviewCache.set(key, { value: cached.value, capturedAtMs: cached.capturedAtMs });
          throw error;
        });
        sessionPreviewCache.set(key, { ...cached, inFlight });
        void inFlight.catch(() => undefined);
      }
      return withPreviewDebug(cached.value, {
        cache: cached.inFlight ? "refreshing" : "stale",
        ageMs,
        payloadBytes: previewPayloadBytes(cached.value)
      });
    }
  }

  if (!options.forceRefresh && cached?.inFlight) {
    return cached.inFlight;
  }

  const inFlight = refreshSessionPreview(session, dataDir, options, key, cached);
  sessionPreviewCache.set(key, {
    value: cached?.value,
    capturedAtMs: cached?.capturedAtMs ?? 0,
    inFlight
  });
  return inFlight;
}

async function refreshSessionPreview(
  session: TerminalSession,
  dataDir: string,
  options: { lines: number; maxChars: number; full: boolean },
  key: string,
  previous?: PreviewCacheEntry
): Promise<SessionPreview> {
  const startedAt = Date.now();
  const preview = await runPreviewJob(async () => {
    const captureStartedAt = Date.now();
    const previewText = await captureSessionPreview(session, dataDir, options.lines, options.full).catch(() => "");
    const captureMs = Date.now() - captureStartedAt;
    const compactPreview = compactPreviewPayload(previewText, options.maxChars);
    const renderStartedAt = Date.now();
    const grid = await renderSessionPreviewGrid(session, compactPreview, options.lines, options.full).catch(
      () => undefined
    );
    const renderMs = Date.now() - renderStartedAt;
    return {
      sessionId: session.id,
      text: compactPreview,
      grid,
      signature: previewSignature(compactPreview, grid),
      capturedAt: new Date().toISOString(),
      debug: {
        cache: previous?.value ? "stale" : "miss",
        captureMs,
        renderMs,
        totalMs: Date.now() - startedAt
      }
    } satisfies SessionPreview;
  });

  const value = withPreviewDebug(preview, {
    ...preview.debug,
    cache: previous?.value ? "stale" : "miss",
    totalMs: Date.now() - startedAt,
    payloadBytes: previewPayloadBytes(preview)
  });
  sessionPreviewCache.set(key, {
    value,
    capturedAtMs: Date.now()
  });
  return value;
}

function runPreviewJob<T>(run: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      activePreviewJobs += 1;
      run()
        .then(resolve, reject)
        .finally(() => {
          activePreviewJobs = Math.max(0, activePreviewJobs - 1);
          previewJobQueue.shift()?.();
        });
    };

    if (activePreviewJobs < PREVIEW_MAX_CONCURRENT) {
      start();
    } else {
      previewJobQueue.push(start);
    }
  });
}

function previewCacheKey(
  session: TerminalSession,
  dataDir: string,
  options: { lines: number; maxChars: number; full: boolean }
): string {
  return [
    path.resolve(dataDir),
    session.id,
    session.tmuxName,
    options.full ? "full" : "viewport",
    options.lines,
    options.maxChars
  ].join("\u001f");
}

function invalidateSessionPreviewCache(session: TerminalSession, dataDir: string): void {
  const prefix = `${path.resolve(dataDir)}\u001f${session.id}\u001f`;
  for (const key of sessionPreviewCache.keys()) {
    if (key.startsWith(prefix)) {
      sessionPreviewCache.delete(key);
    }
  }
}

function withPreviewDebug(preview: SessionPreview, debug: Partial<SessionPreviewDebug>): SessionPreview {
  return {
    ...preview,
    debug: {
      cache: debug.cache ?? preview.debug?.cache ?? "miss",
      ageMs: debug.ageMs ?? preview.debug?.ageMs,
      captureMs: debug.captureMs ?? preview.debug?.captureMs,
      renderMs: debug.renderMs ?? preview.debug?.renderMs,
      totalMs: debug.totalMs ?? preview.debug?.totalMs,
      payloadBytes: debug.payloadBytes ?? preview.debug?.payloadBytes
    }
  };
}

function previewPayloadBytes(preview: SessionPreview): number {
  return Buffer.byteLength(JSON.stringify({ text: preview.text, grid: preview.grid }), "utf8");
}

function setPreviewTimingHeader(
  res: express.Response,
  debug: SessionPreviewDebug | undefined
): void {
  if (!debug) {
    return;
  }
  const parts = [
    `preview;desc="${debug.cache}"`,
    typeof debug.captureMs === "number" ? `zellij;dur=${debug.captureMs}` : "",
    typeof debug.renderMs === "number" ? `render;dur=${debug.renderMs}` : "",
    typeof debug.totalMs === "number" ? `total;dur=${debug.totalMs}` : ""
  ].filter(Boolean);
  if (parts.length) {
    res.setHeader("Server-Timing", parts.join(", "));
  }
}

function emptySessionPreview(sessionId: string): SessionPreview {
  return {
    sessionId,
    text: "",
    signature: "",
    capturedAt: new Date().toISOString()
  };
}

function unchangedSessionPreview(preview: SessionPreview): SessionPreview {
  return withPreviewDebug(
    {
      sessionId: preview.sessionId,
      text: "",
      signature: preview.signature,
      capturedAt: preview.capturedAt,
      unchanged: true
    },
    {
      ...preview.debug,
      payloadBytes: previewPayloadBytes({
        sessionId: preview.sessionId,
        text: "",
        signature: preview.signature,
        capturedAt: preview.capturedAt,
        unchanged: true
      })
    }
  );
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
  dataDir = config.dataDir,
  mode: SessionInputMode = "paste",
  submitDelayMs = 0
) {
  const backend = await resolveBackend(session);
  if (backend === "tmux") {
    await sendTmuxInput(session, data, enter, submitDelayMs);
    return;
  }
  if (backend === "zellij") {
    await sendZellijInput(session, data, enter, { mode, submitDelayMs });
    return;
  }
  await nativeSessions.write(session, data, enter, dataDir, submitDelayMs);
}

function normalizeInputMode(value: unknown): SessionInputMode {
  return value === "type" ? "type" : "paste";
}

function normalizeInputId(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[a-zA-Z0-9._:-]{1,120}$/.test(trimmed)) {
      return trimmed;
    }
  }
  return crypto.randomUUID();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "input failed";
}

function parseSubmitDelayMs(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.min(1000, Math.floor(parsed)));
}

async function handleFileTransferUpload(
  req: express.Request,
  res: express.Response<FileTransferUploadResponse | { error: string }>
) {
  const user = res.locals.user as AuthUser;
  const rootDir = await ensureTransferRoot(user);
  const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
  if (files.length === 0) {
    res.status(400).json({ error: "upload files are required" });
    return;
  }

  const savedFiles = await saveTransferFiles(files, rootDir);
  res.json({
    rootPath: rootDir,
    terminalText: savedFiles.map((file) => file.terminalText).join(" "),
    files: savedFiles
  });
}

async function handleSessionUpload(
  req: express.Request,
  res: express.Response<SessionUploadResponse | { error: string }>
) {
  const store = await storeForUser(res.locals.user as AuthUser);
  const session = await store.get(String(req.params.id ?? ""));
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }

  const files = Array.isArray(req.files) ? (req.files as Express.Multer.File[]) : [];
  if (files.length === 0) {
    res.status(400).json({ error: "upload files are required" });
    return;
  }

  const rootDir = await ensureTransferRoot(res.locals.user as AuthUser);
  const savedFiles = await saveTransferFiles(files, rootDir, session.shell);

  res.json({
    files: savedFiles.map((file) => ({
      originalName: file.originalName,
      fileName: file.name,
      mimeType: file.mimeType,
      size: file.size,
      path: file.path,
      terminalText: file.terminalText
    })),
    terminalText: savedFiles.map((file) => file.terminalText).join(" ")
  });
}

type SavedTransferEntry = FileTransferEntry & {
  originalName: string;
};

async function saveTransferFiles(
  files: Express.Multer.File[],
  rootDir: string,
  shell?: string
): Promise<SavedTransferEntry[]> {
  await fs.promises.mkdir(rootDir, { recursive: true });
  const usedNames = new Set<string>();
  const savedFiles: SavedTransferEntry[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const requestedName = safeUploadFileName(file.originalname, file.mimetype, index);
    const filePath = await uniqueTransferFilePath(rootDir, requestedName, usedNames);
    await fs.promises.writeFile(filePath, file.buffer);
    const stat = await fs.promises.stat(filePath);
    savedFiles.push(
      transferEntryFromPath(rootDir, filePath, stat, shell, file.originalname || path.basename(filePath), file.mimetype)
    );
  }

  return savedFiles;
}

async function fileTransferListPayload(rootDir: string): Promise<FileTransferListResponse> {
  const files = await listTransferFiles(rootDir);
  return {
    rootPath: rootDir,
    terminalText: quotePathForTerminal(rootDir, undefined),
    files
  };
}

async function ensureTransferRoot(user: AuthUser): Promise<string> {
  const rootDir = path.resolve(process.cwd(), TRANSFER_DIR_NAME, safePathSegment(user.name));
  await fs.promises.mkdir(rootDir, { recursive: true });
  return rootDir;
}

async function listTransferFiles(rootDir: string): Promise<FileTransferEntry[]> {
  const entries: FileTransferEntry[] = [];
  await collectTransferFiles(rootDir, rootDir, entries);
  return entries.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
}

async function collectTransferFiles(rootDir: string, directory: string, entries: FileTransferEntry[]): Promise<void> {
  if (entries.length >= MAX_TRANSFER_LIST_FILES) {
    return;
  }

  const items = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const item of items) {
    if (entries.length >= MAX_TRANSFER_LIST_FILES) {
      return;
    }
    const itemPath = path.join(directory, item.name);
    if (item.isDirectory()) {
      await collectTransferFiles(rootDir, itemPath, entries);
      continue;
    }
    if (!item.isFile()) {
      continue;
    }
    const stat = await fs.promises.stat(itemPath).catch(() => null);
    if (stat?.isFile()) {
      entries.push(transferEntryFromPath(rootDir, itemPath, stat));
    }
  }
}

function transferEntryFromPath(
  rootDir: string,
  filePath: string,
  stat: fs.Stats,
  shell?: string,
  originalName?: string,
  mimeType?: string
): SavedTransferEntry {
  const relativePath = toTransferRelativePath(rootDir, filePath);
  const name = path.basename(filePath);
  return {
    name,
    originalName: originalName || name,
    relativePath,
    path: filePath,
    terminalText: quotePathForTerminal(filePath, shell),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    mimeType: mimeType || mimeTypeForFileName(name)
  };
}

async function uniqueTransferFilePath(rootDir: string, fileName: string, usedNames: Set<string>): Promise<string> {
  let candidateName = uniqueUploadFileName(fileName, usedNames);
  let candidatePath = path.join(rootDir, candidateName);
  if (!(await pathExists(candidatePath))) {
    return candidatePath;
  }

  const extension = path.extname(candidateName);
  const stem = candidateName.slice(0, candidateName.length - extension.length) || "file";
  for (let index = 2; index < 10_000; index += 1) {
    candidateName = `${stem}-${index}${extension}`;
    candidatePath = path.join(rootDir, candidateName);
    if (!usedNames.has(candidateName) && !(await pathExists(candidatePath))) {
      usedNames.add(candidateName);
      return candidatePath;
    }
  }

  candidateName = `${stem}-${Date.now()}${extension}`;
  usedNames.add(candidateName);
  return path.join(rootDir, candidateName);
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.promises
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

function resolveTransferFilePath(rootDir: string, relativePath: string): string {
  const targetPath = path.resolve(rootDir, relativePath);
  const relative = path.relative(rootDir, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("invalid file path");
  }
  return targetPath;
}

function resolveTransferFilePathOrRespond(
  rootDir: string,
  relativePath: string,
  res: express.Response
): string | null {
  try {
    return resolveTransferFilePath(rootDir, relativePath);
  } catch {
    res.status(400).json({ error: "invalid file path" });
    return null;
  }
}

function toTransferRelativePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

function safeUploadFileName(originalName: string | undefined, mimeType: string | undefined, index: number): string {
  const baseName = (originalName ?? "").split(/[\\/]/).pop()?.trim() ?? "";
  const fallback = `clipboard-${index + 1}${extensionForMimeType(mimeType)}`;
  const cleaned = (baseName || fallback)
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  const safeName = cleaned || fallback;
  if (safeName.length <= 180) {
    return safeName;
  }
  const extension = path.extname(safeName);
  const stem = safeName.slice(0, Math.max(1, 180 - extension.length));
  return `${stem}${extension}`;
}

function uniqueUploadFileName(fileName: string, usedNames: Set<string>): string {
  if (!usedNames.has(fileName)) {
    usedNames.add(fileName);
    return fileName;
  }

  const extension = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - extension.length) || "file";
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
  const fallback = `${stem}-${Date.now()}${extension}`;
  usedNames.add(fallback);
  return fallback;
}

function extensionForMimeType(mimeType: string | undefined): string {
  const normalized = mimeType?.toLowerCase() ?? "";
  if (normalized === "image/png") {
    return ".png";
  }
  if (normalized === "image/jpeg") {
    return ".jpg";
  }
  if (normalized === "image/gif") {
    return ".gif";
  }
  if (normalized === "image/webp") {
    return ".webp";
  }
  if (normalized === "application/pdf") {
    return ".pdf";
  }
  if (normalized.startsWith("text/")) {
    return ".txt";
  }
  return ".bin";
}

function mimeTypeForFileName(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".pdf") {
    return "application/pdf";
  }
  if ([".txt", ".md", ".json", ".csv", ".log"].includes(extension)) {
    return "text/plain";
  }
  return "application/octet-stream";
}

function quotePathForTerminal(filePath: string, shell: string | undefined): string {
  const normalizedShell = shell?.toLowerCase() ?? "";
  if (process.platform === "win32" && normalizedShell.includes("cmd")) {
    return `"${filePath.replace(/"/g, '\\"')}"`;
  }
  return `'${filePath.replace(/'/g, "'\\''")}'`;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "") || "session";
}

function uploadStamp(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const suffix = crypto.randomBytes(4).toString("hex");
  return `${timestamp}-${suffix}`;
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

function parsePreviewForce(value: unknown): boolean {
  return value === "true";
}

function normalizePreviewSignature(value: unknown): string {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value) ? value : "";
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
