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
  });

  it("send opens the pair scope, captures the peer target, and read/list/info work for both", async () => {
    const reg = await import("../../src/workspace/member-registry.js");
    const { handleToolCallback } = await import("../../src/engine/tools.js");
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
});
