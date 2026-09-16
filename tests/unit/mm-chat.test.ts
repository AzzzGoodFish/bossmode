import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

type Fixture = ReturnType<(typeof import("../helpers/core-fixture.js"))["coreFixture"]>;
let fixture: Fixture;
let dir: string;
beforeEach(async () => {
  vi.resetModules();
  fixture = (await import("../helpers/core-fixture.js")).coreFixture();
  dir = fixture.root;
  mkdirSync(join(dir, "members"), { recursive: true });
  mkdirSync(join(dir, "rooms"), { recursive: true });
});
afterEach(() => fixture.close());

describe("member↔member private chat (⑤ B)", () => {
  it("canonical scope ids round-trip and reject malformed input", async () => {
    const ref = await import("../../src/shared/conversation-ref.js");
    const a = "mem_2a510c12-2357-463a-8546-c0f4ecea406f";
    const b = "mem_eabf18a7-aaaa-bbbb-cccc-dddddddddddd";
    const id = ref.mmScopeIdOf(a, b);
    expect(id).toBe(`mm:${a}-${b}`); // a < b: canonical order puts `a` first
    expect(id).toBe(ref.mmScopeIdOf(b, a));
    expect(ref.parseMmScopeId(id)).toEqual([a, b].sort() as [string, string]);
    expect(ref.parseMmScopeId("mm:mem_a-mem_a")).toBeNull();
    expect(ref.parseMmScopeId("mm:not-a-pair")).toBeNull();
    expect(ref.parseMmScopeId("dm:mem_a")).toBeNull();
    expect(() => ref.mmScopeIdOf("mem_a", "mem_a")).toThrow();
    expect(ref.chatScopeRoomId(id)).toBeNull();

    // Short-id shape regression (批 5 prep): nanoid(10) has no separators, so the
    // second-`mem_` split stays unambiguous for new, old and mixed ids.
    const c = "mem_3kf9q2xz7p";
    const d = "mem_a1b2c3d4e5";
    expect(ref.parseMmScopeId(ref.mmScopeIdOf(c, d))).toEqual([c, d].sort() as [string, string]);
    expect(ref.parseMmScopeId(ref.mmScopeIdOf(a, d))).toEqual([a, d].sort() as [string, string]); // mixed old/new
    expect(ref.parseMmScopeId(`mm:${c}-${a}`)).toBeNull(); // non-canonical order is rejected
  });

  it("send opens the pair scope, captures the peer target, and read/list/info work for both", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const { handleToolCallback } = await import("../../src/agent/tools/tools.js");
    const ref = await import("../../src/shared/conversation-ref.js");
    const alice = reg.createMember({ name: "alice" });
    const bob = reg.createMember({ name: "bob" });
    const carol = reg.createMember({ name: "carol" });
    const scope = ref.mmScopeIdOf(alice.id, bob.id);

    const sent = await handleToolCallback("chat_send", `dm:${alice.id}`, alice.id, { to: bob.id, message: "ping bob" }, { memberId: alice.id }) as any;
    expect(sent.ok).toBe(true);
    expect(sent.chat).toMatchObject({ kind: "mm", id: scope, name: "Private chat with bob" });

    const scopeRow = fixture.db.get<{ kind: string; member_id: string }>("SELECT kind,member_id FROM scopes WHERE id=?", scope);
    expect(scopeRow?.kind).toBe("mm");
    expect(scopeRow?.member_id).toBe([alice.id, bob.id].sort().join("|"));

    // The peer is routed as an ordinary target (pair chat: exactly one recipient).
    const capture = fixture.db.get<{ snapshot_json: string }>(
      "SELECT snapshot_json FROM delivery_captures WHERE scope_id=? ORDER BY rowid DESC LIMIT 1", scope);
    const snapshot = JSON.parse(capture!.snapshot_json);
    expect(snapshot.targets.dm).toEqual([]);
    expect(snapshot.targets.ordinary).toEqual([{ actorKey: bob.id, memberId: bob.id }]);

    // Reading does not need the chat to exist first — but this one does; Bob sees the line.
    const read = await handleToolCallback("chat_read", `dm:${bob.id}`, bob.id, { chat: scope }, { memberId: bob.id }) as any;
    expect(Array.isArray(read)).toBe(true);
    expect(read.map((row: any) => row.content)).toContain("ping bob");

    // Bob replies by member ref; Alice receives the capture target.
    const reply = await handleToolCallback("chat_send", `dm:${bob.id}`, bob.id, { to: alice.id, message: "pong" }, { memberId: bob.id }) as any;
    expect(reply.ok).toBe(true);
    expect(reply.chat.id).toBe(scope); // same canonical scope, no duplicate pair
    expect(fixture.db.get<{ n: number }>("SELECT COUNT(*) n FROM scopes WHERE kind='mm'")!.n).toBe(1);
    const capture2 = fixture.db.get<{ snapshot_json: string }>(
      "SELECT snapshot_json FROM delivery_captures WHERE scope_id=? ORDER BY rowid DESC LIMIT 1", scope);
    expect(JSON.parse(capture2!.snapshot_json).targets.ordinary).toEqual([{ actorKey: alice.id, memberId: alice.id }]);

    const info = await handleToolCallback("chat_info", `dm:${alice.id}`, alice.id, { chat: scope }, { memberId: alice.id }) as any;
    expect(info.chat.kind).toBe("mm");
    expect(info.chat.counterpart).toMatchObject({ id: bob.id, name: "bob" });

    const listed = await handleToolCallback("chat_list", `dm:${bob.id}`, bob.id, {}, { memberId: bob.id }) as any;
    expect(listed.chats.some((c: any) => c.id === scope && c.kind === "mm" && c.name === "Private chat with alice")).toBe(true);

    // Outsiders cannot read the pair chat; chat_edit has nothing to edit; attachments are rejected.
    const denied = await handleToolCallback("chat_read", `dm:${carol.id}`, carol.id, { chat: scope }, { memberId: carol.id }) as any;
    expect(denied.ok).toBe(false);
    const edit = await handleToolCallback("chat_edit", `dm:${alice.id}`, alice.id, { chat: scope, name: "x" }, { memberId: alice.id }) as any;
    expect(edit.ok).toBe(false);
    const attach = await handleToolCallback("chat_send", `dm:${alice.id}`, alice.id, { to: bob.id, message: "x", attachments: ["/tmp/nope.txt"] }, { memberId: alice.id }) as any;
    expect(attach.ok).toBe(false);
    expect(attach.error).toMatch(/not supported/);

    expect(fixture.db.get("PRAGMA foreign_key_check")).toBeUndefined();
  });

  it("first send posts a read-only jump notice into the receiver's user DM; later sends do not duplicate it", async () => {
    const reg = await import("../../src/member/member-registry.js");
    const { handleToolCallback } = await import("../../src/agent/tools/tools.js");
    const chatApi = await import("../../src/api/member-chats.js");
    const ref = await import("../../src/shared/conversation-ref.js");
    const alice = reg.createMember({ name: "alice" });
    const bob = reg.createMember({ name: "bob" });
    const scope = ref.mmScopeIdOf(alice.id, bob.id);

    await handleToolCallback("chat_send", `dm:${alice.id}`, alice.id, { to: bob.id, message: "first" }, { memberId: alice.id });
    await handleToolCallback("chat_send", `dm:${alice.id}`, alice.id, { to: bob.id, message: "second" }, { memberId: alice.id });

    const notices = fixture.db.all<{ sender: string; content: string; extra_json: string }>(
      "SELECT sender,content,extra_json FROM messages WHERE scope_id=? AND sender='system'", `dm:${bob.id}`);
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain("started a private chat");
    expect(JSON.parse(notices[0].extra_json).fields.member_chat_meta).toEqual({ scopeId: scope, fromMemberId: alice.id, toMemberId: bob.id });

    // Members never see the notice; the user's read-only endpoints do.
    const bobDm = await handleToolCallback("chat_read", `dm:${bob.id}`, bob.id, {}, { memberId: bob.id }) as any;
    expect(JSON.stringify(bobDm)).not.toContain("started a private chat");

    const chats = chatApi.listMemberChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].scopeId).toBe(scope);
    expect(chats[0].members.map((m) => m.name).sort()).toEqual(["alice", "bob"]);
    expect(chats[0].messageCount).toBe(2);
    expect(chats[0].lastMessage?.id).toBeTruthy();

    const page = chatApi.readMemberChatMessages(scope, { limit: 1 });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0].content).toBe("second");
    expect(page.hasMore).toBe(true);
    const older = chatApi.readMemberChatMessages(scope, { limit: 10, before: page.messages[0].id });
    expect(older.messages.map((m) => m.content)).toEqual(["first"]);

    chatApi.markMemberChatRead(scope);
    const { getUserReadCursor } = await import("../../src/chat/user-read-cursors.js");
    expect(getUserReadCursor(scope)?.messageId).toBe(page.messages[0].id);
    expect(() => chatApi.readMemberChatMessages("mm:broken", {})).toThrow(/unknown_member_chat/);
  });
});
