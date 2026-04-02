import { useState, useEffect } from "react";
import { ArrowLeft, Save, Trash2, Pencil, X } from "lucide-react";
import { getAgent, updateAgent, deleteAgent, createAgent } from "../api/client";
import { Markdown } from "../components/Markdown";
import { useDialog } from "../components/dialogs";

interface AgentDetailPageProps {
  name: string;
  onBack: () => void;
  isCreate?: boolean;
  onCreated?: (name: string) => void;
}

const editBtnCls = "px-3 py-1.5 text-sm border rounded bg-white hover:bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-300 dark:border-zinc-700 cursor-pointer transition-colors";

export function AgentDetailPage({ name, onBack, isCreate, onCreated }: AgentDetailPageProps) {
  const { toast, confirm } = useDialog();
  const [agentName, setAgentName] = useState(name);
  const [agentData, setAgentData] = useState<any>(null);
  const [content, setContent] = useState(isCreate ? "---\nname: \"\"\ndescription: \"\"\nmodel: \"sonnet\"\nskills: []\n---\n\n" : "");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(!isCreate);
  const [editing, setEditing] = useState(!!isCreate);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const loadAgent = () => {
    setLoading(true);
    getAgent(name)
      .then((agent) => {
        setAgentData(agent);
        const raw = reconstructMarkdown(agent);
        setContent(raw);
        setOriginalContent(raw);
      })
      .catch((err) => toast(`Failed to load: ${err.message}`, "error"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!isCreate) loadAgent();
  }, [name, isCreate]);

  const handleSave = async () => {
    setSaveState("saving");
    try {
      if (isCreate) {
        if (!agentName) { toast("Name is required", "error"); setSaveState("idle"); return; }
        await createAgent(agentName, content);
        onCreated?.(agentName);
      } else {
        await updateAgent(name, content);
        setOriginalContent(content);
        setEditing(false);
        loadAgent(); // refresh preview data
      }
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 1500);
    } catch (err: any) {
      toast(`Save failed: ${err.message}`, "error");
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 3000);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm(`Delete agent "${name}"? This cannot be undone.`))) return;
    try { await deleteAgent(name); onBack(); }
    catch (err: any) { toast(`Delete failed: ${err.message}`, "error"); }
  };

  const handleCancel = () => {
    setContent(originalContent);
    setEditing(false);
  };

  const isBuiltin = agentData?.tags?.includes("builtin");

  if (loading) return <div className="flex-1 flex items-center justify-center text-zinc-500">Loading...</div>;

  return (
    <div className="flex-1 flex flex-col p-6 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-white transition-colors cursor-pointer">
            <ArrowLeft size={18} />
          </button>
          {isCreate ? (
            <input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="agent-name"
              className="text-lg font-bold text-zinc-900 dark:text-white bg-transparent border-b border-zinc-300 dark:border-zinc-700 focus:border-blue-500 outline-none px-1" />
          ) : (
            <>
              {agentData?.avatar && <span className="text-lg">{agentData.avatar}</span>}
              <h1 className="text-lg font-bold text-zinc-900 dark:text-white">{name}</h1>
              <span className="text-xs text-zinc-400 dark:text-zinc-500">Agent · {name}.md</span>
              {isBuiltin && (
                <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-medium uppercase tracking-wide">built-in</span>
              )}
            </>
          )}
          {editing && !isCreate && <span className="text-xs text-amber-500 font-medium">Editing</span>}
        </div>
        <div className="flex items-center gap-2">
          {!isCreate && !editing && !isBuiltin && (
            <>
              <button onClick={() => setEditing(true)} className={`flex items-center gap-1 ${editBtnCls}`}>
                <Pencil size={14} /> Edit
              </button>
              <button onClick={handleDelete}
                className="flex items-center gap-1 px-3 py-1.5 text-red-500 dark:text-red-400 hover:text-red-400 dark:hover:text-red-300 text-sm cursor-pointer">
                <Trash2 size={14} /> Delete
              </button>
            </>
          )}
          {editing && (
            <>
              {!isCreate && (
                <button onClick={handleCancel} className={`flex items-center gap-1 ${editBtnCls}`}>
                  <X size={14} /> Cancel
                </button>
              )}
              <button onClick={handleSave} disabled={saveState === "saving"}
                className={`flex items-center gap-1 px-3 py-1.5 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer ${
                  saveState === "saved" ? "bg-emerald-600" : saveState === "error" ? "bg-red-600" : "bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-200 disabled:text-zinc-400 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-500"
                }`}>
                <Save size={14} /> {saveState === "saving" ? "Saving..." : saveState === "saved" ? "✓ Saved" : saveState === "error" ? "✗ Failed" : isCreate ? "Create" : "Save"}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Preview mode */}
      {!editing && agentData && (
        <div className="flex-1 overflow-y-auto">
          {/* Meta badges */}
          {(agentData.tags?.length > 0 || agentData.skills?.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 mb-4">
              {agentData.tags?.length > 0 && (
                <>
                  <span className="text-xs text-zinc-500">Tags:</span>
                  {agentData.tags.filter((t: string) => t !== "builtin").map((t: string) => (
                    <span key={t} className="text-xs px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded">{t}</span>
                  ))}
                  {agentData.skills?.length > 0 && <span className="text-zinc-300 dark:text-zinc-600">·</span>}
                </>
              )}
              {agentData.skills?.length > 0 && (
                <>
                  <span className="text-xs text-zinc-500">Skills:</span>
                  {agentData.skills.map((s: string) => (
                    <span key={s} className="text-xs px-2 py-0.5 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded">{s}</span>
                  ))}
                </>
              )}
            </div>
          )}
          {/* Builtin agent info card */}
          {isBuiltin ? (
            <div className="bg-white dark:bg-zinc-800/30 border border-zinc-200 dark:border-zinc-800 rounded-lg px-6 py-5">
              <div className="flex items-center gap-3 mb-4">
                <span className="text-2xl">{agentData.avatar || ">_"}</span>
                <div>
                  <div className="text-sm font-semibold text-zinc-900 dark:text-white">{agentData.description}</div>
                </div>
              </div>
              <div className="space-y-2 text-sm text-zinc-600 dark:text-zinc-400">
                <p>A general-purpose CLI agent that preserves the runtime&apos;s default system prompt.</p>
                <ul className="list-disc list-inside space-y-1 mt-3">
                  <li>No custom system prompt injected</li>
                  <li>No skills pre-loaded</li>
                  <li>Bossmode tools (chat, knowledge) are available</li>
                  <li>Define roles dynamically in conversation</li>
                </ul>
                <p className="text-xs text-zinc-500 dark:text-zinc-600 mt-4 italic">This agent cannot be edited or deleted.</p>
              </div>
            </div>
          ) : (
            /* Markdown preview */
            <div className="bg-white dark:bg-zinc-800/30 border border-zinc-200 dark:border-zinc-800 rounded-lg px-6 py-5 text-sm text-zinc-800 dark:text-zinc-300 leading-relaxed">
              <Markdown content={agentData.systemPrompt || ""} />
            </div>
          )}
        </div>
      )}

      {/* Edit mode */}
      {editing && (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="flex-1 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-3 text-sm text-zinc-800 dark:text-zinc-300 font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-600 overflow-y-auto"
          spellCheck={false}
        />
      )}
    </div>
  );
}

function reconstructMarkdown(agent: any): string {
  const meta: Record<string, unknown> = {
    name: agent.name,
    description: agent.description,
    model: agent.model,
  };
  if (agent.skills?.length) meta.skills = agent.skills;
  if (agent.tags?.length) meta.tags = agent.tags;
  if (agent.avatar) meta.avatar = agent.avatar;

  const lines: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    if (Array.isArray(value)) {
      if (value.length > 0) {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${item}`);
      }
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }

  return `---\n${lines.join("\n")}\n---\n\n${agent.systemPrompt}`;
}
