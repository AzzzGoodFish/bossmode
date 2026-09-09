import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { conversationsFixture } from "./core-conversations-fixture.js";
import type { Task } from "../../src/shared/types.js";
import { createTask, getTask, listTasks, listTaskSummaries, listAllTasks, updateTask, addTaskComment, deleteTask, taskMatchesAssignee } from "../../src/workspace/task-store.js";
import { queryRoomTasks, syncRoomTasks } from "../../src/workspace/db/tasks-index.js";
import { roomDir } from "../../src/workspace/room-store.js";

let f: ReturnType<typeof conversationsFixture>;
beforeEach(() => { f = conversationsFixture(); f.room(); });
afterEach(() => { f.close(); });
const sourceTask = (id = "task-original"): Task => ({
  id, roomId: "room-uuid", title: " 中文 日本語 👋 ", status: "review", priority: "P0",
  assignee: "旧名称", assigneeMemberId: "mem_original", description: "\n exact source \n",
  createdBy: "历史创建者", createdAt: 0, updatedAt: 0,
  references: ["docs/测试", "https://example.test/#原始"],
  subscribers: ["user", "unresolved historical", "旧名称"], subscriberMemberIds: ["mem_original", "mem_deleted"],
  comments: [{ id: "comment-original", author: "历史作者", content: "\n original bytes \n", createdAt: 0 }],
});

describe("normalized task authority", () => {
  it("replaces only the old projection schema and preserves original IDs/times/source fields on import and restart", () => {
    expect(f.db.get("SELECT * FROM tasks WHERE task_id='projection'")).toBeUndefined();
    expect(f.db.all<{ name: string }>("PRAGMA table_info(tasks)").map(r => r.name)).not.toContain("payload_json");
    const original = sourceTask();
    f.tasks().importTasks(original.roomId, [original]);
    f.tasks().importTasks(original.roomId, [original]);
    expect(f.tasks().get(original.roomId, original.id)).toEqual(original);
    expect(f.db.get("SELECT kind,value FROM task_subscribers WHERE kind='human'")).toMatchObject({ kind: "human", value: "user" });
    expect(f.db.get("SELECT assignee,assignee_member_id FROM tasks")).toMatchObject({ assignee: "旧名称", assignee_member_id: "mem_original" });
    f.reopen();
    expect(f.tasks().get(original.roomId, original.id)).toEqual(original);
    expect(f.db.get<{ n: number }>("SELECT COUNT(*) n FROM task_comments")!.n).toBe(1);
    expect(f.db.all("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("keeps arrays independent, optional empty values and same task IDs in different owning rooms", () => {
    const t = { ...sourceTask(), assigneeMemberId: undefined, references: [], subscriberMemberIds: [], description: "" };
    f.tasks().upsert(t);
    const other = f.room("other-room");
    f.tasks().upsert({ ...t, roomId: other.id, references: undefined, title: "other" });
    expect(f.tasks().get(t.roomId, t.id)).toMatchObject({ subscribers: t.subscribers, subscriberMemberIds: [], references: [], description: "" });
    expect(f.tasks().get(other.id, t.id)).not.toHaveProperty("references");
    expect(f.tasks().get("wrong-room", t.id)).toBeNull();
    expect(() => f.tasks().importTasks(t.roomId, [{ ...t, roomId: other.id }])).toThrow("ownership mismatch");
    expect(f.tasks().get(other.id, t.id)!.title).toBe("other");
  });

  it("keeps current labels separate from immutable historical task/comment snapshots and old-name reuse", () => {
    f.member("mem_original", "旧名称");
    f.member("mem_other", "bob");
    f.repository().upsertRoom({ ...f.room(), globalMemberIds: ["mem_original", "mem_other"] });
    const original = sourceTask();
    const legacy = { ...sourceTask("legacy"), assigneeMemberId: undefined, subscriberMemberIds: [] };
    f.tasks().importTasks(original.roomId, [original, legacy]);
    f.member("mem_original", "新名称");
    f.member("mem_reused", "旧名称");
    f.repository().upsertRoom({ ...f.repository().getRoom(original.roomId)!, globalMemberIds: ["mem_original", "mem_other", "mem_reused"] });
    for (const t of [getTask(original.roomId, original.id)!, listTasks(original.roomId)[0], listTaskSummaries(original.roomId)[0], listAllTasks().find(t => t.id === original.id)!, queryRoomTasks(original.roomId, {}).tasks.find(t => t.id === original.id)!]) {
      expect(t).toMatchObject({ assignee: "新名称", subscribers: ["user", "新名称", "mem_deleted"], createdBy: original.createdBy, createdAt: 0 });
    }
    expect(getTask(original.roomId, original.id)!.comments).toEqual(original.comments);
    expect(getTask(original.roomId, legacy.id)).toMatchObject({ assignee: "旧名称", subscribers: original.subscribers, subscriberMemberIds: [] });
    expect(queryRoomTasks(original.roomId, { assignee: "旧名称" }).tasks).toEqual([]);
    expect(taskMatchesAssignee(original.roomId, legacy, "旧名称")).toBe(false);
    expect(queryRoomTasks(original.roomId, { assignee: "新名称" }).tasks.map(t => t.id)).toEqual([original.id]);
    expect(queryRoomTasks(original.roomId, { assignee: "mem_original" }).tasks.map(t => t.id)).toEqual([original.id]);
    updateTask(original.roomId, original.id, { title: "unrelated" });
    addTaskComment(original.roomId, original.id, { author: "新名称", content: " now " });
    expect(f.tasks().get(original.roomId, original.id)).toMatchObject({ assignee: original.assignee, subscribers: original.subscribers, createdBy: original.createdBy });
    expect(getTask(original.roomId, original.id)!.comments!.map(c => c.author)).toEqual(["历史作者", "新名称"]);
    f.db.run("DELETE FROM members WHERE id='mem_original'");
    expect(getTask(original.roomId, original.id)!.assignee).toBe("mem_original");
    expect(queryRoomTasks(original.roomId, { assignee: "mem_original" }).total).toBe(1);
    expect(f.tasks().get(original.roomId, original.id)!.assignee).toBe("旧名称");
  });

  it("applies status/assignee/search filtering before pagination with comment-free summaries", () => {
    f.member("mem_original", "Current");
    f.repository().upsertRoom({ ...f.room(), globalMemberIds: ["mem_original"] });
    const tasks = Array.from({ length: 6 }, (_, i) => ({ ...sourceTask(`task-${i}`), updatedAt: i, status: (i === 5 ? "done" : "review") as Task["status"] }));
    f.tasks().importTasks("room-uuid", tasks);
    const result = queryRoomTasks("room-uuid", { status: "review", assignee: "Current", q: " 中文 ", limit: 2, offset: 1 });
    expect(result.total).toBe(5);
    expect(result.tasks.map(t => t.id)).toEqual(["task-3", "task-2"]);
    expect(result.tasks[0]).toMatchObject({ assignee: "Current", commentCount: 1 });
    expect(result.tasks[0]).not.toHaveProperty("comments");
    expect(listAllTasks({ status: "done", query: "日本語" }).map(t => t.id)).toEqual(["task-5"]);
    expect(listTasks("room-uuid").map(t => t.id)).toEqual(tasks.map(t => t.id));
  });

  it("preserves omitted participants, clears both assignee fields explicitly and supports passive human subscriptions", () => {
    f.member("mem_a", "Alice");
    f.repository().upsertRoom({ ...f.room(), globalMemberIds: ["mem_a"] });
    const task = createTask("room-uuid", { title: " New task ", createdBy: "Alice", assignee: "Alice", assigneeMemberId: "mem_a", subscribers: ["user", "user"] });
    expect(task).toMatchObject({ title: "New task", subscribers: ["user", "Alice"], subscriberMemberIds: ["mem_a"] });
    const initial = f.tasks().get(task.roomId, task.id)!;
    expect(updateTask(task.roomId, task.id, { assignee: undefined, assigneeMemberId: undefined })).toMatchObject({ assigneeMemberId: "mem_a" });
    expect(f.tasks().get(task.roomId, task.id)).toMatchObject({ subscribers: initial.subscribers, subscriberMemberIds: initial.subscriberMemberIds });
    for (const clear of [{ assignee: null }, { assigneeMemberId: null }]) {
      updateTask(task.roomId, task.id, { assignee: "Alice", assigneeMemberId: "mem_a" });
      const cleared = updateTask(task.roomId, task.id, clear)!;
      expect(cleared.assignee).toBeUndefined();
      expect(cleared.assigneeMemberId).toBeUndefined();
      expect(queryRoomTasks(task.roomId, { assignee: "mem_a" }).total).toBe(0);
      expect(f.db.get("SELECT assignee,assignee_member_id FROM tasks WHERE task_id=?", task.id)).toMatchObject({ assignee: null, assignee_member_id: null });
    }
    expect(updateTask(task.roomId, task.id, { subscribers: ["user"], subscriberMemberIds: [] })).toMatchObject({ subscribers: ["user"], subscriberMemberIds: [] });
    expect(updateTask(task.roomId, task.id, { subscribers: [], subscriberMemberIds: [], references: [], description: "" })).toMatchObject({ subscribers: [], subscriberMemberIds: [], references: [], description: "" });
    expect(f.db.all("SELECT * FROM outbox")).toEqual([]); // B stores never activate or dispatch; parent composes notification records.
  });

  it("propagates DB failures and rolls back entire task/relations changes and importer batches", () => {
    const t = sourceTask();
    f.tasks().upsert(t);
    f.db.exec("CREATE TRIGGER fail_comments BEFORE INSERT ON task_comments WHEN NEW.content='fail' BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    expect(() => f.tasks().upsert({ ...t, title: "must rollback", references: [], comments: [{ id: "failure", author: "user", content: "fail", createdAt: 1 }] })).toThrow("injected failure");
    expect(f.tasks().get(t.roomId, t.id)).toEqual(t);
    expect(() => addTaskComment(t.roomId, t.id, { author: "user", content: "fail" })).toThrow("injected failure");
    expect(f.tasks().get(t.roomId, t.id)).toEqual(t);
    expect(() => f.tasks().importTasks(t.roomId, [{ ...t, id: "batch-one" }, { ...t, id: "bad", priority: "P99" as Task["priority"] }])).toThrow();
    expect(f.tasks().get(t.roomId, "batch-one")).toBeNull();
    f.db.exec("PRAGMA query_only=ON");
    expect(() => updateTask(t.roomId, t.id, { title: "read-only" })).toThrow();
    f.db.exec("PRAGMA query_only=OFF");
    expect(f.tasks().get(t.roomId, t.id)).toEqual(t);
  });

  it("supports parent transaction composition without independent commits or a hidden file source", () => {
    const t = sourceTask();
    f.tasks().upsert(t);
    expect(() => f.db.transaction(() => {
      updateTask(t.roomId, t.id, { status: "done" });
      f.db.run("INSERT INTO outbox(kind,dedupe_key,payload_json,created_at) VALUES ('task','dedupe','{}',0)");
      throw new Error("parent service failure");
    })).toThrow("parent service failure");
    expect(f.tasks().get(t.roomId, t.id)).toEqual(t);
    expect(f.db.all("SELECT * FROM outbox")).toEqual([]);
    mkdirSync(roomDir(t.roomId), { recursive: true });
    const legacy = join(roomDir(t.roomId), "tasks.json");
    writeFileSync(legacy, JSON.stringify([{ ...t, title: "file must not win" }]));
    expect(getTask(t.roomId, t.id)!.title).toBe(t.title);
    expect(deleteTask(t.roomId, t.id)).toBe(true);
    expect(deleteTask(t.roomId, t.id)).toBe(false);
    expect(listTasks(t.roomId)).toEqual([]);
    expect(existsSync(legacy)).toBe(true); // Actual retirement is the parent's importer responsibility.
    expect(f.db.all("SELECT * FROM task_comments")).toEqual([]);
  });

  it("retains explicit replacement semantics without pruning another room or resurrecting dropped tasks", () => {
    const t = sourceTask();
    f.tasks().upsert(t);
    const other = f.room("other-room");
    f.tasks().upsert({ ...t, roomId: other.id });
    syncRoomTasks(t.roomId, [{ ...t, id: "replacement" }]);
    expect(f.tasks().list(t.roomId).map(t => t.id)).toEqual(["replacement"]);
    syncRoomTasks(t.roomId, []);
    expect(listTasks(t.roomId)).toEqual([]);
    expect(f.tasks().list(other.id)).toHaveLength(1);
    expect(updateTask(t.roomId, "missing", { title: "x" })).toBeNull();
    expect(addTaskComment(t.roomId, "missing", { author: "user", content: "x" })).toBeNull();
    expect(() => addTaskComment(other.id, t.id, { author: "user", content: "  " })).toThrow("comment is required");
    expect(() => addTaskComment(other.id, t.id, { author: "  ", content: "x" })).toThrow("author is required");
  });
});
