import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let tmpDir = "";



beforeEach(() => {
  tmpDir = process.env.BOSSMODE_DIR!;
  mkdirSync(tmpDir, {recursive:true});
});
afterEach(() => {
  vi.resetModules();
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeSkill(name: string, content: string) {
  const dir = join(tmpDir, "members", "m1", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content, "utf-8");
}

describe("skill-catalog budget ladder + platform guide", () => {
  it("always includes platform bossmode-guide even with empty member skills", async () => {
    const { buildSkillCatalog, platformSkillsDir } = await import("../../src/member/skills/skill-catalog.js");
    expect(existsSync(join(platformSkillsDir(), "bossmode-guide", "SKILL.md"))).toBe(true);
    const r = buildSkillCatalog("m1", 100_000);
    expect(r.mode).not.toBe("absent");
    expect(r.entries.some((e) => e.platform && e.relPath.includes("bossmode-guide"))).toBe(true);
    expect(r.lines.some((l) => l.includes("bossmode-guide") && l.includes("[platform]"))).toBe(true);
  });

  it("under_budget with full descriptions from frontmatter + platform", async () => {
    writeSkill("alpha", "---\ndescription: Does alpha things well\n---\n\n# Alpha\n");
    writeSkill("beta", "---\ndescription: Beta helper\n---\n\n# Beta\n");
    const { buildSkillCatalog } = await import("../../src/member/skills/skill-catalog.js");
    const r = buildSkillCatalog("m1", 200_000);
    expect(r.mode).toBe("under_budget");
    expect(r.lines.some((l) => l.includes("alpha/SKILL.md") && l.includes("Does alpha"))).toBe(true);
    expect(r.lines.some((l) => l.includes("beta/SKILL.md"))).toBe(true);
    expect(r.entries.some((e) => e.platform)).toBe(true);
  });

  it("falls back to first body line when frontmatter missing", async () => {
    writeSkill("gamma", "# Gamma skill\n\nBody here.\n");
    const { buildSkillCatalog } = await import("../../src/member/skills/skill-catalog.js");
    const r = buildSkillCatalog("m1", 200_000);
    const gamma = r.entries.find((e) => e.relPath.includes("gamma"));
    expect(gamma?.description).toContain("Gamma skill");
  });

  it("shortened_descriptions when full exceeds budget", async () => {
    writeSkill("s1", `---\ndescription: ${"A".repeat(100)}\n---\n\n`);
    writeSkill("s2", `---\ndescription: ${"B".repeat(100)}\n---\n\n`);
    writeSkill("s3", `---\ndescription: ${"C".repeat(100)}\n---\n\n`);
    const { buildSkillCatalog } = await import("../../src/member/skills/skill-catalog.js");
    const r = buildSkillCatalog("m1", 200);
    expect(["shortened_descriptions", "dropped_descriptions", "omitted_skills"]).toContain(r.mode);
    expect(r.lines.length).toBeGreaterThan(0);
  });

  it("omitted_skills keeps bossmode-guide protected + first members", async () => {
    for (let i = 0; i < 6; i++) {
      writeSkill(`skill${i}`, `---\ndescription: d${i}\n---\n\n`);
    }
    const { buildSkillCatalog } = await import("../../src/member/skills/skill-catalog.js");
    const r = buildSkillCatalog("m1", 40);
    expect(r.mode).toBe("omitted_skills");
    expect(r.lines.some((l) => l.includes("bossmode-guide"))).toBe(true);
    expect(r.lines.some((l) => l.includes("more under") || l.includes("skill"))).toBe(true);
  });

  it("listMemberSkills includes platform flag", async () => {
    writeSkill("local", "---\ndescription: Local only\n---\n");
    const { listMemberSkills } = await import("../../src/member/skills/skill-catalog.js");
    const list = listMemberSkills("m1");
    expect(list.some((s) => s.platform && s.name === "bossmode-guide")).toBe(true);
    expect(list.some((s) => !s.platform && s.name === "local")).toBe(true);
  });
});
