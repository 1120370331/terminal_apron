# Terminal Web Monitor

一个基于 Web 的多 terminal 管理面板。当前正式运行后端统一为 `zellij`，Windows 和 Linux 都通过 Zellij 承载真实 terminal session，Web 服务只负责管理、预览和 attach。

## 当前设计

- Web 面板管理多个 terminal，会话支持名称、分组、标签、路径、颜色、布局、归档和复制配置。
- 每个 terminal 对应一个 Zellij session。网页断开或 Web 服务重启时，Zellij session 不会被杀掉。
- 从本面板启动的 Codex CLI 会自动附加 thread-id 标记；在 Codex 内执行 `/new`、`/fork`（以及同类 branch 操作）后，面板会记录新的 thread。terminal 卡片、terminal 窗口都提供单个重启按钮，工具栏提供全部重启按钮；重启前会核验当前 pane 是否确实运行 Codex，先尝试 `/exit`，仍未退出时自动补发 `Ctrl+C`，确认旧进程结束后才以 `codex resume --yolo <thread-id>` 恢复同一会话。
- 列表卡片可以直接发送输入，服务端会以粘贴模式写入目标 pane，并在短暂等待后发送 Enter，适合 Codex 这类交互式 composer。
- 列表输入行和完整终端窗口支持通过 Ctrl+V 粘贴图片或文件；文件会先上传到项目内 `file-transfer/<user>/` 传输目录，再把路径写入输入位置。
- 顶部工具栏提供文件传输面板，可上传、刷新、下载、删除和复制传输目录/文件路径，用于不同设备之间交换远程文件。
- 列表预览和完整终端都会尽量保留历史，并有上限避免卡顿。
- 登录认证支持密码和 SSH 签名登录。
- 推荐通过 Tailscale tailnet 访问，不建议把终端面板暴露到公网。

## 重要边界

已经被杀掉的进程无法恢复。旧的 native ConPTY 会话不能热迁移进 Zellij，只能保留之前捕获的输出历史。切到 Zellij 后，新开的 terminal 才具备“Web 服务重启不杀会话”的能力。

系统关机后，普通进程能否恢复仍取决于 Zellij session serialization 和命令本身的恢复能力。Codex CLI 额外使用自身的 thread-id/resume 机制恢复；绝对路径绕过 `codex` 命令包装器、或手工覆盖 `tui.terminal_title` 时，只能退回 Zellij 原生恢复。

## 要求

- Node.js 24+（任务存储使用内置 SQLite）
- Zellij 0.44+，Windows 可使用官方 `zellij-x86_64-pc-windows-msvc.zip`
- 可选：Tailscale
- 可选：OpenSSH keys，用于 SSH 签名登录

## 配置

`.env` 示例：

```dotenv
TWM_HOST=tailscale
TWM_PORT=3131
TWM_DATA_DIR=./data
TWM_SESSION_BACKEND=zellij
TWM_ZELLIJ_BIN=./tools/zellij/zellij.exe
TWM_AUTH_MODE=password
TWM_ADMIN_USER=admin
TWM_ADMIN_PASSWORD=change-this-password
TWM_COOKIE_SECURE=false

# 可选：多用户。admin 继续使用 ./data，其他用户使用 ./data/users/<name>。
# TWM_USERS_JSON='[{"name":"alice","password":"alice-pass"},{"name":"bob","authorizedKeysFile":"~/.ssh/bob_authorized_keys"}]'
# TWM_USERS_FILE=./users.json

TWM_NATIVE_HISTORY_BYTES=50000000
TWM_TERMINAL_ATTACH_HISTORY_LINES=5000
TWM_PREVIEW_MAX_LINES=5000
TWM_ZELLIJ_SCROLLBACK=50000
```

`TWM_SESSION_BACKEND` 保留配置项，但正式后端会归一为 `zellij`。旧 session 里的 `auto`、`native`、`tmux` 会被迁移为 `zellij`。

### 多用户隔离

可以继续用原来的 `TWM_ADMIN_USER` / `TWM_ADMIN_PASSWORD`，也可以通过 `TWM_USERS_JSON` 或 `TWM_USERS_FILE` 添加用户：

```json
[
  { "name": "alice", "password": "alice-pass" },
  { "name": "bob", "authorizedKeysFile": "~/.ssh/bob_authorized_keys" }
]
```

每个登录用户有独立的 session 列表、布局、transcripts 和浏览器端筛选/显示配置。为了兼容现有部署，`admin` 仍使用 `TWM_DATA_DIR` 根目录；其他用户默认使用 `TWM_DATA_DIR/users/<name>/`。命令执行的系统权限仍然跟随 Web 服务进程用户，不会因为登录用户名改变而切换 OS 用户。

## 启动

```bash
npm install
npm run build
npm start
```

Windows 后台启动使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1
```

## Task Mode

Apron 顶栏的 **Task Mode** 进入 `/task-monitor/?mode=task-mode`。提供任务板、双栏工作台、文档页三种布局；时间、状态、项目、协作方式和材料可组合筛选。手动排序支持卡片、任务列表与状态列拖拽，双栏宽度可调整，视图偏好保存在当前用户的数据空间。

任务支持即时渲染的 Markdown、剪贴板图片、文件附件和任务/文档引用。每条发送的指示保存独立需求快照；附件快照在原附件删除后仍可查看。点击开始执行后，真实 Codex 代理先理解并拆分任务，将原文交给独立 Worker 会话，收集代码改动和验证证据，再检查结果并更新状态。执行中可追加指示、排队、暂停和恢复；需要人工确认的结果保留在对应步骤内。

任务详情的“Codex 对话”页签和侧栏入口可查看代理与各 Worker 的原始消息、命令、文件改动及当前轮次进度。执行期间 Task Mode 定期向 Codex 确认会话状态，连接中断会显示自动恢复次数和下次检查时间；确认仍在运行的回合后继续跟踪，意外中断的回合会先检查已有改动再续做，连续恢复失败则标记为需要处理。

左侧“项目”保存项目名称、可选的 Markdown 说明和代码库根目录。新建任务时从项目列表选择，工作目录会自动填入项目路径；项目说明也会进入发送给代理的需求快照。修改项目目录会影响后续选择项目时填写的路径，已有任务保留自己的工作目录。

运行前安装并登录 Codex CLI，在任务中设置实际项目工作目录。默认模型为 `gpt-6.1-sol`，可在代理设置中分别配置代理/Worker 模型、提示词、协作方式、Worker 上限、权限和审查策略。Windows 支持 PATH 中的自定义 npm 全局安装目录，也可通过 `TWM_CODEX_BIN` 指定 `codex.exe` 或 `bin/codex.js`。

使用 `npm run build:all` 构建终端和任务页面。`node scripts/qa-task-mode.mjs` 在独立数据目录使用可控 Codex 传输验证页面/API；`node --import tsx scripts/qa-task-mode-real.mjs` 是可选的真实 Codex 联调，会调用已登录账号并在隔离目录执行一个小任务。

## TaskMonitor CLI

TaskMonitor 通过同一服务的 `/task-monitor/` 页面和项目内 Skill 提供任务管理。Codex 等客户端可使用认证后的 JSON CLI 创建、查询、更新、归档、上传任务证据，并提交结构化工作汇报；完整命令和接口约定见 [TaskMonitor CLI 文档](docs/task-monitor-cli.md)。

## Tailscale

当前直接 tailnet HTTP 入口：

```text
http://duren.tail4cd288.ts.net:3131
http://100.111.229.76:3131
```

如果要使用无端口 HTTPS 地址，需要先在 Tailscale Admin Console 启用 HTTPS certificates，然后用 Tailscale Serve 转发本地服务。

## 权限

terminal 里的命令权限跟随 Web 服务进程的操作系统用户。Windows 当前是登录用户 `a1120`，不会自动提升为 `SYSTEM`。可以通过 `/api/health` 的 `processUser.username` 确认。

## 开源组件

- Zellij: https://github.com/zellij-org/zellij
- xterm.js: https://github.com/xtermjs/xterm.js
- node-pty: https://github.com/microsoft/node-pty
- react-grid-layout: https://github.com/react-grid-layout/react-grid-layout
- Tailscale: https://tailscale.com/
