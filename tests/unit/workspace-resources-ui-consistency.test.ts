import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("workspace resources UI consistency (Teams / Agents / Skills)", () => {
  it("removes All teams / All agents rows and section create + for team domain", () => {
    const sidebar = source("web/src/components/Sidebar.tsx");
    expect(sidebar).not.toContain("All teams");
    expect(sidebar).not.toContain("All agents");
    // Section labels open galleries
    expect(sidebar).toContain("onLabelClick={() => onNavigate({ type: \"team\", name: null })}");
    expect(sidebar).toContain("onLabelClick={() => onNavigate({ type: \"agent\", name: null })}");
    expect(sidebar).toContain("onLabelClick={() => onNavigate({ type: \"skill\", name: null })}");
    // No create + on teams/agents/skills section heads (label + onLabelClick only)
    expect(sidebar).not.toContain('onCreate={() => onNavigate({ type: "team"');
    expect(sidebar).not.toContain('onCreate={() => onNavigate({ type: "agent"');
    expect(sidebar).not.toContain('onCreate={() => onNavigate({ type: "skill"');
  });

  it("uses FileDown for team import (arrow down, not Upload)", () => {
    const teams = source("web/src/pages/TeamsPage.tsx");
    expect(teams).toContain("FileDown");
    expect(teams).not.toMatch(/import \{[^}]*Upload[^}]*\} from "lucide-react"/);
    expect(teams).not.toContain("<Upload");
  });

  it("uses shared BackLink and full-width Agents shells", () => {
    const back = source("web/src/components/BackLink.tsx");
    expect(back).toContain("ArrowLeft");
    expect(back).toContain("size={18}");

    for (const path of [
      "web/src/pages/TeamDetailPage.tsx",
      "web/src/pages/AgentDetailPage.tsx",
      "web/src/pages/SkillDetailPage.tsx",
      "web/src/pages/AgentProfilePage.tsx",
    ]) {
      const src = source(path);
      expect(src).toContain("BackLink");
      expect(src).not.toMatch(/<ArrowLeft\b/);
      expect(src).not.toMatch(/BackLink[^>]*className=/);
    }

    const agentsPage = source("web/src/pages/AgentsPage.tsx");
    expect(agentsPage).not.toContain("max-w-[880px]");
    expect(agentsPage).not.toContain("New Agent");
    expect(agentsPage).not.toContain("New Skill");

    const agentDetail = source("web/src/pages/AgentDetailPage.tsx");
    expect(agentDetail).not.toContain("max-w-[880px]");

    const profile = source("web/src/pages/AgentProfilePage.tsx");
    expect(profile).not.toContain("max-w-[880px]");

    const skills = source("web/src/pages/SkillsPage.tsx");
    expect(skills).not.toContain("New Skill");
  });
});
