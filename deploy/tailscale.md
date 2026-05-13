# Tailscale Deployment

## Direct Tailnet Access

On this Windows host the currently verified endpoint is direct tailnet HTTP:

```env
TWM_HOST=tailscale
TWM_PORT=3131
```

`scripts/start-windows.ps1` resolves `tailscale` with `tailscale ip -4` at startup and binds the app to that address.

Use one of these URLs from another device in the same tailnet:

```text
http://duren.tail4cd288.ts.net:3131
http://100.111.229.76:3131
```

Do not use `https://duren.tail4cd288.ts.net/` for this mode. That URL is the Tailscale Serve HTTPS entrypoint.

## Tailscale Serve

If you want a no-port HTTPS URL, first enable HTTPS certificates in the Tailscale admin console, then run:

```bash
TWM_HOST=127.0.0.1 TWM_PORT=3131 npm start
tailscale serve --bg 3131
```

Check certificate support first:

```bash
tailscale cert duren.tail4cd288.ts.net
```

If it returns `your Tailscale account does not support getting TLS certs`, Serve HTTPS is not available yet and direct tailnet HTTP should be used instead.

## SSH Entry

If you also need direct SSH to the machine:

```bash
tailscale up --ssh
```

Then restrict users and hosts in the tailnet ACL. The Web panel should still keep `password` or `ssh` login enabled.

## frp Alternative

frp can do public reverse proxying, but it moves the security boundary to your public entrypoint. If using frp:

- Keep `TWM_AUTH_MODE=password,ssh` enabled.
- Put Caddy/Nginx TLS in front.
- Restrict source IPs or add OIDC/Basic Auth.
- Do not expose an unauthenticated terminal panel to the public internet.
