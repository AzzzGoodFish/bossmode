/**
 * Batch 7 P3 (spec §5): rooms unbind cwd — attachments live in the room data
 * dir, create paths stop requiring cwd, and path policy covers member homes +
 * workspace roots.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let fixture: ReturnType<typeof import("../helpers/core-fixture.js").coreFixture>;
let projDir: string;
beforeEach(async () => {
  dir = process.env.BOSSMODE_DIR!;
  projDir = mkdtempSync(join(tmpdir(), "bm-b7p3-proj-"));
  mkdirSync(join(dir, "members"), { recursive: true });
  mkdirSync(join(dir, "rooms"), { recursive: true });
  vi.resetModules();
  fixture = (await import("../helpers/core-fixture.js")).coreFixture();
});
afterEach(() => {
  fixture.close();
  rmSync(projDir, { recursive: true, force: true });
});

describe("rooms without cwd", () => {
  it("createRoom accepts no cwd; persisted SQL room has none; attachments land in the room data dir", async () => {
    const roomStore = await import("../../src/chat/room-store.js");
    const room = roomStore.createRoom("free-room", undefined, []);
    expect(room.cwd).toBeUndefined();
    fixture.reopen();
    const persisted = roomStore.getRoom(room.id)!;
    expect("cwd" in persisted).toBe(false);
    expect(existsSync(join(dir, "rooms", room.id, "room.json"))).toBe(false);

    // attachment store writes into rooms/<id>/attachments without touching any project dir
    const attachmentStore = await import("../../src/files/attachment-store.js");
    const { Readable } = await import("node:stream");
    const stored = await attachmentStore.streamToAttachment(Readable.from([Buffer.from("pngdata")]), room.id, "shot.png");
    expect(stored.storedFilename).toBeTruthy();
    expect(existsSync(join(dir, "rooms", room.id, "attachments", stored.storedFilename))).toBe(true);
  });

  it("path policy covers member homes and their workspace roots", async () => {
    const roomStore = await import("../../src/chat/room-store.js");
    const reg = await import("../../src/member/member-registry.js");
    const m = reg.createMember({ name: "policybot", agentTemplate: "pm" } as any);
    const room = roomStore.createRoom("policy-room", undefined, []);
    roomStore.stampGlobalMemberIds(room.id, [m.id]);

    const { roomMemberAssetRoots } = await import("../../src/chat/room-store.js");
    const roots = roomMemberAssetRoots(room.id);
    expect(roots).toContain(join(dir, "members", m.id));

    // adding a workspace extends the roots
    const wsr = await import("../../src/member/workspaces/workspace-registry.js");
    wsr.createWorkspace(m.id, { id: "web1", kind: "ssh", host: "h", user: "u", root: "/srv/app" });
    expect(roomMemberAssetRoots(room.id)).toContain("/srv/app");
  });
});
