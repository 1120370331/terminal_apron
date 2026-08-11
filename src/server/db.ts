import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";
import type {
  CreateSessionInput,
  GridItemLayout,
  TerminalBackgroundMode,
  TerminalBackend,
  TerminalSession,
  UpdateSessionInput,
  UserPreferences
} from "../shared/types.js";

interface StoreShape {
  version: 1;
  sessions: TerminalSession[];
  preferences?: UserPreferences;
}

const DEFAULT_COLORS = ["#2f80ed", "#00a676", "#f2994a", "#9b51e0", "#eb5757", "#00897b"];
const DEFAULT_TERMINAL_PROXY_URL = "http://127.0.0.1:7890";

function now(): string {
  return new Date().toISOString();
}

function normalizeTags(tags: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (tags ?? [])
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 12)
    )
  );
}

function normalizeTaskId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : undefined;
}

function normalizeTaskKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  return /^TA-[1-9][0-9]{0,8}$/.test(normalized) ? normalized : undefined;
}

function sanitizeName(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length ? trimmed.slice(0, 80) : fallback;
}

function tmuxNameFromId(id: string): string {
  return `twm_${id.replace(/-/g, "").slice(0, 16)}`;
}

function normalizeBackend(value: TerminalBackend | undefined): TerminalBackend {
  return "zellij";
}

function normalizeBackgroundMode(value: TerminalBackgroundMode | undefined): TerminalBackgroundMode {
  return value === "none" || value === "image" ? value : "inherit";
}

function normalizeBackgroundImage(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.startsWith("/api/backgrounds/") ? trimmed : undefined;
}

function normalizeTerminalProxyUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    return DEFAULT_TERMINAL_PROXY_URL;
  }
  try {
    const parsed = new URL(value.trim());
    if (!["http:", "https:", "socks:", "socks5:"].includes(parsed.protocol) || !parsed.hostname) {
      return DEFAULT_TERMINAL_PROXY_URL;
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_TERMINAL_PROXY_URL;
  }
}

function defaultPreferences(): UserPreferences {
  return {
    terminalBackgroundImage: null,
    terminalProxyEnabled: false,
    terminalProxyUrl: DEFAULT_TERMINAL_PROXY_URL
  };
}

export class SessionStore {
  private readonly dbPath: string;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(readonly dataDir: string) {
    this.dbPath = path.join(dataDir, "sessions.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    try {
      await fs.access(this.dbPath);
    } catch {
      await this.write({ version: 1, sessions: [] });
    }
  }

  async all(): Promise<TerminalSession[]> {
    return (await this.read()).sessions;
  }

  async get(id: string): Promise<TerminalSession | null> {
    return (await this.read()).sessions.find((session) => session.id === id) ?? null;
  }

  async preferences(): Promise<UserPreferences> {
    return (await this.read()).preferences ?? defaultPreferences();
  }

  async updatePreferences(patch: Partial<UserPreferences>): Promise<UserPreferences> {
    return this.mutate((db) => {
      const current = db.preferences ?? defaultPreferences();
      const preferences: UserPreferences = {
        terminalBackgroundImage:
          "terminalBackgroundImage" in patch
            ? normalizeBackgroundImage(patch.terminalBackgroundImage ?? undefined) ?? null
            : current.terminalBackgroundImage,
        terminalProxyEnabled:
          "terminalProxyEnabled" in patch ? Boolean(patch.terminalProxyEnabled) : current.terminalProxyEnabled,
        terminalProxyUrl:
          "terminalProxyUrl" in patch
            ? normalizeTerminalProxyUrl(patch.terminalProxyUrl)
            : current.terminalProxyUrl
      };
      db.preferences = preferences;
      return preferences;
    });
  }

  async create(input: CreateSessionInput): Promise<TerminalSession> {
    return this.mutate(async (db) => {
      const id = randomUUID();
      const timestamp = now();
      const index = db.sessions.length;
      const session: TerminalSession = {
        id,
        name: sanitizeName(input.name, `terminal-${index + 1}`),
        group: sanitizeName(input.group ?? "default", "default"),
        tags: normalizeTags(input.tags),
        taskId: normalizeTaskId(input.taskId),
        taskKey: normalizeTaskKey(input.taskKey),
        cwd: input.cwd?.trim() || os.homedir(),
        shell: input.shell?.trim() || undefined,
        backend: normalizeBackend(input.backend),
        tmuxName: tmuxNameFromId(id),
        color: input.color?.trim() || DEFAULT_COLORS[index % DEFAULT_COLORS.length],
        backgroundMode: normalizeBackgroundMode(input.backgroundMode),
        backgroundImage: normalizeBackgroundImage(input.backgroundImage),
        archived: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        layout: {
          x: (index % 3) * 4,
          y: Math.floor(index / 3) * 4,
          w: 4,
          h: 4,
          minW: 3,
          minH: 3
        }
      };

      db.sessions.push(session);
      return session;
    });
  }

  async update(id: string, patch: UpdateSessionInput): Promise<TerminalSession | null> {
    return this.mutate(async (db) => {
      const index = db.sessions.findIndex((session) => session.id === id);
      if (index === -1) {
        return null;
      }

      const existing = db.sessions[index];
      const updated: TerminalSession = {
        ...existing,
        ...("name" in patch ? { name: sanitizeName(patch.name ?? existing.name, existing.name) } : {}),
        ...("group" in patch ? { group: sanitizeName(patch.group ?? existing.group, "default") } : {}),
        ...("tags" in patch ? { tags: normalizeTags(patch.tags) } : {}),
        ...("taskId" in patch ? { taskId: normalizeTaskId(patch.taskId) } : {}),
        ...("taskKey" in patch ? { taskKey: normalizeTaskKey(patch.taskKey) } : {}),
        ...("cwd" in patch ? { cwd: patch.cwd?.trim() || existing.cwd } : {}),
        ...("shell" in patch ? { shell: patch.shell?.trim() || undefined } : {}),
        ...("backend" in patch ? { backend: normalizeBackend(patch.backend) } : {}),
        ...("color" in patch ? { color: patch.color?.trim() || existing.color } : {}),
        ...("backgroundMode" in patch ? { backgroundMode: normalizeBackgroundMode(patch.backgroundMode) } : {}),
        ...("backgroundImage" in patch ? { backgroundImage: normalizeBackgroundImage(patch.backgroundImage) } : {}),
        ...("layout" in patch ? { layout: normalizeLayout(patch.layout, existing.layout) } : {}),
        ...("archived" in patch
          ? {
              archived: Boolean(patch.archived),
              archivedAt: patch.archived ? now() : undefined,
              stoppedAt: patch.archived ? existing.stoppedAt : undefined
            }
          : {}),
        updatedAt: now()
      };

      db.sessions[index] = updated;
      return updated;
    });
  }

  async markStopped(id: string): Promise<TerminalSession | null> {
    return this.mutate(async (db) => {
      const index = db.sessions.findIndex((session) => session.id === id);
      if (index === -1) {
        return null;
      }

      db.sessions[index] = {
        ...db.sessions[index],
        archived: true,
        stoppedAt: now(),
        archivedAt: now(),
        updatedAt: now()
      };
      return db.sessions[index];
    });
  }

  async updateCodexThread(id: string, threadId: string | null): Promise<TerminalSession | null> {
    return this.mutate((db) => {
      const index = db.sessions.findIndex((session) => session.id === id);
      if (index === -1) {
        return null;
      }
      const existing = db.sessions[index];
      if ((existing.codexThreadId ?? null) === threadId) {
        return existing;
      }
      const updated: TerminalSession = {
        ...existing,
        codexThreadId: threadId ?? undefined,
        codexThreadUpdatedAt: now()
      };
      db.sessions[index] = updated;
      return updated;
    });
  }

  private async read(): Promise<StoreShape> {
    await this.initDirectoryOnly();
    const raw = (await fs.readFile(this.dbPath, "utf8")).replace(/^\uFEFF/, "");
    try {
      return normalizeStoreShape(JSON.parse(raw) as StoreShape);
    } catch (error) {
      const recovered = parseRecoverableStore(raw);
      if (!recovered) {
        await this.backupCorruptDb(raw);
        const empty: StoreShape = { version: 1, sessions: [] };
        await this.write(empty);
        console.error(`Reset unreadable session store at ${this.dbPath}`, error);
        return empty;
      }

      await this.backupCorruptDb(raw);
      await this.write(recovered);
      console.error(`Recovered session store at ${this.dbPath}`, error);
      return recovered;
    }
  }

  private async mutate<T>(operation: (db: StoreShape) => Promise<T> | T): Promise<T> {
    const run = async () => {
      const db = await this.read();
      const result = await operation(db);
      await this.write(db);
      return result;
    };
    const queued = this.mutationQueue.then(run, run);
    this.mutationQueue = queued.catch(() => undefined);
    return queued;
  }

  private async write(db: StoreShape): Promise<void> {
    await this.initDirectoryOnly();
    const tmp = `${this.dbPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(db, null, 2)}\n`, "utf8");
    await fs.rename(tmp, this.dbPath);
  }

  private async backupCorruptDb(raw: string): Promise<void> {
    const backupPath = `${this.dbPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.writeFile(backupPath, raw, "utf8").catch(() => undefined);
  }

  private async initDirectoryOnly(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }
}

function normalizeStoreShape(parsed: StoreShape): StoreShape {
  return {
    version: 1,
    preferences: {
      terminalBackgroundImage: normalizeBackgroundImage(parsed.preferences?.terminalBackgroundImage ?? undefined) ?? null,
      terminalProxyEnabled: Boolean(parsed.preferences?.terminalProxyEnabled),
      terminalProxyUrl: normalizeTerminalProxyUrl(parsed.preferences?.terminalProxyUrl)
    },
    sessions: Array.isArray(parsed.sessions)
      ? parsed.sessions.map((session) => ({
          ...session,
          backend: normalizeBackend(session.backend),
          backgroundMode: normalizeBackgroundMode(session.backgroundMode),
          backgroundImage: normalizeBackgroundImage(session.backgroundImage),
          taskId: normalizeTaskId(session.taskId),
          taskKey: normalizeTaskKey(session.taskKey),
          codexThreadId: normalizeCodexThreadId(session.codexThreadId)
        }))
      : []
  };
}

function normalizeCodexThreadId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)
    ? normalized
    : undefined;
}

function parseRecoverableStore(raw: string): StoreShape | null {
  const prefix = firstJsonObjectPrefix(raw);
  if (!prefix || prefix === raw) {
    return null;
  }

  try {
    return normalizeStoreShape(JSON.parse(prefix) as StoreShape);
  } catch {
    return null;
  }
}

function firstJsonObjectPrefix(raw: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (!started) {
      if (/\s/.test(char)) {
        continue;
      }
      if (char !== "{") {
        return null;
      }
      started = true;
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char !== "}") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return raw.slice(0, index + 1);
    }
  }
  return null;
}

function normalizeLayout(
  layout: GridItemLayout | undefined,
  fallback: GridItemLayout | undefined
): GridItemLayout | undefined {
  if (!layout) {
    return fallback;
  }

  return {
    x: Math.max(0, Number(layout.x) || 0),
    y: Math.max(0, Number(layout.y) || 0),
    w: Math.max(2, Number(layout.w) || fallback?.w || 4),
    h: Math.max(2, Number(layout.h) || fallback?.h || 4),
    minW: Math.max(2, Number(layout.minW) || 3),
    minH: Math.max(2, Number(layout.minH) || 3),
    gridColumns: Math.max(1, Number(layout.gridColumns) || fallback?.gridColumns || 12)
  };
}
