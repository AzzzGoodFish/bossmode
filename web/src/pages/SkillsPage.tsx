import { useState, useEffect } from "react";
import { Puzzle, Search } from "lucide-react";
import type { SkillInfo } from "../api/client";
import { getSkills } from "../api/client";
import { ResourceListContainer, ResourceListPage, ResourceRow } from "../components/ResourceList";
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
    <ResourceListPage
      title="Skills"
      subtitle={`Reusable capability packs from disk — members opt in per scope. ${skills.length} skills configured.`}
      search={
        <div className="relative mb-5 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-4" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search skills…"
            className="w-full bg-inset border border-line rounded-lg pl-9 pr-3 py-2 text-[12.5px] text-ink-1 focus:outline-none focus:border-line-strong transition-colors placeholder:text-ink-4"
          />
        </div>
      }
    >
      <ResourceListContainer>
        {filtered.map((skill) => (
          <ResourceRow
            key={skill.name}
            icon={<Puzzle size={15} />}
            name={skill.name}
            badges={(skill.tags ?? []).map((tag) => (
              <span key={tag} className="text-[10px] bg-surface-2 text-ink-3 px-1.5 py-0.5 rounded">{tag}</span>
            ))}
            description={skill.description || "No description"}
            onClick={() => onSelectSkill(skill.name)}
          />
        ))}
        {filtered.length === 0 && (
          <p className="text-xs text-ink-4 py-6 text-center">No matching skills.</p>
        )}
      </ResourceListContainer>
    </ResourceListPage>
  );
}
