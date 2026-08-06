import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: (agent: string) => ({
    name: agent, description: agent, systemPrompt: "test", tags: [], skills: [],
  }),
}));

vi.mock("../../src/workforce/skill-store.js", () => ({
  resolveGlobalSkillPaths: (skillNames: string[]) => skillNames.map((s: string) => "/tmp/skills/" + s),
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
  getRoom: vi.fn(() => ({ id: "room1", name: "Room", cwd: "/tmp", members: ["developer", "qa"], createdAt: 1, roomMembers: [{ id: "rm_dev", name: "developer", sourceAgent: state.sourceAgent, createdAt: 1, updatedAt: 1, migratedFrom: { memberName: "developer" } }, { id: "rm_qa", name: "qa", sourceAgent: "qa", createdAt: 1, updatedAt: 1, migratedFrom: { memberName: "qa" } }] })),
  getCursors: vi.fn(() => ({ rm_dev: null, rm_qa: null })),
  setCursor: state.setCursor,
  resolveRoomMemberRef: vi.fn((_roomId: string, ref: string) => {
    if (ref === "developer" || ref === "rm_dev") return { id: "rm_dev", name: "developer", sourceAgent: state.sourceAgent, createdAt: 1, updatedAt: 1, migratedFrom: { memberName: "developer" } };
    if (ref === "qa" || ref === "rm_qa") return { id: "rm_qa", name: "qa", sourceAgent: "qa", createdAt: 1, updatedAt: 1, migratedFrom: { memberName: "qa" } };
    return null;
  }),
  getRoomMembers: vi.fn(() => [{ id: "rm_dev", name: "developer", sourceAgent: state.sourceAgent, createdAt: 1, updatedAt: 1, migratedFrom: { memberName: "developer" } }, { id: "rm_qa", name: "qa", sourceAgent: "qa", createdAt: 1, updatedAt: 1, migratedFrom: { memberName: "qa" } }]),
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
import { activateAgent, initAgentManager, shutdownAll } from "../../src/engine/agent-manager.js";
import { matchResponsePrefix } from "../../src/engine/tools.js";

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

function deliveredMessages(): string[] {
  return state.postMessage.mock.calls
    .filter((c: any[]) => c[0] === "room1" && c[1] === "developer")
    .map((c: any[]) => c[2]);
}

describe("response prefix matching", () => {
  it("matches lowercase half-width colon", () => {
    expect(matchResponsePrefix("response: hi")).toEqual({ matched: true, body: "hi" });
  });

  it("matches uppercase and full-width colon (k3 Chinese habit)", () => {
    expect(matchResponsePrefix("Response：你好")).toEqual({ matched: true, body: "你好" });
    expect(matchResponsePrefix("RESPONSE: 收到")).toEqual({ matched: true, body: "收到" });
  });

  it("tolerates leading whitespace and spaces around the colon", () => {
    expect(matchResponsePrefix("  response : done")).toEqual({ matched: true, body: "done" });
  });

  it("does not trigger on a mention inside the text", () => {
    expect(matchResponsePrefix("we discussed the response: prefix earlier")).toEqual({ matched: false, body: expect.any(String) });
    expect(matchResponsePrefix("see response: above")).toEqual({ matched: false, body: expect.any(String) });
  });

  it("returns empty body when only the prefix is present", () => {
    expect(matchResponsePrefix("response:")).toEqual({ matched: true, body: "" });
    expect(matchResponsePrefix("Response： ")).toEqual({ matched: true, body: "" });
  });
});

describe("final-text delivery (0.21 conditional delivery)", () => {
  beforeEach(async () => {
    state.sourceAgent = "developer";
    state.promptImpl = vi.fn(async () => {});
    state.postMessage.mockReset();
    state.setCursor.mockReset();
    state.processEvent.mockReset();
    await setup();
  });

  it("delivers a mid-turn prefixed segment immediately and the final prefixed text once more", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "response: 收到，开查", stopReason: "stop" });
      handle.emit({ type: "message_end", text: "response: 最终结果在这", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    // Both prefixed segments go out; the final one is not double-posted.
    expect(deliveredMessages()).toEqual(["收到，开查", "最终结果在这"]);
    expect(state.postMessage).not.toHaveBeenCalledWith("room1", "system", 'Member "developer" finished without replying.');
  });

  it("mid-turn prefixed delivery clears the debt: unprefixed final text adds nothing, no silence note", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "response: 收到，开查", stopReason: "stop" });
      handle.emit({ type: "message_end", text: "总结完毕，细节如上", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(deliveredMessages()).toEqual(["收到，开查"]);
    expect(state.postMessage).not.toHaveBeenCalledWith("room1", "system", 'Member "developer" finished without replying.');
  });

  it("an error turn delivers nothing and posts no silence note (error notice already shown)", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "response: partial before crash", stopReason: "stop" });
      handle.emit({ type: "message_end", text: "", stopReason: "error", errorMessage: "provider exploded" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    // The mid-turn prefixed segment was already delivered (it completed before the error).
    expect(deliveredMessages()).toEqual(["partial before crash"]);
    // The failed final segment is not a completed segment → nothing at settlement,
    // and hadErrorInTurn suppresses the silence note (system error notice covers it).
    expect(state.postMessage).not.toHaveBeenCalledWith("room1", "system", 'Member "developer" finished without replying.');
  });

  it("abort (dispatchState aborting) delivers nothing at settlement", async () => {
    state.promptImpl = vi.fn(async () => {
      // Simulate an urgent interrupt: the abort path marks the instance aborting
      // before settlement runs.
      const { abortAgent } = await import("../../src/engine/agent-manager.js");
      void abortAgent("room1", "developer");
      handle.emit({ type: "message_end", text: "response: I'll get right on it", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    // The prefixed segment completed before the interrupt → already delivered mid-turn.
    expect(deliveredMessages()).toEqual(["I'll get right on it"]);
  });

  it("no delivery at all when the turn ends with an aborted message_end fragment", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "response: this fragment was cut off by abort", stopReason: "aborted" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    // stopReason aborted → not a completed segment → nothing delivered.
    expect(deliveredMessages()).toEqual([]);
  });

  it("final text with @mention routes the mention (activation handled by router)", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "response: @qa please verify", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    const calls = state.postMessage.mock.calls.filter((c: any[]) => c[0] === "room1" && c[1] === "developer");
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toBe("@qa please verify");
    // mentions list carries the target for the router listener.
    expect(calls[0][3]).toEqual(["qa"]);
  });

  it("empty prefix body is not delivered and falls into the silence branch", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "response:", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(deliveredMessages()).toEqual([]);
    expect(state.postMessage).toHaveBeenCalledWith("room1", "system", 'Member "developer" finished without replying.');
  });
});
