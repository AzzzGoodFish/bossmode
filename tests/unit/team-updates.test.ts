import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  writeFileSync(join(root, "templates", "skills", "skill-a", "SKILL.md"), "---\nname: skill-a\ndescription: A\n---\n\nskill\n", "utf-8");
  writeFileSync(join(root, "templates", "teams", "universal-agent-principles.md"), "# UAP\n\nbody\n", "utf-8");
}

describe("team-updates service", () => {
  let cwdBefore = "";
  let bossmodeDir = "";
  let projectDir = "";

  beforeEach(() => {
    cwdBefore = process.cwd();
    projectDir = makeTmpRoot();
    bossmodeDir = join(projectDir, ".bossmode-home");
    process.env.BOSSMODE_DIR = bossmodeDir;
    seedTemplateProject(projectDir, "1.2.3");
    process.chdir(projectDir);
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(cwdBefore);
    delete process.env.BOSSMODE_DIR;
  });

  async function mod() {
    return import("../../src/workforce/team-updates.js");
  }

  it("contentHash returns stable 16-char hex", async () => {
    const m = await mod();
    const h1 = m.contentHash("abc");
    const h2 = m.contentHash("abc");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[a-f0-9]{16}$/);
  });

  it("seedBuiltinTeam seeds missing files and writes meta", async () => {
    const m = await mod();
    m.seedBuiltinTeam();
    expect(existsSync(join(bossmodeDir, "agents", "pm.md"))).toBe(true);
    expect(existsSync(join(bossmodeDir, "skills", "skill-a", "SKILL.md"))).toBe(true);
    expect(existsSync(join(bossmodeDir, "knowledge", "docs", "rules", "universal-agent-principles.md"))).toBe(true);
    expect(existsSync(join(bossmodeDir, "team-meta.json"))).toBe(true);
  });

  it("seedBuiltinTeam is idempotent for existing files", async () => {
    const m = await mod();
    m.seedBuiltinTeam();
    const first = readFileSync(join(bossmodeDir, "agents", "pm.md"), "utf-8");
    m.seedBuiltinTeam();
    const second = readFileSync(join(bossmodeDir, "agents", "pm.md"), "utf-8");
    expect(second).toBe(first);
  });

  it("seedBuiltinTeam seeds only missing files", async () => {
    const m = await mod();
    m.seedBuiltinTeam();
    const skillPath = join(bossmodeDir, "skills", "skill-a", "SKILL.md");
    writeFileSync(skillPath, "custom", "utf-8");
    m.seedBuiltinTeam();
    expect(readFileSync(skillPath, "utf-8")).toBe("custom");
  });

  it("checkForUpdates returns no updates when versions equal", async () => {
    const m = await mod();
    m.seedBuiltinTeam();
    const result = m.checkForUpdates();
    expect(result.hasUpdates).toBe(false);
    expect(result.candidates.length).toBe(0);
  });

  it("checkForUpdates detects template update by version", async () => {
    const m = await mod();
    m.seedBuiltinTeam();
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ version: "1.2.4" }));
    const result = m.checkForUpdates();
    expect(result.hasUpdates).toBe(true);
    expect(result.candidates.some((c) => c.status === "updated")).toBe(true);
  });

  it("checkForUpdates marks modified files as modified", async () => {
    const m = await mod();
    m.seedBuiltinTeam();
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ version: "1.2.4" }));
    const pmPath = join(bossmodeDir, "agents", "pm.md");
    const current = readFileSync(pmPath, "utf-8");
    writeFileSync(pmPath, `${current}\n# user edit\n`, "utf-8");
    const result = m.checkForUpdates();
    expect(result.candidates.find((c) => c.relativePath === "agents/pm.md")?.status).toBe("modified");
  });

  it("checkForUpdates detects new template files", async () => {
    const m = await mod();
    m.seedBuiltinTeam();
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ version: "1.2.4" }));
    writeFileSync(join(projectDir, "templates", "agents", "new-agent.md"), "---\nname: new-agent\n---\n\nbody\n");
    const result = m.checkForUpdates();
    expect(result.candidates.some((c) => c.relativePath === "agents/new-agent.md" && c.status === "new")).toBe(true);
  });

  it("checkForUpdates respects dismissedVersion", async () => {
    const m = await mod();
    m.seedBuiltinTeam();
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ version: "1.2.4" }));
    m.dismissVersion("1.2.4");
    const result = m.checkForUpdates();
    expect(result.dismissed).toBe(true);
    expect(result.hasUpdates).toBe(false);
  });

  it("checkForUpdates respects dismissPermanent", async () => {
    const m = await mod();
    m.seedBuiltinTeam();
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ version: "1.2.4" }));
    m.dismissPermanently(true);
    const result = m.checkForUpdates();
    expect(result.dismissed).toBe(true);
    expect(result.hasUpdates).toBe(false);
  });

  it("applyUpdates overwrites file and updates meta", async () => {
    const m = await mod();
    m.seedBuiltinTeam();
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ version: "1.2.4" }));
    const result = m.applyUpdates(["agents/pm.md"]);
    expect(result.applied).toContain("agents/pm.md");
    const meta = JSON.parse(readFileSync(join(bossmodeDir, "team-meta.json"), "utf-8"));
    expect(meta.files["agents/pm.md"].version).toBe("1.2.4");
  });

  it("applyUpdates injects source/version frontmatter", async () => {
    const m = await mod();
    m.seedBuiltinTeam();
    const content = readFileSync(join(bossmodeDir, "agents", "pm.md"), "utf-8");
    expect(content).toContain("source: builtin");
    expect(content).toContain("version: 1.2.3");
  });

  it("dismissVersion persists state", async () => {
    const m = await mod();
    m.dismissVersion("1.2.3");
    const meta = JSON.parse(readFileSync(join(bossmodeDir, "team-meta.json"), "utf-8"));
    expect(meta.dismissedVersion).toBe("1.2.3");
  });

  it("dismissPermanently persists and can reset version dismiss", async () => {
    const m = await mod();
    m.dismissVersion("1.2.3");
    m.dismissPermanently(true);
    m.dismissPermanently(false);
    const meta = JSON.parse(readFileSync(join(bossmodeDir, "team-meta.json"), "utf-8"));
    expect(meta.dismissPermanent).toBe(false);
    expect(meta.dismissedVersion).toBeNull();
  });

  it("readMeta fallback on corrupt file", async () => {
    const m = await mod();
    mkdirSync(bossmodeDir, { recursive: true });
    writeFileSync(join(bossmodeDir, "team-meta.json"), "{bad json", "utf-8");
    const result = m.checkForUpdates();
    expect(result.installedVersion).toBe("0.0.0");
  });
});
