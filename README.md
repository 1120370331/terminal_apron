# Terminal Web Monitor

一个薄 Web 管理层，用成熟开源组件承载真实 terminal：

- Windows 原生默认使用 `node-pty`/ConPTY，不依赖 WSL。
- Linux/macOS 原生默认优先使用 `tmux`，没有 tmux 时降级为 native pty。
- `tmux` 模式下网页断开、服务重启都不会杀掉 tmux session。
- `xterm.js` + `node-pty` 负责浏览器里的交互式终端附着。
- `react-grid-layout` 负责多 terminal 预览卡片的拖拽、缩放和排列。
- SSH 公钥签名登录和密码登录都支持；生产环境建议只监听 localhost，再用 Tailscale Serve 暴露到 tailnet。
- terminal 卡片支持复制配置；只复制名称、分组、标签、路径、shell、backend、颜色和布局，不复制正在运行的进程或输出。
- terminal 卡片支持快速输入；不用打开完整终端，也可以直接把回复写入对应 CLI 助手的 stdin 并回车。

## 能力边界

普通应用无法让一个正在运行的进程跨系统关机继续执行。这里的“关机重启不丢失”分两层：

1. Web 面板元数据、名字、分组、标签、路径、归档状态和布局会落盘。
2. tmux 会话可用 `tmux-resurrect` + `tmux-continuum` 恢复 session、窗口、pane、工作目录、布局和部分可恢复程序。

如果 Codex CLI 这类程序自身在关机时退出，需要依赖它自己的 resume/history 能力继续。不断电、只断开网页或重启 Web 服务时，Codex 会继续留在 tmux 里运行。

## 要求

- Linux/macOS/WSL 主机
- Node.js 20+
- `tmux`
- `node-pty` 可编译或可安装预构建包
- 可选：`ssh-keygen`，用于 SSH key 签名登录
- 可选：Tailscale，用于 tailnet 访问

Windows 原生 PowerShell 可以运行面板和 terminal。Windows native pty 能支持 Codex CLI 这类交互命令，但不能提供 `tmux attach` 那种本机终端多路复用，也不能在系统重启后保留正在运行的进程。

## 执行权限

terminal 里的命令权限跟随 Web 服务进程的操作系统用户。

- Windows Startup 文件夹方式启动时，命令以当前登录 Windows 用户运行，例如 `a1120`，不会提升为 `SYSTEM`。
- Linux/macOS 的 `systemd --user` 方式启动时，命令以该 user service 所属用户运行。
- Web 登录账号只控制谁能访问面板，不会把远程浏览器用户自动映射成另一个 Windows/Linux 用户。
- 如果需要多用户严格隔离，应让每个 OS 用户运行自己的实例，使用不同端口、数据目录和 Tailscale ACL。

可以通过 `/api/health` 的 `processUser.username` 确认当前 terminal 实际会以哪个 OS 用户执行。

## 快速开始

```bash
npm install
cp .env.example .env
npm run build
TWM_AUTH_MODE=password TWM_ADMIN_PASSWORD='change-me' npm start
```

后端选择：

```bash
# auto: Windows 走 native pty；Linux/macOS 有 tmux 走 tmux，没有 tmux 走 native pty
TWM_SESSION_BACKEND=auto

# 强制 Windows/Linux 原生 pty
TWM_SESSION_BACKEND=native

# 强制 tmux；适合 Linux/macOS，需要先安装 tmux
TWM_SESSION_BACKEND=tmux
```

开发模式：

```bash
npm run dev
```

默认后端监听 `127.0.0.1:3131`，Vite 开发前端是 `http://localhost:5173`。

## 本机同步

tmux 后端下，每个 Web terminal 都对应一个 tmux session。网页打开 terminal 后，头部会显示本机 attach 命令：

```bash
tmux attach -t twm_xxxxxxxxxxxxxxxx
```

在本机执行该命令后，本机 terminal 与网页 terminal 会连接到同一个 tmux session。输入、输出、全屏 TUI、ANSI 控制序列和 Codex CLI 这类交互程序都由真实 pty + tmux 承载。

native 后端下，terminal 是 Web 服务内的原生 pty/ConPTY session。多个网页客户端可以同时附着到同一个 session，但本机终端不能用 `tmux attach` 进入同一个 Windows ConPTY。

## 认证

`.env` 中配置：

```bash
TWM_AUTH_MODE=password,ssh
TWM_ADMIN_USER=admin
TWM_ADMIN_PASSWORD=change-this-password
TWM_AUTHORIZED_KEYS_FILE=~/.ssh/authorized_keys
```

SSH 登录使用 OpenSSH 签名验证。页面会生成 challenge，你用本机私钥签名，服务端只接受 `authorized_keys` 里存在的公钥。

## Tailscale 访问

当前 Windows 原生部署已验证的入口是 direct tailnet HTTP：

```dotenv
TWM_HOST=tailscale
TWM_PORT=3131
```

访问地址：

```text
http://duren.tail4cd288.ts.net:3131
http://100.111.229.76:3131
```

不要把 `https://duren.tail4cd288.ts.net/` 当成这个入口；那个地址属于 Tailscale Serve/HTTPS。Serve 没配置成功或后端没有监听 localhost 时会不可用或返回 502。

如果要使用无端口 HTTPS 地址，需要先在 Tailscale Admin Console 启用 HTTPS certificates，然后：

```bash
TWM_HOST=127.0.0.1 TWM_PORT=3131 npm start
tailscale serve --bg 3131
```

可以用 `tailscale cert duren.tail4cd288.ts.net` 验证 HTTPS certificates 是否可用。不要用 Funnel 暴露到公网，除非你明确需要公网访问并已额外加固。

## tmux 持久化

安装 tmux 恢复插件：

```bash
bash scripts/install-tmux-persistence.sh
```

它会安装 TPM、`tmux-resurrect` 和 `tmux-continuum`，并启用自动保存和自动恢复。首次安装后进入 tmux 按 `prefix + I` 安装插件，或重启 tmux 后检查 `~/.tmux/plugins`。

## systemd

复制并按需修改：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/terminal-web-monitor.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now terminal-web-monitor.service
```

## Windows 开机自启

Windows 原生运行时可以使用 `scripts/start-windows.ps1`。它会读取项目根目录 `.env`，再启动生产服务：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-windows.ps1
```

如果要只监听 Tailscale 地址，可以在 `.env` 里设置：

```dotenv
TWM_HOST=tailscale
TWM_PORT=3131
```

脚本会在启动时解析当前 `tailscale ip -4`，再让服务绑定到该地址。

用任务计划程序设置当前用户登录后自启：

```powershell
schtasks /Create /TN "TerminalWebMonitor" /SC ONLOGON /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\path\to\terminal_web_monitor\scripts\start-windows.ps1\"" /F
```

## 开源组件

- xterm.js: https://github.com/xtermjs/xterm.js
- node-pty: https://github.com/microsoft/node-pty
- react-grid-layout: https://github.com/react-grid-layout/react-grid-layout
- tmux-resurrect: https://github.com/tmux-plugins/tmux-resurrect
- tmux-continuum: https://github.com/tmux-plugins/tmux-continuum
- Tailscale Serve: https://tailscale.com/kb/1242/tailscale-serve
