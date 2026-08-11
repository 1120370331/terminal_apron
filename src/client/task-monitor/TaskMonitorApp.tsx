import {
  KeyRound,
  ListChecks,
  LockKeyhole,
  LogOut,
  MonitorUp,
  Moon,
  ShieldCheck,
  Sun
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { AuthConfig, AuthUser } from "../../shared/types";
import { taskAuthApi } from "../taskApi";
import { TaskMonitorPage } from "./TaskMonitorPage";

type ThemeMode = "light" | "dark";

const THEME_KEY = "terminal-apron.task-monitor.theme.v1";

export function TaskMonitorApp() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [theme, setTheme] = useState<ThemeMode>(loadTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    void taskAuthApi.me().then(setUser).catch(() => setUser(null));
  }, []);

  if (user === undefined) {
    return (
      <main className="task-monitor-boot" aria-live="polite">
        <span />
        正在打开任务工作台…
      </main>
    );
  }

  if (!user) {
    return <TaskMonitorLogin onAuthenticated={setUser} />;
  }

  return (
    <main className="task-monitor-shell">
      <header className="task-monitor-topbar">
        <div className="task-monitor-brand">
          <span className="task-monitor-brand-mark" aria-hidden="true">
            <ListChecks size={20} />
          </span>
          <div>
            <strong>TaskMonitor</strong>
            <span>Terminal Apron · 独立任务工作台</span>
          </div>
        </div>
        <div className="task-monitor-session">
          <a className="task-shell-mode-link" href="/" title="返回 Terminal Monitor">
            <MonitorUp size={15} />
            终端
          </a>
          <span className="task-monitor-service-state">
            <i /> 任务服务
          </span>
          <span className="task-monitor-user">{user.name}</span>
          <button
            className="task-shell-icon-button"
            type="button"
            onClick={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "切换为浅色" : "切换为深色"}
          >
            {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button
            className="task-shell-icon-button"
            type="button"
            onClick={() => void taskAuthApi.logout().finally(() => setUser(null))}
            title="退出登录"
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>
      <TaskMonitorPage userName={user.name} onUnauthorized={() => setUser(null)} />
    </main>
  );
}

function TaskMonitorLogin({ onAuthenticated }: { onAuthenticated: (user: AuthUser) => void }) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sshChallenge, setSshChallenge] = useState<{
    id: string;
    username: string;
    namespace: string;
    value: string;
  } | null>(null);
  const [publicKey, setPublicKey] = useState("");
  const [signature, setSignature] = useState("");

  useEffect(() => {
    void taskAuthApi
      .config()
      .then((next) => {
        setConfig(next);
        if (next.user) {
          setUsername(next.user);
        }
        if (next.methods.includes("none")) {
          void taskAuthApi.me().then(onAuthenticated);
        }
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "认证配置加载失败"));
  }, [onAuthenticated]);

  const sshCommand = useMemo(() => {
    if (!sshChallenge) {
      return "";
    }
    return [
      `printf '%s' '${sshChallenge.value}' > /tmp/task-monitor-challenge.txt`,
      `ssh-keygen -Y sign -f ~/.ssh/id_ed25519 -n ${sshChallenge.namespace} /tmp/task-monitor-challenge.txt`,
      "cat /tmp/task-monitor-challenge.txt.sig"
    ].join(" && ");
  }, [sshChallenge]);

  const passwordLogin = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onAuthenticated(await taskAuthApi.login(username, password));
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };

  const createChallenge = async () => {
    setBusy(true);
    setError("");
    try {
      setSshChallenge(await taskAuthApi.sshChallenge(username));
    } catch (challengeError) {
      setError(challengeError instanceof Error ? challengeError.message : "SSH 挑战创建失败");
    } finally {
      setBusy(false);
    }
  };

  const verifySsh = async () => {
    if (!sshChallenge) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      onAuthenticated(
        await taskAuthApi.sshVerify({
          challengeId: sshChallenge.id,
          username,
          publicKey,
          signature
        })
      );
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : "SSH 签名验证失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="task-login-shell">
      <section className="task-login-intro">
        <span className="task-login-eyebrow">Terminal Apron / TaskMonitor</span>
        <h1>让每个开发问题，都有清楚的项目归属。</h1>
        <p>集中记录需求、Markdown 描述、截图和验收标准，再由 Codex 持续回报执行进度。</p>
        <div className="task-login-ledger" aria-hidden="true">
          <span>Project</span>
          <strong>Terminal Apron</strong>
          <span>Queue</span>
          <strong>12 tasks</strong>
        </div>
      </section>
      <section className="task-login-panel">
        <header>
          <ShieldCheck size={25} />
          <div>
            <h2>登录任务工作台</h2>
            <p>与 Terminal Apron 使用同一套账号和数据空间。</p>
          </div>
        </header>

        {!config && !error && <div className="task-login-loading">正在读取认证方式…</div>}

        {config?.methods.includes("password") && (
          <form className="task-login-form" onSubmit={passwordLogin}>
            <label>
              <span>用户</span>
              <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
            </label>
            <label>
              <span>密码</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </label>
            <button className="task-login-primary" type="submit" disabled={busy}>
              <LockKeyhole size={17} />
              {busy ? "登录中…" : "登录"}
            </button>
          </form>
        )}

        {config?.methods.includes("ssh") && (
          <details className="task-login-ssh">
            <summary>
              <KeyRound size={16} /> 使用 SSH key
            </summary>
            <label>
              <span>公钥</span>
              <textarea value={publicKey} onChange={(event) => setPublicKey(event.target.value)} placeholder="ssh-ed25519 AAAA…" />
            </label>
            <button type="button" onClick={() => void createChallenge()} disabled={busy}>
              生成挑战
            </button>
            {sshChallenge && (
              <>
                <label>
                  <span>签名命令</span>
                  <textarea readOnly value={sshCommand} />
                </label>
                <label>
                  <span>签名</span>
                  <textarea value={signature} onChange={(event) => setSignature(event.target.value)} />
                </label>
                <button type="button" onClick={() => void verifySsh()} disabled={busy}>
                  验证并登录
                </button>
              </>
            )}
          </details>
        )}

        {error && <div className="task-login-error">{error}</div>}
      </section>
    </main>
  );
}

function loadTheme(): ThemeMode {
  const saved = window.localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") {
    return saved;
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
