import { getMigration } from "../helpers/schema.js";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "../../src/data/database.js";
const baseStorageMigration = getMigration("core-base-v1");
import { prepareStorageUpgrade, type UpgradeOptions } from "../../src/app/upgrade/run.js";
const templatesMigration = getMigration("core-templates-v1");
import { listTemplateMetadata, readTemplateMetadata } from "../../src/member/templates.js";
import { importAgentTemplates, legacyAgentTemplateSources, readTemplateBody } from "../../src/app/upgrade/records.js";

const ioFailure = vi.hoisted(() => ({
  partialBody: false,
  syncPath: "",
  synced: [] as string[],
  openPaths: new Map<number, string>(),
}));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      ioFailure.openPaths.set(fd, String(args[0]));
      return fd;
    }),
    closeSync: (fd: number) => { ioFailure.openPaths.delete(fd); fs.closeSync(fd); },
    fsyncSync: (fd: number) => {
      const path = ioFailure.openPaths.get(fd)!;
      if (path === ioFailure.syncPath) throw new Error("injected directory fsync failure");
      fs.fsyncSync(fd);
      ioFailure.synced.push(path);
    },
    writeFileSync: ((...args: Parameters<typeof fs.writeFileSync>) => {
      if (ioFailure.partialBody && typeof args[0] === "number" && ioFailure.openPaths.get(args[0])?.endsWith("persona.md")) {
        fs.writeFileSync(args[0], "partial");
        throw new Error("injected partial write");
      }
      return fs.writeFileSync(...args);
    }),
  };
});

let root: string;
let opened: Database[];
const markdown = "---\r\nname: Display\r\nsource: user\r\nversion: v1\r\ncustom: [keep]\r\n---\r\n\r\n literal body  \r\n\n";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bossmode-template-upgrade-"));
  opened = [];
  mkdirSync(join(root, "agents"));
  writeFileSync(join(root, "agents/lookup.md"), markdown);
});
afterEach(() => { ioFailure.partialBody = false; ioFailure.syncPath = ""; ioFailure.synced = []; ioFailure.openPaths.clear(); for (const db of opened) db.close(); rmSync(root, { recursive: true, force: true }); });

function options(overrides: Partial<UpgradeOptions> = {}): UpgradeOptions {
  return {
    root, formatVersion: 1, migrations: [baseStorageMigration, templatesMigration],
    collectLegacySources: async () => legacyAgentTemplateSources(["agents/lookup.md"]),
    importData: async ctx => {
      importAgentTemplates(ctx, legacyAgentTemplateSources(ctx.sourceFiles).map(({path}) => ({
        path, slug: path.slice("agents/".length, -3), markdown: readFileSync(join(ctx.sourceRoot, path), "utf8"),
      })));
    },
    validate: async ctx => {
      const rows = listTemplateMetadata(ctx.db);
      expect(rows.map(row => row.slug)).toEqual(["lookup"]);
      expect(rows[0].extensions).toEqual({source: "user", version: "v1", custom: ["keep"]});
      // Bodies are still staged during validation; parent verifies/publishes the stageAsset manifest.
      expect(existsSync(join(root, rows[0].personaPath))).toBe(false);
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
  const metadata = readTemplateMetadata("lookup", first.db)!;
  expect(readTemplateBody(root, metadata)).toBe("\r\n literal body  \r\n\n");
  expect(existsSync(join(root, "agents/lookup.md"))).toBe(false);
  expect(readFileSync(join(first.backupDirectory!, "files/agents/lookup.md"), "utf8")).toBe(markdown);
  first.db.close();
  const second = await run({
    collectLegacySources: async () => { throw new Error("must not discover retired files"); },
    importData: async () => { throw new Error("must not import again"); },
  });
  expect(second.migrated).toBe(false);
  expect(readTemplateMetadata("lookup", second.db)).toEqual(metadata);
  expect(readTemplateBody(root, metadata)).toBe("\r\n literal body  \r\n\n");
});

it("retries an interrupted staging import without publishing partial SQL or retiring source files", async () => {
  await expect(run({checkpoint: phase => { if (phase === "import") throw new Error("interrupted"); }})).rejects.toThrow("interrupted");
  expect(readFileSync(join(root, "agents/lookup.md"), "utf8")).toBe(markdown);
  expect(existsSync(join(root, "bossmode.db"))).toBe(false);
  const recovered = await run();
  expect(listTemplateMetadata(recovered.db)).toHaveLength(1);
  expect(readTemplateBody(root, readTemplateMetadata("lookup", recovered.db)!)).toBe("\r\n literal body  \r\n\n");
});

const exactBody = "\r\n literal body  \r\n\n";
function personaPath(): string {
  return `agents/lookup/import-${createHash("sha256").update(exactBody).digest("hex")}/persona.md`;
}
function expectUnpublished(): void {
  expect(readFileSync(join(root, "agents/lookup.md"), "utf8")).toBe(markdown);
  expect(existsSync(join(root, "bossmode.db"))).toBe(false);
}

it("does not publish a partially staged historical body, preserves backup, and retries exact bytes", async () => {
  ioFailure.partialBody = true;
  await expect(run()).rejects.toThrow("injected partial write");
  expectUnpublished();
  expect(existsSync(join(root, personaPath()))).toBe(false);
  ioFailure.partialBody = false;
  const recovered = await run();
  expect(readFileSync(join(root, personaPath()))).toEqual(Buffer.from(exactBody));
  expect(readFileSync(join(recovered.backupDirectory!, "files/agents/lookup.md"))).toEqual(Buffer.from(markdown));
});

it.each(["slug", "body"])("re-syncs after the %s directory mkdir becomes visible but parent fsync fails", async level => {
  const created = level === "slug" ? "agents/lookup" : join(personaPath(), "..");
  const parent = join(root, created, "..");
  mkdirSync(parent, { recursive: true });
  expect(existsSync(join(root, created))).toBe(false);
  const failureOptions: Partial<UpgradeOptions> = {
    validate: async () => { ioFailure.syncPath = parent; },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(run(failureOptions)).rejects.toThrow("injected directory fsync failure");
    ioFailure.syncPath = "";
    expect(existsSync(join(root, created))).toBe(true);
    expectUnpublished();
  }
  ioFailure.synced = [];
  await run({ checkpoint: phase => {
    if (phase === "validated") {
      expect(ioFailure.synced).toEqual(expect.arrayContaining([root, join(root, "agents"), join(root, "agents/lookup"), join(root, personaPath(), "..")]));
    }
  } });
  expect(readFileSync(join(root, personaPath()))).toEqual(Buffer.from(exactBody));
});

it.each(["", "agents", "agents/lookup"])("blocks cutover on renewed %j fsync failure even with matching historical bytes", async ancestor => {
  mkdirSync(join(root, personaPath(), ".."), { recursive: true });
  writeFileSync(join(root, personaPath()), exactBody);
  for (let attempt = 0; attempt < 2; attempt++) {
    await expect(run({ validate: async () => { ioFailure.syncPath = join(root, ancestor); } })).rejects.toThrow("injected directory fsync failure");
    ioFailure.syncPath = "";
    expectUnpublished();
    expect(readFileSync(join(root, personaPath()))).toEqual(Buffer.from(exactBody));
  }
  const recovered = await run({ validate: async () => {} });
  expect(readTemplateBody(root, readTemplateMetadata("lookup", recovered.db)!)).toBe(exactBody);
});

it("rejects a conflicting historical body without overwriting it or retiring its source", async () => {
  mkdirSync(join(root, personaPath(), ".."), { recursive: true });
  writeFileSync(join(root, personaPath()), "user content");
  await expect(run({ validate: async () => {} })).rejects.toThrow("Existing asset differs");
  expectUnpublished();
  expect(readFileSync(join(root, personaPath()), "utf8")).toBe("user content");
});

it.each(["agents/lookup", "body"])("rejects symlinked historical staging destination %s without publication", async target => {
  const path = target === "body" ? personaPath() : target;
  mkdirSync(join(root, path, ".."), { recursive: true });
  symlinkSync(join(root, "agents/lookup.md"), join(root, path));
  await expect(run()).rejects.toThrow("symlink");
  expectUnpublished();
});

it("rejects symlinked legacy sources before backup/import", async () => {
  unlinkSync(join(root, "agents/lookup.md"));
  writeFileSync(join(root, "outside.md"), markdown);
  symlinkSync(join(root, "outside.md"), join(root, "agents/lookup.md"));
  await expect(run()).rejects.toThrow("symlink");
  expectUnpublished();
});

it("does not retire changed legacy data after cutover, keeps catalog authority and retries retirement", async () => {
  const first = await run({ checkpoint: phase => {
    if (phase === "activated") writeFileSync(join(root, "agents/lookup.md"), "changed user data");
  } });
  expect(first.warnings).toContain("Legacy source retirement pending: agents/lookup.md");
  const metadata = readTemplateMetadata("lookup", first.db)!;
  expect(readTemplateBody(root, metadata)).toBe(exactBody);
  expect(readFileSync(join(root, "agents/lookup.md"), "utf8")).toBe("changed user data");
  expect(readFileSync(join(first.backupDirectory!, "files/agents/lookup.md"), "utf8")).toBe(markdown);
  first.db.close();
  writeFileSync(join(root, "agents/lookup.md"), markdown);
  const second = await run({ importData: async () => { throw new Error("must not import again"); } });
  expect(second.migrated).toBe(false);
  expect(second.warnings).toEqual([]);
  expect(existsSync(join(root, "agents/lookup.md"))).toBe(false);
  expect(readTemplateMetadata("lookup", second.db)).toEqual(metadata);
});

it("requires the verified backup for retirement on restart", async () => {
  await expect(run({ checkpoint: phase => { if (phase === "activated") throw new Error("stop before retirement"); } })).rejects.toThrow("stop before retirement");
  // Read the recorded path from the already authoritative catalog, not filesystem discovery.
  const { openDatabase } = await import("../../src/data/database.js");
  const db = openDatabase(join(root, "bossmode.db"));
  const backup = db.get<{backup_path: string}>("SELECT backup_path FROM storage_upgrade_files WHERE path='agents/lookup.md'")!.backup_path;
  db.close();
  writeFileSync(join(root, backup), "corrupt backup");
  const pending = await run();
  expect(pending.warnings).toContain("Legacy source retirement pending: agents/lookup.md");
  expect(readFileSync(join(root, "agents/lookup.md"), "utf8")).toBe(markdown);
  expect(readTemplateBody(root, readTemplateMetadata("lookup", pending.db)!)).toBe(exactBody);
  pending.db.close();
  writeFileSync(join(root, backup), markdown);
  const recovered = await run();
  expect(recovered.warnings).toEqual([]);
  expect(existsSync(join(root, "agents/lookup.md"))).toBe(false);
});
