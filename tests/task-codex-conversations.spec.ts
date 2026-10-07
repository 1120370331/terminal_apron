import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { TaskItem } from "../src/shared/taskTypes";

let taskTitle = "";
let taskId = "";

test.beforeEach(async ({ page, request }, testInfo) => {
  taskTitle = `Browser conversation ${testInfo.project.name} ${Date.now()}`;
  const response = await request.post("/api/tasks", {
    data: { title: taskTitle, repositoryPath: process.cwd() }
  });
  expect(response.ok()).toBeTruthy();
  taskId = (await response.json()).id as string;
  await page.goto("/task-monitor");
  await openTaskConversation(page);
});

test("one click creates a fresh conversation and starts the task with saved defaults", async ({ page, request }) => {
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  const task = await readTask(request, taskId);
  const before = await readConversations(request, taskId);
  expect(before.conversations).toHaveLength(1);
  await page.getByRole("button", { name: "关闭" }).click();

  let terminalCreates = 0;
  page.on("request", (candidate) => {
    if (candidate.method() === "POST" && new URL(candidate.url()).pathname === "/api/sessions") terminalCreates += 1;
  });
  const createResponse = page.waitForResponse((candidate) =>
    candidate.request().method() === "POST"
      && new URL(candidate.url()).pathname === `/api/tasks/${taskId}/conversations`
  );
  const turnResponse = page.waitForResponse((candidate) =>
    candidate.request().method() === "POST"
      && new URL(candidate.url()).pathname.endsWith("/turns")
      && new URL(candidate.url()).pathname.includes(`/api/tasks/${taskId}/conversations/`)
  );

  await page.getByRole("button", { name: /新建对话并开始任务/ }).click();
  const createdResponse = await createResponse;
  const sentResponse = await turnResponse;
  expect(createdResponse.ok()).toBeTruthy();
  expect(sentResponse.ok()).toBeTruthy();

  const created = await createdResponse.json() as { conversation: { threadId: string } };
  const createBody = createdResponse.request().postDataJSON() as Record<string, unknown>;
  const turnBody = sentResponse.request().postDataJSON() as Record<string, unknown>;
  assertOneClickBodies(task, created.conversation.threadId, createBody, sentResponse.url(), turnBody);

  await expect(page.getByRole("dialog", { name: /Codex 对话/ })).toBeVisible();
  await expect(page.getByText("FAKE-CODEX-PONG").last()).toBeVisible();
  await expect.poll(async () => {
    const current = await readConversations(request, taskId);
    return { count: current.conversations.length, primary: current.primaryThreadId };
  }).toEqual({ count: 2, primary: created.conversation.threadId });
  await expect(page.locator(".task-conversation-list-item.active")).toBeVisible();
  expect(terminalCreates).toBe(0);
});

test("opens one-click conversation and paints the task prompt before create or turn completes", async ({ page, request }) => {
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  const task = await readTask(request, taskId);
  const prompt = expectedTaskArrangementPrompt(task);
  await page.getByRole("button", { name: "关闭" }).click();
  const createGate = deferred();
  const turnGate = deferred();
  const createPath = `/api/tasks/${taskId}/conversations`;
  let createRequests = 0;
  let turnRequests = 0;
  await page.route(`**${createPath}`, async (route) => {
    if (route.request().method() === "POST") {
      createRequests += 1;
      await createGate.promise;
    }
    await route.continue();
  });
  await page.route(`**${createPath}/*/turns`, async (route) => {
    turnRequests += 1;
    await turnGate.promise;
    await route.continue();
  });

  await page.getByRole("button", { name: /新建对话并开始任务/ }).click();
  const dialog = page.getByRole("dialog", { name: /Codex 对话/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-optimistic-user="pending"]')).toContainText(prompt);
  expect(createRequests).toBe(1);
  expect(turnRequests).toBe(0);

  createGate.resolve();
  await expect.poll(() => turnRequests).toBe(1);
  await expect(dialog.getByText(prompt, { exact: true })).toHaveCount(1);
  turnGate.resolve();
  await expect(dialog.getByText("FAKE-CODEX-PONG").last()).toBeVisible();
  await expect(dialog.locator('[data-optimistic-user="pending"]')).toHaveCount(0);
  await expect(dialog.getByText(prompt, { exact: true })).toHaveCount(1);
  await page.unroute(`**${createPath}`);
  await page.unroute(`**${createPath}/*/turns`);
});

test("suppresses the optimistic prompt when canonical history arrives first", async ({ page, request }) => {
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  const task = await readTask(request, taskId);
  const prompt = expectedTaskArrangementPrompt(task);
  await page.getByRole("button", { name: "关闭" }).click();
  const turnGate = deferred();
  const detailPattern = `**/api/tasks/${taskId}/conversations/*`;
  await page.route(detailPattern, async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() !== "GET" || !requestUrl.searchParams.has("limit")) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json() as any;
    body.detail.turns = [{
      id: "canonical-first-turn",
      status: "active",
      startedAt: new Date().toISOString(),
      items: [{ kind: "user", id: "canonical-first-user", text: prompt }]
    }];
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/api/tasks/${taskId}/conversations/*/turns`, async (route) => {
    await turnGate.promise;
    await route.continue();
  });

  await page.getByRole("button", { name: /新建对话并开始任务/ }).click();
  const dialog = page.getByRole("dialog", { name: /Codex 对话/ });
  await expect(dialog.getByText(prompt, { exact: true })).toHaveCount(1);
  await expect(dialog.locator('[data-optimistic-user]')).toHaveCount(0);
  await page.unroute(detailPattern);
  turnGate.resolve();
  await expect(dialog.getByText("FAKE-CODEX-PONG").last()).toBeVisible();
  await page.unroute(`**/api/tasks/${taskId}/conversations/*/turns`);
});

test("continues a one-click launch after the panel closes and releases the duplicate guard", async ({ page }) => {
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  await page.getByRole("button", { name: "关闭" }).click();
  const createPath = `/api/tasks/${taskId}/conversations`;
  let creates = 0;
  let turns = 0;
  await page.route(`**${createPath}`, async (route) => {
    if (route.request().method() === "POST") {
      creates += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await route.continue();
  });
  await page.route(`**${createPath}/*/turns`, async (route) => {
    turns += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });

  const action = page.getByRole("button", { name: /新建对话并开始任务/ });
  await action.click();
  const dialog = page.getByRole("dialog", { name: /Codex 对话/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect.poll(() => ({ creates, turns }), { timeout: 15_000 }).toEqual({ creates: 1, turns: 1 });
  await expect(action).toBeEnabled();
  await action.click();
  await expect.poll(() => creates).toBe(2);
  await expect(dialog).toBeVisible();
  await expect.poll(() => turns).toBe(2);
  await expect(action).toBeEnabled({ timeout: 15_000 });
  await page.unroute(`**${createPath}`);
  await page.unroute(`**${createPath}/*/turns`);
});

test("renders regular sends optimistically and restores the composer on failure", async ({ page }) => {
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  const turnPattern = `**/api/tasks/${taskId}/conversations/*/turns`;
  const successGate = deferred();
  await page.route(turnPattern, async (route) => {
    await successGate.promise;
    await route.continue();
  });
  const composer = page.getByPlaceholder(/给 Codex/);
  await composer.fill("OPTIMISTIC-SEND-PONG");
  await composer.press("Enter");
  const pending = page.locator('[data-optimistic-user="pending"]');
  await expect(pending).toContainText("OPTIMISTIC-SEND-PONG");
  await expect(composer).toHaveValue("");
  successGate.resolve();
  await expect(page.getByText("FAKE-CODEX-PONG").last()).toBeVisible();
  await expect(pending).toHaveCount(0);
  await page.unroute(turnPattern);

  const steerPattern = `**/api/tasks/${taskId}/conversations/*/steer`;
  const failOperation = async (route: import("@playwright/test").Route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "FAKE_TURN_FAILURE", message: "Fake turn unavailable" } }) });
  };
  await page.route(turnPattern, failOperation);
  await page.route(steerPattern, failOperation);
  await composer.fill("RESTORE-ON-FAILURE");
  await composer.press("Enter");
  await expect(page.getByText("Fake turn unavailable")).toBeVisible();
  await expect(pending).toHaveCount(0);
  await expect(composer).toHaveValue("RESTORE-ON-FAILURE");
  await page.unroute(turnPattern);
  await page.unroute(steerPattern);
});

test("keeps a repeated optimistic prompt until a new canonical item arrives", async ({ page, request }) => {
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  const repeatedPrompt = "REPEATED-OPTIMISTIC-PROMPT";
  let includeNewCanonical = false;
  const conversationList = await readConversations(request, taskId);
  const currentThreadId = conversationList.primaryThreadId ?? conversationList.conversations[0].threadId;
  const baseDetailResponse = await request.get(`/api/tasks/${taskId}/conversations/${currentThreadId}?limit=50`);
  expect(baseDetailResponse.ok()).toBeTruthy();
  const baseDetailBody = await baseDetailResponse.json() as any;
  const detailPattern = new RegExp(`/api/tasks/${taskId}/conversations/${currentThreadId}\\?limit=`);
  await page.route(detailPattern, async (route) => {
    const body = structuredClone(baseDetailBody);
    body.detail.turns = [
      ...body.detail.turns,
      {
        id: "repeated-prompt-baseline-turn",
        status: "completed",
        startedAt: new Date().toISOString(),
        items: [{ kind: "user", id: "repeated-prompt-baseline-user", text: repeatedPrompt }]
      },
      ...(includeNewCanonical ? [{
        id: "repeated-prompt-new-turn",
        status: "completed",
        startedAt: new Date().toISOString(),
        items: [{ kind: "user", id: "repeated-prompt-new-user", text: repeatedPrompt }]
      }] : [])
    ];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await sendMessage(page, repeatedPrompt);
  const canonicalMessages = page.locator('.task-message.user:not([data-optimistic-user])').filter({ hasText: repeatedPrompt });
  await expect(canonicalMessages).toHaveCount(1);

  const turnPattern = `**/api/tasks/${taskId}/conversations/*/turns`;
  const secondTurnGate = deferred();
  await page.route(turnPattern, async (route) => {
    await secondTurnGate.promise;
    await route.continue();
  });
  const secondTurnResponse = page.waitForResponse((candidate) =>
    candidate.request().method() === "POST"
      && new URL(candidate.url()).pathname.includes(`/api/tasks/${taskId}/conversations/`)
      && new URL(candidate.url()).pathname.endsWith("/turns")
  );

  await sendMessage(page, repeatedPrompt);
  await expect(page.locator('[data-optimistic-user="pending"]').filter({ hasText: repeatedPrompt })).toHaveCount(1);
  await expect(page.locator(".task-message.user").filter({ hasText: repeatedPrompt })).toHaveCount(2);

  includeNewCanonical = true;
  secondTurnGate.resolve();
  expect((await secondTurnResponse).ok()).toBeTruthy();
  await expect(canonicalMessages).toHaveCount(2);
  await expect(page.locator('[data-optimistic-user]').filter({ hasText: repeatedPrompt })).toHaveCount(0);
  await page.unroute(turnPattern);
  await page.unroute(detailPattern);
});

test("suppresses duplicate one-click starts while creation is in flight", async ({ page }) => {
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  await page.getByRole("button", { name: "关闭" }).click();
  const createBodies: Array<Record<string, unknown>> = [];
  let turns = 0;
  const createPath = `/api/tasks/${taskId}/conversations`;
  page.on("request", (candidate) => {
    const requestPath = new URL(candidate.url()).pathname;
    if (candidate.method() === "POST" && requestPath === createPath) createBodies.push(candidate.postDataJSON() as Record<string, unknown>);
    if (candidate.method() === "POST" && requestPath.startsWith(`${createPath}/`) && requestPath.endsWith("/turns")) turns += 1;
  });
  await page.route(`**${createPath}`, async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await route.continue();
  });

  const action = page.getByRole("button", { name: /新建对话并开始任务/ });
  await action.evaluate((button) => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await expect(page.getByText("FAKE-CODEX-PONG").last()).toBeVisible();
  expect(createBodies).toHaveLength(1);
  expect(turns).toBe(1);
  await page.unroute(`**${createPath}`);
});

test("keeps and opens a fresh conversation when the initial task turn fails", async ({ page, request }) => {
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  const task = await readTask(request, taskId);
  await page.getByRole("button", { name: "关闭" }).click();
  let creates = 0;
  let capturedTurnBody: Record<string, unknown> | undefined;
  let capturedTurnUrl = "";
  page.on("request", (candidate) => {
    if (candidate.method() === "POST" && new URL(candidate.url()).pathname === `/api/tasks/${taskId}/conversations`) creates += 1;
  });
  await page.route(`**/api/tasks/${taskId}/conversations/*/turns`, async (route) => {
    capturedTurnUrl = route.request().url();
    capturedTurnBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "FAKE_TURN_FAILURE", message: "Fake turn unavailable" } })
    });
  });
  const createResponse = page.waitForResponse((candidate) =>
    candidate.request().method() === "POST"
      && new URL(candidate.url()).pathname === `/api/tasks/${taskId}/conversations`
  );

  await page.getByRole("button", { name: /新建对话并开始任务/ }).click();
  const createdResponse = await createResponse;
  const created = await createdResponse.json() as { conversation: { threadId: string } };
  const createBody = createdResponse.request().postDataJSON() as Record<string, unknown>;
  await expect(page.getByRole("dialog", { name: /Codex 对话/ })).toBeVisible();
  await expect(page.getByText("已创建新对话，但任务指令发送失败：Fake turn unavailable")).toBeVisible();
  assertOneClickBodies(task, created.conversation.threadId, createBody, capturedTurnUrl, capturedTurnBody ?? {});
  await expect.poll(async () => {
    const current = await readConversations(request, taskId);
    return { count: current.conversations.length, primary: current.primaryThreadId };
  }).toEqual({ count: 2, primary: created.conversation.threadId });
  expect(creates).toBe(1);
});

test("recovers a failed one-click turn after the panel closes and allows another start", async ({ page, request }) => {
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  const task = await readTask(request, taskId);
  const prompt = expectedTaskArrangementPrompt(task);
  await page.getByRole("button", { name: "关闭" }).click();

  const createPath = `/api/tasks/${taskId}/conversations`;
  const turnPattern = `**${createPath}/*/turns`;
  const failureGate = deferred();
  let creates = 0;
  let turns = 0;
  page.on("request", (candidate) => {
    const requestPath = new URL(candidate.url()).pathname;
    if (candidate.method() === "POST" && requestPath === createPath) creates += 1;
    if (candidate.method() === "POST" && requestPath.startsWith(`${createPath}/`) && requestPath.endsWith("/turns")) turns += 1;
  });
  await page.route(turnPattern, async (route) => {
    await failureGate.promise;
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "FAKE_TURN_FAILURE", message: "Fake turn unavailable" } })
    });
  });

  const action = page.getByRole("button", { name: /新建对话并开始任务/ });
  const createResponse = page.waitForResponse((candidate) =>
    candidate.request().method() === "POST" && new URL(candidate.url()).pathname === createPath
  );
  await action.click();
  const createdResponse = await createResponse;
  const created = await createdResponse.json() as { conversation: { threadId: string } };
  const dialog = page.getByRole("dialog", { name: /Codex 对话/ });
  await expect.poll(() => turns).toBe(1);
  await dialog.getByRole("button", { name: "关闭" }).click();
  failureGate.resolve();
  await expect(action).toBeEnabled();

  const selectedThreadDetail = page.waitForResponse((candidate) => {
    const requestUrl = new URL(candidate.url());
    return candidate.request().method() === "GET"
      && requestUrl.pathname === `${createPath}/${created.conversation.threadId}`
      && requestUrl.searchParams.has("limit");
  });
  await openTaskConversation(page);
  expect((await selectedThreadDetail).ok()).toBeTruthy();
  await expect(page.getByText("已创建新对话，但任务指令发送失败：Fake turn unavailable")).toBeVisible();
  await expect(page.getByPlaceholder(/给 Codex/)).toHaveValue(prompt);
  await expect(page.locator(".task-conversation-list-item.active")).toBeVisible();
  await expect(action).toBeEnabled();
  await expect.poll(async () => (await readConversations(request, taskId)).primaryThreadId).toBe(created.conversation.threadId);

  await dialog.getByRole("button", { name: "关闭" }).click();
  await page.unroute(turnPattern);
  await action.click();
  await expect.poll(() => ({ creates, turns }), { timeout: 15_000 }).toEqual({ creates: 2, turns: 2 });
  await expect(page.getByText("FAKE-CODEX-PONG").last()).toBeVisible();
  await expect(action).toBeEnabled({ timeout: 15_000 });
});

test("configures the same model reasoning and permission defaults from the Task list and inspector", async ({ page, request }) => {
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  const task = await readTask(request, taskId);
  await page.getByRole("button", { name: "关闭" }).click();
  let terminalCreates = 0;
  page.on("request", (candidate) => {
    if (candidate.method() === "POST" && new URL(candidate.url()).pathname === "/api/sessions") terminalCreates += 1;
  });

  const row = page.locator("article.task-table-row").filter({ hasText: taskTitle }).first();
  await row.getByRole("button", { name: `${task.key} Codex 默认设置` }).click();
  const dialog = page.getByRole("dialog", { name: new RegExp(`${task.key}.*Codex 默认设置`) });
  await expect(dialog).toBeVisible();
  const selects = dialog.locator("select");
  await selects.nth(0).selectOption("fake-codex");
  await expect(selects.nth(1).locator('option[value="xhigh"]')).toHaveAttribute("disabled", "");
  await selects.nth(1).selectOption("high");
  await selects.nth(2).selectOption("workspace_write");
  const savedResponse = page.waitForResponse((candidate) =>
    candidate.request().method() === "PATCH"
      && new URL(candidate.url()).pathname === `/api/tasks/${taskId}/conversations/preferences`
  );
  await dialog.getByRole("button", { name: "保存默认设置" }).click();
  const response = await savedResponse;
  expect(response.ok()).toBeTruthy();
  expect(response.request().postDataJSON()).toMatchObject({
    defaultModel: "fake-codex",
    defaultReasoningEffort: "high",
    defaultPermissionPreset: "workspace_write",
    revision: 0
  });
  await expect(dialog.getByText("已保存到此 Task")).toBeVisible();
  await dialog.getByRole("button", { name: "关闭默认设置" }).click();

  await page.reload();
  await page.getByPlaceholder("搜索任务、项目、标签或仓库").fill(taskTitle);
  const reloadedRow = page.locator("article.task-table-row").filter({ hasText: taskTitle }).first();
  await reloadedRow.click();
  await page.locator(".task-inspector-actions").getByRole("button", { name: `${task.key} Codex 默认设置` }).click();
  const inspectorDialog = page.getByRole("dialog", { name: new RegExp(`${task.key}.*Codex 默认设置`) });
  await expect(inspectorDialog.locator("select").nth(0)).toHaveValue("fake-codex");
  await expect(inspectorDialog.locator("select").nth(1)).toHaveValue("high");
  await expect(inspectorDialog.locator("select").nth(2)).toHaveValue("workspace_write");
  await inspectorDialog.getByRole("button", { name: "关闭默认设置" }).click();

  await reloadedRow.getByRole("button", { name: "Codex 对话" }).click();
  const inlineDefaults = page.locator(".task-defaults-inline");
  await expect(inlineDefaults.locator("select").nth(0)).toHaveValue("fake-codex");
  await expect(inlineDefaults.locator("select").nth(1)).toHaveValue("high");
  await expect(inlineDefaults.locator("select").nth(2)).toHaveValue("workspace_write");
  expect(terminalCreates).toBe(0);
});

test("create, send, approve and persist conversation without a Terminal", async ({ page }, testInfo) => {
  const marks: Record<string, number> = {};
  const started = Date.now();
  await expect(page.getByRole("dialog", { name: /Codex 对话/ })).toBeVisible();
  marks.shell = Date.now() - started;

  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  marks.controls = Date.now() - started;

  await sendMessage(page, "QA-DIRECT-PONG");
  await expect(page.getByText("QA-DIRECT-PONG").last()).toBeVisible();
  marks.firstHistory = Date.now() - started;

  await page.reload();
  await openTaskConversation(page);
  await expect(page.getByText("QA-DIRECT-PONG").last()).toBeVisible();

  await sendMessage(page, "NEED_APPROVAL_COMMAND");
  await expect(page.getByText("Codex 请求执行命令")).toBeVisible();
  await page.getByRole("button", { name: "拒绝" }).click();
  await expect(page.getByText("Codex 请求执行命令")).toHaveCount(0);

  await sendMessage(page, "NEED_APPROVAL_COMMAND FILE_CHANGE");
  await expect(page.getByText("Codex 请求修改文件")).toBeVisible();
  await page.getByRole("button", { name: "允许一次" }).click();
  await expect(page.getByText(/APPROVAL_OK accept/).last()).toBeVisible();
  marks.complete = Date.now() - started;

  const evidence = path.resolve(".local-test-data/task-conversation-browser", `${testInfo.project.name}-marks.json`);
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  fs.writeFileSync(evidence, JSON.stringify(marks, null, 2));
  await page.screenshot({
    path: path.resolve(".local-test-data/task-conversation-browser", `${testInfo.project.name}-conversation.png`),
    fullPage: true
  });

  expect(marks.shell).toBeLessThanOrEqual(500);
  expect(marks.controls).toBeLessThanOrEqual(1000);
  expect(marks.firstHistory).toBeLessThanOrEqual(4000);
});

test("interrupts a running turn and continues when the completion event is missed", async ({ page }) => {
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  await sendMessage(page, "LONG_RUNNING SILENT_INTERRUPT");
  await expect(page.getByRole("button", { name: "中断", exact: true })).toBeVisible();
  await sendMessage(page, "QA-STEERED");
  await page.getByRole("button", { name: "中断", exact: true }).click();
  await expect(page.getByRole("button", { name: "中断", exact: true })).toHaveCount(0);
  await sendMessage(page, "QA-DIRECT-PONG AFTER INTERRUPT");
  await expect(page.getByText("QA-DIRECT-PONG").last()).toBeVisible();
});

test("renames and archives a conversation from the workspace", async ({ page, request }) => {
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  const before=(await (await request.get(`/api/tasks/${taskId}/conversations`)).json()).conversations[0].threadId as string;
  page.once("dialog", (dialog) => dialog.accept("Renamed browser thread"));
  const renamed = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/conversations/"));
  await page.locator('button[title="重命名"]').click();
  expect((await renamed).ok()).toBeTruthy();
  await expect(page.getByText("Renamed browser thread", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  const archived = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/archive"));
  await page.locator(".task-conversation-list-item").getByRole("button", { name: "×" }).click();
  expect((await archived).ok()).toBeTruthy();
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  await expect(page.getByText("创建第一个对话")).toHaveCount(0);
  await expect.poll(async()=>{const list=await (await request.get(`/api/tasks/${taskId}/conversations`)).json() as any;return list.conversations[0]?.threadId;}).not.toBe(before);
});

test("shows slow-history recovery actions without blocking the conversation shell", async ({ page }) => {
  const delayFile = path.resolve(".local-test-data/task-conversation-browser/data/fake-thread-read-delay-ms");
  fs.mkdirSync(path.dirname(delayFile), { recursive: true });
  fs.writeFileSync(delayFile, "2500");
  try {
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept("SLOW_HISTORY"));
  const renamed = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/conversations/"));
  await page.locator('button[title="重命名"]').click();
  expect((await renamed).ok()).toBeTruthy();
  await page.reload();
  await openTaskConversation(page);
  const composer = page.getByPlaceholder(/给 Codex/);
  await expect(composer).toBeDisabled();
  await expect(page.getByText("历史加载较慢")).toBeVisible();
  await expect(page.locator(".task-conversation-skeleton").getByRole("button", { name: "重新加载" })).toBeVisible();
  await expect(page.locator(".task-conversation-skeleton").getByRole("button", { name: "高级终端" })).toBeVisible();
  await expect(composer).toBeEnabled({ timeout: 5_000 });
  } finally {
    fs.writeFileSync(delayFile, "0");
  }
});

test("meets warm reload budgets with 20 conversations and 500 projected items", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "The fixed performance profile is desktop Chromium.");
  await page.getByRole("button", { name: "关闭" }).click();
  for (let index = 1; index <= 19; index += 1) {
    const response = await request.post(`/api/tasks/${taskId}/conversations`, {
      data: { clientMessageId: crypto.randomUUID(), displayName: `Performance ${index}` }
    });
    expect(response.ok()).toBeTruthy();
  }
  await page.reload();
  await openTaskConversation(page);
  await sendMessage(page, "SEED_HISTORY_500");
  await expect(page.locator('.task-message:not([data-optimistic-user])')).toHaveCount(500, { timeout: 5_000 });
  await page.goto("/task-monitor");

  const samples: Array<{ shell: number; controls: number; first50: number; all500: number }> = [];
  for (let run = 0; run < 12; run += 1) {
    await page.goto("/task-monitor");
    await page.getByPlaceholder("搜索任务、项目、标签或仓库").fill(taskTitle);
    await page.getByText(taskTitle, { exact: true }).first().click();
    const started = Date.now();
    const conversationButton = page.getByRole("button", { name: "Codex 对话" }).first();
    await conversationButton.waitFor();
    await conversationButton.click();
    await expect(page.locator(".task-conversation-panel")).toBeVisible();
    const shell = Date.now() - started;
    await expect(page.getByPlaceholder(/给 Codex/)).toBeEnabled();
    const controls = Date.now() - started;
    await expect(page.locator(".task-message")).toHaveCount(500);
    const all500 = Date.now() - started;
    const first50 = all500;
    if (run >= 2) samples.push({ shell, controls, first50, all500 });
  }
  const summary = {
    profile: { conversations: 20, turns: 50, projectedItems: 500, warmups: 2, runs: 10 },
    p50: percentileRecord(samples, 0.5),
    p95: percentileRecord(samples, 0.95),
    samples
  };
  const evidence = path.resolve(".local-test-data/task-conversation-browser/performance.json");
  fs.writeFileSync(evidence, JSON.stringify(summary, null, 2));
  expect(summary.p95.shell).toBeLessThanOrEqual(500);
  expect(summary.p95.controls).toBeLessThanOrEqual(1_000);
  expect(summary.p95.first50).toBeLessThanOrEqual(1_500);
  expect(summary.p95.all500).toBeLessThanOrEqual(3_000);
});

test("creates exactly one default conversation on first open and none on warm reopen",async({page,request})=>{
  await page.getByRole("button",{name:"关闭"}).click();
  taskTitle=`Automatic default ${Date.now()}`;
  const created=await request.post("/api/tasks",{data:{title:taskTitle,repositoryPath:process.cwd()}});expect(created.ok()).toBeTruthy();taskId=(await created.json()).id as string;
  await page.goto("/task-monitor");let defaultPosts=0;
  page.on("request",(req)=>{if(req.method()==="POST"&&req.url().endsWith(`/api/tasks/${taskId}/conversations/default`))defaultPosts++;});
  await openTaskConversation(page);
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  await expect(page.locator(".task-conversation-list-item")).toHaveCount(1);
  expect(defaultPosts).toBe(1);
  await page.reload();await openTaskConversation(page);await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
  expect(defaultPosts).toBe(1);
});

test("shows retry UI without a placeholder when default creation fails",async({page,request})=>{
  await page.getByRole("button",{name:"关闭"}).click();
  taskTitle=`Default retry ${Date.now()}`;
  const created=await request.post("/api/tasks",{data:{title:taskTitle,repositoryPath:process.cwd()}});expect(created.ok()).toBeTruthy();taskId=(await created.json()).id as string;
  await page.route(`**/api/tasks/${taskId}/conversations/default`,async(route)=>route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:{code:"DEFAULT_CONVERSATION_PENDING",message:"Default pending"}})}));
  await page.goto("/task-monitor");await openTaskConversation(page);
  await expect(page.getByText("Default pending")).toBeVisible();
  await expect(page.getByText("创建第一个对话")).toHaveCount(0);
  await expect(page.getByPlaceholder(/给 Codex/)).toHaveCount(0);
  await page.unroute(`**/api/tasks/${taskId}/conversations/default`);
  await page.getByRole("button",{name:"重新连接"}).last().click();
  await expect(page.getByPlaceholder(/给 Codex/)).toBeVisible();
});

async function openTaskConversation(page: import("@playwright/test").Page): Promise<void> {
  await page.getByPlaceholder("搜索任务、项目、标签或仓库").fill(taskTitle);
  const row=page.locator("article.task-table-row").filter({hasText:taskTitle}).first();
  await row.getByRole("button", { name: "Codex 对话" }).click();
  await expect(page.getByRole("dialog", { name: /Codex 对话/ })).toBeVisible();
}

async function sendMessage(page: import("@playwright/test").Page, text: string): Promise<void> {
  const composer = page.getByPlaceholder(/给 Codex/);
  await composer.fill(text);
  await composer.press("Enter");
}

async function readTask(request: import("@playwright/test").APIRequestContext, id: string): Promise<TaskItem> {
  const response = await request.get(`/api/tasks/${id}`);
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<TaskItem>;
}

async function readConversations(
  request: import("@playwright/test").APIRequestContext,
  id: string
): Promise<{ conversations: Array<{ threadId: string }>; primaryThreadId?: string }> {
  const response = await request.get(`/api/tasks/${id}/conversations`);
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<{ conversations: Array<{ threadId: string }>; primaryThreadId?: string }>;
}

function assertOneClickBodies(
  task: TaskItem,
  createdThreadId: string,
  createBody: Record<string, unknown>,
  turnUrl: string,
  turnBody: Record<string, unknown>
): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  expect(createBody.clientMessageId).toEqual(expect.stringMatching(uuid));
  expect(createBody).not.toHaveProperty("model");
  expect(new URL(turnUrl).pathname).toBe(`/api/tasks/${task.id}/conversations/${createdThreadId}/turns`);
  expect(turnBody.clientMessageId).toEqual(expect.stringMatching(uuid));
  expect(turnBody.clientMessageId).not.toBe(createBody.clientMessageId);
  expect(turnBody.text).toBe(expectedTaskArrangementPrompt(task));
  expect(turnBody).not.toHaveProperty("model");
  expect(turnBody).not.toHaveProperty("effort");
  expect(turnBody).not.toHaveProperty("permissionPreset");
}

function expectedTaskArrangementPrompt(task: TaskItem): string {
  return [
    `请使用 $manage-terminal-apron-tasks 读取并处理 ${task.key}。`,
    "先执行 Skill 的 context 和 start 流程，检查任务描述、验收标准、项目目录与全部截图，再开始修改代码。",
    "每个关键里程碑都通过 Skill 汇报；需要我做决定或确认时必须使用 Skill 的 confirm 流程并暂停；完成后提交验证证据并进入待自动验收。"
  ].join("\n");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function percentileRecord(samples: Array<Record<string, number>>, percentile: number): Record<string, number> {
  return Object.fromEntries(Object.keys(samples[0]).map((key) => {
    const values = samples.map((sample) => sample[key]).sort((left, right) => left - right);
    return [key, values[Math.min(values.length - 1, Math.ceil(values.length * percentile) - 1)]];
  }));
}
