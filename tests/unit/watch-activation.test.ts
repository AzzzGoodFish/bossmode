import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/workspace/team-store.js", () => ({
  ensureRoomTeamAgent: (_roomId: string, agent: string) => ({
    name: agent, description: agent, systemPrompt: "test", tags: [], skills: [],
  }),
  loadRoomTeamAgent: (_roomId: string, agent: string) => ({
    name: agent, description: agent, systemPrompt: "test", tags: [], skills: [],
  }),
  resolveRoomSkillPaths: (_roomId: string, skills: string[]) => skills.map((s: string) => "/tmp/skills/" + s),
}));
import type { AgentStreamEvent } from "../../src/engine/runtime/types.js";

const state = vi.hoisted(() => ({
  sourceAgent: "developer",
  promptImpl: vi.fn(async (_message: string) => {}),
  postMessage: vi.fn(),
  setCursor: vi.fn(),
  processEvent: vi.fn(() => undefined),
}));

class TestHandle {
  listeners = new Set<(event: AgentStreamEvent) => void>();
  prompt = vi.fn(async (message: string) => state.promptImpl(message));
  steer = vi.fn();
  abort = vi.fn();
  destroy = vi.fn();
  waitForIdle = vi.fn(async () => {});
  subscribe = vi.fn((fn: (event: AgentStreamEvent) => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); });
  emit(event: AgentStreamEvent) { for (const fn of this.listeners) fn(event); }
}

let handle: TestHandle;

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => "/tmp/bossmode-test",
  readConfig: () => ({ runtime: { sessionResume: false }, defaults: {}, apiKeys: {} }),
}));

vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: vi.fn((name: string) => ({ name, description: name, systemPrompt: `${name} prompt`, tags: [] })),
}));

vi.mock("../../src/workforce/member-store.js", () => ({
  getMemberByName: vi.fn((name: string) => ({ id: name, name, type: "agent", agent: state.sourceAgent, model: "anthropic/claude-sonnet-4-6", credentialId: "cred-a", runtime: "test", thinkingLevel: "off" })),
}));

vi.mock("../../src/workspace/room-store.js", () => ({
  getRoom: vi.fn(() => ({ id: "room1", name: "Room", cwd: "/tmp", members: ["developer"], createdAt: 1, roomMembers: [{ id: "rm_dev", name: "developer", sourceAgent: state.sourceAgent, createdAt: 1, updatedAt: 1, migratedFrom: { memberName: "developer" } }] })),
  getCursors: vi.fn(() => ({ rm_dev: null })),
  setCursor: state.setCursor,
  resolveRoomMemberRef: vi.fn((_roomId: string, ref: string) => ref === "developer" || ref === "rm_dev" ? { id: "rm_dev", name: "developer", sourceAgent: state.sourceAgent, createdAt: 1, updatedAt: 1, migratedFrom: { memberName: "developer" } } : null),
  getRoomMembers: vi.fn(() => [{ id: "rm_dev", name: "developer", sourceAgent: state.sourceAgent, createdAt: 1, updatedAt: 1, migratedFrom: { memberName: "developer" } }]),
}));

vi.mock("../../src/workspace/session-store.js", () => ({
  getSessions: vi.fn(() => ({})),
  saveSession: vi.fn(),
}));

vi.mock("../../src/workspace/attachment-store.js", () => ({
  getAttachmentPath: vi.fn(),
}));

vi.mock("../../src/communication/message-bus.js", () => ({
  postMessage: state.postMessage,
  getMessagesSince: vi.fn(() => [{ id: "msg-1", sender: "qa", senderMemberId: "rm_qa", content: "report ready", mentions: [], ts: Date.now() }]),
  getLatestMessageId: vi.fn(() => "msg-1"),
}));

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToRoom: vi.fn(),
  broadcastToAgentSubscribers: vi.fn(),
}));

vi.mock("../../src/engine/prompt-compiler.js", () => ({
  compileMemberPrompt: vi.fn(() => ({ agentPrompt: "agent", envPrompt: "env", appendSystemPrompt: [], fullPrompt: "agent\n\nenv" })),
}));

vi.mock("../../src/engine/event-handler.js", () => ({
  handleAgentEvent: state.processEvent,
  loadEventsFromDisk: vi.fn(() => []),
  appendEventToDisk: vi.fn(),
}));

import { RuntimeRegistry } from "../../src/engine/runtime/registry.js";
import { activateAgent, activateAgentForWatch, initAgentManager, shutdownAll } from "../../src/engine/agent-manager.js";
import { getActivationSource, clearAllActivationSources } from "../../src/engine/activation-context.js";

async function setup() {
  await shutdownAll();
  clearAllActivationSources();
  handle = new TestHandle();
  const runtime = {
    name: "test",
    capabilities: { streaming: true, toolEvents: true, thinking: false, usage: false, dynamicModel: false, dynamicThinking: false, permissionControl: false, sessionResume: false },
    detect: vi.fn(async () => ({ available: true })),
    createAgent: vi.fn(async () => handle as any),
    shutdownAll: vi.fn(async () => {}),
  };
  const registry = new RuntimeRegistry();
  registry.register(runtime as any);
  initAgentManager(registry);
}

describe("watch activation", () => {
  beforeEach(async () => {
    state.sourceAgent = "developer";
    state.promptImpl = vi.fn(async () => {});
    state.postMessage.mockReset();
    state.setCursor.mockReset();
    state.processEvent.mockReset();
    await setup();
  });

  it("delivers the new-message batch with a watch banner prefix", async () => {
    await activateAgentForWatch("room1", "rm_dev", { targetName: "qa" });

    expect(handle.prompt).toHaveBeenCalledTimes(1);
    const payload = handle.prompt.mock.calls[0][0] as string;
    expect(payload.startsWith("Watch notification: qa posted in this room.")).toBe(true);
    expect(payload).toContain("report ready");
  });

  it("marks activation source as watch (not room_mention)", async () => {
    await activateAgentForWatch("room1", "rm_dev", { targetName: "qa" });
    expect(getActivationSource("room1", "rm_dev")).toBe("watch");
  });

  it("advances the cursor (same as @ activation)", async () => {
    await activateAgentForWatch("room1", "rm_dev", { targetName: "qa" });
    expect(state.setCursor).toHaveBeenCalledWith("room1", "rm_dev", "msg-1");
  });

  it("silent turn after watch activation does NOT post 'finished without replying' (no reply debt)", async () => {
    await activateAgentForWatch("room1", "rm_dev", { targetName: "qa" });

    expect(handle.prompt).toHaveBeenCalledTimes(1);
    const silenceNote = state.postMessage.mock.calls.find(
      (c) => c[1] === "system" && typeof c[2] === "string" && c[2].includes("finished without replying"),
    );
    expect(silenceNote).toBeUndefined();
  });

  it("@ activation still carries reply debt (regression on the shared path)", async () => {
    await activateAgent("room1", "developer");

    expect(handle.prompt).toHaveBeenCalledTimes(1);
    expect(getActivationSource("room1", "rm_dev")).toBe("room_mention");
    expect(state.postMessage).toHaveBeenCalledWith("room1", "system", 'Member "developer" finished without replying.');
  });

  it("@ activation payload has no watch banner (regression)", async () => {
    await activateAgent("room1", "developer");
    const payload = handle.prompt.mock.calls[0][0] as string;
    expect(payload).not.toContain("Watch notification:");
  });
});
