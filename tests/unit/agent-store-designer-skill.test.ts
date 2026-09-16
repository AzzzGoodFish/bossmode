import { afterEach, describe, it, expect } from "vitest";
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadSkillTemplates, loadSkillDefinitionsStrict, getSkillsDir } from "../../src/member/skills/skill-store.js";
import { seedBuiltinAssets } from "../../src/member/assets/team-updates.js";
import { buildSkillCatalog, listMemberSkills } from "../../src/member/skills/skill-catalog.js";
import { memberSkillsDir } from "../../src/files/layout.js";

const memberId = "impeccable-skill-fixture";
afterEach(() => { rmSync(memberSkillsDir(memberId), { recursive: true, force: true }); });

describe("independent Impeccable skill template and catalog", () => {
  it("ships Impeccable with its description, instructions, notice and reference files", () => {
    const skill = loadSkillTemplates().find(skill => skill.name === "impeccable");
    expect(skill).toBeTruthy();
    expect(skill!.description.length).toBeGreaterThan(0);
    expect(skill!.content).toContain("DESIGN.md");
    const packaged = join(import.meta.dirname, "../../templates/skills/impeccable");
    expect(readFileSync(join(packaged, "NOTICE.md"), "utf8")).toContain("Paul Bakaus");
    expect(existsSync(join(packaged, "reference/typography.md"))).toBe(true);
  });

  it("seeds the complete skill and lists an explicitly installed member skill without agent factories", () => {
    seedBuiltinAssets();
    const skill = loadSkillDefinitionsStrict().find(skill => skill.name === "impeccable");
    expect(skill).toBeTruthy();
    const installed = join(getSkillsDir(), "impeccable");
    const packaged = join(import.meta.dirname, "../../templates/skills/impeccable");
    for (const path of ["NOTICE.md", "reference/typography.md"]) {
      expect(readFileSync(join(installed, path))).toEqual(readFileSync(join(packaged, path)));
    }
    cpSync(installed, join(memberSkillsDir(memberId), "impeccable"), { recursive: true });
    expect(listMemberSkills(memberId)).toEqual(expect.arrayContaining([expect.objectContaining({ name: "impeccable", platform: false })]));
    const catalog = buildSkillCatalog(memberId, 100_000);
    expect(catalog.entries).toEqual(expect.arrayContaining([expect.objectContaining({ relPath: "impeccable/SKILL.md", absPath: join(memberSkillsDir(memberId), "impeccable/SKILL.md") })]));
    expect(catalog.lines.some(line => line.includes("impeccable/SKILL.md"))).toBe(true);
  });
});
