import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { NextFunction, Request, Response } from "express";
import type { AuthConfig, AuthUser } from "../shared/types.js";
import { config, configuredUser } from "./config.js";

interface Challenge {
  id: string;
  username: string;
  value: string;
  expiresAt: number;
}

const TOKEN_COOKIE = "twm_token";
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const challenges = new Map<string, Challenge>();

function secretPath(): string {
  return path.join(config.dataDir, "server-secret");
}

async function getSecret(): Promise<string> {
  await fsp.mkdir(config.dataDir, { recursive: true });
  try {
    return (await fsp.readFile(secretPath(), "utf8")).trim();
  } catch {
    const secret = crypto.randomBytes(48).toString("base64url");
    await fsp.writeFile(secretPath(), `${secret}\n`, { mode: 0o600 });
    return secret;
  }
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }
  return Object.fromEntries(
    header.split(";").map((part) => {
      const [key, ...rest] = part.trim().split("=");
      return [decodeURIComponent(key), decodeURIComponent(rest.join("="))];
    })
  );
}

export async function createToken(user: AuthUser): Promise<string> {
  const secret = await getSecret();
  const payload = base64url(
    JSON.stringify({
      user,
      exp: Date.now() + TOKEN_TTL_MS
    })
  );
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export async function verifyToken(token: string | undefined): Promise<AuthUser | null> {
  if (!token) {
    return null;
  }

  const [payload, signature] = token.split(".");
  if (!payload || !signature) {
    return null;
  }

  const secret = await getSecret();
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (
    expected.length !== signature.length ||
    !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      user: AuthUser;
      exp: number;
    };
    if (!decoded.exp || decoded.exp < Date.now()) {
      return null;
    }
    return decoded.user;
  } catch {
    return null;
  }
}

export async function userFromCookie(header: string | undefined): Promise<AuthUser | null> {
  if (authConfig().methods.includes("none")) {
    return { name: "local", method: "none" };
  }
  const cookies = parseCookies(header);
  return verifyToken(cookies[TOKEN_COOKIE]);
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await userFromCookie(req.headers.cookie);
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.locals.user = user;
  next();
}

export function authConfig(): AuthConfig {
  const methods = config.authModes.filter((method) => {
    if (method === "password") {
      return config.users.some((user) => Boolean(user.password));
    }
    if (method === "ssh") {
      return config.users.some((user) => user.publicKeys.length > 0 || Boolean(user.authorizedKeysFile && fs.existsSync(user.authorizedKeysFile)));
    }
    return true;
  });

  return {
    methods: methods.length ? methods : ["none"],
    user: config.users.length === 1 ? config.users[0].name : config.adminUser
  };
}

export function setAuthCookie(res: Response, token: string): void {
  const parts = [
    `${TOKEN_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${TOKEN_TTL_MS / 1000}`
  ];
  if (config.cookieSecure) {
    parts.push("Secure");
  }
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearAuthCookie(res: Response): void {
  res.setHeader("Set-Cookie", `${TOKEN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

export async function verifyPassword(username: string, password: string): Promise<AuthUser | null> {
  if (!authConfig().methods.includes("password")) {
    return null;
  }
  const user = configuredUser(username);
  if (!user?.password || !constantTimeStringEqual(password, user.password)) {
    return null;
  }
  return { name: user.name, method: "password" };
}

export function createSshChallenge(username: string): Challenge {
  const normalizedUser = username.trim() || config.adminUser;
  const challenge: Challenge = {
    id: randomUUID(),
    username: normalizedUser,
    value: `${config.sshNamespace}:${normalizedUser}:${randomUUID()}:${Date.now()}`,
    expiresAt: Date.now() + 1000 * 60 * 5
  };
  challenges.set(challenge.id, challenge);
  return challenge;
}

export async function verifySshLogin(input: {
  challengeId: string;
  username: string;
  publicKey: string;
  signature: string;
}): Promise<AuthUser | null> {
  if (!authConfig().methods.includes("ssh")) {
    return null;
  }

  const challenge = challenges.get(input.challengeId);
  if (!challenge || challenge.expiresAt < Date.now()) {
    return null;
  }

  const username = input.username.trim() || config.adminUser;
  if (username !== challenge.username) {
    return null;
  }
  const user = configuredUser(username);
  if (!user) {
    return null;
  }

  const publicKey = normalizePublicKey(input.publicKey);
  if (!publicKey || !(await authorizedKeyExists(user, publicKey))) {
    return null;
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "twm-ssh-"));
  try {
    const allowedSignersPath = path.join(tempDir, "allowed_signers");
    const signaturePath = path.join(tempDir, "signature.sig");
    await fsp.writeFile(allowedSignersPath, `${username} ${publicKey}\n`, "utf8");
    await fsp.writeFile(signaturePath, decodeSignature(input.signature));
    await runSshKeygenVerify(
      ["-Y", "verify", "-f", allowedSignersPath, "-I", username, "-n", config.sshNamespace, "-s", signaturePath],
      challenge.value
    );
    challenges.delete(input.challengeId);
    return { name: user.name, method: "ssh" };
  } catch {
    return null;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

function normalizePublicKey(value: string): string | null {
  const keyTypes = new Set([
    "ssh-ed25519",
    "ssh-rsa",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
    "sk-ecdsa-sha2-nistp256@openssh.com"
  ]);
  const parts = value.trim().split(/\s+/);
  const index = parts.findIndex((part) => keyTypes.has(part));
  if (index === -1 || !parts[index + 1]) {
    return null;
  }
  return `${parts[index]} ${parts[index + 1]}`;
}

async function authorizedKeyExists(
  user: { publicKeys: string[]; authorizedKeysFile?: string },
  publicKey: string
): Promise<boolean> {
  const configuredKeys = user.publicKeys.some((line) => normalizePublicKey(line) === publicKey);
  if (configuredKeys) {
    return true;
  }
  if (!user.authorizedKeysFile) {
    return false;
  }
  const raw = await fsp.readFile(user.authorizedKeysFile, "utf8").catch(() => "");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .some((line) => normalizePublicKey(line) === publicKey);
}

function constantTimeStringEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function decodeSignature(value: string): Buffer | string {
  const trimmed = value.trim();
  if (trimmed.includes("BEGIN SSH SIGNATURE")) {
    return `${trimmed}\n`;
  }
  return Buffer.from(trimmed.replace(/\s+/g, ""), "base64");
}

function runSshKeygenVerify(args: string[], stdin: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh-keygen", args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `ssh-keygen exited with ${code}`));
    });
    child.stdin.end(stdin);
  });
}
