import { useState, useEffect, useMemo, type FormEvent } from "react";
import type { MemberInfo, KnowledgeTreeNode, ModelOption, AgentInfo } from "../api/client";
import { Sheet } from "./Sheet";
import { FolderPicker } from "./FolderPicker";
import { getMembers, getKnowledgeTree, createMember, getConfiguredModels, getAgents } from "../api/client";
import { useDialog } from "./dialogs";
import { RulesTree } from "./RulesTree";
import { Shield, FolderOpen } from "lucide-react";
import { composeManualModelPayload, uniqueModelProfiles } from "../model-helpers";

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
      <form onSubmit={handleSubmit} className="bg-zinc-900 rounded-lg p-6 w-full space-y-4">
        <h2 className="text-lg font-semibold text-white">Create Room</h2>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">Room Name</label>
          <input autoComplete="off" type="text" value={name} onChange={(e) => setName(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600"
            placeholder="e.g., openteam dev" autoFocus required />
        </div>

        <div>
          <label className="block text-sm text-zinc-400 mb-1">Working Directory</label>
          <div className="flex items-center gap-2">
            <input autoComplete="off" type="text" value={cwd} onChange={(e) => setCwd(e.target.value)}
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600 font-mono"
              placeholder="/path/to/your/project" required />
            <button
              type="button"
              title="Browse folders"
              onClick={() => setShowFolderPicker(true)}
              className="min-w-[44px] min-h-[44px] flex items-center justify-center text-zinc-400 hover:text-zinc-200 bg-zinc-800 border border-zinc-700 rounded transition-colors cursor-pointer"
            >
              <FolderOpen size={16} />
            </button>
          </div>
        </div>

        {/* Members */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-zinc-400">Members ({selectedMembers.size} selected)</label>
          </div>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {members.length === 0 && (
              <p className="text-xs text-zinc-600">No members configured. Create one from an agent below.</p>
            )}
            {members.filter((m) => m.name !== "summarizer").map((m) => (
              <label key={m.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-zinc-800 cursor-pointer">
                <input autoComplete="off" type="checkbox" checked={selectedMembers.has(m.name)} onChange={() => toggleMember(m.name)} />
                <span className="text-sm text-zinc-300">{m.name}</span>
                <span className="text-xs text-zinc-600 ml-auto">{m.agent} · {m.model || "agent default"}</span>
              </label>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <select
              value={creatingForAgent || ""}
              onChange={(e) => e.target.value && setCreatingForAgent(e.target.value)}
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-2 focus:ring-blue-600"
            >
              <option value="">Create member from agent…</option>
              {agents.map((agent) => <option key={agent.name} value={agent.name}>{agent.name}</option>)}
            </select>
            <button type="button" onClick={() => setCreatingForAgent(agents[0]?.name || null)} disabled={agents.length === 0}
              className="px-2 py-1.5 text-xs rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              New member
            </button>
          </div>
        </div>

        {/* Rules: pick from the knowledge tree */}
        {allDocPaths.length > 0 && (
          <div>
            <label className="text-sm text-zinc-400 mb-1 flex items-center gap-1.5">
              <Shield size={13} className="text-amber-500" />
              Rules ({selectedRuleDocs.size} selected)
            </label>
            <p className="text-xs text-zinc-600 mb-2">
              Selected documents are injected into every agent's system prompt.
              Docs under <code>{"<cwd-basename>/rules/"}</code> or root <code>rules/</code> are preselected.
            </p>
            <div className="border border-zinc-800 rounded p-2 max-h-56 overflow-y-auto">
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
  const DEFAULT_MODEL_VALUE = "__agent_default__";
  const [model, setModel] = useState<string | undefined>();
  const [credentialId, setCredentialId] = useState<string | null>();
  const [models, setModels] = useState<ModelOption[]>([]);
  const [manualModel, setManualModel] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { getConfiguredModels().then(setModels).catch(() => setModels([])); }, []);

  const handleCreate = async () => {
    setSaving(true);
    try {
      const modelPayload = manualModel
        ? composeManualModelPayload(model, credentialId, models)
        : { model: model ?? null, credentialId: credentialId ?? null };
      const member = await createMember({ name, agent: agentName, ...modelPayload, runtime: "pi-cli", thinkingLevel: "off" });
      onCreated(member);
    } catch (err: any) { toast(err.message, "error"); }
    finally { setSaving(false); }
  };

  return (
    <Sheet open onClose={onClose} size="sm" closeOnOverlayClick={false}>
      <div className="bg-zinc-900 rounded-lg p-5 w-full space-y-3">
        <h3 className="text-sm font-semibold text-white">Create Member for "{agentName}"</h3>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Name</label>
          <input autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} autoFocus
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600" />
        </div>
        <div>
          <label className="block text-xs text-zinc-400 mb-1">Model</label>
          {!manualModel && models.length > 0 ? (
            <select value={credentialId && model ? `${credentialId}::${model}` : DEFAULT_MODEL_VALUE} onChange={(e) => { if (e.target.value === DEFAULT_MODEL_VALUE) { setModel(undefined); setCredentialId(null); return; } const [profileId, ref] = e.target.value.split("::"); setModel(ref); setCredentialId(profileId); }}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600">
              <option value={DEFAULT_MODEL_VALUE}>Use agent default</option>
              {models.map((m) => <option key={`${m.profileId}:${m.ref}`} value={`${m.profileId}::${m.ref}`}>{m.profileName} — {m.ref}</option>)}
            </select>
          ) : (
            <div className="space-y-2">
              {models.length > 0 && (
                <select value={credentialId || ""} onChange={(e) => setCredentialId(e.target.value || null)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600">
                  <option value="">No credential profile (enter full provider/model)</option>
                  {uniqueModelProfiles(models).map((p) => <option key={p.id} value={p.id}>{p.name} — {p.providerSlug}</option>)}
                </select>
              )}
              <input autoComplete="off" value={model || ""} onChange={(e) => setModel(e.target.value || undefined)} placeholder={credentialId ? "Enter model id" : "Use agent default, or enter provider/model"}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-600" />
            </div>
          )}
          <p className="text-xs text-zinc-500 mt-1">Uses the model configured on the agent definition unless a model is selected here.</p>
          <button type="button" onClick={() => setManualModel(!manualModel)} className="mt-1.5 text-xs text-blue-400 hover:text-blue-300 cursor-pointer">
            {manualModel ? "Choose from configured models" : "Enter model manually"}
          </button>
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 hover:text-white cursor-pointer">Cancel</button>
          <button type="button" onClick={handleCreate} disabled={!name || saving}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-700 text-white text-sm font-medium rounded-lg cursor-pointer">
            {saving ? "Creating..." : "Create"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
