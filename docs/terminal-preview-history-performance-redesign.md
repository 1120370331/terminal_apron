# Terminal Preview And History Performance Redesign

This note follows the broker refactor and focuses on the two remaining user-visible problems:

- List previews still feel delayed, especially over Tailscale or other remote links.
- Reopened terminals still do not expose enough old history through normal scrolling.

The current product direction remains Zellij-only. This design does not add a tmux/native fallback.

## Findings

### Local Measurements

The local service was measured against two running Zellij sessions on `http://127.0.0.1:3132`.

Transcript sizes:

- `7c927b6f...`: 37.2 MB
- `b132f2c5...`: 19.0 MB

HTTP preview endpoint:

- `/api/sessions`: 217 ms for 2 sessions.
- `/api/sessions/:id/preview?full=false`: roughly 120-500 ms per card request.
- `/api/sessions/:id/preview?full=true`: roughly 370-530 ms per card request.

Server-side split for preview:

- Viewport capture via Zellij: roughly 190-200 ms.
- Grid render for list preview: roughly 140-180 ms.
- Full preview can return tens of KB for a single card.

History range reads:

- 800 raw-line request can read 4-7 MB and take 220-430 ms.
- 5000 raw-line request can read 19-33 MB and take 1-3 seconds.
- With a 256 KB byte cap, only 36-47 raw lines were returned for output with long lines.

These numbers explain the reported behavior. The app is currently doing expensive snapshot work repeatedly, and "line count" is not a reliable proxy for terminal rows.

### Code-Level Causes

List preview still uses HTTP polling instead of broker subscriptions:

- `src/client/App.tsx` polls each visible card through `api.preview(...)`.
- `src/server/index.ts` handles `/api/sessions/:id/preview`.
- The endpoint calls `captureSessionPreview(...)`, then `renderSessionPreviewGrid(...)`.
- Zellij preview capture calls `dump-screen --ansi`.
- Preview grid rendering calls `zellijPreviewSize(...)`, which can trigger another Zellij metadata query.

This means each list card can spend one or more subprocess calls plus one headless/render pass every polling interval. The current `VIEWPORT_PREVIEW_TTL_MS` is 600 ms, while list polling defaults to 1000 ms, so normal polling usually misses the cache and re-runs Zellij.

History has three separate issues:

- `src/server/terminalHistory.ts` is hard-coded around raw transcript byte ranges. Config values such as `terminalHistoryRangeLines`, `terminalHistoryRangeBytes`, `terminalSnapshotViewportLines`, and `terminalHistoryColdTailBytes` are defined in `config.ts` but are not actually used by this service.
- `src/client/components/TerminalDock.tsx` requests only `tailLines: "500"` initially and older chunks of `800` lines with `256_000` bytes.
- Older chunks are stored in `olderHistoryPreview`, a side panel capped at `80_000` chars. They are not inserted into xterm scrollback, so normal terminal scrolling cannot reach them.

There is also a persistence gap: the transcript only appends output observed through the broker attach PTY. If a Zellij session produces output while no broker is attached, the transcript can lag behind Zellij scrollback. Zellij can dump or subscribe to rendered pane output, but the current history range loader reads only the transcript file.

## External References

The design should follow these constraints from established terminal systems:

- xterm.js flow control: xterm `write` is non-blocking and buffers work on the UI thread; high/low watermarks and client ACKs are recommended for WebSocket transports.
  https://xtermjs.org/docs/guides/flowcontrol/
- xterm.js serialize addon: framebuffer serialization can support fast visual restore and persisted browser-side terminal state, but it is marked experimental.
  https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize
- VS Code persistent terminal sessions: process reconnection/revive is separate from restored scrollback volume, and scrollback has its own setting.
  https://code.visualstudio.com/docs/terminal/advanced#_persistent-sessions
- Zellij programmatic control: `dump-screen` is a point-in-time snapshot, while `subscribe` is the streaming observation primitive.
  https://zellij.dev/documentation/programmatic-control.html
- Zellij subscribe: initial delivery sends the current viewport and optional scrollback, subsequent deliveries only occur when the viewport changes.
  https://zellij.dev/documentation/zellij-subscribe.html
- JupyterLab terminal protocol: keep the core realtime protocol small and explicit around `stdin`, `stdout`, `set_size`, and `disconnect`.
  https://jupyterlab.readthedocs.io/en/4.0.x/api/types/services.Terminal.MessageType.html

## Target Architecture

### 1. Preview Broker

Replace list HTTP polling as the primary path with broker-owned preview subscriptions.

New server concepts:

```ts
type PreviewSnapshot = {
  sessionId: string;
  paneId: string | null;
  seq: number;
  signature: string;
  capturedAt: number;
  cols: number;
  rows: number;
  ansiViewport: string;
  grid?: TerminalPreviewGrid;
  cacheState: "fresh" | "stale" | "loading";
};
```

Responsibilities:

- Keep one in-memory preview snapshot per active session.
- Serve stale snapshots immediately while a refresh is in flight.
- Use one Zellij metadata query per refresh cycle; do not call `list-panes` again just to render size.
- Deduplicate concurrent preview requests across clients.
- Emit updates only when `signature` changes.
- Keep HTTP `/preview` as a debug/compat endpoint, backed by the same cache.

Recommended implementation path:

1. Add `PreviewBroker` behind `TerminalBroker` or next to it.
2. If an interactive broker is live, derive list preview from the broker's latest viewport/snapshot instead of calling `dump-screen`.
3. If no broker is live, use a Zellij observer:
   - Preferred: `zellij --session <name> subscribe --pane-id <id> --format json --ansi`.
   - Fallback/debug: `dump-screen --ansi` with stale-while-revalidate cache.
4. Add socket event `terminal:preview` for list cards:

```ts
type TerminalPreviewFrame = {
  version: 2;
  sessionId: string;
  seq: number;
  signature: string;
  capturedAt: number;
  grid?: TerminalPreviewGrid;
  text?: string;
};
```

Client behavior:

- Subscribe only visible cards.
- Pause preview subscriptions while fullscreen terminal is open.
- On return to list, render cached snapshots instantly, then resume subscriptions.
- Do not send full grid payload if the signature has not changed.
- Add a global preview concurrency budget for the remaining HTTP fallback path.

### 2. Server Timing And Diagnostics

Add timing fields in development and optionally as `Server-Timing` headers:

```ts
type PreviewDebugTiming = {
  cacheHit: boolean;
  zellijPaneMs: number;
  zellijDumpMs: number;
  renderGridMs: number;
  payloadBytes: number;
};
```

This should be visible in browser DevTools and optionally in a compact settings/debug panel. Without this, future latency regressions will be hard to distinguish from remote network delay.

### 3. Real History Index

Raw LF counting is not enough. A terminal row is affected by wrapping, ANSI state, and the current terminal width.

Introduce a per-session rendered row index:

```ts
type HistoryCheckpoint = {
  sessionId: string;
  offset: number;
  seq?: number;
  cols: number;
  renderedRow: number;
  rawLine: number;
  createdAt: number;
};

type HistoryRowBlock = {
  sessionId: string;
  fromRow: number;
  toRow: number;
  fromOffset: number;
  toOffset: number;
  ansi: string;
  plainText?: string;
  hasMoreBefore: boolean;
};
```

Implementation:

- Maintain the append-only ANSI transcript.
- Build an index asynchronously from transcript bytes using `@xterm/headless`.
- Store checkpoints every 500-1000 rendered rows or every 1-4 MB, whichever comes first.
- On range request, jump to the nearest checkpoint and parse forward, instead of scanning huge byte ranges backward.
- Count rendered rows, not raw line breaks.
- Return row ranges and byte offsets together.
- Backfill from Zellij `dump-screen --full` or `subscribe --scrollback` when transcript coverage is missing.

This makes "load 5000 rows" a bounded indexed read instead of a 30 MB reverse scan.

### 4. Fullscreen History UX

xterm does not provide a cheap general-purpose "prepend old scrollback" API. The current side panel is technically safe but does not match user expectations.

Use a two-layer UX:

- Live xterm remains focused, responsive, and small on cold open.
- A terminal-styled virtual history layer appears when the user scrolls above available xterm scrollback or clicks history.

The virtual layer should:

- Look like the terminal, not like a separate note panel.
- Support normal wheel/PageUp/PageDown.
- Load older and newer pages by row cursor.
- Retain at least 5000 rendered rows by default, with a higher configurable cap.
- Support search/export later.
- Have a clear "jump to live" action.

Current implementation note: the first shipped virtual layer keeps live xterm separate, pages transcript ranges by byte
offset, strips ANSI for the history view, approximates terminal wrapping by the active terminal column count, and retains
up to 100,000 rendered history rows in the browser. This makes the history view useful immediately while the indexed
rendered-row service above remains the next deeper backend step.

Cold open sequence:

1. Show viewport snapshot immediately.
2. Start live stream and accept input.
3. Load a small recent tail, for example 300-800 rows.
4. Build or refresh the history index in the background.
5. When user scrolls above live scrollback, switch to virtual history and lazy-load row blocks.

This satisfies "latest first" and "5000+ history" without blocking input on a huge replay.

### 5. Config Cleanup

Wire existing config into the actual services:

- `TWM_TERMINAL_SNAPSHOT_VIEWPORT_LINES`
- `TWM_TERMINAL_HISTORY_COLD_TAIL_LINES`
- `TWM_TERMINAL_HISTORY_COLD_TAIL_BYTES`
- `TWM_TERMINAL_HISTORY_RANGE_LINES`
- `TWM_TERMINAL_HISTORY_MAX_RANGE_LINES`
- `TWM_TERMINAL_HISTORY_RANGE_BYTES`

Remove or deprecate unused constants in `terminalHistory.ts` and `TerminalDock.tsx`.

Recommended defaults:

- Cold viewport: 120 rows.
- Cold tail: 500 rendered rows.
- Interactive older page: 1000 rendered rows.
- Minimum accessible history target: 5000 rendered rows.
- Max per history response: 512 KB local, 128-256 KB remote.
- Preview cache TTL: 1500-2500 ms for polling fallback.
- Preview stale-while-revalidate window: 15-30 seconds.

## Rollout Plan

### Phase A: Stabilize Current Paths

Low risk, should be implemented first.

- Wire config values into `terminalHistory.ts` and `TerminalDock.tsx`.
- Increase viewport preview cache TTL so normal 1s polling can hit cache.
- Add stale-while-revalidate for `/preview`.
- Avoid duplicate Zellij pane metadata queries during one preview render.
- Disable full preview refresh for remote hosts unless explicitly requested.
- Add global preview concurrency, for example 2 local and 1 remote.
- Include timing/payload diagnostics in preview responses during development.
- Replace the history side panel cap with a larger ring or paged buffer so it stops discarding useful loaded history.

Expected result:

- List preview should feel less bursty.
- Remote typing should no longer compete with repeated full preview payloads.
- History settings should actually change behavior.

### Phase B: Preview Subscriptions

Medium risk, high value.

- Add `PreviewBroker`.
- Add list-card socket subscriptions.
- Emit preview only on signature change.
- Keep HTTP preview as debug/fallback.
- Test Zellij `subscribe` on Windows with local and Tailscale access.

Expected result:

- List cards stop spawning Zellij commands every polling tick.
- Returning from fullscreen shows cached latest immediately.
- Quick-send can mark `updated` from observed preview/live sequence rather than arbitrary timeout.

### Phase C: Indexed History And Virtual History Layer

Highest value for the 5000+ history requirement.

- Build `HistoryIndexService`.
- Add row-based range API.
- Add terminal-styled virtual history mode in `TerminalDock`.
- Trigger virtual history when the user scrolls above live xterm scrollback.
- Keep live xterm responsive and do not replay 5000+ rows on cold open.

Expected result:

- Users can access at least 5000 rendered rows reliably.
- Loading old history is newest-first in UX but forward-parsed internally.
- Large outputs with long lines do not force 30 MB reads for every history request.

### Phase D: Browser-Side Restore

Optional after Phase C.

- Add `@xterm/addon-serialize`.
- Serialize hidden terminal buffers for the most recent sessions.
- Restore visual state immediately on reopen/reload, then reconnect by `lastAckSeq`.
- Treat this as a cache only; server transcript/index remains the source of truth.

## Acceptance Criteria

- List preview update with unchanged output sends no large payload.
- A visible card update should not require more than one Zellij subprocess per refresh cycle in fallback mode.
- Over a remote browser host, typing into fullscreen terminal should not be delayed by list preview refresh work.
- Opening a large-history terminal reaches live input before deep history is loaded.
- The user can access at least 5000 rendered rows from fullscreen history UI.
- History requests are cancellable and bounded by response bytes.
- Configured history limits in `.env` affect actual behavior.
- Zellij remains the only backend path.
