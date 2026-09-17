import { getMigration } from "../helpers/schema.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyStorageMigrations, openDatabase, type Database } from "../../src/data/database.js";
const templatesMigration = getMigration("core-templates-v1");
import { listTemplateMetadata, readTemplateMetadata } from "../../src/member/templates.js";
import * as historical from "../../src/app/upgrade/records.js";
import { seedBuiltinAssets } from "../../src/member/templates.js";

const installation = vi.hoisted(() => ({ root: "" }));
vi.mock("../../src/files/layout.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/files/layout.js")>(),
  get installationRoot() { return installation.root; },
}));

const originalCwd = process.cwd();
let root: string;
let packageRoot: string;
let db: Database;
function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
beforeEach(() => {
  root = process.env.BOSSMODE_DIR!;
  if (!process.env.BOSSMODE_TEST_ROOT || !root.startsWith(process.env.BOSSMODE_TEST_ROOT + "/")) throw new Error("Use isolated test launcher");
  packageRoot = join(root, "package");
  installation.root = packageRoot;
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
  expect(listTemplateMetadata(db)).toEqual([]);
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
  const repository = db;
  const metadata = readTemplateMetadata("general", repository)!;
  expect(metadata.extensions).toEqual({ source: "builtin", version: 0.19, unknown: ["z", "a", "z"] });
  expect(metadata.tags).toEqual([]);
  expect(metadata.skills).toBeUndefined();
  seedBuiltinAssets();
  expect(readTemplateMetadata("general", repository)).toEqual(metadata);
  expect(historical.readTemplateBody(root, metadata)).toBe("\r\n kept body  \n");
  rmSync(join(root, metadata.personaPath));
  seedBuiltinAssets();
  expect(readTemplateMetadata("general", repository)).toEqual(metadata);
  expect(() => historical.readTemplateBody(root, metadata)).toThrow();
  expect(readFileSync(join(root, "agents/general.md"), "utf8")).toBe(legacy);
  expect(readFileSync(join(packageRoot, "templates/agents/general.md"), "utf8")).toContain("retired factory");
});
