import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, applyStorageMigrations, type Database } from "../../src/data/database.js";
import { coreStorageMigrations } from "../../src/data/migrations.js";
import { archiveRetiredScopeSessions } from "../../src/data/migrations/member-session-archive.js";

// Member-centric sessions (① A2/A3, fish #20025): the per-scope session layout is
// retired. Its files are parked under `members/<id>/archive/sessions/` so nothing is
// lost; `sessions/<day>/main/` is the live layout and must never be touched.

vi.mock("../../src/kernel/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let root: string;
let db: Database | undefined;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "member-session-archive-")); });
afterEach(() => { db?.close(); db = undefined; rmSync(root, { recursive: true, force: true }); });

const MEMBER = "mem_a";
const sessionsOf = (member = MEMBER) => join(root, "members", member, "sessions");
const archiveOf = (member = MEMBER) => join(root, "members", member, "archive", "sessions");
const flag = () => db!.get<{ value: string }>("SELECT value FROM storage_meta WHERE key='core-member-session-archive-v1'");

function open(): Database {
  db = openDatabase(join(root, "bossmode.db"));
  applyStorageMigrations(db, coreStorageMigrations);
  return db;
}

it("archives retired scope directories and the legacy reference file, leaving main/ untouched", () => {
  open();
  const day = "2026-09-13";
  mkdirSync(join(sessionsOf(), day, "rooms", "r1"), { recursive: true });
  writeFileSync(join(sessionsOf(), day, "rooms", "r1", "room.jsonl"), "room");
  mkdirSync(join(sessionsOf(), day, "dm"), { recursive: true });
  writeFileSync(join(sessionsOf(), day, "dm", "dm.jsonl"), "dm");
  mkdirSync(join(sessionsOf(), day, "main"), { recursive: true });
  writeFileSync(join(sessionsOf(), day, "main", "member.jsonl"), "member");
  writeFileSync(join(sessionsOf(), "current.json"), "{}");

  archiveRetiredScopeSessions(root, db!);

  expect(existsSync(join(sessionsOf(), day, "rooms"))).toBe(false);
  expect(existsSync(join(sessionsOf(), day, "dm"))).toBe(false);
  expect(existsSync(join(sessionsOf(), "current.json"))).toBe(false);
  expect(existsSync(join(sessionsOf(), day, "main", "member.jsonl"))).toBe(true);
  expect(readFileSync(join(archiveOf(), day, "rooms", "r1", "room.jsonl"), "utf8")).toBe("room");
  expect(readFileSync(join(archiveOf(), day, "dm", "dm.jsonl"), "utf8")).toBe("dm");
  expect(readFileSync(join(archiveOf(), "current.json"), "utf8")).toBe("{}");
  expect(JSON.parse(flag()!.value)).toMatchObject({ movedEntries: 3, skippedConflicts: 0 });
});

it("never overwrites an archive entry: the conflict is counted and the source stays", () => {
  open();
  const day = "2026-09-13";
  mkdirSync(join(archiveOf(), day, "rooms", "r1"), { recursive: true });
  writeFileSync(join(archiveOf(), day, "rooms", "r1", "room.jsonl"), "already archived");
  mkdirSync(join(sessionsOf(), day, "rooms", "r1"), { recursive: true });
  writeFileSync(join(sessionsOf(), day, "rooms", "r1", "room.jsonl"), "room");

  archiveRetiredScopeSessions(root, db!);

  expect(readFileSync(join(archiveOf(), day, "rooms", "r1", "room.jsonl"), "utf8")).toBe("already archived");
  expect(readFileSync(join(sessionsOf(), day, "rooms", "r1", "room.jsonl"), "utf8")).toBe("room");
  expect(JSON.parse(flag()!.value)).toMatchObject({ movedEntries: 0, skippedConflicts: 1 });
});

it("is a one-shot: files arriving after the flag are deliberately left in place", () => {
  open();
  archiveRetiredScopeSessions(root, db!);
  expect(flag()).toBeDefined();

  const late = join(sessionsOf(), "2026-09-14", "rooms", "r2");
  mkdirSync(late, { recursive: true });
  writeFileSync(join(late, "late.jsonl"), "late");
  archiveRetiredScopeSessions(root, db!);
  expect(existsSync(join(late, "late.jsonl"))).toBe(true);
});

it("never follows symlinks and keeps the flag unset when the scan fails so a later startup retries", () => {
  open();
  // A file where a member's sessions directory is expected makes the scan throw.
  mkdirSync(join(root, "members", "mem_b"), { recursive: true });
  writeFileSync(join(root, "members", "mem_b", "sessions"), "not a directory");
  archiveRetiredScopeSessions(root, db!);
  expect(flag()).toBeUndefined();

  rmSync(join(root, "members", "mem_b", "sessions"));
  mkdirSync(join(sessionsOf("mem_b"), "2026-09-15", "dm"), { recursive: true });
  writeFileSync(join(sessionsOf("mem_b"), "2026-09-15", "dm", "dm.jsonl"), "dm");
  archiveRetiredScopeSessions(root, db!);
  expect(flag()).toBeDefined();
  expect(existsSync(join(sessionsOf("mem_b"), "2026-09-15", "dm"))).toBe(false);
  expect(readFileSync(join(archiveOf("mem_b"), "2026-09-15", "dm", "dm.jsonl"), "utf8")).toBe("dm");
});
