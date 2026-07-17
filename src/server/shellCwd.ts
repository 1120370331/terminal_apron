import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function resolveDirectoryChange(command: string, currentCwd: string): string | null {
  const normalized = command.replace(CSI_PATTERN, "").trim();
  const match =
    normalized.match(/^(?:cd|chdir)\s+(?:\/d\s+)?(.+?)(?:\s*(?:&&|;)\s*.*)?$/i) ??
    normalized.match(/^(?:set-location|sl|pushd)\s+(?:(?:-literalpath|-path)\s+)?(.+?)(?:\s*(?:&&|;)\s*.*)?$/i);
  if (!match?.[1]) {
    return null;
  }

  const target = expandDirectoryTarget(stripWrappingQuotes(match[1].trim()));
  const candidate = path.resolve(currentCwd || os.homedir(), target || os.homedir());
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

export function createShellCommandTracker(
  initialCwd: string,
  onDirectoryChange: (cwd: string) => void,
  getCurrentCwd?: () => string | undefined
): { feed: (data: string) => void; current: () => string } {
  let currentCwd = initialCwd;
  let inputBuffer = "";

  return {
    feed(data: string) {
      const cleaned = data.replace(CSI_PATTERN, "");
      for (const char of cleaned) {
        if (char === "\r" || char === "\n") {
          currentCwd = getCurrentCwd?.() || currentCwd;
          const nextCwd = resolveDirectoryChange(inputBuffer, currentCwd);
          inputBuffer = "";
          if (nextCwd) {
            currentCwd = nextCwd;
            onDirectoryChange(nextCwd);
          }
          continue;
        }
        if (char === "\u0003") {
          inputBuffer = "";
          continue;
        }
        if (char === "\b" || char === "\u007f") {
          inputBuffer = inputBuffer.slice(0, -1);
          continue;
        }
        if (char >= " " && char !== "\u007f") {
          inputBuffer = `${inputBuffer}${char}`.slice(-8192);
        }
      }
    },
    current: () => currentCwd
  };
}

function stripWrappingQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function expandDirectoryTarget(value: string): string {
  const home = os.homedir();
  if (!value || value === "~" || /^\$(?:HOME|USERPROFILE)$/i.test(value) || /^%(?:HOME|USERPROFILE)%$/i.test(value)) {
    return home;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(home, value.slice(2));
  }
  return value.replace(/%([^%]+)%/g, (_match, name: string) => process.env[name] ?? _match);
}
