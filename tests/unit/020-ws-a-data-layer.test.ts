import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { coreFixture } from "../helpers/core-fixture.js";
import { ConversationsRepository } from "../../src/data/repositories/conversations.js";
import { MemberArchiveService } from "../../src/member/archive/member-archive-lifecycle.js";
import {
  scopeIdOf,
  parseScopeId,
  scopeDirName,
  parseScopeDirName,
  instanceKey,
} from "../../src/shared/conversation-ref.js";

let fixture: ReturnType<typeof coreFixture>;
beforeEach(() => { fixture = coreFixture(); });
afterEach(() => fixture.close());

describe("ConversationRef / ScopeId", () => {
  it("round-trips dm and room refs", () => {
    const dm = scopeIdOf({ kind: "dm", memberId: "mem_abc" });
    expect(dm).toBe("dm:mem_abc");
    expect(parseScopeId(dm)).toEqual({ kind: "dm", memberId: "mem_abc" });

    const room = scopeIdOf({ kind: "room", roomId: "room-uuid-1" });
    expect(room).toBe("room:room-uuid-1");
    expect(parseScopeId(room)).toEqual({ kind: "room", roomId: "room-uuid-1" });
  });

  it("parseScopeId returns null on illegal input", () => {
    expect(parseScopeId("")).toBeNull();
    expect(parseScopeId("foo:bar")).toBeNull();
    expect(parseScopeId("dm:")).toBeNull();
    expect(parseScopeId("room:")).toBeNull();
    expect(parseScopeId("dm:a:b")).toBeNull();
  });

  it("scopeDirName encodes for filesystem (no colon)", () => {
    expect(scopeDirName({ kind: "dm", memberId: "mem_x" })).toBe("dm");
    expect(scopeDirName("dm:mem_x")).toBe("dm");
    expect(scopeDirName({ kind: "room", roomId: "r1" })).toBe("room-r1");
    expect(scopeDirName("room:r1")).toBe("room-r1");
    expect(parseScopeDirName("dm", "mem_x")).toEqual({ kind: "dm", memberId: "mem_x" });
    expect(parseScopeDirName("room-r1", "mem_x")).toEqual({ kind: "room", roomId: "r1" });
  });

  it("instanceKey = memberId (one runtime per member, ① B1)", () => {
    expect(instanceKey("mem_a")).toBe("mem_a");
    expect(() => instanceKey("")).toThrow(/memberId/);
  });
});

describe("member-registry", () => {
  it("creates unique members, rejects name clash, renames, fires", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const a = reg.createMember({ name: "pm", agentTemplate: "pm", model: "anthropic/claude" });
    expect(a.id).toMatch(/^mem_/);
    expect(a.unifiedModel).toBe(true);
    expect(a.global.model).toBe("anthropic/claude");

    expect(() => reg.createMember({ name: "pm", agentTemplate: "pm" })).toThrow(/taken/i);
    expect(() => reg.createMember({ name: "PM", agentTemplate: "pm" })).toThrow(/taken/i);

    const renamed = reg.renameMember(a.id, "project-pm");
    expect(renamed.name).toBe("project-pm");
    expect(reg.findMemberByName("pm")).toBeNull();
    expect(reg.findMemberByName("project-pm")?.id).toBe(a.id);
    expect(reg.resolveMemberRef("project-pm")?.id).toBe(a.id);
    expect(reg.resolveMemberRef(a.id)?.name).toBe("project-pm");

    const { archived } = await new MemberArchiveService(fixture.db, fixture.root, {quiesce: async () => {}}).archive(a.id, {confirm: true});
    expect(archived.startsWith(`backups/fired-${a.id}-`)).toBe(true);
    expect(reg.getMember(a.id)).toBeNull();
    expect(reg.listMembers()).toHaveLength(0);
  });

  it("scope overrides retired (batch-5b): patches write global, never scope", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const m = reg.createMember({ name: "patchscope" });
    reg.updateMember(m.id, { unifiedModel: false });
    reg.applyMemberConfigPatch(m.id, "room:r1", { model: "scope-model" });
    const eff = reg.getEffectiveConfig(m.id, "room:r1");
    expect(eff.model).toBe("scope-model");
    expect(eff.sources.model).toBe("global");
    const rec = reg.getMember(m.id)!;
    expect(rec.scopeOverrides["room:r1"]).toBeUndefined();
    expect(rec.unifiedModel).toBe(true); // normalized on read
  });
});

describe("member-memory-store + dm-message-store", () => {
  it("writes persona and per-scope layers under member dir", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const mem = await import("../../src/member/memory/member-memory-store.js");
    const m = reg.createMember({ name: "qa", agentTemplate: "qa" });
    mem.ensureMemorySkeleton(m.id, "dm:" + m.id);
    mem.writeMemoryLayer(m.id, "persona", "## Persona\nI am qa.\n", { type: "user" }, { reason: "init" });
    mem.writeMemoryLayer(
      m.id,
      "principles",
      "## Rules\nBe thorough.\n",
      { type: "member", memberId: m.id, name: "qa" },
      { scopeId: "dm:" + m.id, reason: "note" },
    );
    const persona = mem.readMemoryLayer(m.id, "persona");
    expect(persona.content).toMatch(/I am qa/);
    const prin = mem.readMemoryLayer(m.id, "principles", "dm:" + m.id);
    expect(prin.content).toMatch(/thorough/);
  });

  it("dm messages append with seq and cursor", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const dm = await import("../../src/chat/dm-message-store.js");
    const m = reg.createMember({ name: "arch", agentTemplate: "architect" });
    const m1 = dm.addDmMessage(m.id, { sender: "user", content: "hello", mentions: [] });
    const m2 = dm.addDmMessage(m.id, {
      sender: "arch",
      content: "hi",
      mentions: [],
      senderMemberId: m.id,
    });
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(2);
    expect(dm.readAllDmMessages(m.id)).toHaveLength(2);
    expect(dm.getDmMessagesSince(m.id, 1)).toHaveLength(1);
    dm.setDmCursor(m.id, { messageId: m2.id, seq: 2 });
    expect(dm.getDmCursor(m.id).seq).toBe(2);
  });
});

// Retired name-guessing/marker migration assertions are mapped to explicit
// historical SQL import cases in core-execution-finish-imports.test.ts.

describe("SQL chats aggregation and ID membership", () => {
  it("inviteGlobalMember stamps globalMemberIds; remove clears membership", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const roomStore = await import("../../src/chat/room-store.js");
    const g = reg.createMember({ name: "ops", agentTemplate: "general" });
    const roomId = "room-inv-1";
    new ConversationsRepository(fixture.db).upsertRoom({id: roomId, name: "ops-room", members: [], globalMemberIds: [], createdAt: 1});

    const invited = roomStore.inviteGlobalMember(roomId, {
      id: g.id,
      name: g.name,
      agentTemplate: g.agentTemplate,
    });
    expect(invited.ok).toBe(true);
    const room = roomStore.getRoom(roomId)!;
    expect(room.globalMemberIds).toContain(g.id);
    expect(room.roomMembers).toBeUndefined();
    expect(roomStore.getRoomMembers(roomId).some((m) => m.id === g.id && m.name === "ops")).toBe(true);

    const rm = roomStore.getRoomMembers(roomId)[0];
    const removed = roomStore.removeRoomMemberByRef(roomId, rm.id, { globalMemberId: g.id });
    expect(removed.ok).toBe(true);
    expect(roomStore.getRoom(roomId)!.globalMemberIds || []).not.toContain(g.id);
    expect(roomStore.getRoomMembers(roomId)).toHaveLength(0);
  });

  it("stampGlobalMemberIds after invite matches memberIds create path", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const roomStore = await import("../../src/chat/room-store.js");
    const a = reg.createMember({ name: "alice", agentTemplate: "general" });
    const b = reg.createMember({ name: "bob", agentTemplate: "general" });
    const roomId = "room-mid-1";
    new ConversationsRepository(fixture.db).upsertRoom({id: roomId, name: "r2", members: [], globalMemberIds: [], createdAt: 1});
    // Invite both by global id — membership is globalMemberIds only
    expect(roomStore.inviteGlobalMember(roomId, { id: a.id, name: a.name, agentTemplate: "general" }).ok).toBe(true);
    expect(roomStore.inviteGlobalMember(roomId, { id: b.id, name: b.name, agentTemplate: "general" }).ok).toBe(true);
    roomStore.stampGlobalMemberIds(roomId, [a.id, b.id], a.id);
    const stamped = roomStore.getRoom(roomId)!;
    expect(stamped.globalMemberIds?.sort()).toEqual([a.id, b.id].sort());
    expect(stamped.promptLeaderGlobalMemberId).toBe(a.id);
    expect(stamped.roomMembers).toBeUndefined();
    expect(roomStore.getRoomMembers(roomId).map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect(roomStore.getRoomMembers(roomId).map((m) => m.name).sort()).toEqual(["alice", "bob"]);
  });

  it("user read cursor drives unread after mark-read", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const dm = await import("../../src/chat/dm-message-store.js");
    const cursors = await import("../../src/chat/user-read-cursors.js");
    const { scopeIdOf } = await import("../../src/shared/conversation-ref.js");
    const m = reg.createMember({ name: "chatty", agentTemplate: "general" });
    const scopeId = scopeIdOf({ kind: "dm", memberId: m.id });
    const a = dm.addDmMessage(m.id, { sender: "user", content: "hi", mentions: [] });
    dm.addDmMessage(m.id, { sender: "chatty", content: "yo @fish", mentions: [], senderMemberId: m.id });
    dm.addDmMessage(m.id, { sender: "chatty", content: "again", mentions: [], senderMemberId: m.id });

    // No user cursor yet → all non-user messages unread
    const msgs = dm.readAllDmMessages(m.id);
    expect(msgs.filter((x) => x.sender !== "user")).toHaveLength(2);

    cursors.setUserReadCursor(scopeId, { messageId: a.id, seq: a.seq ?? 1 });
    const c = cursors.getUserReadCursor(scopeId)!;
    const after = msgs.filter((msg) => typeof msg.seq === "number" && c.seq != null && msg.seq > c.seq && msg.sender !== "user");
    expect(after).toHaveLength(2);
    expect(after.some((msg) => msg.content.includes("@fish"))).toBe(true);
  });
});
