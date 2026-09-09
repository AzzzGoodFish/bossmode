import { afterEach, beforeEach, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "../../src/storage/database.js";
import { baseStorageMigration } from "../../src/storage/base-schema.js";
import { prepareStorageUpgrade, type UpgradeOptions } from "../../src/storage/upgrade-runner.js";
import { templatesMigration } from "../../src/storage/schema/templates.js";
import { TemplateRepository } from "../../src/storage/repositories/templates.js";
import { importAgentTemplates, legacyAgentTemplateSources, readTemplateBody, seedAgentTemplates } from "../../src/workforce/template-files.js";

let root: string;
let opened: Database[];
const markdown = "---\r\nname: Display\r\nsource: user\r\nversion: v1\r\ncustom: [keep]\r\n---\r\n\r\n literal body  \r\n\n";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bossmode-template-upgrade-"));
  opened = [];
  mkdirSync(join(root, "agents"));
  writeFileSync(join(root, "agents/lookup.md"), markdown);
});
afterEach(() => { for (const db of opened) db.close(); rmSync(root, { recursive: true, force: true }); });

function options(overrides: Partial<UpgradeOptions> = {}): UpgradeOptions {
  return {
    root, formatVersion: 1, migrations: [baseStorageMigration, templatesMigration],
    collectLegacySources: async () => legacyAgentTemplateSources(["agents/lookup.md"]),
    importData: async ctx => {
      importAgentTemplates(ctx, legacyAgentTemplateSources(ctx.sourceFiles).map(({path}) => ({
        path, slug: path.slice("agents/".length, -3), markdown: readFileSync(join(ctx.sourceRoot, path), "utf8"),
      })));
      seedAgentTemplates(ctx, [{path: "package/agents/general.md", slug: "general", markdown: "---\nname: General\n---\ngeneral"}], "test-v1");
    },
    validate: async ctx => {
      const rows = new TemplateRepository(ctx.db).list();
      expect(rows.map(row => row.slug)).toEqual(["general", "lookup"]);
      expect(rows[1].extensions).toEqual({source: "user", version: "v1", custom: ["keep"]});
      // Bodies are still staged during validation; parent verifies/publishes the stageAsset manifest.
      expect(existsSync(join(root, rows[1].personaPath))).toBe(false);
    },
    ...overrides,
  };
}
async function run(overrides: Partial<UpgradeOptions> = {}) {
  const result = await prepareStorageUpgrade(options(overrides));
  opened.push(result.db);
  return result;
}

it("imports through real parent stageAsset, preserves body bytes, retires mixed files, and restarts without discovery", async () => {
  const first = await run();
  const metadata = new TemplateRepository(first.db).get("lookup")!;
  expect(readTemplateBody(root, metadata)).toBe("\r\n literal body  \r\n\n");
  expect(existsSync(join(root, "agents/lookup.md"))).toBe(false);
  expect(readFileSync(join(first.backupDirectory!, "files/agents/lookup.md"), "utf8")).toBe(markdown);
  first.db.close();
  const second = await run({
    collectLegacySources: async () => { throw new Error("must not discover retired files"); },
    importData: async () => { throw new Error("must not import again"); },
  });
  expect(second.migrated).toBe(false);
  expect(new TemplateRepository(second.db).get("lookup")).toEqual(metadata);
  expect(readTemplateBody(root, metadata)).toBe("\r\n literal body  \r\n\n");
});

it("retries an interrupted staging import without publishing partial SQL or retiring source files", async () => {
  await expect(run({checkpoint: phase => { if (phase === "import") throw new Error("interrupted"); }})).rejects.toThrow("interrupted");
  expect(readFileSync(join(root, "agents/lookup.md"), "utf8")).toBe(markdown);
  expect(existsSync(join(root, "bossmode.db"))).toBe(false);
  const recovered = await run();
  expect(new TemplateRepository(recovered.db).list()).toHaveLength(2);
  expect(readTemplateBody(root, new TemplateRepository(recovered.db).get("lookup")!)).toBe("\r\n literal body  \r\n\n");
});
