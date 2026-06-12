import { useState, useEffect } from "react";
import { Puzzle, Plus, Search } from "lucide-react";
import type { SkillInfo } from "../api/client";
import { getSkills, createSkill } from "../api/client";
import { useDialog } from "../components/dialogs";
import { matchesWorkspaceResourceSearch } from "./resource-list-filter";

interface SkillsPageProps {
  onSelectSkill: (name: string) => void;
}

export function SkillsPage({ onSelectSkill }: SkillsPageProps) {
  const { toast } = useDialog();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    getSkills().then(setSkills).catch(console.error);
  }, []);

  const filtered = skills.filter((s) => matchesWorkspaceResourceSearch(s, search));

  const handleCreate = async (name: string, content: string) => {
    try {
      await createSkill(name, content);
      setShowCreate(false);
      getSkills().then(setSkills);
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  return (
    <div className="flex-1 flex flex-col p-6 overflow-y-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-bold text-ink-1">Skills</h1>
          <p className="text-sm text-ink-3 mt-0.5">{skills.length} skills configured</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-accent text-accent-contrast hover:opacity-90 text-sm font-medium rounded-lg transition-colors cursor-pointer"
        >
          <Plus size={14} /> New Skill
        </button>
      </div>

      <div className="relative mb-4">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search skills..."
          className="w-full bg-surface-1 border border-line-soft rounded-lg pl-9 pr-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors placeholder:text-ink-4"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((skill) => (
          <button
            key={skill.name}
            onClick={() => onSelectSkill(skill.name)}
            className="text-left bg-surface-1 border border-line-soft rounded-lg p-4 hover:border-line-strong transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 mb-2">
              <Puzzle size={14} className="text-ink-3" />
              <span className="font-semibold text-ink-1 text-sm">{skill.name}</span>
            </div>
            <p className="text-xs text-ink-4 mb-2 line-clamp-2">{skill.description || "No description"}</p>
            <div className="flex flex-wrap gap-1">
              {(skill.tags ?? []).map((tag) => (
                <span key={tag} className="text-[10px] bg-surface-2 text-ink-3 px-1.5 py-0.5 rounded">{tag}</span>
              ))}
            </div>
          </button>
        ))}
      </div>

      {showCreate && <CreateSkillDialog onClose={() => setShowCreate(false)} onCreate={handleCreate} />}
    </div>
  );
}

function CreateSkillDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, content: string) => void }) {
  const [name, setName] = useState("");
  const [content, setContent] = useState(`---
name: ""
description: ""
tags: []
---

# Skill Name

## When to Use
...

## Process
...

## Output Format
...
`);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-surface-1 border border-line-soft rounded-lg p-5 w-full max-w-3xl">
        <h2 className="text-sm font-semibold text-ink-1 mb-4">Create Skill</h2>
        <div className="mb-3">
          <label className="block text-xs text-ink-4 mb-1">Name (directory name)</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-surface-2 border border-line rounded px-3 py-2 text-sm text-ink-1 focus:outline-none focus:border-line-strong transition-colors"
            placeholder="my-skill"
            autoFocus
          />
        </div>
        <div className="mb-4">
          <label className="block text-xs text-ink-4 mb-1">Markdown Content</label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={20}
            className="w-full bg-surface-2 border border-line rounded px-3 py-2 text-sm text-ink-1 font-mono focus:outline-none focus:border-line-strong transition-colors resize-none"
          />
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm text-ink-4 hover:text-ink-1 cursor-pointer">Cancel</button>
          <button
            onClick={() => name && content && onCreate(name, content)}
            disabled={!name || !content}
            className="px-4 py-2 bg-accent text-accent-contrast hover:opacity-90 disabled:opacity-40 text-sm font-medium rounded-lg cursor-pointer"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
