import { useEffect, useMemo, useState } from "react";
import type { AgentInfo, MemberInfo } from "../api/client";
import { Sheet } from "./Sheet";
import { getAgents } from "../api/client";
import { suggestMemberName } from "../utils/member-name-suggestion";
import { userActionError } from "../utils/user-error";

interface AddMemberDialogProps {
  currentMembers: string[];
  currentMemberInfos?: MemberInfo[];
  onAdd: (agentName: string, memberName?: string) => Promise<void>;
  onClose: () => void;
}

function displayAgentName(agentName: string): string {
  if (!agentName) return "Agent";
  const normalized = agentName.trim();
  const upper = normalized.toUpperCase();
  if (["QA", "PM"].includes(upper)) return upper;
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      const acronym = part.toUpperCase();
      if (["QA", "PM"].includes(acronym)) return acronym;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function AddMemberDialog({ currentMembers, currentMemberInfos = [], onAdd, onClose }: AddMemberDialogProps) {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [memberName, setMemberName] = useState("");
  const [saving, setSaving] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  const loadAgents = async () => {
    setAgentsError(null);
    try {
      const items = await getAgents();
      setAgents(items);
      const first = items.find((agent) => agent.name.toLowerCase().includes("developer"))?.name || items[0]?.name || "";
      setSelectedAgent(first);
      setMemberName(first ? suggestMemberName(first, currentMembers) : "");
    } catch (err) {
      console.error("Failed to load Agent templates", err);
      setAgents([]);
      setSelectedAgent("");
      setMemberName("");
      setAgentsError(userActionError("load Agent templates"));
    }
  };

  useEffect(() => { void loadAgents(); }, [currentMembers]);

  const normalizedCurrent = useMemo(() => new Set(currentMembers.map((name) => name.toLowerCase())), [currentMembers]);
  const trimmedName = memberName.trim();
  const duplicate = !!trimmedName && normalizedCurrent.has(trimmedName.toLowerCase());
  const existingFromAgent = currentMemberInfos.filter((member) => (member.agent || member.sourceAgent || "").toLowerCase() === selectedAgent.toLowerCase());
  const canCreate = selectedAgent && trimmedName && !duplicate && !saving;

  const handleAgentChange = (agentName: string) => {
    setSelectedAgent(agentName);
    setMemberName(suggestMemberName(agentName, currentMembers));
  };

  const handleCreate = async () => {
    if (!canCreate) return;
    setSaving(true);
    try {
      await onAdd(selectedAgent, trimmedName);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open onClose={onClose} size="md" closeOnOverlayClick={false}>
      <div className="p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-ink-1">Add room member</h2>
            <p className="text-xs text-ink-4 mt-1">Choose an Agent template, then give this room member a unique name.</p>
          </div>
          <button onClick={onClose} className="text-ink-3 hover:text-ink-1 text-lg transition-colors cursor-pointer">×</button>
        </div>

        <div className="rounded-lg border border-line-soft bg-surface-1 p-3 space-y-3">
          <label className="block space-y-1.5">
            <span className="text-[11px] text-ink-4 uppercase tracking-wide">Agent</span>
            {agentsError ? (
              <div role="alert" className="rounded border border-blocked/30 bg-blocked-dim/30 px-3 py-2 text-xs text-blocked">
                <div>Couldn’t load Agent templates. {agentsError}</div>
                <button type="button" onClick={() => void loadAgents()} className="mt-2 rounded border border-blocked/40 px-2 py-1 text-[11px] hover:bg-blocked-dim">Retry</button>
              </div>
            ) : agents.length === 0 ? (
              <p className="rounded border border-line-soft bg-inset px-3 py-2 text-xs text-ink-4">No Agent templates are available yet. Create an Agent first.</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Agent template">
                {agents.map((agent) => {
                  const active = agent.name === selectedAgent;
                  return (
                    <button
                      key={agent.name}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => handleAgentChange(agent.name)}
                      className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors cursor-pointer ${active ? "border-accent bg-accent-dim text-accent-ink" : "border-line bg-inset text-ink-2 hover:border-line-strong hover:bg-surface-2"}`}
                    >
                      <span className="font-medium">{displayAgentName(agent.name)}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-ink-4">You can choose the same Agent multiple times. Each room member gets its own name and session.</p>
          </label>

          <label className="block space-y-1.5">
            <span className="text-[11px] text-ink-4 uppercase tracking-wide">Member name</span>
            <input
              value={memberName}
              onChange={(e) => setMemberName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleCreate(); }}
              autoFocus
              className={`w-full bg-inset border rounded px-3 py-2 font-mono text-sm text-ink-1 focus:outline-none transition-colors ${duplicate ? "border-blocked focus:border-blocked" : "border-line focus:border-line-strong"}`}
              placeholder="developer"
            />
            {duplicate ? (
              <p className="text-[11px] text-blocked">This room already has a member named {trimmedName}. Pick another name.</p>
            ) : (
              <p className="text-[11px] text-ink-4">Mention target will be <span className="font-mono">@{trimmedName || "member-name"}</span>.</p>
            )}
          </label>
        </div>

        <div className="rounded-lg border border-line-soft bg-inset/50 p-3">
          <div className="text-[11px] text-ink-4 uppercase tracking-wide mb-2">Current room members</div>
          <div className="space-y-1.5 max-h-36 overflow-y-auto">
            {currentMemberInfos.map((member) => (
              <div key={member.id || member.name} className="flex items-center justify-between gap-3 rounded bg-surface-1 px-2.5 py-1.5">
                <span className="font-mono text-xs font-semibold text-ink-2 truncate">{member.name}</span>
                <span className="text-[11px] text-ink-4 truncate">{displayAgentName(member.agent || member.sourceAgent || member.name)}</span>
              </div>
            ))}
          </div>
          {existingFromAgent.length > 0 && (
            <p className="text-[11px] text-ink-4 mt-2">
              {existingFromAgent.length} room member{existingFromAgent.length > 1 ? "s" : ""} already use {displayAgentName(selectedAgent)}. Add another by choosing a unique member name.
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-ink-4 hover:text-ink-1 cursor-pointer">Cancel</button>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!canCreate}
            className="px-4 py-2 bg-accent text-accent-contrast hover:opacity-90 disabled:opacity-40 text-sm font-semibold rounded-lg cursor-pointer"
          >
            {saving ? "Creating…" : "Create member"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
