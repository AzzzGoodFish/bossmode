import { useState, type FormEvent } from "react";
import { login } from "../api/client";

interface LoginProps {
  onLogin: (username: string) => void;
}

export function Login({ onLogin }: LoginProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await login(username, password);
      onLogin(username);
    } catch (err) {
      console.error("Failed to sign in", err);
      setError("Couldn’t sign in. Check your username and password, then try again.");
    } finally {
      setLoading(false);
    }
  };

  const inputCls =
    "w-full bg-inset border border-line rounded-md px-3 py-2 text-ink-1 text-sm " +
    "focus:outline-none focus:border-accent placeholder:text-ink-4 transition-colors";

  return (
    <div className="h-full overflow-y-auto bg-surface-0 flex items-center justify-center px-4 py-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="w-11 h-11 rounded-xl bg-accent-dim text-accent-ink flex items-center justify-center font-bold text-lg mx-auto mb-4 select-none">
            B
          </div>
          <h1 className="text-2xl font-semibold text-ink-1 tracking-tight">Bossmode</h1>
          <p className="text-ink-3 mt-1.5 text-[13px]">AI Team Command Center</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-surface-1 border border-line rounded-xl p-6 space-y-4"
        >
          {error && (
            <div className="bg-blocked-dim border border-blocked/30 text-blocked text-xs px-3 py-2 rounded-md">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="username" className="block text-xs font-medium text-ink-2 mb-1.5">
              Username
            </label>
            <input
              id="username" type="text" value={username} onChange={(e) => setUsername(e.target.value)}
              className={inputCls}
              placeholder="Enter username" autoFocus required
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-xs font-medium text-ink-2 mb-1.5">
              Password
            </label>
            <input
              id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className={inputCls}
              placeholder="Enter password" required
            />
          </div>

          <button
            type="submit" disabled={loading}
            className="w-full bg-accent text-accent-contrast font-semibold text-sm py-2 px-4 rounded-md cursor-pointer hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
