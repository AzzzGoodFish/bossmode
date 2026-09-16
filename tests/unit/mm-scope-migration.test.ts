import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, applyStorageMigrations, type Database } from "../../src/data/database.js";
import { coreStorageMigrations } from "../../src/data/schema.js";

let root: string;
let db: Database | undefined;
// Everything before the mm-scope migration: a cutoff slice so later-appended
// migrations (e.g. core-short-ids-v1) never leak into the "old schema" fixture.
const MM_SCOPE_CUTOFF = coreStorageMigrations.findIndex((m) => m.id === "core-mm-scope-v1");
if (MM_SCOPE_CUTOFF < 0) throw new Error("core-mm-scope-v1 missing from the migration list");
const beforeMmScope = () => coreStorageMigrations.slice(0, MM_SCOPE_CUTOFF);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "mm-scope-")); });
afterEach(() => { db?.close(); db = undefined; rmSync(root, { recursive: true, force: true }); });

describe("core-mm-scope-v1", () => {
  it("swaps the scope-kind constraint in place, keeps child FKs pointed at scopes, and accepts mm rows", () => {
    const database = openDatabase(join(root, "bossmode.db"));
    db = database;
    applyStorageMigrations(database, beforeMmScope());
    // Seed data through the old schema: a room scope, a dm scope, messages + cursors.
    database.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES('room-1','room','room-1',NULL),('dm:mem_a','dm',NULL,'mem_a')");
    database.run("INSERT INTO scope_sequences(scope_id,next_seq) VALUES('room-1',2),('dm:mem_a',2)");
    database.run("INSERT INTO messages(scope_id,id,seq,ts,sender,origin,content,content_lower,extra_json) VALUES('room-1','m1',1,1,'user','user','hello','hello','{\"fields\":{},\"presentLists\":[]}'),('dm:mem_a','m2',1,1,'user','user','hi','hi','{\"fields\":{},\"presentLists\":[]}')");
    database.run("INSERT INTO read_cursors(scope_id,kind,actor_key,value,updated_at) VALUES('dm:mem_a','member','mem_a',NULL,1)");

    applyStorageMigrations(database, coreStorageMigrations); // applies core-mm-scope-v1

    // Existing rows survive verbatim.
    expect(database.all("SELECT id,kind,room_id,member_id FROM scopes ORDER BY id")).toEqual([
      { id: "dm:mem_a", kind: "dm", room_id: null, member_id: "mem_a" },
      { id: "room-1", kind: "room", room_id: "room-1", member_id: null },
    ]);
    expect(database.all("SELECT id FROM messages ORDER BY id")).toEqual([{ id: "m1" }, { id: "m2" }]);

    // Child FK clauses still reference `scopes` (no scopes_old rewrite anywhere).
    const childSql = database.all<{ name: string; sql: string }>("SELECT name,sql FROM sqlite_master WHERE type='table' AND sql LIKE '%REFERENCES scopes(%'").map((r) => r.name);
    expect(childSql.sort()).toEqual(expect.arrayContaining(["messages", "scope_sequences", "read_cursors", "message_archive_entries"]));
    expect(database.all("SELECT name FROM sqlite_master WHERE sql LIKE '%scopes_old%'")).toEqual([]);

    // New kind is accepted; the mm shape is enforced.
    database.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES('mm:mem_a-mem_b','mm',NULL,'mem_a|mem_b')");
    expect(database.get<{ n: number }>("SELECT COUNT(*) n FROM scopes WHERE kind='mm'")!.n).toBe(1);
    expect(() => database.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES('mm:bad','mm','mm:bad',NULL)")).toThrow();
    expect(() => database.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES('mm:bad2','mm',NULL,NULL)")).toThrow();

    // FKs are still enforced after the swap.
    expect(() => database.run("INSERT INTO messages(scope_id,id,seq,ts,sender,origin,content,content_lower,extra_json) VALUES('nope','m3',1,1,'user','user','x','x','{\"fields\":{},\"presentLists\":[]}')")).toThrow();
    database.run("INSERT INTO messages(scope_id,id,seq,ts,sender,origin,content,content_lower,extra_json) VALUES('mm:mem_a-mem_b','m4',1,1,'mem_a','member','private','private','{\"fields\":{},\"presentLists\":[]}')");

    expect(database.get("PRAGMA foreign_key_check")).toBeUndefined();
    expect(database.get<{ integrity_check: string }>("PRAGMA integrity_check").integrity_check).toBe("ok");

    // Re-application is a no-op.
    applyStorageMigrations(database, coreStorageMigrations);
    expect(database.get<{ n: number }>("SELECT COUNT(*) n FROM scopes")!.n).toBe(3);
  });
});
