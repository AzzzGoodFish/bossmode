import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { baseStorageMigration } from "../../src/storage/base-schema.js";
import { getDatabase, type Database } from "../../src/storage/database.js";
import { prepareStorageUpgrade, type UpgradeOptions } from "../../src/storage/upgrade-runner.js";

let root: string;
let opened: Database[];
function source(name: string, content: string) { const path = join(root, name); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); }
function options(overrides: Partial<UpgradeOptions> = {}): UpgradeOptions {
  return {
    root, formatVersion: 1,
    migrations: [baseStorageMigration, { id: "fixture-v1", sql: "CREATE TABLE records (id TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)" }],
    collectLegacySources: async () => ["config.json"],
    importData: async ({ db, sourceRoot, legacy }) => {
      if (legacy) {
        const value = JSON.parse(readFileSync(join(sourceRoot, "config.json"), "utf8"));
        db.transaction(tx => tx.run("INSERT INTO records VALUES (?,?)", value.id, value.value));
      }
    },
    validate: async ({ db }) => { expect(db.all("SELECT * FROM records")).toEqual([{ id: "original", value: "preserve me" }]); },
    ...overrides,
  };
}
async function run(overrides: Partial<UpgradeOptions> = {}) {
  const result = await prepareStorageUpgrade(options(overrides)); opened.push(result.db); return result;
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bm-core-upgrade-unit-")); opened = []; source("config.json", JSON.stringify({ id: "original", value: "preserve me" })); });
afterEach(() => { for (const db of opened) db.close(); rmSync(root, { recursive: true, force: true }); });

describe("ordinary startup storage upgrade coordinator", () => {
  it("backs up, imports, validates and retires sources without binding or modifying SDK sessions", async () => {
    source("members/mem_one/sessions/keep.jsonl", "{\"session\":\"unchanged\"}\n");
    const phases: string[] = [];
    const result = await run({ onProgress: p => phases.push(p.phase) });
    expect(result.migrated).toBe(true); expect(result.warnings).toEqual([]);
    expect(() => getDatabase()).toThrow("not initialized");
    expect(existsSync(join(root, "config.json"))).toBe(false);
    expect(readFileSync(join(result.backupDirectory!, "files/config.json"), "utf8")).toContain("preserve me");
    expect(statSync(join(result.backupDirectory!, "files/config.json")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(root, "members/mem_one/sessions/keep.jsonl"), "utf8")).toBe("{\"session\":\"unchanged\"}\n");
    expect(phases).toEqual(expect.arrayContaining(["checking", "backing-up", "importing", "validating", "cutover", "retiring", "ready"]));
  });
  it("does not rescan or import historical files after successful cutover", async () => {
    const first = await run(); first.db.close();
    const second = await run({ collectLegacySources: async () => { throw new Error("must not scan"); }, importData: async () => { throw new Error("must not import"); } });
    expect(second.migrated).toBe(false);
    expect(second.db.all("SELECT * FROM records")).toEqual([{ id: "original", value: "preserve me" }]);
  });
  it("keeps authoritative database and legacy sources unchanged on an interrupted import", async () => {
    const old = new DatabaseSync(join(root, "bossmode.db"));
    old.exec("PRAGMA journal_mode=WAL; CREATE TABLE old_records(id INTEGER); INSERT INTO old_records VALUES(7)"); old.close();
    await expect(run({ checkpoint: phase => { if (phase === "import") throw new Error("injected interruption"); } })).rejects.toThrow("injected interruption");
    expect(existsSync(join(root, "config.json"))).toBe(true);
    const original = new DatabaseSync(join(root, "bossmode.db"), { readOnly: true });
    expect(original.prepare("SELECT * FROM old_records").all()).toEqual([{ id: 7 }]);
    expect(original.prepare("SELECT name FROM sqlite_master WHERE name='records'").get()).toBeUndefined(); original.close();
    const next = await run();
    expect(next.db.all("SELECT * FROM records")).toHaveLength(1);
    expect(readdirSync(join(root, "upgrades")).some(name => name.startsWith("interrupted-"))).toBe(true);
  });
  it("protects existing database writes while the snapshot is being imported", async () => {
    const old = new DatabaseSync(join(root, "bossmode.db"));
    old.exec("PRAGMA journal_mode=WAL; CREATE TABLE old_records(id INTEGER)"); old.close();
    const defaults = options();
    await run({ importData: async ctx => {
      const other = new DatabaseSync(join(root, "bossmode.db"));
      try { expect(() => other.exec("INSERT INTO old_records VALUES(8)")).toThrow(/locked/); }
      finally { other.close(); }
      await defaults.importData(ctx);
    } });
  });
  it("recovers after activation without reimporting or losing committed data", async () => {
    await expect(run({ checkpoint: phase => { if (phase === "activated") throw new Error("process stopped"); } })).rejects.toThrow("process stopped");
    expect(existsSync(join(root, "config.json"))).toBe(true);
    const next = await run({ importData: async () => { throw new Error("must not reimport"); } });
    expect(next.migrated).toBe(false); expect(next.warnings).toEqual([]);
    expect(next.db.all("SELECT * FROM records")).toHaveLength(1);
    expect(existsSync(join(root, "config.json"))).toBe(false);
  });
  it("prepares persona bytes and safely retries after validation interruption", async () => {
    const defaults = options();
    const importData: UpgradeOptions["importData"] = async ctx => { await defaults.importData(ctx); ctx.stageAsset("members/mem_one/persona.md", Buffer.from("  literal\r\n\n")); };
    await expect(run({ importData, checkpoint: phase => { if (phase === "validated") throw new Error("interrupted"); } })).rejects.toThrow("interrupted");
    expect(existsSync(join(root, "config.json"))).toBe(true);
    await run({ importData });
    expect(readFileSync(join(root, "members/mem_one/persona.md"), "utf8")).toBe("  literal\r\n\n");
  });
  it("never overwrites an existing different file asset", async () => {
    source("members/mem_one/persona.md", "user's existing text");
    const defaults = options();
    await expect(run({ importData: async ctx => { await defaults.importData(ctx); ctx.stageAsset("members/mem_one/persona.md", Buffer.from("different")); } })).rejects.toThrow("Existing asset differs");
    expect(readFileSync(join(root, "members/mem_one/persona.md"), "utf8")).toBe("user's existing text");
    expect(existsSync(join(root, "config.json"))).toBe(true);
    expect(existsSync(join(root, "bossmode.db"))).toBe(false);
  });
  it("detects changes to live sources before activating the new authority", async () => {
    const defaults = options();
    await expect(run({ importData: async ctx => { await defaults.importData(ctx); source("config.json", "edited outside migration"); } })).rejects.toThrow("Source changed before cutover");
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe("edited outside migration");
    expect(existsSync(join(root, "bossmode.db"))).toBe(false);
  });
  it("rejects traversal and symlink source inventory", async () => {
    await expect(run({ collectLegacySources: async () => ["dir/../config.json"] })).rejects.toThrow("canonical");
    symlinkSync("config.json", join(root, "linked.json"));
    await expect(run({ collectLegacySources: async () => ["linked.json"] })).rejects.toThrow("symlink");
    symlinkSync("missing", join(root, "broken.json"));
    await expect(run({ collectLegacySources: async () => ["broken.json"] })).rejects.toThrow("symlink");
  });
  it("keeps the upgrade lease through application activation", async () => {
    await run({ activate: async () => { await expect(run()).rejects.toThrow("lease"); } });
  });
  it("rejects another live service without beginning an upgrade", async () => {
    source("bossmode.pid", String(process.ppid));
    await expect(run()).rejects.toThrow("Another Bossmode process");
    expect(existsSync(join(root, "upgrades"))).toBe(false);
  });
  it("refuses a storage-format downgrade", async () => {
    const current = await run({ formatVersion: 2 }); current.db.close();
    await expect(run({ formatVersion: 1 })).rejects.toThrow("newer storage format");
  });
  it("retains modified legacy leftovers after cutover rather than overwriting user edits", async () => {
    await expect(run({ checkpoint: phase => { if (phase === "activated") { source("config.json", "late edit"); throw new Error("stopped"); } } })).rejects.toThrow("stopped");
    const next = await run();
    expect(next.warnings).toContain("Legacy source retirement pending: config.json");
    expect(readFileSync(join(root, "config.json"), "utf8")).toBe("late edit");
    expect(next.db.all("SELECT * FROM records")).toEqual([{ id: "original", value: "preserve me" }]);
  });
  it("refuses to publish a staging database while a reader pins its WAL", async () => {
    let reader: DatabaseSync | undefined;
    try {
      await expect(run({ validate: async ({db}) => {
        db.exec("PRAGMA busy_timeout=0");
        reader = new DatabaseSync(db.path, { readOnly: true });
        reader.exec("BEGIN"); reader.prepare("SELECT * FROM records").all();
      } })).rejects.toThrow("Staging database is still in use");
      expect(existsSync(join(root, "bossmode.db"))).toBe(false);
      expect(existsSync(join(root, "config.json"))).toBe(true);
    } finally { reader?.close(); }
    const next = await run(); expect(next.db.all("SELECT * FROM records")).toHaveLength(1);
  });
  it("allows append-only schema upgrades and refuses same-format truncation or reordering", async () => {
    const initial = await run(); initial.db.close();
    const before = options().migrations;
    const newer = [...before, {id: "fixture-v2", sql: "CREATE TABLE extra(id INTEGER)"}];
    const upgraded = await run({migrations: newer});
    const marker = upgraded.db.get<{value: string}>("SELECT value FROM storage_meta WHERE key='core-authority'")!.value;
    expect(upgraded.migrated).toBe(true); upgraded.db.close();
    await expect(run({migrations: before})).rejects.toThrow("Unsupported or reordered");
    await expect(run({migrations: [newer[1], newer[0], newer[2]]})).rejects.toThrow("Unsupported or reordered");
    const live = new DatabaseSync(join(root, "bossmode.db"), {readOnly:true});
    try { expect(live.prepare("SELECT value FROM storage_meta WHERE key='core-authority'").get()!.value).toBe(marker); }
    finally { live.close(); }
  });

});
