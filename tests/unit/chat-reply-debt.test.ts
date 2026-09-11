// Reply-debt turns without a chat call: nothing is delivered, the silence is
// made visible as a system note. The final-text fallback (autoDelivered) was
// retired 2026-09-11 (fish #19368/#19381; plan-retire-chat-fallback-v1).
import { coreFixture } from "../helpers/core-fixture.js";
import { getDatabase } from "../../src/storage/database.js";
import { MembersRepository } from "../../src/storage/repositories/members.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as bus from "../../src/communication/message-bus.js";

type PromptOptions = { beforeDispatch?: (event: { attemptId: string; dispatchIndex: number; message: string }) => void };
function dispatch(message: string, options?: PromptOptions) {
  getDatabase().transaction(() => options?.beforeDispatch?.({ attemptId: `mock-${randomUUID()}`, dispatchIndex: 0, message }));
}
let fixture: ReturnType<typeof coreFixture>;
let compactionRefreshPending = false;
vi.mock("../../src/communication/message-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/communication/message-bus.js")>();
  return { ...actual, postMessage: vi.fn(actual.postMessage) };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentStreamEvent, CreateAgentOpts } from "../../src/engine/runtime/types.js";

const state = vi.hoisted(() => ({
  promptImpl: vi.fn(async (_message: string) => {}),
}));

class TestHandle {
  onChat!: (message: string) => Promise<void>;
  listeners = new Set<(event: AgentStreamEvent) => void>();
  prompt = vi.fn(async (message: string, options?: PromptOptions) => { dispatch(message, options); return state.promptImpl(message); });
  steer = vi.fn();
  abort = vi.fn();
  destroy = vi.fn();
  async destroyAndWait(): Promise<void> { this.abort(); await this.waitForIdle(); this.destroy(); }
  waitForIdle = vi.fn(async () => {});
  subscribe = vi.fn((fn: (event: AgentStreamEvent) => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); });
  emit(event: AgentStreamEvent) {
    if (event.type === "compaction_end") compactionRefreshPending = true;
    for (const fn of this.listeners) fn(event);
  }
}

let handle: TestHandle;

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToRoom: vi.fn(),
  broadcastToAgentSubscribers: vi.fn(),
}));

import { RuntimeRegistry } from "../../src/engine/runtime/registry.js";
import { activateAgent, initAgentManager, shutdownAll } from "../../src/engine/agent-manager.js";

async function setup() {
  await shutdownAll();
  handle = new TestHandle();
  const runtime = {
    name: "pi-cli",
    capabilities: { streaming: true, toolEvents: true, thinking: false, usage: false, dynamicModel: false, dynamicThinking: false, permissionControl: false, sessionResume: false },
    detect: vi.fn(async () => ({ available: true })),
    createAgent: vi.fn(async (options: CreateAgentOpts) => { handle.onChat = options.callbacks!.onChat!; return handle; }),
    shutdownAll: vi.fn(async () => {}),
  };
  const registry = new RuntimeRegistry();
  registry.register(runtime as any);
  initAgentManager(registry);
}

/** Messages posted as the member itself — must stay empty when chat was not called. */
function memberMessages(scope = "room1"): Array<{ text: string }> {
  return bus.getMessagesSince(scope, null)
    .filter((message) => message.senderMemberId === "mem_developer")
    .map((message) => ({ text: message.content }));
}

function silenceNoteCalls() {
  return bus.getMessagesSince("room1", null).filter((message) => message.sender === "system" && message.content.includes("finished without replying"));
}

beforeEach(async () => {
  compactionRefreshPending = false;
  fixture = coreFixture();
  (await import("../../src/shared/config.js")).writeConfig({ auth: { username: "test", passwordHash: "fixture" }, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 }, runtime: { sessionResume: false } });
  const members = new MembersRepository(fixture.db);
  const conversations = new ConversationsRepository(fixture.db);
  for (const name of ["developer", "qa"]) {
    const id = `mem_${name}`;
    members.insert({ id, name, agentTemplate: name, global: { model: "anthropic/claude-a", credentialId: "cred-a" },
      unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}, createdAt: 1, updatedAt: 1 });
    conversations.ensureDmScope(id);
    const memberPath = join(fixture.root, "members", id);
    mkdirSync(memberPath, { recursive: true });
    writeFileSync(join(memberPath, "persona.md"), `You are ${name}.`);
  }
  for (const id of ["room1", "room2", "room3"]) {
    conversations.upsertRoom({ id, name: id, cwd: fixture.root, members: ["developer", "qa"], globalMemberIds: ["mem_developer", "mem_qa"], createdAt: 1 });
  }
  bus.postMessage("room1", "user", "@developer hi", ["developer"]);
  vi.mocked(bus.postMessage).mockClear();
});
afterEach(async () => {
  await (await import("../../src/engine/agent-manager.js")).shutdownAll();
  // The real event consumer schedules post-compaction refreshes up to 1500ms.
  if (compactionRefreshPending) await new Promise((resolve) => setTimeout(resolve, 1600));
  fixture.close();
});

describe("reply debt turns without chat (final-text fallback retired)", () => {
  beforeEach(async () => {
    state.promptImpl = vi.fn(async () => {});
    vi.mocked(bus.postMessage).mockClear();
    await setup();
  });

  it("a debt turn that never calls chat delivers nothing — the silence note fires", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "I checked the logs. The fix is in place.", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(memberMessages()).toHaveLength(0);
    expect(silenceNoteCalls()).toHaveLength(1);
  });

  it("a successful chat call delivers via chat and clears the debt: no silence note", async () => {
    state.promptImpl = vi.fn(async () => {
      // Exercise the runtime callback: real publication, no successful-tool-event shortcut.
      await handle.onChat("Sent via chat");
      handle.emit({ type: "message_end", text: "done — sent via chat", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(memberMessages()).toEqual([{ text: "Sent via chat" }]);
    expect(silenceNoteCalls()).toHaveLength(0);
  });

  it("a failed chat call leaves the debt pending: nothing delivered, silence note fires", async () => {
    state.promptImpl = vi.fn(async () => {
      expect(() => getDatabase().transaction(() => {
        bus.postMessage("room1", "developer", "Uncommitted chat", [], { senderMemberId: "mem_developer" });
        throw new Error("boom");
      })).toThrow("boom");
      handle.emit({ type: "tool_end", toolName: "chat", toolCallId: "c1", result: { ok: false, error: "boom" }, isError: true });
      handle.emit({ type: "message_end", text: "chat failed but here is the result anyway", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(memberMessages()).toHaveLength(0);
    expect(silenceNoteCalls()).toHaveLength(1);
  });

  it("an FYI turn (no debt) posts neither text nor a silence note", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "noting this for later", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer", { needResponse: [], senderName: "qa" });

    expect(memberMessages()).toHaveLength(0);
    expect(silenceNoteCalls()).toHaveLength(0);
  });

  it("user @ carries debt: banner stays in the payload, nothing is delivered, note fires", async () => {
    const payloads: string[] = [];
    state.promptImpl = vi.fn(async (msg: string) => {
      payloads.push(msg);
      handle.emit({ type: "message_end", text: "bare text reply to the user", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer", { needResponse: ["developer"], senderName: "user" });

    expect(payloads[0]).toContain("[REPLY EXPECTED] Respond using the chat tool.");
    expect(memberMessages()).toHaveLength(0);
    expect(silenceNoteCalls()).toHaveLength(1);
  });

  it("internal member reply expectation carries the sender-named banner; no text → note", async () => {
    const payloads: string[] = [];
    state.promptImpl = vi.fn(async (msg: string) => {
      payloads.push(msg);
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer", { needResponse: ["developer"], senderName: "qa" });

    expect(payloads[0]).toContain("[REPLY EXPECTED] qa expects your reply — respond with the chat tool.");
    expect(memberMessages()).toHaveLength(0);
    expect(silenceNoteCalls()).toHaveLength(1);
  });

  it("an error turn delivers nothing and fires no note (error notice already shown)", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "partial before crash", stopReason: "stop" });
      handle.emit({ type: "message_end", text: "", stopReason: "error", errorMessage: "provider exploded" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(memberMessages()).toHaveLength(0);
    expect(silenceNoteCalls()).toHaveLength(0);
  });

  it("abort (dispatchState aborting) delivers nothing", async () => {
    state.promptImpl = vi.fn(async () => {
      const { abortAgent } = await import("../../src/engine/agent-manager.js");
      void abortAgent("room1", "developer");
      handle.emit({ type: "message_end", text: "I'll get right on it", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(memberMessages()).toHaveLength(0);
  });

  it("a turn ending with an aborted message_end fragment delivers nothing — silence note fires", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "this fragment was cut off by abort", stopReason: "aborted" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(memberMessages()).toHaveLength(0);
    expect(silenceNoteCalls()).toHaveLength(1);
  });

  it("a debt turn with no text at all delivers nothing and fires the note", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(memberMessages()).toHaveLength(0);
    expect(silenceNoteCalls()).toHaveLength(1);
  });

  it("length truncation still runs one continuation; its text is not delivered and the note fires", async () => {
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
    expect(memberMessages()).toHaveLength(0);
    expect(silenceNoteCalls()).toHaveLength(1);
  });

  it("DM: a debt turn without chat delivers nothing — the silence note lands in the DM scope", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    bus.postMessage("dm:mem_developer", "user", "@developer scoped question", ["developer"]);
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "Scoped answer", stopReason: "stop" });
      handle.emit({ type: "agent_end" });
    });
    await manager.activateDmMember("mem_developer");
    const dmMessages = bus.getMessagesSince("dm:mem_developer", null);
    expect(dmMessages.some((message) => message.senderMemberId === "mem_developer")).toBe(false);
    expect(dmMessages.some((message) => message.sender === "system" && message.content.includes("finished without replying"))).toBe(true);
    // Nothing leaks into the room scope.
    expect(memberMessages()).toHaveLength(0);
  });
});
