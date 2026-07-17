import fs from "node:fs";
import path from "node:path";
import { io, type Socket } from "socket.io-client";
import type { SessionPreview, TerminalSession } from "../src/shared/types.js";
import { codexResumeCommand } from "../src/server/codex.js";

const projectRoot = path.resolve(import.meta.dirname, "..");
loadEnv(path.join(projectRoot, ".env"));

const baseUrl = process.env.TWM_VERIFY_URL || "http://localhost:3131";
const username = process.env.TWM_ADMIN_USER || "admin";
const password = process.env.TWM_ADMIN_PASSWORD || "";

const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password })
});
assert(loginResponse.ok, `login failed: ${loginResponse.status}`);
const cookie = loginResponse.headers.get("set-cookie")?.split(";", 1)[0];
assert(cookie, "login did not return an auth cookie");

const sessions = await api<TerminalSession[]>("/api/sessions", cookie);
const liveSessions = sessions.filter((session) => session.runtime?.exists);
assert(liveSessions.length > 0, "no live terminal session is available for rendering verification");

const previewResults = [];
for (const session of liveSessions) {
  const preview = await api<SessionPreview>(
    `/api/sessions/${session.id}/preview?lines=500&maxChars=500000&full=true`,
    cookie
  );
  const rows = preview.grid?.rows ?? [];
  assert(rows.length > 0, `${session.name}: preview grid is empty`);
  const texts = rows.map((row) => row.segments.map((segment) => segment.text).join(""));
  assert(texts.at(-1)?.trim(), `${session.name}: preview still has trailing blank rows`);

  const composerRow = texts.findLastIndex((line) => /(?:^|\s)›(?:\s|$)/u.test(line));
  if (
    /\bcodex(?:\.exe)?\b/i.test(session.runtime?.currentCommand || "") &&
    session.codexStatus?.conversationId &&
    composerRow >= 0
  ) {
    assert(rows.length >= 20, `${session.name}: Codex history collapsed to only ${rows.length} rows`);
    assert(
      texts.length - 1 - composerRow <= 4,
      `${session.name}: Codex composer is ${texts.length - 1 - composerRow} rows above the viewport end`
    );
  }
  previewResults.push({
    session: session.name,
    rows: rows.length,
    composerRow,
    lastRow: texts.at(-1)?.trim()
  });
}

const target = liveSessions[0];
const desktop = await connectTerminal(target.id, cookie, "desktop", 180, 48);
const desktopSize = await waitForSize(desktop);
assert(desktopSize.cols >= 180 && desktopSize.rows >= 48, "desktop terminal did not adopt the requested large viewport");

const mobile = await connectTerminal(target.id, cookie, "mobile", 60, 20);
const mobileSize = await waitForSize(mobile);
assert(
  mobileSize.cols === desktopSize.cols && mobileSize.rows === desktopSize.rows,
  "mobile attachment changed the shared desktop terminal dimensions"
);

mobile.disconnect();
await delay(150);
desktop.disconnect();

const resumeCommand = codexResumeCommand("019f6897-1861-72e1-b6a3-6a6eb5eece07");
assert(resumeCommand.includes("--no-alt-screen"), "Codex resume command must preserve inline terminal scrollback");

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      previewResults,
      sharedTerminalSize: desktopSize,
      resumeCommand
    },
    null,
    2
  )
);

async function api<T>(pathname: string, cookieHeader: string): Promise<T> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: { Cookie: cookieHeader }
  });
  assert(response.ok, `${pathname} failed: ${response.status}`);
  return (await response.json()) as T;
}

async function connectTerminal(
  sessionId: string,
  cookieHeader: string,
  clientProfile: "desktop" | "mobile",
  cols: number,
  rows: number
): Promise<Socket> {
  const socket = io(baseUrl, {
    transports: ["websocket"],
    extraHeaders: { Cookie: cookieHeader },
    query: { sessionId, clientProfile, cols, rows }
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${clientProfile} terminal connection timed out`)), 15_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return socket;
}

function waitForSize(socket: Socket): Promise<{ cols: number; rows: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("terminal resize acknowledgement timed out")), 15_000);
    socket.once("terminal:resized", (size: { cols?: number; rows?: number }) => {
      clearTimeout(timeout);
      resolve({ cols: Number(size.cols), rows: Number(size.rows) });
    });
  });
}

function loadEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) {
    return;
  }
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const separator = line.indexOf("=");
    const name = line.slice(0, separator).trim();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^(['"])(.*)\1$/, "$2");
    process.env[name] ??= value;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
