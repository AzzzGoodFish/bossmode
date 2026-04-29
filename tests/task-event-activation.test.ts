import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

const addMessage = vi.fn((roomId: string, msg: any) => ({
  id: "msg-test",
  ts: Date.now(),
  ...msg,
}));

vi.mock("../src/workspace/message-store.js", () => ({
  addMessage,
}));

const broadcastToRoom = vi.fn();
vi.mock("../src/communication/ws.js", () => ({
  broadcastToRoom,
}));

const getRoom = vi.fn();
vi.mock("../src/workspace/room-store.js", () => ({
  getRoom,
}));

const createTask = vi.fn();
const getTask = vi.fn();
const updateTask = vi.fn();
const deleteTask = vi.fn();
const listTasks = vi.fn(() => []);
const listAllTasks = vi.fn(() => []);
vi.mock("../src/workspace/task-store.js", () => ({
  createTask,
  getTask,
  updateTask,
  deleteTask,
  listTasks,
  listAllTasks,
}));

vi.mock("../src/foundation/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("task event activation via message-bus", () => {
  let postMessage: typeof import("../src/communication/message-bus.js").postMessage;
  let onMessage: typeof import("../src/communication/message-bus.js").onMessage;
  let emitTaskEvent: typeof import("../src/api/tasks.js").emitTaskEvent;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-import to get fresh module state
    const mb = await import("../src/communication/message-bus.js");
    postMessage = mb.postMessage;
    onMessage = mb.onMessage;
    const tasks = await import("../src/api/tasks.js");
    emitTaskEvent = tasks.emitTaskEvent;

    getRoom.mockReturnValue({
      id: "room-1",
      members: ["pm", "developer", "qa", "architect"],
    });
  });

  it("emitTaskEvent triggers message-bus listeners (router activation path)", () => {
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

    emitTaskEvent("room-1", "created", task, "architect", {
      activateAssignee: true,
      previousAssignee: undefined,
    });

    // Listener should have been called with the message
    expect(listener).toHaveBeenCalledTimes(1);
    const [roomId, message] = listener.mock.calls[0];
    expect(roomId).toBe("room-1");
    expect(message.mentions).toContain("developer");
    expect(message.type).toBe("task_event");
    expect(message.task_event_meta).toEqual({
      action: "created",
      taskId: "task-abc",
      taskTitle: "Fix bug",
      newStatus: undefined,
      actor: "architect",
    });
  });

  it("self-assign does not trigger mention", () => {
    const listener = vi.fn();
    onMessage(listener);

    const task = {
      id: "task-abc",
      title: "My task",
      status: "todo" as const,
      priority: "P1" as const,
      assignee: "architect",
      createdBy: "architect",
      roomId: "room-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    emitTaskEvent("room-1", "created", task, "architect", {
      activateAssignee: true,
      previousAssignee: undefined,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const [, message] = listener.mock.calls[0];
    expect(message.mentions).toEqual([]);
  });

  it("same assignee update does not trigger mention", () => {
    const listener = vi.fn();
    onMessage(listener);

    const task = {
      id: "task-abc",
      title: "Fix bug",
      status: "in-progress" as const,
      priority: "P1" as const,
      assignee: "developer",
      createdBy: "architect",
      roomId: "room-1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    emitTaskEvent("room-1", "updated", task, "architect", {
      activateAssignee: true,
      previousAssignee: "developer", // same as current
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const [, message] = listener.mock.calls[0];
    expect(message.mentions).toEqual([]);
  });

  it("reassignment triggers mention for new assignee", () => {
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

    emitTaskEvent("room-1", "updated", task, "architect", {
      activateAssignee: true,
      previousAssignee: "developer",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    const [, message] = listener.mock.calls[0];
    expect(message.mentions).toContain("qa");
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

    emitTaskEvent("room-1", "status_changed", task, "pm", {
      activateAssignee: true,
      previousAssignee: "developer", // same, no mention
    });

    // addMessage should have been called with task_event type
    expect(addMessage).toHaveBeenCalledWith("room-1", expect.objectContaining({
      type: "task_event",
      task_event_meta: expect.objectContaining({
        action: "status_changed",
        taskId: "task-abc",
        newStatus: "review",
      }),
    }));
  });
});
