import type { ResolvedTerminalBackend, TerminalBackend, TerminalSession } from "../shared/types.js";
import { config } from "./config.js";
import { tmuxHealth } from "./tmux.js";

let tmuxAvailableCache: Promise<boolean> | null = null;

async function tmuxAvailable(): Promise<boolean> {
  tmuxAvailableCache ??= tmuxHealth().then((health) => health.available);
  return tmuxAvailableCache;
}

export async function resolveBackend(session?: Pick<TerminalSession, "backend">): Promise<ResolvedTerminalBackend> {
  const requested: TerminalBackend = session?.backend ?? config.sessionBackend;

  if (requested === "native") {
    return "native";
  }

  if (requested === "tmux") {
    if (!(await tmuxAvailable())) {
      throw new Error("tmux backend requested but tmux is not available on this host");
    }
    return "tmux";
  }

  if (process.platform === "win32") {
    return "native";
  }

  return (await tmuxAvailable()) ? "tmux" : "native";
}

export async function backendHealth(): Promise<{
  default: ResolvedTerminalBackend | null;
  configured: TerminalBackend;
  platform: string;
  error?: string;
}> {
  try {
    return {
      default: await resolveBackend(),
      configured: config.sessionBackend,
      platform: process.platform
    };
  } catch (error) {
    return {
      default: null,
      configured: config.sessionBackend,
      platform: process.platform,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
