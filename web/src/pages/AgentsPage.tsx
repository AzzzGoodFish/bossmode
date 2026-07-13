import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import type { AgentInfo, SkillInfo } from "../api/client";
import { getAgents, getSkills } from "../api/client";
import { StaffBadge } from "../components/StaffBadge";
import { AgentEditorDialog } from "../components/AgentEditorDialog";
import { matchesWorkspaceResourceSearch } from "./resource-list-filter";
import { formatTokenCount, loadRoomMemberFacts, matchesAgentFact, type RoomMemberFact } from "./room-member-facts";
import { userActionError } from "../utils/user-error";

interface AgentsPageProps {
  onSelectAgent: (name: string) => void;
  onSelectSkill: (name: string) => void;
  onCreateSkill: () => void;
  onRefresh: () => void;
  /** open the create dialog on mount (sidebar "+" route) */
  autoCreate?: boolean;
  onCloseCreate?: () => void;
}

/** Team page — Agent templates and their real room-local member facts. */
export function AgentsPage({ onSelectAgent, onSelectSkill, onCreateSkill, onRefresh, autoCreate, onCloseCreate }: AgentsPageProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [facts, setFacts] = useState<RoomMemberFact[]>([]);
  const [baseError, setBaseError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [baseReady, setBaseReady] = useState(false);
  const [activityReady, setActivityReady] = useState(false);
  const [loadingActivity, setLoadingActivity] = useState(true);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(!!autoCreate);

  const load = async () => {
    setBaseError(null);
    setActivityError(null);
    setLoadingActivity(true);
    try {
      const [nextAgents, nextSkills] = await Promise.all([getAgents(), getSkills()]);
      setAgents(nextAgents);
      setSkills(nextSkills);
      setBaseReady(true);
    } catch (err) {
      console.error("Failed to load Team data", err);
      setBaseError(userActionError("load Team data"));
      setLoadingActivity(false);
      return;
    }
    try {
      setFacts(await loadRoomMemberFacts());
      setActivityReady(true);
    } catch (err) {
      console.error("Failed to load member activity", err);
      setActivityError(userActionError("load member activity"));
    } finally {
      setLoadingActivity(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const filteredAgents = agents.filter((agent) => matchesWorkspaceResourceSearch(agent, search));
  const filteredSkills = skills.filter((skill) => matchesWorkspaceResourceSearch(skill, search));

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-surface-1">
      <div className="w-full max-w-[880px] mx-auto px-6 md:px-9 pt-7 pb-16">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-[17px] font-semibold tracking-tight text-ink-1">Team</h1>
            <p className="text-xs text-ink-4 mt-0.5">Agent templates and the skills they can use.</p>
          </div>
        </div>

        {(baseError || activityError) && (
          <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-blocked/30 bg-blocked-dim/30 px-3 py-2 text-xs text-blocked">
            <span>{baseError ? `Couldn’t load Team data. ${baseError}` : `Member activity unavailable. ${activityError}`}</span>
            <button type="button" onClick={() => void load()} className="shrink-0 rounded border border-blocked/40 px-2 py-1 text-[11px] hover:bg-blocked-dim">Retry</button>
          </div>
        )}

        {baseReady && <div className="relative mb-6">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search agents and skills…"
            className="w-full bg-surface-0 border border-line rounded-lg pl-8.5 pr-3 py-2 text-[12.5px] text-ink-1 focus:outline-none focus:border-line-strong placeholder:text-ink-4 transition-colors"
          />
        </div>}

        {baseReady && <><div className="flex items-center justify-between mb-2.5">
          <h2 className="text-[11px] font-semibold tracking-[0.08em] text-ink-4">AGENTS · {agents.length}</h2>
          <button onClick={() => setCreating(true)} className="flex items-center gap-1.5 px-3 py-1.5 bg-accent text-accent-contrast text-[11.5px] font-semibold rounded-md cursor-pointer hover:opacity-90 transition-opacity">
            <Plus size={12} /> New Agent
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5 mb-8">
          {filteredAgents.map((agent) => {
            const instances = facts.filter((fact) => matchesAgentFact(fact, agent.name));
            const roomCount = new Set(instances.map((instance) => instance.roomId)).size;
            const totalTokens = instances.reduce((total, instance) => total + instance.totalTokens, 0);
            const anyWorking = instances.some((instance) => instance.status === "working");
            const isBuiltin = (agent.tags ?? []).includes("builtin");
            return (
              <button key={agent.name} onClick={() => onSelectAgent(agent.name)} className="text-left bg-surface-0 border border-line rounded-lg p-4 hover:border-line-strong cursor-pointer transition-colors">
                <div className="flex items-center gap-2.5 mb-2">
                  <StaffBadge name={agent.name} avatar={agent.avatar} status={anyWorking ? "working" : "idle"} size="sm" />
                  <span className="font-semibold text-ink-1 text-[13px]">{agent.name}</span>
                  {isBuiltin && <span className="text-[9px] font-semibold tracking-[0.05em] px-1.5 py-0.5 rounded-full bg-accent-dim text-accent-ink">BUILT-IN</span>}
                </div>
                <p className="text-xs text-ink-3 mb-2.5 line-clamp-2 leading-relaxed">{agent.description || "No description"}</p>
                <div className="flex items-center gap-2 text-[10.5px] text-ink-4 flex-wrap">
                  {(agent.skills ?? []).map((skill) => <span key={skill} className="bg-surface-2 px-1.5 py-0.5 rounded">{skill}</span>)}
                  <span className="ml-auto">
                    {loadingActivity ? "Loading members…" : !activityReady ? "Member activity unavailable" : instances.length ? `${instances.length} member${instances.length > 1 ? "s" : ""} · ${roomCount} room${roomCount > 1 ? "s" : ""} · ${formatTokenCount(totalTokens)} tokens` : "not in any room"}
                  </span>
                </div>
              </button>
            );
          })}
          {filteredAgents.length === 0 && <p className="text-xs text-ink-4 col-span-full py-6 text-center">No matching agents.</p>}
        </div>

        <div className="flex items-center justify-between mb-2.5">
          <h2 className="text-[11px] font-semibold tracking-[0.08em] text-ink-4">SKILLS · {skills.length}</h2>
          <button onClick={onCreateSkill} className="flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] font-medium text-ink-3 border border-line rounded-md hover:text-ink-1 hover:border-line-strong cursor-pointer transition-colors">
            <Plus size={12} /> New Skill
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
          {filteredSkills.map((skill) => {
            const usedBy = agents.filter((agent) => (agent.skills ?? []).includes(skill.name));
            return (
              <button key={skill.name} onClick={() => onSelectSkill(skill.name)} className="text-left bg-surface-0 border border-line rounded-lg p-4 hover:border-line-strong cursor-pointer transition-colors">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <span className="w-6 h-6 rounded-md bg-surface-2 text-ink-3 flex items-center justify-center text-[10px] shrink-0">◆</span>
                  <span className="font-semibold text-ink-1 text-[13px]">{skill.name}</span>
                </div>
                <p className="text-xs text-ink-3 line-clamp-2 leading-relaxed mb-1.5">{skill.description || "No description"}</p>
                <p className="text-[10.5px] text-ink-4">{usedBy.length ? `Used by ${usedBy.map((agent) => agent.name).join(", ")}` : "Not bound to any agent"}</p>
              </button>
            );
          })}
          {filteredSkills.length === 0 && <p className="text-xs text-ink-4 col-span-full py-6 text-center">No matching skills.</p>}
        </div></>}
      </div>

      {creating && <AgentEditorDialog agent={null} onClose={() => { setCreating(false); onCloseCreate?.(); }} onSaved={(agentName) => { setCreating(false); void load(); onRefresh(); onSelectAgent(agentName); }} />}
    </div>
  );
}
