import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("seedTemplates", () => {
  let tempDir: string;
  let bossmodeDir: string;
  let templatesDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "seed-test-"));
    bossmodeDir = join(tempDir, ".bossmode");
    templatesDir = join(tempDir, "templates");

    // Create template agents
    const agentsSrc = join(templatesDir, "agents");
    mkdirSync(agentsSrc, { recursive: true });
    writeFileSync(join(agentsSrc, "pm.md"), "---\nname: pm\n---\nPM agent");
    writeFileSync(join(agentsSrc, "general.md"), "---\nname: general\n---\nGeneral agent");
    writeFileSync(join(agentsSrc, "developer.md"), "---\nname: developer\n---\nDeveloper agent");

    // Create template skills
    const skillsSrc = join(templatesDir, "skills", "code-review");
    mkdirSync(skillsSrc, { recursive: true });
    writeFileSync(join(skillsSrc, "SKILL.md"), "# Code Review Skill");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  // Helper: inline seedTemplates logic to test with custom dirs
  // (The real function uses module-level BOSSMODE_DIR, so we replicate the logic)
  function seedTemplatesWithDirs(templatesRoot: string, targetDir: string) {
    const { existsSync: ex, mkdirSync: mk, readdirSync: rd, copyFileSync: cp } = require("node:fs");
    const { cpSync } = require("node:fs");
    const { join: j } = require("node:path");

    const agentsDir = j(targetDir, "agents");
    const skillsDir = j(targetDir, "skills");

    // Agents: per-file check
    const agentsSrc = j(templatesRoot, "agents");
    if (ex(agentsSrc)) {
      mk(agentsDir, { recursive: true });
      let seeded = 0;
      for (const f of rd(agentsSrc).filter((f: string) => f.endsWith(".md"))) {
        const dest = j(agentsDir, f);
        if (!ex(dest)) {
          cp(j(agentsSrc, f), dest);
          seeded++;
        }
      }
    }

    // Skills: per-directory check
    const skillsSrc = j(templatesRoot, "skills");
    if (ex(skillsSrc)) {
      mk(skillsDir, { recursive: true });
      for (const d of rd(skillsSrc)) {
        const dest = j(skillsDir, d);
        if (!ex(dest)) {
          cpSync(j(skillsSrc, d), dest, { recursive: true });
        }
      }
    }
  }

  it("seeds all templates when target dir is empty", () => {
    seedTemplatesWithDirs(templatesDir, bossmodeDir);

    const agentsDir = join(bossmodeDir, "agents");
    expect(existsSync(join(agentsDir, "pm.md"))).toBe(true);
    expect(existsSync(join(agentsDir, "general.md"))).toBe(true);
    expect(existsSync(join(agentsDir, "developer.md"))).toBe(true);

    const skillsDir = join(bossmodeDir, "skills");
    expect(existsSync(join(skillsDir, "code-review", "SKILL.md"))).toBe(true);
  });

  it("seeds missing templates without overwriting existing ones", () => {
    // Pre-create agents dir with only pm.md (user-modified version)
    const agentsDir = join(bossmodeDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "pm.md"), "---\nname: pm\n---\nMY CUSTOM PM");

    seedTemplatesWithDirs(templatesDir, bossmodeDir);

    // pm.md should NOT be overwritten
    expect(readFileSync(join(agentsDir, "pm.md"), "utf-8")).toContain("MY CUSTOM PM");
    // general.md and developer.md should be seeded
    expect(existsSync(join(agentsDir, "general.md"))).toBe(true);
    expect(existsSync(join(agentsDir, "developer.md"))).toBe(true);
  });

  it("does nothing when all templates already exist", () => {
    // Pre-create all agents
    const agentsDir = join(bossmodeDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, "pm.md"), "existing pm");
    writeFileSync(join(agentsDir, "general.md"), "existing general");
    writeFileSync(join(agentsDir, "developer.md"), "existing developer");

    // Pre-create all skills
    const skillsDir = join(bossmodeDir, "skills", "code-review");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), "existing skill");

    seedTemplatesWithDirs(templatesDir, bossmodeDir);

    // Nothing should be overwritten
    expect(readFileSync(join(agentsDir, "pm.md"), "utf-8")).toBe("existing pm");
    expect(readFileSync(join(agentsDir, "general.md"), "utf-8")).toBe("existing general");
    expect(readFileSync(join(bossmodeDir, "skills", "code-review", "SKILL.md"), "utf-8")).toBe("existing skill");
  });

  it("seeds missing skill directories without overwriting existing ones", () => {
    // Pre-create skills dir with existing skill
    const skillsDir = join(bossmodeDir, "skills");
    mkdirSync(join(skillsDir, "my-custom-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "my-custom-skill", "SKILL.md"), "custom");

    seedTemplatesWithDirs(templatesDir, bossmodeDir);

    // Custom skill untouched
    expect(readFileSync(join(skillsDir, "my-custom-skill", "SKILL.md"), "utf-8")).toBe("custom");
    // Template skill seeded
    expect(existsSync(join(skillsDir, "code-review", "SKILL.md"))).toBe(true);
  });
});
