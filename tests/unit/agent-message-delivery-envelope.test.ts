vi.mock("../../src/workforce/room-member-resolver.js", () => ({
  resolveRoomMember: vi.fn(() => ({
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

import { beforeEach, describe, expect, it, vi } from "vitest";


vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: (agent: string) => ({
    name: agent, description: agent, systemPrompt: "test", tags: [], skills: [],
  }),
}));

vi.mock("../../src/workforce/skill-store.js", () => ({
  resolveGlobalSkillPaths: (skillNames: string[]) => skillNames.map((s: string) => "/tmp/skills/" + s),
}));

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

  it("hybrid: backlog compresses to one unread hint; trigger message injects in full", async () => {
    mocks.getMessagesSince.mockReturnValue([
      { id: "m1", sender: "user", content: "first", mentions: [], ts: 1, seq: 101 },
      { id: "m2", sender: "architect", content: "second", mentions: [], ts: 2, seq: 102 },
      { id: "m3", sender: "user", content: "@pm status?", mentions: ["pm"], ts: 3, seq: 103 },
    ]);

    await activateAgent("room1", "pm");

    const sent = mocks.prompt.mock.calls[0][0] as string;
    // Backlog hint: counts the two pre-trigger messages, user first
    expect(sent).toContain("you have 2 unread messages (No.101\u2013No.102): user×1, architect×1");
    expect(sent).toContain("query_room_messages (from_seq 100)");
    // Trigger message injects in full (its own sub-header + content)
    expect(sent).toContain('No.103');
    expect(sent).toContain("@pm status?");
    // Backlog bodies are NOT injected verbatim
    expect(sent).not.toContain("first\n");
    expect(sent).not.toContain("second");
    expect(sent).not.toContain("mentioned by");
  });

  it("hybrid: no mention trigger → newest message is the trigger, earlier ones become the hint", async () => {
    mocks.getMessagesSince.mockReturnValue([
      { id: "m1", sender: "user", content: "plain msg", mentions: [], ts: 1, seq: 201 },
      { id: "m2", sender: "architect", content: "also plain", mentions: [], ts: 2, seq: 202 },
    ]);

    await activateAgent("room1", "pm");
    const sent = mocks.prompt.mock.calls[0][0] as string;
    // m1 = backlog hint, m2 = trigger full
    expect(sent).toContain("you have 1 unread messages (No.201\u2013No.201): user×1");
    expect(sent).toContain('No.202');
    expect(sent).toContain("also plain");
    expect(sent).not.toContain("plain msg");
    expect(sent).not.toContain("mentioned by");
  });
});
