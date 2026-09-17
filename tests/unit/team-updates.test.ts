import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const installation = vi.hoisted(() => ({ root: "" }));
vi.mock("../../src/files/layout.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/files/layout.js")>(),
  get installationRoot() { return installation.root; },
}));

function makeTmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "bossmode-team-updates-"));
}

function write(p: string, content: string): void {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content, "utf-8");
}

function seedTemplateProject(root: string, version = "9.9.9"): void {
  mkdirSync(join(root, "templates", "agents"), { recursive: true });
  mkdirSync(join(root, "templates", "skills", "skill-a"), { recursive: true });
  mkdirSync(join(root, "templates", "teams"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version }, null, 2));

  writeFileSync(join(root, "templates", "agents", "pm.md"), "---\nname: pm\ndescription: PM\n---\n\n# prompt\n", "utf-8");
  writeFileSync(join(root, "templates", "agents", "general.md"), "---\nname: general\ndescription: General\n---\n\n# old general prompt\n", "utf-8");
  writeFileSync(join(root, "templates", "skills", "skill-a", "SKILL.md"), "---\nname: skill-a\ndescription: A\n---\n\nskill\n", "utf-8");
  writeFileSync(join(root, "templates", "teams", "universal-principles.md"), "# UAP\n\nbody\n", "utf-8");
}

describe("team-updates service (fresh-install seed only — update-check/apply removed)", () => {
  let cwdBefore = "";
  let bossmodeDir = "";
  let projectDir = "";

  beforeEach(async () => {
    cwdBefore = process.cwd();
    projectDir = makeTmpRoot();
    bossmodeDir = process.env.BOSSMODE_DIR!;
    if (!process.env.BOSSMODE_TEST_ROOT || !bossmodeDir.startsWith(process.env.BOSSMODE_TEST_ROOT + "/")) throw new Error("Use isolated test launcher");
    installation.root = projectDir;
    seedTemplateProject(projectDir, "1.2.3");
    process.chdir(projectDir);
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(cwdBefore);
    rmSync(bossmodeDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  async function mod() {
    return import("../../src/member/templates.js");
  }

  it("seedBuiltinAssets seeds missing files without any meta file", async () => {
    const m = await mod();
    m.seedBuiltinAssets();
    expect(existsSync(join(bossmodeDir, "agents"))).toBe(false);
    expect(existsSync(join(bossmodeDir, "skills", "skill-a", "SKILL.md"))).toBe(true);
    expect(existsSync(join(bossmodeDir, "memory", "projects", "rules", "member-universal-principles.md"))).toBe(true);
    // No update-tracking file is written — seeding is meta-free.
    expect(existsSync(join(bossmodeDir, "team-meta.json"))).toBe(false);
  });

  it("seedBuiltinAssets syncs whole skill directories including raw reference files", async () => {
    write(join(projectDir, "templates", "skills", "skill-a", "NOTICE.md"), "notice\n");
    write(join(projectDir, "templates", "skills", "skill-a", "reference", "guide.md"), "# Guide\n");
    const m = await mod();
    m.seedBuiltinAssets();

    expect(readFileSync(join(bossmodeDir, "skills", "skill-a", "SKILL.md"), "utf-8")).toContain("source: builtin");
    expect(readFileSync(join(bossmodeDir, "skills", "skill-a", "NOTICE.md"), "utf-8")).toBe("notice\n");
    expect(readFileSync(join(bossmodeDir, "skills", "skill-a", "reference", "guide.md"), "utf-8")).toBe("# Guide\n");
  });

  it("uses installation templates/version rather than cwd or a later data-root environment change", async () => {
    const m = await mod();
    const other = makeTmpRoot();
    const previous = process.env.BOSSMODE_DIR;
    try {
      seedTemplateProject(other, "99.99.99");
      write(join(other, "templates", "skills", "cwd-only", "SKILL.md"), "cwd must not become an installed skill");
      process.chdir(other);
      process.env.BOSSMODE_DIR = join(other, "wrong-data");
      m.seedBuiltinAssets();
      expect(readFileSync(join(bossmodeDir, "skills", "skill-a", "SKILL.md"), "utf8")).toContain("version: 1.2.3");
      expect(existsSync(join(bossmodeDir, "skills", "cwd-only"))).toBe(false);
      expect(existsSync(join(other, "wrong-data"))).toBe(false);
    } finally { process.env.BOSSMODE_DIR = previous; process.chdir(projectDir); rmSync(other, { recursive: true, force: true }); }
  });

  it("copies non-Markdown skill assets byte-for-byte", async () => {
    const bytes = Buffer.from([0, 255, 254, 13, 10, 128, 1]);
    writeFileSync(join(projectDir, "templates", "skills", "skill-a", "binary.dat"), bytes);
    (await mod()).seedBuiltinAssets();
    expect(readFileSync(join(bossmodeDir, "skills", "skill-a", "binary.dat"))).toEqual(bytes);
  });

  it("seedBuiltinAssets is idempotent for existing files", async () => {
    const m = await mod();
    m.seedBuiltinAssets();
    const paths = ["skills/skill-a/SKILL.md", "memory/projects/rules/member-universal-principles.md"];
    const first = paths.map(path => readFileSync(join(bossmodeDir, path)));
    m.seedBuiltinAssets();
    const second = paths.map(path => readFileSync(join(bossmodeDir, path)));
    expect(second).toEqual(first);
  });

  it("seedBuiltinAssets seeds only missing files — never overwrites local content, even after a template change", async () => {
    const m = await mod();
    m.seedBuiltinAssets();
    const skillPath = join(bossmodeDir, "skills", "skill-a", "SKILL.md");
    writeFileSync(skillPath, "custom", "utf-8");
    // Bump the packaged template — with no update-check path anymore, a
    // re-seed must still leave the local (already-present) file untouched.
    writeFileSync(join(projectDir, "templates", "skills", "skill-a", "SKILL.md"), "---\nname: skill-a\ndescription: A v2\n---\n\nskill v2\n", "utf-8");
    m.seedBuiltinAssets();
    expect(readFileSync(skillPath, "utf-8")).toBe("custom");
  });

  it("applyUpdates/checkForUpdates/dismiss* are removed (Built-in Updates feature retired)", async () => {
    const m = await mod();
    expect((m as any).checkForUpdates).toBeUndefined();
    expect((m as any).applyUpdates).toBeUndefined();
    expect((m as any).dismissVersion).toBeUndefined();
    expect((m as any).dismissPermanently).toBeUndefined();
    expect((m as any).getUpdateSettings).toBeUndefined();
    expect((m as any).resetDismiss).toBeUndefined();
    expect((m as any).seedBuiltinTeam).toBeUndefined();
  });

  it("seedBuiltinAssets removes locally-installed builtin skills whose template was dropped, preserving custom skills", async () => {
    const m = await mod();
    m.seedBuiltinAssets();
    write(join(bossmodeDir, "skills", "old-built-in", "SKILL.md"), "---\nname: old-built-in\nsource: builtin\n---\n\nold\n");
    write(join(bossmodeDir, "skills", "custom-skill", "SKILL.md"), "---\nname: custom-skill\n---\n\ncustom\n");

    m.seedBuiltinAssets();

    expect(existsSync(join(bossmodeDir, "skills", "old-built-in"))).toBe(false);
    expect(existsSync(join(bossmodeDir, "skills", "custom-skill", "SKILL.md"))).toBe(true);
  });
});
