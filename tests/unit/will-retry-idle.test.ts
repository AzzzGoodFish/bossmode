
import { coreFixture } from "../helpers/core-fixture.js";
import { getDatabase } from "../../src/data/database.js";
import { MembersRepository } from "../../src/data/repositories/members.js";
import { ConversationsRepository } from "../../src/data/repositories/conversations.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as bus from "../../src/chat/message-bus.js";
import { loadEventsFromDisk } from "../../src/agent/events/event-handler.js";

type PromptOptions = { beforeDispatch?: (event: { attemptId: string; dispatchIndex: number; message: string }) => void };
function dispatch(message: string, options?: PromptOptions) {
  getDatabase().transaction(() => options?.beforeDispatch?.({ attemptId: `mock-${randomUUID()}`, dispatchIndex: 0, message }));
}
let fixture: ReturnType<typeof coreFixture>;
let compactionRefreshPending = false;
vi.mock("../../src/chat/message-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/chat/message-bus.js")>();
  return { ...actual, postMessage: vi.fn(actual.postMessage) };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStreamEvent } from "../../src/agent/runtime/types.js";

const state = vi.hoisted(() => ({
  promptImpl: vi.fn(async (_message: string) => {}),
  broadcastToAgentSubscribers: vi.fn(),
  broadcastToRoom: vi.fn(),
}));

class TestHandle {
  listeners = new Set<(event: AgentStreamEvent) => void>();
  prompt = vi.fn(async (message: string, options?: PromptOptions) => { dispatch(message, options); return state.promptImpl(message); });
  steer = vi.fn();
  abort = vi.fn();
  destroy = vi.fn();
  async destroyAndWait(): Promise<void> { this.abort(); await this.waitForIdle(); this.destroy(); }
  waitForIdle = vi.fn(async () => {});
  subscribe = vi.fn((fn: (event: AgentStreamEvent) => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  });
  emit(event: AgentStreamEvent) {
    if (event.type === "compaction_end") compactionRefreshPending = true;
    for (const fn of this.listeners) fn(event);
  }
}

let handle: TestHandle;

vi.mock("../../src/kernel/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/app/server/ws.js", () => ({
  broadcastToRoom: state.broadcastToRoom,
  broadcastToAgentSubscribers: state.broadcastToAgentSubscribers,
}));

import { RuntimeRegistry } from "../../src/agent/runtime/registry.js";
import { activateAgent, getAgentStatus, initAgentManager, shutdownAll } from "../../src/agent/orchestrator/agent-manager.js";
import { mapPiAgentEvent } from "../../src/agent/runtime/pi-events.js";
import { handleAgentEvent as processEvent } from "../../src/agent/events/event-handler.js";

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
  (await import("../../src/config/settings.js")).writeConfig({ auth: { username: "test", passwordHash: "fixture" }, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 }, runtime: { sessionResume: false } });
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
  await (await import("../../src/agent/orchestrator/agent-manager.js")).shutdownAll();
  // The real event consumer schedules post-compaction refreshes up to 1500ms.
  if (compactionRefreshPending) await new Promise((resolve) => setTimeout(resolve, 1600));
  fixture.close();
});

describe("mapPiAgentEvent willRetry passthrough", () => {
  it("maps agent_end.willRetry from raw pi event", () => {
    expect(mapPiAgentEvent({ type: "agent_end", willRetry: true })).toEqual({ type: "agent_end", willRetry: true });
    expect(mapPiAgentEvent({ type: "agent_end" })).toEqual({ type: "agent_end", willRetry: false });
  });
});

describe("processEvent willRetry does not idle", () => {
  it("returns undefined for agent_end willRetry (no public idle)", () => {
    const buf: any[] = [];
    const status = processEvent("room1", "developer", "k", { type: "agent_end", willRetry: true }, buf, "mem_developer");
    expect(status).toBeUndefined();
  });

  it("returns idle for final agent_end", () => {
    const buf: any[] = [];
    const status = processEvent("room1", "developer", "k", { type: "agent_end", willRetry: false }, buf, "mem_developer");
    expect(status).toBe("idle");
  });
});

describe("willRetry idle + deferred error notice + user_steer", () => {
  beforeEach(async () => {
    state.promptImpl = vi.fn(async () => {
      // hang until test emits events
    });
    vi.mocked(bus.postMessage).mockClear();
    state.broadcastToAgentSubscribers.mockReset();
    state.broadcastToRoom.mockReset();
    await setup();
  });

  it("keeps working across willRetry agent_end; one system notice on final failure", async () => {
    const promptDone = new Promise<void>((resolve) => {
      state.promptImpl = vi.fn(async () => {
        handle.emit({ type: "agent_start" });
        handle.emit({ type: "message_end", text: "", stopReason: "error", errorMessage: "Request timed out" });
        handle.emit({ type: "agent_end", willRetry: true });
        expect(getAgentStatus("room1", "mem_developer")).toBe("working");
        expect(bus.postMessage).not.toHaveBeenCalledWith(
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

    expect(getAgentStatus("room1", "mem_developer")).toBe("idle");
    const systemFails = vi.mocked(bus.postMessage).mock.calls.filter(
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
    expect(getAgentStatus("room1", "mem_developer")).toBe("working");

    bus.postMessage("room1", "user", "@developer hi again", ["developer"]);
    // Second @ while working → interrupt path: abort (never steer), the
    // message is queued at the front banner-wrapped. fish 2026-09-05: NO
    // user_steer event here — the drained queue emits exactly one user_prompt
    // (banner + message); the old pre-emit made one message two cards.
    await activateAgent("room1", "developer");
    expect(handle.steer).not.toHaveBeenCalled();
    expect(handle.abort).toHaveBeenCalled();
    const steers = loadEventsFromDisk("room1", "mem_developer")
      .filter((e: any) => e?.type === "user_steer");
    expect(steers).toHaveLength(0);

    release();
    await first;
    await new Promise((r) => setTimeout(r, 40));

    // The drained interrupt produced exactly one user_prompt (banner +
    // message), and the model received the interrupted message exactly once.
    const prompts = loadEventsFromDisk("room1", "mem_developer")
      .filter((e: any) => e?.type === "user_prompt");
    const interruptCards = prompts.filter((e: any) => typeof e.text === "string" && e.text.includes("interrupted by this message"));
    expect(interruptCards).toHaveLength(1);
    expect(interruptCards[0].text).toContain("@developer hi");
    const modelCalls = handle.prompt.mock.calls.filter((c: any[]) => String(c[0]).includes("interrupted by this message"));
    expect(modelCalls).toHaveLength(1);
    expect(String(modelCalls[0][0])).toContain("@developer hi");
  });
});
