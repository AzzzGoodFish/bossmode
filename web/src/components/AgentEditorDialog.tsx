import { useState, useEffect } from "react";
import { Save } from "lucide-react";
import { Sheet } from "./Sheet";
import { MarkdownEditor } from "./MarkdownEditor";
import { useDialog } from "./dialogs";
import { userActionError } from "../utils/user-error";
import {
  type AgentDetail,
  type SkillInfo,
  getSkills,
  createAgent,
  updateAgent,
} from "../api/client";

/**
 * Team prototype (GOO-138 v2): agent template create/edit dialog.
 * fish ruling: a template is exactly name + system prompt + skills.
 * Model / thinking / MCP are member (room) properties and do NOT appear here.
 */

interface AgentEditorDialogProps {
  /** null = create mode */
  agent: AgentDetail | null;
  onClose: () => void;
  onSaved: (name: string) => void;
}

function composeContent(fields: {
  name: string;
  description: string;
  skills: string[];
  tags?: string[];
  avatar?: string;
  model?: string;
  prompt: string;
}): string {
  const lines: string[] = ["---"];
  lines.push(`name: ${JSON.stringify(fields.name)}`);
  lines.push(`description: ${JSON.stringify(fields.description)}`);
  // model preserved on edit for backward-compat (not editable here; member owns runtime model)
  if (fields.model) lines.push(`model: ${JSON.stringify(fields.model)}`);
  if (fields.skills.length) {
    lines.push("skills:");
    for (const s of fields.skills) lines.push(`  - ${s}`);
  }
  if (fields.tags?.length) {
    lines.push("tags:");
    for (const t of fields.tags) lines.push(`  - ${t}`);
  }
  if (fields.avatar) lines.push(`avatar: ${JSON.stringify(fields.avatar)}`);
  lines.push("---", "", fields.prompt.trim(), "");
  return lines.join("\n");
}

export function AgentEditorDialog({ agent, onClose, onSaved }: AgentEditorDialogProps) {
  const { toast } = useDialog();
  const isCreate = agent === null;
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [selectedSkills, setSelectedSkills] = useState<string[]>(agent?.skills ?? []);
  const [prompt, setPrompt] = useState(agent?.systemPrompt ?? "");
  const [allSkills, setAllSkills] = useState<SkillInfo[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => { getSkills().then(setAllSkills).catch(console.error); }, []);

  const toggleSkill = (item: string) =>
    setSelectedSkills((prev) => (prev.includes(item) ? prev.filter((x) => x !== item) : [...prev, item]));

  const handleSave = async () => {
    const agentName = name.trim().toLowerCase().replace(/\s+/g, "-");
    if (!agentName) { toast("Name is required", "error"); return; }
    if (!prompt.trim()) { toast("System prompt is required", "error"); return; }
    setSaving(true);
    try {
      const content = composeContent({
        name: agentName,
        description: description.trim(),
        skills: selectedSkills,
        tags: agent?.tags?.filter((t) => t !== "builtin"),
        avatar: agent?.avatar,
        model: agent?.model,
        prompt,
      });
      if (isCreate) await createAgent(agentName, content);
      else await updateAgent(agent!.name, content);
      onSaved(agentName);
    } catch (err) {
      console.error("Failed to save Agent", err);
      toast(userActionError("save this Agent", "Check the required fields, then try again."), "error");
    } finally {
      setSaving(false);
    }
  };

  const labelCls = "block text-[11px] font-semibold tracking-[0.05em] text-ink-4 uppercase mb-1.5";
  const inputCls = "w-full bg-surface-0 border border-line rounded-md px-3 py-2 text-[13px] text-ink-1 focus:outline-none focus:border-line-strong placeholder:text-ink-4";
  const chipCls = (on: boolean) =>
    `px-2.5 py-1 rounded-full text-[11.5px] border cursor-pointer transition-colors ${
      on ? "bg-accent-dim text-accent-ink border-accent/40" : "bg-surface-0 text-ink-3 border-line hover:border-line-strong"
    }`;

  return (
    <Sheet open onClose={onClose} size="2xl" closeOnOverlayClick={false}>
      <div className="p-6">
        <h2 className="text-[15px] font-semibold text-ink-1 mb-1">{isCreate ? "New Agent" : `Edit ${agent!.name}`}</h2>
        <p className="text-[11.5px] text-ink-4 mb-5">
          An agent template is name + prompt + skills. Model, thinking and MCP are configured per member in each room.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className={labelCls}>Name</label>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. data-analyst" disabled={!isCreate} />
          </div>
          <div>
            <label className={labelCls}>Description <span className="normal-case font-normal">(optional, shown on roster)</span></label>
            <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="One line: role and responsibility" />
          </div>
        </div>

        <div className="mb-4">
          <label className={labelCls}>Skills</label>
          <div className="flex flex-wrap gap-1.5">
            {allSkills.map((s) => (
              <button key={s.name} onClick={() => toggleSkill(s.name)} className={chipCls(selectedSkills.includes(s.name))}>{s.name}</button>
            ))}
            {allSkills.length === 0 && <span className="text-[11px] text-ink-4">No skills yet — create one in Team → Skills.</span>}
          </div>
        </div>

        <div className="mb-5">
          <label className={labelCls}>System prompt</label>
          <div className="border border-line rounded-md overflow-hidden">
            <MarkdownEditor value={prompt} onChange={setPrompt} placeholder="Who is this agent? How should they work?" className="min-h-[280px] max-h-[42vh] overflow-y-auto" />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-[12.5px] text-ink-4 hover:text-ink-1 cursor-pointer">Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="flex items-center gap-1.5 px-4 py-2 bg-accent text-accent-contrast text-[12.5px] font-semibold rounded-md cursor-pointer hover:opacity-90 disabled:opacity-50">
            <Save size={13} /> {saving ? "Saving…" : isCreate ? "Create agent" : "Save"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}
