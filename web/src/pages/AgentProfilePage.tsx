import { useEffect, useState } from "react";
import { BackLink } from "../components/BackLink";
import { type AgentDetail, deleteAgent, getAgent } from "../api/client";
import { StaffBadge } from "../components/StaffBadge";
import { Markdown } from "../components/Markdown";
import { MobileTopBar } from "../components/MobileTopBar";
import { AgentEditorDialog } from "../components/AgentEditorDialog";
import { useDialog } from "../components/dialogs";
import { formatTokenCount, loadRoomMemberFacts, matchesAgentFact, type RoomMemberFact } from "./room-member-facts";
import { userActionError } from "../utils/user-error";

interface AgentProfilePageProps {
  name: string;
  onBack: () => void;
  onDeleted: () => void;
  onOpenMobileSidebar?: () => void;
}

const STATUS_DOT: Record<string, string> = {
  working: "bg-working",
  thinking: "bg-think",
  idle: "bg-idle",
  off: "bg-ink-4/40",
  inactive: "bg-ink-4/40",
};

/** Agent template profile with real room-local member facts. */
export function AgentProfilePage({ name, onBack, onDeleted, onOpenMobileSidebar }: AgentProfilePageProps) {
  const { toast, confirm } = useDialog();
  const [agent, setAgent] = useState<AgentDetail | null>(null);
  const [facts, setFacts] = useState<RoomMemberFact[]>([]);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [activityReady, setActivityReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [promptExpanded, setPromptExpanded] = useState(false);

  const load = async () => {
    setAgentError(null);
    setActivityError(null);
    setLoading(true);
    try {
      setAgent(await getAgent(name));
    } catch (err) {
      console.error("Failed to load Agent", err);
      setAgentError(userActionError("load this Agent"));
      setLoading(false);
      return;
    }
    try {
      setFacts(await loadRoomMemberFacts());
      setActivityReady(true);
    } catch (err) {
      console.error("Failed to load member activity", err);
      setActivityError(userActionError("load member activity"));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, [name]);

  const handleDelete = async () => {
    if (!(await confirm(`Delete agent "${name}"? This cannot be undone.`))) return;
    try { await deleteAgent(name); onDeleted(); }
    catch (err) { console.error("Failed to delete Agent", err); toast(userActionError("delete this Agent"), "error"); }
  };

  if (!agent) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-1 p-6">
        {loading ? <span className="text-xs text-ink-4">Loading Agent…</span> : (
          <div role="alert" className="max-w-sm rounded-lg border border-blocked/30 bg-blocked-dim/30 p-4 text-center">
            <p className="text-sm text-blocked">Couldn’t load this Agent.</p>
            {agentError && <p className="mt-1 text-xs text-ink-3">{agentError}</p>}
            <button type="button" onClick={() => void load()} className="mt-3 rounded border border-line px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-2">Retry</button>
          </div>
        )}
      </div>
    );
  }

  const instances = facts.filter((fact) => matchesAgentFact(fact, name));
  const roomCount = new Set(instances.map((instance) => instance.roomId)).size;
  const totalTokens = instances.reduce((total, instance) => total + instance.totalTokens, 0);
  const anyWorking = instances.some((instance) => instance.status === "working");
  const isBuiltin = (agent.tags ?? []).includes("builtin");
  const btnCls = "px-3 py-1.5 text-xs font-medium text-ink-3 border border-line rounded-md hover:text-ink-1 hover:border-line-strong cursor-pointer transition-colors";
  const headCls = "text-[10.5px] font-semibold tracking-[0.08em] text-ink-4 mb-2";

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-surface-1">
      <MobileTopBar title={name} onOpenSidebar={onOpenMobileSidebar || (() => {})} />
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="w-full px-6 md:px-10 pt-7 pb-16">
          {activityError && (
            <div role="alert" className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-blocked/30 bg-blocked-dim/30 px-3 py-2 text-xs text-blocked">
              <span>Member activity unavailable. {activityError}</span>
              <button type="button" onClick={() => void load()} className="shrink-0 rounded border border-blocked/40 px-2 py-1 text-[11px] hover:bg-blocked-dim">Retry</button>
            </div>
          )}

          <BackLink label="Agents" onClick={onBack} />

          <div className="flex items-start gap-4">
            <StaffBadge name={name} avatar={agent.avatar} status={anyWorking ? "working" : "idle"} size="lg" />
            <div className="min-w-0">
              <h2 className="text-[19px] font-semibold tracking-tight text-ink-1 flex items-center gap-2.5 flex-wrap">
                {name}
                {isBuiltin && <span className="text-[10px] font-semibold tracking-[0.05em] px-2 py-0.5 rounded-full bg-accent-dim text-accent-ink">BUILT-IN</span>}
              </h2>
              <p className="text-[13px] text-ink-2 mt-1 max-w-[560px]">{agent.description || "No description"}</p>
              <p className="text-[11px] text-ink-4 mt-1.5">
                {loading ? "Loading member activity…" : !activityReady ? "Member activity unavailable" : instances.length ? `${instances.length} member${instances.length > 1 ? "s" : ""} in ${roomCount} room${roomCount > 1 ? "s" : ""} · ${formatTokenCount(totalTokens)} tokens` : "Not in any room yet"}
              </p>
            </div>
            <div className="ml-auto flex gap-2 shrink-0">
              <button onClick={() => setEditing(true)} className={btnCls}>Edit</button>
              {!isBuiltin && <button onClick={handleDelete} className={`${btnCls} hover:!text-blocked hover:!border-blocked/40`}>Delete</button>}
            </div>
          </div>

          <div className="mt-7">
            <h3 className={headCls}>SKILLS</h3>
            <div className="bg-surface-0 border border-line rounded-lg px-4 py-3 flex items-center gap-2 flex-wrap">
              {(agent.skills ?? []).length ? (agent.skills ?? []).map((skill) => <span key={skill} className="px-2.5 py-1 rounded-full text-[11.5px] bg-surface-2 text-ink-2">{skill}</span>) : <span className="text-[11.5px] text-ink-4">No skills bound — Edit to add.</span>}
            </div>
          </div>

          <div className="mt-7">
            <h3 className={headCls}>MEMBERS — one card per room member</h3>
            {loading ? (
              <p className="text-xs text-ink-4 bg-surface-0 border border-line rounded-lg px-4 py-5 text-center">Loading members…</p>
            ) : !activityReady ? (
              <p className="text-xs text-blocked bg-surface-0 border border-blocked/30 rounded-lg px-4 py-5 text-center">Member activity unavailable. Retry to load room members.</p>
            ) : instances.length === 0 ? (
              <p className="text-xs text-ink-4 bg-surface-0 border border-line rounded-lg px-4 py-5 text-center">No members yet — open a room and Add member to put this Agent to work.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {instances.map((instance) => (
                  <div key={`${instance.roomId}:${instance.memberId}`} className="bg-surface-0 border border-line rounded-lg p-3.5">
                    <div className="flex items-center gap-2 mb-2.5">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${STATUS_DOT[instance.status] || "bg-ink-4/40"}`} title={instance.status} />
                      <span className="font-mono text-[12px] text-ink-1 font-medium">@{instance.memberName}</span>
                      <span className="text-[11px] text-ink-4 ml-auto truncate">{instance.roomName}</span>
                    </div>
                    <div className="grid grid-cols-[52px_1fr] gap-y-1.5 gap-x-2 text-[11px]">
                      <span className="text-ink-4">model</span><span className="font-mono text-ink-2 truncate">{instance.model || "—"}</span>
                      <span className="text-ink-4">think</span><span className="text-ink-2">{instance.thinkingLevel || "—"}</span>
                      <span className="text-ink-4">mcp</span>
                      <span className="text-ink-2">{instance.mcpServers.length ? instance.mcpServers.map((server) => <span key={server} className="font-mono bg-surface-2 px-1.5 py-0.5 rounded mr-1">{server}</span>) : "—"}</span>
                      <span className="text-ink-4">tokens</span><span className="text-ink-2">{formatTokenCount(instance.totalTokens)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!loading && activityReady && instances.length > 0 && <p className="text-[10px] text-ink-4 mt-2">Model, thinking, and MCP access are configured for each member inside its room.</p>}
          </div>

          <div className="mt-7">
            <h3 className={headCls}>SYSTEM PROMPT</h3>
            <div className="bg-surface-0 border border-line rounded-lg p-5 relative">
              <div className={promptExpanded ? "" : "max-h-[300px] overflow-hidden"}><Markdown content={agent.systemPrompt || "_No prompt yet — Edit to write one._"} /></div>
              {!promptExpanded && <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-surface-0 to-transparent rounded-b-lg flex items-end justify-center pb-2"><button onClick={() => setPromptExpanded(true)} className="text-[11px] text-accent-ink cursor-pointer">Show full prompt</button></div>}
              {promptExpanded && <button onClick={() => setPromptExpanded(false)} className="block mx-auto mt-2 text-[11px] text-accent-ink cursor-pointer">Collapse</button>}
            </div>
          </div>
        </div>
      </div>

      {editing && <AgentEditorDialog agent={agent} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void load(); }} />}
    </div>
  );
}
