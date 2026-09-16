/**
 * G3 cutover: room config links by global member ID (sourceMemberId / globalMemberIds), not free name search.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { coreFixture } from "../helpers/core-fixture.js";
import { ConversationsRepository } from "../../src/data/repositories/conversations.js";
let fixture: ReturnType<typeof coreFixture>;
function historicalRoom(names: string[]) {
  // Explicit historical import, never inferred from today's names or template files.
  const room = {id: "imported-room", name: "R", members: names, createdAt: 1,
    roomMembers: names.map(name => ({id: `rm_${name}`, roomId: "imported-room", name, sourceAgent: name, createdAt: 1, updatedAt: 2}))};
  new ConversationsRepository(fixture.db).upsertRoom(room);
  return room;
}
describe("G3 ID-link SQL cutover", () => {
  beforeEach(() => { fixture = coreFixture(); });
  afterEach(() => fixture.close());

  it("stampGlobalMemberIds synthesizes members from globalMemberIds without discarding historical roomMembers", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const roomStore = await import("../../src/chat/room-store.js");
    const pm = reg.createMember({ name: "pm", agentTemplate: "pm", model: "m/a", credentialId: "c1" });
    const dev = reg.createMember({ name: "developer", agentTemplate: "developer", model: "m/b", credentialId: "c2" });

    const room = historicalRoom(["pm", "developer"]);

    roomStore.stampGlobalMemberIds(room.id, [pm.id, dev.id], pm.id);
    const fresh = roomStore.getRoom(room.id)!;
    expect(fresh.roomMembers).toEqual(room.roomMembers);
    expect(fresh.globalMemberIds).toEqual([pm.id, dev.id]);
    expect(fresh.promptLeaderMemberId).toBe(pm.id);

    const members = roomStore.getRoomMembers(room.id);
    expect(members.map((m) => m.id).sort()).toEqual([dev.id, pm.id].sort());
    expect(members.find((m) => m.name === "pm")?.id).toBe(pm.id);
    expect(members.find((m) => m.name === "developer")?.sourceMemberId).toBe(dev.id);
  });

  it("resolveGlobalMemberId prefers sourceMemberId; rename does not break ID link", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const roomStore = await import("../../src/chat/room-store.js");
    const pm = reg.createMember({ name: "pm", agentTemplate: "pm" });
    const room = historicalRoom(["pm"]);
    roomStore.stampGlobalMemberIds(room.id, [pm.id], pm.id);

    // Rename global member
    reg.renameMember(pm.id, "prime");
    const local = roomStore.getRoomMembers(room.id).find((m) => m.sourceMemberId === pm.id)!;
    expect(local.name).toBe("prime");
    fixture.reopen();
    // The SQL ID link survives both rename and storage reopen.
    const fresh = roomStore.getRoom(room.id)!;
    expect(roomStore.resolveGlobalMemberId(fresh, local)).toBe(pm.id);
  });

  it("inviteGlobalMember adds mem_* membership without activating historical roomMembers", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const roomStore = await import("../../src/chat/room-store.js");
    const pm = reg.createMember({ name: "pm", agentTemplate: "pm" });
    const dev = reg.createMember({ name: "developer", agentTemplate: "developer" });
    const room = historicalRoom(["pm"]);
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
    expect(fresh.roomMembers).toEqual(room.roomMembers);
    expect(roomStore.getRoomMembers(room.id).map((m) => m.id)).toEqual(expect.arrayContaining([pm.id, dev.id]));
  });

  it("does not resolve a same-named global member outside globalMemberIds", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const roomStore = await import("../../src/chat/room-store.js");
    // Two globals cannot share name — so create room-local "shadow" without stamp
    const pm = reg.createMember({ name: "pm", agentTemplate: "pm" });
    const room = historicalRoom(["pm"]);
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
