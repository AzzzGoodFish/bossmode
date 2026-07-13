import { useState, useEffect } from "react";
import { ArrowLeft, Save, Trash2, Pencil, X } from "lucide-react";
import { MobileTopBar } from "../components/MobileTopBar";
import { getSkill, updateSkill, deleteSkill, createSkill } from "../api/client";
import { Markdown } from "../components/Markdown";
import { useDialog } from "../components/dialogs";
import { userActionError } from "../utils/user-error";

interface SkillDetailPageProps {
  name: string;
  onBack: () => void;
  isCreate?: boolean;
  onCreated?: (name: string) => void;
  onOpenMobileSidebar?: () => void;
}

const editBtnCls = "px-3 py-1.5 text-sm border border-line rounded text-ink-2 hover:text-ink-1 hover:border-line-strong cursor-pointer transition-colors";

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
      .catch((err) => { console.error("Failed to load Skill", err); toast(userActionError("load this Skill"), "error"); })
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
    } catch (err) {
      console.error("Failed to save Skill", err);
      toast(userActionError("save this Skill", "Check the required fields, then try again."), "error");
      setSaveState("error");
      setTimeout(() => setSaveState("idle"), 3000);
    }
  };

  const handleDelete = async () => {
    if (!(await confirm(`Delete skill "${name}"? This cannot be undone.`))) return;
    try { await deleteSkill(name); onBack(); }
    catch (err) { console.error("Failed to delete Skill", err); toast(userActionError("delete this Skill"), "error"); }
  };

  const handleCancel = () => {
    setContent(originalContent);
    setEditing(false);
  };

  if (loading) return <div className="flex-1 flex items-center justify-center text-ink-3">Loading...</div>;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <MobileTopBar title={isCreate ? "New Skill" : name} onOpenSidebar={onOpenMobileSidebar || (() => {})} />
      <div className="flex-1 flex flex-col p-6 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="text-ink-4 hover:text-ink-1 transition-colors cursor-pointer">
            <ArrowLeft size={18} />
          </button>
          {isCreate ? (
            <input value={skillName} onChange={(e) => setSkillName(e.target.value)} placeholder="skill-name"
              className="text-lg font-bold text-ink-1 bg-transparent border-b border-line focus:border-accent outline-none px-1" />
          ) : (
            <>
              <h1 className="text-lg font-bold text-ink-1">{name}</h1>
              <span className="text-xs text-ink-4">Skill · {name}/SKILL.md</span>
            </>
          )}
          {editing && !isCreate && <span className="text-xs text-think font-medium">Editing</span>}
        </div>
        <div className="flex items-center gap-2">
          {!isCreate && !editing && (
            <>
              <button onClick={() => setEditing(true)} className={`flex items-center gap-1 ${editBtnCls}`}>
                <Pencil size={14} /> Edit
              </button>
              <button onClick={handleDelete}
                className="flex items-center gap-1 px-3 py-1.5 text-blocked hover:opacity-80 text-sm cursor-pointer">
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
                  saveState === "saved" ? "bg-onair" : saveState === "error" ? "bg-blocked" : "bg-accent hover:opacity-90 disabled:opacity-40"
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
                <span key={t} className="text-xs px-2 py-0.5 bg-surface-2 text-ink-2 rounded">{t}</span>
              ))}
            </div>
          )}
          <div className="bg-surface-1 border border-line rounded-lg px-6 py-5 text-sm text-ink-2 leading-relaxed">
            <Markdown content={skillData.content || ""} />
          </div>
        </div>
      )}

      {/* Edit mode */}
      {editing && (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="flex-1 bg-inset border border-line rounded-lg px-4 py-3 text-base md:text-sm text-ink-2 font-mono resize-none focus:outline-none focus:border-line-strong transition-colors overflow-y-auto"
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
