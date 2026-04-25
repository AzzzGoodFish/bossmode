import { useState, useEffect } from "react";
import { ArrowLeft, Save, Trash2, Pencil, X } from "lucide-react";
import { MobileTopBar } from "../components/MobileTopBar";
import { getSkill, updateSkill, deleteSkill, createSkill } from "../api/client";
import { Markdown } from "../components/Markdown";
import { useDialog } from "../components/dialogs";

interface SkillDetailPageProps {
  name: string;
  onBack: () => void;
  isCreate?: boolean;
  onCreated?: (name: string) => void;
  onOpenMobileSidebar?: () => void;
}

const editBtnCls = "px-3 py-1.5 text-sm border rounded bg-white hover:bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:text-zinc-300 dark:border-zinc-700 cursor-pointer transition-colors";

export function SkillDetailPage({ name, onBack, isCreate, onCreated, onOpenMobileSidebar }: SkillDetailPageProps) {
  const { toast, confirm } = useDialog();
  const [skillName, setSkillName] = useState(name);
  const [skillData, setSkillData] = useState<any>(null);
  const [content, setContent] = useState(isCreate ? "---\nname: \"\"\ndescription: \"\"\n---\n\n" : "");
  const [originalContent, setOriginalContent] = useState("");
  const [loading, setLoading] = useState(!isCreate);
  const [editing, setEditing] = useState(!!isCreate);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const loadSkill = () => {
    setLoading(true);
    getSkill(name)
      .then((skill) => {
        setSkillData(skill);
        const raw = reconstructSkillMarkdown(skill);
        setContent(raw);
        setOriginalContent(raw);
      })
      .catch((err) => toast(`Failed to load: ${err.message}`, "error"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (!isCreate) loadSkill();
  }, [name, isCreate]);

  const handleSave = async () => {
    setSaveState("saving");
    try {
      if (isCreate) {
        if (!skillName) { toast("Name is required", "error"); setSaveState("idle"); return; }
        await createSkill(skillName, content);
        onCreated?.(skillName);
      } else {
        await updateSkill(name, content);
        setOriginalContent(content);
        setEditing(false);
        loadSkill();
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
    if (!(await confirm(`Delete skill "${name}"? This cannot be undone.`))) return;
    try { await deleteSkill(name); onBack(); }
    catch (err: any) { toast(`Delete failed: ${err.message}`, "error"); }
  };

  const handleCancel = () => {
    setContent(originalContent);
    setEditing(false);
  };

  if (loading) return <div className="flex-1 flex items-center justify-center text-zinc-500">Loading...</div>;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <MobileTopBar title={isCreate ? "New Skill" : name} onOpenSidebar={onOpenMobileSidebar || (() => {})} />
      <div className="flex-1 flex flex-col p-6 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-zinc-400 dark:text-zinc-500 hover:text-zinc-900 dark:hover:text-white transition-colors cursor-pointer">
            <ArrowLeft size={18} />
          </button>
          {isCreate ? (
            <input value={skillName} onChange={(e) => setSkillName(e.target.value)} placeholder="skill-name"
              className="text-lg font-bold text-zinc-900 dark:text-white bg-transparent border-b border-zinc-300 dark:border-zinc-700 focus:border-blue-500 outline-none px-1" />
          ) : (
            <>
              <h1 className="text-lg font-bold text-zinc-900 dark:text-white">{name}</h1>
              <span className="text-xs text-zinc-400 dark:text-zinc-500">Skill · {name}/SKILL.md</span>
            </>
          )}
          {editing && !isCreate && <span className="text-xs text-amber-500 font-medium">Editing</span>}
        </div>
        <div className="flex items-center gap-2">
          {!isCreate && !editing && (
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
      {!editing && skillData && (
        <div className="flex-1 overflow-y-auto">
          {skillData.tags?.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-4">
              {skillData.tags.map((t: string) => (
                <span key={t} className="text-xs px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded">{t}</span>
              ))}
            </div>
          )}
          <div className="bg-white dark:bg-zinc-800/30 border border-zinc-200 dark:border-zinc-800 rounded-lg px-6 py-5 text-sm text-zinc-800 dark:text-zinc-300 leading-relaxed">
            <Markdown content={skillData.content || ""} />
          </div>
        </div>
      )}

      {/* Edit mode */}
      {editing && (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="flex-1 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg px-4 py-3 text-base md:text-sm text-zinc-800 dark:text-zinc-300 font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-600 overflow-y-auto"
          spellCheck={false}
        />
      )}
    </div>
    </div>
  );
}

function reconstructSkillMarkdown(skill: any): string {
  const meta: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  };
  if (skill.tags?.length) meta.tags = skill.tags;

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

  return `---\n${lines.join("\n")}\n---\n\n${skill.content}`;
}
