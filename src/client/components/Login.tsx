import { FormEvent, useEffect, useMemo, useState } from "react";
import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import type { AuthConfig, AuthUser } from "../../shared/types";
import { api } from "../api";

interface Props {
  onAuthenticated: (user: AuthUser) => void;
}

export function Login({ onAuthenticated }: Props) {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [sshChallenge, setSshChallenge] = useState<{
    id: string;
    username: string;
    namespace: string;
    value: string;
  } | null>(null);
  const [publicKey, setPublicKey] = useState("");
  const [signature, setSignature] = useState("");

  useEffect(() => {
    void api.authConfig().then((next) => {
      setConfig(next);
      if (next.user) {
        setUsername(next.user);
      }
      if (next.methods.includes("none")) {
        void api.me().then(onAuthenticated);
      }
    });
  }, [onAuthenticated]);

  const sshCommand = useMemo(() => {
    if (!sshChallenge) {
      return "";
    }
    return [
      `printf '%s' '${sshChallenge.value}' > /tmp/twm-challenge.txt`,
      `ssh-keygen -Y sign -f ~/.ssh/id_ed25519 -n ${sshChallenge.namespace} /tmp/twm-challenge.txt`,
      "cat /tmp/twm-challenge.txt.sig"
    ].join(" && ");
  }, [sshChallenge]);

  const passwordLogin = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    try {
      onAuthenticated(await api.login(username, password));
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    }
  };

  const createChallenge = async () => {
    setError("");
    setSshChallenge(await api.sshChallenge(username));
  };

  const verifySsh = async () => {
    if (!sshChallenge) {
      return;
    }
    setError("");
    try {
      onAuthenticated(
        await api.sshVerify({
          challengeId: sshChallenge.id,
          username,
          publicKey,
          signature
        })
      );
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    }
  };

  if (!config) {
    return <div className="boot-screen">Loading auth...</div>;
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="login-heading">
          <ShieldCheck size={30} />
          <div>
            <h1>Terminal Web Monitor</h1>
            <p>登录后管理本机 Zellij terminal。</p>
          </div>
        </div>

        {config.methods.includes("password") && (
          <form className="login-form" onSubmit={passwordLogin}>
            <label>
              用户
              <input value={username} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label>
              密码
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            <button className="primary-button wide" type="submit">
              <LockKeyhole size={17} />
              密码登录
            </button>
          </form>
        )}

        {config.methods.includes("ssh") && (
          <div className="ssh-login">
            <div className="ssh-login-title">
              <KeyRound size={17} />
              SSH key
            </div>
            <label>
              公钥
              <textarea
                value={publicKey}
                onChange={(event) => setPublicKey(event.target.value)}
                placeholder="ssh-ed25519 AAAA..."
              />
            </label>
            <button className="secondary-button wide" type="button" onClick={createChallenge}>
              生成挑战
            </button>
            {sshChallenge && (
              <>
                <label>
                  命令
                  <textarea readOnly value={sshCommand} />
                </label>
                <label>
                  签名
                  <textarea value={signature} onChange={(event) => setSignature(event.target.value)} />
                </label>
                <button className="primary-button wide" type="button" onClick={verifySsh}>
                  <KeyRound size={17} />
                  SSH 登录
                </button>
              </>
            )}
          </div>
        )}

        {error && <div className="form-error">{error}</div>}
      </section>
    </main>
  );
}
