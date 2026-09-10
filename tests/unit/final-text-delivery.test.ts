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

function deliveredMessages(): Array<{ text: string; extra?: Record<string, unknown> }> {
  return bus.getMessagesSince("room1", null)
    .filter((message) => message.senderMemberId === "mem_developer")
    .map((message) => ({ text: message.content, extra: { autoDelivered: message.autoDelivered } }));
}

function silenceNoteCalls() {
  return bus.getMessagesSince("room1", null).filter((message) => message.sender === "system" && message.content.includes("finished without replying"));
}

beforeEach(async () => {
  compactionRefreshPending = false;
  fixture = coreFixture();
  (await import("../../src/shared/config.js")).writeConfig({ auth: { username: "test", passwordHash: "fixture" }, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 }, runtime: { sessionResume: false, topicSeedMode: "fresh" } });
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

describe("final-text fallback (chat need_response debt turn)", () => {
  beforeEach(async () => {
    state.promptImpl = vi.fn(async () => {});
    vi.mocked(bus.postMessage).mockClear();
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
      // Exercise the runtime callback: real publication, no successful-tool-event shortcut.
      await handle.onChat("Sent via chat");
      handle.emit({ type: "message_end", text: "done — sent via chat", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(deliveredMessages()).toEqual([{ text: "Sent via chat", extra: { autoDelivered: undefined } }]);
    expect(silenceNoteCalls()).toHaveLength(0);
  });

  it("a failed chat call does NOT clear the debt: the fallback still posts the final text", async () => {
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

    await activateAgent("room1", "developer", { needResponse: [], senderName: "qa" });

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

    await activateAgent("room1", "developer", { needResponse: ["developer"], senderName: "user" });

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

    await activateAgent("room1", "developer", { needResponse: ["developer"], senderName: "qa" });

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

    const calls = vi.mocked(bus.postMessage).mock.calls.filter((c: any[]) => c[0] === "room1" && c[1] === "developer");
    expect(calls).toHaveLength(1);
    expect(calls[0][2]).toBe("@qa please verify the fallback");
    // mentions list carries the target for the router listener.
    expect(calls[0][3]).toEqual(["qa"]);
    // The mention inside a fallback delivery does NOT carry needResponse (FYI for the target).
    expect(calls[0][4]?.needResponse).toBeUndefined();
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

  it("delivers for the captured member ID after a rename, never for a reused display name", async () => {
    state.promptImpl = vi.fn(async () => {
      (await import("../../src/workspace/member-registry.js")).updateMemberIdentity("mem_developer", { name: "renamed" });
      new MembersRepository(fixture.db).insert({ id: "mem_replacement", name: "developer", agentTemplate: "developer", global: {},
        unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}, createdAt: 2, updatedAt: 2 });
      handle.emit({ type: "message_end", text: "Reply from original owner", stopReason: "stop" });
      handle.emit({ type: "agent_end" });
    });
    await activateAgent("room1", "mem_developer");
    const replies = bus.getMessagesSince("room1", null).filter((message) => message.autoDelivered);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ sender: "renamed", senderMemberId: "mem_developer", content: "Reply from original owner" });
    expect(bus.getMessagesSince("room1", null).some((message) => message.senderMemberId === "mem_replacement")).toBe(false);
  });


  it.each(["dm", "topic"])("commits final-text fallback in the owning %s scope without leaking into the room", async (kind) => {
    const manager = await import("../../src/engine/agent-manager.js");
    const scope = kind === "dm" ? "dm:mem_developer" : "topic:fixture-topic";
    if (kind === "topic") {
      new ConversationsRepository(fixture.db).upsertTopic({ id: "fixture-topic", roomId: "room1", title: "Scoped reply",
        anchorMessageId: bus.getLatestMessageId("room1")!, createdBy: "user", createdAt: 1, status: "active", seedMode: "fresh", participants: ["mem_developer"] });
    }
    bus.postMessage(scope, "user", "@developer scoped question", ["developer"]);
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "Scoped answer", stopReason: "stop" });
      handle.emit({ type: "agent_end" });
    });
    if (kind === "dm") await manager.activateDmMember("mem_developer");
    else await manager.activateTopicMember("room1", "fixture-topic", "mem_developer");
    const replies = bus.getMessagesSince(scope, null).filter((message) => message.senderMemberId === "mem_developer");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ content: "Scoped answer", autoDelivered: true });
    expect(deliveredMessages()).toHaveLength(0);
  });

});
