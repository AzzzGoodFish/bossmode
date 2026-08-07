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

describe("chat enforcement pending reply", () => {
  beforeEach(async () => {
    state.sourceAgent = "developer";
    state.promptImpl = vi.fn(async () => {});
    state.postMessage.mockReset();
    state.setCursor.mockReset();
    state.processEvent.mockReset();
    await setup();
  });

  it("posts an honest system note (no hidden follow-up) when a debt turn ends with no chat and no text", async () => {
    await activateAgent("room1", "developer");

    // No hidden chat_warning follow-up prompt — only the original turn ran.
    expect(handle.prompt).toHaveBeenCalledTimes(1);
    // No text at all → the silence is made visible to the room as a system message.
    expect(state.postMessage).toHaveBeenCalledWith("room1", "system", 'Member "developer" finished without replying.');
  });

  it("[room]-marked text is plain text now: a debt turn's final text is fallback-posted verbatim (marker mechanism removed)", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "Let me check...\n[room]\nFound it — the failure is in the token refresh.", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    // The marker is dead text — the completed segment is delivered as-is by the fallback.
    const delivered = state.postMessage.mock.calls.filter((c: any[]) => c[0] === "room1" && c[1] === "developer");
    expect(delivered).toHaveLength(1);
    expect(delivered[0][2]).toBe("Let me check...\n[room]\nFound it — the failure is in the token refresh.");
    expect(delivered[0][4]).toMatchObject({ autoDelivered: true });
    expect(state.postMessage).not.toHaveBeenCalledWith("room1", "system", 'Member "developer" finished without replying.');
    expect(handle.prompt).toHaveBeenCalledTimes(1);
  });

  it("a debt turn's bare final text is fallback-posted verbatim — no silence note", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "Done — the fix is in place.", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(handle.prompt).toHaveBeenCalledTimes(1);
    const delivered = state.postMessage.mock.calls.filter((c: any[]) => c[0] === "room1" && c[1] === "developer");
    expect(delivered).toHaveLength(1);
    expect(delivered[0][2]).toBe("Done — the fix is in place.");
    // Fallback delivery clears the reply debt → no silence note.
    expect(state.postMessage).not.toHaveBeenCalledWith("room1", "system", 'Member "developer" finished without replying.');
  });

  it("an FYI turn (no debt) never fallback-posts bare text and never warns", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "Let me check... done, see the fix.", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer", { needResponse: false, senderName: "qa" });

    // No debt → the text stays invisible (work note), and no silence note fires.
    expect(handle.prompt).toHaveBeenCalledTimes(1);
    expect(state.postMessage).not.toHaveBeenCalledWith("room1", "developer", expect.stringContaining("Let me check"), expect.anything());
    expect(state.postMessage).not.toHaveBeenCalledWith("room1", "system", 'Member "developer" finished without replying.');
  });

  it("continues once after length truncation even when SDK emits no compaction event", async () => {
    state.promptImpl = vi.fn(async () => {
      const call = handle.prompt.mock.calls.length;
      if (call === 1) {
        // Truncated segment: no text captured (not a completed segment), continuation requested.
        handle.emit({ type: "message_end", text: "", stopReason: "max_output_tokens" });
        handle.emit({ type: "agent_end" });
      } else if (call === 2) {
        // Continuation completes with a final text → fallback-posted.
        handle.emit({ type: "message_end", text: "Full result after continuation.", stopReason: "stop" });
        handle.emit({ type: "agent_end" });
      }
    });

    await activateAgent("room1", "developer");

    expect(handle.prompt).toHaveBeenCalledTimes(2);
    expect(handle.prompt.mock.calls[1][0]).toContain("cut off due to output length");
    expect(handle.prompt.mock.calls[1][0]).toContain("`chat` tool");
    // Only the continuation's completed text was fallback-posted.
    const delivered = state.postMessage.mock.calls.filter((c: any[]) => c[0] === "room1" && c[1] === "developer");
    expect(delivered).toHaveLength(1);
    expect(delivered[0][2]).toBe("Full result after continuation.");
  });

  it("continues once after length-truncated threshold compaction with no SDK retry", async () => {
    state.promptImpl = vi.fn(async () => {
      const call = handle.prompt.mock.calls.length;
      if (call === 1) {
        handle.emit({ type: "message_end", text: "", stopReason: "length" });
        handle.emit({ type: "agent_end" });
        handle.emit({ type: "compaction_start", reason: "threshold" });
        handle.emit({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
      } else if (call === 2) {
        handle.emit({ type: "message_end", text: "Result after threshold compaction.", stopReason: "stop" });
        handle.emit({ type: "agent_end" });
      }
    });

    await activateAgent("room1", "developer");

    expect(handle.prompt).toHaveBeenCalledTimes(2);
    expect(handle.prompt.mock.calls[1][0]).toContain("cut off due to output length");
    expect(handle.prompt.mock.calls[1][0]).toContain("`chat` tool");
    const delivered = state.postMessage.mock.calls.filter((c: any[]) => c[0] === "room1" && c[1] === "developer");
    expect(delivered).toHaveLength(1);
    expect(delivered[0][2]).toBe("Result after threshold compaction.");
  });

  it("does not continue after normal threshold compaction", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "done", stopReason: "stop" });
      handle.emit({ type: "agent_end" });
      handle.emit({ type: "compaction_start", reason: "threshold" });
      handle.emit({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
    });

    await activateAgent("room1", "developer");

    expect(handle.prompt).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate SDK retry when runtime starts again after length truncation", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "", stopReason: "length" });
      handle.emit({ type: "agent_end" });
      handle.emit({ type: "compaction_start", reason: "overflow" });
      handle.emit({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: true });
      handle.emit({ type: "agent_start" });
    });

    await activateAgent("room1", "developer");

    expect(handle.prompt).toHaveBeenCalledTimes(1);
  });

  it("stops after one automatic length continuation to avoid loops", async () => {
    state.promptImpl = vi.fn(async () => {
      const call = handle.prompt.mock.calls.length;
      handle.emit({ type: "message_end", text: "", stopReason: "length" });
      handle.emit({ type: "agent_end" });
      handle.emit({ type: "compaction_start", reason: "threshold" });
      handle.emit({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
    });

    await activateAgent("room1", "developer");

    expect(handle.prompt).toHaveBeenCalledTimes(2);
    expect(state.postMessage).toHaveBeenCalledWith("room1", "system", expect.stringContaining("Automatic continuation stopped to avoid a loop"));
  });
});
