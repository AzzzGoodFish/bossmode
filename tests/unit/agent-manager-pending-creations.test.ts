import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  prompt: vi.fn(async () => {}),
  setCursor: vi.fn(),
}));

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
    runtime: "claude-cli",
    thinkingLevel: "off",
    skills: [],
  })),
}));

vi.mock("../../src/workspace/room-store.js", () => ({
  getRoom: vi.fn(() => ({ id: "room1", name: "Room", cwd: "/tmp", members: ["developer"], createdAt: Date.now() })),
  getCursors: vi.fn(() => ({ developer: null })),
  setCursor: mocks.setCursor,
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
  broadcastToRoom: vi.fn(),
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
import { activateAgent, initAgentManager, shutdownAll } from "../../src/engine/agent-manager.js";

describe("agent-manager pending creation dedup", () => {
  beforeEach(async () => {
    mocks.createAgent.mockReset();
    mocks.prompt.mockReset();
    mocks.setCursor.mockReset();

    const handle = {
      prompt: mocks.prompt,
      steer: vi.fn(),
      abort: vi.fn(),
      destroy: vi.fn(),
      waitForIdle: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      getContextUsage: vi.fn(async () => null),
      isWorking: false,
      runtimeName: "claude-cli",
    };

    mocks.createAgent.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return handle;
    });

    const runtime = {
      name: "claude-cli",
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
      createAgent: mocks.createAgent,
      shutdownAll: vi.fn(async () => {}),
    };

    const reg = new RuntimeRegistry();
    reg.register(runtime as any);
    initAgentManager(reg);
    await shutdownAll();
  });

  it("deduplicates concurrent activateAgent calls for same room/member", async () => {
    await Promise.all([
      activateAgent("room1", "developer"),
      activateAgent("room1", "developer"),
    ]);

    expect(mocks.createAgent).toHaveBeenCalledTimes(1);
  });
});
