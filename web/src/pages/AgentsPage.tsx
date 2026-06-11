import { useState, useEffect } from "react";
import { Plus, Search } from "lucide-react";
import type { AgentInfo } from "../api/client";
import { getAgents } from "../api/client";
import { StaffBadge } from "../components/StaffBadge";
import { matchesWorkspaceResourceSearch } from "./resource-list-filter";

interface AgentsPageProps {
  onSelectAgent: (name: string) => void;
  onRefresh: () => void;
  onCreateAgent?: () => void;
}

/** Team 域列表落地页 — 员工花名册 */
export function AgentsPage({ onSelectAgent, onCreateAgent }: AgentsPageProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    getAgents().then(setAgents).catch(console.error);
  }, []);

  const filtered = agents.filter((a) => matchesWorkspaceResourceSearch(a, search));

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-surface-1">
      <div className="w-full max-w-[880px] mx-auto px-6 md:px-9 pt-7 pb-16">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-[17px] font-semibold tracking-tight text-ink-1">Team</h1>
            <p className="text-xs text-ink-4 mt-0.5">{agents.length} 名员工 — 点击查看档案与跨房间在岗</p>
          </div>
          <button
            onClick={onCreateAgent}
            className="flex items-center gap-1.5 px-3.5 py-1.5 bg-accent text-accent-contrast text-xs font-semibold rounded-md cursor-pointer hover:opacity-90 transition-opacity"
          >
            <Plus size={13} /> New Agent
          </button>
        </div>

        {/* Search */}
        <div className="relative mb-4">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search agents…"
            className="w-full bg-surface-0 border border-line rounded-lg pl-8.5 pr-3 py-2 text-[12.5px] text-ink-1 focus:outline-none focus:border-line-strong placeholder:text-ink-4 transition-colors"
          />
        </div>

        {/* Roster */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          {filtered.map((agent) => {
            const tags = (agent.tags ?? []).filter((t) => t !== "builtin");
            const isBuiltin = (agent.tags ?? []).includes("builtin");
            return (
              <button
                key={agent.name}
                onClick={() => onSelectAgent(agent.name)}
                className="text-left bg-surface-0 border border-line rounded-lg p-4 hover:border-line-strong cursor-pointer transition-colors"
              >
                <div className="flex items-center gap-2.5 mb-2">
                  <StaffBadge name={agent.name} avatar={agent.avatar} status="idle" size="sm" />
                  <span className="font-semibold text-ink-1 text-[13px]">{agent.name}</span>
                  {isBuiltin && (
                    <span className="text-[9px] font-semibold tracking-[0.05em] px-1.5 py-0.5 rounded-full bg-accent-dim text-accent-ink">
                      BUILT-IN
                    </span>
                  )}
                </div>
                <p className="text-xs text-ink-3 mb-2 line-clamp-2 leading-relaxed">
                  {agent.description || "No description"}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {agent.model && <span className="font-mono text-[10px] text-ink-4">{agent.model}</span>}
                  {tags.map((tag) => (
                    <span key={tag} className="text-[10px] bg-surface-2 text-ink-4 px-1.5 py-0.5 rounded">{tag}</span>
                  ))}
                  {(agent.skills ?? []).length > 0 && (
                    <span className="text-[10px] bg-surface-2 text-ink-4 px-1.5 py-0.5 rounded">
                      {(agent.skills ?? []).length} skills
                    </span>
                  )}
                </div>
              </button>
            );
          })}
          {filtered.length === 0 && (
            <p className="text-xs text-ink-4 col-span-full py-6 text-center">没有匹配的员工。</p>
          )}
        </div>
      </div>
    </div>
  );
}
