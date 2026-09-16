import { getMigration } from "../helpers/schema.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyStorageMigrations, openDatabase, type Database } from "../../src/data/database.js";
const templatesMigration = getMigration("core-templates-v1");
import { TemplateRepository } from "../../src/data/repositories/templates.js";
import * as historical from "../../src/app/upgrade/records.js";
import { seedBuiltinAssets } from "../../src/member/assets/team-updates.js";

const originalCwd = process.cwd();
const originalDir = process.env.BOSSMODE_DIR;
let root: string;
let packageRoot: string;
let db: Database;
function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bossmode-template-retirement-"));
  process.env.BOSSMODE_DIR = root;
  packageRoot = join(root, "package");
  write(join(packageRoot, "package.json"), '{"version":"test-version"}');
  // A stale package directory must not resurrect agents, even when its YAML is invalid.
  write(join(packageRoot, "templates/agents/general.md"), "---\nname: [\n---\nretired factory");
  write(join(packageRoot, "templates/skills/demo/SKILL.md"), "---\nname: demo\n---\nallowed skill");
  write(join(packageRoot, "templates/teams/dev-team/team-prompt.md"), "# Protocol\nallowed rule");
  db = openDatabase(join(root, "historical.sqlite"));
  applyStorageMigrations(db, [templatesMigration]);
  process.chdir(packageRoot);
});
afterEach(() => {
  db.close();
  process.chdir(originalCwd);
  process.env.BOSSMODE_DIR = originalDir;
  rmSync(root, { recursive: true, force: true });
});

it("removes live modules, factory agent assets and live template-file exports, not skill templates", () => {
  const repo = join(import.meta.dirname, "../..");
  for (const path of ["src/workforce/agent-store.ts", "src/workforce/template-lifecycle.ts", "templates/agents"]) {
    expect(existsSync(join(repo, path))).toBe(false);
  }
  for (const name of ["importAgentTemplates", "legacyAgentTemplateSources", "parseAgentDefinitionMarkdown", "readTemplateBody"] as const) {
    expect(historical[name]).toBeTypeOf("function");
  }
  for (const name of ["createAgentDefinition", "updateAgentDefinition", "deleteAgentDefinition", "getAgentDefinition", "listAgentDefinitions"]) {
    expect(historical).not.toHaveProperty(name);
  }
  expect(existsSync(join(repo, "templates/skills/impeccable/SKILL.md"))).toBe(true);
});

it("fresh seeding ignores all agents, needs no bound DB, and retains skill/rule file seeding", () => {
  seedBuiltinAssets();
  expect(new TemplateRepository(db).list()).toEqual([]);
  expect(existsSync(join(root, "agents"))).toBe(false);
  expect(readFileSync(join(root, "skills/demo/SKILL.md"), "utf8")).toContain("allowed skill");
  expect(readFileSync(join(root, "memory/projects/rules/team-dev-protocol.md"), "utf8")).toContain("allowed rule");
});

it("repeated seeding never changes installed legacy data, historical labels/body references, or missing bodies", () => {
  const legacy = "---\nname: Historical General\nsource: builtin\nversion: 0.19\nunknown: [z, a, z]\ntags: []\n---\n\r\n kept body  \n";
  write(join(root, "agents/general.md"), legacy);
  historical.importAgentTemplates({ db, stageAsset: (path, bytes) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), bytes);
  } }, [{ slug: "general", path: "agents/general.md", markdown: legacy }]);
  const repository = new TemplateRepository(db);
  const metadata = repository.get("general")!;
  expect(metadata.extensions).toEqual({ source: "builtin", version: 0.19, unknown: ["z", "a", "z"] });
  expect(metadata.tags).toEqual([]);
  expect(metadata.skills).toBeUndefined();
  seedBuiltinAssets();
  expect(repository.get("general")).toEqual(metadata);
  expect(historical.readTemplateBody(root, metadata)).toBe("\r\n kept body  \n");
  rmSync(join(root, metadata.personaPath));
  seedBuiltinAssets();
  expect(repository.get("general")).toEqual(metadata);
  expect(() => historical.readTemplateBody(root, metadata)).toThrow();
  expect(readFileSync(join(root, "agents/general.md"), "utf8")).toBe(legacy);
  expect(readFileSync(join(packageRoot, "templates/agents/general.md"), "utf8")).toContain("retired factory");
});
