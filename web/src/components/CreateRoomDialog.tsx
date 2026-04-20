import { useState, useEffect, useMemo, type FormEvent } from "react";
import type { MemberInfo, RuntimeInfo, KnowledgeTreeNode } from "../api/client";
import { getMembers, getRuntimes, getKnowledgeTree, createMember } from "../api/client";
import { useDialog } from "./dialogs";
import { Shield, Folder, FolderOpen, File as FileIcon, ChevronRight, ChevronDown } from "lucide-react";

interface CreateRoomDialogProps {
  onClose: () => void;
  onSubmit: (name: string, cwd: string, members: string[], ruleDocs?: string[]) => void;
}

export function CreateRoomDialog({ onClose, onSubmit }: CreateRoomDialogProps) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [members, setMembers] = useState<MemberInfo[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
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
    getRuntimes().then(setRuntimes).catch(console.error);
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
            placeholder="/path/to/your/project" required />
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

// -- Rules tree (dialog-embedded, compact) --

function RulesTree({ nodes, selected, onToggle }: {
  nodes: KnowledgeTreeNode[];
  selected: Set<string>;
  onToggle: (path: string) => void;
}) {
  return (
    <ul className="text-sm">
      {nodes.map((node) => (
        <RulesTreeNode key={node.path} node={node} depth={0} selected={selected} onToggle={onToggle} />
      ))}
    </ul>
  );
}

function RulesTreeNode({ node, depth, selected, onToggle }: {
  node: KnowledgeTreeNode;
  depth: number;
  selected: Set<string>;
  onToggle: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  const indent = { paddingLeft: `${depth * 12 + 4}px` };

  if (node.kind === "folder") {
    return (
      <li>
        <div style={indent}
          className="flex items-center gap-1 py-0.5 cursor-pointer text-zinc-300 hover:text-white"
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown size={12} className="text-zinc-500 shrink-0" /> : <ChevronRight size={12} className="text-zinc-500 shrink-0" />}
          {open ? <FolderOpen size={12} className="text-amber-500 shrink-0" /> : <Folder size={12} className="text-amber-500 shrink-0" />}
          <span className="text-xs truncate">{node.name}</span>
        </div>
        {open && node.children && (
          <ul>
            {node.children.map((c) => (
              <RulesTreeNode key={c.path} node={c} depth={depth + 1} selected={selected} onToggle={onToggle} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isSelected = selected.has(node.path);
  return (
    <li>
      <label style={indent}
        className="flex items-center gap-1.5 py-0.5 cursor-pointer rounded hover:bg-zinc-800/60"
      >
        <span className="w-3 shrink-0" />
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onToggle(node.path)}
          className="shrink-0"
        />
        <FileIcon size={11} className="text-zinc-500 shrink-0" />
        <span className={`text-xs truncate ${isSelected ? "text-amber-400" : "text-zinc-300"}`}>
          {node.title || node.name}
        </span>
        <span className="text-[10px] text-zinc-600 ml-auto font-mono truncate pl-2">{node.path}</span>
      </label>
    </li>
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
