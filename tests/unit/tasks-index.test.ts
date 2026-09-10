import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Task } from "../../src/shared/types.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { coreFixture } from "../helpers/core-fixture.js";
let fixture: ReturnType<typeof coreFixture>;

function task(id: string, over: Partial<Task> = {}): Task {
  const now = Date.parse("2026-07-24T00:00:00Z");
  return {
    id,
    roomId: "room-a",
    title: `Task ${id}`,
    status: "todo",
    priority: "P1",
    comments: [],
    subscribers: [],
    subscriberMemberIds: [],
    createdBy: "user",
    createdAt: now,
    updatedAt: now,
    ...over,
  } as Task;
}

describe("authoritative task queries", () => {
  beforeEach(() => {
    fixture = coreFixture();
    for (const id of ["room-a", "room-b"]) new ConversationsRepository().upsertRoom({ id, name: id, members: [], createdAt: 1 });
  });
  afterEach(() => { fixture.close(); });

  it("syncRoomTasks upserts rows and queryRoomTasks returns list items + total", async () => {
    const { syncRoomTasks, queryRoomTasks } = await import("../../src/workspace/db/tasks-index.js");
    syncRoomTasks("room-a", [
      task("task-1", { status: "todo", assignee: "dev-ben" }),
      task("task-2", { status: "in-progress", assignee: "developer" }),
      task("task-3", { status: "done", assignee: "dev-ben", comments: [{ id: "c1", author: "x", content: "y", createdAt: 1 }] as any }),
    ]);

    const all = queryRoomTasks("room-a", {})!;
    expect(all.total).toBe(3);
    expect(all.tasks.length).toBe(3);
    // commentCount derived from normalized comments, comments body stripped.
    const t3 = all.tasks.find((t) => t.id === "task-3")!;
    expect(t3.commentCount).toBe(1);
    expect((t3 as Record<string, unknown>).comments).toBeUndefined();
  });

  it("rejects missing or mismatched live task ownership without pruning existing facts", async () => {
    const { syncRoomTasks, queryRoomTasks } = await import("../../src/workspace/db/tasks-index.js");
    syncRoomTasks("room-a", [task("kept")]);
    for (const roomId of [undefined, "room-b"]) {
      expect(() => syncRoomTasks("room-a", [task("new"), task("bad", { roomId })])).toThrow("ownership mismatch");
      expect(queryRoomTasks("room-a", {}).tasks.map(t => t.id)).toEqual(["kept"]);
    }
  });

  it("filters by status and assignee", async () => {
    const { syncRoomTasks, queryRoomTasks } = await import("../../src/workspace/db/tasks-index.js");
    syncRoomTasks("room-a", [
      task("task-1", { status: "todo", assignee: "dev-ben" }),
      task("task-2", { status: "done", assignee: "dev-ben" }),
      task("task-3", { status: "done", assignee: "developer" }),
    ]);

    expect(queryRoomTasks("room-a", { status: "done" })!.total).toBe(2);
    expect(queryRoomTasks("room-a", { assignee: "dev-ben" })!.total).toBe(2);
    expect(queryRoomTasks("room-a", { status: "done", assignee: "dev-ben" })!.total).toBe(1);
  });

  it("q filters by title substring", async () => {
    const { syncRoomTasks, queryRoomTasks } = await import("../../src/workspace/db/tasks-index.js");
    syncRoomTasks("room-a", [
      task("task-1", { title: "SQLite base" }),
      task("task-2", { title: "Activity index" }),
    ]);
    const r = queryRoomTasks("room-a", { q: "activity" })!;
    expect(r.total).toBe(1);
    expect(r.tasks[0].id).toBe("task-2");
  });

  it("paginates with limit/offset, total is unfiltered by page", async () => {
    const { syncRoomTasks, queryRoomTasks } = await import("../../src/workspace/db/tasks-index.js");
    const now = Date.parse("2026-07-24T00:00:00Z");
    syncRoomTasks("room-a", [0, 1, 2, 3, 4].map((i) => task(`task-${i}`, { updatedAt: now + i * 1000 })));
    const page1 = queryRoomTasks("room-a", { limit: 2, offset: 0 })!;
    expect(page1.total).toBe(5);
    expect(page1.tasks.length).toBe(2);
    // Newest updated first.
    expect(page1.tasks[0].id).toBe("task-4");
    const page2 = queryRoomTasks("room-a", { limit: 2, offset: 2 })!;
    expect(page2.tasks.map((t) => t.id)).toEqual(["task-2", "task-1"]);
  });

  it("prunes only explicitly replaced room tasks", async () => {
    const { syncRoomTasks, queryRoomTasks } = await import("../../src/workspace/db/tasks-index.js");
    syncRoomTasks("room-a", [task("task-1"), task("task-2"), task("task-3")]);
    expect(queryRoomTasks("room-a", {})!.total).toBe(3);
    // Re-sync with task-2 removed.
    syncRoomTasks("room-a", [task("task-1"), task("task-3")]);
    const r = queryRoomTasks("room-a", {})!;
    expect(r.total).toBe(2);
    expect(r.tasks.map((t) => t.id).sort()).toEqual(["task-1", "task-3"]);
  });

  it("scopes rows per room", async () => {
    const { syncRoomTasks, queryRoomTasks } = await import("../../src/workspace/db/tasks-index.js");
    syncRoomTasks("room-a", [task("task-1")]);
    syncRoomTasks("room-b", [task("task-9", { roomId: "room-b" })]);
    expect(queryRoomTasks("room-a", {})!.total).toBe(1);
    expect(queryRoomTasks("room-b", {})!.total).toBe(1);
    expect(queryRoomTasks("room-a", {})!.tasks[0].id).toBe("task-1");
  });
});
