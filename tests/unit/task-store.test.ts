import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir = "";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bossmode-task-test-"));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => tmpDir,
  ensureBossmodeDir: () => {},
  writePidFile: () => {},
  removePidFile: () => {},
  readConfig: () => ({ auth: {}, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 } }),
  configExists: () => true,
}));

function ensureRoom(roomId: string) {
  const dir = join(tmpDir, "rooms", roomId);
  mkdirSync(dir, { recursive: true });
  const roomJson = join(dir, "room.json");
  writeFileSync(roomJson, JSON.stringify({
    id: roomId, name: `Room ${roomId}`, cwd: "/tmp", members: ["pm"], createdAt: Date.now(),
  }), "utf-8");
}

describe("task-store", () => {
  it("creates a task with all fields", async () => {
    const { createTask, getTask } = await import("../../src/workspace/task-store.js");
    ensureRoom("r1");
    const task = createTask("r1", { title: "Design API", createdBy: "pm", priority: "P0", assignee: "architect" });
    expect(task.id).toMatch(/^task-/);
    expect(task.title).toBe("Design API");
    expect(task.status).toBe("todo");
    expect(task.priority).toBe("P0");
    expect(task.assignee).toBe("architect");
    expect(task.createdBy).toBe("pm");
    expect(task.roomId).toBe("r1");

    const found = getTask("r1", task.id);
    expect(found).not.toBeNull();
    expect(found!.title).toBe("Design API");
  });

  it("lists tasks for a room", async () => {
    const { createTask, listTasks } = await import("../../src/workspace/task-store.js");
    ensureRoom("r2");
    createTask("r2", { title: "Task A", createdBy: "pm" });
    createTask("r2", { title: "Task B", createdBy: "pm" });
    const tasks = listTasks("r2");
    expect(tasks.length).toBe(2);
  });

  it("updates a task", async () => {
    const { createTask, updateTask, getTask } = await import("../../src/workspace/task-store.js");
    ensureRoom("r3");
    const task = createTask("r3", { title: "Original", createdBy: "pm" });
    const updated = updateTask("r3", task.id, { title: "Updated", status: "in-progress" });
    expect(updated).not.toBeNull();
    expect(updated!.title).toBe("Updated");
    expect(updated!.status).toBe("in-progress");
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(task.updatedAt);

    const found = getTask("r3", task.id);
    expect(found!.status).toBe("in-progress");
  });

  it("deletes a task", async () => {
    const { createTask, deleteTask, getTask } = await import("../../src/workspace/task-store.js");
    ensureRoom("r4");
    const task = createTask("r4", { title: "To delete", createdBy: "pm" });
    expect(deleteTask("r4", task.id)).toBe(true);
    expect(getTask("r4", task.id)).toBeNull();
  });

  it("delete returns false for missing task", async () => {
    const { deleteTask } = await import("../../src/workspace/task-store.js");
    ensureRoom("r5");
    expect(deleteTask("r5", "nonexistent")).toBe(false);
  });

  it("listAllTasks aggregates across rooms", async () => {
    const { createTask, listAllTasks } = await import("../../src/workspace/task-store.js");
    ensureRoom("r6");
    ensureRoom("r7");
    createTask("r6", { title: "Room 6 task", createdBy: "pm" });
    createTask("r7", { title: "Room 7 task", createdBy: "pm" });
    const all = listAllTasks();
    const r6 = all.filter((t) => t.roomId === "r6");
    const r7 = all.filter((t) => t.roomId === "r7");
    expect(r6.length).toBeGreaterThanOrEqual(1);
    expect(r7.length).toBeGreaterThanOrEqual(1);
  });

  it("listAllTasks filters by status", async () => {
    const { createTask, listAllTasks } = await import("../../src/workspace/task-store.js");
    ensureRoom("r8");
    createTask("r8", { title: "Todo task", createdBy: "pm", status: "todo" });
    createTask("r8", { title: "Done task", createdBy: "pm", status: "done" });
    const todos = listAllTasks({ status: "todo" });
    for (const t of todos) expect(t.status).toBe("todo");
  });

  it("listAllTasks filters by query", async () => {
    const { createTask, listAllTasks } = await import("../../src/workspace/task-store.js");
    ensureRoom("r9");
    createTask("r9", { title: "Implement search", createdBy: "pm" });
    createTask("r9", { title: "Fix bug", createdBy: "pm" });
    const results = listAllTasks({ query: "search" });
    expect(results.some((t) => t.title.includes("search"))).toBe(true);
    expect(results.every((t) => t.title.toLowerCase().includes("search"))).toBe(true);
  });

  it("creates a task with references", async () => {
    const { createTask, getTask } = await import("../../src/workspace/task-store.js");
    ensureRoom("r10");
    const task = createTask("r10", {
      title: "Task with refs",
      createdBy: "pm",
      references: ["docs/bossmode/prds/prd-task-board.md", "https://github.com/example"],
    });
    expect(task.references).toEqual(["docs/bossmode/prds/prd-task-board.md", "https://github.com/example"]);
    const found = getTask("r10", task.id);
    expect(found!.references).toEqual(["docs/bossmode/prds/prd-task-board.md", "https://github.com/example"]);
  });

  it("updates references on a task", async () => {
    const { createTask, updateTask } = await import("../../src/workspace/task-store.js");
    ensureRoom("r11");
    const task = createTask("r11", { title: "Ref update", createdBy: "pm", references: ["docs/a.md"] });
    const updated = updateTask("r11", task.id, { references: ["docs/a.md", "docs/b.md"] });
    expect(updated!.references).toEqual(["docs/a.md", "docs/b.md"]);
  });

  it("clears references with empty array", async () => {
    const { createTask, updateTask } = await import("../../src/workspace/task-store.js");
    ensureRoom("r12");
    const task = createTask("r12", { title: "Ref clear", createdBy: "pm", references: ["docs/x.md"] });
    const updated = updateTask("r12", task.id, { references: [] });
    expect(updated!.references).toEqual([]);
  });

  it("does not change references when not in patch", async () => {
    const { createTask, updateTask } = await import("../../src/workspace/task-store.js");
    ensureRoom("r13");
    const task = createTask("r13", { title: "Ref unchanged", createdBy: "pm", references: ["docs/y.md"] });
    const updated = updateTask("r13", task.id, { title: "New title" });
    expect(updated!.references).toEqual(["docs/y.md"]);
    expect(updated!.title).toBe("New title");
  });

  it("creates default comments and creator subscriber", async () => {
    const { createTask, getTask } = await import("../../src/workspace/task-store.js");
    ensureRoom("r14");
    const task = createTask("r14", { title: "Defaults", createdBy: "pm" });
    expect(task.comments).toEqual([]);
    expect(task.subscribers).toEqual(["pm"]);
    expect(getTask("r14", task.id)!.comments).toEqual([]);
  });

  it("dedupes subscribers on create and replacement update", async () => {
    const { createTask, updateTask } = await import("../../src/workspace/task-store.js");
    ensureRoom("r15");
    const task = createTask("r15", { title: "Subs", createdBy: "pm", subscribers: ["qa", "qa", "", "pm"] });
    expect(task.subscribers).toEqual(["pm", "qa"]);
    const updated = updateTask("r15", task.id, { subscribers: ["developer", "qa", "developer"] });
    expect(updated!.subscribers).toEqual(["developer", "qa"]);
  });

  it("adds comments and bumps updatedAt", async () => {
    const { createTask, addTaskComment, getTask } = await import("../../src/workspace/task-store.js");
    ensureRoom("r16");
    const task = createTask("r16", { title: "Commented", createdBy: "pm" });
    const result = addTaskComment("r16", task.id, { author: "developer", content: "Implemented" });
    expect(result).not.toBeNull();
    expect(result!.comment.id).toMatch(/^comment-/);
    expect(result!.comment.author).toBe("developer");
    expect(result!.comment.content).toBe("Implemented");
    expect(result!.comment.createdAt).toBeGreaterThan(0);
    expect(result!.task.updatedAt).toBeGreaterThanOrEqual(task.updatedAt);
    expect(getTask("r16", task.id)!.comments).toHaveLength(1);
  });

  it("stores member identity for assignees and subscribers and updates display names on rename", async () => {
    const { createTask, getTask, renameParticipant } = await import("../../src/workspace/task-store.js");
    ensureRoom("r17-member-ids");
    const task = createTask("r17-member-ids", {
      title: "Member ids",
      createdBy: "pm",
      assignee: "dev-a",
      assigneeMemberId: "rm_dev_a",
      subscribers: ["qa-a"],
      subscriberMemberIds: ["rm_qa_a"],
    });
    expect(task.assigneeMemberId).toBe("rm_dev_a");
    expect(task.subscriberMemberIds).toEqual(["rm_qa_a"]);

    expect(renameParticipant("r17-member-ids", { memberId: "rm_dev_a", oldName: "dev-a", newName: "dev-ui" })).toBe(1);
    expect(getTask("r17-member-ids", task.id)!.assignee).toBe("dev-ui");
    expect(renameParticipant("r17-member-ids", { memberId: "rm_qa_a", oldName: "qa-a", newName: "qa-browser" })).toBe(1);
    expect(getTask("r17-member-ids", task.id)!.subscribers).toEqual(["pm", "qa-browser"]);
  });

  it("normalizes old task json without comments and subscribers", async () => {
    const { getTask, listTaskSummaries } = await import("../../src/workspace/task-store.js");
    ensureRoom("r17");
    const dir = join(tmpDir, "rooms", "r17");
    writeFileSync(join(dir, "tasks.json"), JSON.stringify([{ id: "task-old", roomId: "r17", title: "Old", status: "todo", priority: "P1", createdBy: "pm", createdAt: 1, updatedAt: 1 }]), "utf-8");
    const task = getTask("r17", "task-old")!;
    expect(task.comments).toEqual([]);
    expect(task.subscribers).toEqual([]);
    expect(listTaskSummaries("r17")[0].commentCount).toBe(0);
  });
});
