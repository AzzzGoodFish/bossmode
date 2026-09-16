import { afterEach, beforeEach, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backupDatabase, checkpointDatabase, getDatabase, inspectDatabase, lockDatabase, openDatabase, type Database } from "../../src/data/database.js";

let root: string;
let db: Database | undefined;
beforeEach(() => { root = process.env.BOSSMODE_DIR!; mkdirSync(root, { recursive: true }); });
afterEach(() => { db?.close(); db = undefined; rmSync(root, { recursive: true, force: true }); });
function seed(): string {
  const path = join(root, "source.sqlite");
  db = openDatabase(path);
  db.exec("CREATE TABLE sample(value INTEGER); INSERT INTO sample VALUES(1)");
  return path;
}

it("read-only inspection neither creates storage nor binds a consumer context", () => {
  const missing = join(root, "absent/source.sqlite");
  expect(() => inspectDatabase(missing, read => read.get("SELECT 1"))).toThrow();
  expect(existsSync(join(root, "absent"))).toBe(false);
  const path = seed();
  expect(inspectDatabase(path, read => read.get("SELECT value FROM sample"))).toEqual({ value: 1 });
  expect(() => getDatabase()).toThrow("bootstrap");
});

it("inspection rejects writes and asynchronous callbacks without changing data", () => {
  const path = seed();
  expect(() => inspectDatabase(path, read => (read as Database).run("UPDATE sample SET value=2"))).toThrow();
  expect(() => inspectDatabase(path, async () => 1)).toThrow("inspections must be synchronous");
  expect(db!.get("SELECT value FROM sample")).toEqual({ value: 1 });
});

it.each(["exclusive", "immediate"] as const)("%s locking rejects a competitor and can be released safely", mode => {
  const path = join(root, "lock.sqlite");
  const release = lockDatabase(path, mode);
  try { expect(() => lockDatabase(path, mode)).toThrow(); }
  finally { release(); release(); }
  lockDatabase(path, mode)();
});

it("SQLite backups retain the committed snapshot while another connection holds a write transaction", async () => {
  const source = seed();
  const copy = join(root, "snapshot.sqlite");
  db!.exec("BEGIN IMMEDIATE; UPDATE sample SET value=2");
  try {
    await backupDatabase(source, copy);
    expect(inspectDatabase(copy, read => read.get("SELECT value FROM sample"))).toEqual({ value: 1 });
  } finally { db!.exec("ROLLBACK"); }
  db!.close(); db = undefined;
  expect(checkpointDatabase(source)).toMatchObject({ busy: 0 });
});
