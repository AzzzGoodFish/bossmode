import { useState, useEffect, useMemo, type FormEvent } from "react";
import type { MemberInfo, KnowledgeTreeNode, ModelOption, AgentInfo } from "../api/client";
import { ModelPicker } from "./ModelPicker";
import { Sheet } from "./Sheet";
import { FolderPicker } from "./FolderPicker";
import { getMembers, getKnowledgeTree, createMember, getConfiguredModels, getAgents } from "../api/client";
import { useDialog } from "./dialogs";
import { RulesTree } from "./RulesTree";
import { Shield, FolderOpen } from "lucide-react";

interface CreateRoomDialogProps {
  onClose: () => void;
  onSubmit: (name: string, cwd: string, members: string[], ruleDocs?: string[]) => void;
}


export function CreateRoomDialog({ onClose, onSubmit }: CreateRoomDialogProps) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [showFolderPicker, setShowFolderPicker] = useState(false);
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<Set<string>>(new Set());

  // Knowledge tree for rules selection
  const [tree, setTree] = useState<KnowledgeTreeNode | null>(null);
  const [selectedRuleDocs, setSelectedRuleDocs] = useState<Set<string>>(new Set());
  const [autoSelectApplied, setAutoSelectApplied] = useState(false);

  // Inline member creation
  const [creatingForAgent, setCreatingForAgent] = useState<string | null>(null);

  const refreshMembers = () => getMembers().then(setMembers).catch(console.error);

  useEffect(() => {
    refreshMembers();
    getAgents().then(setAgents).catch(console.error);
    getKnowledgeTree().then(setTree).catch(console.error);
  }, []);

  // All markdown file paths in the tree (flat)
  const allDocPaths = useMemo(() => {
    if (!tree?.children) return [] as string[];
    const out: string[] = [];
    const walk = (nodes: KnowledgeTreeNode[]) => {
      for (const n of nodes) {
        if (n.kind === "file") out.push(n.path);
        else if (n.children) walk(n.children);
      }
    };
    walk(tree.children);
    return out;
  }, [tree]);

  // Heuristic auto-select: when user types a cwd, suggest rules/ docs under
  // <cwd-basename>/ (e.g. "/home/fish/dev/llm/bossmode" → "bossmode/rules/*").
  // Falls back to top-level "rules/*" if no project-specific rules exist.
  useEffect(() => {
    if (autoSelectApplied || allDocPaths.length === 0 || !cwd.trim()) return;
    const basename = cwd.trim().replace(/\/+$/, "").split("/").pop() || "";
    const candidates = basename
      ? allDocPaths.filter((p) => p.startsWith(`${basename}/rules/`))
      : [];
    const fallback = candidates.length === 0
      ? allDocPaths.filter((p) => p.startsWith("rules/"))
      : candidates;
    if (fallback.length > 0) {
      setSelectedRuleDocs(new Set(fallback));
      setAutoSelectApplied(true);
    }
  }, [cwd, allDocPaths, autoSelectApplied]);

  const toggleMember = (memberName: string) => {
    setSelectedMembers((prev) => {
      const next = new Set(prev);
      next.has(memberName) ? next.delete(memberName) : next.add(memberName);
      return next;
    });
  };

  const toggleRuleDoc = (docPath: string) => {
    setSelectedRuleDocs((prev) => {
      const next = new Set(prev);
      next.has(docPath) ? next.delete(docPath) : next.add(docPath);
      return next;
    });
    // Once the user manually touches the selection, disable auto-apply
    setAutoSelectApplied(true);
  };

  const canSubmit = name.trim() && cwd.trim() && selectedMembers.size > 0;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(
      name.trim(),
      cwd.trim(),
      Array.from(selectedMembers),
      selectedRuleDocs.size > 0 ? Array.from(selectedRuleDocs) : undefined,
    );
  };

  return (
    <Sheet open onClose={onClose} size="lg" closeOnOverlayClick={false}>
      <form onSubmit={handleSubmit} className="bg-surface-1 rounded-lg p-6 w-full space-y-4">
        <h2 className="text-lg font-semibold text-white">Create Room</h2>

        <div>
          <label className="block text-sm text-ink-4 mb-1">Room Name</label>
          <input autoComplete="off" type="text" value={name} onChange={(e) => setName(e.target.value)}
            className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-line-strong transition-colors"
            placeholder="e.g., openteam dev" autoFocus required />
        </div>

        <div>
          <label className="block text-sm text-ink-4 mb-1">Working Directory</label>
          <div className="flex items-center gap-2">
            <input autoComplete="off" type="text" value={cwd} onChange={(e) => setCwd(e.target.value)}
              className="flex-1 bg-inset border border-line rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-line-strong transition-colors font-mono"
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

        {/* Rules: pick from the knowledge tree */}
        {allDocPaths.length > 0 && (
          <div>
            <label className="text-sm text-ink-4 mb-1 flex items-center gap-1.5">
              <Shield size={13} className="text-think" />
              Rules ({selectedRuleDocs.size} selected)
            </label>
            <p className="text-xs text-ink-3 mb-2">
              Selected documents are injected into every agent's system prompt.
              Docs under <code>{"<cwd-basename>/rules/"}</code> or root <code>rules/</code> are preselected.
            </p>
            <div className="border border-line-soft rounded p-2 max-h-56 overflow-y-auto">
              {tree?.children && (
                <RulesTree
                  nodes={tree.children}
                  selected={selectedRuleDocs}
                  onToggle={toggleRuleDoc}
                />
              )}
            </div>
          </div>
        )}

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
        <h3 className="text-sm font-semibold text-white">Create Member for "{agentName}"</h3>
        <div>
          <label className="block text-xs text-ink-4 mb-1">Name</label>
          <input autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} autoFocus
            className="w-full bg-inset border border-line rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-line-strong transition-colors" />
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
