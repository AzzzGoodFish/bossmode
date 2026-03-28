import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("../src/core/agent-manager.js", () => ({
  activateAgent: vi.fn().mockResolvedValue(undefined),
  activateAll: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/store/room-store.js", () => ({
  getRoom: vi.fn().mockReturnValue({
    id: "room-1",
    name: "test",
    cwd: "/tmp",
    members: ["pm", "dev", "qa"],
    createdAt: Date.now(),
  }),
}));

describe("message-router", () => {
  let routeMessage: typeof import("../src/core/message-router.js").routeMessage;
  let activateAgent: any;
  let activateAll: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const router = await import("../src/core/message-router.js");
    routeMessage = router.routeMessage;
    const agentMgr = await import("../src/core/agent-manager.js");
    activateAgent = agentMgr.activateAgent;
    activateAll = agentMgr.activateAll;
  });

  it("should activate mentioned agent", async () => {
    await routeMessage("room-1", {
      id: "msg-1",
      sender: "user",
      content: "@pm analyze this",
      mentions: ["pm"],
      ts: Date.now(),
    });

    expect(activateAgent).toHaveBeenCalledWith("room-1", "pm");
  });

  it("should activate multiple mentioned agents", async () => {
    await routeMessage("room-1", {
      id: "msg-2",
      sender: "user",
      content: "@pm and @dev work on this",
      mentions: ["pm", "dev"],
      ts: Date.now(),
    });

    expect(activateAgent).toHaveBeenCalledWith("room-1", "pm");
    expect(activateAgent).toHaveBeenCalledWith("room-1", "dev");
  });

  it("should use activateAll for @all", async () => {
    await routeMessage("room-1", {
      id: "msg-3",
      sender: "user",
      content: "@all start working",
      mentions: ["all"],
      ts: Date.now(),
    });

    expect(activateAll).toHaveBeenCalledWith("room-1");
    expect(activateAgent).not.toHaveBeenCalled();
  });

  it("should skip messages with no mentions", async () => {
    await routeMessage("room-1", {
      id: "msg-4",
      sender: "user",
      content: "just chatting",
      mentions: [],
      ts: Date.now(),
    });

    expect(activateAgent).not.toHaveBeenCalled();
    expect(activateAll).not.toHaveBeenCalled();
  });
});
