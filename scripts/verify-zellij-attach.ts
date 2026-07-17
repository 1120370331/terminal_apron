import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import pty from "node-pty";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
loadEnv(path.join(projectRoot, ".env"));

const zellijBin = resolveBinary(process.env.TWM_ZELLIJ_BIN || "zellij");
const existingSession = process.argv[2]?.trim() || "";
const sessionName = existingSession || `twm_attach_check_${process.pid}_${Date.now()}`;
const durationMs = existingSession ? 20_000 : 12_000;
let term: ReturnType<typeof pty.spawn> | null = null;
let failure: unknown = null;

try {
  let reattach: ReturnType<typeof spawnClient>;
  if (existingSession) {
    reattach = spawnExistingClient();
  } else {
    const initial = spawnClient(true);
    term = initial.term;
    await delay(1_500);
    await execFileAsync(zellijBin, ["--session", sessionName, "action", "detach"], { timeout: 5_000 });
    await delay(500);
    reattach = spawnClient(false);
  }
  term = reattach.term;
  await delay(durationMs);
  const plainOutput = stripAnsi(reattach.output());
  assert(
    !/your zellij client lost connection to the zellij server/i.test(plainOutput),
    "Zellij detached its node-pty reattach client before the verification window ended"
  );
  assert(reattach.exitEvent() === null, `Zellij reattach client exited early: ${JSON.stringify(reattach.exitEvent())}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        zellijBin,
        version: (await execFileAsync(zellijBin, ["--version"])).stdout.trim(),
        sessionName,
        existingSession: Boolean(existingSession),
        durationMs,
        outputBytes: Buffer.byteLength(reattach.output())
      },
      null,
      2
    )
  );
} catch (error) {
  failure = error;
} finally {
  if (!existingSession) {
    await execFileAsync(zellijBin, ["kill-session", sessionName], { timeout: 5_000 }).catch(() => undefined);
    await execFileAsync(zellijBin, ["delete-session", sessionName], { timeout: 5_000 }).catch(() => undefined);
  }
  await delay(150);
  try {
    term?.kill();
  } catch {
    // Killing the test session normally closes the client first.
  }
}

if (failure) {
  console.error(failure instanceof Error ? failure.stack || failure.message : String(failure));
  process.exit(1);
}
process.exit(0);

function spawnClient(create: boolean): {
  term: ReturnType<typeof pty.spawn>;
  output: () => string;
  exitEvent: () => { exitCode: number; signal?: number } | null;
} {
  let output = "";
  let exitEvent: { exitCode: number; signal?: number } | null = null;
  const args = [
    "--layout-string",
    ["layout {", "    pane", "}"].join("\n"),
    "attach",
    ...(create ? ["--create"] : []),
    "--force-run-commands",
    sessionName,
    "options",
    "--on-force-close",
    "detach",
    "--default-cwd",
    projectRoot,
    "--show-startup-tips",
    "false",
    "--simplified-ui",
    "true",
    "--pane-frames",
    "false"
  ];
  const client = pty.spawn(zellijBin, args, {
    name: "xterm-256color",
    cols: 160,
    rows: 44,
    cwd: projectRoot,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor"
    }
  });
  client.onData((data) => {
    output = (output + data).slice(-100_000);
  });
  client.onExit((event) => {
    exitEvent = event;
  });
  return {
    term: client,
    output: () => output,
    exitEvent: () => exitEvent
  };
}

function spawnExistingClient(): ReturnType<typeof spawnClient> {
  let output = "";
  let exitEvent: { exitCode: number; signal?: number } | null = null;
  const client = pty.spawn(zellijBin, ["attach", sessionName], {
    name: "xterm-256color",
    cols: 160,
    rows: 44,
    cwd: projectRoot,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor"
    }
  });
  client.onData((data) => {
    output = (output + data).slice(-100_000);
  });
  client.onExit((event) => {
    exitEvent = event;
  });
  return {
    term: client,
    output: () => output,
    exitEvent: () => exitEvent
  };
}

function resolveBinary(value: string): string {
  const expanded =
    value === "~"
      ? process.env.USERPROFILE || value
      : value.startsWith("~/") || value.startsWith("~\\")
        ? path.join(process.env.USERPROFILE || "", value.slice(2))
        : value;
  return path.isAbsolute(expanded) || expanded.includes("/") || expanded.includes("\\")
    ? path.resolve(projectRoot, expanded)
    : expanded;
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

function stripAnsi(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
