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
  getZellijTrackedCwd,
  killZellijSession,
  saveZellijSessionState,
  sendZellijInput,
  setZellijTrackedCwd,
  zellijHealth,
  zellijPreviewSize,
  zellijRuntimeInfo,
  zellijRuntimeSnapshot
} from "./zellij.js";
import { hasActiveZellijWebClient, registerTerminalSockets } from "./terminalSocket.js";
import { nodePtyHealth } from "./pty.js";
import { backendHealth, resolveBackend } from "./backend.js";
import { NativeSessionManager } from "./nativeSessions.js";
import { renderPreviewGrid } from "./previewGrid.js";
import {
  codexResumeCommand,
  findCodexConversation,
  getCodexSessionStatus,
  listCodexConversations
} from "./codex.js";
import { resolveDirectoryChange } from "./shellCwd.js";
import { selectNativeDirectory } from "./nativeDirectoryPicker.js";
import { resolveCodexStatus } from "../shared/codexStatus.js";
import type {
  CreateSessionInput,
  AuthUser,
  SystemMetrics,
  TerminalPreviewGrid,
  TerminalSession,
  UpdateSessionInput,
  UserPreferences
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
const observedCodexSessions = new Set<string>();
let codexStateSnapshotRunning = false;
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

app.get("/api/preferences", async (_req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  res.json(await store.preferences());
});

app.patch("/api/preferences", async (req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  res.json(await store.updatePreferences(req.body as Partial<UserPreferences>));
});

app.post(
  "/api/backgrounds",
  express.raw({ type: ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"], limit: "12mb" }),
  async (req, res) => {
    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    const extension = backgroundImageExtension(req.headers["content-type"]);
    if (!buffer?.length || !extension) {
      res.status(400).json({ error: "请选择 PNG、JPEG、WebP、GIF 或 AVIF 图片" });
      return;
    }

    const store = await storeForUser(res.locals.user as AuthUser);
    const name = `${crypto.randomUUID()}.${extension}`;
    const directory = path.join(store.dataDir, "backgrounds");
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(directory, name), buffer, { flag: "wx" });
    res.status(201).json({ url: `/api/backgrounds/${name}`, name });
  }
);

app.get("/api/backgrounds/:name", async (req, res) => {
  const name = req.params.name;
  if (!/^[a-f0-9-]+\.(?:png|jpg|webp|gif|avif)$/.test(name)) {
    res.status(404).json({ error: "background not found" });
    return;
  }
  const store = await storeForUser(res.locals.user as AuthUser);
  const filePath = path.join(store.dataDir, "backgrounds", name);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "background not found" });
    return;
  }
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(filePath);
});

app.post("/api/filesystem/select-directory", async (req, res) => {
  const initialPath = typeof req.body?.initialPath === "string" ? req.body.initialPath : undefined;
  try {
    res.json({ path: await selectNativeDirectory(initialPath) });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/sessions", async (req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  const includeArchived = req.query.archived === "true";
  const sessions = await store.all();
  const visible = includeArchived ? sessions : sessions.filter((session) => !session.archived);
  const enriched = await Promise.all(
    visible.map(async (session) => {
      const runtime = await getRuntimeSnapshot(session, store.dataDir).catch(() => fallbackRuntime(session));
      return {
        ...session,
        runtime,
        codexStatus: getCodexSessionStatus(
          runtime.currentPath || session.cwd,
          runtime.currentCommand,
          runtime.exists,
          reservedCodexConversationIds(visible, session.id),
          session.createdAt
        )
      };
    })
  );
  res.json(enriched);
});

app.get("/api/codex/statuses", async (_req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  res.json(await collectCodexStatuses(store));
});

async function collectCodexStatuses(store: SessionStore): Promise<Record<string, ReturnType<typeof resolveCodexStatus>>> {
  const sessions = (await store.all()).filter((session) => !session.archived);
  await disableDuplicateCodexResumeAssignments(store, sessions);
  const entries = await Promise.all(
    sessions.map(async (session) => {
      if (hasActiveZellijWebClient(session.tmuxName)) {
        const status = session.codexConversationId
          ? getCodexSessionStatus(
              session.cwd,
              `codex resume ${session.codexConversationId}`,
              Boolean(session.codexAutoResume)
            )
          : { state: "stopped" as const, label: "Codex 未启动" };
        return { session, status };
      }
      const runtime = await getRuntimeSnapshot(session, store.dataDir).catch(() => fallbackRuntime(session));
      const rolloutStatus = getCodexSessionStatus(
        runtime.currentPath || session.cwd,
        runtime.currentCommand,
        runtime.exists,
        reservedCodexConversationIds(sessions, session.id),
        session.createdAt
      );
      const previewText = runtime.exists
        ? await captureSessionPreview(session, store.dataDir, 80, false).catch(() => "")
        : "";
      const status = resolveCodexStatus(
        { ...session, runtime, codexStatus: rolloutStatus },
        {
          sessionId: session.id,
          text: previewText,
          capturedAt: new Date().toISOString()
        }
      );
      return { session, status };
    })
  );
  for (const entry of entries) {
    await persistCodexResumeState(store, entry.session, entry.status);
  }
  return Object.fromEntries(entries.map((entry) => [entry.session.id, entry.status]));
}

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
    color: source.color,
    backgroundMode: source.backgroundMode,
    backgroundImage: source.backgroundImage
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
  if (typeof req.body?.cwd === "string" && req.body.cwd.trim()) {
    setZellijTrackedCwd(updated.tmuxName, updated.cwd);
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

  const { data, enter, submitDelayMs } = req.body as {
    data?: unknown;
    enter?: unknown;
    submitKey?: unknown;
    submitDelayMs?: unknown;
  };
  if (typeof data !== "string" || data.length === 0) {
    res.status(400).json({ error: "input data is required" });
    return;
  }
  if (data.length > 16_000) {
    res.status(413).json({ error: "input data is too large" });
    return;
  }

  await sendSessionInput(session, data, enter !== false, store.dataDir, parseSubmitDelayMs(submitDelayMs, 160));
  if (enter !== false) {
    const currentCwd = getZellijTrackedCwd(session.tmuxName) ?? session.cwd;
    const changedCwd = resolveDirectoryChange(data, currentCwd);
    if (changedCwd) {
      await store.update(session.id, { cwd: changedCwd });
      session.cwd = changedCwd;
      setZellijTrackedCwd(session.tmuxName, changedCwd);
    }
  }
  res.json({
    ok: true,
    runtime: await getRuntimeSnapshot(session, store.dataDir).catch(() => fallbackRuntime(session))
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

app.get("/api/sessions/:id/codex/conversations", async (req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  const session = await store.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }

  const cwd = getZellijTrackedCwd(session.tmuxName) ?? session.cwd;
  try {
    res.json({
      cwd,
      conversations: listCodexConversations(cwd)
    });
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/sessions/:id/codex/resume", async (req, res) => {
  const store = await storeForUser(res.locals.user as AuthUser);
  const session = await store.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }

  const conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId.trim() : "";
  const runtime = await getRuntimeSnapshot(session, store.dataDir).catch(() => undefined);
  const cwd = getZellijTrackedCwd(session.tmuxName) ?? session.cwd;
  if (/\bcodex(?:\.exe)?\b/i.test(runtime?.currentCommand || "")) {
    res.status(409).json({ error: "Codex is already running in this terminal" });
    return;
  }
  const conversation = findCodexConversation(cwd, conversationId);
  if (!conversation) {
    res.status(404).json({ error: "Codex conversation not found for this project path" });
    return;
  }

  const command = codexResumeCommand(conversation.id);
  await sendSessionInput(session, command, true, store.dataDir);
  await store.update(session.id, {
    codexConversationId: conversation.id,
    codexAutoResume: true
  });
  res.json({ ok: true, command, conversation });
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
const codexStateSnapshotTimer = setInterval(() => void snapshotKnownCodexStates(), 15_000);
codexStateSnapshotTimer.unref();
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
  clearInterval(codexStateSnapshotTimer);
  await snapshotKnownCodexStates().catch((error) => {
    console.error("Failed to snapshot Codex sessions during shutdown", error);
  });
  await saveKnownZellijSessions().catch((error) => {
    console.error("Failed to save zellij sessions during shutdown", error);
  });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

async function snapshotKnownCodexStates() {
  if (codexStateSnapshotRunning) {
    return;
  }
  codexStateSnapshotRunning = true;
  try {
    const storeResults = await Promise.allSettled(Array.from(stores.values()));
    for (const result of storeResults) {
      if (result.status === "fulfilled") {
        await collectCodexStatuses(result.value).catch((error) => {
          console.error(`Failed to snapshot Codex sessions in ${result.value.dataDir}`, error);
        });
      }
    }
  } finally {
    codexStateSnapshotRunning = false;
  }
}

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
  await disableDuplicateCodexResumeAssignments(store, sessions);
  const results = await Promise.allSettled(
    sessions.map(async (session) => {
      await ensureSession(session, store.dataDir);
      await restoreCodexConversation(store, session, store.dataDir);
    })
  );
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      console.error(`Failed to restore session ${sessions[index]?.id}`, result.reason);
    }
  });
}

async function restoreCodexConversation(store: SessionStore, session: TerminalSession, dataDir: string) {
  if (!session.codexAutoResume || !session.codexConversationId) {
    return;
  }
  const runtime = await getRuntime(session, dataDir).catch(() => undefined);
  if (!runtime?.exists || isCodexRuntimeCommand(runtime.currentCommand)) {
    return;
  }
  const conversation = findCodexConversation(runtime.currentPath || session.cwd, session.codexConversationId);
  if (!conversation) {
    console.warn(`Skipping Codex restore for ${session.name}: conversation ${session.codexConversationId} not found`);
    await store.update(session.id, { codexConversationId: undefined, codexAutoResume: false });
    return;
  }
  await sendSessionInput(session, codexResumeCommand(conversation.id), true, dataDir, 220);
  console.log(`Restored Codex conversation ${conversation.id} in ${session.name}`);
}

async function persistCodexResumeState(
  store: SessionStore,
  session: TerminalSession,
  status: ReturnType<typeof resolveCodexStatus>
) {
  if (status.state !== "stopped" && status.conversationId) {
    const conversation = findCodexConversation(session.cwd, status.conversationId);
    if (!conversation) {
      if (session.codexConversationId || session.codexAutoResume) {
        await store.update(session.id, { codexConversationId: undefined, codexAutoResume: false });
      }
      return;
    }
    observedCodexSessions.add(session.id);
    if (session.codexConversationId !== status.conversationId || !session.codexAutoResume) {
      await store.update(session.id, {
        codexConversationId: status.conversationId,
        codexAutoResume: true
      });
    }
    return;
  }
  if (
    status.state !== "stopped" &&
    !status.conversationId &&
    (session.codexConversationId || session.codexAutoResume)
  ) {
    await store.update(session.id, { codexConversationId: undefined, codexAutoResume: false });
    return;
  }
  if (status.state === "stopped" && session.codexAutoResume && observedCodexSessions.has(session.id)) {
    observedCodexSessions.delete(session.id);
    await store.update(session.id, { codexAutoResume: false });
  }
}

function isCodexRuntimeCommand(value: string): boolean {
  return /(?:^|[\\/\s])codex(?:\.js|\.exe)?(?:\s|$)/i.test(value) || /@openai[\\/]codex/i.test(value);
}

function reservedCodexConversationIds(sessions: TerminalSession[], currentSessionId: string): string[] {
  return sessions.flatMap((session) =>
    session.id !== currentSessionId && session.codexConversationId ? [session.codexConversationId] : []
  );
}

async function disableDuplicateCodexResumeAssignments(
  store: SessionStore,
  sessions: TerminalSession[]
): Promise<void> {
  const owners = new Set<string>();
  for (const session of [...sessions].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    const conversationId = session.codexConversationId;
    if (!session.codexAutoResume || !conversationId) {
      continue;
    }
    if (!owners.has(conversationId)) {
      owners.add(conversationId);
      continue;
    }
    session.codexConversationId = undefined;
    session.codexAutoResume = false;
    await store.update(session.id, { codexConversationId: undefined, codexAutoResume: false });
  }
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
        preserveViewport: true
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
  submitDelayMs = 160
) {
  const backend = await resolveBackend(session);
  if (backend === "tmux") {
    await sendTmuxInput(session, data, enter, submitDelayMs);
    return;
  }
  if (backend === "zellij") {
    await sendZellijInput(session, data, enter, submitDelayMs);
    return;
  }
  await nativeSessions.write(session, data, enter, dataDir, submitDelayMs);
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

function parseSubmitDelayMs(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(120, Math.min(12_000, Math.floor(parsed)));
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

function backgroundImageExtension(contentType: string | string[] | undefined): string | null {
  const normalized = Array.isArray(contentType) ? contentType[0] : contentType?.split(";")[0].trim().toLowerCase();
  if (normalized === "image/png") {
    return "png";
  }
  if (normalized === "image/jpeg") {
    return "jpg";
  }
  if (normalized === "image/webp") {
    return "webp";
  }
  if (normalized === "image/gif") {
    return "gif";
  }
  if (normalized === "image/avif") {
    return "avif";
  }
  return null;
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
