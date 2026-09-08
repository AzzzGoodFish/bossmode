vi.mock("../../src/workforce/room-member-resolver.js", () => ({
  resolveRoomMember: vi.fn(() => ({
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

import { beforeEach, describe, expect, it, vi } from "vitest";

let sessionResumeEnabled = true;
const createAgentMock = vi.fn();

const mockHandle = {
  prompt: vi.fn(async () => {}),
  steer: vi.fn(),
  abort: vi.fn(),
  destroy: vi.fn(),
  waitForIdle: vi.fn(async () => {}),
  subscribe: vi.fn(() => () => {}),
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
    runtime: { sessionResume: sessionResumeEnabled },
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



vi.mock("../../src/workspace/room-store.js", () => ({
  getRoom: vi.fn(() => ({ id: "room1", name: "Room", cwd: "/tmp", members: ["developer"], createdAt: Date.now() })),
  getCursors: vi.fn(() => ({ developer: null })),
  setCursor: vi.fn(),
}));

vi.mock("../../src/workspace/session-store.js", () => ({
  getSessions: vi.fn(() => ({
    developer: { runtime: "pi-cli", sessionId: "sid-123", sessionFile: "/tmp/sid.json" },
  })),
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

describe("agent-manager session resume toggle", () => {
  beforeEach(async () => {
    createAgentMock.mockReset();
    mockHandle.prompt.mockClear();
    mockHandle.subscribe.mockReturnValue(() => {});

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
      createAgent: createAgentMock.mockImplementation(async () => mockHandle),
      shutdownAll: vi.fn(async () => {}),
    };

    const reg = new RuntimeRegistry();
    reg.register(runtime as any);
    initAgentManager(reg);
    await shutdownAll();
  });

  it("passes resumeSession when runtime.sessionResume=true", async () => {
    sessionResumeEnabled = true;

    await activateAgent("room1", "developer");

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    const args = createAgentMock.mock.calls[0][0];
    expect(args.resumeSession).toEqual({ sessionId: "sid-123", sessionFile: "/tmp/sid.json" });
  });

  it("does not pass resumeSession when runtime.sessionResume=false", async () => {
    sessionResumeEnabled = false;

    await activateAgent("room1", "developer");

    expect(createAgentMock).toHaveBeenCalledTimes(1);
    const args = createAgentMock.mock.calls[0][0];
    expect(args.resumeSession).toBeUndefined();
  });
});
