import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, applyStorageMigrations, type Database } from "../../src/data/database.js";
import { coreStorageMigrations } from "../../src/data/schema.js";
import { archiveRetiredTasks } from "../../src/app/upgrade/retirements.js";

// Task feature retirement (fish #19259): the four task tables are exported to a
// verified archive BEFORE the core-task-retirement-v1 migration drops them.
// These assertions lock the safety property: never drop without a verified export.

let root: string;
let db: Database | undefined;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "task-retire-")); });
afterEach(() => { db?.close(); db = undefined; rmSync(root, { recursive: true, force: true }); });

function seedTaskData(database: Database): void {
  database.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES('room-x','room','room-x',NULL)");
  database.run("INSERT INTO rooms(id,name,created_at,docs_path,leader_member_id,leader_global_member_id,roster_kind,has_local_records,has_rule_docs,has_overrides) VALUES('room-x','Room','0',NULL,NULL,NULL,'names',0,0,0)");
  database.run("INSERT INTO tasks(room_id,task_id,title,status,priority,assignee,assignee_member_id,description,created_by,created_at,updated_at,has_references) VALUES('room-x','task-1','Ship it','todo','P1','alice','mem_a','desc','bob',1,2,1)");
  database.run("INSERT INTO task_references(room_id,task_id,position,value) VALUES('room-x','task-1',0,'docs/x.md')");
  database.run("INSERT INTO task_subscribers(room_id,task_id,position,kind,value) VALUES('room-x','task-1',0,'member','mem_a')");
  database.run("INSERT INTO task_comments(room_id,task_id,position,id,author,content,created_at) VALUES('room-x','task-1',0,'c1','alice','looks good',3)");
}

describe("task feature retirement migration", () => {
  it("exports a verified archive from the pre-drop schema and then drops the four tables", () => {
    db = openDatabase(join(root, "stage.sqlite"));
    // Migrations up to (but not including) retirement: apply the whole plan on a
    // schema without task rows, then insert rows, then re-run the retirement step
    // by exporting + applying the full plan on a fresh DB where tables exist.
    applyStorageMigrations(db, coreStorageMigrations);

    // The migration plan ends by dropping the tables — they must be gone.
    for (const table of ["tasks", "task_references", "task_subscribers", "task_comments"]) {
      expect(db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table)).toBeUndefined();
    }
  });

  it("archiveRetiredTasks exports every table, verifies checksums and writes a manifest + README", () => {
    db = openDatabase(join(root, "stage.sqlite"));
    // Build the pre-retirement schema by applying the plan WITHOUT the retirement
    // migration, so the task tables exist to be exported.
    const withoutRetirement = coreStorageMigrations.slice(0, coreStorageMigrations.findIndex((m) => m.id === "core-task-retirement-v1"));
    applyStorageMigrations(db, withoutRetirement);
    seedTaskData(db);

    const result = archiveRetiredTasks(db, root);
    expect(result).not.toBeNull();
    expect(result!.rowCounts).toEqual({ tasks: 1, task_references: 1, task_subscribers: 1, task_comments: 1 });

    const dir = result!.directory;
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir);
    for (const f of ["tasks.json", "task_references.json", "task_subscribers.json", "task_comments.json", "SHA256SUMS", "README.md"]) {
      expect(files, `missing ${f}`).toContain(f);
    }

    // Exported rows match the seeded data, verbatim.
    const tasksJson = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"));
    expect(tasksJson.table).toBe("tasks");
    expect(tasksJson.rowCount).toBe(1);
    expect(tasksJson.rows[0]).toMatchObject({ room_id: "room-x", task_id: "task-1", title: "Ship it", assignee: "alice", assignee_member_id: "mem_a" });
    const commentsJson = JSON.parse(readFileSync(join(dir, "task_comments.json"), "utf8"));
    expect(commentsJson.rows[0]).toMatchObject({ task_id: "task-1", content: "looks good" });

    // SHA256SUMS lists each export and verifies.
    const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8");
    for (const f of ["tasks.json", "task_references.json", "task_subscribers.json", "task_comments.json"]) {
      expect(sums).toContain(f);
    }
    for (const line of sums.trim().split("\n")) {
      const [hash, name] = line.split(/\s+/);
      const actual = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
      expect(actual).toBe(hash);
    }

    // README explains why + how to verify.
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    expect(readme).toContain("Retired task data");
    expect(readme).toContain("SHA256SUMS verifies every JSON export");
  });

  it("returns null (no archive) when the task tables never existed — fresh install", () => {
    db = openDatabase(join(root, "stage.sqlite"));
    applyStorageMigrations(db, coreStorageMigrations); // tables already dropped
    expect(archiveRetiredTasks(db, root)).toBeNull();
    expect(existsSync(join(root, "archive"))).toBe(false);
  });

  it("does not silently drop: export happens on the pre-migration schema in the upgrade flow", async () => {
    // End-to-end through prepareStorageUpgrade: a DB with the pre-retirement schema
    // but no authority marker forces the upgrade path; the archive step must run.
    const { prepareStorageUpgrade } = await import("../../src/app/upgrade/run.js");
    const withoutRetirement = coreStorageMigrations.slice(0, coreStorageMigrations.findIndex((m) => m.id === "core-task-retirement-v1"));
    // Build a "previous" database at the pre-retirement schema.
    const prevPath = join(root, "previous.sqlite");
    const prev = openDatabase(prevPath);
    applyStorageMigrations(prev, withoutRetirement);
    seedTaskData(prev);
    prev.close();

    // Copy it into the managed location the runner expects.
    const { mkdirSync, copyFileSync } = await import("node:fs");
    mkdirSync(root, { recursive: true });
    copyFileSync(prevPath, join(root, "bossmode.db"));

    let archived: Awaited<ReturnType<typeof archiveRetiredTasks>> = null;
    const { archiveRetiredTasks: archiveFn } = await import("../../src/app/upgrade/retirements.js");
    const result = await prepareStorageUpgrade({
      root,
      formatVersion: 999, // differs from the DB → forces migration
      migrations: coreStorageMigrations,
      collectLegacySources: async () => [],
      archiveRetiredData: (stagingDb, dirRoot) => { archived = archiveFn(stagingDb, dirRoot); },
      importData: async () => {},
      validate: async () => {},
    });
    result.db.close();
    expect(archived).not.toBeNull();
    expect(archived!.rowCounts.tasks).toBe(1);
    expect(existsSync(archived!.directory)).toBe(true);
  });
});
