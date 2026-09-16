import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
}));

vi.mock("../../src/files/layout.js", () => ({
  roomDir: (roomId: string) => join(dir, "rooms", roomId),
  getRoomsDir: () => join(dir, "rooms"),
}));

describe("memory-storage-reorg-v1 migration", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-storagereorg-test-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedLegacy(roomId: string) {
    const pDir = join(dir, "rooms", roomId, "prompt-supplements");
    const mDir = join(dir, "rooms", roomId, "mainlines");
    mkdirSync(join(pDir, "members"), { recursive: true });
    mkdirSync(join(mDir, "members"), { recursive: true });
    writeFileSync(join(pDir, "room.md"), "Room rules.");
    writeFileSync(join(pDir, "meta.json"), JSON.stringify({ room: { revision: 1 } }));
    writeFileSync(join(pDir, "history.jsonl"), '{"ts":1}\n');
    writeFileSync(join(pDir, "members", "qa.md"), "QA principles.");
    writeFileSync(join(mDir, "meta.json"), JSON.stringify({ members: { qa: { revision: 1 } } }));
    writeFileSync(join(mDir, "history.jsonl"), '{"ts":2}\n');
    writeFileSync(join(mDir, "members", "qa.md"), "## Focus\n\nQA focus.\n");
  }

  it("copies room + member principles and member mainline into the new memory/ layout", async () => {
    const migration = await import("../../src/workspace/memory-storage-reorg-migration.js");
    seedLegacy("room1");

    migration.runMemoryStorageReorgMigration();

    const memDir = join(dir, "rooms", "room1", "memory");
    expect(readFileSync(join(memDir, "room-principles.md"), "utf-8")).toBe("Room rules.");
    expect(readFileSync(join(memDir, "principles-meta.json"), "utf-8")).toContain("revision");
    expect(readFileSync(join(memDir, "principles-history.jsonl"), "utf-8")).toContain('"ts":1');
    expect(readFileSync(join(memDir, "members", "qa", "principles.md"), "utf-8")).toBe("QA principles.");
    expect(readFileSync(join(memDir, "mainline-meta.json"), "utf-8")).toContain("revision");
    expect(readFileSync(join(memDir, "mainline-history.jsonl"), "utf-8")).toContain('"ts":2');
    expect(readFileSync(join(memDir, "members", "qa", "mainline.md"), "utf-8")).toBe("## Focus\n\nQA focus.\n");

    // Legacy files are left in place (copy, not move)
    expect(existsSync(join(dir, "rooms", "room1", "prompt-supplements", "room.md"))).toBe(true);
  });

  it("is idempotent: a second run makes no changes", async () => {
    const migration = await import("../../src/workspace/memory-storage-reorg-migration.js");
    seedLegacy("room1");
    migration.runMemoryStorageReorgMigration();
    const before = readFileSync(join(dir, "rooms", "room1", "memory", "room-principles.md"), "utf-8");
    migration.runMemoryStorageReorgMigration();
    const after = readFileSync(join(dir, "rooms", "room1", "memory", "room-principles.md"), "utf-8");
    expect(after).toBe(before);
  });

  it("does not overwrite a new-location file that already has content", async () => {
    const migration = await import("../../src/workspace/memory-storage-reorg-migration.js");
    seedLegacy("room1");
    const memDir = join(dir, "rooms", "room1", "memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "room-principles.md"), "Already migrated content.");

    migration.runMemoryStorageReorgMigration();
    expect(readFileSync(join(memDir, "room-principles.md"), "utf-8")).toBe("Already migrated content.");
  });

  it("self-heals: a member file added to the legacy location after an earlier run still gets copied", async () => {
    const migration = await import("../../src/workspace/memory-storage-reorg-migration.js");
    mkdirSync(join(dir, "rooms", "room1"), { recursive: true });
    migration.runMemoryStorageReorgMigration(); // nothing to migrate yet; room marked seen

    // Legacy member file appears later.
    const pMembersDir = join(dir, "rooms", "room1", "prompt-supplements", "members");
    mkdirSync(pMembersDir, { recursive: true });
    writeFileSync(join(pMembersDir, "qa.md"), "Late member principles.");

    migration.runMemoryStorageReorgMigration();
    expect(readFileSync(join(dir, "rooms", "room1", "memory", "members", "qa", "principles.md"), "utf-8")).toBe("Late member principles.");
  });

  it("handles a member with only one of the two assets", async () => {
    const migration = await import("../../src/workspace/memory-storage-reorg-migration.js");
    const pMembersDir = join(dir, "rooms", "room1", "prompt-supplements", "members");
    mkdirSync(pMembersDir, { recursive: true });
    writeFileSync(join(pMembersDir, "solo.md"), "Only principles, no mainline.");

    migration.runMemoryStorageReorgMigration();
    const memberDir = join(dir, "rooms", "room1", "memory", "members", "solo");
    expect(readFileSync(join(memberDir, "principles.md"), "utf-8")).toBe("Only principles, no mainline.");
    expect(existsSync(join(memberDir, "mainline.md"))).toBe(false);
  });

  it("skips rooms with no legacy data", async () => {
    const migration = await import("../../src/workspace/memory-storage-reorg-migration.js");
    mkdirSync(join(dir, "rooms", "empty-room"), { recursive: true });
    expect(() => migration.runMemoryStorageReorgMigration()).not.toThrow();
    expect(existsSync(join(dir, "rooms", "empty-room", "memory"))).toBe(false);
  });
});

describe("mainline-english-headings-v1 migration", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-headings-test-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedMainline(roomId: string, memberId: string, content: string) {
    const memberDir = join(dir, "rooms", roomId, "memory", "members", memberId);
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(join(memberDir, "mainline.md"), content);
    return join(memberDir, "mainline.md");
  }

  it("rewrites Chinese headings to English in member mainline files", async () => {
    const migration = await import("../../src/workspace/mainline-english-headings-migration.js");
    const path = seedMainline("room1", "qa", "## 焦点\n\nQuality focus.\n\n## 动态索引\n\n- docs/x.md — ref\n");

    migration.runMainlineEnglishHeadingsMigration();

    expect(readFileSync(path, "utf-8")).toBe("## Focus\n\nQuality focus.\n\n## Dynamic Index\n\n- docs/x.md — ref\n");
  });

  it("leaves files already in English untouched and is idempotent", async () => {
    const migration = await import("../../src/workspace/mainline-english-headings-migration.js");
    const content = "## Focus\n\nAlready English.\n\n## Dynamic Index\n\n- docs/x.md — ref\n";
    const path = seedMainline("room1", "qa", content);

    migration.runMainlineEnglishHeadingsMigration();
    expect(readFileSync(path, "utf-8")).toBe(content);
    migration.runMainlineEnglishHeadingsMigration();
    expect(readFileSync(path, "utf-8")).toBe(content);
  });

  it("self-heals a room wrongly marked done before its mainline files existed", async () => {
    const migration = await import("../../src/workspace/mainline-english-headings-migration.js");
    mkdirSync(join(dir, "rooms", "room1", "memory", "members"), { recursive: true });
    migration.runMainlineEnglishHeadingsMigration();

    const path = seedMainline("room1", "qa", "## 焦点\n\nLate arrival.\n\n## 动态索引\n\n");
    migration.runMainlineEnglishHeadingsMigration();
    expect(readFileSync(path, "utf-8")).toContain("## Focus");
    expect(readFileSync(path, "utf-8")).toContain("## Dynamic Index");
  });

  it("syncs mainline-meta.json contentHash/contentLength after rewriting a file (QA-caught bug)", async () => {
    const migration = await import("../../src/workspace/mainline-english-headings-migration.js");
    const content = "## 焦点\n\n中文内容测试。\n\n## 动态索引\n\n- docs/x.md — 引用\n";
    seedMainline("room1", "qa", content);
    const metaPath = join(dir, "rooms", "room1", "memory", "mainline-meta.json");
    mkdirSync(join(dir, "rooms", "room1", "memory"), { recursive: true });
    writeFileSync(metaPath, JSON.stringify({ members: { qa: { revision: 1, contentHash: "stale", contentLength: 999 } } }));

    migration.runMainlineEnglishHeadingsMigration();

    const rewritten = readFileSync(join(dir, "rooms", "room1", "memory", "members", "qa", "mainline.md"), "utf-8");
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    // contentLength must be the UTF-16 character count (same unit the stores and
    // budget system use) — NOT UTF-8 byte length, which would over-count the
    // Chinese content and silently push members over budget.
    expect(meta.members.qa.contentLength).toBe(rewritten.length);
    expect(meta.members.qa.contentLength).not.toBe(Buffer.byteLength(rewritten, "utf8"));
    expect(meta.members.qa.revision).toBe(1); // untouched fields preserved
  });

  it("does not touch meta for a file that needed no heading rewrite", async () => {
    const migration = await import("../../src/workspace/mainline-english-headings-migration.js");
    const content = "## Focus\n\nAlready English.\n\n## Dynamic Index\n\n";
    seedMainline("room1", "qa", content);
    const metaPath = join(dir, "rooms", "room1", "memory", "mainline-meta.json");
    mkdirSync(join(dir, "rooms", "room1", "memory"), { recursive: true });
    writeFileSync(metaPath, JSON.stringify({ members: { qa: { revision: 1, contentHash: "unchanged", contentLength: 5 } } }));

    migration.runMainlineEnglishHeadingsMigration();
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.members.qa.contentHash).toBe("unchanged");
    expect(meta.members.qa.contentLength).toBe(5);
  });
});
