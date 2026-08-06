import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  prompt: vi.fn(async () => {}),
  steer: vi.fn(),
  abort: vi.fn(),
  subscribeCb: undefined as any,
  setCursor: vi.fn(),
  broadcastToRoom: vi.fn(),
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
    credentialId: "cred-a",
    runtime: "pi-cli",
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


vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: (agent: string) => ({
    name: agent, description: agent, systemPrompt: "test", tags: [], skills: [],
  }),
}));

vi.mock("../../src/workforce/skill-store.js", () => ({
  resolveGlobalSkillPaths: (skillNames: string[]) => skillNames.map((s: string) => "/tmp/skills/" + s),
}));

import { RuntimeRegistry } from "../../src/engine/runtime/registry.js";
import { activateAgent, initAgentManager, shutdownAll } from "../../src/engine/agent-manager.js";

describe("agent-manager pending creation dedup", () => {
  beforeEach(async () => {
    mocks.createAgent.mockReset();
    mocks.prompt.mockReset();
    mocks.steer.mockReset();
    mocks.abort.mockReset();
    mocks.subscribeCb = undefined;
    mocks.setCursor.mockReset();
    mocks.broadcastToRoom.mockReset();

    const handle = {
      prompt: mocks.prompt,
      steer: mocks.steer,
      abort: mocks.abort,
      destroy: vi.fn(),
      waitForIdle: vi.fn(async () => {}),
      subscribe: vi.fn((fn) => { mocks.subscribeCb = fn; return () => {}; }),
      getContextUsage: vi.fn(async () => null),
      isWorking: false,
      runtimeName: "pi-cli",
    };

    mocks.createAgent.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return handle;
    });

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

  it("does not broadcast working until runtime agent_start", async () => {
    let resolvePrompt!: () => void;
    mocks.prompt.mockReturnValue(new Promise<void>((resolve) => { resolvePrompt = resolve; }));

    const activation = activateAgent("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastToRoom).not.toHaveBeenCalledWith("room1", expect.objectContaining({ type: "agent:status", status: "working" }));

    mocks.subscribeCb?.({ type: "agent_start" });
    expect(mocks.broadcastToRoom).not.toHaveBeenCalledWith("room1", expect.objectContaining({ type: "agent:status", status: "working" }));

    resolvePrompt();
    await activation;
  });

  it("queues activation during promptSubmitted and flushes it as steer on agent_start", async () => {
    let resolvePrompt!: () => void;
    mocks.prompt.mockReturnValue(new Promise<void>((resolve) => { resolvePrompt = resolve; }));

    const first = activateAgent("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = activateAgent("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.steer).not.toHaveBeenCalled();

    mocks.subscribeCb?.({ type: "agent_start" });
    expect(mocks.steer).toHaveBeenCalledTimes(1);

    resolvePrompt();
    await Promise.all([first, second]);
  });

  it("does not prompt again between agent_end and prompt promise settlement; queued input prompts after settle", async () => {
    let resolveFirst!: () => void;
    mocks.prompt
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async () => {
        mocks.subscribeCb?.({ type: "tool_end", toolName: "response", toolCallId: "call-queued", result: { ok: true }, isError: false } as any);
      });

    const first = activateAgent("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.prompt).toHaveBeenCalledTimes(1);

    mocks.subscribeCb?.({ type: "agent_start" });
    mocks.subscribeCb?.({ type: "agent_end" });

    const second = activateAgent("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.steer).not.toHaveBeenCalled();

    resolveFirst();
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.prompt).toHaveBeenCalledTimes(2);
  });
});
