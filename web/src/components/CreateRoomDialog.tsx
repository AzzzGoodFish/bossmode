import { useState, useEffect, type FormEvent } from "react";
import type { MemberInfo, RuntimeInfo, KnowledgeBaseInfo, KnowledgeEntryInfo } from "../api/client";
import { getMembers, getRuntimes, getKnowledgeBases, getKnowledgeEntries, createMember } from "../api/client";
import { useDialog } from "./dialogs";

interface CreateRoomDialogProps {
  onClose: () => void;
  onSubmit: (name: string, cwd: string, members: string[], knowledgeBaseId?: string, ruleIds?: string[]) => void;
}

export function CreateRoomDialog({ onClose, onSubmit }: CreateRoomDialogProps) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());

  // Knowledge
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseInfo[]>([]);
  const [selectedKbId, setSelectedKbId] = useState<string>("");
  const [kbEntries, setKbEntries] = useState<KnowledgeEntryInfo[]>([]);
  const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());

  // Inline member creation
  const [creatingForAgent, setCreatingForAgent] = useState<string | null>(null);

  const refreshMembers = () => getMembers().then(setMembers).catch(console.error);

  useEffect(() => {
    refreshMembers();
    getRuntimes().then(setRuntimes).catch(console.error);
    getKnowledgeBases().then(setKnowledgeBases).catch(console.error);
  }, []);

  // Load entries when KB changes
  useEffect(() => {
    if (selectedKbId) {
      getKnowledgeEntries(selectedKbId).then((entries) => {
        setKbEntries(entries);
        // Auto-select all rules
        const ruleIds = entries.filter((e) => e.type === "rule").map((e) => e.id);
        setSelectedRuleIds(new Set(ruleIds));
      }).catch(console.error);
    } else {
      setKbEntries([]);
      setSelectedRuleIds(new Set());
    }
  }, [selectedKbId]);

  const rules = kbEntries.filter((e) => e.type === "rule");

  const toggleMember = (memberName: string) => {
    setSelectedMembers((prev) => {
      const next = new Set(prev);
      next.has(memberName) ? next.delete(memberName) : next.add(memberName);
      return next;
    });
  };

  const toggleRule = (ruleId: string) => {
    setSelectedRuleIds((prev) => {
      const next = new Set(prev);
      next.has(ruleId) ? next.delete(ruleId) : next.add(ruleId);
      return next;
    });
  };

  const canSubmit = name.trim() && cwd.trim() && selectedMembers.size > 0;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(
      name.trim(),
      cwd.trim(),
      Array.from(selectedMembers),
      selectedKbId || undefined,
      selectedRuleIds.size > 0 ? Array.from(selectedRuleIds) : undefined,
    );
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 w-full max-w-lg space-y-4 max-h-[85vh] overflow-y-auto">
        <h2 className="text-lg font-semibold text-white">Create Room</h2>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">Room Name</label>
          <input autoComplete="off" type="text" value={name} onChange={(e) => setName(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600"
            placeholder="e.g., openteam dev" autoFocus required />
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">Working Directory</label>
          <input autoComplete="off" type="text" value={cwd} onChange={(e) => setCwd(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600 font-mono"
            placeholder="/home/fish/dev/project" required />
        </div>

        {/* Members */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-zinc-400">Members ({selectedMembers.size} selected)</label>
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {members.length === 0 && (
              <p className="text-xs text-zinc-600">No members configured. Go to Members page to create them.</p>
            )}
            {members.map((m) => (
              <label key={m.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-zinc-800 cursor-pointer">
                <input autoComplete="off" type="checkbox" checked={selectedMembers.has(m.name)} onChange={() => toggleMember(m.name)} />
                <span className="text-sm text-zinc-300">{m.name}</span>
                <span className="text-xs text-zinc-600 ml-auto">{m.agent} · {m.runtime}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Knowledge Base */}
        {knowledgeBases.length > 0 && (
          <div>
            <label className="block text-sm text-zinc-400 mb-1">Knowledge Base (optional)</label>
            <select value={selectedKbId} onChange={(e) => setSelectedKbId(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600">
              <option value="">None</option>
              {knowledgeBases.map((kb) => <option key={kb.id} value={kb.id}>{kb.name}</option>)}
            </select>
          </div>
        )}

        {/* Rules from selected KB */}
        {selectedKbId && rules.length > 0 && (
          <div>
            <label className="block text-sm text-zinc-400 mb-2">Rules ({selectedRuleIds.size}/{rules.length} selected)</label>
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {rules.map((r) => (
                <label key={r.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-zinc-800 cursor-pointer">
                  <input autoComplete="off" type="checkbox" checked={selectedRuleIds.has(r.id)} onChange={() => toggleRule(r.id)} />
                  <span className="text-sm text-amber-400">{r.title}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 hover:text-white cursor-pointer">Cancel</button>
          <button type="submit" disabled={!canSubmit}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-medium rounded-lg cursor-pointer">
            Create
          </button>
        </div>
      </form>

      {creatingForAgent && (
        <InlineCreateMember
          agentName={creatingForAgent}
          runtimes={runtimes}
          onCreated={(newMember) => {
            setCreatingForAgent(null);
            refreshMembers();
            setSelectedMembers((prev) => new Set([...prev, newMember.name]));
          }}
          onClose={() => setCreatingForAgent(null)}
        />
      )}
    </div>
  );
}

function InlineCreateMember({
  agentName, runtimes, onCreated, onClose,
}: {
  agentName: string; runtimes: RuntimeInfo[]; onCreated: (member: MemberInfo) => void; onClose: () => void;
}) {
  const { toast } = useDialog();
  const [name, setName] = useState(agentName);
  const [runtime, setRuntime] = useState("pi-cli");
  const [model, setModel] = useState("sonnet");
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    setSaving(true);
    try {
      const member = await createMember({ name, agent: agentName, model, runtime: runtime as any, thinkingLevel: "off" });
      onCreated(member);
    } catch (err: any) { toast(err.message, "error"); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]">
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5 w-full max-w-sm space-y-3">
        <h3 className="text-sm font-semibold text-white">Create Member for "{agentName}"</h3>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Name</label>
          <input autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} autoFocus
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600" />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Runtime</label>
          <select value={runtime} onChange={(e) => setRuntime(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600">
            {runtimes.filter((r) => r.available).map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Model</label>
          <input autoComplete="off" value={model} onChange={(e) => setModel(e.target.value)} placeholder="sonnet"
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600" />
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 hover:text-white cursor-pointer">Cancel</button>
          <button type="button" onClick={handleCreate} disabled={!name || saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white text-sm font-medium rounded-lg cursor-pointer">
            {saving ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
