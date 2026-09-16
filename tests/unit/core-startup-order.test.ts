import { getDefaultConfig } from "../../src/config/settings.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Database } from "../../src/data/database.js";
import { prepareCoreStorage } from "../../src/app/upgrade/run.js";

import { shortIdJournalPath, writeShortIdJournal } from "../../src/app/upgrade/ids.js";

const fault = vi.hoisted(() => ({ ids: false }));
vi.mock("../../src/app/upgrade/ids.js", async original => {
  const actual = await original<typeof import("../../src/app/upgrade/ids.js")>();
  return { ...actual, migrateShortIds: (...args: Parameters<typeof actual.migrateShortIds>) => {
    if (fault.ids) throw new Error("injected required ID migration failure");
    return actual.migrateShortIds(...args);
  } };
});
let root: string;
let database: Database | undefined;
beforeEach(() => {
  fault.ids = false;
  root = process.env.BOSSMODE_DIR!;
  mkdirSync(root, { recursive: true });
});
afterEach(() => {
  database?.close(); database = undefined;
  rmSync(root, { recursive: true, force: true });
});
const oldRoomId = "22222222-2222-4222-8222-222222222222";
function put(path: string, body: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
}
function seed(): void {
  put("config.json", JSON.stringify({ ...getDefaultConfig(), auth: { username: "operator", passwordHash: "fixture-hash" } }));
  put(`rooms/${oldRoomId}/room.json`, JSON.stringify({ id: oldRoomId, name: "Retained room", members: [], globalMemberIds: [], createdAt: 1 }));
  put(`rooms/${oldRoomId}/memory/room-principles.md`, "Retained room description\n");
}

it("activation sees completed ID and description upgrades, never intermediate records", async () => {
  seed();
  let observed: { id: string; description: string | null } | undefined;
  const result = await prepareCoreStorage({ root, activate: async db => {
    database = db;
    observed = db.get<{ id: string; description: string | null }>("SELECT id,description FROM rooms");
  } });
  database = result.db;
  expect(observed).toMatchObject({ id: expect.stringMatching(/^rm_[a-z0-9]{10}$/), description: "Retained room description" });
  expect(existsSync(join(root, "rooms", oldRoomId))).toBe(false);
});

it("a competing startup lease prevents short-ID journal replay and all source changes", async () => {
  const source = "rooms/old-folder", target = "rooms/new-folder";
  put(`${source}/body.md`, "unchanged");
  writeShortIdJournal(root, [{ from: source, to: target }]);
  const journal = readFileSync(shortIdJournalPath(root));
  mkdirSync(join(root, "upgrades"), { recursive: true });
  const lease = new DatabaseSync(join(root, "upgrades/lease.sqlite"));
  lease.exec("BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS lease (id INTEGER)");
  try {
    await expect(prepareCoreStorage({ root })).rejects.toThrow("Cannot acquire startup upgrade lease");
    expect(existsSync(join(root, source, "body.md"))).toBe(true);
    expect(existsSync(join(root, target))).toBe(false);
    expect(readFileSync(shortIdJournalPath(root))).toEqual(journal);
  } finally { lease.exec("ROLLBACK"); lease.close(); }
});

it("a required post-cutover migration failure does not activate consumers", async () => {
  seed();
  fault.ids = true;
  let activated = false;
  await expect(prepareCoreStorage({ root, activate: async db => {
    database = db;
    activated = true;
  } })).rejects.toThrow("injected required ID migration failure");
  database?.close(); database = undefined;
  expect(activated).toBe(false);
  expect(existsSync(join(root, "bossmode.db"))).toBe(true);
  fault.ids = false;
  const result = await prepareCoreStorage({ root });
  database = result.db;
  expect(database.get("SELECT id,description FROM rooms")).toMatchObject({
    id: expect.stringMatching(/^rm_[a-z0-9]{10}$/), description: "Retained room description",
  });
});
