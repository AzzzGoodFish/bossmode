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
  processEvent: vi.fn(() => undefined as string | undefined),
  appendEventToDisk: vi.fn(),
  broadcastToAgentSubscribers: vi.fn(),
  broadcastToRoom: vi.fn(),
  notifyMemberIdle: vi.fn(),
}));

class TestHandle {
  listeners = new Set<(event: AgentStreamEvent) => void>();
  prompt = vi.fn(async (message: string) => state.promptImpl(message));
  steer = vi.fn();
  abort = vi.fn();
  destroy = vi.fn();
  waitForIdle = vi.fn(async () => {});
  subscribe = vi.fn((fn: (event: AgentStreamEvent) => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  });
  emit(event: AgentStreamEvent) {
    for (const fn of this.listeners) fn(event);
  }
}

let handle: TestHandle;

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: () => "/tmp/bossmode-test-will-retry",
  readConfig: () => ({ runtime: { sessionResume: false }, defaults: {}, apiKeys: {} }),
}));

vi.mock("../../src/workforce/member-store.js", () => ({
  getMemberByName: vi.fn((name: string) => ({
    id: name, name, type: "agent", agent: state.sourceAgent,
    model: "anthropic/claude-sonnet-4-6", credentialId: "cred-a", runtime: "test", thinkingLevel: "off",
  })),
}));

vi.mock("../../src/workspace/room-store.js", () => ({
  getRoom: vi.fn(() => ({
    id: "room1", name: "Room", cwd: "/tmp", members: ["developer"], createdAt: 1,
    roomMembers: [{ id: "rm_dev", name: "developer", sourceAgent: state.sourceAgent, createdAt: 1, updatedAt: 1, migratedFrom: { memberName: "developer" } }],
  })),
  getCursors: vi.fn(() => ({ rm_dev: null })),
  setCursor: state.setCursor,
  resolveRoomMemberRef: vi.fn((_roomId: string, ref: string) =>
    ref === "developer" || ref === "rm_dev"
      ? { id: "rm_dev", name: "developer", sourceAgent: state.sourceAgent, createdAt: 1, updatedAt: 1, migratedFrom: { memberName: "developer" } }
      : null),
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
  broadcastToRoom: state.broadcastToRoom,
  broadcastToAgentSubscribers: state.broadcastToAgentSubscribers,
}));

vi.mock("../../src/engine/prompt-compiler.js", () => ({
  compileMemberPrompt: vi.fn(() => ({ agentPrompt: "agent", envPrompt: "env", appendSystemPrompt: [], fullPrompt: "agent\n\nenv", contractFingerprint: "fp" })),
  compileMemberPromptForScope: vi.fn(() => ({ agentPrompt: "agent", envPrompt: "env", appendSystemPrompt: [], fullPrompt: "agent\n\nenv", contractFingerprint: "fp" })),
}));

vi.mock("../../src/engine/wait-wait.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/wait-wait.js")>("../../src/engine/wait-wait.js");
  return {
    ...actual,
    notifyMemberIdle: (...args: unknown[]) => state.notifyMemberIdle(...args),
  };
});

vi.mock("../../src/engine/event-handler.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/engine/event-handler.js")>("../../src/engine/event-handler.js");
  return {
    ...actual,
    // Use real processEvent for willRetry status decisions
    loadEventsFromDisk: vi.fn(() => []),
    appendEventToDisk: state.appendEventToDisk,
  };
});

import { RuntimeRegistry } from "../../src/engine/runtime/registry.js";
import { activateAgent, getAgentStatus, initAgentManager, shutdownAll } from "../../src/engine/agent-manager.js";
import { mapPiAgentEvent } from "../../src/engine/runtime/pi-events.js";
import { handleAgentEvent as processEvent } from "../../src/engine/event-handler.js";

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

describe("mapPiAgentEvent willRetry passthrough", () => {
  it("maps agent_end.willRetry from raw pi event", () => {
    expect(mapPiAgentEvent({ type: "agent_end", willRetry: true })).toEqual({ type: "agent_end", willRetry: true });
    expect(mapPiAgentEvent({ type: "agent_end" })).toEqual({ type: "agent_end", willRetry: false });
  });
});

describe("processEvent willRetry does not idle", () => {
  it("returns undefined for agent_end willRetry (no public idle)", () => {
    const buf: any[] = [];
    const status = processEvent("room1", "developer", "k", { type: "agent_end", willRetry: true }, buf, "rm_dev");
    expect(status).toBeUndefined();
  });

  it("returns idle for final agent_end", () => {
    const buf: any[] = [];
    const status = processEvent("room1", "developer", "k", { type: "agent_end", willRetry: false }, buf, "rm_dev");
    expect(status).toBe("idle");
  });
});

describe("willRetry idle + deferred error notice + user_steer", () => {
  beforeEach(async () => {
    state.sourceAgent = "developer";
    state.promptImpl = vi.fn(async () => {
      // hang until test emits events
    });
    state.postMessage.mockReset();
    state.setCursor.mockReset();
    state.appendEventToDisk.mockReset();
    state.broadcastToAgentSubscribers.mockReset();
    state.broadcastToRoom.mockReset();
    state.notifyMemberIdle.mockReset();
    await setup();
  });

  it("keeps working across willRetry agent_end; one system notice on final failure", async () => {
    const promptDone = new Promise<void>((resolve) => {
      state.promptImpl = vi.fn(async () => {
        handle.emit({ type: "agent_start" });
        handle.emit({ type: "message_end", text: "", stopReason: "error", errorMessage: "Request timed out" });
        handle.emit({ type: "agent_end", willRetry: true });
        expect(getAgentStatus("room1", "rm_dev")).toBe("working");
        expect(state.notifyMemberIdle).not.toHaveBeenCalled();
        expect(state.postMessage).not.toHaveBeenCalledWith(
          "room1",
          "system",
          expect.stringContaining("request failed"),
        );

        handle.emit({ type: "agent_start" });
        handle.emit({ type: "message_end", text: "", stopReason: "error", errorMessage: "Request timed out" });
        handle.emit({ type: "agent_end", willRetry: false });
        resolve();
      });
    });

    await activateAgent("room1", "developer");
    await promptDone;
    await new Promise((r) => setTimeout(r, 20));

    expect(getAgentStatus("room1", "rm_dev")).toBe("idle");
    expect(state.notifyMemberIdle).toHaveBeenCalled();
    const systemFails = state.postMessage.mock.calls.filter(
      (c) => c[1] === "system" && String(c[2]).includes("request failed"),
    );
    expect(systemFails).toHaveLength(1);
  });

  it("mid-turn mention interrupts the run (design-interrupt-on-message-v1): abort, no steer, one activity card", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "agent_start" });
      await gate;
      handle.emit({ type: "message_end", text: "done", stopReason: "stop" });
      handle.emit({ type: "agent_end", willRetry: false });
    });

    const first = activateAgent("room1", "developer");
    await new Promise((r) => setTimeout(r, 20));
    expect(getAgentStatus("room1", "rm_dev")).toBe("working");

    // Second @ while working → interrupt path: abort (never steer), the
    // message is queued at the front banner-wrapped. fish 2026-09-05: NO
    // user_steer event here — the drained queue emits exactly one user_prompt
    // (banner + message); the old pre-emit made one message two cards.
    await activateAgent("room1", "developer");
    expect(handle.steer).not.toHaveBeenCalled();
    expect(handle.abort).toHaveBeenCalled();
    const steers = state.appendEventToDisk.mock.calls
      .map((c: any[]) => c[2])
      .filter((e: any) => e?.type === "user_steer");
    expect(steers).toHaveLength(0);

    release();
    await first;
    await new Promise((r) => setTimeout(r, 40));

    // The drained interrupt produced exactly one user_prompt (banner +
    // message), and the model received the interrupted message exactly once.
    const prompts = state.appendEventToDisk.mock.calls
      .map((c: any[]) => c[2])
      .filter((e: any) => e?.type === "user_prompt");
    const interruptCards = prompts.filter((e: any) => typeof e.text === "string" && e.text.includes("interrupted by this message"));
    expect(interruptCards).toHaveLength(1);
    expect(interruptCards[0].text).toContain("@developer hi");
    const modelCalls = handle.prompt.mock.calls.filter((c: any[]) => String(c[0]).includes("interrupted by this message"));
    expect(modelCalls).toHaveLength(1);
    expect(String(modelCalls[0][0])).toContain("@developer hi");
  });
});
