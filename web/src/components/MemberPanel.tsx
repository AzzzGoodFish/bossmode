import type { AgentStatusMap } from "../hooks/useRoom";

interface MemberPanelProps {
  members: string[];
  agentStatus: AgentStatusMap;
  onOpenPrivateChat?: (agentName: string) => void;
}

export function MemberPanel({ members, agentStatus, onOpenPrivateChat }: MemberPanelProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-zinc-200 dark:border-zinc-800">
        <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
          Members ({members.length})
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        <div className="px-3 py-1.5 flex items-center gap-2">
          <StatusDot status="idle" />
          <span className="text-sm text-zinc-700 dark:text-zinc-300">you</span>
        </div>

        {members.map((name) => (
          <button
            key={name}
            onClick={() => onOpenPrivateChat?.(name)}
            className="w-full px-3 py-1.5 flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800/50 transition-colors cursor-pointer text-left"
            title={`Open private chat with ${name}`}
          >
            <StatusDot status={agentStatus[name] || "idle"} />
            <span className="text-sm text-zinc-700 dark:text-zinc-300">{name}</span>
            {agentStatus[name] === "working" && (
              <span className="text-xs text-blue-500 ml-auto">working</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  switch (status) {
    case "working":
      return <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />;
    case "idle":
      return <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />;
    default:
      return <span className="inline-block w-2 h-2 rounded-full bg-zinc-400 dark:bg-zinc-600" />;
  }
}
