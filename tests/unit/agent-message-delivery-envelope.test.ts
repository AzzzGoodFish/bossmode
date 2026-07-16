import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  prompt: vi.fn(async () => {}),
  steer: vi.fn(),
  getMessagesSince: vi.fn(),
  getLatestMessageId: vi.fn(() => "msg-last"),
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
    name: "pm",
    description: "pm",
    systemPrompt: "You are pm",
    skills: [],
    tags: [],
  })),
}));

vi.mock("../../src/workforce/member-store.js", () => ({
  getMemberByName: vi.fn(() => ({
    id: "pm",
    name: "pm",
    type: "agent",
    agent: "pm",
    model: "sonnet",
    credentialId: "cred-a",
    runtime: "mock",
    thinkingLevel: "off",
    skills: [],
  })),
}));

vi.mock("../../src/workspace/room-store.js", () => ({
  getRoom: vi.fn(() => ({ id: "room1", name: "bossmode dev", cwd: "/tmp", members: ["pm"], createdAt: Date.now() })),
  getCursors: vi.fn(() => ({ pm: null })),
  setCursor: mocks.setCursor,
}));

vi.mock("../../src/workspace/session-store.js", () => ({
  getSessions: vi.fn(() => ({})),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock("../../src/knowledge/store.js", () => ({
  listEntries: vi.fn(() => []),
  getEntry: vi.fn(),
  getDocumentTree: vi.fn(() => ({ path: "", name: "docs", kind: "folder", children: [] })),
  addEntry: vi.fn(),
}));

vi.mock("../../src/communication/message-bus.js", () => ({
  postMessage: vi.fn(),
  getMessagesSince: mocks.getMessagesSince,
  getLatestMessageId: mocks.getLatestMessageId,
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

describe("agent delivery envelope formatting", () => {
  beforeEach(async () => {
    mocks.prompt.mockReset();
    mocks.steer.mockReset();
    mocks.getMessagesSince.mockReset();
    mocks.setCursor.mockReset();

    const handle = {
      prompt: mocks.prompt,
      steer: mocks.steer,
      abort: vi.fn(),
      destroy: vi.fn(),
      waitForIdle: vi.fn(async () => {}),
      subscribe: vi.fn(() => () => {}),
      getContextUsage: vi.fn(async () => null),
      isWorking: false,
      runtimeName: "mock",
    };

    mocks.createAgent.mockResolvedValue(handle);
    const runtime = {
      name: "mock",
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

  it("adds context headers per message and one room footer on trigger message", async () => {
    mocks.getMessagesSince.mockReturnValue([
      { id: "m1", sender: "user", content: "first", mentions: [], ts: 1 },
      { id: "m2", sender: "architect", content: "second", mentions: [], ts: 2 },
      { id: "m3", sender: "user", content: "@pm status?", mentions: ["pm"], ts: 3 },
    ]);

    await activateAgent("room1", "pm");

    const sent = mocks.prompt.mock.calls[0][0] as string;
    expect(sent).toContain('[Message from room "bossmode dev", from user @fish]');
    expect(sent).toContain('[Message from room "bossmode dev", from member @architect]');
    expect(sent).toContain('[Message from room "bossmode dev", mentioned by user @fish]');
    expect(sent.match(/\[Reply hint: Suggested call the chat tool with target="room"/g)?.length).toBe(1);
  });

  it("keeps summary messages as pass-through", async () => {
    mocks.getMessagesSince.mockReturnValue([
      { id: "s1", sender: "summarizer", content: "[Summary | covers ...]", mentions: [], ts: 1, type: "summary" },
      { id: "m3", sender: "user", content: "@pm status?", mentions: ["pm"], ts: 3 },
    ]);

    await activateAgent("room1", "pm");
    const sent = mocks.prompt.mock.calls[0][0] as string;
    expect(sent).toContain("[Summary | covers ...]");
  });

  it("fallbacks to last non-summary as trigger when no mention exists", async () => {
    mocks.getMessagesSince.mockReturnValue([
      { id: "m1", sender: "user", content: "plain msg", mentions: [], ts: 1 },
      { id: "m2", sender: "architect", content: "also plain", mentions: [], ts: 2 },
    ]);

    await activateAgent("room1", "pm");
    const sent = mocks.prompt.mock.calls[0][0] as string;
    expect(sent).toContain('[Message from room "bossmode dev", mentioned by member @architect]');
    expect(sent).toContain('[Reply hint: Suggested call the chat tool with target="room"');
  });
});
