import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  broadcastToRoom: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  updateTaskLinearMetadata: vi.fn(),
  getTask: vi.fn(),
  updateRoomLinearIntegration: vi.fn(),
  getLinearApiKey: vi.fn(),
  getRoomLinearIntegration: vi.fn(),
  createIssue: vi.fn(),
  updateIssue: vi.fn(),
  createComment: vi.fn(),
  getTeamDetails: vi.fn(),
}));

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToRoom: mocks.broadcastToRoom,
}));

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: mocks.loggerInfo, warn: mocks.loggerWarn, error: vi.fn() },
}));

vi.mock("../../src/workspace/task-store.js", () => ({
  getTask: mocks.getTask,
  updateTaskLinearMetadata: mocks.updateTaskLinearMetadata,
}));

vi.mock("../../src/workspace/room-store.js", () => ({
  updateRoomLinearIntegration: mocks.updateRoomLinearIntegration,
}));

vi.mock("../../src/integrations/linear-settings.js", () => ({
  getLinearApiKey: mocks.getLinearApiKey,
  getRoomLinearIntegration: mocks.getRoomLinearIntegration,
}));

vi.mock("../../src/integrations/linear-client.js", () => ({
  linearPriority: (priority: string) => priority === "P0" ? 1 : priority === "P2" ? 3 : 2,
  resolveLinearStateId: () => "state-todo",
  LinearClient: vi.fn(() => ({
    getTeamDetails: mocks.getTeamDetails,
    createIssue: mocks.createIssue,
    updateIssue: mocks.updateIssue,
    createComment: mocks.createComment,
  })),
}));

import { syncTaskEventToLinear } from "../../src/integrations/task-linear-sync.js";

const task = {
  id: "task-1",
  title: "Ship it",
  status: "todo" as const,
  priority: "P1" as const,
  comments: [],
};

const roomConfig = { enabled: true, teamId: "team-1", teamName: "Team", projectId: "proj-1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getLinearApiKey.mockReturnValue("lin_api_secret");
  mocks.getRoomLinearIntegration.mockReturnValue(roomConfig);
  mocks.getTeamDetails.mockResolvedValue({ states: [{ id: "state-todo", name: "Todo" }] });
  mocks.createIssue.mockResolvedValue({ id: "issue-1", identifier: "GOO-1", url: "https://linear/GOO-1" });
  mocks.updateTaskLinearMetadata.mockImplementation((_roomId, _taskId, patch) => ({ ...task, ...patch }));
  mocks.getTask.mockReturnValue(task);
});

describe("task Linear sync notifications", () => {
  it("syncs task metadata and stays silent in room chat", async () => {
    await syncTaskEventToLinear({ roomId: "room1", action: "created", task, actor: "pm" });

    expect(mocks.createIssue).toHaveBeenCalledWith(expect.objectContaining({ title: "Ship it", teamId: "team-1" }));
    expect(mocks.broadcastToRoom).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastToRoom).toHaveBeenCalledWith("room1", expect.objectContaining({ type: "task:updated" }));
    expect(mocks.broadcastToRoom).not.toHaveBeenCalledWith("room1", expect.objectContaining({ type: "room:message" }));
    expect(mocks.loggerInfo).toHaveBeenCalledWith("linear", "task synced", expect.objectContaining({ roomId: "room1", taskId: "task-1", issue: "GOO-1" }));
  });

  it("records sync errors without posting Linear sync failure messages to the room", async () => {
    mocks.getTeamDetails.mockRejectedValueOnce(new Error("fetch failed"));

    await syncTaskEventToLinear({ roomId: "room1", action: "created", task, actor: "pm" });

    expect(mocks.updateTaskLinearMetadata).toHaveBeenCalledWith("room1", "task-1", { linearSyncError: "fetch failed" });
    expect(mocks.broadcastToRoom).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith("linear", "task sync failed", expect.objectContaining({ roomId: "room1", taskId: "task-1", error: "fetch failed" }));
  });
});
