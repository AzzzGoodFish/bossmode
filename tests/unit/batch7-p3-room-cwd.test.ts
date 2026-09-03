/**
 * Batch 7 P3 (spec §5): rooms unbind cwd — attachments live in the room data
 * dir (startup migration moves legacy dirs), create paths stop requiring cwd,
 * and path policy covers member homes + workspace roots.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let projDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-b7p3-"));
  projDir = mkdtempSync(join(tmpdir(), "bm-b7p3-proj-"));
  process.env.BOSSMODE_DIR = dir;
  mkdirSync(join(dir, "members"), { recursive: true });
  mkdirSync(join(dir, "rooms"), { recursive: true });
  vi.resetModules();
});
afterEach(() => {
  delete process.env.BOSSMODE_DIR;
  rmSync(dir, { recursive: true, force: true });
  rmSync(projDir, { recursive: true, force: true });
});

describe("room attachments migration", () => {
  it("moves legacy room.cwd/.bossmode-attachments into rooms/<id>/attachments, idempotently", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const legacyRoot = mkdtempSync(join(tmpdir(), "bm-b7p3-legacy-"));
    mkdirSync(join(legacyRoot, ".bossmode-attachments"), { recursive: true });
    writeFileSync(join(legacyRoot, ".bossmode-attachments", "img.png"), "png", "utf-8");
    // Upgrade shape: a pre-batch-7 room.json on disk still carries cwd.
    const roomId = "legacy-room-1";
    mkdirSync(join(dir, "rooms", roomId), { recursive: true });
    writeFileSync(join(dir, "rooms", roomId, "room.json"), JSON.stringify({
      id: roomId, name: "proj-room", cwd: legacyRoot, members: [], roomMembers: [],
    }), "utf-8");

    const mig = await import("../../src/workspace/room-attachments-migration.js");
    expect(mig.needsRoomAttachmentsMigration()).toBe(true);
    const report = mig.runRoomAttachmentsMigration();
    expect(report.movedRooms).toContain(roomId);
    const target = join(dir, "rooms", roomId, "attachments", "img.png");
    expect(existsSync(target)).toBe(true);
    expect(existsSync(join(legacyRoot, ".bossmode-attachments"))).toBe(false);

    // idempotent second run: nothing left to move
    expect(mig.needsRoomAttachmentsMigration()).toBe(false);
    const again = mig.runRoomAttachmentsMigration();
    expect(again.movedRooms).toHaveLength(0);
    expect(readFileSync(target, "utf-8")).toBe("png");
    rmSync(legacyRoot, { recursive: true, force: true });
  });
});

describe("rooms without cwd", () => {
  it("createRoom accepts no cwd; persisted room.json has none; attachments land in the room data dir", async () => {
    const roomStore = await import("../../src/workspace/room-store.js");
    const room = roomStore.createRoom("free-room", undefined, []);
    expect(room.cwd).toBeUndefined();
    const persisted = JSON.parse(readFileSync(join(dir, "rooms", room.id, "room.json"), "utf-8"));
    expect("cwd" in persisted).toBe(false);

    // attachment store writes into rooms/<id>/attachments without touching any project dir
    const attachmentStore = await import("../../src/workspace/attachment-store.js");
    const { Readable } = await import("node:stream");
    const stored = await attachmentStore.streamToAttachment(Readable.from([Buffer.from("pngdata")]), room.id, "shot.png");
    expect(stored.storedFilename).toBeTruthy();
    expect(existsSync(join(dir, "rooms", room.id, "attachments", stored.storedFilename))).toBe(true);
  });

  it("path policy covers member homes and their workspace roots", async () => {
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "agents", "pm.md"), '---\nname: pm\ndescription: pm\n---\npm\n', "utf-8");
    const roomStore = await import("../../src/workspace/room-store.js");
    const reg = await import("../../src/workspace/member-registry.js");
    const m = reg.createMember({ name: "policybot", agentTemplate: "pm" } as any);
    const room = roomStore.createRoom("policy-room", undefined, [{ agent: "pm", name: "policybot", id: m.id }]);
    // Stamp the 0.20 global id link (the API memberIds path does this).
    const persisted = JSON.parse(readFileSync(join(dir, "rooms", room.id, "room.json"), "utf-8"));
    persisted.globalMemberIds = [m.id];
    writeFileSync(join(dir, "rooms", room.id, "room.json"), JSON.stringify(persisted));

    const { roomMemberAssetRoots } = await import("../../src/workspace/room-store.js");
    const roots = roomMemberAssetRoots(room.id);
    expect(roots).toContain(join(dir, "members", m.id));

    // adding a workspace extends the roots
    const wsr = await import("../../src/workspace/workspace-registry.js");
    wsr.createWorkspace(m.id, { id: "web1", kind: "ssh", host: "h", user: "u", root: "/srv/app" });
    expect(roomMemberAssetRoots(room.id)).toContain("/srv/app");
  });
});
