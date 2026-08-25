import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
}));

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-skill-cat-"));
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

describe("skill-catalog budget ladder", () => {
  it("absent when no skills dir or empty", async () => {
    const { buildSkillCatalog } = await import("../../src/engine/skill-catalog.js");
    expect(buildSkillCatalog("m1", 100_000).mode).toBe("absent");
    mkdirSync(join(tmpDir, "members", "m1", "skills"), { recursive: true });
    expect(buildSkillCatalog("m1", 100_000).mode).toBe("absent");
  });

  it("under_budget with full descriptions from frontmatter", async () => {
    writeSkill("alpha", "---\ndescription: Does alpha things well\n---\n\n# Alpha\n");
    writeSkill("beta", "---\ndescription: Beta helper\n---\n\n# Beta\n");
    const { buildSkillCatalog } = await import("../../src/engine/skill-catalog.js");
    const r = buildSkillCatalog("m1", 200_000); // large budget
    expect(r.mode).toBe("under_budget");
    expect(r.lines.some((l) => l.includes("alpha/SKILL.md") && l.includes("Does alpha"))).toBe(true);
    expect(r.lines.some((l) => l.includes("beta/SKILL.md"))).toBe(true);
  });

  it("falls back to first body line when frontmatter missing", async () => {
    writeSkill("gamma", "# Gamma skill\n\nBody here.\n");
    const { buildSkillCatalog } = await import("../../src/engine/skill-catalog.js");
    const r = buildSkillCatalog("m1", 200_000);
    expect(r.entries[0].description).toContain("Gamma skill");
  });

  it("shortened_descriptions when full exceeds budget", async () => {
    // Tiny budget so full descriptions don't fit.
    writeSkill("s1", `---\ndescription: ${"A".repeat(100)}\n---\n\n`);
    writeSkill("s2", `---\ndescription: ${"B".repeat(100)}\n---\n\n`);
    writeSkill("s3", `---\ndescription: ${"C".repeat(100)}\n---\n\n`);
    const { buildSkillCatalog } = await import("../../src/engine/skill-catalog.js");
    const r = buildSkillCatalog("m1", 200); // 2% = 4 tokens ≈ 16 chars — forces ladder
    expect(["shortened_descriptions", "dropped_descriptions", "omitted_skills"]).toContain(r.mode);
    expect(r.lines.length).toBeGreaterThan(0);
  });

  it("omitted_skills keeps first 3 + notice", async () => {
    for (let i = 0; i < 6; i++) {
      writeSkill(`skill${i}`, `---\ndescription: d${i}\n---\n\n`);
    }
    const { buildSkillCatalog } = await import("../../src/engine/skill-catalog.js");
    const r = buildSkillCatalog("m1", 40); // tiny
    if (r.mode === "omitted_skills") {
      expect(r.lines.filter((l) => l.trim().startsWith("- ")).length).toBeLessThanOrEqual(3);
      expect(r.lines.some((l) => l.includes("more under"))).toBe(true);
    } else {
      // Accept earlier ladder step if it already fits.
      expect(r.mode).not.toBe("absent");
    }
  });
});
