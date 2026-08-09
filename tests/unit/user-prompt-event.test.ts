import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent } from "../../src/engine/runtime/types.js";

vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: (agent: string) => ({
    name: agent, description: agent, systemPrompt: "test", tags: [], skills: [],
  }),
}));

vi.mock("../../src/workforce/skill-store.js", () => ({
  resolveGlobalSkillPaths: (skillNames: string[]) => skillNames.map((s: string) => "/tmp/skills/" + s),
}));

const state = vi.hoisted(() => ({
  sourceAgent: "developer",
  promptImpl: vi.fn(async (_message: string) => {}),
  postMessage: vi.fn(),
  setCursor: vi.fn(),
  processEvent: vi.fn(() => undefined),
  appendEventToDisk: vi.fn(),
  broadcastToAgentSubscribers: vi.fn(),
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
  getBossmodeDir: () => "/tmp/bossmode-test-user-prompt",
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
  getMessagesSince: vi.fn(() => [{ id: "msg-1", sender: "user", content: "@developer hi", mentions: ["developer"], ts: Date.now() }]),
  getLatestMessageId: vi.fn(() => "msg-1"),
}));

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToRoom: vi.fn(),
  broadcastToAgentSubscribers: state.broadcastToAgentSubscribers,
}));

vi.mock("../../src/engine/prompt-compiler.js", () => ({
  compileMemberPrompt: vi.fn(() => ({ agentPrompt: "agent", envPrompt: "env", appendSystemPrompt: [], fullPrompt: "agent\n\nenv", contractFingerprint: "fp" })),
  compileMemberPromptForScope: vi.fn(() => ({ agentPrompt: "agent", envPrompt: "env", appendSystemPrompt: [], fullPrompt: "agent\n\nenv", contractFingerprint: "fp" })),
}));

vi.mock("../../src/engine/event-handler.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/event-handler.js")>("../../src/engine/event-handler.js");
  return {
    ...actual,
    handleAgentEvent: state.processEvent,
    loadEventsFromDisk: vi.fn(() => []),
    appendEventToDisk: state.appendEventToDisk,
  };
});

import { RuntimeRegistry } from "../../src/engine/runtime/registry.js";
import { activateAgent, initAgentManager, shutdownAll } from "../../src/engine/agent-manager.js";
import { formatToolArgsFull, getSanitizedArgs } from "../../web/src/components/agent-event-utils.js";

async function setup() {
  await shutdownAll();
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

describe("user_prompt activity event", () => {
  beforeEach(async () => {
    state.sourceAgent = "developer";
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "ok", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });
    state.postMessage.mockReset();
    state.setCursor.mockReset();
    state.processEvent.mockReset();
    state.appendEventToDisk.mockReset();
    state.broadcastToAgentSubscribers.mockReset();
    await setup();
  });

  it("emits user_prompt with the full composed payload on activate", async () => {
    await activateAgent("room1", "developer");

    const promptEvents = state.appendEventToDisk.mock.calls
      .map((c: any[]) => c[2])
      .filter((e: any) => e?.type === "user_prompt");
    expect(promptEvents).toHaveLength(1);
    expect(promptEvents[0].trigger).toBe("activate");
    expect(String(promptEvents[0].text)).toContain("@developer hi");

    const wsEvents = state.broadcastToAgentSubscribers.mock.calls
      .map((c: any[]) => c[2]?.event)
      .filter((e: any) => e?.type === "user_prompt");
    expect(wsEvents.length).toBeGreaterThanOrEqual(1);
  });
});

describe("tool args full sanitize", () => {
  it("redacts sensitive keys without truncating long content", () => {
    const long = "x".repeat(500);
    const out = getSanitizedArgs({
      content: long,
      api_key: "secret-value",
      nested: { password: "p", body: "ok" },
    }) as any;
    expect(out.content).toBe(long);
    expect(out.api_key).toBe("[redacted]");
    expect(out.nested.password).toBe("[redacted]");
    expect(out.nested.body).toBe("ok");
    const json = formatToolArgsFull({ content: long, token: "t" });
    expect(json).toContain(long);
    expect(json).toContain("[redacted]");
    expect(json).not.toContain("\"t\"");
  });
});
