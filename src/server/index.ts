import express from "express";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server as SocketServer } from "socket.io";
import { config } from "./config.js";
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
  tmuxHealth
} from "./tmux.js";
import { registerTerminalSockets } from "./terminalSocket.js";
import { nodePtyHealth } from "./pty.js";
import { backendHealth, resolveBackend } from "./backend.js";
import { NativeSessionManager } from "./nativeSessions.js";
import type { CreateSessionInput, TerminalSession, UpdateSessionInput } from "../shared/types.js";

const app = express();
const server = http.createServer(app);
const io = new SocketServer(server, {
  cors: {
    origin: true,
    credentials: true
  }
});
const store = new SessionStore(config.dataDir);
const nativeSessions = new NativeSessionManager();

app.use(express.json({ limit: "1mb" }));

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
  const [tmux, nodePty, backend] = await Promise.all([tmuxHealth(), nodePtyHealth(), backendHealth()]);
  res.json({
    ok: nodePty.available && Boolean(backend.default),
    auth: authConfig(),
    backend,
    tmux,
    nodePty,
    dataDir: config.dataDir
  });
});

app.use("/api", requireAuth);

app.get("/api/sessions", async (req, res) => {
  const includeArchived = req.query.archived === "true";
  const sessions = await store.all();
  const visible = includeArchived ? sessions : sessions.filter((session) => !session.archived);
  const enriched = await Promise.all(
    visible.map(async (session) => ({
      ...session,
      runtime: await getRuntime(session).catch(() => ({
        exists: false,
        backend: "native",
        persistent: false,
        attached: 0,
        currentPath: session.cwd,
        currentCommand: "",
        windows: 0,
        lastAttached: null
      }))
    }))
  );
  res.json(enriched);
});

app.post("/api/sessions", async (req, res) => {
  const session = await store.create(req.body as CreateSessionInput);
  await ensureSession(session);
  res.status(201).json({
    ...session,
    runtime: await getRuntime(session)
  });
});

app.post("/api/sessions/:id/duplicate", async (req, res) => {
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
    runtime: await getRuntime(copied)
  });
});

app.patch("/api/sessions/:id", async (req, res) => {
  const updated = await store.update(req.params.id, req.body as UpdateSessionInput);
  if (!updated) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  res.json({
    ...updated,
    runtime: await getRuntime(updated).catch(() => undefined)
  });
});

app.post("/api/sessions/:id/ensure", async (req, res) => {
  const session = await store.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  await ensureSession(session);
  res.json({
    ...session,
    runtime: await getRuntime(session)
  });
});

app.post("/api/sessions/:id/archive", async (req, res) => {
  const updated = await store.update(req.params.id, { archived: true });
  if (!updated) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  res.json(updated);
});

app.post("/api/sessions/:id/restore", async (req, res) => {
  const updated = await store.update(req.params.id, { archived: false });
  if (!updated) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  await ensureSession(updated);
  res.json({
    ...updated,
    runtime: await getRuntime(updated)
  });
});

app.post("/api/sessions/:id/kill", async (req, res) => {
  const session = await store.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  await killSession(session);
  const stopped = await store.markStopped(session.id);
  res.json(stopped);
});

app.get("/api/sessions/:id/preview", async (req, res) => {
  const session = await store.get(req.params.id);
  if (!session) {
    res.status(404).json({ error: "session not found" });
    return;
  }
  res.json({
    sessionId: session.id,
    text: await captureSessionPreview(session).catch(() => ""),
    capturedAt: new Date().toISOString()
  });
});

registerTerminalSockets(io, store, nativeSessions);

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

await store.init();
server.listen(config.port, config.host, () => {
  console.log(`terminal-web-monitor listening on http://${config.host}:${config.port}`);
  console.log(`data dir: ${config.dataDir}`);
  console.log(`auth modes: ${authConfig().methods.join(", ")}`);
});

async function ensureSession(session: TerminalSession) {
  const backend = await resolveBackend(session);
  if (backend === "tmux") {
    await ensureTmuxSession(session);
    return;
  }
  await nativeSessions.ensure(session);
}

async function getRuntime(session: TerminalSession) {
  const backend = await resolveBackend(session);
  return backend === "tmux" ? runtimeInfo(session) : nativeSessions.runtime(session);
}

async function captureSessionPreview(session: TerminalSession) {
  const backend = await resolveBackend(session);
  return backend === "tmux" ? capturePreview(session) : nativeSessions.preview(session);
}

async function killSession(session: TerminalSession) {
  const backend = await resolveBackend(session);
  if (backend === "tmux") {
    await killTmuxSession(session);
    return;
  }
  await nativeSessions.kill(session);
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
