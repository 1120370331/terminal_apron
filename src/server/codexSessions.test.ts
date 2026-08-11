import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  addCodexSessionTrackingToEnvironment,
  classifyCodexBootstrapFailure,
  codexResumeCommand,
  codexThreadIdFromProcessCommand,
  codexTerminalTitleMatchesThread,
  CodexTerminalTitleTracker,
  isCodexProcessCommand,
  isCodexYoloProcessCommand,
  listCodexCliThreads,
  parseCodexThreadIntent,
  resolveCodexThreadForPrompt,
  resolveCodexThreadFromTerminalTitle,
  resolveCodexThreadId,
  selectCodexThreadForIntent,
  type CodexLocalThread
} from "./codexSessions.js";

const THREAD_ID = "019f96dc-e94d-7553-aeb2-e9f1cef03e32";
const NEW_THREAD_ID = "019f96dd-0000-7000-8000-000000000001";
const OTHER_THREAD_ID = "019f96dd-0000-7000-8000-000000000002";
const TITLE_PREFIX = `${THREAD_ID.slice(0, 29)}...`;

test("builds a direct CLI resume command without an app-server bridge", () => {
  const command = codexResumeCommand(THREAD_ID, {
    modelProvider: "openai"
  });
  assert.ok(command);
  assert.match(command.at(-1) ?? "", /model_provider=openai/);
  assert.doesNotMatch(command.at(-1) ?? "", /--remote|app-server/i);
  assert.match(command.at(-1) ?? "", /resume --yolo/);
  assert.match(command.at(-1) ?? "", new RegExp(THREAD_ID));
});

test("recognizes Codex process commands without treating an ordinary shell as Codex", () => {
  assert.equal(isCodexProcessCommand("codex.exe --yolo"), true);
  assert.equal(isCodexProcessCommand("cmd.exe /c C:\\tools\\codex.cmd resume --yolo thread"), true);
  assert.equal(isCodexProcessCommand("node C:\\npm\\@openai\\codex\\bin\\codex.js"), true);
  assert.equal(isCodexProcessCommand("powershell.exe"), false);
  assert.equal(isCodexProcessCommand("bash"), false);
  const realZellijCommand = `node C:\\Users\\rog\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js -c tui.terminal_title=['session-id'] resume ${THREAD_ID} --yolo`;
  assert.equal(isCodexProcessCommand(realZellijCommand), true);
  assert.equal(codexThreadIdFromProcessCommand(realZellijCommand), THREAD_ID);
  assert.equal(isCodexYoloProcessCommand(realZellijCommand), true);
  assert.equal(isCodexYoloProcessCommand(`codex resume ${THREAD_ID}`), false);
  assert.equal(codexThreadIdFromProcessCommand(`echo ${THREAD_ID}`), null);
});

test("wraps the installed Codex command directly and only adds terminal-title tracking", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-apron-codex-wrapper-test-"));
  const realCodex = path.join(root, process.platform === "win32" ? "real-codex.cmd" : "real-codex");
  const runtimeDir = path.join(root, "runtime");
  await fs.writeFile(realCodex, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  try {
    const environment = addCodexSessionTrackingToEnvironment(
      { PATH: root, Path: root },
      runtimeDir,
      realCodex
    );
    const wrapperDir = path.join(runtimeDir, ".terminal-apron", "bin");
    const wrappers = await Promise.all(
      ["codex", "codex.cmd", "codex.ps1"].map((name) =>
        fs.readFile(path.join(wrapperDir, name), "utf8")
      )
    );
    assert.equal(environment.PATH?.split(path.delimiter)[0], wrapperDir);
    assert.match(wrappers.join("\n"), /terminal_title/);
    assert.doesNotMatch(wrappers.join("\n"), /--remote|app-server/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("recognizes TUI thread switches and direct Codex CLI launches", () => {
  assert.deepEqual(parseCodexThreadIntent("/new"), { kind: "new" });
  assert.deepEqual(parseCodexThreadIntent("/clear project"), { kind: "new" });
  assert.deepEqual(parseCodexThreadIntent("/fork", THREAD_ID), { kind: "fork" });
  assert.deepEqual(parseCodexThreadIntent("/branch", THREAD_ID), { kind: "fork" });
  assert.deepEqual(parseCodexThreadIntent("/resume"), { kind: "resume" });
  assert.deepEqual(parseCodexThreadIntent("codex"), { kind: "start" });
  assert.deepEqual(parseCodexThreadIntent("exec codex --yolo", THREAD_ID), { kind: "start" });
  assert.deepEqual(parseCodexThreadIntent(`codex resume ${THREAD_ID}`), {
    kind: "resume",
    expectedThreadId: THREAD_ID
  });
  assert.equal(parseCodexThreadIntent("echo codex"), null);
  assert.equal(parseCodexThreadIntent("ordinary prompt"), null);
});

test("selects a newly created local CLI thread for the terminal working directory", () => {
  const submittedAt = Date.now();
  const cwd = path.resolve("tracked-project");
  const current = localThread(THREAD_ID, cwd, submittedAt - 60_000);
  const created = localThread(NEW_THREAD_ID, cwd, submittedAt + 50);
  const unrelated = localThread(OTHER_THREAD_ID, path.resolve("another-project"), submittedAt + 10);

  assert.equal(
    selectCodexThreadForIntent(
      { kind: "new" },
      cwd,
      THREAD_ID,
      submittedAt,
      [current, unrelated, created]
    )?.id,
    NEW_THREAD_ID
  );
  assert.equal(
    selectCodexThreadForIntent(
      { kind: "new" },
      cwd,
      THREAD_ID,
      submittedAt,
      [current]
    ),
    null
  );
});

test("does not confuse a pre-existing recent thread with a newly launched CLI", () => {
  const submittedAt = Date.now();
  const cwd = path.resolve("tracked-project");
  const preExisting = localThread(OTHER_THREAD_ID, cwd, submittedAt - 20);
  const created = localThread(NEW_THREAD_ID, cwd, submittedAt + 50);
  const initialActivity = new Map([[preExisting.id, preExisting.updatedAt]]);

  assert.equal(
    selectCodexThreadForIntent(
      { kind: "start" },
      cwd,
      THREAD_ID,
      submittedAt,
      [preExisting, created],
      initialActivity
    )?.id,
    NEW_THREAD_ID
  );
});

test("honors an explicit CLI resume target", () => {
  const submittedAt = Date.now();
  const target = localThread(NEW_THREAD_ID, path.resolve("other-project"), submittedAt - 86_400_000);
  assert.equal(
    selectCodexThreadForIntent(
      { kind: "resume", expectedThreadId: NEW_THREAD_ID },
      path.resolve("tracked-project"),
      THREAD_ID,
      submittedAt,
      [target]
    )?.id,
    NEW_THREAD_ID
  );
});

test("uses Codex recency when a resume picker activates an existing thread", () => {
  const submittedAt = Date.now();
  const cwd = path.resolve("tracked-project");
  const current = {
    ...localThread(THREAD_ID, cwd, submittedAt - 60_000),
    updatedAt: submittedAt - 10,
    recencyAt: submittedAt - 10
  };
  const resumed = {
    ...localThread(NEW_THREAD_ID, cwd, submittedAt - 86_400_000),
    recencyAt: submittedAt + 20
  };

  assert.equal(
    selectCodexThreadForIntent(
      { kind: "resume" },
      cwd,
      THREAD_ID,
      submittedAt,
      [current, resumed]
    )?.id,
    NEW_THREAD_ID
  );
});

test("reads current CLI conversations directly from Codex's local thread index", async () => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-apron-codex-db-test-"));
  const cwd = path.resolve("tracked-project");
  const database = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  try {
    database.exec(`
      CREATE TABLE threads (
        id TEXT,
        cwd TEXT,
        source TEXT,
        thread_source TEXT,
        created_at_ms INTEGER,
        updated_at_ms INTEGER,
        recency_at_ms INTEGER,
        created_at INTEGER,
        updated_at INTEGER,
        recency_at INTEGER,
        archived INTEGER
      )
    `);
    const insert = database.prepare(`
      INSERT INTO threads (
        id, cwd, source, thread_source,
        created_at_ms, updated_at_ms, recency_at_ms,
        created_at, updated_at, recency_at, archived
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    insert.run(THREAD_ID, cwd, "cli", "user", now - 1_000, now, now, 0, 0, 0, 0);
    insert.run(NEW_THREAD_ID, cwd, "vscode", "user", now, now, now, 0, 0, 0, 0);
    insert.run(OTHER_THREAD_ID, cwd, "cli", "subagent", now, now, now, 0, 0, 0, 0);
  } finally {
    database.close();
  }

  try {
    assert.deepEqual(
      listCodexCliThreads(cwd, codexHome).map((thread) => thread.id),
      [THREAD_ID]
    );
  } finally {
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test("classifies Codex bootstrap failures seen during restart", () => {
  assert.equal(
    classifyCodexBootstrapFailure(
      "failed to initialize sqlite local db: failed to open log DB: database is locked"
    ),
    "database-locked"
  );
  assert.equal(
    classifyCodexBootstrapFailure("failed to load configuration: Model provider `custom` not found"),
    "model-provider-missing"
  );
  assert.equal(
    classifyCodexBootstrapFailure(
      "Error: Failed to resume session: thread/resume failed during TUI bootstrap"
    ),
    "resume-failed"
  );
  assert.equal(classifyCodexBootstrapFailure("OpenAI Codex ready"), null);
});

test("recognizes a tracked thread from Codex's terminal title", () => {
  assert.equal(
    codexTerminalTitleMatchesThread(`[${TITLE_PREFIX}]`, THREAD_ID),
    true
  );
  assert.equal(
    codexTerminalTitleMatchesThread(
      "[019f96dd-0000-7000-8000-00000...]",
      THREAD_ID
    ),
    false
  );
});

test("resolves Codex's ellipsized terminal-title thread prefix", async () => {
  const codexHome = await makeCodexHome();
  try {
    assert.equal(await resolveCodexThreadId(TITLE_PREFIX, codexHome), THREAD_ID);
  } finally {
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test("resolves a thread id embedded in a Codex terminal title", async () => {
  const codexHome = await makeCodexHome();
  try {
    assert.equal(
      await resolveCodexThreadFromTerminalTitle(`Codex [${TITLE_PREFIX}]`, codexHome),
      THREAD_ID
    );
    assert.equal(await resolveCodexThreadFromTerminalTitle("ordinary shell", codexHome), null);
  } finally {
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test("tracks session switches when OSC title sequences are split across PTY chunks", async () => {
  const codexHome = await makeCodexHome();
  const changes: Array<string | null> = [];
  let resolveChange: (() => void) | undefined;
  const changed = new Promise<void>((resolve) => {
    resolveChange = resolve;
  });
  const tracker = new CodexTerminalTitleTracker((threadId) => {
    changes.push(threadId);
    resolveChange?.();
  }, codexHome);

  try {
    tracker.push("screen data\x1b");
    tracker.push(`]2;${TITLE_PREFIX}`);
    tracker.push("\x07more data");
    await changed;
    assert.deepEqual(changes, [THREAD_ID]);

    tracker.push("\x1b]2;\x07");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(changes, [THREAD_ID]);
  } finally {
    tracker.dispose();
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

test("falls back to Codex history for sessions launched before title tracking was installed", async () => {
  const codexHome = await makeCodexHome();
  const prompt = "message after /new";
  const submittedAt = Date.now();
  try {
    await fs.writeFile(
      path.join(codexHome, "history.jsonl"),
      `${JSON.stringify({
        session_id: THREAD_ID,
        ts: Math.floor(submittedAt / 1000),
        text: prompt
      })}\n`,
      "utf8"
    );
    assert.equal(
      await resolveCodexThreadForPrompt(prompt, submittedAt, codexHome),
      THREAD_ID
    );
  } finally {
    await fs.rm(codexHome, { recursive: true, force: true });
  }
});

async function makeCodexHome(): Promise<string> {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "terminal-apron-codex-test-"));
  await fs.writeFile(
    path.join(codexHome, "session_index.jsonl"),
    `${JSON.stringify({ id: THREAD_ID, thread_name: "tracked" })}\n`,
    "utf8"
  );
  return codexHome;
}

function localThread(id: string, cwd: string, createdAt: number): CodexLocalThread {
  return {
    id,
    cwd,
    source: "cli",
    threadSource: "user",
    createdAt,
    updatedAt: createdAt
  };
}
