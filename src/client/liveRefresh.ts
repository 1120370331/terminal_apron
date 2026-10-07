interface RefreshEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
interface Options {
  intervalMs?: number;
  delayMs?: number;
  document?: RefreshEventTarget & { visibilityState: string };
  window?: RefreshEventTarget;
  onError?: (error: unknown) => void;
}

/** Serialize reads and coalesce notifications without postponing the first scheduled refresh. */
export function createLiveRefreshLoop(refresh: () => Promise<unknown>, options: Options = {}) {
  const doc = options.document ?? (typeof document === "undefined" ? undefined : document);
  const target = options.window ?? (typeof window === "undefined" ? undefined : window);
  let disposed = false, inFlight = false, rerun = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visible = () => doc?.visibilityState !== "hidden";
  const run = async () => {
    timer = undefined;
    if (disposed || !visible()) return;
    inFlight = true;
    try { await refresh(); }
    catch (error) { if (!disposed) options.onError?.(error); }
    finally { inFlight = false; if (rerun && !disposed) { rerun = false; request(); } }
  };
  const request = (immediate = false) => {
    if (disposed || !visible()) return;
    if (inFlight) { rerun = true; return; }
    if (timer !== undefined) { if (!immediate) return; clearTimeout(timer); }
    timer = setTimeout(() => void run(), immediate ? 0 : options.delayMs ?? 200);
  };
  const resume = () => request(true);
  doc?.addEventListener("visibilitychange", resume);
  for (const event of ["focus", "online", "pageshow"]) target?.addEventListener(event, resume);
  const fallback = setInterval(resume, options.intervalMs ?? 5000);
  return { request, dispose() {
    disposed = true; rerun = false; clearTimeout(timer); clearInterval(fallback);
    doc?.removeEventListener("visibilitychange", resume);
    for (const event of ["focus", "online", "pageshow"]) target?.removeEventListener(event, resume);
  } };
}
