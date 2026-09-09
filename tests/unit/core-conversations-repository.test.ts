import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { conversationsFixture } from "./core-conversations-fixture.js";
import type { Room, Task } from "../../src/shared/types.js";
import type { TopicRecord } from "../../src/workspace/topic-store.js";
import { getRoom, listRooms, getRoomMembersFromRoom, stampGlobalMemberIds, resolveGlobalMemberId, removeRoomMemberByRef,
  getCursors, setCursor, deleteCursor, inviteGlobalMember, updateRoomName, updateRoomPromptLeader, updateRoomDocsPath, updateRoomRuleDocs,
  updateRuleDocPaths, updateRuleDocPathsByPrefix, createRoom, deleteRoom, roomDir } from "../../src/workspace/room-store.js";
import { getTopic, saveTopic, listTopics, resolveTopicRoomId, getTopicById, createTopic, addTopicParticipant,
  resolveOwningRoomId, resolveChatScopeRoomId } from "../../src/workspace/topic-store.js";
import { ensureDmScope } from "../../src/storage/repositories/conversations.js";

let f: ReturnType<typeof conversationsFixture>;
beforeEach(() => { f = conversationsFixture(); });
afterEach(() => { f.close(); });
const topic = (roomId: string): TopicRecord => ({
  id: "topic_original", roomId, title: "历史 日本語 👩🏽‍💻", anchorMessageId: "msg-anchor", anchorSeq: 0,
  createdBy: "旧名字", status: "closed", createdAt: 0, closedAt: 2, seedMode: "fork", summary: "",
  brief: "保留\n空白  ", guideText: "guide", anchorExcerpt: " exact  source ", participants: ["mem_deleted", "unresolved-name"],
});

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

  it("persists canonical scope ownership, explicit DMs, topics and participant source references", () => {
    const room = f.room();
    const t = topic(room.id);
    saveTopic(t);
    expect(ensureDmScope("mem_original")).toBe("dm:mem_original");
    expect(ensureDmScope("mem_original")).toBe("dm:mem_original");
    expect(f.db.all("SELECT id,kind,room_id,member_id FROM scopes ORDER BY id")).toEqual([
      { id: "dm:mem_original", kind: "dm", room_id: null, member_id: "mem_original" },
      { id: room.id, kind: "room", room_id: room.id, member_id: null },
      { id: `topic:${t.id}`, kind: "topic", room_id: room.id, member_id: null },
    ]);
    expect(getTopic(room.id, t.id)).toEqual(t);
    expect(getTopic("wrong-room", t.id)).toBeNull();
    expect(getTopicById(t.id)).toEqual(t);
    expect(resolveTopicRoomId(t.id)).toBe(room.id);
    expect(resolveOwningRoomId(`topic:${t.id}`)).toBe(room.id);
    expect(resolveChatScopeRoomId("dm:mem_original")).toBeNull();
    expect(listTopics(room.id, { status: "active" })).toEqual([]);
    f.reopen();
    expect(getTopicById(t.id)).toEqual(t);
    expect(() => saveTopic({ ...t, roomId: f.room("other-room").id })).toThrow("ownership cannot change");
    expect(getTopicById(t.id)).toEqual(t);
    expect(() => saveTopic({ ...t, id: "orphan", roomId: "missing" })).toThrow();
    expect(f.db.get("SELECT * FROM scopes WHERE id='topic:orphan'")).toBeUndefined();
    expect(() => ensureDmScope("")).toThrow();
    expect(() => f.repository().upsertRoom({ ...room, id: `topic:${t.id}` })).toThrow();
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

  it("creates topics and deduplicates participants without touching message/cursor functions", () => {
    const room = f.room();
    const t = createTopic({ roomId: room.id, title: " Topic ", anchorMessageId: "original-anchor", brief: " Scope " });
    addTopicParticipant(room.id, t.id, "mem_unknown");
    addTopicParticipant(room.id, t.id, "mem_unknown");
    expect(getTopicById(t.id)).toMatchObject({ title: "Topic", brief: "Scope", participants: ["mem_unknown"] });
  });

  it("deletes owned room/topic/task relations, but never member identities or another DM", () => {
    const room = f.room();
    const other = f.room("other");
    f.member("mem_a", "alive");
    ensureDmScope("mem_a");
    f.repository().upsertTopic(topic(room.id));
    f.repository().setCursor(`topic:${topic(room.id).id}`, "mem_a", null);
    f.tasks().upsert({ id: "task", roomId: room.id, title: "t", status: "todo", priority: "P1", createdBy: "user", createdAt: 0, updatedAt: 0,
      subscribers: ["user"], references: ["doc"], comments: [{ id: "c", content: "c", author: "old", createdAt: 0 }] });
    expect(deleteRoom(room.id)).toBe(true);
    expect(deleteRoom(room.id)).toBe(false);
    for (const table of ["tasks", "task_comments", "task_references", "task_subscribers", "topics", "topic_participants", "read_cursors"]) {
      expect(f.db.get<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)!.n).toBe(0);
    }
    expect(f.repository().getRoom(other.id)).not.toBeNull();
    expect(f.db.get("SELECT * FROM members WHERE id='mem_a'")).toBeDefined();
    expect(f.db.get("SELECT * FROM scopes WHERE id='dm:mem_a'")).toBeDefined();
    expect(f.db.all("PRAGMA foreign_key_check")).toEqual([]);
  });
});
