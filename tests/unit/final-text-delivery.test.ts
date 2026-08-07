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

function deliveredMessages(): Array<{ text: string; extra?: Record<string, unknown> }> {
  return state.postMessage.mock.calls
    .filter((c: any[]) => c[0] === "room1" && c[1] === "developer")
    .map((c: any[]) => ({ text: c[2], extra: c[4] }));
}

function silenceNoteCalls() {
  return state.postMessage.mock.calls.filter((c: any[]) => c[0] === "room1" && c[1] === "system" && String(c[2]).includes("finished without replying"));
}

describe("final-text fallback (chat need_response debt turn)", () => {
  beforeEach(async () => {
    state.sourceAgent = "developer";
    state.promptImpl = vi.fn(async () => {});
    state.postMessage.mockReset();
    state.setCursor.mockReset();
    state.processEvent.mockReset();
    await setup();
  });

  it("delivers the last completed text verbatim when a debt turn never calls chat — autoDelivered, debt cleared, no silence note", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "I checked the logs. The fix is in place.", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    const delivered = deliveredMessages();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toBe("I checked the logs. The fix is in place.");
    expect(delivered[0].extra).toMatchObject({ autoDelivered: true });
    expect(silenceNoteCalls()).toHaveLength(0);
  });

  it("a successful chat call clears the debt: bare final text is NOT fallback-posted, no silence note", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "tool_end", toolName: "chat", toolCallId: "c1", result: {}, isError: false });
      handle.emit({ type: "message_end", text: "done — sent via chat", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(deliveredMessages()).toHaveLength(0);
    expect(silenceNoteCalls()).toHaveLength(0);
  });

  it("a failed chat call does NOT clear the debt: the fallback still posts the final text", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "tool_end", toolName: "chat", toolCallId: "c1", result: { ok: false, error: "boom" }, isError: true });
      handle.emit({ type: "message_end", text: "chat failed but here is the result anyway", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    const delivered = deliveredMessages();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toBe("chat failed but here is the result anyway");
    expect(delivered[0].extra).toMatchObject({ autoDelivered: true });
    expect(silenceNoteCalls()).toHaveLength(0);
  });

  it("FYI turn (no debt): bare text is NOT delivered and no silence note fires", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "noting this for later", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer", { needResponse: false, senderName: "qa" });

    expect(deliveredMessages()).toHaveLength(0);
    expect(silenceNoteCalls()).toHaveLength(0);
  });

  it("user @ carries debt: bare text fallback-posted with [REPLY EXPECTED] banner in the payload", async () => {
    const payloads: string[] = [];
    state.promptImpl = vi.fn(async (msg: string) => {
      payloads.push(msg);
      handle.emit({ type: "message_end", text: "bare text reply to the user", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer", { needResponse: true, senderName: "user" });

    expect(payloads[0]).toContain("[REPLY EXPECTED] Respond using the chat tool.");
    const delivered = deliveredMessages();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toBe("bare text reply to the user");
    expect(delivered[0].extra).toMatchObject({ autoDelivered: true });
  });

  it("member need_response @ carries the sender-named banner and debt", async () => {
    const payloads: string[] = [];
    state.promptImpl = vi.fn(async (msg: string) => {
      payloads.push(msg);
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer", { needResponse: true, senderName: "qa" });

    expect(payloads[0]).toContain("[REPLY EXPECTED] qa expects your reply — respond with the chat tool.");
    // No text and debt pending → silence note.
    expect(deliveredMessages()).toHaveLength(0);
    expect(silenceNoteCalls()).toHaveLength(1);
  });

  it("an error turn falls back to nothing: no delivery, no silence note (error notice already shown)", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "partial before crash", stopReason: "stop" });
      handle.emit({ type: "message_end", text: "", stopReason: "error", errorMessage: "provider exploded" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(deliveredMessages()).toHaveLength(0);
    expect(silenceNoteCalls()).toHaveLength(0);
  });

  it("abort (dispatchState aborting) does not fall back", async () => {
    state.promptImpl = vi.fn(async () => {
      const { abortAgent } = await import("../../src/engine/agent-manager.js");
      void abortAgent("room1", "developer");
      handle.emit({ type: "message_end", text: "I'll get right on it", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(deliveredMessages()).toHaveLength(0);
  });

  it("a turn ending with an aborted message_end fragment has no completed segment → silence note", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "this fragment was cut off by abort", stopReason: "aborted" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(deliveredMessages()).toHaveLength(0);
    expect(silenceNoteCalls()).toHaveLength(1);
  });

  it("fallback text with @mention routes the mention (activation handled by router)", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "@qa please verify the fallback", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    const calls = state.postMessage.mock.calls.filter((c: any[]) => c[0] === "room1" && c[1] === "developer");
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toBe("@qa please verify the fallback");
    // mentions list carries the target for the router listener.
    expect(calls[0][3]).toEqual(["qa"]);
    // The mention inside a fallback delivery does NOT carry needResponse (FYI for the target).
    expect(calls[0][4]).not.toMatchObject({ needResponse: true });
  });

  it("a debt turn with no text at all falls into the silence branch", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(deliveredMessages()).toHaveLength(0);
    expect(silenceNoteCalls()).toHaveLength(1);
  });

  it("length-truncated segment is not a fallback candidate; the continuation's completed text is", async () => {
    state.promptImpl = vi.fn(async () => {
      const call = handle.prompt.mock.calls.length;
      if (call === 1) {
        handle.emit({ type: "message_end", text: "", stopReason: "max_output_tokens" });
        handle.emit({ type: "agent_end" });
      } else if (call === 2) {
        handle.emit({ type: "message_end", text: "Full result after continuation.", stopReason: "stop" });
        handle.emit({ type: "agent_end" });
      }
    });

    await activateAgent("room1", "developer");

    expect(handle.prompt).toHaveBeenCalledTimes(2);
    expect(handle.prompt.mock.calls[1][0]).toContain("cut off due to output length");
    expect(handle.prompt.mock.calls[1][0]).toContain("`chat` tool");
    const delivered = deliveredMessages();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].text).toBe("Full result after continuation.");
    expect(delivered[0].extra).toMatchObject({ autoDelivered: true });
  });
});
