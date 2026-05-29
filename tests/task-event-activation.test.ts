import { describe, it, expect, vi, beforeEach } from "vitest";

const addMessage = vi.fn((roomId: string, msg: any) => ({
  id: "msg-test",
  ts: Date.now(),
  ...msg,
}));

vi.mock("../src/workspace/message-store.js", () => ({ addMessage }));

const broadcastToRoom = vi.fn();
vi.mock("../src/communication/ws.js", () => ({ broadcastToRoom }));

const createTask = vi.fn();
const getTask = vi.fn();
const updateTask = vi.fn();
const deleteTask = vi.fn();
const listTasks = vi.fn(() => []);
const listAllTasks = vi.fn(() => []);
vi.mock("../src/workspace/task-store.js", () => ({ createTask, getTask, updateTask, deleteTask, listTasks, listAllTasks }));

vi.mock("../src/foundation/logger.js", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

describe("task events do not activate assignees", () => {
  let onMessage: typeof import("../src/communication/message-bus.js").onMessage;
  let emitTaskEvent: typeof import("../src/api/tasks.js").emitTaskEvent;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mb = await import("../src/communication/message-bus.js");
    onMessage = mb.onMessage;
    const tasks = await import("../src/api/tasks.js");
    emitTaskEvent = tasks.emitTaskEvent;
  });

  it("emits task_event with empty mentions even when assignee is a member", () => {
    const listener = vi.fn();
    onMessage(listener);

    const task = {
      id: "task-abc",
      title: "Fix bug",
      status: "todo" as const,
      priority: "P1" as const,
      assignee: "developer",
      createdBy: "architect",
      roomId: "room-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    emitTaskEvent("room-1", "created", task, "architect");

    expect(listener).toHaveBeenCalledTimes(1);
    const [roomId, message] = listener.mock.calls[0];
    expect(roomId).toBe("room-1");
    expect(message.mentions).toEqual([]);
    expect(message.type).toBe("task_event");
    expect(message.task_event_meta).toEqual({
      action: "created",
      taskId: "task-abc",
      taskTitle: "Fix bug",
      newStatus: undefined,
      actor: "architect",
    });
  });

  it("reassignment still emits no mentions", () => {
    const listener = vi.fn();
    onMessage(listener);

    const task = {
      id: "task-abc",
      title: "Fix bug",
      status: "todo" as const,
      priority: "P1" as const,
      assignee: "qa",
      createdBy: "architect",
      roomId: "room-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    emitTaskEvent("room-1", "updated", task, "architect");

    expect(listener).toHaveBeenCalledTimes(1);
    const [, message] = listener.mock.calls[0];
    expect(message.mentions).toEqual([]);
  });

  it("commented task event emits no mentions and includes comment id", () => {
    const listener = vi.fn();
    onMessage(listener);

    const task = {
      id: "task-abc",
      title: "Fix bug",
      status: "todo" as const,
      priority: "P1" as const,
      assignee: "developer",
      subscribers: ["qa", "pm"],
      createdBy: "architect",
      roomId: "room-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    emitTaskEvent("room-1", "commented", task, "developer", { commentId: "comment-1" });

    expect(listener).toHaveBeenCalledTimes(1);
    const [, message] = listener.mock.calls[0];
    expect(message.mentions).toEqual([]);
    expect(message.content).toContain("commented on task");
    expect(message.task_event_meta).toEqual(expect.objectContaining({
      action: "commented",
      commentId: "comment-1",
    }));
  });

  it("task_event preserves type and meta for UI card rendering", () => {
    const listener = vi.fn();
    onMessage(listener);

    const task = {
      id: "task-abc",
      title: "Fix bug",
      status: "review" as const,
      priority: "P0" as const,
      assignee: "developer",
      createdBy: "architect",
      roomId: "room-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    emitTaskEvent("room-1", "status_changed", task, "pm");

    expect(addMessage).toHaveBeenCalledWith("room-1", expect.objectContaining({
      mentions: [],
      type: "task_event",
      task_event_meta: expect.objectContaining({
        action: "status_changed",
        taskId: "task-abc",
        newStatus: "review",
      }),
    }));
  });
});
