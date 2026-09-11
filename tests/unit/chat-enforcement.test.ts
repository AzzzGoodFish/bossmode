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

import type { AgentStreamEvent } from "../../src/engine/runtime/types.js";

const state = vi.hoisted(() => ({
  promptImpl: vi.fn(async (_message: string) => {}),
}));

class TestHandle {
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
    createAgent: vi.fn(async () => handle as any),
    shutdownAll: vi.fn(async () => {}),
  };
  const registry = new RuntimeRegistry();
  registry.register(runtime as any);
  initAgentManager(registry);
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

describe("chat enforcement pending reply", () => {
  beforeEach(async () => {
    state.promptImpl = vi.fn(async () => {});
    vi.mocked(bus.postMessage).mockClear();
    await setup();
  });

  it("posts an honest system note (no hidden follow-up) when a debt turn ends with no chat and no text", async () => {
    await activateAgent("room1", "developer");

    // No hidden chat_warning follow-up prompt — only the original turn ran.
    expect(handle.prompt).toHaveBeenCalledTimes(1);
    // No text at all → the silence is made visible to the room as a system message.
    expect(bus.postMessage).toHaveBeenCalledWith("room1", "system", 'Member "developer" finished without replying.');
  });

  it("a debt turn's completed text stays invisible (marker or not) — only the silence note fires", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "Let me check...\n[room]\nFound it — the failure is in the token refresh.", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    // No chat call → the text is a work note; the room sees only the silence note.
    const delivered = vi.mocked(bus.postMessage).mock.calls.filter((c: any[]) => c[0] === "room1" && c[1] === "developer");
    expect(delivered).toHaveLength(0);
    expect(bus.postMessage).toHaveBeenCalledWith("room1", "system", 'Member "developer" finished without replying.');
    expect(handle.prompt).toHaveBeenCalledTimes(1);
  });

  it("a debt turn's bare final text is never delivered — the silence note fires", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "Done — the fix is in place.", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer");

    expect(handle.prompt).toHaveBeenCalledTimes(1);
    const delivered = vi.mocked(bus.postMessage).mock.calls.filter((c: any[]) => c[0] === "room1" && c[1] === "developer");
    expect(delivered).toHaveLength(0);
    // No chat call → the debt stays pending; the silence is made visible.
    expect(bus.postMessage).toHaveBeenCalledWith("room1", "system", 'Member "developer" finished without replying.');
  });

  it("an FYI turn (no debt) never fallback-posts bare text and never warns", async () => {
    state.promptImpl = vi.fn(async () => {
      handle.emit({ type: "message_end", text: "Let me check... done, see the fix.", stopReason: "stop" });
      handle.emit({ type: "agent_end", messages: [] });
    });

    await activateAgent("room1", "developer", { needResponse: [], senderName: "qa" });

    // No debt → the text stays invisible (work note), and no silence note fires.
    expect(handle.prompt).toHaveBeenCalledTimes(1);
    expect(bus.postMessage).not.toHaveBeenCalledWith("room1", "developer", expect.stringContaining("Let me check"), expect.anything());
    expect(bus.postMessage).not.toHaveBeenCalledWith("room1", "system", 'Member "developer" finished without replying.');
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
    // The continuation's completed text is not delivered — no chat call was made.
    const delivered = vi.mocked(bus.postMessage).mock.calls.filter((c: any[]) => c[0] === "room1" && c[1] === "developer");
    expect(delivered).toHaveLength(0);
    expect(bus.postMessage).toHaveBeenCalledWith("room1", "system", 'Member "developer" finished without replying.');
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
    const delivered = vi.mocked(bus.postMessage).mock.calls.filter((c: any[]) => c[0] === "room1" && c[1] === "developer");
    expect(delivered).toHaveLength(0);
    expect(bus.postMessage).toHaveBeenCalledWith("room1", "system", 'Member "developer" finished without replying.');
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
    expect(bus.postMessage).toHaveBeenCalledWith("room1", "system", expect.stringContaining("Automatic continuation stopped to avoid a loop"));
  });
});
