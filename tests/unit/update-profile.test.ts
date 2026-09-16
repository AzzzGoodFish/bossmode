import { ConversationsRepository } from "../../src/data/repositories/conversations.js";
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setupTestWorkspace, getTestBossmodeDir, getTestWorkspace } from "../helpers/test-server.js";
setupTestWorkspace();

async function fixture() {
  const registry = await import("../../src/member/member-registry.js");
  const rooms = await import("../../src/chat/room-store.js");
  const suffix = randomUUID().slice(0, 8);
  const own = registry.createMember({ name: `Self-${suffix}`, title: "Before" });
  const peer = registry.createMember({ name: `Peer-${suffix}` });
  const room = rooms.createRoom(`Room-${suffix}`, undefined, []);
  rooms.stampGlobalMemberIds(room.id, [own.id, peer.id]);
  const { handleToolCallback } = await import("../../src/engine/tools.js");
  const call = (tool: string, params: any, scope = room.id) => handleToolCallback(tool, scope, own.name, params, { memberId: own.id });
  return { registry, rooms, own, peer, room, call };
}

describe("self-only profile_update", () => {
  it("atomically updates normalized DB identity, clears description, and preserves persona/configuration", async () => {
    const f = await fixture();
    const path = join(getTestBossmodeDir(), "members", f.own.id, "persona.md");
    const bytes = "\uFEFF\r\n---\r\nname: literal content\r\n---\r\n  unchanged  \r\n";
    writeFileSync(path, bytes);
    const name = `言实 β ${randomUUID().slice(0, 6)}`;
    expect(await f.call("profile_update", { name: ` ${name} `, description: " Engineer " })).toEqual({
      ok: true,
      member: { id: f.own.id, name, description: "Engineer" },
      changed: true,
    });
    const saved = f.registry.getMember(f.own.id)!;
    expect(saved.global).toEqual(f.own.global);
    expect(await f.call("profile_update", { name, description: "Engineer" })).toMatchObject({ changed: false });
    expect(f.registry.getMember(f.own.id)!.updatedAt).toBe(saved.updatedAt);
    expect(await f.call("profile_update", { description: "" })).toMatchObject({ member: { name, description: "" }, changed: true });
    expect(readFileSync(path, "utf8")).toBe(bytes);
    getTestWorkspace().reopen();
    expect(f.registry.getMember(f.own.id)).toMatchObject({ name });
    expect(f.registry.getMember(f.own.id)!.title).toBeUndefined();
  });

  it("rejects target injection, malformed/empty patches and collisions without partial writes", async () => {
    const f = await fixture();
    for (const patch of [{}, { memberId: f.peer.id, description: "stolen" }, { name: null }, { description: null }, { name: 4 }, { description: [] }, { name: "  " }, { name: "invalid/path", description: "bad" }, { name: "ALL" }, { name: " User " }, { name: "system" }, { title: "old field" }]) {
      expect(await f.call("profile_update", patch)).toMatchObject({ ok: false, code: "invalid_profile" });
      expect(f.registry.getMember(f.own.id)).toEqual(f.own);
    }
    expect(await f.call("profile_update", { name: f.peer.name.toUpperCase(), description: "partial" })).toMatchObject({ ok: false, code: "name_taken" });
    expect(f.registry.getMember(f.own.id)).toEqual(f.own);
    expect(f.registry.getMember(f.peer.id)).toEqual(f.peer);
    for (const name of ["all", "USER", " System "]) expect(() => f.registry.createMember({ name })).toThrow("reserved_member_name");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    expect(await handleToolCallback("profile_update", f.room.id, f.own.name, { description: "bad" })).toMatchObject({ ok: false, code: "invalid_caller" });
    expect(await f.call("profile_update", { description: "bad" }, `dm:${f.peer.id}`)).toMatchObject({ ok: false, code: "scope_access_denied" });
  });

  it("keeps room/DM and subsequent SDK calls bound to caller ID through two renames and name reuse", async () => {
    const f = await fixture();
    const { createBossmodeSdkTools } = await import("../../src/engine/runtime/bossmode-sdk-tools.js");
    const { loadScopeMessages, handleToolCallback } = await import("../../src/engine/tools.js");
    const scopes = [f.room.id, `dm:${f.own.id}`];
    const toolSets = scopes.map(roomId => createBossmodeSdkTools({ roomId, memberId: f.own.id }));
    await f.call("chat_send", { message: "historical snapshot" });
    const originalName = f.own.name;
    const next = `New ${randomUUID().slice(0, 6)}`;
    await f.call("profile_update", { name: next });
    const { updateProfileForMember } = await import("../../src/engine/member-profile-update.js");
    updateProfileForMember(f.peer.id, { name: originalName });
    for (const tools of toolSets) {
      await (tools.find(t => t.name === "chat_send")!.execute as any)("chat-id", { message: "after rename" });
      const profile = await (tools.find(t => t.name === "bossmode")!.execute as any)("profile-id", { action: "call", tool: "profile_update", args: { description: "Self only" } });
      expect(JSON.stringify(profile)).toContain(f.own.id);
    }
    for (const scope of scopes) {
      const last = loadScopeMessages(scope).at(-1)!;
      expect(last.sender).toBe(next);
      expect(last.senderMemberId).toBe(f.own.id);
      expect(await handleToolCallback("chat_list", scope, originalName, {}, { memberId: f.own.id })).toMatchObject({ ok: true });
    }
    expect(loadScopeMessages(f.room.id)[0].sender).toBe(originalName);
    expect(f.registry.getMember(f.peer.id)!.title).toBeUndefined();
    await f.call("profile_update", { name: `${next}-again` });
    expect(await f.call("workspace_list", {})).toMatchObject({ ok: true });
    expect(await f.call("chat_list", {})).toMatchObject({ ok: true });
  });

  it("rolls back both fields when SQLite rejects the write, and one contender wins a collision", async () => {
    const f = await fixture();
    const { getDatabase } = await import("../../src/data/database.js");
    getDatabase().exec("CREATE TEMP TRIGGER fail_profile BEFORE UPDATE ON members BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    try { expect(await f.call("profile_update", { name: "failed-name", description: "failed-title" })).toMatchObject({ ok: false, code: "persistence_failed" }); }
    finally { getDatabase().exec("DROP TRIGGER fail_profile"); }
    expect(f.registry.getMember(f.own.id)).toEqual(f.own);
    const target = `Collision-${randomUUID()}`;
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const results = await Promise.all([
      f.call("profile_update", { name: target }),
      handleToolCallback("profile_update", f.room.id, f.peer.name, { name: target.toUpperCase(), description: "must roll back" }, { memberId: f.peer.id }),
    ]) as any[];
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => r.code === "name_taken")).toHaveLength(1);
    const loser = results[0].ok ? f.peer : f.own;
    expect(f.registry.getMember(loser.id)).toEqual(loser);
  });
  it("matches current Unicode/spaced names and keeps reply targets and waits on IDs after name reuse", async () => {
    const f = await fixture();
    const router = await import("../../src/communication/router.js");
    const next = `言实 同事 ${randomUUID().slice(0, 6)}`;
    let captured: any;
    const stop = router.initRouter({mention:(_scope,id,ctx)=>{captured={id,ctx};}});
    try {
      await f.call("chat_send", { message: `@${f.peer.name} please reply` });
      expect(captured).toMatchObject({ id: f.peer.id });
      const { postMessage } = await import("../../src/communication/message-bus.js");
      postMessage(f.room.id, f.own.name, "captured internal reply obligation", [f.peer.name], { senderMemberId: f.own.id, mentionMemberIds: [f.peer.id], needResponseMemberIds: [f.peer.id] });
      await Promise.resolve();
      expect(captured).toMatchObject({ id: f.peer.id, ctx: { needResponseMemberIds: [f.peer.id] } });
      const originalContext = captured.ctx;
      const { updateProfileForMember } = await import("../../src/engine/member-profile-update.js");
      const next = `${f.own.name}-renamed`;
      await f.call("profile_update", { name: next });
      updateProfileForMember(f.peer.id, { name: f.own.name });
      const roster = f.rooms.getRoomMembers(f.room.id);
      expect(router.parseMentionMemberIds(`@${next}`, roster)).toEqual([f.own.id]);
      expect(router.parseMentionMemberIds(`@${f.own.name}`, roster)).toEqual([f.peer.id]);
      expect(router.parseMentionMemberIds(`\`@all\` @${next}-unknown`, roster)).toEqual([]);
      expect(router.parseMentions(`!${next} and word!${next}`, [next])).toEqual([]);
      expect(router.parseMentions("@foo`bar`", ["foo", "foo`bar`"])).toEqual(["foo`bar`"]);
      expect(router.parseMentions("`@foo`", ["foo"])).toEqual([]);
      postMessage(f.room.id, "user", "old name now targets another member", [f.own.name], { mentionMemberIds: [f.peer.id] });
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(originalContext.needResponseMemberIds).toEqual([f.peer.id]);
    } finally { stop(); }
  });

  it("creates chats with current Unicode identity and keeps historical template tools ID-bound", async () => {
    const f = await fixture();
    const { updateProfileForMember } = await import("../../src/engine/member-profile-update.js");
    const pending = f.call("chat_create", { name: "Creator race", members: [f.peer.id] }, `dm:${f.own.id}`);
    const next = `创建者 ${randomUUID().slice(0, 6)}`;
    updateProfileForMember(f.own.id, { name: next });
    const created = await pending as any;
    expect(created).toMatchObject({ ok: true, chat: { name: "Creator race" } });
    const createdRoomId = String(created.chat.id).replace(/^room:/, "");
    expect(f.rooms.getRoom(createdRoomId)!.globalMemberIds).toContain(f.own.id);
    const legacyRoom = { id: "historical-room", name: "Historical room", members: ["Historical-template"], createdAt: 1,
      roomMembers: [{ id: "rm_historical", roomId: "historical-room", name: "Historical-template", sourceAgent: "developer", createdAt: 1, updatedAt: 1 }] };
    new ConversationsRepository(getTestWorkspace().db).upsertRoom(legacyRoom);
    const local = f.rooms.getRoomMembers(legacyRoom.id)[0];
    const unrelated = f.registry.createMember({ name: local.name });
    const { createBossmodeSdkTools } = await import("../../src/engine/runtime/bossmode-sdk-tools.js");
    const tools = createBossmodeSdkTools({ roomId: legacyRoom.id, memberId: local.id });
    await expect(tools.find(t => t.name === "chat_send")!.execute("legacy-chat", { message: "Existing local tool" }, undefined, undefined, undefined as any)).resolves.toBeTruthy();
    await expect((tools.find(t => t.name === "bossmode")!.execute as any)("legacy-profile", { action: "call", tool: "profile_update", args: { description: "Do not claim DB names" } })).rejects.toThrow("database member ID");
    expect(f.registry.getMember(unrelated.id)!.title).toBeUndefined();
  });

});
