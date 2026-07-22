import { useEffect, useState } from "react";
import { ChevronRight, X } from "lucide-react";
import type { AgentInfo, TeamTemplateSummary } from "../api/client";
import { getAgents, getTeams } from "../api/client";
import { Sheet } from "./Sheet";
import { StaffBadge } from "./StaffBadge";
import { userActionError } from "../utils/user-error";

export interface PickedMemberDraft {
  name: string;
  agent: string;
  leader?: boolean;
  /** "template" when bulk-added from a team template. */
  source?: "template" | "agent";
}

interface MemberPickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called when user picks a whole template roster. */
  onPickTemplate: (drafts: PickedMemberDraft[], templateName: string) => void;
  /** Called when user picks a single agent. */
  onPickAgent: (draft: PickedMemberDraft) => void;
}

type Mode = "root" | "template" | "agent";

function avatarLetter(name: string): string {
  return (name.trim()[0] || "?").toUpperCase();
}

/** Two-level Add-member picker: From a team template / Add an agent (approved prototype). */
export function MemberPickerDialog({ open, onClose, onPickTemplate, onPickAgent }: MemberPickerDialogProps) {
  const [mode, setMode] = useState<Mode>("root");
  const [teams, setTeams] = useState<TeamTemplateSummary[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setMode("root");
      setError(null);
      return;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (mode === "template" && teams.length === 0) {
      setLoading(true);
      setError(null);
      getTeams()
        .then(setTeams)
        .catch((err) => {
          console.error("Failed to load teams", err);
          setError(userActionError("load teams"));
        })
        .finally(() => setLoading(false));
    }
    if (mode === "agent" && agents.length === 0) {
      setLoading(true);
      setError(null);
      getAgents()
        .then(setAgents)
        .catch((err) => {
          console.error("Failed to load agents", err);
          setError(userActionError("load agents"));
        })
        .finally(() => setLoading(false));
    }
  }, [open, mode, teams.length, agents.length]);

  if (!open) return null;

  const title =
    mode === "root" ? "Add member" :
    mode === "template" ? "From a team template" :
    "Add an agent";
  const sub =
    mode === "root" ? "Choose how to add members to this room." :
    mode === "template" ? "The template's roster is added as draft members — you can still rename or trim before creating." :
    "Pick an agent, then give it a member name for this room.";

  return (
    <Sheet open onClose={onClose} size="lg" closeOnOverlayClick>
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h2 className="text-base font-semibold text-ink-1">{title}</h2>
          <p className="mt-0.5 text-xs text-ink-4">{sub}</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-ink-4 hover:bg-surface-2 hover:text-ink-1">
          <X size={18} />
        </button>
      </div>

      <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
        {error && (
          <div role="alert" className="mb-3 rounded-lg border border-blocked/30 bg-blocked-dim/30 px-3 py-2 text-xs text-blocked">
            {error}
          </div>
        )}

        {mode === "root" && (
          <div className="space-y-2">
            <PickRow
              icon={<span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-accent-dim text-sm font-extrabold text-accent-ink">◉</span>}
              title="From a team template"
              subtitle="Instantiate a whole team's roster at once"
              onClick={() => setMode("template")}
            />
            <PickRow
              icon={<span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-accent-dim text-sm font-extrabold text-accent-ink">◈</span>}
              title="Add an agent"
              subtitle="Pick one agent as a named member"
              onClick={() => setMode("agent")}
            />
          </div>
        )}

        {mode === "template" && (
          <div>
            <button type="button" onClick={() => setMode("root")} className="mb-2.5 rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-2 hover:bg-surface-2">
              ← Back
            </button>
            {loading ? (
              <p className="py-6 text-center text-sm text-ink-4">Loading teams…</p>
            ) : teams.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-4">No team templates available.</p>
            ) : (
              <div className="space-y-2">
                {teams.map((t) => (
                  <PickRow
                    key={t.slug || t.name}
                    icon={
                      <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-accent-dim text-sm font-extrabold text-accent-ink">
                        {avatarLetter(t.name)}
                      </span>
                    }
                    title={t.name}
                    subtitle={(t.agentNames ?? []).join(" · ") || `${(t.agentNames ?? []).length} agents`}
                    onClick={() => {
                      const drafts: PickedMemberDraft[] = (t.agentNames ?? []).map((n) => ({
                        name: n,
                        agent: n,
                        leader: n === t.leader,
                        source: "template",
                      }));
                      onPickTemplate(drafts, t.slug || t.name);
                      onClose();
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {mode === "agent" && (
          <div>
            <button type="button" onClick={() => setMode("root")} className="mb-2.5 rounded-md border border-line px-2.5 py-1 text-[11.5px] text-ink-2 hover:bg-surface-2">
              ← Back
            </button>
            {loading ? (
              <p className="py-6 text-center text-sm text-ink-4">Loading agents…</p>
            ) : agents.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-4">No agents available.</p>
            ) : (
              <div className="space-y-2">
                {agents.map((a) => (
                  <PickRow
                    key={a.name}
                    icon={<StaffBadge name={a.name} avatar={a.avatar} status="idle" size="sm" />}
                    title={a.name}
                    subtitle={a.description || "Agent"}
                    onClick={() => {
                      onPickAgent({ name: a.name, agent: a.name, source: "agent" });
                      onClose();
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Sheet>
  );
}

function PickRow({
  icon, title, subtitle, onClick,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-[11px] border border-line-soft bg-surface-1 px-3.5 py-2.5 text-left transition-colors hover:border-line-strong hover:bg-surface-2"
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold text-ink-1">{title}</span>
        <span className="mt-0.5 block truncate text-[10.5px] leading-snug text-ink-4">{subtitle}</span>
      </span>
      <ChevronRight size={14} className="shrink-0 text-ink-4" />
    </button>
  );
}
