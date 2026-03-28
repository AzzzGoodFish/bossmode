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
    } catch (err: any) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 flex items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-zinc-900 dark:text-white tracking-tight">
            Bossmode
          </h1>
          <p className="text-zinc-500 mt-2 text-sm">
            AI Team Command Center
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6 space-y-4"
        >
          {error && (
            <div className="bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 text-sm px-3 py-2 rounded">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="username" className="block text-sm font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">
              Username
            </label>
            <input
              id="username" type="text" value={username} onChange={(e) => setUsername(e.target.value)}
              className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-3 py-2 text-zinc-900 dark:text-white text-sm
                         focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent
                         placeholder:text-zinc-400 dark:placeholder:text-zinc-600"
              placeholder="Enter username" autoFocus required
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-zinc-600 dark:text-zinc-400 mb-1.5">
              Password
            </label>
            <input
              id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-zinc-50 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded px-3 py-2 text-zinc-900 dark:text-white text-sm
                         focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent
                         placeholder:text-zinc-400 dark:placeholder:text-zinc-600"
              placeholder="Enter password" required
            />
          </div>

          <button
            type="submit" disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-200 dark:disabled:bg-zinc-700 disabled:text-zinc-400 dark:disabled:text-zinc-500
                       text-white font-medium text-sm py-2 px-4 rounded transition-colors cursor-pointer"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
