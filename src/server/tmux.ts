import { execFile } from "node:child_process";
import fs from "node:fs";
import type { SessionRuntime, TerminalSession } from "../shared/types.js";
import { config } from "./config.js";

function runTmux(args: string[], timeoutMs = 8000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      config.tmuxBin,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 4 },
      (error, stdout, stderr) => {
        if (error) {
          const wrapped = new Error(stderr || error.message);
          reject(wrapped);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

export async function tmuxVersion(): Promise<string> {
  const result = await runTmux(["-V"]);
  return result.stdout.trim();
}

export async function tmuxHealth(): Promise<{ available: boolean; version?: string; error?: string }> {
  try {
    return { available: true, version: await tmuxVersion() };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function hasSession(tmuxName: string): Promise<boolean> {
  try {
    await runTmux(["has-session", "-t", tmuxName], 3000);
    return true;
  } catch {
    return false;
  }
}

export async function ensureTmuxSession(session: Pick<TerminalSession, "tmuxName" | "cwd" | "shell">): Promise<void> {
  if (await hasSession(session.tmuxName)) {
    await runTmux(["set-option", "-t", session.tmuxName, "history-limit", String(config.tmuxHistoryLimit)], 5000).catch(
      () => undefined
    );
    return;
  }

  const args = ["new-session", "-d", "-s", session.tmuxName];
  if (session.cwd && fs.existsSync(session.cwd)) {
    args.push("-c", session.cwd);
  }
  if (session.shell) {
    args.push(session.shell);
  }

  await runTmux(args, 10000);
  await runTmux(["set-option", "-t", session.tmuxName, "history-limit", String(config.tmuxHistoryLimit)], 5000).catch(
    () => undefined
  );
}

export async function killTmuxSession(session: Pick<TerminalSession, "tmuxName">): Promise<void> {
  if (!(await hasSession(session.tmuxName))) {
    return;
  }
  await runTmux(["kill-session", "-t", session.tmuxName], 5000);
}

export async function capturePreview(session: Pick<TerminalSession, "tmuxName">, lines = 500): Promise<string> {
  if (!(await hasSession(session.tmuxName))) {
    return "";
  }

  const start = `-${Math.max(5, Math.min(lines, config.previewMaxLines))}`;
  const result = await runTmux(["capture-pane", "-p", "-e", "-J", "-S", start, "-t", session.tmuxName], 5000);
  return result.stdout.replace(/\s+$/g, "");
}

export async function sendTmuxInput(
  session: Pick<TerminalSession, "tmuxName" | "cwd" | "shell">,
  data: string,
  enter = false,
  submitDelayMs = 0
): Promise<void> {
  await ensureTmuxSession(session);
  const bufferName = `twm_input_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  await runTmux(["set-buffer", "-b", bufferName, data], 5000);
  await runTmux(["paste-buffer", "-d", "-b", bufferName, "-t", session.tmuxName], 5000);
  if (enter) {
    await delay(submitDelayMs);
    await runTmux(["send-keys", "-t", session.tmuxName, "Enter"], 5000);
  }
}

function delay(ms: number): Promise<void> {
  const duration = Math.max(0, Math.min(12_000, Math.floor(ms)));
  if (duration === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, duration));
}

export async function runtimeInfo(session: TerminalSession): Promise<SessionRuntime> {
  if (!(await hasSession(session.tmuxName))) {
  return {
    exists: false,
    backend: "tmux",
    persistent: true,
    attached: 0,
      currentPath: session.cwd,
      currentCommand: "",
      windows: 0,
      lastAttached: null
    };
  }

  const format = [
    "#{pane_current_path}",
    "#{pane_current_command}",
    "#{session_attached}",
    "#{session_windows}",
    "#{session_last_attached}"
  ].join("\t");
  const result = await runTmux(["display-message", "-p", "-t", session.tmuxName, format], 5000);
  const [currentPath, currentCommand, attached, windows, lastAttached] = result.stdout.trimEnd().split("\t");
  return {
    exists: true,
    backend: "tmux",
    persistent: true,
    attached: Number(attached) || 0,
    currentPath: currentPath || session.cwd,
    currentCommand: currentCommand || "",
    windows: Number(windows) || 1,
    lastAttached: Number(lastAttached) || null
  };
}
