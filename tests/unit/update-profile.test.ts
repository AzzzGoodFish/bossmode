import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setupConfigMock, getTestBossmodeDir } from "../helpers/test-server.js";
setupConfigMock();

async function fixture() {
  const registry = await import("../../src/workspace/member-registry.js");
  const rooms = await import("../../src/workspace/room-store.js");
  const { waitForProjectionInitialization } = await import("../../src/workspace/db/projection.js");
  const suffix = randomUUID().slice(0, 8);
  const own = registry.createMember({ name: `Self-${suffix}`, title: "Before" });
  await waitForProjectionInitialization();
  const peer = registry.createMember({ name: `Peer-${suffix}` });
  const room = rooms.createRoom(`Room-${suffix}`, undefined, []);
  rooms.stampGlobalMemberIds(room.id, [own.id, peer.id]);
  const { handleToolCallback } = await import("../../src/engine/tools.js");
  const call = (tool: string, params: any, scope = room.id) => handleToolCallback(tool, scope, own.name, params, { memberId: own.id });
  return { registry, rooms, own, peer, room, call };
}

describe("self-only update_profile", () => {
  it("atomically updates normalized DB identity, clears title, and preserves persona/configuration", async () => {
    const f = await fixture();
    const path = join(getTestBossmodeDir(), "members", f.own.id, "persona.md");
    const bytes = "\uFEFF\r\n---\r\nname: literal content\r\n---\r\n  unchanged  \r\n";
    writeFileSync(path, bytes);
    const name = `言实 β ${randomUUID().slice(0, 6)}`;
    expect(await f.call("update_profile", { name: ` ${name} `, title: " Engineer " })).toEqual({ ok: true, memberId: f.own.id, name, title: "Engineer", changed: true });
    const saved = f.registry.getMember(f.own.id)!;
    expect(saved.global).toEqual(f.own.global);
    expect(await f.call("update_profile", { name, title: "Engineer" })).toMatchObject({ changed: false });
    expect(f.registry.getMember(f.own.id)!.updatedAt).toBe(saved.updatedAt);
    expect(await f.call("update_profile", { title: "" })).toMatchObject({ name, title: null, changed: true });
    expect(readFileSync(path, "utf8")).toBe(bytes);
    const { resetDbCache } = await import("../../src/workspace/db/sqlite.js");
    resetDbCache();
    expect(f.registry.getMember(f.own.id)).toMatchObject({ name });
    expect(f.registry.getMember(f.own.id)!.title).toBeUndefined();
  });

  it("rejects target injection, malformed/empty patches and collisions without partial writes", async () => {
    const f = await fixture();
    for (const patch of [{}, { memberId: f.peer.id, title: "stolen" }, { name: null }, { title: null }, { name: 4 }, { title: [] }, { name: "  " }, { name: "invalid/path", title: "bad" }, { name: "ALL" }, { name: " User " }, { name: "system" }]) {
      expect(await f.call("update_profile", patch)).toMatchObject({ ok: false, code: "invalid_profile" });
      expect(f.registry.getMember(f.own.id)).toEqual(f.own);
    }
    expect(await f.call("update_profile", { name: f.peer.name.toUpperCase(), title: "partial" })).toMatchObject({ ok: false, code: "name_taken" });
    expect(f.registry.getMember(f.own.id)).toEqual(f.own);
    expect(f.registry.getMember(f.peer.id)).toEqual(f.peer);
    for (const name of ["all", "USER", " System "]) expect(() => f.registry.createMember({ name })).toThrow("reserved_member_name");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    expect(await handleToolCallback("update_profile", f.room.id, f.own.name, { title: "bad" })).toMatchObject({ ok: false, code: "invalid_caller" });
    expect(await f.call("update_profile", { title: "bad" }, `dm:${f.peer.id}`)).toMatchObject({ ok: false, code: "scope_access_denied" });
  });

  it("keeps room/DM/topic and subsequent SDK calls bound to caller ID through two renames and name reuse", async () => {
    const f = await fixture();
    const { createTopic } = await import("../../src/workspace/topic-store.js");
    const topic = createTopic({ roomId: f.room.id, title: "Identity", createdBy: f.own.id } as any);
    const { createBossmodeSdkTools } = await import("../../src/engine/runtime/bossmode-sdk-tools.js");
    const { loadScopeMessages, handleToolCallback } = await import("../../src/engine/tools.js");
    const scopes = [f.room.id, `dm:${f.own.id}`, `topic:${topic.id}`];
    const toolSets = scopes.map(roomId => createBossmodeSdkTools({ roomId, memberId: f.own.id }));
    await f.call("chat", { message: "historical snapshot" });
    const originalName = f.own.name;
    const next = `New ${randomUUID().slice(0, 6)}`;
    await f.call("update_profile", { name: next });
    const { updateProfileForMember } = await import("../../src/engine/member-profile-update.js");
    updateProfileForMember(f.peer.id, { name: originalName });
    for (const tools of toolSets) {
      await (tools.find(t => t.name === "chat")!.execute as any)("chat-id", { message: "after rename" });
      const profile = await (tools.find(t => t.name === "update_profile")!.execute as any)("profile-id", { title: "Self only" });
      expect(JSON.stringify(profile)).toContain(f.own.id);
    }
    for (const scope of scopes) {
      const last = loadScopeMessages(scope).at(-1)!;
      expect(last.sender).toBe(next);
      expect(last.senderMemberId).toBe(f.own.id);
      expect(await handleToolCallback("background_status", scope, originalName, {}, { memberId: f.own.id, execution: "background" })).toMatchObject({ ok: true });
    }
    expect(loadScopeMessages(f.room.id)[0].sender).toBe(originalName);
    expect(f.registry.getMember(f.peer.id)!.title).toBeUndefined();
    await f.call("update_profile", { name: `${next}-again` });
    expect(await f.call("workspace_list", {})).toMatchObject({ ok: true });
    expect(await f.call("list_scopes", {})).toMatchObject({ ok: true });
  });

  it("rolls back both fields when SQLite rejects the write, and one contender wins a collision", async () => {
    const f = await fixture();
    const { openDb } = await import("../../src/workspace/db/sqlite.js");
    openDb().exec("CREATE TEMP TRIGGER fail_profile BEFORE UPDATE ON members BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    try { expect(await f.call("update_profile", { name: "failed-name", title: "failed-title" })).toMatchObject({ ok: false, code: "persistence_failed" }); }
    finally { openDb().exec("DROP TRIGGER fail_profile"); }
    expect(f.registry.getMember(f.own.id)).toEqual(f.own);
    const target = `Collision-${randomUUID()}`;
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const results = await Promise.all([
      f.call("update_profile", { name: target }),
      handleToolCallback("update_profile", f.room.id, f.peer.name, { name: target.toUpperCase(), title: "must roll back" }, { memberId: f.peer.id }),
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
    const stop = router.initRouter((_scope, id, ctx) => { captured = { id, ctx }; }, () => {});
    try {
      await f.call("chat", { message: `@${f.peer.name} please reply`, need_response: [f.peer.name] });
      expect(captured).toMatchObject({ id: f.peer.id, ctx: { needResponseMemberIds: [f.peer.id] } });
      const originalContext = captured.ctx;
      const { updateProfileForMember } = await import("../../src/engine/member-profile-update.js");
      const { waitForMember, isMemberWaiting } = await import("../../src/engine/wait-wait.js");
      const { postMessage } = await import("../../src/communication/message-bus.js");
      const pending = waitForMember({ roomId: f.room.id, waiterMemberId: f.own.id, waiterName: f.own.name, targetMemberId: f.peer.id, targetName: f.peer.name, targetStatus: "working", timeoutMinutes: 1 });
      await f.call("update_profile", { name: next });
      updateProfileForMember(f.peer.id, { name: f.own.name });
      const roster = f.rooms.getRoomMembers(f.room.id);
      expect(router.parseMentionMemberIds(`@${next}`, roster)).toEqual([f.own.id]);
      expect(router.parseMentionMemberIds(`@${f.own.name}`, roster)).toEqual([f.peer.id]);
      expect(router.parseMentionMemberIds(`\`@all\` @${next}-unknown`, roster)).toEqual([]);
      expect(router.parseUrgentMentionMemberIds(`!${next}`, roster)).toEqual([f.own.id]);
      expect(router.parseUrgentMentionMemberIds(`word!${next}`, roster)).toEqual([]);
      expect(router.parseMentions("@foo`bar`", ["foo", "foo`bar`"])).toEqual(["foo`bar`"]);
      expect(router.parseMentions("`@foo`", ["foo"])).toEqual([]);
      postMessage(f.room.id, "user", "old name now targets another member", [f.own.name], { mentionMemberIds: [f.peer.id] });
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(isMemberWaiting(f.room.id, f.own.id)).toBe(true);
      postMessage(f.room.id, f.own.name, "target answered", [], { senderMemberId: f.peer.id });
      expect(await pending).toMatchObject({ ok: true, reason: "message", target: f.own.name });
      expect(originalContext.needResponseMemberIds).toEqual([f.peer.id]);
    } finally { stop(); const { settleWaitOnAbort } = await import("../../src/engine/wait-wait.js"); settleWaitOnAbort(f.room.id, f.own.id); }
  });

  it("creates rooms with current Unicode identity and keeps historical template tools ID-bound", async () => {
    const f = await fixture();
    const { updateProfileForMember } = await import("../../src/engine/member-profile-update.js");
    const pending = f.call("create_room", { name: "Creator race", memberIds: [f.peer.id] }, `dm:${f.own.id}`);
    const next = `创建者 ${randomUUID().slice(0, 6)}`;
    updateProfileForMember(f.own.id, { name: next });
    expect(await pending).toMatchObject({ ok: true, leader: next, leaderMemberId: f.own.id });
    const legacyRoom = f.rooms.createRoom("Historical room", undefined, [{ agent: "developer", name: "Historical-template" }]);
    const local = f.rooms.getRoomMembers(legacyRoom.id)[0];
    const unrelated = f.registry.createMember({ name: local.name });
    const { createBossmodeSdkTools } = await import("../../src/engine/runtime/bossmode-sdk-tools.js");
    const tools = createBossmodeSdkTools({ roomId: legacyRoom.id, memberId: local.id });
    await expect(tools.find(t => t.name === "chat")!.execute("legacy-chat", { message: "Existing local tool" }, undefined, undefined, undefined as any)).resolves.toBeTruthy();
    await expect(tools.find(t => t.name === "update_profile")!.execute("legacy-profile", { title: "Do not claim DB names" }, undefined, undefined, undefined as any)).rejects.toThrow("database member ID");
    expect(f.registry.getMember(unrelated.id)!.title).toBeUndefined();
  });

  it("keeps creator subscription on the caller when its name looks like another member ID", async () => {
    const f = await fixture();
    f.rooms.stampGlobalMemberIds(f.room.id, [f.peer.id, f.own.id]);
    await f.call("update_profile", { name: f.peer.id });
    const result: any = await f.call("create_task", { title: "ID-shaped creator name" });
    expect(result.ok).toBe(true);
    const { getTask } = await import("../../src/workspace/task-store.js");
    const task = getTask(f.room.id, result.taskId)!;
    expect(task.createdBy).toBe(f.peer.id);
    expect(task.subscriberMemberIds).toEqual([f.own.id]);
  });

});
