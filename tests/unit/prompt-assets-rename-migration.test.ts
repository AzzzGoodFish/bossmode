import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir = "";

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
}));

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function seedLegacyRoom() {
  const dir = join(tmpDir, "rooms", "room-legacy", "prompt-supplements");
  mkdirSync(join(dir, "members"), { recursive: true });
  const roomContent = "## Rules\n\n用 edit_prompt_supplement 改 room 准则；read_prompt_supplement 读取。\n";
  const memberContent = "# 个人纪律\n\n写完用 write_prompt_supplement 全量覆盖，别用 edit_prompt_supplement。\n";
  const orphanContent = "orphan: read_prompt_supplement\n";
  writeFileSync(join(dir, "room.md"), roomContent, "utf-8");
  writeFileSync(join(dir, "members", "rm_1.md"), memberContent, "utf-8");
  writeFileSync(join(dir, "members", "rm_orphan.md"), orphanContent, "utf-8");
  writeFileSync(join(dir, "meta.json"), JSON.stringify({
    room: { revision: 3, contentHash: sha(roomContent), contentLength: roomContent.length },
    members: { rm_1: { revision: 2, contentHash: sha(memberContent), contentLength: memberContent.length } },
  }), "utf-8");
  return { roomContent, memberContent, orphanContent };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-rename-mig-"));
  mkdirSync(join(tmpDir, "rooms"), { recursive: true });
});

afterEach(() => {
  vi.resetModules();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("prompt-assets-rename migration", () => {
  it("rewrites retired tool names, refreshes meta hashes, snapshots, and writes an idempotent marker", async () => {
    const legacy = seedLegacyRoom();
    const { runPromptAssetsRenameMigration } = await import("../../src/member/migrations/prompt-assets-rename-migration.js");
    runPromptAssetsRenameMigration();

    const dir = join(tmpDir, "rooms", "room-legacy", "prompt-supplements");
    const room = readFileSync(join(dir, "room.md"), "utf-8");
    const member = readFileSync(join(dir, "members", "rm_1.md"), "utf-8");
    const orphan = readFileSync(join(dir, "members", "rm_orphan.md"), "utf-8");
    expect(room).toContain("edit_asset");
    expect(room).toContain("read_asset");
    expect(room).not.toContain("prompt_supplement");
    expect(member).toContain("write_asset");
    expect(member).not.toContain("prompt_supplement");
    expect(orphan).toContain("read_asset");
    expect(orphan).not.toContain("prompt_supplement");
    // Only the tool names changed — surrounding content is intact
    expect(room.replace(/edit_asset|read_asset/g, (m) => m.replace("asset", "prompt_supplement"))).toBe(legacy.roomContent);

    // meta.json hashes/lengths recomputed, revision preserved
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    expect(meta.room.revision).toBe(3);
    expect(meta.room.contentHash).toBe(sha(room));
    expect(meta.room.contentLength).toBe(room.length);
    expect(meta.members.rm_1.revision).toBe(2);
    expect(meta.members.rm_1.contentHash).toBe(sha(member));

    // snapshots were taken before rewrite
    const snapshots = readdirSync(join(tmpDir, "pi-agent", "runtime", ".migration-snapshots"));
    expect(snapshots.some((f) => f.includes("room-legacy-room"))).toBe(true);
    expect(snapshots.some((f) => f.includes("rm_1"))).toBe(true);
    const snap = readFileSync(join(tmpDir, "pi-agent", "runtime", ".migration-snapshots", snapshots.find((f) => f.includes("room-legacy-room"))!), "utf-8");
    expect(snap).toBe(legacy.roomContent);

    // marker written
    const marker = JSON.parse(readFileSync(join(tmpDir, "pi-agent", "runtime", ".migrations", "prompt-assets-rename-v1.json"), "utf-8"));
    expect(marker.rooms["room-legacy"]).toBe(true);
  });

  it("second run is a no-op (idempotent) and leaves already-clean rooms untouched", async () => {
    seedLegacyRoom();
    const { runPromptAssetsRenameMigration } = await import("../../src/member/migrations/prompt-assets-rename-migration.js");
    runPromptAssetsRenameMigration();
    const dir = join(tmpDir, "rooms", "room-legacy", "prompt-supplements");
    const afterFirst = readFileSync(join(dir, "room.md"), "utf-8");
    const snapshotsAfterFirst = readdirSync(join(tmpDir, "pi-agent", "runtime", ".migration-snapshots")).length;
    runPromptAssetsRenameMigration();
    expect(readFileSync(join(dir, "room.md"), "utf-8")).toBe(afterFirst);
    expect(readdirSync(join(tmpDir, "pi-agent", "runtime", ".migration-snapshots")).length).toBe(snapshotsAfterFirst);

    // A clean room without legacy tool names is never written
    const cleanDir = join(tmpDir, "rooms", "room-clean", "prompt-supplements");
    mkdirSync(cleanDir, { recursive: true });
    writeFileSync(join(cleanDir, "room.md"), "## Rules\n\n使用 read_asset。\n", "utf-8");
    runPromptAssetsRenameMigration();
    expect(readFileSync(join(cleanDir, "room.md"), "utf-8")).toBe("## Rules\n\n使用 read_asset。\n");
  });

  it("handles a room added after the first migration pass", async () => {
    seedLegacyRoom();
    const { runPromptAssetsRenameMigration } = await import("../../src/member/migrations/prompt-assets-rename-migration.js");
    runPromptAssetsRenameMigration();
    // Room restored from backup after migration → still gets migrated on next startup
    const dir = join(tmpDir, "rooms", "room-restored", "prompt-supplements");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "room.md"), "见 write_prompt_supplement\n", "utf-8");
    runPromptAssetsRenameMigration();
    expect(readFileSync(join(dir, "room.md"), "utf-8")).toBe("见 write_asset\n");
  });
});
