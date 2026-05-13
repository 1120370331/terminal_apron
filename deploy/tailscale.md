# Tailscale 部署建议

## 私有 tailnet 访问

应用默认监听 localhost：

```bash
TWM_HOST=127.0.0.1 TWM_PORT=3131 npm start
```

通过 Tailscale Serve 暴露：

```bash
tailscale serve --bg 3131
```

查看状态：

```bash
tailscale serve status
```

关闭：

```bash
tailscale serve reset
```

## SSH 入口

如果你还需要直接 SSH 到机器：

```bash
tailscale up --ssh
```

然后在 tailnet ACL 里限制允许的用户和目标主机。Web 面板自身仍建议保留 `password` 或 `ssh` 登录，不要只依赖内网可达。

## frp 备选

frp 可以做公网反代，但安全边界更靠近你自己维护的公网入口。若使用 frp：

- 面板必须开启 `TWM_AUTH_MODE=password,ssh`
- 建议前面放 Caddy/Nginx TLS
- 限制来源 IP 或加额外 OIDC/Basic Auth
- 不建议把未加固的 terminal 面板直接暴露公网
