import { useState, useEffect } from "react";
import { RefreshCw, CheckCircle, XCircle } from "lucide-react";
import type { RuntimeInfo } from "../api/client";
import { getRuntimes } from "../api/client";

export function SettingsPage() {
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try { setRuntimes(await getRuntimes()); }
    catch (err: any) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, []);

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto">
      <h1 className="text-lg font-bold text-zinc-900 dark:text-white mb-6">Settings</h1>

      {/* Runtimes */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">Agent Runtimes</h2>
          <button onClick={refresh} disabled={loading}
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 cursor-pointer">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Re-detect
          </button>
        </div>

        <div className="space-y-3">
          {runtimes.map((rt) => (
            <div key={rt.name} className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  {rt.available
                    ? <CheckCircle size={16} className="text-emerald-500" />
                    : <XCircle size={16} className="text-red-500" />
                  }
                  <span className="font-semibold text-zinc-900 dark:text-white text-sm">{rt.name}</span>
                  {rt.available && <span className="text-xs text-zinc-500">v{rt.version}</span>}
                </div>
                <span className={`text-xs px-2 py-0.5 rounded ${rt.available ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400" : "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400"}`}>
                  {rt.available ? "Available" : "Not Found"}
                </span>
              </div>
              {rt.path && <div className="text-xs text-zinc-500 dark:text-zinc-600 font-mono mb-2">{rt.path}</div>}
              {rt.available && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {Object.entries(rt.capabilities).map(([cap, supported]) => (
                    <span key={cap} className={`text-[10px] px-1.5 py-0.5 rounded ${supported ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400" : "bg-zinc-100/50 text-zinc-400 dark:bg-zinc-800/50 dark:text-zinc-600 line-through"}`}>
                      {cap}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
