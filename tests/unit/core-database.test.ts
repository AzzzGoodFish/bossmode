import { getMigration } from "../helpers/schema.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyStorageMigrations, bindDatabase, getDatabase, openDatabase, sqliteBoolean, type Database } from "../../src/data/database.js";
const baseStorageMigration = getMigration("core-base-v1");

let root: string;
let databases: Database[];
function open(): Database {
  const db = openDatabase(join(root, `db-${databases.length}.sqlite`));
  databases.push(db);
  return db;
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bm-core-db-unit-")); databases = []; });
afterEach(() => { for (const db of databases) db.close(); rmSync(root, { recursive: true, force: true }); });

describe("explicit core database lifecycle", () => {
  it("encodes optional SQL booleans without opening or binding a database", () => {
    expect(sqliteBoolean(undefined)).toBeNull();
    expect(sqliteBoolean(false)).toBe(0);
    expect(sqliteBoolean(true)).toBe(1);
    expect(() => getDatabase()).toThrow("not initialized");
  });
  it("does not open a database when an uninitialized consumer asks for one", () => {
    expect(() => getDatabase()).toThrow("bootstrap");
    expect(existsSync(join(root, "bossmode.db"))).toBe(false);
  });
  it("requires an absolute path and an explicit binding", () => {
    expect(() => openDatabase("relative.sqlite")).toThrow("absolute");
    const db = open();
    expect(() => getDatabase()).toThrow("not initialized");
    bindDatabase(db);
    expect(getDatabase()).toBe(db);
    expect(() => bindDatabase(open())).toThrow("different");
    db.close();
    expect(() => getDatabase()).toThrow("not initialized");
    expect(() => bindDatabase(db)).toThrow("closed");
  });
  it("uses durable WAL, foreign keys and private database/sidecar files", () => {
    const db = open();
    db.exec("CREATE TABLE sidecar_probe (id INTEGER)");
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode).toBe("wal");
    expect(db.get<{ synchronous: number }>("PRAGMA synchronous")?.synchronous).toBe(2);
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
    for (const suffix of ["", "-wal", "-shm"]) {
      expect(statSync(db.path + suffix).mode & 0o777).toBe(0o600);
    }
  });
});

describe("transaction boundaries", () => {
  function ready() { const db = open(); db.exec("CREATE TABLE records (id INTEGER PRIMARY KEY)"); return db; }
  it("commits a value and rolls back a failing callback", () => {
    const db = ready();
    expect(db.transaction(tx => { tx.run("INSERT INTO records VALUES (?)", 1); return "saved"; })).toBe("saved");
    expect(() => db.transaction(tx => { tx.run("INSERT INTO records VALUES (?)", 2); throw new Error("failure"); })).toThrow("failure");
    expect(db.all("SELECT * FROM records")).toEqual([{ id: 1 }]);
  });
  it("rolls back inner savepoint without committing the outer transaction", () => {
    const db = ready();
    expect(() => db.transaction(tx => {
      tx.run("INSERT INTO records VALUES (1)");
      expect(() => tx.transaction(inner => { inner.run("INSERT INTO records VALUES (2)"); throw new Error("inner"); })).toThrow("inner");
      expect(tx.all("SELECT * FROM records")).toEqual([{ id: 1 }]);
      tx.transaction(inner => inner.run("INSERT INTO records VALUES (3)"));
      throw new Error("outer");
    })).toThrow("outer");
    expect(db.all("SELECT * FROM records")).toEqual([]);
  });
  it("refuses writes after SQLite aborts the entire transaction inside a savepoint", () => {
    const db = ready(); db.run("INSERT INTO records VALUES (99)");
    expect(() => db.transaction(tx => {
      tx.run("INSERT INTO records VALUES (1)");
      expect(() => tx.transaction(inner => inner.run("INSERT OR ROLLBACK INTO records VALUES (1)"))).toThrow();
      expect(() => tx.run("INSERT INTO records VALUES (2)")).toThrow("aborted");
    })).toThrow("aborted");
    expect(db.all("SELECT * FROM records")).toEqual([{ id: 99 }]);
    db.transaction(tx => tx.run("INSERT INTO records VALUES (3)"));
    expect(db.all("SELECT * FROM records ORDER BY id")).toEqual([{ id: 3 }, { id: 99 }]);
  });
  it("never binds an expiring transaction handle as the process context", () => {
    const db = ready();
    db.transaction(tx => expect(() => bindDatabase(tx)).toThrow("transaction-scoped"));
    expect(() => getDatabase()).toThrow("not initialized");
    bindDatabase(db); expect(getDatabase()).toBe(db);
    db.close(); expect(() => getDatabase()).toThrow("not initialized");
  });
  it("rejects async callbacks before they execute", async () => {
    const db = ready(); let entered = false;
    expect(() => db.transaction(async tx => { entered = true; tx.run("INSERT INTO records VALUES (1)"); })).toThrow("synchronous");
    await Promise.resolve();
    expect(entered).toBe(false); expect(db.all("SELECT * FROM records")).toEqual([]);
  });
  it("rolls back thenables and expires the transaction handle before delayed work", async () => {
    const db = ready(); let pending!: Promise<void>; let failure: unknown;
    expect(() => db.transaction(tx => {
      tx.run("INSERT INTO records VALUES (1)");
      pending = Promise.resolve().then(() => { try { tx.run("INSERT INTO records VALUES (2)"); } catch (e) { failure = e; } });
      return pending;
    })).toThrow("promises");
    await pending;
    expect(String(failure)).toContain("expired");
    expect(db.all("SELECT * FROM records")).toEqual([]);
  });
  it("invalidates escaped transaction methods after successful commit", () => {
    const db = ready(); const run = db.transaction(tx => tx.run);
    expect(() => run("INSERT INTO records VALUES (1)")).toThrow("expired");
  });
});

describe("versioned schemas and shared scope keys", () => {
  it("is idempotent and rejects changed applied SQL", () => {
    const db = open(); applyStorageMigrations(db, [baseStorageMigration]);
    applyStorageMigrations(db, [baseStorageMigration]);
    expect(db.all("SELECT id FROM storage_schema_versions")).toEqual([{ id: "core-base-v1" }]);
    expect(() => applyStorageMigrations(db, [{ ...baseStorageMigration, sql: baseStorageMigration.sql + "\n" }])).toThrow("changed");
  });
  it("rejects duplicate migration IDs before performing schema writes", () => {
    const db = open();
    expect(() => applyStorageMigrations(db, [baseStorageMigration, baseStorageMigration])).toThrow("Duplicate");
    expect(db.get("SELECT name FROM sqlite_master WHERE name='storage_schema_versions'")).toBeUndefined();
  });
  it("does not mark or retain partial schema from a failed step", () => {
    const db = open();
    expect(() => applyStorageMigrations(db, [{ id: "broken", sql: "CREATE TABLE partial (id TEXT); INSERT INTO missing VALUES (1)" }])).toThrow();
    expect(db.get("SELECT name FROM sqlite_master WHERE name='partial'")).toBeUndefined();
    expect(db.all("SELECT * FROM storage_schema_versions")).toEqual([]);
  });
  it("enforces scope ownership shape and reference constraints", () => {
    const db = open(); applyStorageMigrations(db, [baseStorageMigration]);
    expect(() => db.run("INSERT INTO storage_meta VALUES (NULL, 'bad')")).toThrow();
    expect(() => db.run("INSERT INTO scopes VALUES (NULL, 'room', 'room-one', NULL)")).toThrow();
    expect(() => db.run("INSERT INTO scope_sequences VALUES (NULL, 1)")).toThrow();
    expect(() => db.run("INSERT INTO storage_schema_versions VALUES (NULL, 'bad', 1)")).toThrow();
    db.run("INSERT INTO scopes VALUES (?, ?, ?, ?)", "room-one", "room", "room-one", null);
    db.run("INSERT INTO scopes VALUES (?, ?, ?, ?)", "topic:t", "topic", "room-one", null);
    db.run("INSERT INTO scopes VALUES (?, ?, ?, ?)", "dm:mem_one", "dm", null, "mem_one");
    expect(() => db.run("INSERT INTO scopes VALUES (?, ?, ?, ?)", "bad", "dm", "room-one", null)).toThrow();
    expect(() => db.run("INSERT INTO scope_sequences VALUES ('missing', 1)")).toThrow();
    db.run("INSERT INTO read_cursors VALUES (?, ?, ?, ?, ?)", "room-one", "member", "mem_one", "message-one", 1);
    expect(() => db.run("INSERT INTO read_cursors VALUES (?, ?, ?, ?, ?)", "room-one", "member", "mem_one", "message-two", 2)).toThrow();
  });
});
