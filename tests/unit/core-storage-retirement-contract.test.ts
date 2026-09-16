import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createLegacyMemberStorageFixture } from "../helpers/legacy-member-storage.js";
import { prepareCoreStorage } from "../../src/app/upgrade/run.js";
import { getDefaultConfig } from "../../src/config/config.js";
import { MembersRepository } from "../../src/data/repositories/members.js";
import { migratedMemberId } from "../helpers/short-id.js";
import { getDatabase, type Database } from "../../src/data/database.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
let root: string;
let db: Database | undefined;
beforeEach(() => {
  root = mkdtempSync(join(process.env.BOSSMODE_TEST_ROOT!, "storage-retirement-"));
  mkdirSync(join(root, "knowledge"));
});
afterEach(() => {
  db?.close(); db = undefined;
  rmSync(root, { recursive: true, force: true });
});
function file(path: string, bytes: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}
async function start() {
  const result = await prepareCoreStorage({ root, initialConfig: getDefaultConfig(), bundledCatalog: [] });
  db = result.db;
  return result;
}
function readLegacy<T>(query: string): T[] {
  const legacy = new DatabaseSync(join(root, "bossmode.db"), { readOnly: true });
  try { return legacy.prepare(query).all() as T[]; } finally { legacy.close(); }
}

// These are absence/package-boundary checks, not a rebuilt tarball assertion.
describe("production legacy retirement", () => {
  it("ships no standalone migration writer or retired implementation", () => {
    const pkg = JSON.parse(readFileSync(join(repository, "package.json"), "utf8"));
    expect(pkg.files.filter((entry: string) => entry.startsWith("scripts/"))).toEqual([
      "scripts/check-package-inputs.mjs",
    ]);
    for (const entry of pkg.files.filter((entry: string) => entry.startsWith("scripts/"))) {
      expect(existsSync(join(repository, entry)), entry).toBe(true);
    }
    expect(readdirSync(join(repository, "scripts")).filter(name => /^migrate-/.test(name))).toEqual([]);
    for (const path of ["src/member/migrations/identity-migration.ts", "src/member/migrations/member-assets-migration.ts", "src/knowledge/migration.ts",
      "dist/member/migrations/identity-migration.js", "dist/member/migrations/member-assets-migration.js", "dist/knowledge/migration.js"]) {
      expect(existsSync(join(repository, path)), path).toBe(false);
    }
    const sessions = readFileSync(join(repository, "assets/skills/bossmode-guide/references/sessions.md"), "utf8");
    expect(sessions).toContain("Supported storage upgrades run during normal startup");
    expect(sessions).not.toMatch(/--(?:dry-run|apply|recover)|scripts\/migrate-/);
    expect(pkg.files).not.toContain("tests");
    expect(pkg.files.some((entry: string) => entry.includes("legacy-member-storage"))).toBe(false);
  });

  it("leaves no production legacy bootstrap, heal command or test-fixture import", () => {
    for (const path of ["scripts/migrate-member-storage-v1.mjs", "scripts/heal-activity-index.mjs",
      "src/workspace/db/sqlite.ts", "src/workspace/db/schema.ts"]) {
      expect(existsSync(join(repository, path)), path).toBe(false);
    }
    function inspect(directory: string): void {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) inspect(path);
        else if (/\.(?:ts|mjs|js)$/.test(entry.name)) {
          expect(readFileSync(path, "utf8"), path).not.toMatch(
            /workspace\/db\/(?:sqlite|schema)|\b(?:openDb|resetDbCache|isDbAvailable|BossmodeDb)\b|migrate-member-storage-v1|heal-activity-index|helpers\/legacy-/,
          );
        }
      }
    }
    // Intentionally source/scripts only. The separately owned panel test must be
    // ported before integration; a permanent production shim is not an option.
    inspect(join(repository, "src"));
    inspect(join(repository, "scripts"));
  });

  it("documents ordinary startup with bounded recovery and no manual migration commands", () => {
    const readme = readFileSync(join(repository, "README.md"), "utf8");
    const upgrade = readme.split("### Upgrading to 0.24 RC\n")[1].split("<div")[0];
    expect(upgrade).toContain("Normal startup automatically backs up supported legacy storage, imports and validates it");
    expect(upgrade).toContain("retry normal startup");
    expect(upgrade).toContain("does not repair corrupt data or replace missing authoritative data");
    expect(upgrade).toContain("Do not delete `bossmode.db`");
    expect(upgrade).not.toMatch(/--(?:dry-run|apply|recover)|scripts\/migrate-|startup does not migrate/);
  });
});

describe("test-only historical fixture fidelity", () => {
  it("preserves the exact old table/index DDL, migration IDs and fresh projection state without binding", () => {
    expect(() => getDatabase()).toThrow("not initialized");
    createLegacyMemberStorageFixture(join(root, "bossmode.db"));
    expect(() => getDatabase()).toThrow("not initialized");
    const shape = readLegacy("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type,name");
    // Captured from ca0253d's original schema.ts SQL on Node 24 before deletion.
    // Includes all seven tables/five explicit indexes and their historical constraints.
    expect(createHash("sha256").update(JSON.stringify(shape)).digest("hex"))
      .toBe("c5edfdd76531bc66188d6a98ec06d038e6604448f38f065445f7c8e3af1dc301");
    expect(readLegacy("SELECT id FROM schema_migrations ORDER BY id")).toEqual([
      { id: "member-storage-v1" }, { id: "sqlite-projection-v1" },
    ]);
    expect(readLegacy("SELECT * FROM projection_state")).toEqual([]);
    expect(readLegacy("SELECT * FROM members")).toEqual([]);
  });

  it("requires an explicit new sandbox database and never reopens existing authority", () => {
    expect(() => createLegacyMemberStorageFixture("bossmode.db")).toThrow("absolute test sandbox path");
    expect(() => createLegacyMemberStorageFixture(join(dirname(process.env.BOSSMODE_TEST_ROOT!), "not-a-fixture.db")))
      .toThrow("inside the test sandbox");
    const path = join(root, "bossmode.db");
    file("bossmode.db", "existing authority");
    expect(() => createLegacyMemberStorageFixture(path)).toThrow("new database");
    expect(readFileSync(path, "utf8")).toBe("existing authority");
  });

  it("upgrades the historical SQL owner without importing poisoned old identities or changing persona bytes", async () => {
    createLegacyMemberStorageFixture(join(root, "bossmode.db"));
    const legacy = new DatabaseSync(join(root, "bossmode.db"));
    try {
      legacy.prepare("INSERT INTO members VALUES(?,?,?,?,?,?,?,?)")
        .run("mem_old", "Old", "old", "Engineer", "general", '{"model":"p/m"}', 123, 456);
    } finally { legacy.close(); }
    const body = "\uFEFF---\r\nnot frontmatter: [\r\n---\r\n literal 原文 😀\r\n";
    file("members/mem_old/persona.md", body);
    file("members/mem_old/member.json", "invalid retired identity");
    file("members/mem_old/member.md", "---\ninvalid retired frontmatter");
    const result = await start();
    const mid = migratedMemberId(db!, "mem_old");
    expect(result.migrated).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(new MembersRepository(db!).get(mid)).toMatchObject({
      id: mid, name: "Old", title: "Engineer", agentTemplate: "general", global: { model: "p/m" }, createdAt: 123, updatedAt: 456,
    });
    expect(db!.get("SELECT member_id FROM memory_documents WHERE path=?", `members/${mid}/persona.md`))
      .toEqual({ member_id: mid });
    expect(readFileSync(join(root, `members/${mid}/persona.md`))).toEqual(Buffer.from(body));
    expect(existsSync(join(root, `members/${mid}/member.json`))).toBe(false);
    const backup = new DatabaseSync(join(result.backupDirectory!, "database-before.sqlite"), { readOnly: true });
    try {
      expect(backup.prepare("SELECT id,name,created_at,updated_at FROM members").all())
        .toEqual([{ id: "mem_old", name: "Old", created_at: 123, updated_at: 456 }]);
      expect(backup.prepare("SELECT 1 FROM sqlite_master WHERE name='storage_meta'").get()).toBeUndefined();
    } finally { backup.close(); }
    db!.close();
    expect((await start()).migrated).toBe(false);
    expect(new MembersRepository(db!).list()).toHaveLength(1);
    expect(readFileSync(join(root, `members/${mid}/persona.md`))).toEqual(Buffer.from(body));
  });

  it("retains a corrupt historical SQL row on rejection instead of normalizing it in the fixture", async () => {
    createLegacyMemberStorageFixture(join(root, "bossmode.db"));
    const legacy = new DatabaseSync(join(root, "bossmode.db"));
    try {
      // The old schema accepted invalid global_json. The current schema must
      // reject it during staging, not retroactively make the fixture stricter.
      legacy.prepare("INSERT INTO members VALUES(?,?,?,?,?,?,?,?)")
        .run("mem_bad", "Bad", "bad", null, "general", "not json", 123, 456);
    } finally { legacy.close(); }
    file("members/mem_bad/persona.md", "unchanged\r\n");
    await expect(start()).rejects.toThrow(/malformed JSON|CHECK constraint failed/);
    expect(readLegacy("SELECT id,global_json,created_at,updated_at FROM members"))
      .toEqual([{ id: "mem_bad", global_json: "not json", created_at: 123, updated_at: 456 }]);
    expect(readLegacy("SELECT name FROM sqlite_master WHERE name='storage_meta'")).toEqual([]);
    expect(readFileSync(join(root, "members/mem_bad/persona.md"), "utf8")).toBe("unchanged\r\n");
  });
});
