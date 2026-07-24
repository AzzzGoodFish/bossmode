import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/shared/types.js";

let dir: string;

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => dir,
  ensureBossmodeDir: () => {
    mkdirSync(dir, { recursive: true });
  },
}));

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

async function openFreshDb() {
  const { openDb } = await import("../../src/workspace/db/sqlite.js");
  const { initProjection } = await import("../../src/workspace/db/projection.js");
  // initProjection registers the process-level db so getProjectionDb() returns it.
  initProjection();
  return openDb();
}

describe("tasks-index (S3)", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bossmode-s3-tasks-"));
    vi.resetModules();
  });

  afterEach(async () => {
    const { resetDbCache } = await import("../../src/workspace/db/sqlite.js");
    resetDbCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it("syncRoomTasks upserts rows and queryRoomTasks returns list items + total", async () => {
    await openFreshDb();
    const { syncRoomTasks, queryRoomTasks } = await import("../../src/workspace/db/tasks-index.js");
    syncRoomTasks("room-a", [
      task("task-1", { status: "todo", assignee: "dev-ben" }),
      task("task-2", { status: "in-progress", assignee: "developer" }),
      task("task-3", { status: "done", assignee: "dev-ben", comments: [{ id: "c1", author: "x", content: "y", createdAt: 1 }] as any }),
    ]);

    const all = queryRoomTasks("room-a", {})!;
    expect(all.total).toBe(3);
    expect(all.tasks.length).toBe(3);
    // commentCount derived from payload, comments body stripped.
    const t3 = all.tasks.find((t) => t.id === "task-3")!;
    expect(t3.commentCount).toBe(1);
    expect((t3 as Record<string, unknown>).comments).toBeUndefined();
  });

  it("filters by status and assignee", async () => {
    await openFreshDb();
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
    await openFreshDb();
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
    await openFreshDb();
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

  it("prunes rows for tasks removed from the file (delete semantics)", async () => {
    await openFreshDb();
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
    await openFreshDb();
    const { syncRoomTasks, queryRoomTasks } = await import("../../src/workspace/db/tasks-index.js");
    syncRoomTasks("room-a", [task("task-1")]);
    syncRoomTasks("room-b", [task("task-9", { roomId: "room-b" })]);
    expect(queryRoomTasks("room-a", {})!.total).toBe(1);
    expect(queryRoomTasks("room-b", {})!.total).toBe(1);
    expect(queryRoomTasks("room-a", {})!.tasks[0].id).toBe("task-1");
  });
});
