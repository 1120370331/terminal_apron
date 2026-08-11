# TaskMonitor 开发计划

> 状态：单服务双入口 MVP v0.6 已落地，完整租约与 AI 拆解调度阶段待开发
> 创建日期：2026-08-10
> 目标项目：Terminal Apron

当前 MVP 已完成：3131 同一服务内的独立 TaskMonitor 页面、按项目纵向分框的任务视图、项目列表与代码库根目录、Markdown 编辑/安全预览、Ctrl+V 内嵌截图、字段手工更新、搜索筛选、归档恢复、每用户 SQLite、结构化 Codex 汇报 API、任务变更 SSE 实时同步，以及能下载并查看任务附图的项目内 `$manage-terminal-apron-tasks` Skill。Task Terminal 不再维护仿制终端面板，直接复用 Terminal Monitor 的 `SessionCard`、`SessionEditor`、ANSI/Canvas 预览、Quick Input、文件粘贴和 `TerminalDock`/Socket.IO/xterm。v0.6 加入一键安排 MVP：自动创建并关联 Task Terminal、启动 `codex --yolo`、等待 Codex 进入可对话状态并发送 Skill 任务指令；任务页根据进程与输出区分未启动、工作中、重连、异常、需确认和已完成。Skill CLI 通过 `TASK_MONITOR_STATE` 标记稳定暴露工作、需确认和完成状态。完整 Launch 租约、工作项依赖图、Git worktree 隔离和 OpenAI Compatible 调度器仍按本文后续阶段实施。

> 2026-08-10 架构修订：Terminal Monitor 与 TaskMonitor 是两个独立界面模式，不是两个服务进程。二者由同一个 3131 Node/Express 进程提供；`/` 保留原 Terminal 入口，`/task-monitor/` 使用独立 HTML、React 入口、构建目录和 CSS。TaskMonitor 只在服务端共用认证、每用户数据目录和 API 基础设施，不向 Terminal 前端导入任何 TaskMonitor 组件或样式。

## 1. 目标与总体原则

TaskMonitor 是与现有 Terminal Monitor 并列、前端边界独立的界面模式，用于创建、规划、发射、执行和追踪开发任务。两个模式共用一个 3131 服务进程。

核心原则：

- TaskMonitor 负责任务、计划、进度、附件和执行记录。
- Launch Coordinator 负责 Terminal 分配、并发上限、Codex 启动、暂停、恢复与释放。
- AI Scheduler 负责生成和调整结构化计划，不直接操作数据库或执行任意模型输出的命令。
- Codex Skill 通过受限 Agent API 更新任务，不直接读写 SQLite。
- 多个 Codex 并行开发时默认使用独立 Git worktree，避免共享工作树导致代码互相覆盖。
- 保留现有 Terminal Monitor 的运行模型和数据，TaskMonitor 不以迁移全部终端数据为前置条件。
- 原 Terminal 客户端入口、组件、样式和 Zellij 运行模型保持原样；TaskMonitor 通过同一 3131 服务的 `/task-monitor/` 独立入口访问。

## 2. 当前仓库现状与约束

当前项目采用 React、Express、Socket.IO、Zellij：

- 前端主要集中在 `src/client/App.tsx`，文件已经较大，TaskMonitor 不应继续直接堆入该组件。
- 后端路由和终端编排主要集中在 `src/server/index.ts`。
- Terminal Session 当前按用户保存在 `sessions.json`，由 `src/server/db.ts` 中的 `SessionStore` 管理。
- 项目已经具备 Codex thread 识别、跟踪和 `resume --yolo` 恢复能力，主要位于 `src/server/codexSessions.ts`。
- Terminal 创建后会自动启动 Zellij Session；TaskMonitor 需要通过复用的 Terminal Service 操作它，而不是复制路由内部逻辑。
- 当前多用户模型是每个用户对应独立 data directory，TaskMonitor 必须延续相同的数据隔离规则。

技术决策：

- 保留现有 `sessions.json`，避免 TaskMonitor 首版引入终端存储迁移风险。
- TaskMonitor 单独使用每用户 SQLite 数据库。
- TaskMonitor 使用 `task-monitor.html`、`vite.task-monitor.config.ts` 和 `dist/task-monitor-client` 形成独立前端构建；不导入原 Terminal React 入口或 CSS。
- TaskMonitor 路由、服务和调度逻辑拆到独立模块，由 `src/server/index.ts` 仅负责把 `/api/tasks` 和 `/task-monitor/` 挂到同一个 Express 进程。
- 只抽取 Launch Coordinator 必须复用的 Terminal Service，不在首版重写整个 Terminal Monitor。
- 若使用内置 `node:sqlite`，正式运行时统一 Node.js 版本到 Node 24；如果必须继续支持 Node 20，则改用经过评估的 SQLite 第三方驱动。

## 3. 总体架构

```text
Browser / ───────────────► Terminal UI bundle
    │
    └─ Browser /task-monitor/ ─► TaskMonitor UI bundle
                    │
                    ▼
          Terminal Apron Express :3131
             ├── shared auth and per-user data directory
             ├── Terminal API / Socket.IO ─► Zellij
             └── /api/tasks ───────────────► task-monitor.sqlite
                         │
                         ├── SchedulerProvider ─► DeepSeek / OpenAI Compatible
                         ├── LaunchCoordinator ─► TerminalService ─► Codex
                         └◄── Agent API ◄── Codex Task Skill ◄──目标代码仓库
```

建议模块结构：

```text
src/shared/
└── taskTypes.ts

src/client/
├── taskMonitorMain.tsx
└── task-monitor/
    ├── TaskMonitorApp.tsx
    ├── TaskMonitorPage.tsx
    ├── TaskTable.tsx
    ├── TaskBoard.tsx
    ├── TaskEditor.tsx
    ├── TaskDetailDrawer.tsx
    ├── LaunchTaskDialog.tsx
    ├── TerminalAssignmentPicker.tsx
    ├── PlanEditor.tsx
    ├── ExecutionPanel.tsx
    └── ActivityTimeline.tsx

src/server/
├── terminalService.ts
├── tasks/
│   ├── taskDb.ts
│   ├── migrations.ts
│   ├── taskRepository.ts
│   ├── taskService.ts
│   ├── taskRouter.ts
│   └── attachmentService.ts
├── scheduler/
│   ├── schedulerProvider.ts
│   ├── openAiCompatibleProvider.ts
│   ├── repoContextBuilder.ts
│   ├── planValidator.ts
│   ├── launchCoordinator.ts
│   └── schedulerJobRunner.ts
└── agent/
    ├── agentRouter.ts
    └── agentTokenService.ts
```

## 4. TaskMonitor 产品界面

### 4.1 独立入口

TaskMonitor 通过同一服务的独立地址 `http://127.0.0.1:3131/task-monitor/` 访问。原 `/` 页面仅在现有工具栏增加“任务”跳转入口，不增加 TaskMonitor 页面状态或全局样式；TaskMonitor 顶栏提供“终端”返回入口。两个 Vite 入口互不导入组件和 CSS。后续深链接统一保留在 `/task-monitor/` 命名空间：

```text
/task-monitor/tasks
/task-monitor/tasks/:taskId
/task-monitor/tasks/:taskId/launches/:launchId
```

### 4.2 任务安排表

默认提供类似飞书任务或 Notion Database 的表格视图，字段包括：

- 编号，例如 `TA-42`
- 归属项目；允许暂时未归属
- 任务名称
- 处理进度：未开始、进行中、待自动验收、待人工验收、已完成、阻塞
- 优先级：P0、P1、P2、P3
- 难度：1–5
- 标签
- 目标仓库
- 已分配 Terminal 数
- 创建时间
- 更新时间
- 发射按钮

支持：

- 表格内直接修改处理进度、优先级和难度；创建时间可在任务编辑器中人工校正。
- 按项目、处理进度、优先级、难度、标签、仓库筛选。
- 按创建时间、更新时间、优先级排序。
- 关键词搜索标题和描述。
- 表格视图与看板视图切换。
- 软归档和恢复，不默认提供不可恢复的硬删除。

任务进度使用离散阶段而非百分比。Codex 开始工作时进入“进行中”，提交开发结果后进入“待自动验收”；自动验收通过后进入“待人工验收”，只有人工确认后才进入“已完成”。任何阶段都可转为“阻塞”。

### 4.3 快速创建任务

创建表单包含：

- 任务名称
- Markdown 描述
- 验收标准
- 截图与附件
- 优先级
- 难度
- 标签
- 目标代码仓库，可延迟到发射时填写

Markdown 编辑器建议使用 CodeMirror 6、`react-markdown`、`remark-gfm` 和 `rehype-sanitize`，支持：

- 编辑、预览和分栏模式。
- 常用 Markdown 工具栏。
- 粘贴或拖放截图。
- 自动插入图片 Markdown。
- GFM 表格、任务列表和代码块。
- 自动保存草稿和未保存状态提示。
- 禁止默认渲染原始 HTML，避免存储型 XSS。

### 4.4 任务详情

任务详情分为：

- 概览：描述、验收标准和任务属性。
- 计划：AI 拆解出的工作项和依赖关系。
- 执行：每个 Terminal/Codex 的当前任务和状态。
- 动态：人工修改、Codex 汇报和调度事件。
- 附件：截图、日志、测试结果和其他产物。
- 历史：字段变更、计划版本和 Launch 历史。

任务运行期间修改需求时，必须让用户选择：

- 仅更新任务描述，不影响当前 Launch。
- 应用到当前执行并触发重新规划。
- 留到下一次 Launch。

活动 Launch 必须保留启动时的任务快照和计划版本，防止执行目标静默漂移。

### 4.5 Terminal Monitor 联动

被 TaskMonitor 占用的 Terminal 在 Terminal Monitor 中显示任务徽标，例如 `TA-42`，并支持：

- 从 Terminal 卡片跳转到任务。
- 从任务执行面板打开真实 TerminalDock。
- 按任务筛选 Terminal。
- 显示当前工作项和最近一次 Codex 汇报。
- 防止同一 Terminal 同时被两个活动 Launch 占用。

## 5. 数据模型

每个用户使用独立数据库：

```text
<dataDirForUser>/task-monitor.sqlite
```

### 5.1 `tasks`

主要字段：

- `id`：UUID。
- `task_key`：面向用户的编号，例如 `TA-42`。
- `project`：一级项目归属；空字符串表示暂未归属。Schema v4 通过独立 `task_projects` 表维护项目及其根目录。
- `title`。
- `description_md`。
- `acceptance_criteria_md`。
- `status`。
- `priority`。
- `difficulty`。
- `repository_path`。
- `repository_revision`。
- `max_concurrency`。
- `revision`：乐观锁版本。
- `created_at`、`updated_at`、`archived_at`、`completed_at`。

任务处理进度：

```text
not_started
in_progress
pending_auto_acceptance
pending_manual_acceptance
done
blocked
```

任务状态与 Launch 状态分开保存，避免一个任务的多次执行互相覆盖。

### 5.2 `task_projects`

- `name`：大小写不敏感唯一的项目名称。
- `root_directory`：人工选择并由后端校验的绝对文件夹路径。
- `created_at`、`updated_at`。

任务选择项目后，默认继承该项目的 `root_directory` 作为 `repository_path`。旧任务的非空项目名会在 Schema v4 迁移时自动导入。

### 5.3 `task_attachments`

保存：

- 任务 ID。
- 文件名和安全显示名。
- MIME 类型。
- 文件大小。
- SHA-256。
- 相对存储路径。
- 图片宽高。
- 上传者和时间。

实际文件存储在：

```text
<dataDirForUser>/task-attachments/<taskId>/
```

数据库不保存大文件内容，也不向浏览器暴露真实磁盘路径。

### 5.4 `task_launches`

保存每次发射的：

- 任务快照和计划版本。
- 调度模式。
- Provider 配置引用。
- 最大并发数。
- Git/worktree 策略。
- Launch 状态和错误。
- 开始、暂停、完成和取消时间。

建议 Launch 状态：

```text
draft
planning
ready
launching
running
paused
review
completed
failed
cancelled
```

### 5.5 `task_work_items`

每个工作项包括：

- 标题和目标。
- 详细执行说明。
- 验收标准。
- 允许修改的文件或模块。
- 验证命令。
- 优先级和难度。
- 进度权重。
- 状态。
- 分配的 Terminal slot。
- 开始和完成时间。

建议工作项状态：

```text
queued
assigned
running
blocked
review
done
failed
cancelled
```

### 5.6 `work_item_dependencies`

保存工作项依赖关系，计划生效前必须检查依赖图无环。

### 5.7 `task_terminal_slots`

保存：

- Launch ID。
- Terminal Session ID。
- Slot 编号。
- 角色：Coordinator、Worker、Reviewer。
- 当前工作项。
- Codex thread ID。
- Slot 状态。
- 最近活动和最后一次汇报时间。
- Token 版本和释放时间。

建议 Slot 状态：

```text
reserved
starting
idle
busy
stale
failed
released
```

需要用数据库约束确保同一 Terminal 只能存在一个未释放的活动分配。

### 5.8 `task_reports`

保存 Codex 的结构化汇报：

- 状态。
- 摘要。
- 修改文件。
- 验证命令和结果。
- 风险。
- 阻塞项。
- 下一步。
- 关联工作项和 Codex thread。
- 幂等请求 ID。

### 5.9 `task_events`

保存完整审计历史，actor 类型包括：

- user
- worker-codex
- coordinator-codex
- scheduler
- system

### 5.10 `scheduler_jobs`

实现可恢复的数据库任务队列，字段包括状态、尝试次数、租约持有者、租约到期时间和幂等键。服务重启后可以重新接管过期租约，但不得重复分发已经开始的工作项。

### 5.11 `model_providers`

保存：

- 显示名称。
- Base URL。
- 模型名。
- Endpoint 模式。
- 超时和重试配置。
- API Key 的加密引用或环境变量名。
- 能力标记，例如 JSON 输出支持情况。

数据库使用 WAL、事务、迁移版本、`busy_timeout` 和 `revision` 乐观锁。

## 6. 后端 API

### 6.1 Web 任务接口

| 接口 | 功能 |
|---|---|
| `GET /api/tasks` | 查询、筛选、排序和分页 |
| `POST /api/tasks` | 创建任务 |
| `GET /api/tasks/:id` | 获取任务详情 |
| `PATCH /api/tasks/:id` | 修改任务，携带 revision |
| `POST /api/tasks/:id/archive` | 软归档 |
| `POST /api/tasks/:id/restore` | 恢复归档任务 |
| `POST /api/tasks/:id/attachments` | 上传截图或附件 |
| `GET /api/tasks/:id/attachments/:attachmentId/content` | 认证下载 |
| `DELETE /api/tasks/:id/attachments/:attachmentId` | 删除附件引用 |
| `GET /api/tasks/:id/activity` | 动态和汇报记录 |
| `POST /api/tasks/:id/plans` | 生成计划 |
| `PATCH /api/tasks/:id/plans/:planId` | 人工修改计划 |
| `POST /api/tasks/:id/launches` | 发射任务 |
| `GET /api/tasks/:id/terminal-candidates` | 获取可分配 Terminal |
| `GET /api/task-launches/:id` | 获取执行状态 |
| `POST /api/task-launches/:id/pause` | 暂停新工作分发 |
| `POST /api/task-launches/:id/resume` | 恢复调度 |
| `POST /api/task-launches/:id/cancel` | 取消执行 |
| `POST /api/task-launches/:id/slots/:slotId/retry` | 重试失败工作项 |
| `POST /api/task-launches/:id/slots/:slotId/release` | 释放 Terminal |

所有 PATCH 请求使用 revision 或 `If-Match` 防止人工编辑和 Codex 汇报互相覆盖。

### 6.2 模型配置接口

```text
GET    /api/scheduler/providers
POST   /api/scheduler/providers
PATCH  /api/scheduler/providers/:id
POST   /api/scheduler/providers/:id/test
```

要求：

- 模型 API Key 只能在后端使用。
- 浏览器永远拿不到明文。
- 日志中必须脱敏。
- 优先支持环境变量引用。
- UI 存储时使用 server secret 加密。
- Test 接口只返回连通性、模型可用性和错误摘要。

### 6.3 Codex Agent API

Agent API 使用独立 Bearer Token，不复用浏览器 Cookie：

```text
GET   /api/agent/v1/context
POST  /api/agent/v1/heartbeat
POST  /api/agent/v1/reports
PATCH /api/agent/v1/work-item
POST  /api/agent/v1/artifacts
POST  /api/agent/v1/plan
POST  /api/agent/v1/dispatch
```

Token 必须绑定：

- 用户。
- Task。
- Launch。
- Terminal slot。
- Work item。
- 角色和 scopes。
- 有效期和 Token 版本。

Worker Token 无权访问其他任务、创建 Terminal 或分发其他 Worker。Coordinator Token 可以提交计划和发起受限调度请求，但实际 Terminal 创建和并发校验仍由后端完成。

### 6.4 实时事件

当前任务 CRUD/Skill 汇报 MVP 使用同一 3131 服务内的 `GET /api/tasks/events` SSE。`TaskStore` 在项目、任务、附件和汇报成功提交后发布轻量变更通知；浏览器收到通知后去抖并重新请求任务列表和项目统计。SSE 沿用 `/api` 登录认证，每个连接只订阅当前用户的 `TaskStore`，断线由浏览器自动重连，重连成功后再拉取一次完整状态。

v0.5 的任务终端状态来自原 `/api/sessions` 权威接口：TaskMonitor 只保留 `TerminalSession.taskId/taskKey` 可选关联元数据，并按 2.5 秒刷新运行快照；只有关联且 `runtime.exists` 的 Terminal 才触发任务行转圈动画。弹窗打开时，Terminal 输出按照 Terminal Monitor 的用户预览行数、刷新频率、字号和缩放配置刷新。该轮询是运行进程探测，不另建服务，也不复制 Zellij 生命周期。

Launch 和多 Terminal 执行面板落地时复用现有 Socket.IO，并增加按用户和任务隔离的房间，事件包括：

```text
task:updated
task:report
task:activity
launch:state
work-item:updated
slot:updated
slot:thread
```

REST 始终是权威数据接口。当前 SSE 及后续 Socket.IO 都只负责失效通知或增量通知，断线后由客户端重新拉取完整状态。

## 7. 发射任务界面与流程

发射界面使用五步向导：

1. 选择并验证目标仓库。
2. 选择调度模式。
3. 设置最大 Codex 并发数。
4. 分配已有 Terminal 或创建新 Terminal。
5. 预览计划、权限、分支和风险后确认发射。

### 7.1 仓库预检

检查：

- 路径存在且位于允许访问范围内。
- 是否为 Git 仓库。
- 当前 branch 和 commit SHA。
- 是否存在未提交改动。
- 是否包含适用的 `AGENTS.md`。
- Codex 和 Zellij 是否可用。
- 是否允许创建 worktree。

非 Git 仓库默认最大并发为 1。允许多个 Codex 共用目录时必须明确警告。

### 7.2 Terminal 选择器

显示：

- Terminal 名称。
- 当前 cwd。
- 是否空闲。
- 当前命令。
- 是否已有 Codex。
- 是否已归属其他任务。
- Codex thread ID。
- 是否符合目标仓库要求。

接管规则：

- 正在运行非 Codex 命令的 Terminal 不允许静默接管。
- cwd 不匹配时，默认提供“复制为新的任务 Terminal”，而不是直接修改已有 Session 元数据。
- 已有 Codex 可以仅关联用于显示；要启用完整 Skill 汇报，默认要求由 TaskMonitor 重启或重新启动 Codex 以注入受限凭据。

### 7.3 最大并发定义

`maxConcurrency = X` 表示同一时间最多由 TaskMonitor 管理 X 个 Codex CLI 进程。

- 外部模型调度：调度器不占 Terminal，X 个 Slot 都可作为 Worker。
- Codex 调度：Coordinator 本身占一个名额，通常为 1 个 Coordinator 加 X-1 个 Worker。
- X=1 时，Coordinator 同时负责规划和实现。

该限制只约束由 TaskMonitor 发射和管理的 Codex，不约束用户在系统外手工启动的其他进程。

### 7.4 Git worktree 隔离

当 X 大于 1 时，为每个 Worker 创建独立 worktree：

```text
data/worktrees/<user>/<task-key>/slot-1
data/worktrees/<user>/<task-key>/slot-2
```

分支命名示例：

```text
ta/TA-42/slot-1
ta/TA-42/slot-2
```

每个工作项必须包含文件或模块归属，尽量减少合并冲突。首版不自动删除 worktree，也不未经确认自动合并。任务详情显示分支、commit 和待集成状态。

### 7.5 完整发射流程

1. 用户创建任务。
2. 调度器读取任务和受限仓库上下文。
3. 生成结构化计划。
4. 用户预览、调整并批准计划。
5. 后端事务性创建 Launch、工作项、依赖关系和 Terminal slots。
6. 创建或验证 worktree。
7. 检查 Terminal 空闲状态并启动 Zellij/Codex。
8. 向 Codex 注入任务 ID、工作项 ID和短期 Token。
9. 第一条提示明确要求调用 `$manage-terminal-apron-tasks`。
10. Codex 读取上下文、开始工作并按里程碑汇报。
11. 调度器在依赖完成后分发下一批工作。
12. 服务重启后根据数据库租约、Zellij 状态和 Codex thread 恢复。
13. 所有工作项完成后进入 Review，而不是直接标记 Done。
14. 用户确认完成后释放 Terminal，worktree 和分支保留到用户主动清理。

暂停默认只停止新工作分发，不杀死正在运行的 Codex。取消时提供：

- 优雅停止 Codex 并释放 Slot。
- 仅解除调度，保留 Terminal 和进程。

## 8. AI Scheduler

支持三种模式：

| 模式 | 特点 |
|---|---|
| 手动计划 | 用户创建工作项，后端只负责任务分发 |
| OpenAI Compatible | 后端调用 DeepSeek 等模型生成结构化计划 |
| Codex Coordinator | 一个 Codex 使用项目 Skill 检查代码库、拆解和调度 |

### 8.1 Provider 抽象

Provider 配置包括：

- `baseUrl`
- `apiKey` 或环境变量引用
- `model`
- `endpointMode`
- `timeoutMs`
- `maxRetries`
- JSON 输出能力标记

首版优先支持 OpenAI Compatible Chat Completions，不假设所有供应商都支持 Responses API。模型输出必须经过 Schema 校验；失败时允许一次受控的 JSON 修复请求，不得无限重试。

### 8.2 RepoContextBuilder

外部模型不能直接使用 Codex 工具，因此后端生成受限上下文包，包括：

- 目录树。
- README。
- 适用的 `AGENTS.md`。
- 包管理和语言清单。
- Git branch、commit 和 dirty 状态。
- 与任务描述相关的文件和符号摘要。
- 用户额外选择的文件。

默认排除：

- `.env` 和所有常见密钥文件。
- `.git`。
- `node_modules`、构建产物和缓存。
- Terminal Apron 数据目录。
- 用户配置的敏感路径。

在发送给第三方 Provider 前，UI 必须显示上下文摘要、供应商和预计发送范围。

### 8.3 计划结构

统一计划至少包括：

- 计划摘要。
- 假设与风险。
- 工作项。
- 依赖关系。
- 可并行分组。
- 文件或模块归属。
- 验收标准。
- 验证命令。
- 工作量权重。
- 集成步骤。

后端检查：

- 依赖图无环。
- 工作项数量和描述长度有上限。
- 权重合法。
- 并行组不超过最大并发。
- 同一 Terminal 同时只能属于一个活动 Launch。
- 不直接执行模型返回的任意 Shell 命令。
- 模型返回的路径不能绕过目标仓库边界。

### 8.4 调度行为

- 只分发所有依赖已经完成的工作项。
- 每个 Slot 同一时间最多一个工作项。
- 分发请求带幂等键。
- Codex thread 与 Slot 绑定并写入 Launch 记录。
- Worker Blocked 时暂停依赖它的后续工作。
- Coordinator 可以建议重新规划，但计划变更需要保存新版本。
- 服务重启时优先检查现存 Codex 状态，不能直接重复发送同一提示。

## 9. 项目内 Codex Skill

Canonical source：

```text
.agents/skills/manage-terminal-apron-tasks/
├── SKILL.md
├── agents/
│   └── openai.yaml
├── scripts/
│   └── task-monitor.mjs
└── references/
    ├── api-contract.md
    └── report-schema.md
```

Skill 名称：

```text
manage-terminal-apron-tasks
```

Skill 支持的 CLI 命令：

```text
context
start
report
block
complete
list-work-items
plan
dispatch
artifact
```

### 9.1 Skill 工作流程

Worker 必须：

1. 先读取当前 Task、Launch 和 Work item 上下文。
2. 读取并遵守目标仓库适用的 `AGENTS.md`。
3. 只处理 Token 允许的工作项和路径范围。
4. 在开始、重要里程碑、阻塞和完成时提交报告。
5. 完成前执行约定的验证命令。
6. 报告修改文件、验证证据、风险和未验证项。
7. 无法完成时标记 Blocked，不得伪报 Done。
8. 不在输出、提交记录或日志中打印 Agent Token。
9. 不直接打开 TaskMonitor SQLite 数据库。

Coordinator 额外可以：

- 提交结构化计划。
- 调整尚未开始的工作项。
- 请求后端分配空闲 Slot。
- 请求重新规划。

实际 Terminal 创建、并发校验和任务状态迁移仍由后端负责。

### 9.2 汇报 Schema

典型报告字段：

```json
{
  "status": "running",
  "summary": "Implemented login form validation",
  "changedFiles": ["src/login.tsx"],
  "verification": [
    {
      "command": "npm test",
      "result": "passed"
    }
  ],
  "risks": [],
  "blockers": [],
  "nextStep": "Add regression coverage"
}
```

### 9.3 Skill 与数据库的边界

调用链固定为：

```text
Skill → task-monitor.mjs → Agent API → TaskService → SQLite
```

禁止 Skill 直接读写 SQLite，因为直接数据库访问会绕过：

- 用户认证。
- Task/Launch/Work item scopes。
- 数据校验。
- 乐观锁和幂等控制。
- 审计记录。
- 后续数据库迁移边界。

### 9.4 Skill 安装与发现

由于 Codex 在其他目标仓库启动时，不一定能发现 Terminal Apron 仓库内的项目 Skill，需要提供：

```text
npm run skill:install
npm run skill:validate
```

安装脚本把项目内 canonical skill 安全同步到当前 Codex 的用户级 Skills 路径，并使用内容哈希避免静默覆盖用户手工修改的版本。目标仓库就是 Terminal Apron 时直接使用项目内版本。

实现后必须执行真实 Codex 发现测试，确认目标仓库中的 Codex 能通过 `$manage-terminal-apron-tasks` 调用该 Skill。

官方规范参考：<https://developers.openai.com/codex/skills/>。本计划编写时当前环境访问该页面受到 HTTP 403 限制，因此最终目录发现规则必须以实现时的官方文档和本机 Codex smoke test 双重确认。

## 10. 安全与权限

### 10.1 Agent Token

- 随 Launch/Slot 生成。
- 数据库只保存 Token hash。
- Token 短期有效，可在恢复时轮换。
- Scope 最小化。
- 释放 Slot 或取消 Launch 后立即吊销。
- Token 不放在任务描述或聊天提示正文中。
- TaskMonitor 启动的 Codex 通过受控环境或受保护的启动上下文获取凭据。

### 10.2 模型凭据

- API Key 不返回浏览器。
- API Key 不进入模型提示。
- API Key 不进入普通日志和任务事件。
- UI 只展示掩码和最后验证时间。
- 支持通过环境变量提供 Key，作为首选部署方式。

### 10.3 Markdown 与附件

- Markdown 默认禁止原始 HTML。
- 下载接口必须验证用户和任务归属。
- 文件名、扩展名和 MIME 类型同时校验。
- 使用随机存储名，不能使用用户输入拼接磁盘路径。
- 限制单文件大小、任务附件总量和支持类型。
- 图片使用内容检测，不能只相信浏览器 Content-Type。

### 10.4 仓库与命令

- 所有仓库路径先解析为绝对路径并验证边界。
- 不允许模型指定任意系统目录作为工作树。
- Existing Terminal 忙碌时不强制接管。
- 不未经确认删除 worktree、分支或用户文件。
- 不未经确认自动合并或推送远端分支。

### 10.5 多用户隔离

- 每个用户独立 SQLite、附件目录、worktree 根目录和 Socket.IO rooms。
- Agent Token 绑定用户 data directory。
- Terminal Session ID 查询必须同时验证当前用户的 SessionStore。

## 11. 测试计划

### 11.1 单元测试

- SQLite migrations 和升级。
- Task 字段规范化和 revision 冲突。
- 自动进度计算与人工覆盖。
- 依赖图环检测。
- 可运行工作项选择。
- 最大并发校验。
- Terminal 唯一活动租约。
- Agent Token scope、过期和吊销。
- 报告幂等。
- Provider JSON 校验和修复重试。
- 敏感文件排除规则。

### 11.2 集成测试

- 创建任务、上传截图、更新字段和归档恢复。
- 生成计划、人工编辑、发射和暂停恢复。
- 分配已有 Terminal 和创建新 Terminal。
- Busy Terminal 拒绝接管。
- X=2 时同时最多两个 Codex。
- Codex 汇报更新工作项和任务活动。
- Blocked 工作项阻止后续依赖分发。
- 服务重启后恢复 Launch 且不重复 dispatch。
- 取消 Launch 后吊销 Token 并释放 Slot。
- 多用户不能互相读取任务、附件或 Terminal。

### 11.3 前端 E2E

- 30 秒内完成名称、Markdown 和截图创建。
- 表格内修改状态、优先级、难度和进度。
- Markdown 粘贴图片和预览。
- Launch 向导完整流程。
- 执行面板实时展示多个 Slot。
- 从任务打开 Terminal，再返回任务不丢失状态。
- 桌面和移动端基本可用。

### 11.4 回归测试

- 现有 Terminal 创建、编辑、归档、恢复。
- Terminal Preview。
- TerminalDock 连接和历史。
- Quick Input。
- Codex thread 识别和 resume。
- 多用户认证和文件传输。

## 12. 实施阶段

### Phase 0：边界整理，预计 1–2 天

- 拆出 `AppShell` 和 `TerminalMonitorPage`。
- 抽出可复用 `TerminalService`。
- 确定 Node.js 运行时基线。
- 定义 Task、Launch、WorkItem、Report 和 Agent API 类型。
- 建立 TaskMonitor API 错误格式和验证规则。

交付标准：现有 Terminal Monitor 行为和测试不变，新模块具备清晰依赖边界。

### Phase 1：任务 CRUD，预计 4–6 天

- SQLite、迁移和 TaskService。
- 任务表格、详情和筛选。
- Markdown 编辑器。
- 截图上传。
- 手工状态、优先级、难度和进度。
- 审计时间线。

交付标准：用户可以不依赖 AI 完整管理任务。

### Phase 2：发射与 Terminal 分配，预计 4–6 天

当前已交付手工关联和一键安排 MVP：任务信息自动填充 Terminal 名称、项目分组、标签和 cwd；可关联已有 Terminal、遵守任务槽位上限、直接复用原 Terminal 卡片和实际终端；一键安排可启动 Codex 并发送 Skill 指令。以下完整 Launch 治理能力仍待完成：

- Launch 向导。
- 仓库预检。
- Terminal 候选和租约。
- 跨请求的原子并发租约限制。
- Codex thread 与正式 Launch/Slot 记录绑定。
- Git worktree 隔离。
- 暂停、取消、重试和释放。

交付标准：用户可以手工拆分工作项并可靠发射到多个 Terminal。

### Phase 3：Codex Skill，预计 2–4 天

- Agent API 和 scoped token。
- Skill CLI。
- 开始、汇报、需确认、阻塞和完成协议（基础协议已交付）。
- 安装和验证脚本。
- 真实 Codex smoke test。

交付标准：TaskMonitor 启动的 Codex 能读取任务并提交结构化进度。

### Phase 4：AI Scheduler，预计 4–6 天

- OpenAI Compatible Provider。
- DeepSeek 配置。
- RepoContextBuilder。
- 计划 Schema 和验证。
- Codex Coordinator 模式。
- 自动依赖调度和重新规划。

交付标准：用户可以预览 AI 计划，并在批准后自动分发到受限数量的 Codex。

### Phase 5：恢复与质量门禁，预计 3–5 天

- SQLite job leases 和服务重启恢复。
- Socket.IO 实时执行面板。
- 权限、XSS、路径穿越和密钥泄漏测试。
- 多用户隔离验证。
- 多 Codex 并行验收。
- 现有 Terminal Monitor 完整回归。

交付标准：满足本文验收标准并具备可恢复、可审计的完整执行链路。

总体预估：

- 任务管理、Terminal 发射和 Skill 汇报 MVP：单人约 2–3 周。
- 包含完整 AI Scheduler、恢复和安全加固：单人约 4–6 周。

## 13. 最终验收标准

- 用户能在 30 秒内完成“名称、Markdown 描述、截图”的任务创建。
- 创建时间自动记录，状态、优先级、难度和进度均可手工修改。
- 人工进度不会被 Codex 自动汇报覆盖。
- 同一 Launch 永远不超过配置的 Codex 并发数。
- Busy Terminal 不会被静默接管。
- 同一 Terminal 不会同时属于两个活动 Launch。
- 两个并行 Codex 默认不共享同一 Git 工作树。
- Codex Skill 无法跨 Task、Launch 或 Work item 修改数据。
- Codex 汇报能在数秒内显示在任务动态和执行面板中。
- 服务重启不会重复分发已经开始的工作项。
- 外部模型拿不到 API Key，也不会默认收到敏感文件。
- Markdown 和附件不能造成 XSS、路径穿越或未授权访问。
- Pause、Cancel、Retry、Release 都有明确且可审计的状态变化。
- TaskMonitor 的引入不改变现有 Terminal Monitor 的启动、预览、输入和恢复行为。

## 14. 开工前置事项

当前工作树已有多处未提交的 Terminal 相关修改。实际开发前需要：

1. 确认这些改动的归属和目标。
2. 建立独立 TaskMonitor 功能分支或工作树。
3. 不执行 `git reset --hard`、覆盖或清理用户现有改动。
4. 先完成 Phase 0 的模块边界和回归基线，再进入 TaskMonitor 功能实现。
