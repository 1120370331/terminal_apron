import type { UserPreferences } from "../shared/types.js";
import { config } from "./config.js";
import { addCodexSessionTrackingToEnvironment } from "./codexSessions.js";

export interface TerminalProxyConfig {
  enabled: boolean;
  url: string;
}

export const DISABLED_TERMINAL_PROXY: TerminalProxyConfig = {
  enabled: false,
  url: "http://127.0.0.1:7890"
};

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy"
] as const;

export function terminalProxyConfig(preferences: UserPreferences): TerminalProxyConfig {
  return {
    enabled: preferences.terminalProxyEnabled,
    url: preferences.terminalProxyUrl
  };
}

export function terminalProcessEnvironment(
  proxy: TerminalProxyConfig,
  additions: Record<string, string> = {}
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
  if (proxy.enabled) {
    for (const key of PROXY_ENV_KEYS) {
      env[key] = proxy.url;
    }
  }
  return addCodexSessionTrackingToEnvironment({
    ...env,
    ...additions
  }, config.dataDir, config.codexBin);
}

export function sameTerminalProxy(left: UserPreferences, right: UserPreferences): boolean {
  if (left.terminalProxyEnabled !== right.terminalProxyEnabled) {
    return false;
  }
  return !left.terminalProxyEnabled || left.terminalProxyUrl === right.terminalProxyUrl;
}
