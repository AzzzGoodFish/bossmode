import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Check, Crown, FolderOpen, Info, Pencil, Plus, Trash2, UserRound, Users, X } from "lucide-react";
import type { AgentInfo, CreateRoomMemberInput } from "../api/client";
import { getAgents } from "../api/client";
import { FolderPicker } from "./FolderPicker";
import { Sheet } from "./Sheet";
import { suggestMemberName } from "../utils/member-name-suggestion";
import { userActionError } from "../utils/user-error";

interface DraftRoomMember {
  id: string;
  name: string;
  agent: string;
}

interface DraftEditorState {
  mode: "add" | "edit";
  draftId?: string;
}

type AgentLoadStatus = "loading" | "ready" | "error";

export function agentAuthorityDisplayState(status: AgentLoadStatus, agentCount: number): "loading" | "error" | "empty" | "items" {
  if (status !== "ready") return status;
  return agentCount === 0 ? "empty" : "items";
}

interface CreateRoomDialogProps {
  onClose: () => void;
  onSubmit: (name: string, cwd: string, members: CreateRoomMemberInput[], ruleDocs?: string[], promptLeaderMemberName?: string) => Promise<void>;
}

function displayAgentName(agentName: string): string {
  const normalized = agentName.trim();
  if (!normalized) return "Agent";
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

function memberNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a member name.";
  if (trimmed.length > 64) return "Use 64 characters or fewer.";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) {
    return "Start with a letter or number. Then use letters, numbers, dots, underscores, or hyphens.";
  }
  if (trimmed.toLowerCase() === "all") return "“all” is reserved. Pick another name.";
  return null;
}

function memberInitials(name: string): string {
  const bits = name.split(/[-_.\s]+/).filter(Boolean);
  if (bits.length > 1) return `${bits[0][0] || ""}${bits[1][0] || ""}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function CreateRoomDialog({ onClose, onSubmit }: CreateRoomDialogProps) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentLoadStatus, setAgentLoadStatus] = useState<AgentLoadStatus>("loading");
  const [agentLoadError, setAgentLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<DraftRoomMember[]>([]);
  const [leaderName, setLeaderName] = useState("");
  const [editor, setEditor] = useState<DraftEditorState | null>(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const loadAgents = async () => {
    setAgentLoadStatus("loading");
    setAgentLoadError(null);
    try {
      setAgents(await getAgents());
      setAgentLoadStatus("ready");
    } catch (error) {
      console.error("Failed to load Agent templates", error);
      setAgentLoadError(userActionError("load Agent templates"));
      setAgentLoadStatus("error");
    }
  };

  useEffect(() => {
    void loadAgents();
  }, []);

  useEffect(() => {
    if (leaderName && !drafts.some((draft) => draft.name === leaderName)) {
      setLeaderName(drafts[0]?.name || "");
    }
  }, [drafts, leaderName]);

  const canSubmit = Boolean(name.trim() && cwd.trim() && drafts.length > 0 && leaderName);

  const upsertDraft = (next: Omit<DraftRoomMember, "id">, draftId?: string) => {
    if (draftId) {
      const previous = drafts.find((draft) => draft.id === draftId);
      setDrafts((current) => current.map((draft) => draft.id === draftId ? { ...draft, ...next } : draft));
      if (previous?.name === leaderName) setLeaderName(next.name);
    } else {
      const draft: DraftRoomMember = { ...next, id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
      setDrafts((current) => [...current, draft]);
      if (!leaderName) setLeaderName(draft.name);
    }
    setEditor(null);
    setSubmitError(null);
  };

  const removeDraft = (draftId: string) => {
    const removed = drafts.find((draft) => draft.id === draftId);
    const remaining = drafts.filter((draft) => draft.id !== draftId);
    setDrafts(remaining);
    if (removed?.name === leaderName) setLeaderName(remaining[0]?.name || "");
    setSubmitError(null);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitAttempted(true);
    setSubmitError(null);
    if (!canSubmit) return;
    setSaving(true);
    try {
      await onSubmit(name.trim(), cwd.trim(), drafts.map(({ agent, name: memberName }) => ({ agent, name: memberName })), undefined, leaderName);
      onClose();
    } catch (error: any) {
      setSubmitError(error?.message || "Couldn’t create the Room. Your draft is still here.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open onClose={onClose} size="2xl" closeOnOverlayClick={false}>
      <form onSubmit={handleSubmit}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div>
            <h2 className="text-lg font-semibold text-ink-1">Create Room</h2>
            <p className="mt-1 text-sm text-ink-4">Set up the workspace, then add the members who will work here.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close Create Room" className="rounded-md p-1.5 text-ink-4 hover:bg-surface-2 hover:text-ink-1">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-6 p-6">
          <section aria-labelledby="room-details-heading">
            <div className="mb-3 flex items-center gap-2">
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-3 text-[10px] font-semibold text-ink-3">1</span>
              <h3 id="room-details-heading" className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-3">Room details</h3>
            </div>
            <div className="grid gap-4 md:grid-cols-[0.8fr_1.2fr]">
              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-ink-3">Room name</span>
                <input
                  autoComplete="off"
                  value={name}
                  onChange={(event) => { setName(event.target.value); setSubmitError(null); }}
                  autoFocus
                  className={`w-full rounded-lg border bg-inset px-3 py-2.5 text-sm text-ink-1 outline-none transition-colors ${submitAttempted && !name.trim() ? "border-blocked" : "border-line focus:border-line-strong"}`}
                  placeholder="e.g., Product launch"
                />
                {submitAttempted && !name.trim() && <p className="text-[11px] text-blocked">Enter a Room name.</p>}
              </label>

              <label className="block space-y-1.5">
                <span className="text-xs font-medium text-ink-3">Working directory</span>
                <div className="flex gap-2">
                  <input
                    autoComplete="off"
                    value={cwd}
                    onChange={(event) => { setCwd(event.target.value); setSubmitError(null); }}
                    className={`min-w-0 flex-1 rounded-lg border bg-inset px-3 py-2.5 font-mono text-sm text-ink-1 outline-none transition-colors ${submitAttempted && !cwd.trim() ? "border-blocked" : "border-line focus:border-line-strong"}`}
                    placeholder="/path/to/your/project"
                  />
                  <button
                    type="button"
                    title="Browse folders"
                    onClick={() => setShowFolderPicker(true)}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-line bg-inset text-ink-4 hover:border-line-strong hover:text-ink-1"
                  >
                    <FolderOpen size={16} />
                  </button>
                </div>
                {submitAttempted && !cwd.trim() && <p className="text-[11px] text-blocked">Choose a working directory.</p>}
              </label>
            </div>
          </section>

          <section aria-labelledby="members-heading">
            <div className="mb-3 flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-3 text-[10px] font-semibold text-ink-3">2</span>
                <h3 id="members-heading" className="text-xs font-semibold uppercase tracking-[0.1em] text-ink-3">Members</h3>
                {drafts.length > 0 && <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-medium text-ink-3">{drafts.length}</span>}
              </div>
              {drafts.length > 0 && (
                <button type="button" onClick={() => setEditor({ mode: "add" })} className="flex items-center gap-1.5 rounded-lg border border-line bg-surface-1 px-3 py-1.5 text-xs font-semibold text-ink-2 hover:border-line-strong hover:bg-surface-2">
                  <Plus size={14} /> Add member
                </button>
              )}
            </div>

            <div className={`rounded-xl border ${submitAttempted && drafts.length === 0 ? "border-blocked" : "border-line"} bg-inset p-2`}>
              {drafts.length === 0 ? (
                <div className="flex min-h-40 flex-col items-center justify-center px-4 py-6 text-center">
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-2 text-ink-4"><Users size={19} /></div>
                  <p className="text-sm font-medium text-ink-2">No members yet</p>
                  <p className="mt-1 max-w-sm text-xs leading-5 text-ink-4">Add an Agent template as a named member of this Room. You can add the same Agent more than once.</p>
                  <button type="button" onClick={() => setEditor({ mode: "add" })} className="mt-4 flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-xs font-semibold text-accent-contrast hover:opacity-90">
                    <Plus size={14} /> Add member
                  </button>
                </div>
              ) : (
                <div role="list" aria-label="Draft room members" className="space-y-1.5">
                  {drafts.map((draft) => (
                    <div key={draft.id} role="listitem" data-draft-member={draft.name} className="group flex min-h-14 items-center gap-3 rounded-lg border border-transparent bg-surface-1 px-3 py-2 hover:border-line-soft">
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line-soft bg-surface-2 font-mono text-[10px] font-semibold text-ink-3">
                        {memberInitials(draft.name)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-baseline gap-2">
                          <span className="truncate font-mono text-sm font-semibold text-ink-1">{draft.name}</span>
                          <span className="truncate text-xs text-ink-4">{displayAgentName(draft.agent)}</span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-ink-4">Defaults for model, thinking, and tools</div>
                      </div>
                      {leaderName === draft.name && (
                        <span className="hidden items-center gap-1 rounded-full bg-think/10 px-2 py-1 text-[10px] font-medium text-think sm:flex"><Crown size={10} /> Leader</span>
                      )}
                      <div className="flex shrink-0 items-center gap-1">
                        <button type="button" onClick={() => setEditor({ mode: "edit", draftId: draft.id })} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-ink-4 hover:bg-surface-2 hover:text-ink-1"><Pencil size={12} /> Edit</button>
                        <button type="button" onClick={() => removeDraft(draft.id)} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-ink-4 hover:bg-blocked/10 hover:text-blocked"><Trash2 size={12} /> Remove</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {submitAttempted && drafts.length === 0 && <p className="mt-1.5 text-[11px] text-blocked">Add at least one member.</p>}

            {drafts.length > 0 && (
              <div className="mt-3 grid gap-3 rounded-lg border border-line-soft bg-surface-1 p-3 md:grid-cols-[1fr_1fr] md:items-center">
                <div className="flex items-start gap-2">
                  <Info size={14} className="mt-0.5 shrink-0 text-ink-4" />
                  <p className="text-[11px] leading-4 text-ink-4">Model, thinking, and tools use the Agent defaults. Change them from the member profile after the Room is created.</p>
                </div>
                <label className="flex items-center justify-end gap-2 text-xs text-ink-3">
                  <span className="flex items-center gap-1.5 whitespace-nowrap"><Crown size={12} className="text-think" /> Room leader</span>
                  <select value={leaderName} onChange={(event) => setLeaderName(event.target.value)} className="min-w-0 max-w-52 flex-1 rounded-md border border-line bg-inset px-2.5 py-1.5 font-mono text-xs text-ink-1 outline-none focus:border-line-strong">
                    {drafts.map((draft) => <option key={draft.id} value={draft.name}>{draft.name}</option>)}
                  </select>
                </label>
              </div>
            )}
          </section>

          {submitError && (
            <div role="alert" className="rounded-lg border border-blocked/40 bg-blocked/10 px-3 py-2.5">
              <p className="text-sm font-medium text-blocked">Couldn’t create this Room</p>
              <p className="mt-0.5 text-xs text-ink-3">{submitError}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-1 px-6 py-4">
          <p className="hidden text-xs text-ink-4 sm:block">The Room and its members are created together.</p>
          <div className="ml-auto flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-ink-4 hover:bg-surface-2 hover:text-ink-1">Cancel</button>
            <button
              type="submit"
              aria-disabled={!canSubmit}
              className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${canSubmit ? "bg-accent text-accent-contrast hover:opacity-90" : "bg-surface-3 text-ink-3 hover:text-ink-2"}`}
            >
              {saving ? "Creating…" : "Create Room"}
            </button>
          </div>
        </div>
      </form>

      {editor && (
        <DraftMemberEditor
          agents={agents}
          agentLoadStatus={agentLoadStatus}
          agentLoadError={agentLoadError}
          onRetryAgents={() => void loadAgents()}
          drafts={drafts}
          editing={editor.draftId ? drafts.find((draft) => draft.id === editor.draftId) : undefined}
          onSave={(draft) => upsertDraft(draft, editor.draftId)}
          onClose={() => setEditor(null)}
        />
      )}

      {showFolderPicker && (
        <FolderPicker
          open
          initialPath={cwd || undefined}
          onConfirm={(path) => { setCwd(path); setShowFolderPicker(false); }}
          onCancel={() => setShowFolderPicker(false)}
        />
      )}
    </Sheet>
  );
}

function DraftMemberEditor({
  agents,
  agentLoadStatus,
  agentLoadError,
  onRetryAgents,
  drafts,
  editing,
  onSave,
  onClose,
}: {
  agents: AgentInfo[];
  agentLoadStatus: AgentLoadStatus;
  agentLoadError: string | null;
  onRetryAgents: () => void;
  drafts: DraftRoomMember[];
  editing?: DraftRoomMember;
  onSave: (draft: Omit<DraftRoomMember, "id">) => void;
  onClose: () => void;
}) {
  const [selectedAgent, setSelectedAgent] = useState(editing?.agent || "");
  const [memberName, setMemberName] = useState(editing?.name || "");
  const [attempted, setAttempted] = useState(false);
  const trimmedName = memberName.trim();
  const invalidName = memberNameError(memberName);
  const duplicate = Boolean(trimmedName && drafts.some((draft) => draft.id !== editing?.id && draft.name.toLowerCase() === trimmedName.toLowerCase()));
  const canSave = Boolean(selectedAgent && !invalidName && !duplicate);
  const selectedAgentInfo = useMemo(() => agents.find((agent) => agent.name === selectedAgent), [agents, selectedAgent]);
  const agentDisplayState = agentAuthorityDisplayState(agentLoadStatus, agents.length);

  const selectAgent = (agentName: string) => {
    setSelectedAgent(agentName);
    if (!memberName.trim() || memberName === suggestMemberName(selectedAgent, drafts.filter((draft) => draft.id !== editing?.id).map((draft) => draft.name))) {
      setMemberName(suggestMemberName(agentName, drafts.filter((draft) => draft.id !== editing?.id).map((draft) => draft.name)));
    }
  };

  const save = () => {
    setAttempted(true);
    if (!canSave) return;
    onSave({ agent: selectedAgent, name: trimmedName });
  };

  return (
    <Sheet open onClose={onClose} size="lg" closeOnOverlayClick={false}>
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-ink-1">{editing ? "Edit member" : "Add member"}</h3>
            <p className="mt-1 text-xs text-ink-4">Choose an Agent identity, then name this concrete Room member.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close member editor" className="rounded-md p-1.5 text-ink-4 hover:bg-surface-2 hover:text-ink-1"><X size={17} /></button>
        </div>

        <div className="mt-5 space-y-5">
          <fieldset>
            <legend className="mb-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">Agent</legend>
            {agentDisplayState === "loading" ? (
              <p className="rounded-lg border border-line bg-inset p-3 text-xs text-ink-4">Loading Agent templates…</p>
            ) : agentDisplayState === "error" ? (
              <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-blocked/40 bg-blocked/10 p-3 text-xs">
                <span className="text-blocked">{agentLoadError || "Couldn’t load Agent templates."}</span>
                <button type="button" onClick={onRetryAgents} className="shrink-0 rounded border border-blocked/40 px-2 py-1 text-[11px] text-blocked hover:bg-blocked/10">Retry</button>
              </div>
            ) : agentDisplayState === "empty" ? (
              <p className="rounded-lg border border-line bg-inset p-3 text-xs text-ink-4">No Agent templates available yet.</p>
            ) : (
              <div role="radiogroup" aria-label="Agent template" className={`grid grid-cols-2 gap-2 sm:grid-cols-3 ${attempted && !selectedAgent ? "rounded-lg ring-1 ring-blocked" : ""}`}>
                {agents.map((agent) => {
                  const active = selectedAgent === agent.name;
                  return (
                    <button
                      key={agent.name}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => selectAgent(agent.name)}
                      className={`relative min-h-16 rounded-lg border px-3 py-2 text-left transition-colors ${active ? "border-accent bg-accent-dim" : "border-line bg-inset hover:border-line-strong hover:bg-surface-2"}`}
                    >
                      <div className="flex items-center gap-2">
                        <UserRound size={14} className={active ? "text-accent-ink" : "text-ink-4"} />
                        <span className={`truncate text-sm font-medium ${active ? "text-accent-ink" : "text-ink-2"}`}>{displayAgentName(agent.name)}</span>
                        {active && <Check size={13} className="ml-auto shrink-0 text-accent-ink" />}
                      </div>
                      {agent.description && <p className="mt-1 line-clamp-1 text-[10px] text-ink-4">{agent.description}</p>}
                    </button>
                  );
                })}
              </div>
            )}
            {(agentDisplayState === "empty" || agentDisplayState === "items") && attempted && !selectedAgent && <p className="mt-1.5 text-[11px] text-blocked">Choose an Agent.</p>}
          </fieldset>

          <label className="block space-y-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-4">Member name</span>
            <input
              value={memberName}
              onChange={(event) => setMemberName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); save(); } }}
              autoFocus={Boolean(editing)}
              className={`w-full rounded-lg border bg-inset px-3 py-2.5 font-mono text-sm text-ink-1 outline-none ${attempted && (invalidName || duplicate) ? "border-blocked" : "border-line focus:border-line-strong"}`}
              placeholder="developer"
            />
            {duplicate ? (
              <p className="text-[11px] text-blocked">This draft already has a member named {trimmedName}. Pick another name.</p>
            ) : attempted && invalidName ? (
              <p className="text-[11px] text-blocked">{invalidName}</p>
            ) : (
              <p className="text-[11px] text-ink-4">Mention target: <span className="font-mono text-ink-3">@{trimmedName || "member-name"}</span></p>
            )}
          </label>

          {selectedAgent && (
            <div className="flex items-start gap-2 rounded-lg border border-line-soft bg-inset p-3">
              <Info size={14} className="mt-0.5 shrink-0 text-ink-4" />
              <p className="text-[11px] leading-4 text-ink-4"><span className="font-medium text-ink-3">{displayAgentName(selectedAgentInfo?.name || selectedAgent)}</span> defaults will be used for model, thinking, and tools. You can change them after creating the Room.</p>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm text-ink-4 hover:bg-surface-2 hover:text-ink-1">Cancel</button>
          <button type="button" onClick={save} className={`rounded-lg px-4 py-2 text-sm font-semibold ${canSave ? "bg-accent text-accent-contrast hover:opacity-90" : "bg-surface-3 text-ink-3"}`}>
            {editing ? "Save changes" : "Add member"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
