/**
 * Background retirement (fish #19454/#19455): the retirement migration drops
 * `background_tasks` and its terminal-notification outbox rows; the session
 * cleanup removes member background-task directories once, idempotently.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, applyStorageMigrations, type Database } from "../../src/data/database.js";
import { coreStorageMigrations } from "../../src/data/schema.js";
import { cleanupRetiredBackgroundSessionFiles } from "../../src/app/upgrade/retirements.js";

let root: string;
let db: Database | undefined;
const withoutBackgroundRetirement = () => coreStorageMigrations.slice(
  0, coreStorageMigrations.findIndex((m) => m.id === "core-background-retirement-v1")); // pre-retirement schema: everything from this step on lands later

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "bg-retire-")); });
afterEach(() => { db?.close(); db = undefined; rmSync(root, { recursive: true, force: true }); });

function seed(database: Database): void {
  database.run("INSERT INTO scopes(id,kind,room_id,member_id) VALUES('r1','room','r1',NULL),('dm:mem_m1','dm',NULL,'mem_m1')");
  database.run("INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES('mem_m1','One','one','general','{}',1,1)");
  database.run("INSERT INTO rooms(id,name,created_at,docs_path,leader_member_id,leader_global_member_id,roster_kind,has_local_records,has_rule_docs,has_overrides) VALUES('r1','R','0',NULL,NULL,NULL,'names',0,0,0)");
  database.run("INSERT INTO background_tasks(task_id,member_id,scope_id,kind,session_mode,prompt,status,started_at,ended_at,result,session_dir) VALUES('bgt-00000000-0000-4000-8000-000000000001','mem_m1','dm:mem_m1','generic','new','work','done','2026-09-09T00:00:00Z','2026-09-09T00:00:01Z','answer','members/mem_m1/background-tasks/2026-09-09/bgt-00000000-0000-4000-8000-000000000001')");
  database.run("INSERT INTO outbox(kind,scope_id,dedupe_key,payload_json,created_at) VALUES('background.terminal','dm:mem_m1','background.terminal:bgt-00000000-0000-4000-8000-000000000001','{}',1)");
}

describe("core-background-retirement-v1", () => {
  it("drops the table and clears terminal outbox rows while main data stays intact", () => {
    const database = openDatabase(join(root, "bossmode.db"));
    db = database;
    applyStorageMigrations(database, withoutBackgroundRetirement());
    seed(database);
    const members = database.all("SELECT * FROM members ORDER BY id");
    const scopes = database.all("SELECT * FROM scopes ORDER BY id");
    applyStorageMigrations(database, coreStorageMigrations);
    applyStorageMigrations(database, coreStorageMigrations);
    expect(database.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_tasks'")).toBeUndefined();
    expect(database.all("SELECT * FROM outbox WHERE kind='background.terminal'")).toEqual([]);
    expect(database.all("SELECT * FROM members ORDER BY id")).toEqual(members);
    expect(database.all("SELECT * FROM scopes ORDER BY id")).toEqual(scopes);
    expect(database.get("PRAGMA foreign_key_check")).toBeUndefined();
    expect(database.get<{integrity_check:string}>("PRAGMA integrity_check").integrity_check).toBe("ok");
  });

  it("rolls back with no half-delete when the outbox cleanup fails", () => {
    const database = openDatabase(join(root, "bossmode.db"));
    db = database;
    applyStorageMigrations(database, withoutBackgroundRetirement());
    seed(database);
    database.exec("CREATE TRIGGER reject_bg_outbox BEFORE DELETE ON outbox BEGIN SELECT RAISE(ABORT,'injected'); END");
    expect(() => applyStorageMigrations(database, coreStorageMigrations)).toThrow(/injected/);
    expect(database.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_tasks'")).toBeDefined();
    expect(database.all("SELECT * FROM outbox WHERE kind='background.terminal'")).toHaveLength(1);
    database.exec("DROP TRIGGER reject_bg_outbox");
    applyStorageMigrations(database, coreStorageMigrations);
    expect(database.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background_tasks'")).toBeUndefined();
  });
});

describe("background session cleanup", () => {
  it("removes member background-task directories once and leaves other trees untouched", () => {
    const database = openDatabase(join(root, "bossmode.db"));
    db = database;
    applyStorageMigrations(database, coreStorageMigrations);
    const taskDir = join(root, "members", "mem_m1", "background-tasks", "2026-09-09", "bgt-x");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "session.jsonl"), "sdk bytes");
    const keep = join(root, "members", "mem_m1", "sessions", "2026-09-09", "rooms", "r1");
    mkdirSync(keep, { recursive: true });
    writeFileSync(join(keep, "s.jsonl"), "keep");
    cleanupRetiredBackgroundSessionFiles(root, database);
    expect(existsSync(join(root, "members", "mem_m1", "background-tasks"))).toBe(false);
    expect(existsSync(keep)).toBe(true);
    expect(database.get("SELECT 1 FROM storage_meta WHERE key='core-background-session-cleanup-v1'")).toBeDefined();
    cleanupRetiredBackgroundSessionFiles(root, database);
    expect(existsSync(keep)).toBe(true);
  });
});
