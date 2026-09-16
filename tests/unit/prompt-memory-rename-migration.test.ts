import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
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

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

describe("prompt-memory-rename-v1 migration (new memory/ layout)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-memrename-test-"));
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function memDir(roomId: string) {
    return join(dir, "rooms", roomId, "memory");
  }

  function seedRoomPrinciples(roomId: string, content: string) {
    mkdirSync(memDir(roomId), { recursive: true });
    writeFileSync(join(memDir(roomId), "room-principles.md"), content);
    writeFileSync(join(memDir(roomId), "principles-meta.json"), JSON.stringify({ room: { revision: 1, contentHash: sha(content), contentLength: content.length } }, null, 2));
  }

  function seedMemberPrinciples(roomId: string, memberId: string, content: string) {
    const memberDir = join(memDir(roomId), "members", memberId);
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(join(memberDir, "principles.md"), content);
    const metaPath = join(memDir(roomId), "principles-meta.json");
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf-8")) : {};
    meta.members = { ...(meta.members || {}), [memberId]: { revision: 1, contentHash: sha(content), contentLength: content.length } };
    mkdirSync(memDir(roomId), { recursive: true });
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  function seedMemberMainline(roomId: string, memberId: string, content: string) {
    const memberDir = join(memDir(roomId), "members", memberId);
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(join(memberDir, "mainline.md"), content);
    const metaPath = join(memDir(roomId), "mainline-meta.json");
    const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf-8")) : {};
    meta.members = { ...(meta.members || {}), [memberId]: { revision: 1, contentHash: sha(content), contentLength: content.length } };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  }

  it("rewrites *_asset references in room, member principles, and member mainline files + syncs meta hashes", async () => {
    const migration = await import("../../src/workspace/prompt-memory-rename-migration.js");
    seedRoomPrinciples("room1", "Room rule: use read_asset.");
    seedMemberPrinciples("room1", "qa", "Member rule: use write_asset to rewrite.");
    seedMemberMainline("room1", "qa", "- docs/x.md — see edit_asset\n");

    migration.runPromptMemoryRenameMigration();

    expect(readFileSync(join(memDir("room1"), "room-principles.md"), "utf-8")).toBe("Room rule: use read_memory.");
    expect(readFileSync(join(memDir("room1"), "members", "qa", "principles.md"), "utf-8")).toBe("Member rule: use write_memory to rewrite.");
    expect(readFileSync(join(memDir("room1"), "members", "qa", "mainline.md"), "utf-8")).toBe("- docs/x.md — see edit_memory\n");

    const pMeta = JSON.parse(readFileSync(join(memDir("room1"), "principles-meta.json"), "utf-8"));
    expect(pMeta.room.contentHash).toBe(sha("Room rule: use read_memory."));
    expect(pMeta.members.qa.contentHash).toBe(sha("Member rule: use write_memory to rewrite."));
    const mMeta = JSON.parse(readFileSync(join(memDir("room1"), "mainline-meta.json"), "utf-8"));
    expect(mMeta.members.qa.contentHash).toBe(sha("- docs/x.md — see edit_memory\n"));

    const snapshots = readdirSync(join(dir, "pi-agent", "runtime", ".migration-snapshots"));
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
  });

  it("orphan member files without a meta entry still get rewritten", async () => {
    const migration = await import("../../src/workspace/prompt-memory-rename-migration.js");
    const memberDir = join(memDir("room1"), "members", "ghost");
    mkdirSync(memberDir, { recursive: true });
    writeFileSync(join(memberDir, "principles.md"), "orphan uses read_asset");
    mkdirSync(memDir("room1"), { recursive: true });
    writeFileSync(join(memDir("room1"), "principles-meta.json"), JSON.stringify({ members: {} }));

    migration.runPromptMemoryRenameMigration();
    expect(readFileSync(join(memberDir, "principles.md"), "utf-8")).toBe("orphan uses read_memory");
  });

  it("self-heals a room wrongly marked done before its member files existed", async () => {
    const migration = await import("../../src/workspace/prompt-memory-rename-migration.js");
    mkdirSync(memDir("room1"), { recursive: true });
    migration.runPromptMemoryRenameMigration();
    const marker1 = JSON.parse(readFileSync(join(dir, "pi-agent", "runtime", ".migrations", "prompt-memory-rename-v1.json"), "utf-8"));
    expect(marker1.rooms.room1).toBe(true);

    seedMemberPrinciples("room1", "qa", "late file uses write_asset");

    migration.runPromptMemoryRenameMigration();
    expect(readFileSync(join(memDir("room1"), "members", "qa", "principles.md"), "utf-8")).toBe("late file uses write_memory");
  });

  it("leaves files without asset references untouched and is idempotent", async () => {
    const migration = await import("../../src/workspace/prompt-memory-rename-migration.js");
    seedMemberPrinciples("room1", "qa", "No tool references here.");

    migration.runPromptMemoryRenameMigration();
    const before = readFileSync(join(memDir("room1"), "members", "qa", "principles.md"), "utf-8");
    migration.runPromptMemoryRenameMigration();
    const after = readFileSync(join(memDir("room1"), "members", "qa", "principles.md"), "utf-8");
    expect(after).toBe(before);
  });

  it("skips rooms with no memory directory", async () => {
    const migration = await import("../../src/workspace/prompt-memory-rename-migration.js");
    mkdirSync(join(dir, "rooms", "empty-room"), { recursive: true });
    expect(() => migration.runPromptMemoryRenameMigration()).not.toThrow();
  });
});
