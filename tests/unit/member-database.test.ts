import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MemberRecord } from "../../src/member/member-registry.js";
import { coreFixture } from "../helpers/core-fixture.js";
import * as registry from "../../src/member/member-registry.js";
import { MemberArchiveService } from "../../src/member/archive/member-archive-lifecycle.js";
import { rebuildEventAggregates } from "../../src/data/repositories/event-repository.js";
let fixture: ReturnType<typeof coreFixture>;
let dir: string;
beforeEach(() => { fixture = coreFixture(); dir = fixture.root; });
afterEach(() => { vi.restoreAllMocks(); fixture.close(); });
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
    fixture.reopen();
    expect(registry.getMember(member.id)).toMatchObject({ name: "engineer", title: "Engineer", global: { thinkingLevel: "high", model: "test/model" } });
    expect(fixture.db.get<{ synchronous: number }>("PRAGMA synchronous")?.synchronous).toBe(2);
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
    expect(() => fixture.db.run("UPDATE members SET global_json = ? WHERE id = ?", "invalid", a.id)).toThrow();
    expect(registry.getMember(a.id)).toEqual(a);
    fixture.db.close();
    expect(() => registry.getMember(a.id)).toThrow(/bootstrap/);
    expect(() => registry.listMembers()).toThrow(/bootstrap/);
  });

  it("retains archived identity while tombstoning the authoritative row", async () => {
    const a = registry.createMember({ name: "fired", title: "Engineer" });
    const result = await new MemberArchiveService(fixture.db, dir, { quiesce: async () => {} }).archive(a.id, { confirm: true });
    expect(registry.getMember(a.id)).toBeNull();
    expect(existsSync(join(dir, "members", a.id))).toBe(false);
    expect(fixture.db.get("SELECT id,name,title,archive_path FROM members WHERE id=?", a.id)).toEqual({ id: a.id, name: a.name, title: "Engineer", archive_path: result.archived });
    expect(existsSync(join(dir, result.archived, "member.json"))).toBe(false);
    expect(existsSync(join(dir, result.archived, "persona.md"))).toBe(true);
  });

  it("never overwrites a concurrent rename with a stale configuration update", () => {
    const member = registry.createMember({ name: "before", model: "old" });
    const db = fixture.db;
    const originalGet = db.get.bind(db);
    let attempted = false;
    const spy = vi.spyOn(db, "get").mockImplementation((sql: string, ...params: unknown[]) => {
      const row = originalGet(sql, ...params);
      if (sql.includes("SELECT * FROM members WHERE id")) {
        attempted = true;
        const other = new DatabaseSync(db.path);
        try { expect(() => other.prepare("UPDATE members SET name = ?, name_key = ? WHERE id = ?").run("after", "after", member.id)).toThrow(/locked|busy/i); }
        finally { other.close(); }
      }
      return row;
    });
    try { registry.updateMember(member.id, { global: { model: "new" } }); }
    finally { spy.mockRestore(); }
    expect(attempted).toBe(true);
    expect(registry.getMember(member.id)).toMatchObject({ name: "before", global: { model: "new" } });
    registry.renameMember(member.id, "after");
    expect(registry.getMember(member.id)).toMatchObject({ name: "after", global: { model: "new" } });
  });

  it("preserves authoritative members across repeated aggregate rebuild and reopen", () => {
    const a = registry.createMember({ name: "durable" });
    rebuildEventAggregates(); rebuildEventAggregates(); fixture.reopen();
    expect(registry.getMember(a.id)).toEqual(a);
  });

  it("validates rename without changing either identity field", () => {
    const a = registry.createMember({ name: "valid", title: "untouched" });
    expect(() => registry.renameMember(a.id, " ")).toThrow("invalid_member_name");
    expect(() => registry.updateMemberIdentity(a.id, { name: "next", title: 5 as any })).toThrow("invalid_member_title");
    expect(registry.getMember(a.id)).toMatchObject({ name: "valid", title: "untouched" });
  });
});
