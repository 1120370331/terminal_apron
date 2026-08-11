import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "/task-monitor/",
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:3131"
    }
  },
  build: {
    outDir: "dist/task-monitor-client",
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(rootDir, "task-monitor.html")
    }
  }
});
