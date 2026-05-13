export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
}

interface PtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd?: string;
      env: NodeJS.ProcessEnv;
    }
  ): PtyProcess;
}

let ptyModulePromise: Promise<PtyModule> | null = null;

export async function loadPty(): Promise<PtyModule> {
  ptyModulePromise ??= import("node-pty") as Promise<PtyModule>;
  return ptyModulePromise;
}

export async function nodePtyHealth(): Promise<{ available: boolean; error?: string }> {
  try {
    await loadPty();
    return { available: true };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}
