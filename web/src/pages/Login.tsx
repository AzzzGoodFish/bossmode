import { useRef, useState, type FormEvent } from "react";
import { Eye, EyeOff, Moon, Sun } from "lucide-react";
import { ApiError, login } from "../api/client";
import "../styles/login.css";
import { applyTheme } from "../grok/ui";

interface LoginProps {
  onLogin: (username: string) => void;
  expired?: boolean;
}

function loginFailure(error: unknown): { text: string; credentials: boolean } {
  if (error instanceof ApiError && error.status === 401) {
    return { text: "账号或密码不正确，请重试。", credentials: true };
  }
  if (error instanceof ApiError && error.status === 429) {
    return { text: "尝试次数较多，请稍后再登录。", credentials: false };
  }
  if (error instanceof TypeError || (error instanceof ApiError && error.status >= 500)) {
    return { text: "无法连接服务器，请检查连接后重试。", credentials: false };
  }
  return { text: "暂时无法登录，请稍后重试。", credentials: false };
}

/** Production authentication with the approved 18786 login layout, not demo outcomes. */
export function Login({ onLogin, expired }: LoginProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<ReturnType<typeof loginFailure> | null>(null);
  const [loading, setLoading] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const submitting = useRef(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setError(null);
    setVisible(false);
    setLoading(true);
    try {
      const name = username.trim();
      if (!name) {
        setError({ text: "请输入用户名。", credentials: false });
        return;
      }
      await login(name, password);
      setPassword("");
      onLogin(name);
    } catch (reason) {
      setError(loginFailure(reason));
    } finally {
      submitting.current = false;
      setLoading(false);
    }
  };

  const toggleTheme = () => {
    const next = !document.documentElement.classList.contains("dark");
    applyTheme(next ? "dark" : "light");
    setDark(next);
  };

  return (
    <div className="bm-login min-h-screen">
      <button type="button" className="bm-login-theme" onClick={toggleTheme}
        aria-label={dark ? "切换为浅色主题" : "切换为深色主题"}
        title={dark ? "切换为浅色主题" : "切换为深色主题"}>
        {dark ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <main className="bm-login-stage">
        <div className="bm-login-wrap">
          <header className="bm-login-brand">
            <h1>Bossmode</h1>
            <p>{expired ? "登录已失效。重新登录同一账号可继续，未发送内容已保留。" : "登录以继续"}</p>
          </header>
          <form className="bm-login-form" onSubmit={handleSubmit} aria-label="登录" aria-busy={loading}>
            <div className="bm-login-field">
              <label htmlFor="username">用户名</label>
              <input id="username" name="username" type="text" value={username}
                onChange={(event) => { setUsername(event.target.value); setError(null); }}
                autoComplete="username" autoCapitalize="none" spellCheck={false}
                autoFocus required disabled={loading} aria-invalid={error?.credentials || undefined}
                aria-describedby={error ? "login-error" : undefined} />
            </div>
            <div className="bm-login-field">
              <label htmlFor="password">密码</label>
              <div className="bm-login-password">
                <input id="password" name="password" type={visible ? "text" : "password"} value={password}
                  onChange={(event) => { setPassword(event.target.value); setError(null); }}
                  autoComplete="current-password" required disabled={loading}
                  aria-invalid={error?.credentials || undefined} aria-describedby={error ? "login-error" : undefined} />
                <button type="button" className="bm-login-visibility" disabled={loading}
                  onClick={() => setVisible((value) => !value)}
                  aria-label={visible ? "隐藏密码" : "显示密码"} title={visible ? "隐藏密码" : "显示密码"}
                  aria-controls="password" aria-pressed={visible}>
                  {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            {error && <p id="login-error" role="alert" className="bm-login-error" data-credentials={error.credentials}>{error.text}</p>}
            <button className="bm-login-submit" type="submit" disabled={loading}>
              {loading ? "正在登录…" : "登录"}
            </button>
            <span className="sr-only" role="status" aria-live="polite">{loading ? "正在登录，请稍候。" : ""}</span>
          </form>
        </div>
      </main>
    </div>
  );
}
