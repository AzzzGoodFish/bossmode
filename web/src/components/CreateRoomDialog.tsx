import { useState, useEffect, type FormEvent } from "react";
import type { MemberInfo, ModelOption, AgentInfo } from "../api/client";
import { ModelPicker } from "./ModelPicker";
import { Sheet } from "./Sheet";
import { FolderPicker } from "./FolderPicker";
import { getMembers, createMember, getConfiguredModels, getAgents } from "../api/client";
import { useDialog } from "./dialogs";
import { Crown, FolderOpen } from "lucide-react";

interface CreateRoomDialogProps {
  onClose: () => void;
  onSubmit: (name: string, cwd: string, members: string[], ruleDocs?: string[], promptLeaderMemberName?: string) => void;
}


export function CreateRoomDialog({ onClose, onSubmit }: CreateRoomDialogProps) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());
  const [leaderName, setLeaderName] = useState("");

  // Inline member creation
  const [creatingForAgent, setCreatingForAgent] = useState<string | null>(null);

  const refreshMembers = () => getMembers().then(setMembers).catch(console.error);

  useEffect(() => {
    refreshMembers();
    getAgents().then(setAgents).catch(console.error);
  }, []);

  const toggleMember = (memberName: string) => {
    setSelectedMembers((prev) => {
      const next = new Set(prev);
      if (next.has(memberName)) {
        next.delete(memberName);
      } else {
        next.add(memberName);
        if (!leaderName) setLeaderName(memberName);
      }
      return next;
    });
  };

  useEffect(() => {
    if (leaderName && !selectedMembers.has(leaderName)) setLeaderName("");
  }, [leaderName, selectedMembers]);

  const canSubmit = name.trim() && cwd.trim() && selectedMembers.size > 0 && leaderName;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(
      name.trim(),
      cwd.trim(),
      Array.from(selectedMembers),
      undefined,
      leaderName,
    );
  };

  return (
    <Sheet open onClose={onClose} size="lg" closeOnOverlayClick={false}>
      <form onSubmit={handleSubmit} className="bg-surface-1 rounded-lg p-6 w-full space-y-4">
        <h2 className="text-lg font-semibold text-ink-1">Create Room</h2>

        <div>
          <label className="block text-sm text-ink-4 mb-1">Room Name</label>
          <input autoComplete="off" type="text" value={name} onChange={(e) => setName(e.target.value)}
            className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors"
            placeholder="e.g., openteam dev" autoFocus required />
        </div>

        <div>
          <label className="block text-sm text-ink-4 mb-1">Working Directory</label>
          <div className="flex items-center gap-2">
            <input autoComplete="off" type="text" value={cwd} onChange={(e) => setCwd(e.target.value)}
              className="flex-1 bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors font-mono"
              placeholder="/path/to/your/project" required />
            <button
              type="button"
              title="Browse folders"
              onClick={() => setShowFolderPicker(true)}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center text-ink-4 hover:text-ink-1 bg-inset border border-line rounded transition-colors cursor-pointer"
            >
              <FolderOpen size={16} />
            </button>
          </div>
        </div>

        {/* Members */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-ink-4">Members ({selectedMembers.size} selected)</label>
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {members.length === 0 && (
              <p className="text-xs text-ink-3">No members configured. Create one from an agent below.</p>
            )}
            {members.filter((m) => m.name !== "summarizer").map((m) => (
              <label key={m.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-surface-2 cursor-pointer">
                <input autoComplete="off" type="checkbox" checked={selectedMembers.has(m.name)} onChange={() => toggleMember(m.name)} />
                <span className="text-sm text-ink-2">{m.name}</span>
                <span className="text-xs text-ink-3 ml-auto">{m.agent} · {m.model || "agent default"}</span>
              </label>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <select
              value={creatingForAgent || ""}
              onChange={(e) => e.target.value && setCreatingForAgent(e.target.value)}
              className="flex-1 bg-inset border border-line rounded px-2 py-1.5 text-xs text-ink-1 focus:outline-none focus:border-line-strong transition-colors"
            >
              <option value="">Create member from agent…</option>
              {agents.map((agent) => <option key={agent.name} value={agent.name}>{agent.name}</option>)}
            </select>
            <button type="button" onClick={() => setCreatingForAgent(agents[0]?.name || null)} disabled={agents.length === 0}
              className="px-2 py-1.5 text-xs rounded bg-surface-2 text-ink-2 hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              New member
            </button>
          </div>
        </div>

        <div>
          <label className="text-sm text-ink-4 mb-1 flex items-center gap-1.5">
            <Crown size={13} className="text-think" />
            Room leader
          </label>
          <select
            value={leaderName}
            onChange={(e) => setLeaderName(e.target.value)}
            className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors"
            required
          >
            <option value="">Select a room leader…</option>
            {Array.from(selectedMembers).map((memberName) => (
              <option key={memberName} value={memberName}>{memberName}</option>
            ))}
          </select>
          <p className="text-xs text-ink-3 mt-1.5">The leader can maintain the Room Supplemental Prompt through tools. You can change this later in Room Settings.</p>
        </div>

        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-ink-4 hover:text-ink-1 cursor-pointer">Cancel</button>
          <button type="submit" disabled={!canSubmit}
            className="px-4 py-2 bg-accent hover:opacity-90 disabled:bg-surface-3 disabled:text-ink-3 text-white text-sm font-medium rounded-lg cursor-pointer">Create</button>
        </div>
      </form>

      {creatingForAgent && (
        <InlineCreateMember
          agentName={creatingForAgent}
          onCreated={(newMember) => {
            setCreatingForAgent(null);
            refreshMembers();
            setSelectedMembers((prev) => new Set([...prev, newMember.name]));
          }}
          onClose={() => setCreatingForAgent(null)}
        />
      )}

      {showFolderPicker && (
        <FolderPicker
          open={showFolderPicker}
          initialPath={cwd || undefined}
          onConfirm={(path) => { setCwd(path); setShowFolderPicker(false); }}
          onCancel={() => setShowFolderPicker(false)}
        />
      )}
    </Sheet>
  );
}

function InlineCreateMember({
  agentName, onCreated, onClose,
}: {
  agentName: string; onCreated: (member: MemberInfo) => void; onClose: () => void;
}) {
  const { toast } = useDialog();
  const [name, setName] = useState(agentName);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelValue, setModelValue] = useState<{ model: string | null; credentialId: string | null }>({ model: null, credentialId: null });
  const [saving, setSaving] = useState(false);

  useEffect(() => { getConfiguredModels().then(setModels).catch(() => setModels([])); }, []);

  const getModelPayload = () => ({ model: modelValue.model, credentialId: modelValue.credentialId });

  const handleCreate = async () => {
    setSaving(true);
    try {
      const modelPayload = getModelPayload();
      const member = await createMember({ name, agent: agentName, ...modelPayload, thinkingLevel: "off" });
      onCreated(member);
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open onClose={onClose} size="sm" closeOnOverlayClick={false}>
      <div className="bg-surface-1 rounded-lg p-5 w-full space-y-3">
        <h3 className="text-sm font-semibold text-ink-1">Create Member for "{agentName}"</h3>
        <div>
          <label className="block text-xs text-ink-4 mb-1">Name</label>
          <input autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} autoFocus
            className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors" />
        </div>
        <div>
          <label className="block text-xs text-ink-4 mb-1">Model</label>
          <ModelPicker value={modelValue} models={models} onChange={setModelValue} />
          <p className="text-xs text-ink-3 mt-1">Choose from Settings → Model Credentials, or follow the agent default.</p>
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-ink-4 hover:text-ink-1 cursor-pointer">Cancel</button>
          <button type="button" onClick={handleCreate} disabled={!name || saving}
            className="px-4 py-2 bg-accent text-accent-contrast hover:opacity-90 disabled:opacity-40 text-sm font-medium rounded-lg cursor-pointer">
            {saving ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
