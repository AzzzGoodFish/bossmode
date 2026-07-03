import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  broadcastToRoom: vi.fn(),
}));

let contextUsageCallCount = 0;

const mockHandle = {
  prompt: vi.fn(async () => {}),
  steer: vi.fn(),
  abort: vi.fn(),
  destroy: vi.fn(),
  waitForIdle: vi.fn(async () => {}),
  subscribe: vi.fn(() => () => {}),
  getContextUsage: vi.fn(async () => {
    contextUsageCallCount += 1;
    return { totalTokens: 1234, rawMaxTokens: 200000, percentage: 0.617, model: "sonnet" };
  }),
  isWorking: false,
  runtimeName: "pi-cli",
};

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => "/tmp/bossmode-test",
  readConfig: () => ({
    auth: { username: "u", passwordHash: "h" },
    apiKeys: {},
    defaults: { host: "127.0.0.1", port: 8080 },
    runtime: { sessionResume: true },
  }),
}));

vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: vi.fn(() => ({
    name: "developer",
    description: "dev",
    systemPrompt: "You are dev",
    skills: [],
    tags: [],
  })),
}));

vi.mock("../../src/workforce/member-store.js", () => ({
  getMemberByName: vi.fn(() => ({
    id: "developer",
    name: "developer",
    type: "agent",
    agent: "developer",
    model: "sonnet",
    runtime: "pi-cli",
    thinkingLevel: "off",
    skills: [],
  })),
}));

vi.mock("../../src/workspace/room-store.js", () => ({
  getRoom: vi.fn(() => ({ id: "room1", name: "Room", cwd: "/tmp", members: ["developer"], createdAt: Date.now() })),
  getCursors: vi.fn(() => ({ developer: null })),
  setCursor: vi.fn(),
}));

vi.mock("../../src/workspace/session-store.js", () => ({
  getSessions: vi.fn(() => ({})),
  saveSession: vi.fn(),
}));

vi.mock("../../src/knowledge/store.js", () => ({
  listEntries: vi.fn(() => []),
  getEntry: vi.fn(),
  getDocumentTree: vi.fn(() => ({ path: "", name: "docs", kind: "folder", children: [] })),
}));

vi.mock("../../src/communication/message-bus.js", () => ({
  postMessage: vi.fn(),
  getMessagesSince: vi.fn(() => [{ id: "msg-1", sender: "user", content: "@developer hi", mentions: ["developer"], ts: Date.now() }]),
  getLatestMessageId: vi.fn(() => "msg-1"),
}));

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToRoom: mocks.broadcastToRoom,
  broadcastToAgentSubscribers: vi.fn(),
}));

vi.mock("../../src/engine/prompt-assembler.js", () => ({
  buildAgentPrompt: vi.fn(() => ({ agentPrompt: "", envPrompt: "" })),
}));

vi.mock("../../src/engine/event-handler.js", () => ({
  handleAgentEvent: vi.fn(() => undefined),
  loadEventsFromDisk: vi.fn(() => []),
  appendEventToDisk: vi.fn(),
}));

import { RuntimeRegistry } from "../../src/engine/runtime/registry.js";
import {
  activateAgent,
  destroyInstance,
  getAgentContextUsage,
  initAgentManager,
  refreshContextUsage,
  shutdownAll,
} from "../../src/engine/agent-manager.js";

describe("agent-manager context usage cache", () => {
  beforeEach(async () => {
    contextUsageCallCount = 0;
    mockHandle.prompt.mockClear();
    mockHandle.getContextUsage.mockClear();
    mockHandle.subscribe.mockReturnValue(() => {});
    mocks.broadcastToRoom.mockReset();

    const runtime = {
      name: "pi-cli",
      capabilities: {
        streaming: true,
        toolEvents: true,
        thinking: true,
        usage: true,
        dynamicModel: true,
        dynamicThinking: true,
        permissionControl: true,
        sessionResume: true,
        contextUsage: true,
      },
      detect: vi.fn(async () => ({ available: true })),
      createAgent: vi.fn(async () => mockHandle),
      shutdownAll: vi.fn(async () => {}),
    };

    const reg = new RuntimeRegistry();
    reg.register(runtime as any);
    initAgentManager(reg);
    await shutdownAll();
    await activateAgent("room1", "developer");
  });

  it("refreshes cache from runtime on idle and broadcasts agent:context_usage", async () => {
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(contextUsageCallCount).toBe(1);
    expect(mocks.broadcastToRoom).toHaveBeenCalledWith("room1", {
      type: "agent:context_usage",
      roomId: "room1",
      agent: "developer",
      usage: { totalTokens: 1234, rawMaxTokens: 200000, percentage: 0.617, model: "sonnet" },
    });
  });

  it("reads cached context usage without calling runtime again", async () => {
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));
    contextUsageCallCount = 0;

    const usage = getAgentContextUsage("room1", "developer");

    expect(usage).toEqual({ totalTokens: 1234, rawMaxTokens: 200000, percentage: 0.617, model: "sonnet" });
    expect(contextUsageCallCount).toBe(0);
  });

  it("preserves previous usage and marks compacted when SDK reports null tokens", async () => {
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));
    mocks.broadcastToRoom.mockReset();
    mockHandle.getContextUsage.mockResolvedValueOnce({ totalTokens: 0, rawMaxTokens: 200000, percentage: 0, model: "sonnet", compacted: true });

    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getAgentContextUsage("room1", "developer")).toEqual({ totalTokens: 1234, rawMaxTokens: 200000, percentage: 0.617, model: "sonnet", compacted: true });
    expect(mocks.broadcastToRoom).toHaveBeenCalledWith("room1", expect.objectContaining({
      type: "agent:context_usage",
      usage: { totalTokens: 1234, rawMaxTokens: 200000, percentage: 0.617, model: "sonnet", compacted: true },
    }));
  });

  it("marks compacted on a same-session significant context drop and keeps the marker across immediate fallback refresh", async () => {
    mockHandle.getContextUsage.mockResolvedValueOnce({ totalTokens: 18017, rawMaxTokens: 1200, percentage: 1501.4, model: "sonnet" });
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));
    mocks.broadcastToRoom.mockReset();

    mockHandle.getContextUsage.mockResolvedValueOnce({ totalTokens: 82, rawMaxTokens: 1200, percentage: 6.83, model: "sonnet" });
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getAgentContextUsage("room1", "developer")).toEqual({ totalTokens: 82, rawMaxTokens: 1200, percentage: 6.83, model: "sonnet", compacted: true });

    mockHandle.getContextUsage.mockResolvedValueOnce({ totalTokens: 82, rawMaxTokens: 1200, percentage: 6.83, model: "sonnet" });
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getAgentContextUsage("room1", "developer")?.compacted).toBe(true);
  });

  it("does not mark compacted after restart/reset clears the active instance usage history", async () => {
    mockHandle.getContextUsage.mockResolvedValueOnce({ totalTokens: 18017, rawMaxTokens: 1200, percentage: 1501.4, model: "sonnet" });
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));

    destroyInstance("room1", "developer");
    await activateAgent("room1", "developer");
    mockHandle.getContextUsage.mockResolvedValueOnce({ totalTokens: 82, rawMaxTokens: 1200, percentage: 6.83, model: "sonnet" });
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getAgentContextUsage("room1", "developer")).toEqual({ totalTokens: 82, rawMaxTokens: 1200, percentage: 6.83, model: "sonnet" });
  });
});
