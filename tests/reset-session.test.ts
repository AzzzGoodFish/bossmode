import { describe, it, expect, vi, beforeEach } from "vitest";


vi.mock("../src/workspace/team-store.js", () => ({
  ensureRoomTeamAgent: (_roomId: string, agent: string) => ({
    name: agent, description: agent, systemPrompt: "test", tags: [], skills: [],
  }),
  loadRoomTeamAgent: (_roomId: string, agent: string) => ({
    name: agent, description: agent, systemPrompt: "test", tags: [], skills: [],
  }),
  resolveRoomSkillPaths: (_roomId: string, skills: string[]) => skills.map((s: string) => "/tmp/skills/" + s),
}));

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

let sessionResumeEnabled = true;
let mockRoom: any;

const mockRuntime = {
  name: "pi-cli",
  capabilities: {
    streaming: true,
    toolEvents: true,
    thinking: true,
    usage: true,
    dynamicModel: true,
    dynamicThinking: true,
    permissionControl: false,
    sessionResume: true,
    contextUsage: false,
  },
  detect: vi.fn(async () => ({ available: true })),
  createAgent: vi.fn(async ({ onSessionChanged }: any) => {
    onSessionChanged?.({ sessionId: "session-123", sessionFile: "/tmp/session.json" });
    return mockHandle;
  }),
  shutdownAll: vi.fn(async () => {}),
};

vi.mock("../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: vi.fn(() => ({
    name: "pm",
    model: "mock-model",
    description: "PM",
    systemPrompt: "You are pm.",
    skills: [],
    tags: [],
  })),
}));

vi.mock("../src/workforce/member-store.js", () => ({
  getMemberByName: vi.fn(() => ({
    id: "pm",
    name: "pm",
    type: "agent",
    agent: "pm",
    model: "mock-model",
    credentialId: "cred-a",
    runtime: "pi-cli",
    skills: [],
    thinkingLevel: "off",
  })),
}));

vi.mock("../src/shared/config.js", () => ({
  getBossmodeDir: () => "/tmp/bossmode-test",
  readConfig: () => ({
    auth: { username: "u", passwordHash: "h" },
    apiKeys: {},
    defaults: { host: "127.0.0.1", port: 8080 },
    sessionResume: sessionResumeEnabled,
  }),
}));

vi.mock("../src/workspace/room-store.js", () => ({
  getRoom: vi.fn(() => mockRoom),
  resolveRoomMemberRef: vi.fn((roomId: string, ref: string) => (mockRoom?.roomMembers || []).find((member: any) => member.id === ref || member.name === ref) || null),
  getCursors: vi.fn(() => ({ pm: "msg-1" })),
  setCursor: vi.fn(),
  deleteCursor: vi.fn(),
}));

vi.mock("../src/workspace/session-store.js", () => ({
  getSessions: vi.fn(() => ({ pm: { runtime: "pi-cli", sessionId: "session-123", sessionFile: "/tmp/session.json" } })),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
  deleteSessionEntry: vi.fn(),
}));

vi.mock("../src/knowledge/store.js", () => ({
  listEntries: vi.fn(() => []),
  getEntry: vi.fn(),
  getDocumentTree: vi.fn(() => ({ path: "", name: "docs", kind: "folder", children: [] })),
}));

vi.mock("../src/communication/message-bus.js", () => ({
  postMessage: vi.fn(),
  getMessagesSince: vi.fn(() => [{ id: "msg-1", sender: "user", content: "hello", mentions: [], ts: Date.now() }]),
  getLatestMessageId: vi.fn(() => "msg-1"),
}));

vi.mock("../src/communication/ws.js", () => ({
  broadcastToRoom: vi.fn(),
  broadcastToAgentSubscribers: vi.fn(),
}));

vi.mock("../src/engine/prompt-assembler.js", () => ({
  buildAgentPrompt: vi.fn(() => ({ agentPrompt: "", envPrompt: "", fullPrompt: "" })),
}));

vi.mock("../src/engine/event-handler.js", () => ({
  handleAgentEvent: vi.fn(),
  loadEventsFromDisk: vi.fn(() => []),
  appendEventToDisk: vi.fn(),
}));

import { RuntimeRegistry } from "../src/engine/runtime/registry.js";
import { initAgentManager, activateAgent, resetAgentSession, shutdownAll } from "../src/engine/agent-manager.js";
import * as roomStore from "../src/workspace/room-store.js";
import * as sessionStore from "../src/workspace/session-store.js";
import { appendEventToDisk } from "../src/engine/event-handler.js";
import { broadcastToRoom, broadcastToAgentSubscribers } from "../src/communication/ws.js";

describe("resetAgentSession", () => {
  beforeEach(async () => {
    await shutdownAll();
    vi.clearAllMocks();
    sessionResumeEnabled = true;
    mockRoom = { id: "room1", name: "Room 1", cwd: "/tmp", members: ["pm"], createdAt: Date.now() };
    vi.mocked(sessionStore.getSessions).mockReturnValue({ pm: { runtime: "pi-cli", sessionId: "session-123", sessionFile: "/tmp/session.json" } });
    mockHandle.destroy.mockClear();
    mockHandle.abort.mockClear();
    mockHandle.subscribe.mockReturnValue(() => {});
    const registry = new RuntimeRegistry();
    registry.register(mockRuntime as any);
    initAgentManager(registry);
  });

  it("passes resumeSession to runtime when sessionResume is enabled", async () => {
    sessionResumeEnabled = true;

    await activateAgent("room1", "pm");

    const createOpts = mockRuntime.createAgent.mock.calls[0][0];
    expect(createOpts.resumeSession).toEqual({
      sessionId: "session-123",
      sessionFile: "/tmp/session.json",
    });
  });

  it("does not pass resumeSession when sessionResume is disabled", async () => {
    sessionResumeEnabled = false;

    await activateAgent("room1", "pm");

    const createOpts = mockRuntime.createAgent.mock.calls[0][0];
    expect(createOpts.resumeSession).toBeUndefined();
  });

  it("does not resume from legacy name-key sessions for migrated room members", async () => {
    mockRoom = {
      id: "room1",
      name: "Room 1",
      cwd: "/tmp",
      members: ["architect"],
      roomMembers: [{ id: "rm_architect", roomId: "room1", name: "architect", sourceAgent: "architect", config: { model: "anthropic/claude-sonnet-4-6", credentialId: "cred-a" }, createdAt: 1, updatedAt: 1 }],
      createdAt: Date.now(),
    };
    vi.mocked(sessionStore.getSessions).mockReturnValue({ architect: { runtime: "pi-cli", sessionId: "legacy", sessionFile: "/tmp/legacy.json" } });

    await activateAgent("room1", "architect");

    const createOpts = mockRuntime.createAgent.mock.calls[0][0];
    expect(createOpts.member.id).toBe("rm_architect");
    expect(createOpts.resumeSession).toBeUndefined();
    expect(sessionStore.saveSession).toHaveBeenCalledWith("room1", "rm_architect", expect.objectContaining({ sessionId: "session-123" }));
  });

  it("destroys instance, clears session, resets cursor to null, and emits system event", async () => {
    await activateAgent("room1", "pm");

    const result = resetAgentSession("room1", "pm");

    expect(result).toEqual({ ok: true, message: "Session reset. Next activation will start fresh." });
    expect(mockHandle.destroy).toHaveBeenCalledTimes(1);
    expect(sessionStore.clearSession).toHaveBeenCalledWith("room1", "pm", "pi-cli");
    expect(roomStore.setCursor).toHaveBeenCalledWith("room1", "pm", null);
    expect(appendEventToDisk).toHaveBeenCalledWith(
      "room1",
      "pm",
      expect.objectContaining({ type: "system", text: "Session reset. Next activation will start fresh." }),
    );
    expect(broadcastToAgentSubscribers).toHaveBeenCalledWith(
      "room1",
      "pm",
      expect.objectContaining({
        type: "agent:event",
        roomId: "room1",
        agent: "pm",
        event: expect.objectContaining({ type: "system" }),
      }),
    );
    expect(broadcastToRoom).toHaveBeenCalledWith("room1", {
      type: "agent:status",
      roomId: "room1",
      agent: "pm",
      status: "inactive",
    });
  });

  it("deletes legacy name-key session and cursor entries when resetting a migrated member", () => {
    mockRoom = {
      id: "room1",
      name: "Room 1",
      cwd: "/tmp",
      members: ["architect"],
      roomMembers: [{ id: "rm_architect", roomId: "room1", name: "architect", sourceAgent: "architect", createdAt: 1, updatedAt: 1 }],
      createdAt: Date.now(),
    };
    vi.mocked(sessionStore.getSessions).mockReturnValue({
      rm_architect: { runtime: "pi-cli", sessionId: "current", sessionFile: "/tmp/current.json" },
      architect: { runtime: "pi-cli", sessionId: "legacy", sessionFile: "/tmp/legacy.json" },
    });

    resetAgentSession("room1", "architect");

    expect(sessionStore.clearSession).toHaveBeenCalledWith("room1", "rm_architect", "pi-cli");
    expect(sessionStore.clearSession).not.toHaveBeenCalledWith("room1", "architect", expect.any(String));
    expect(sessionStore.deleteSessionEntry).toHaveBeenCalledWith("room1", "architect");
    expect(roomStore.setCursor).toHaveBeenCalledWith("room1", "rm_architect", null);
    expect(roomStore.setCursor).not.toHaveBeenCalledWith("room1", "architect", null);
    expect(roomStore.deleteCursor).toHaveBeenCalledWith("room1", "architect");
  });
});
