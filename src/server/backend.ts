import type { ResolvedTerminalBackend, TerminalBackend, TerminalSession } from "../shared/types.js";
import { config } from "./config.js";
import { zellijHealth } from "./zellij.js";

let zellijAvailableCache: Promise<boolean> | null = null;

async function zellijAvailable(): Promise<boolean> {
  zellijAvailableCache ??= zellijHealth().then((health) => health.available);
  return zellijAvailableCache;
}

export async function resolveBackend(session?: Pick<TerminalSession, "backend">): Promise<ResolvedTerminalBackend> {
  const requested: TerminalBackend = session?.backend ?? config.sessionBackend;
  if (requested !== "zellij" && requested !== "auto") {
    // Legacy configs are migrated to zellij at the store boundary. This guard
    // keeps stale env/session values from silently falling back to nonpersistent pty modes.
  }

  if (!(await zellijAvailable())) {
    throw new Error("zellij backend is required but zellij is not available on this host");
  }
  return "zellij";
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
