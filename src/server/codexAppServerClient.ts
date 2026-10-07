import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";

interface RpcResponse { id: number | string; result?: unknown; error?: { code?: number; message?: string; data?: unknown } }
interface ServerMessage { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: unknown }
interface PendingRequest { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

export class CodexRpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
  }
}

export interface CodexServerRequest {
  id: number | string;
  method: string;
  params: unknown;
  reply(result: unknown): void;
  reject(code: number, message: string): void;
}

export interface CodexAppServerClientOptions {
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  experimentalApi?: boolean;
}

export class CodexAppServerClient extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private requestSequence = 0;
  private pending = new Map<number | string, PendingRequest>();
  private initializePromise?: Promise<void>;
  private generation = 0;

  constructor(private readonly options: CodexAppServerClientOptions = {}) {
    super();
  }

  get currentGeneration(): number { return this.generation; }
  get running(): boolean { return Boolean(this.child && !this.child.killed); }

  async ensureInitialized(): Promise<void> {
    this.initializePromise ??= this.initialize();
    return this.initializePromise;
  }

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (method !== "initialize") await this.ensureInitialized();
    const child = this.child;
    if (!child || child.killed) throw new CodexRpcError("Codex app-server is unavailable");
    const id = ++this.requestSequence;
    const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRpcError(`Codex request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    this.initializePromise = undefined;
    this.rejectAll(new CodexRpcError("Codex app-server closed"));
    if (child && !child.killed) child.kill();
  }

  private async initialize(): Promise<void> {
    this.start();
    await this.request("initialize", {
      clientInfo: { name: "terminal-apron", title: "Terminal Apron", version: "0.1.0" },
      capabilities: { experimentalApi: this.options.experimentalApi ?? false }
    });
    this.sendNotification("initialized");
  }

  private start(): void {
    if (this.child && !this.child.killed) return;
    const { command, args } = resolveCodexSpawnCommand(this.options);
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: this.options.env ?? process.env });
    this.child = child;
    this.generation += 1;
    const generation = this.generation;
    const lines = readline.createInterface({ input: child.stdout });
    child.once("error", (error) => {
      lines.close();
      if (generation !== this.generation) return;
      this.child = undefined;
      this.initializePromise = undefined;
      this.rejectAll(new CodexRpcError(`无法启动 Codex app-server：${error.message}。请检查 TWM_CODEX_BIN 或 PATH。`));
      this.emit("exit", { code: null, signal: "spawn_error", generation });
    });
    lines.on("line", (line) => this.handleLine(line, generation));
    child.stderr.on("data", (chunk) => this.emit("stderr", String(chunk).slice(0, 8_000)));
    child.once("exit", (code, signal) => {
      lines.close();
      if (generation !== this.generation) return;
      this.child = undefined;
      this.initializePromise = undefined;
      this.rejectAll(new CodexRpcError(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
      this.emit("exit", { code, signal, generation });
    });
  }

  private handleLine(line: string, generation: number): void {
    if (generation !== this.generation || !line.trim()) return;
    let message: ServerMessage;
    try { message = JSON.parse(line) as ServerMessage; }
    catch {
      this.emit("protocolWarning", { message: "Malformed JSONL frame", generation });
      return;
    }
    if (message.id !== undefined && ("result" in message || "error" in message) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      const response = message as RpcResponse;
      if (response.error) pending.reject(new CodexRpcError(response.error.message ?? "Codex RPC failed", response.error.code, response.error.data));
      else pending.resolve(response.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      let resolved = false;
      const reply = (result: unknown) => {
        if (resolved || generation !== this.generation) return;
        resolved = true;
        this.write({ id: message.id, result });
      };
      const reject = (code: number, errorMessage: string) => {
        if (resolved || generation !== this.generation) return;
        resolved = true;
        this.write({ id: message.id, error: { code, message: errorMessage } });
      };
      this.emit("serverRequest", { id: message.id, method: message.method, params: message.params, reply, reject } satisfies CodexServerRequest);
      return;
    }
    if (message.method) this.emit("notification", { method: message.method, params: message.params, generation });
  }

  private sendNotification(method: string, params?: unknown): void { this.write({ method, params }); }
  private write(value: unknown): void { this.child?.stdin.write(`${JSON.stringify(value)}\n`); }
  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}

export function resolveCodexSpawnCommand(options: CodexAppServerClientOptions = {}): { command: string; args: string[] } {
  if (options.command) return { command: options.command, args: options.args ?? ["app-server"] };
  const environment = options.env ?? process.env;
  const configured = environment.TWM_CODEX_BIN?.trim();
  const args = options.args ?? ["app-server"];
  if (configured && configured !== "codex") {
    if (/\.m?js$/i.test(configured)) return { command: process.execPath, args: [configured, ...args] };
    if (/\.(?:cmd|ps1)$/i.test(configured)) {
      const entry = path.join(path.dirname(configured), "node_modules", "@openai", "codex", "bin", "codex.js");
      if (fs.existsSync(entry)) return { command: process.execPath, args: [entry, ...args] };
      throw new CodexRpcError("TWM_CODEX_BIN 请指向 codex.exe 或 Codex 的 bin/codex.js");
    }
    return { command: configured, args };
  }
  if (process.platform === "win32") {
    const searchPath = environment.Path ?? environment.PATH ?? "";
    const directories = [...searchPath.split(path.delimiter), ...(environment.APPDATA ? [path.join(environment.APPDATA, "npm")] : [])];
    for (const directory of directories) {
      const root = directory.trim().replace(/^"|"$/g, "");
      if (!root) continue;
      const binary = path.join(root, "codex.exe");
      if (fs.existsSync(binary)) return { command: binary, args };
      const script = path.join(root, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
    }
  }
  return { command: "codex", args };
}
