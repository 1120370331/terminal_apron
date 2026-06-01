# Terminal Connection, Attach, And Update Redesign

This document is a review draft for improving terminal connection, attach, history loading, and list/fullscreen update behavior in `terminal_apron`.

The intended backend direction is still Zellij-first. This proposal does not add a new fallback backend. When Zellij is unavailable, the product should report a clear backend error and configuration path instead of silently changing behavior.

## Goals

- Opening a terminal should show the latest usable view first, then load older history lazily.
- Fullscreen terminal, list preview, and quick-send input should share one session state model.
- History replay must not block live input.
- Reopening an existing terminal should reuse hot browser/server state where possible.
- Remote access over Tailscale or other higher-latency links should avoid large repeated transfers.
- The architecture should be explicit enough to support later work: file transfer status, multi-client viewing, search/export history, and reconnect recovery.

## Current State

Relevant implementation points:

- `src/server/terminalSocket.ts` attaches a browser socket directly to a Zellij attach PTY.
- `attachZellij()` calls `captureZellijAttachHistory()` before live output is released.
- Historical replay and live output are both emitted as `terminal:data`.
- `src/server/zellij.ts` can read transcript tail and can call `zellij action dump-screen --ansi --full`.
- `src/server/terminalData.ts` chunks large `terminal:data` payloads, but there is no protocol-level ack or flow control.
- `src/client/components/TerminalDock.tsx` owns one xterm instance, one socket, and an internal write queue.
- `src/client/App.tsx` currently keeps only one cached `TerminalDock`.
- List previews are still refreshed through HTTP `/api/sessions/:id/preview` polling.
- List quick input writes through REST, then waits for preview refresh or returned preview content to make the UI feel updated.

This explains most reported symptoms:

- Old terminals take too long to open because attach is coupled with history capture and replay.
- Live output can be delayed behind history replay.
- xterm has to parse a large ANSI stream on the main thread when reopening old sessions.
- List preview and fullscreen terminal can disagree because they are fed by different update paths.
- A quick-send command can be accepted by the server while the card still looks stale.
- Remote links feel worse because repeated preview/history payloads dominate perceived latency.

## Open Source References

The design borrows patterns from these projects, while keeping a custom protocol because `terminal_apron` needs session state, lazy history, and list preview semantics.

- xterm.js attach addon: simple WebSocket-to-terminal attach model.
  https://github.com/xtermjs/xterm.js/tree/master/addons/addon-attach
- xterm.js encoding guide: keep PTY output/input as UTF-8 terminal byte streams.
  https://xtermjs.org/docs/guides/encoding/
- ttyd: small WebSocket terminal built around xterm.js and a server-side PTY.
  https://github.com/tsl0922/ttyd
- WeTTY: web terminal UX centered on WebSocket interaction rather than delayed HTTP polling.
  https://github.com/butlerx/wetty
- VS Code terminal persistent sessions: separate process lifetime, reconnection, and restored scrollback.
  https://code.visualstudio.com/docs/terminal/advanced
- code-server: browser-hosted VS Code terminal behavior over remote links.
  https://github.com/coder/code-server
- Coder web terminal: clear Browser -> WebSocket -> Server/Agent -> PTY layering and latency/debug concerns.
  https://coder.com/docs/user-guides/workspace-access/web-terminal
- JupyterLab terminal protocol: restrained message categories such as input, output, size, and disconnect.
  https://jupyterlab.readthedocs.io/en/4.0.x/api/types/services.Terminal.MessageType.html
- terminado: Jupyter terminal WebSocket backend built around PTY processes.
  https://github.com/jupyter/terminado
- Zellij programmatic control and subscribe APIs: distinguish snapshot capture from streaming observation.
  https://zellij.dev/documentation/programmatic-control.html
  https://zellij.dev/documentation/zellij-subscribe.html

## Proposed Architecture

The main change is to split the terminal data plane into three independent concepts:

- Live stream: interactive PTY/Zellij output from now onward.
- Latest snapshot: the current visible terminal screen and a small tail.
- Historical range: older transcript/scrollback data loaded on demand.

### 1. Server Session Broker

Introduce a per-session `TerminalBroker`.

The broker is the only server object allowed to coordinate live subscribers for a terminal session. Browser sockets attach to the broker; the broker attaches to Zellij and owns session state.

Responsibilities:

- Track session state: `starting`, `live`, `detached`, `reconnecting`, `error`.
- Keep a short hot lifetime after the last browser disconnects, for example 30-120 seconds.
- Maintain a subscriber list for fullscreen terminals, list previews, and future file-transfer progress panels.
- Serialize input writes from fullscreen terminal and list quick-send.
- Assign monotonic sequence numbers to live output and accepted input.
- Publish lightweight preview snapshots without forcing each list card to run a fresh full screen dump.
- Decide which browser client owns interactive resize. Preview subscribers must not resize the underlying terminal.
- Report Zellij backend errors as hard backend errors.

Conceptual shape:

```ts
type TerminalBroker = {
  sessionId: string;
  backend: "zellij";
  state: "starting" | "live" | "detached" | "reconnecting" | "error";
  streamId: string;
  lastSeq: number;
  subscribers: Map<string, TerminalSubscriber>;
  inputQueue: Promise<void>;
  ringBuffer: TerminalFrameRingBuffer;
  snapshot: TerminalSnapshot | null;
  lastActiveAt: number;
};
```

### 2. History Store

History should not be replayed as an unavoidable part of attach.

Use an append-only transcript plus an index:

- Raw ANSI transcript: append live output with byte offsets and sequence boundaries.
- Rendered line index: map approximate terminal rows to transcript offsets.
- Latest snapshot: store current viewport and small scrollback tail.
- Range API: load older history by line number or byte offset.

Initial implementation can start with byte ranges because the project already has transcript files. The long-term target should be a rendered line index, because terminal wrapping and ANSI state make "last N raw lines" unreliable.

```ts
type TerminalHistoryCursor = {
  sessionId: string;
  newestSeq: number;
  newestLine?: number;
  oldestLoadedLine?: number;
  newestOffset: number;
};

type TerminalHistoryRange = {
  sessionId: string;
  requestId: string;
  fromLine?: number;
  toLine?: number;
  fromOffset?: number;
  toOffset?: number;
  ansi: string;
  hasMoreBefore: boolean;
};
```

Important constraint: old terminal output cannot be loaded newest-first by reversing ANSI chunks. Terminal control sequences depend on forward state. The UX can be latest-first, but data replay must remain ordered.

Practical strategy:

- Cold open writes only a latest snapshot and small tail.
- Live output starts immediately after `ready`.
- Older history loads only when the user requests it or scrolls near the top.
- If older history is injected into xterm scrollback, inject it in forward order and preserve scroll position with xterm markers.
- If xterm cannot safely prepend, use a separate virtualized history viewer for deep history and keep the live terminal responsive.

### 3. Realtime Socket Protocol

The current `terminal:data` string event is too ambiguous. Keep raw terminal data, but wrap it in versioned frames with sequence IDs and kind fields.

Suggested namespace:

```txt
/io/terminal
```

Connection query:

```ts
type TerminalConnectQuery = {
  protocolVersion: 2;
  sessionId: string;
  clientId: string;
  clientProfile: "desktop" | "mobile";
  mode: "interactive" | "preview";
  cols?: number;
  rows?: number;
  lastAckSeq?: number;
  historyPolicy: "none" | "viewport" | "tail";
  tailLines?: number;
};
```

Server to client:

```ts
type TerminalReady = {
  sessionId: string;
  streamId: string;
  backend: "zellij";
  persistent: true;
  cols: number;
  rows: number;
  newestSeq: number;
  canResumeFromSeq: boolean;
  canLoadOlderHistory: boolean;
};

type TerminalState = {
  sessionId: string;
  state: "starting" | "live" | "detached" | "reconnecting" | "error";
  latencyMs?: number;
  updatedAt: string;
};

type TerminalData = {
  sessionId: string;
  streamId: string;
  seq: number;
  kind: "live";
  data: string;
  byteLength: number;
  emittedAt: number;
};

type TerminalHistoryInit = {
  sessionId: string;
  streamId: string;
  snapshotSeq: number;
  viewportAnsi: string;
  tailAnsi?: string;
  oldestLine?: number;
  newestLine?: number;
  hasMoreBefore: boolean;
};

type TerminalHistoryChunk = {
  sessionId: string;
  requestId: string;
  fromLine?: number;
  toLine?: number;
  fromOffset?: number;
  toOffset?: number;
  ansi: string;
  hasMoreBefore: boolean;
};

type TerminalInputAck = {
  sessionId: string;
  inputId: string;
  accepted: boolean;
  inputSeq?: number;
  message?: string;
};

type TerminalFlow = {
  sessionId: string;
  streamId: string;
  paused: boolean;
  reason?: "client-backpressure" | "history-loading" | "network";
};

type TerminalError = {
  sessionId: string;
  code:
    | "unauthorized"
    | "session-not-found"
    | "backend-unavailable"
    | "attach-failed"
    | "history-failed"
    | "resync-required";
  message: string;
  recoverable: boolean;
};
```

Client to server:

```ts
type TerminalInput = {
  sessionId: string;
  inputId: string;
  data: string;
  mode: "type" | "paste" | "quick-send";
};

type TerminalResize = {
  sessionId: string;
  cols: number;
  rows: number;
  seq: number;
  source: "interactive";
};

type TerminalAck = {
  sessionId: string;
  streamId: string;
  seq: number;
  renderedAt: number;
  writeQueueBytes: number;
};

type TerminalHistoryRequest = {
  sessionId: string;
  requestId: string;
  beforeLine?: number;
  beforeOffset?: number;
  limitLines?: number;
  maxBytes?: number;
  format: "ansi" | "plain";
};

type TerminalHistoryCancel = {
  sessionId: string;
  requestId: string;
};

type TerminalVisibility = {
  sessionId: string;
  visible: boolean;
  atBottom: boolean;
};
```

### 4. Backpressure

Backpressure should be protocol-visible.

Suggested defaults:

- Track unacknowledged live bytes per subscriber.
- If unacknowledged bytes exceed 512 KB, pause history chunks for that subscriber.
- If unacknowledged bytes exceed 2 MB, send `terminal:flow` and coalesce live chunks.
- History requests must be cancellable when a tab closes, fullscreen exits, or the user switches sessions.
- Live output should be favored over historical replay.
- A slow preview subscriber must not slow down the interactive subscriber.

This directly targets remote-link lag: do not keep sending old output when the user is trying to type into the current terminal.

### 5. Frontend Terminal Registry

Replace the single cached fullscreen terminal with a `TerminalInstanceRegistry`.

The registry owns browser-side xterm instances independently from the current route/fullscreen state.

```ts
type TerminalInstance = {
  sessionId: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  socket: Socket;
  state: "cold" | "connecting" | "ready" | "hidden" | "stale" | "error";
  lastVisibleAt: number;
  lastAckSeq: number;
  writeQueueBytes: number;
  scrollState: {
    atBottom: boolean;
    userViewingHistory: boolean;
  };
};
```

Behavior:

- Reopen same session: reuse terminal, socket, buffer, and `lastAckSeq`.
- Hide fullscreen: mark hidden, keep alive until TTL expires.
- Switch session: keep the most recent 2-3 instances with LRU eviction.
- Cold open: request `historyPolicy: "viewport"` first, then lazy tail/history.
- Mobile and desktop fit/resize stay independent; do not share desktop stable width assumptions with mobile portrait mode.
- When a user is scrolled up, do not force-scroll on live output. Show a "new output" affordance instead.

### 6. List Preview And Quick Send

List preview should become a lightweight broker subscriber instead of an independent polling path.

Target behavior:

- List cards subscribe to compact preview snapshots for visible sessions.
- Fullscreen open pauses list preview subscribers, but broker state remains live.
- Returning to list resumes preview updates immediately.
- Quick-send creates an `inputId` and gets `terminal:input:ack`.
- The card updates immediately to `sending`, then `sent`, then `echoing`, then `updated`.
- The UI clears the input on ack, not after an arbitrary timeout.
- Preview is marked updated once a frame with `seq >= inputSeq` is observed.
- HTTP `/preview` can remain as a compatibility/debug endpoint but should not be the main update loop.

This removes the current "REST write succeeded but UI still feels frozen" gap.

## UX Model

### Fast Open

Target order when the user opens a terminal:

1. Show terminal chrome immediately with `connecting`.
2. If a hot frontend instance exists, show it immediately and reconnect in the background if needed.
3. If not, show latest viewport snapshot first.
4. Mark terminal `live` as soon as live stream is attached.
5. Load recent tail or older history in the background.
6. Load deep history only when requested.

Target feedback states:

- `connecting`
- `loading latest screen`
- `live`
- `loading older history`
- `history paused, live output available`
- `reconnecting`
- `detached`
- `error`

### Reconnect

- Keep xterm buffer in the browser during socket reconnect.
- Reconnect with `lastAckSeq`.
- If broker still has the missing frames, replay only the gap.
- If the gap is too large, send `resync-required` and reload latest snapshot.
- Do not silently drop user input while disconnected. Buffer visibly or disable input with a status message.

### History

- Initial attach should not require 5000+ lines.
- Default cold open should be viewport plus a small tail, for example 200-800 rows.
- "At least 5000 lines of history" should be satisfied by lazy history access, not by blocking terminal open.
- Deep history should be searchable/exportable later, ideally from the transcript/index rather than from xterm's current buffer.

## Rollout Plan

### Phase 0: Stabilize Without Major Rewrite

Scope: low-risk changes around the current files.

- Add `kind: "history" | "live"` to terminal data frames while preserving compatibility.
- Emit `terminal:history:done` so the frontend can stop showing loading state.
- Add input IDs and input ack for list quick-send.
- Make `/api/sessions/:id/input` return an immediate input status and sequence-like token.
- Reduce cold attach history default to a smaller number, while keeping deep history available via a separate request.
- Make history replay cancellable when closing fullscreen or switching sessions.
- Keep 2 cached terminal instances instead of one.
- Add performance timings: click-to-frame, ready-to-live, history bytes, write queue bytes, preview poll duration.
- Keep Zellij missing as a hard backend error with clear setup text.

### Phase 1: Introduce Broker And Protocol V2

Scope: new server terminal module and new frontend connection abstraction.

- Add `TerminalBroker` and broker registry.
- Move input, resize, live output, preview snapshot, and transcript append behind the broker.
- Add sequence numbers, ack, and subscriber-level flow control.
- Replace list preview polling with broker snapshot subscription for visible sessions.
- Add frontend `TerminalInstanceRegistry` with LRU and TTL.
- Keep HTTP preview as a debug endpoint.
- Remove `dump-screen --full` from the fullscreen attach path.
- Add lazy history request/cancel APIs.

### Phase 2: Build Real History Service

Scope: history correctness and advanced UX.

- Maintain rendered line index from transcript.
- Use headless xterm or equivalent terminal parser to produce stable snapshots and line ranges.
- Support deep history search and export.
- Support replay by sequence range.
- Support multi-client viewing with one active resize owner.
- Add binary/compressed frames for remote links if profiling shows socket payload overhead remains material.
- Explore Zellij `subscribe` for preview observation, while keeping attach/input behavior explicit.

## Acceptance Criteria For Review

- Cold-opening a session with large history does not block live input.
- Reopening a recently used session does not replay all history again.
- Fullscreen terminal and list preview eventually show the same latest state.
- List quick-send has immediate visible acknowledgement.
- A high-latency browser connection does not repeatedly receive large full-history or full-preview payloads.
- Users can access 5000+ lines of history, but that history loads lazily.
- Zellij backend errors are explicit and do not switch to another behavior silently.

## Open Questions

- Should deep history appear inside xterm scrollback, a separate history drawer, or both?
- How many hot browser terminal instances should be retained by default: 2 or 3?
- What is the first acceptable cold-open tail size: 300, 500, or 800 rows?
- Should broker state be process-local only, or persisted enough to survive server restart?
- Is Zellij `subscribe` reliable enough on Windows for preview snapshots, or should it remain a later optimization?
