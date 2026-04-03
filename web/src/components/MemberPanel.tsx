import { Square } from "lucide-react";
import { abortAgent } from "../api/client";
import type { ContextUsageData } from "../api/client";
import type { AgentStatusMap } from "../hooks/useRoom";

interface MemberPanelProps {
  members: string[];
  agentStatus: AgentStatusMap;
  contextUsage: Record<string, ContextUsageData>;
  roomId: string;
  onOpenPrivateChat?: (agentName: string) => void;
}

/** Format token count: <1k raw, >=1k one decimal+k, >=100k no decimal+k */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n / 1000) + "k";
}

/** Get progress bar color class based on percentage — dark mode 25-35% opacity for visibility */
function getBarColor(pct: number): string {
  if (pct < 50) return "bg-emerald-500/20 dark:bg-emerald-400/25";
  if (pct < 75) return "bg-amber-500/25 dark:bg-amber-400/30";
  if (pct < 90) return "bg-orange-500/30 dark:bg-orange-400/35";
  return "bg-red-500/35 dark:bg-red-400/35";
}

/** Get percentage text color */
function getPctColor(pct: number): string {
  if (pct >= 90) return "text-red-600 dark:text-red-400 font-semibold";
  return "text-zinc-500 dark:text-zinc-400";
}

export function MemberPanel({ members, agentStatus, contextUsage, roomId, onOpenPrivateChat }: MemberPanelProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-zinc-200 dark:border-zinc-800">
        <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
          Members ({members.length})
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {/* User row — no progress bar */}
        <div className="px-3 py-2 flex items-center gap-2">
          <StatusDot status="idle" />
          <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">you</span>
        </div>

        {members.map((name) => {
          const status = agentStatus[name] || "inactive";
          const usage = contextUsage[name];
          const hasData = usage?.supported && usage.percentage !== undefined;
          const pct = hasData ? usage.percentage! : 0;
          const isWorking = status === "working";
          const tooltipText = hasData
            ? `${formatTokens(usage.totalTokens!)} / ${formatTokens(usage.rawMaxTokens!)} (${Math.round(pct)}%)`
            : `Open private chat with ${name}`;

          return (
            <button
              key={name}
              onClick={() => onOpenPrivateChat?.(name)}
              className="w-full relative px-3 py-2 flex items-center gap-2 hover:bg-zinc-100/50 dark:hover:bg-zinc-800/30 transition-colors cursor-pointer text-left rounded-md mx-0"
              title={tooltipText}
            >
              {/* Bottom layer: progress bar fill */}
              {hasData && pct > 0 && (
                <div
                  className={`absolute inset-y-0 left-0 rounded-md transition-all duration-700 ease-out ${getBarColor(pct)} ${isWorking ? "animate-pulse" : ""}`}
                  style={{ width: `${Math.max(pct, 2)}%` }}
                  role="progressbar"
                  aria-valuenow={usage.totalTokens}
                  aria-valuemax={usage.rawMaxTokens}
                  aria-label={`Context usage: ${Math.round(pct)}%`}
                />
              )}

              {/* Top layer: content */}
              <div className="relative z-10 flex items-center gap-2 w-full min-w-0">
                <StatusDot status={status} />
                <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200 truncate">{name}</span>
                <span className={`ml-auto text-[11px] font-mono tabular-nums shrink-0 ${hasData ? getPctColor(pct) : "text-zinc-400 dark:text-zinc-500"}`}>
                  {hasData ? `${Math.round(pct)}%` : "\u2014"}
                </span>
                {isWorking && (
                  <button
                    onClick={(e) => { e.stopPropagation(); abortAgent(roomId, name).catch(console.error); }}
                    className="w-5 h-5 flex items-center justify-center rounded text-zinc-400 hover:text-red-400 transition-colors cursor-pointer shrink-0"
                    title={`Interrupt ${name}`}
                  >
                    <Square size={10} fill="currentColor" />
                  </button>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  switch (status) {
    case "working":
      return <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse shrink-0" />;
    case "idle":
      return <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 shrink-0" />;
    default:
      return <span className="inline-block w-2 h-2 rounded-full bg-zinc-400 dark:bg-zinc-600 shrink-0" />;
  }
}
