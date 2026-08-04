/**
 * G3 cutover: room config links by global member ID (sourceMemberId / globalMemberIds), not free name search.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

vi.mock("../../src/shared/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/shared/config.js")>();
  return {
    ...actual,
    getBossmodeDir: () => dir,
    ensureBossmodeDir: () => { mkdirSync(dir, { recursive: true }); },
  };
});

function seedAgent(name: string) {
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", `${name}.md`), `---\nname: ${name}\n---\n\nYou are ${name}.\n`);
}

describe("G3 ID-link cutover", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bm-g3-"));
    mkdirSync(join(dir, "members"), { recursive: true });
    mkdirSync(join(dir, "rooms"), { recursive: true });
    mkdirSync(join(dir, "knowledge", "docs"), { recursive: true });
    seedAgent("pm");
    seedAgent("developer");
    seedAgent("general");
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("stampGlobalMemberIds synthesizes members from globalMemberIds and drops roomMembers", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const roomStore = await import("../../src/workspace/room-store.js");
    const pm = reg.createMember({ name: "pm", agentTemplate: "pm", model: "m/a", credentialId: "c1" });
    const dev = reg.createMember({ name: "developer", agentTemplate: "developer", model: "m/b", credentialId: "c2" });

    const room = roomStore.createRoom("R", dir, [
      { agent: "pm", name: "pm" },
      { agent: "developer", name: "developer" },
    ], undefined, { promptLeaderMemberName: "pm" });

    roomStore.stampGlobalMemberIds(room.id, [pm.id, dev.id], pm.id);
    const fresh = roomStore.getRoom(room.id)!;
    expect(fresh.roomMembers).toBeUndefined();
    expect(fresh.globalMemberIds).toEqual([pm.id, dev.id]);
    expect(fresh.promptLeaderMemberId).toBe(pm.id);

    const members = roomStore.getRoomMembers(room.id);
    expect(members.map((m) => m.id).sort()).toEqual([dev.id, pm.id].sort());
    expect(members.find((m) => m.name === "pm")?.id).toBe(pm.id);
    expect(members.find((m) => m.name === "developer")?.sourceMemberId).toBe(dev.id);
  });

  it("resolveGlobalMemberId prefers sourceMemberId; rename does not break ID link", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const roomStore = await import("../../src/workspace/room-store.js");
    const pm = reg.createMember({ name: "pm", agentTemplate: "pm" });
    const room = roomStore.createRoom("R", dir, [{ agent: "pm", name: "pm" }], undefined, { promptLeaderMemberName: "pm" });
    roomStore.stampGlobalMemberIds(room.id, [pm.id], pm.id);

    // Rename global member
    reg.renameMember(pm.id, "prime");
    const local = roomStore.getRoomMembers(room.id).find((m) => m.sourceMemberId === pm.id)!;
    // Local name still "pm" but sourceMemberId holds the link
    const fresh = roomStore.getRoom(room.id)!;
    expect(roomStore.resolveGlobalMemberId(fresh, local)).toBe(pm.id);
  });

  it("inviteGlobalMember adds mem_* membership without roomMembers array", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const roomStore = await import("../../src/workspace/room-store.js");
    const pm = reg.createMember({ name: "pm", agentTemplate: "pm" });
    const dev = reg.createMember({ name: "developer", agentTemplate: "developer" });
    const room = roomStore.createRoom("R", dir, [{ agent: "pm", name: "pm" }], undefined, { promptLeaderMemberName: "pm" });
    roomStore.stampGlobalMemberIds(room.id, [pm.id], pm.id);

    const invited = roomStore.inviteGlobalMember(room.id, {
      id: dev.id,
      name: dev.name,
      agentTemplate: "developer",
    });
    expect(invited.ok).toBe(true);
    if (invited.ok) {
      expect(invited.member.id).toBe(dev.id);
      expect(invited.member.sourceMemberId).toBe(dev.id);
    }
    const fresh = roomStore.getRoom(room.id)!;
    expect(fresh.globalMemberIds).toContain(dev.id);
    expect(fresh.roomMembers).toBeUndefined();
    expect(roomStore.getRoomMembers(room.id).map((m) => m.id)).toEqual(expect.arrayContaining([pm.id, dev.id]));
  });

  it("does not resolve a same-named global member outside globalMemberIds", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const roomStore = await import("../../src/workspace/room-store.js");
    // Two globals cannot share name — so create room-local "shadow" without stamp
    const pm = reg.createMember({ name: "pm", agentTemplate: "pm" });
    const room = roomStore.createRoom("R", dir, [{ agent: "pm", name: "pm" }], undefined, { promptLeaderMemberName: "pm" });
    // No stampGlobalMemberIds — empty globalMemberIds
    const local = roomStore.getRoomMembers(room.id)[0];
    const fresh = roomStore.getRoom(room.id)!;
    // Without sourceMemberId and without globalMemberIds, no link (even though name matches a global)
    expect(local.sourceMemberId).toBeFalsy();
    expect(fresh.globalMemberIds || []).toHaveLength(0);
    expect(roomStore.resolveGlobalMemberId(fresh, local)).toBeNull();
    // After stamp, link appears
    roomStore.stampGlobalMemberIds(room.id, [pm.id], pm.id);
    const after = roomStore.getRoomMembers(room.id)[0];
    expect(roomStore.resolveGlobalMemberId(roomStore.getRoom(room.id)!, after)).toBe(pm.id);
  });
});
