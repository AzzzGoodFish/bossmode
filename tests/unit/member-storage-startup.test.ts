import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
let root: string;
let restore: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bm-member-startup-"));
  restore = process.env.BOSSMODE_DIR; process.env.BOSSMODE_DIR = root;
  vi.resetModules();
});
afterEach(async () => {
  const { openDb } = await import("../../src/workspace/db/sqlite.js");
  openDb().close();
  if (restore === undefined) delete process.env.BOSSMODE_DIR; else process.env.BOSSMODE_DIR = restore;
  rmSync(root, { recursive: true, force: true });
});
describe("mandatory member storage startup", () => {
  it("initializes fresh DB and validates new member directories", async () => {
    const { ensureMemberStorageReady } = await import("../../src/workspace/member-storage-startup.js");
    ensureMemberStorageReady();
    const { createMember } = await import("../../src/workspace/member-registry.js");
    createMember({ name: "fresh" });
    expect(() => ensureMemberStorageReady()).not.toThrow();
  });
  it("refuses legacy records before opening an empty registry", async () => {
    const dir = join(root, "members", "mem_old"); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "member.json"), "{}");
    const { ensureMemberStorageReady } = await import("../../src/workspace/member-storage-startup.js");
    expect(() => ensureMemberStorageReady()).toThrow(/offline migration/);
  });
  it("refuses missing authoritative DB and incomplete conversion", async () => {
    mkdirSync(join(root, "migrations"));
    const journal = join(root, "migrations", "member-storage-v1.json");
    writeFileSync(journal, JSON.stringify({ status: "prepared" }));
    const { ensureMemberStorageReady } = await import("../../src/workspace/member-storage-startup.js");
    expect(() => ensureMemberStorageReady()).toThrow(/incomplete/);
    writeFileSync(journal, JSON.stringify({ status: "done" }));
    expect(() => ensureMemberStorageReady()).toThrow(/database is missing/);
  });
  it("refuses a database member whose assets disappeared during an interrupted fire", async () => {
    const { createMember } = await import("../../src/workspace/member-registry.js");
    const member = createMember({ name: "interrupted" });
    rmSync(join(root, "members", member.id), { recursive: true });
    const { ensureMemberStorageReady } = await import("../../src/workspace/member-storage-startup.js");
    expect(() => ensureMemberStorageReady()).toThrow(/no asset directory/);
  });
  it("refuses orphaned asset directories rather than hiding a lost identity", async () => {
    const { openDb } = await import("../../src/workspace/db/sqlite.js"); openDb();
    mkdirSync(join(root, "members", "mem_orphan"), { recursive: true });
    const { ensureMemberStorageReady } = await import("../../src/workspace/member-storage-startup.js");
    expect(() => ensureMemberStorageReady()).toThrow(/no database identity/);
  });
});
