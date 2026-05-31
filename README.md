# Terminal Web Monitor

一个基于 Web 的多 terminal 管理面板。当前正式运行后端统一为 `zellij`，Windows 和 Linux 都通过 Zellij 承载真实 terminal session，Web 服务只负责管理、预览和 attach。

## 当前设计

- Web 面板管理多个 terminal，会话支持名称、分组、标签、路径、颜色、布局、归档和复制配置。
- 每个 terminal 对应一个 Zellij session。网页断开或 Web 服务重启时，Zellij session 不会被杀掉。
- 列表卡片可以直接发送输入，服务端会以粘贴模式写入目标 pane，并在短暂等待后发送 Enter，适合 Codex 这类交互式 composer。
- 列表输入行和完整终端窗口支持通过 Ctrl+V 粘贴图片或文件；文件会先上传到项目内 `file-transfer/<user>/` 传输目录，再把路径写入输入位置。
- 顶部工具栏提供文件传输面板，可上传、刷新、下载、删除和复制传输目录/文件路径，用于不同设备之间交换远程文件。
- 列表预览和完整终端都会尽量保留历史，并有上限避免卡顿。
- 登录认证支持密码和 SSH 签名登录。
- 推荐通过 Tailscale tailnet 访问，不建议把终端面板暴露到公网。

## 重要边界

已经被杀掉的进程无法恢复。旧的 native ConPTY 会话不能热迁移进 Zellij，只能保留之前捕获的输出历史。切到 Zellij 后，新开的 terminal 才具备“Web 服务重启不杀会话”的能力。

系统关机后，正在运行的进程能否恢复取决于 Zellij session serialization 和命令本身的恢复能力。Codex CLI 这类工具如果自身支持 resume/history，应该配合它自己的恢复机制使用。

## 要求

- Node.js 20+
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
