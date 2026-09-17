import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { createMember } from "../../src/app/member-actions.js";
import { updateMemberIdentity } from "../../src/member/identity.js";
import { storeRoom, connectConversationMembers, getRoomMembersFromRoom } from "../../src/chat/conversations.js";
import { assertMemberScopeAccess, listRoomsForMember } from "../../src/chat/conversations.js";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => { vi.restoreAllMocks(); fixture.close(); });

it("never grants access from historical names when the current roster is explicitly empty", async () => {
  const member = createMember({ name: "Reused name" });
  storeRoom({ id: "empty-current", name: "Historical room", members: [member.name], globalMemberIds: [], createdAt: 1,
    roomMembers: [{ id: "old-member", name: member.name, sourceAgent: "general", createdAt: 1, updatedAt: 1 }] });
  expect(listRoomsForMember(member.id)).toEqual([]);
  expect(() => assertMemberScopeAccess(member.id, "room:empty-current")).toThrow(/not a member/);
  const { handleToolCallback } = await import("../../src/agent/tools/tools.js");
  const result = await handleToolCallback("chat_read", `dm:${member.id}`, member.id, { chat: "room:empty-current" }, { memberId: member.id });
  expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/not a member/) });
});

it("keeps a proven historical member link through rename without granting access to a reused name", () => {
  const original = createMember({ name: "Original name" });
  storeRoom({ id: "linked-history", name: "Linked room", members: [original.name], createdAt: 1,
    roomMembers: [{ id: "old-member", name: original.name, sourceMemberId: original.id, sourceAgent: "general", createdAt: 1, updatedAt: 1 }] });
  updateMemberIdentity(original.id, { name: "Current name" });
  const reused = createMember({ name: "Original name" });
  expect(listRoomsForMember(original.id).map(room => room.id)).toEqual(["linked-history"]);
  expect(assertMemberScopeAccess(original.id, "room:linked-history").kind).toBe("room");
  expect(listRoomsForMember(reused.id)).toEqual([]);
  expect(() => assertMemberScopeAccess(reused.id, "room:linked-history")).toThrow(/not a member/);
});

it("uses the explicitly connected member directory without a second member SQL reader", () => {
  const read = vi.fn(id => ({ id, name: "Directory name", agentTemplate: "general", createdAt: 1, updatedAt: 2 }));
  const disconnect = connectConversationMembers(read);
  vi.spyOn(fixture.db, "get").mockImplementation(() => { throw new Error("unexpected SQL lookup"); });
  try {
    const members = getRoomMembersFromRoom({ id: "room-directory", name: "Room", members: [], globalMemberIds: ["mem_directory"], createdAt: 1 });
    expect(members).toMatchObject([{ id: "mem_directory", name: "Directory name" }]);
    expect(read).toHaveBeenCalledExactlyOnceWith("mem_directory", false);
  } finally { disconnect(); }
});

it("never restores a disposed directory when a newer connection closes", () => {
  const read = (id: string) => ({ id, name: "Directory name", agentTemplate: "general", createdAt: 1, updatedAt: 2 });
  const first = connectConversationMembers(read);
  const second = connectConversationMembers(read);
  const room = { id: "room-directory", name: "Room", members: [], globalMemberIds: ["mem_directory"], createdAt: 1 };
  first();
  expect(getRoomMembersFromRoom(room)).toHaveLength(1);
  second();
  expect(() => getRoomMembersFromRoom(room)).toThrow("Conversation member directory is not connected");
});
