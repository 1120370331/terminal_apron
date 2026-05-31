import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthMethod } from "../shared/types.js";
import type { TerminalBackend } from "../shared/types.js";

export interface ConfigUser {
  name: string;
  password?: string;
  authorizedKeysFile?: string;
  publicKeys: string[];
  dataDir: string;
  legacyRoot?: boolean;
}

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function splitModes(value: string | undefined): AuthMethod[] | null {
  if (!value) {
    return null;
  }

  const modes = value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const allowed = new Set<AuthMethod>(["none", "password", "ssh"]);
  const parsed = modes.filter((mode): mode is AuthMethod => allowed.has(mode as AuthMethod));
  return parsed.length ? Array.from(new Set(parsed)) : null;
}

function parseBoundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

const dataDir = path.resolve(process.env.TWM_DATA_DIR ?? path.join(process.cwd(), "data"));
const authorizedKeysFile = expandHome(
  process.env.TWM_AUTHORIZED_KEYS_FILE ?? path.join("~", ".ssh", "authorized_keys")
);
const zellijBin = resolveBinaryPath(process.env.TWM_ZELLIJ_BIN ?? "zellij");
const adminUser = sanitizeUserName(process.env.TWM_ADMIN_USER ?? "admin", "admin");
const configuredUsers = buildConfiguredUsers(dataDir, adminUser, authorizedKeysFile);

const explicitAuthModes = splitModes(process.env.TWM_AUTH_MODE);
const inferredAuthModes: AuthMethod[] = configuredUsers.some((user) => user.password)
  ? ["password"]
  : configuredUsers.some((user) => userHasSshKeys(user))
    ? ["ssh"]
    : ["none"];

export const config = {
  host: process.env.TWM_HOST ?? process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.TWM_PORT ?? process.env.PORT ?? 3131),
  dataDir,
  tmuxBin: process.env.TWM_TMUX_BIN ?? "tmux",
  zellijBin,
  sessionBackend: parseBackend(process.env.TWM_SESSION_BACKEND),
  adminUser,
  adminPassword: process.env.TWM_ADMIN_PASSWORD ?? "",
  users: configuredUsers,
  authModes: explicitAuthModes ?? inferredAuthModes,
  authorizedKeysFile,
  cookieSecure: process.env.TWM_COOKIE_SECURE === "true",
  sshNamespace: "terminal-web-monitor",
  nativeHistoryBytes: parseBoundedInteger(process.env.TWM_NATIVE_HISTORY_BYTES, 50_000_000, 1_000_000, 200_000_000),
  nativeScreenScrollback: parseBoundedInteger(process.env.TWM_NATIVE_SCREEN_SCROLLBACK, 50_000, 5_000, 200_000),
  terminalAttachHistoryLines: parseBoundedInteger(
    process.env.TWM_TERMINAL_ATTACH_HISTORY_LINES,
    5_000,
    5_000,
    200_000
  ),
  previewMaxLines: parseBoundedInteger(process.env.TWM_PREVIEW_MAX_LINES, 5_000, 100, 20_000),
  tmuxHistoryLimit: parseBoundedInteger(process.env.TWM_TMUX_HISTORY_LIMIT, 50_000, 5_000, 200_000),
  zellijScrollback: parseBoundedInteger(process.env.TWM_ZELLIJ_SCROLLBACK, 50_000, 5_000, 200_000)
};

export function configuredUser(name: string | undefined): ConfigUser | undefined {
  const normalized = name?.trim();
  if (!normalized) {
    return undefined;
  }
  return config.users.find((user) => user.name === normalized);
}

export function dataDirForUser(name: string): string {
  const user = configuredUser(name);
  if (user) {
    return user.dataDir;
  }
  if (name === "local") {
    return config.dataDir;
  }
  return path.join(config.dataDir, "users", safePathSegment(name));
}

function parseBackend(value: string | undefined): TerminalBackend {
  return value === "auto" ? "auto" : "zellij";
}

function resolveBinaryPath(value: string): string {
  const expanded = expandHome(value.trim() || "zellij");
  if (path.isAbsolute(expanded) || expanded.startsWith(".") || expanded.includes("/") || expanded.includes("\\")) {
    return path.resolve(expanded);
  }
  return expanded;
}

function buildConfiguredUsers(rootDataDir: string, legacyAdminUser: string, legacyAuthorizedKeysFile: string): ConfigUser[] {
  const users = new Map<string, ConfigUser>();
  const legacyAdmin = createConfigUser(
    {
      name: legacyAdminUser,
      password: process.env.TWM_ADMIN_PASSWORD,
      authorizedKeysFile: legacyAuthorizedKeysFile,
      legacyRoot: true
    },
    rootDataDir
  );
  if (legacyAdmin.password || legacyAdmin.authorizedKeysFile) {
    users.set(legacyAdmin.name, legacyAdmin);
  }

  for (const user of readUsersFromConfig(rootDataDir)) {
    const previous = users.get(user.name);
    users.set(user.name, mergeConfigUser(previous, user));
  }

  return Array.from(users.values());
}

function readUsersFromConfig(rootDataDir: string): ConfigUser[] {
  const raw = process.env.TWM_USERS_JSON ?? readOptionalFile(process.env.TWM_USERS_FILE);
  if (!raw?.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const items = normalizeUserConfigItems(parsed);
    return items
      .map((item) => createConfigUser(item, rootDataDir))
      .filter((user) => user.name && (user.password || user.authorizedKeysFile || user.publicKeys.length));
  } catch {
    return [];
  }
}

function readOptionalFile(filePath: string | undefined): string | undefined {
  if (!filePath?.trim()) {
    return undefined;
  }
  const resolved = path.resolve(expandHome(filePath.trim()));
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch {
    return undefined;
  }
}

function normalizeUserConfigItems(parsed: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(parsed)) {
    return parsed.filter((item): item is Record<string, unknown> => item !== null && typeof item === "object");
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { users?: unknown }).users)) {
    return normalizeUserConfigItems((parsed as { users: unknown }).users);
  }
  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed as Record<string, unknown>)
      .filter((entry): entry is [string, Record<string, unknown>] => entry[1] !== null && typeof entry[1] === "object")
      .map(([name, value]) => ({ ...value, name }));
  }
  return [];
}

function createConfigUser(input: Record<string, unknown>, rootDataDir: string): ConfigUser {
  const name = sanitizeUserName(String(input.name ?? ""), "user");
  const explicitDataDir = typeof input.dataDir === "string" && input.dataDir.trim() ? input.dataDir.trim() : "";
  const legacyRoot = Boolean(input.legacyRoot);
  const dataDirValue = explicitDataDir
    ? path.resolve(expandHome(explicitDataDir))
    : legacyRoot
      ? rootDataDir
      : path.join(rootDataDir, "users", safePathSegment(name));
  return {
    name,
    password: typeof input.password === "string" && input.password.length ? input.password : undefined,
    authorizedKeysFile:
      typeof input.authorizedKeysFile === "string" && input.authorizedKeysFile.trim()
        ? path.resolve(expandHome(input.authorizedKeysFile.trim()))
        : undefined,
    publicKeys: normalizePublicKeys(input.publicKeys),
    dataDir: dataDirValue,
    legacyRoot
  };
}

function mergeConfigUser(previous: ConfigUser | undefined, next: ConfigUser): ConfigUser {
  if (!previous) {
    return next;
  }
  return {
    ...previous,
    ...next,
    dataDir: next.dataDir || previous.dataDir,
    legacyRoot: previous.legacyRoot || next.legacyRoot,
    publicKeys: Array.from(new Set([...previous.publicKeys, ...next.publicKeys]))
  };
}

function normalizePublicKeys(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function userHasSshKeys(user: ConfigUser): boolean {
  return user.publicKeys.length > 0 || Boolean(user.authorizedKeysFile && fs.existsSync(user.authorizedKeysFile));
}

function sanitizeUserName(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.slice(0, 80);
}

function safePathSegment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "user";
}
