import type { AgentInfo } from "../api/client";

interface AgentListProps {
  agents: AgentInfo[];
}

export function AgentList({ agents }: AgentListProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-zinc-800">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          Contacts ({agents.length})
        </span>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {agents.length === 0 && (
          <div className="px-3 py-6 text-center text-zinc-600 text-xs">
            No agents configured
          </div>
        )}
        {agents.map((agent) => (
          <div
            key={agent.name}
            className="px-3 py-2 text-sm"
          >
            <div className="text-zinc-300 font-medium">{agent.name}</div>
            <div className="text-xs text-zinc-600">{agent.description}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
