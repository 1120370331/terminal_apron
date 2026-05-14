import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthMethod } from "../shared/types.js";
import type { TerminalBackend } from "../shared/types.js";

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

const explicitAuthModes = splitModes(process.env.TWM_AUTH_MODE);
const inferredAuthModes: AuthMethod[] = process.env.TWM_ADMIN_PASSWORD
  ? ["password"]
  : fs.existsSync(authorizedKeysFile)
    ? ["ssh"]
    : ["none"];

export const config = {
  host: process.env.TWM_HOST ?? process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.TWM_PORT ?? process.env.PORT ?? 3131),
  dataDir,
  tmuxBin: process.env.TWM_TMUX_BIN ?? "tmux",
  zellijBin,
  sessionBackend: parseBackend(process.env.TWM_SESSION_BACKEND),
  adminUser: process.env.TWM_ADMIN_USER ?? "admin",
  adminPassword: process.env.TWM_ADMIN_PASSWORD ?? "",
  authModes: explicitAuthModes ?? inferredAuthModes,
  authorizedKeysFile,
  cookieSecure: process.env.TWM_COOKIE_SECURE === "true",
  sshNamespace: "terminal-web-monitor",
  nativeHistoryBytes: parseBoundedInteger(process.env.TWM_NATIVE_HISTORY_BYTES, 8_000_000, 240_000, 50_000_000),
  nativeScreenScrollback: parseBoundedInteger(process.env.TWM_NATIVE_SCREEN_SCROLLBACK, 50_000, 1_000, 200_000),
  previewMaxLines: parseBoundedInteger(process.env.TWM_PREVIEW_MAX_LINES, 5_000, 100, 20_000),
  tmuxHistoryLimit: parseBoundedInteger(process.env.TWM_TMUX_HISTORY_LIMIT, 50_000, 1_000, 200_000),
  zellijScrollback: parseBoundedInteger(process.env.TWM_ZELLIJ_SCROLLBACK, 50_000, 1_000, 200_000)
};

function parseBackend(value: string | undefined): TerminalBackend {
  if (value === "native" || value === "tmux" || value === "zellij" || value === "auto") {
    return value;
  }
  return "auto";
}

function resolveBinaryPath(value: string): string {
  const expanded = expandHome(value.trim() || "zellij");
  if (path.isAbsolute(expanded) || expanded.startsWith(".") || expanded.includes("/") || expanded.includes("\\")) {
    return path.resolve(expanded);
  }
  return expanded;
}
