import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AuthUser } from "../shared/types.js";
import { AUTH_TOKEN_TTL_MS, createToken, taskMonitorCookieHeader } from "./auth.js";
import { config } from "./config.js";
import { taskContextRoot } from "./tasks/taskContextWorkspace.js";

export const TASK_MONITOR_CREDENTIAL_FILE_NAME = ".task-monitor-credential.json";
const REFRESH_BEFORE_EXPIRY_MS = 24 * 60 * 60 * 1000;

export interface TaskMonitorCliCredential {
  version: 1;
  url: string;
  user: string;
  cookie: string;
  expiresAt: string;
}

interface TaskMonitorCliCredentialOptions {
  credentialFactory?: (user: AuthUser) => Promise<TaskMonitorCliCredential>;
}

const cachedCredentials = new Map<string, TaskMonitorCliCredential>();
const credentialJobs = new Map<string, Promise<TaskMonitorCliCredential>>();

export function taskMonitorCredentialPath(dataDir: string): string {
  return path.resolve(dataDir, ".terminal-apron", TASK_MONITOR_CREDENTIAL_FILE_NAME);
}

export async function ensureTaskMonitorCliCredential(
  user: AuthUser,
  dataDir: string,
  contextDirectory?: string,
  options: TaskMonitorCliCredentialOptions = {}
): Promise<string> {
  const resolvedDataDir = path.resolve(dataDir);
  const cacheKey = `${resolvedDataDir}\u001f${user.name}`;
  let credential = cachedCredentials.get(cacheKey);
  if (!isFreshCredential(credential, user.name)) {
    let job = credentialJobs.get(cacheKey);
    if (!job) {
      job = (options.credentialFactory ?? createCredential)(user).finally(() => credentialJobs.delete(cacheKey));
      credentialJobs.set(cacheKey, job);
    }
    credential = await job;
    cachedCredentials.set(cacheKey, credential);
  }

  const globalPath = taskMonitorCredentialPath(resolvedDataDir);
  await writeCredentialFile(globalPath, credential);
  if (contextDirectory) {
    const taskDirectory = validatedTaskContextDirectory(resolvedDataDir, contextDirectory);
    await writeCredentialFile(path.join(taskDirectory, TASK_MONITOR_CREDENTIAL_FILE_NAME), credential);
  }
  return globalPath;
}

export async function writeTaskMonitorCliCredential(
  filePath: string,
  credential: TaskMonitorCliCredential
): Promise<void> {
  validateCredential(credential);
  await writeCredentialFile(path.resolve(filePath), credential);
}

async function createCredential(user: AuthUser): Promise<TaskMonitorCliCredential> {
  const createdAt = Date.now();
  return {
    version: 1,
    url: `http://127.0.0.1:${config.port}`,
    user: user.name,
    cookie: taskMonitorCookieHeader(await createToken(user)),
    expiresAt: new Date(createdAt + AUTH_TOKEN_TTL_MS).toISOString()
  };
}

function isFreshCredential(
  credential: TaskMonitorCliCredential | undefined,
  userName: string
): credential is TaskMonitorCliCredential {
  return Boolean(
    credential &&
      credential.user === userName &&
      Date.parse(credential.expiresAt) > Date.now() + REFRESH_BEFORE_EXPIRY_MS
  );
}

function validatedTaskContextDirectory(dataDir: string, contextDirectory: string): string {
  const root = taskContextRoot(dataDir);
  const candidate = path.resolve(contextDirectory);
  const relative = path.relative(root, candidate);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    return candidate;
  }
  throw new Error("TaskMonitor credential target is outside the task context root");
}

function validateCredential(credential: TaskMonitorCliCredential): void {
  const parsedUrl = new URL(credential.url);
  if (
    credential.version !== 1 ||
    !credential.user.trim() ||
    !/^twm_token=[A-Za-z0-9._~%+-]+$/.test(credential.cookie) ||
    !Number.isFinite(Date.parse(credential.expiresAt)) ||
    parsedUrl.protocol !== "http:" ||
    parsedUrl.hostname !== "127.0.0.1"
  ) {
    throw new Error("Invalid TaskMonitor CLI credential");
  }
}

async function writeCredentialFile(filePath: string, credential: TaskMonitorCliCredential): Promise<void> {
  validateCredential(credential);
  const content = `${JSON.stringify(credential)}\n`;
  const existing = await fs.promises.readFile(filePath, "utf8").catch(() => "");
  if (existing === content) {
    await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
    return;
  }

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.promises.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    if (!(["EEXIST", "EPERM"] as Array<string | undefined>).includes((error as NodeJS.ErrnoException).code)) {
      throw error;
    }
    await fs.promises.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
    await fs.promises.rm(temporaryPath, { force: true });
  }
  await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
}
