import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemberRecord } from "../../src/workspace/member-registry.js";
let registry: typeof import("../../src/workspace/member-registry.js");
let sqlite: typeof import("../../src/workspace/db/sqlite.js");
let projection: typeof import("../../src/workspace/db/projection.js");

let dir: string;
let previous: string | undefined;
beforeEach(async () => {
  previous = process.env.BOSSMODE_DIR;
  dir = mkdtempSync(join(tmpdir(), "bm-member-db-"));
  process.env.BOSSMODE_DIR = dir;
  mkdirSync(join(dir, "rooms"));
  vi.resetModules();
  registry = await import("../../src/workspace/member-registry.js");
  sqlite = await import("../../src/workspace/db/sqlite.js");
  projection = await import("../../src/workspace/db/projection.js");
});
afterEach(() => {
  sqlite.resetDbCache();
  if (previous === undefined) delete process.env.BOSSMODE_DIR; else process.env.BOSSMODE_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});
function legacy(id = "mem_import", name = "imported"): MemberRecord {
  return { id, name, title: "Engineer", agentTemplate: "general", global: { model: "test/model", skills: ["test"] },
    unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}, createdAt: 101, updatedAt: 102 };
}

describe("authoritative member database", () => {
  it("creates a blank persona and persists identity/configuration only in SQLite across reopen", () => {
    const member = registry.createMember({ name: " engineer ", title: " Engineer ", model: "test/model" });
    expect(member.name).toBe("engineer"); expect(member.title).toBe("Engineer");
    expect(existsSync(join(dir, "members", member.id, "member.json"))).toBe(false);
    expect(readFileSync(join(dir, "members", member.id, "persona.md"), "utf8")).toBe("");
    registry.updateMember(member.id, { global: { thinkingLevel: "high" } });
    sqlite.resetDbCache();
    expect(registry.getMember(member.id)).toMatchObject({ name: "engineer", title: "Engineer", global: { thinkingLevel: "high", model: "test/model" } });
    expect(sqlite.openDb().get<{ synchronous: number }>("PRAGMA synchronous")?.synchronous).toBe(2);
  });

  it("enforces Unicode-aware normalized uniqueness and updates name/title atomically", () => {
    const a = registry.createMember({ name: "Änne", title: "old" });
    const b = registry.createMember({ name: "second", title: "unchanged" });
    expect(() => registry.createMember({ name: "änne" })).toThrow(registry.MemberNameTakenError);
    expect(() => registry.updateMemberIdentity(b.id, { name: " ÄNNE ", title: "must not commit" })).toThrow(registry.MemberNameTakenError);
    expect(registry.getMember(b.id)).toMatchObject({ name: "second", title: "unchanged" });
    const changed = registry.updateMemberIdentity(a.id, { name: "言实", title: "工程师" });
    expect(changed.id).toBe(a.id); expect(registry.findMemberByName("言实")?.id).toBe(a.id);
    expect(registry.findMemberByName("Änne")).toBeNull();
    expect(registry.updateMemberIdentity(a.id, { name: "言实", title: "工程师" }).updatedAt).toBe(changed.updatedAt);
    expect(registry.updateMemberIdentity(a.id, { title: "" }).title).toBeUndefined();
  });

  it("does not consult old member.json files", () => {
    const record = legacy();
    mkdirSync(join(dir, "members", record.id), { recursive: true });
    writeFileSync(join(dir, "members", record.id, "member.json"), JSON.stringify(record));
    expect(registry.listMembers()).toEqual([]); expect(registry.getMember(record.id)).toBeNull();
  });

  it("imports exact IDs/timestamps without persona creation and refuses overwrite", () => {
    const record = legacy();
    expect(registry.importMemberRecord(record)).toEqual(record);
    expect(existsSync(join(dir, "members", record.id, "persona.md"))).toBe(false);
    expect(() => registry.importMemberRecord({ ...record, name: "replacement" })).toThrow();
    expect(() => registry.importMemberRecord(legacy("mem_other", "IMPORTED"))).toThrow(registry.MemberNameTakenError);
    expect(registry.getMember(record.id)).toEqual(record);
    expect(() => registry.importMemberRecord({ ...record, id: "../bad" })).toThrow("invalid_member_record");
  });

  it("reports storage corruption rather than silently returning no members", () => {
    const a = registry.createMember({ name: "a" });
    sqlite.openDb().run("UPDATE members SET global_json = ? WHERE id = ?", "invalid", a.id);
    expect(() => registry.getMember(a.id)).toThrow(); expect(() => registry.listMembers()).toThrow();
  });

  it("exports fired identity before removing the authoritative row", () => {
    const a = registry.createMember({ name: "fired", title: "Engineer" });
    const result = registry.fireMember(a.id, { confirm: true });
    expect(registry.getMember(a.id)).toBeNull();
    expect(existsSync(join(dir, "members", a.id))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, result.archived, "member.json"), "utf8"))).toMatchObject({ id: a.id, name: a.name, title: "Engineer" });
    expect(existsSync(join(dir, result.archived, "persona.md"))).toBe(true);
  });

  it("preserves an existing projection during schema upgrade instead of rebuilding it", async () => {
    const db = sqlite.openDb();
    db.exec("DROP TABLE members; DROP TABLE projection_state; DELETE FROM schema_migrations WHERE id = 'member-storage-v1'");
    db.run("INSERT INTO token_usage_daily (room_id,member_id,date,model,input_tokens,output_tokens,cache_read,cache_write,cost,turns) VALUES (?,?,?,?,?,?,?,?,?,?)", "topic:preserve", "mem_old", "2026-09-08", "model", 42, 0, 0, 0, 0, 1);
    sqlite.resetDbCache();
    projection.initProjection();
    await projection.waitForProjectionInitialization();
    expect(projection.getBackfillStatus().status).toBe("ready");
    expect(sqlite.openDb().get<{ input_tokens: number }>("SELECT input_tokens FROM token_usage_daily WHERE room_id = ?", "topic:preserve")?.input_tokens).toBe(42);
  });

  it("never overwrites a concurrent rename with a stale configuration update", () => {
    const member = registry.createMember({ name: "before", model: "old" });
    const db = sqlite.openDb();
    const originalGet = db.get.bind(db);
    const spy = vi.spyOn(db, "get").mockImplementation((sql: string, ...params: unknown[]) => {
      const row = originalGet(sql, ...params);
      if (sql === "SELECT * FROM members WHERE id = ?") {
        const other = new DatabaseSync(db.path);
        try { other.prepare("UPDATE members SET name = ?, name_key = ? WHERE id = ?").run("after", "after", member.id); }
        finally { other.close(); }
      }
      return row;
    });
    try { expect(() => registry.updateMember(member.id, { global: { model: "new" } })).toThrow(/locked|busy/i); }
    finally { spy.mockRestore(); }
    expect(registry.getMember(member.id)).toMatchObject({ name: "after", global: { model: "old" } });
  });

  it("starts backfill even when member storage created the DB first and preserves members on rebuild", async () => {
    const a = registry.createMember({ name: "durable" });
    expect(sqlite.openDb().get("SELECT * FROM projection_state")).toBeUndefined();
    expect(projection.initProjection()).not.toBeNull();
    await projection.waitForProjectionInitialization();
    expect(projection.getBackfillStatus().status).toBe("ready");
    expect(sqlite.openDb().get("SELECT * FROM projection_state WHERE key = 'backfill-complete'")).toBeDefined();
    await projection.rebuildProjection();
    expect(registry.getMember(a.id)?.name).toBe("durable");
  });

  it("validates rename without changing either identity field", () => {
    const a = registry.createMember({ name: "valid", title: "untouched" });
    expect(() => registry.renameMember(a.id, " ")).toThrow("invalid_member_name");
    expect(() => registry.updateMemberIdentity(a.id, { name: "next", title: 5 as any })).toThrow("invalid_member_title");
    expect(registry.getMember(a.id)).toMatchObject({ name: "valid", title: "untouched" });
  });
});
