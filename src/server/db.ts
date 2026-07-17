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

function normalizeCodexConversationId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed || "")
    ? trimmed
    : undefined;
}

export class SessionStore {
  private readonly dbPath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

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
    return (await this.read()).preferences ?? { terminalBackgroundImage: null };
  }

  async updatePreferences(patch: Partial<UserPreferences>): Promise<UserPreferences> {
    return this.mutate(async () => {
      const db = await this.read();
      const current = db.preferences ?? { terminalBackgroundImage: null };
      const preferences: UserPreferences = {
        terminalBackgroundImage:
          "terminalBackgroundImage" in patch
            ? normalizeBackgroundImage(patch.terminalBackgroundImage ?? undefined) ?? null
            : current.terminalBackgroundImage
      };
      db.preferences = preferences;
      await this.write(db);
      return preferences;
    });
  }

  async create(input: CreateSessionInput): Promise<TerminalSession> {
    return this.mutate(async () => {
      const db = await this.read();
      const id = randomUUID();
      const timestamp = now();
      const index = db.sessions.length;
      const session: TerminalSession = {
        id,
        name: sanitizeName(input.name, `terminal-${index + 1}`),
        group: sanitizeName(input.group ?? "default", "default"),
        tags: normalizeTags(input.tags),
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
      await this.write(db);
      return session;
    });
  }

  async update(id: string, patch: UpdateSessionInput): Promise<TerminalSession | null> {
    return this.mutate(async () => {
      const db = await this.read();
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
        ...("cwd" in patch ? { cwd: patch.cwd?.trim() || existing.cwd } : {}),
        ...("shell" in patch ? { shell: patch.shell?.trim() || undefined } : {}),
        ...("backend" in patch ? { backend: normalizeBackend(patch.backend) } : {}),
        ...("color" in patch ? { color: patch.color?.trim() || existing.color } : {}),
        ...("backgroundMode" in patch ? { backgroundMode: normalizeBackgroundMode(patch.backgroundMode) } : {}),
        ...("backgroundImage" in patch ? { backgroundImage: normalizeBackgroundImage(patch.backgroundImage) } : {}),
        ...("codexConversationId" in patch
          ? { codexConversationId: normalizeCodexConversationId(patch.codexConversationId) }
          : {}),
        ...("codexAutoResume" in patch
          ? {
              codexAutoResume: Boolean(
                patch.codexAutoResume &&
                  normalizeCodexConversationId(patch.codexConversationId ?? existing.codexConversationId)
              )
            }
          : {}),
        ...("layout" in patch ? { layout: normalizeLayout(patch.layout, existing.layout) } : {}),
        ...("archived" in patch
          ? { archived: Boolean(patch.archived), archivedAt: patch.archived ? now() : undefined }
          : {}),
        updatedAt: now()
      };

      db.sessions[index] = updated;
      await this.write(db);
      return updated;
    });
  }

  async markStopped(id: string): Promise<TerminalSession | null> {
    return this.mutate(async () => {
      const db = await this.read();
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
      await this.write(db);
      return db.sessions[index];
    });
  }

  private async read(): Promise<StoreShape> {
    await this.initDirectoryOnly();
    const raw = (await fs.readFile(this.dbPath, "utf8")).replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as StoreShape;
    return {
      version: 1,
      preferences: {
        terminalBackgroundImage: normalizeBackgroundImage(parsed.preferences?.terminalBackgroundImage ?? undefined) ?? null
      },
      sessions: Array.isArray(parsed.sessions)
        ? parsed.sessions.map((session) => ({
            ...session,
            backend: normalizeBackend(session.backend),
            backgroundMode: normalizeBackgroundMode(session.backgroundMode),
            backgroundImage: normalizeBackgroundImage(session.backgroundImage),
            codexConversationId: normalizeCodexConversationId(session.codexConversationId),
            codexAutoResume: Boolean(
              session.codexAutoResume && normalizeCodexConversationId(session.codexConversationId)
            )
          }))
        : []
    };
  }

  private async write(db: StoreShape): Promise<void> {
    await this.initDirectoryOnly();
    const tmp = `${this.dbPath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(db, null, 2)}\n`, "utf8");
    await fs.rename(tmp, this.dbPath);
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async initDirectoryOnly(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
  }
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
    minH: Math.max(2, Number(layout.minH) || 3)
  };
}
