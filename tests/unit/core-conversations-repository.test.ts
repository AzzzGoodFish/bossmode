import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { conversationsFixture } from "./core-conversations-fixture.js";
import type { Room, Task } from "../../src/shared/types.js";
import { getRoom, listRooms, getRoomMembersFromRoom, stampGlobalMemberIds, resolveGlobalMemberId, removeRoomMemberByRef,
  getCursors, setCursor, deleteCursor, inviteGlobalMember, updateRoomName, updateRoomPromptLeader, updateRoomDocsPath, updateRoomRuleDocs,
  updateRuleDocPaths, updateRuleDocPathsByPrefix, createRoom, deleteRoom, roomDir } from "../../src/workspace/room-store.js";
import { chatScopeRoomId } from "../../src/shared/conversation-ref.js";
import { ensureDmScope } from "../../src/storage/repositories/conversations.js";

let f: ReturnType<typeof conversationsFixture>;
beforeEach(() => { f = conversationsFixture(); });
afterEach(() => { f.close(); });

describe("normalized conversation authority", () => {
  it("imports modern empty rosters without resurrecting historical shadows or discovering files", () => {
    const room: Room = {
      id: "room-original", name: "房间", cwd: "/historical/workspace", createdAt: 0, members: ["旧名"], globalMemberIds: [],
      roomMembers: [{ id: "rm_old", name: "旧名", sourceAgent: "agent", sourceMemberId: "mem_deleted", createdAt: 0, updatedAt: 3,
        migratedFrom: { memberName: "源名称", memberId: "legacy-source" }, config: { model: "provider/model", extensions: ["opaque-extension"] } }],
      docsPath: "项目/", ruleDocs: [], memberOverrides: { "旧名": { thinkingLevel: "high" } },
      promptLeaderMemberId: "mem_deleted", promptLeaderGlobalMemberId: "mem_deleted",
    };
    f.repository().upsertRoom(room);
    expect(f.repository().getRoom(room.id)).toEqual({ ...room, roomMembers: [{ ...room.roomMembers![0], roomId: room.id }] });
    expect(getRoom(room.id)!.members).toEqual([]);
    expect(getRoomMembersFromRoom(getRoom(room.id)!)).toEqual([]);
    mkdirSync(roomDir("file-only"), { recursive: true });
    writeFileSync(join(roomDir("file-only"), "room.json"), JSON.stringify({ ...room, id: "file-only" }));
    expect(getRoom("file-only")).toBeNull();
    expect(listRooms().map(r => r.id)).toEqual([room.id]);
    expect(f.db.get("SELECT model,credential_id,source_member_id,migrated_id FROM room_member_snapshots")).toMatchObject({ model: "provider/model", source_member_id: "mem_deleted", migrated_id: "legacy-source" });
    f.reopen();
    expect(f.repository().getRoom(room.id)!.roomMembers![0].createdAt).toBe(0);
    expect(f.repository().getRoom(room.id)!.cwd).toBe("/historical/workspace");
  });

  it.each([undefined, [], ["legacy label"]])("keeps names-only and explicitly local membership shapes (%j)", (labels) => {
    const room: Room = { id: "legacy-room", name: "Legacy", members: labels ?? [], createdAt: 1, ...(labels === undefined ? { roomMembers: [] } : {}) };
    f.repository().upsertRoom(room);
    expect(f.repository().getRoom(room.id)).toEqual(room);
    expect(f.repository().getRoom(room.id)).not.toHaveProperty("globalMemberIds");
  });

  it("current names follow stable IDs without attaching reused names to historical records", () => {
    f.member("mem_original", "旧名字", 5);
    const room: Room = { id: "rename-room", name: "Room", members: ["旧名字"], globalMemberIds: ["mem_original"], createdAt: 0,
      roomMembers: [{ id: "rm_historical", name: "旧名字", sourceAgent: "old", createdAt: 0, updatedAt: 1 }] };
    f.repository().upsertRoom(room);
    f.member("mem_original", "新名字", 7);
    f.member("mem_reused", "旧名字", 10);
    expect(getRoom(room.id)!.members).toEqual(["新名字"]);
    expect(listRooms()[0].members).toEqual(["新名字"]);
    expect(getRoomMembersFromRoom(getRoom(room.id)!)[0].createdAt).toBe(5);
    expect(resolveGlobalMemberId({ ...room, globalMemberIds: ["mem_reused"] }, room.roomMembers![0])).toBeNull();
    f.db.run("DELETE FROM members WHERE id='mem_original'");
    expect(getRoom(room.id)!.members).toEqual([]);
    expect(f.repository().getRoom(room.id)!.globalMemberIds).toEqual(["mem_original"]);
    expect(f.repository().getRoom(room.id)!.roomMembers![0].name).toBe("旧名字");
  });

  it("persists canonical scope ownership and explicit DMs", () => {
    const room = f.room();
    expect(ensureDmScope("mem_original")).toBe("dm:mem_original");
    expect(ensureDmScope("mem_original")).toBe("dm:mem_original");
    expect(f.db.all("SELECT id,kind,room_id,member_id FROM scopes ORDER BY id")).toEqual([
      { id: "dm:mem_original", kind: "dm", room_id: null, member_id: "mem_original" },
      { id: room.id, kind: "room", room_id: room.id, member_id: null },
    ]);
    expect(chatScopeRoomId("dm:mem_original")).toBeNull();
    f.reopen();
    expect(f.repository().getRoom(room.id)).not.toBeNull();
    expect(() => ensureDmScope("")).toThrow();
    expect(() => f.repository().upsertRoom({ ...room, id: "room:not-bare" })).toThrow();
  });

  it("creates and edits room metadata without JSON authority or stale path discovery", () => {
    const room = createRoom("项目 房间", "/ignored", [], ["docs/a", "docs/folder/b"]);
    expect(existsSync(join(roomDir(room.id), "room.json"))).toBe(false);
    expect(existsSync(join(roomDir(room.id), "cursors.json"))).toBe(false);
    expect(existsSync(join(roomDir(room.id), "messages.jsonl"))).toBe(false);
    expect(getRoom(room.id)).not.toHaveProperty("cwd");
    updateRoomName(room.id, "新房间");
    expect(updateRuleDocPaths("docs/a", "docs/z")).toBe(1);
    expect(updateRuleDocPathsByPrefix("docs/folder", "docs/renamed")).toBe(1);
    expect(getRoom(room.id)!.ruleDocs).toEqual(["docs/z", "docs/renamed/b"]);
    updateRoomRuleDocs(room.id, []);
    updateRoomDocsPath(room.id, null);
    expect(getRoom(room.id)!.ruleDocs).toBeUndefined();
    expect(getRoom(room.id)!.docsPath).toBeUndefined();
    expect(getRoom(room.id)!.name).toBe("新房间");
    expect(() => updateRoomDocsPath(room.id, "../unsafe")).toThrow();
    expect(() => updateRoomPromptLeader(room.id, "mem_unknown")).toThrow();
  });

  it("retains cursor actor identities and imports original timestamps without a name heuristic", () => {
    f.member("mem_a", "alice");
    const room: Room = { ...f.room(), globalMemberIds: undefined, roomMembers: [
      { id: "rm_explicit", name: "alice", sourceAgent: "general", sourceMemberId: "mem_a", createdAt: 0, updatedAt: 0 },
      { id: "rm_unresolved", name: "alice", sourceAgent: "general", createdAt: 0, updatedAt: 0 },
    ] };
    f.repository().upsertRoom(room);
    f.repository().setCursor(room.id, "rm_explicit", "msg-one", 0);
    setCursor(room.id, "rm_unresolved", "msg-legacy");
    setCursor(room.id, "alice", "msg-ambiguous");
    setCursor(room.id, "mem_a", "msg-current");
    f.db.run("INSERT INTO read_cursors VALUES (?,'user','browser','0',0)", room.id);
    stampGlobalMemberIds(room.id, ["mem_a"], "mem_a");
    expect(getCursors(room.id)).toEqual({ rm_unresolved: "msg-legacy", alice: "msg-ambiguous", mem_a: "msg-current" });
    updateRoomPromptLeader(room.id, null);
    expect(getRoom(room.id)!.promptLeaderGlobalMemberId).toBeUndefined();
    expect(removeRoomMemberByRef(room.id, "mem_a").ok).toBe(true);
    expect(getRoom(room.id)!.globalMemberIds).toEqual([]);
    expect(getRoom(room.id)!.members).toEqual([]);
    expect(getCursors(room.id)).toEqual({ rm_unresolved: "msg-legacy", alice: "msg-ambiguous" });
    deleteCursor(room.id, "alice");
    expect(f.db.get("SELECT value FROM read_cursors WHERE kind='user'")).toMatchObject({ value: "0" });
    expect(() => setCursor("not-a-scope", "mem_a", null)).toThrow();
  });

  it("removes one local member without dropping unlinked peers, configs or cursors", () => {
    const members = ["alice", "bob", "carol"].map((name, i) => ({
      id: `rm_${name}`, roomId: "local-room", name, sourceAgent: "general", createdAt: i, updatedAt: i,
      config: { model: `provider/${name}`, extensions: [" exact ", "duplicate", "duplicate"] },
    }));
    const room: Room = { id: "local-room", name: "Local", members: members.map(m => m.name), roomMembers: members,
      memberOverrides: { bob: { thinkingLevel: "high" } }, createdAt: 0 };
    f.repository().upsertRoom(room);
    members.forEach(m => f.repository().setCursor(room.id, m.id, `msg-${m.name}`, 0));
    f.repository().setCursor(room.id, "alice", "ambiguous-name", 1);
    expect(removeRoomMemberByRef(room.id, "rm_alice").ok).toBe(true);
    expect(f.repository().getRoom(room.id)).toEqual({ ...room, members: ["bob", "carol"], roomMembers: members.slice(1) });
    expect(getRoom(room.id)!.members).toEqual(["bob", "carol"]);
    expect(f.db.all("SELECT actor_key,value,updated_at FROM read_cursors ORDER BY actor_key")).toEqual([
      { actor_key: "alice", value: "ambiguous-name", updated_at: 1 },
      { actor_key: "rm_bob", value: "msg-bob", updated_at: 0 },
      { actor_key: "rm_carol", value: "msg-carol", updated_at: 0 },
    ]);
  });

  it("removes only linked global snapshots and preserves other historical source records", () => {
    f.member("mem_a", "Alice");
    f.member("mem_b", "Bob");
    const room: Room = { ...f.room(), members: ["Alice", "Bob"], globalMemberIds: ["mem_a", "mem_b"],
      roomMembers: [
        { id: "rm_a", roomId: "room-uuid", name: "Old Alice", sourceMemberId: "mem_a", sourceAgent: "old", createdAt: 0, updatedAt: 0 },
        { id: "rm_b", roomId: "room-uuid", name: "Old Bob", sourceMemberId: "mem_b", sourceAgent: "old", createdAt: 0, updatedAt: 0,
          config: { model: "historical/model", contextLimit: 42 }, migratedFrom: { memberName: "source", memberId: "source-id" } },
        { id: "rm_unlinked", roomId: "room-uuid", name: "Alice", sourceAgent: "old", createdAt: 0, updatedAt: 0, config: { thinkingLevel: "high" } },
      ], memberOverrides: { "Old Bob": { model: "historical/override" } } };
    f.repository().upsertRoom(room);
    for (const key of ["mem_a", "mem_b", "rm_b", "rm_unlinked", "Alice"]) f.repository().setCursor(room.id, key, `msg-${key}`, 7);
    expect(removeRoomMemberByRef(room.id, "mem_a").ok).toBe(true);
    expect(f.repository().getRoom(room.id)).toEqual({ ...room, members: ["Bob"], globalMemberIds: ["mem_b"], roomMembers: room.roomMembers!.slice(1) });
    expect(getRoom(room.id)!.members).toEqual(["Bob"]);
    expect(f.db.all("SELECT actor_key,value,updated_at FROM read_cursors ORDER BY actor_key")).toEqual(
      ["Alice", "mem_b", "rm_b", "rm_unlinked"].map(key => ({ actor_key: key, value: `msg-${key}`, updated_at: 7 })),
    );
    f.reopen();
    expect(f.repository().getRoom(room.id)!.roomMembers).toEqual(room.roomMembers!.slice(1));
  });

  it("rejects a direct SQL NULL room key independently of the shared scopes schema", () => {
    expect(() => f.db.run(`INSERT INTO rooms(id,name,created_at,roster_kind,has_local_records,has_rule_docs,has_overrides)
      VALUES (NULL,'invalid',0,'names',0,0,0)`)).toThrow(/NOT NULL constraint failed: rooms.id/);
    expect(f.db.all("SELECT * FROM rooms")).toEqual([]);
  });

  it("rolls back membership and cursor changes together when a cursor write fails", () => {
    const room = f.room();
    f.member("mem_a", "Alice");
    f.db.exec("CREATE TRIGGER fail_cursor BEFORE INSERT ON read_cursors BEGIN SELECT RAISE(ABORT,'cursor failure'); END");
    expect(() => inviteGlobalMember(room.id, { id: "mem_a", name: "ignored", agentTemplate: "general" })).toThrow("cursor failure");
    expect(getRoom(room.id)!.globalMemberIds).toEqual([]);
    f.db.exec("DROP TRIGGER fail_cursor");
    expect(inviteGlobalMember(room.id, { id: "mem_a", name: "ignored", agentTemplate: "general" }).ok).toBe(true);
    f.db.exec("CREATE TRIGGER fail_cursor_delete BEFORE DELETE ON read_cursors BEGIN SELECT RAISE(ABORT,'cursor failure'); END");
    expect(() => removeRoomMemberByRef(room.id, "mem_a")).toThrow("cursor failure");
    expect(getRoom(room.id)!.globalMemberIds).toEqual(["mem_a"]);
    expect(getCursors(room.id)).toEqual({ mem_a: null });
  });

  it("deletes owned room relations, but never member identities or another DM", () => {
    const room = f.room();
    const other = f.room("other");
    f.member("mem_a", "alive");
    ensureDmScope("mem_a");
    f.repository().setCursor(room.id, "mem_a", null);
    f.repository().setCursor("dm:mem_a", "mem_a", null);
    expect(deleteRoom(room.id)).toBe(true);
    expect(deleteRoom(room.id)).toBe(false);
    expect(f.db.get<{ n: number }>("SELECT COUNT(*) n FROM read_cursors WHERE scope_id=?", room.id)!.n).toBe(0);
    expect(f.db.get<{ n: number }>("SELECT COUNT(*) n FROM read_cursors WHERE scope_id='dm:mem_a'")!.n).toBe(1);
    // Task tables are retired and gone from the schema entirely.
    for (const table of ["tasks", "task_comments", "task_references", "task_subscribers"]) {
      expect(f.db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table)).toBeUndefined();
    }
    expect(f.repository().getRoom(other.id)).not.toBeNull();
    expect(f.db.get("SELECT * FROM members WHERE id='mem_a'")).toBeDefined();
    expect(f.db.get("SELECT * FROM scopes WHERE id='dm:mem_a'")).toBeDefined();
    expect(f.db.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
