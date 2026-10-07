import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const runtime = process.env.TWM_STAGED_RUNTIME;
if (!runtime) throw new Error("TWM_STAGED_RUNTIME is required");
const port = process.env.TWM_TASK_INTERRUPTED_RESUME_PORT ?? "3422";
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests",
  testMatch: "task-codex-conversations.spec.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  outputDir: path.join(runtime, "playwright-output"),
  reporter: "list",
  use: { baseURL: origin, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "staged-production", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node ${JSON.stringify(path.join(runtime, "dist/server/server/index.js"))}`,
    url: `${origin}/api/health`,
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      TWM_PORT: port,
      TWM_HOST: "127.0.0.1",
      TWM_AUTH_MODE: "none",
      TWM_DATA_DIR: path.join(runtime, "data"),
      TWM_CODEX_APP_SERVER_SCRIPT: path.resolve("scripts/fake-codex-app-server.mjs")
    }
  }
});
