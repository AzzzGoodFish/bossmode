import { useState, useEffect } from "react";
import { Puzzle, Search } from "lucide-react";
import type { SkillInfo } from "../api/client";
import { getSkills } from "../api/client";
import { matchesWorkspaceResourceSearch } from "./resource-list-filter";

interface SkillsPageProps {
  onSelectSkill: (name: string) => void;
}

export function SkillsPage({ onSelectSkill }: SkillsPageProps) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [search, setSearch] = useState("");

  useEffect(() => {
    getSkills().then(setSkills).catch(console.error);
  }, []);

  const filtered = skills.filter((s) => matchesWorkspaceResourceSearch(s, search));

  return (
    <div className="flex-1 flex flex-col overflow-y-auto bg-surface-1">
      <div className="w-full px-6 md:px-10 pt-7 pb-16">
        <div className="mb-6">
          <h1 className="text-[17px] font-semibold tracking-tight text-ink-1">Skills</h1>
          <p className="text-xs text-ink-4 mt-0.5">{skills.length} skills configured</p>
        </div>

        <div className="relative mb-5 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search skills…"
            className="w-full bg-surface-0 border border-line rounded-lg pl-9 pr-3 py-2 text-[12.5px] text-ink-1 focus:outline-none focus:border-line-strong transition-colors placeholder:text-ink-4"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5">
          {filtered.map((skill) => (
            <button
              key={skill.name}
              onClick={() => onSelectSkill(skill.name)}
              className="text-left bg-surface-0 border border-line rounded-lg p-4 hover:border-line-strong transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2 mb-2">
                <Puzzle size={14} className="text-ink-3" />
                <span className="font-semibold text-ink-1 text-[13px]">{skill.name}</span>
              </div>
              <p className="text-xs text-ink-3 mb-2 line-clamp-2 leading-relaxed">{skill.description || "No description"}</p>
              <div className="flex flex-wrap gap-1">
                {(skill.tags ?? []).map((tag) => (
                  <span key={tag} className="text-[10px] bg-surface-2 text-ink-3 px-1.5 py-0.5 rounded">{tag}</span>
                ))}
              </div>
            </button>
          ))}
          {filtered.length === 0 && (
            <p className="text-xs text-ink-4 col-span-full py-6 text-center">No matching skills.</p>
          )}
        </div>
      </div>
    </div>
  );
}
