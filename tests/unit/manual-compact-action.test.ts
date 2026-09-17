import { loadMemberPromptSource } from "../../src/app/member-actions.js";

import { coreFixture } from "../helpers/core-fixture.js";
import { getDatabase } from "../../src/data/database.js";
import { insertMemberIdentity } from "../../src/member/identity.js";
import { ensureDmScope, storeRoom } from "../../src/chat/conversations.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as bus from "../../src/chat/message-bus.js";

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

/**
 * Manual compaction as ONE conversation action (steer-removal §2/§3):
 * - busy before the first await → ordinary messages queue, never cancel
 * - working turn settles first (shell waits + abort + waitForIdle)
 * - Stop in the gap (old prompt finished, compact not started) cancels the request
 * - Stop after start aborts the operation; lifecycle resets; queue resumes
 * - room / DM instances all key by their real scopeId
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHandle, AgentStreamEvent } from "../../src/agent/types.js";

const handles: TestHandle[] = [];
const { loggerError, loggerWarn, loggerInfo } = vi.hoisted(() => ({ loggerError: vi.fn(), loggerWarn: vi.fn(), loggerInfo: vi.fn() }));

class TestHandle implements AgentHandle {
  listeners = new Set<(event: AgentStreamEvent) => void>();
  promptCalls: string[] = [];
  compactCalls = 0;
  abortCalls = 0;
  destroyed = false;
  runtimeName = "test";
  runtimeParams: any;
  /** Hold compact() behind a latch to keep the operation in flight. */
  holdCompact = false;
  private pendingCompactResolve: (() => void) | null = null;
  /** Hold prompt() to simulate a working turn. */
  holdPrompt = false;
  private pendingPromptResolve: (() => void) | null = null;
  /** waitForIdle resolver — compactMember awaits it for the old turn. */
  idleResolver: (() => void) | null = null;

  constructor(model: string) {
    this.runtimeParams = { model };
  }

  async prompt(message = "", options?: PromptOptions): Promise<void> {
    dispatch(message, options);
    this.promptCalls.push(message);
    this.emit({ type: "agent_start" });
    this.emit({ type: "agent_end" });
    if (this.holdPrompt) {
      await new Promise<void>((resolve) => { this.pendingPromptResolve = resolve; });
    }
  }

  resolvePendingPrompt(): void {
    this.pendingPromptResolve?.();
    this.pendingPromptResolve = null;
  }

  steer(): void { throw new Error("steer must never be called after steer-removal"); }
  abort(): void { this.abortCalls += 1; }
  destroy(): void { this.destroyed = true; }
  async destroyAndWait(): Promise<void> { this.abort(); await this.waitForIdle(); this.destroy(); }
  waitForIdle(): Promise<void> {
    if (this.idleResolver) return new Promise<void>((resolve) => { this.idleResolver = resolve; });
    return Promise.resolve();
  }
  subscribe(fn: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(event: AgentStreamEvent): void {
    if (event.type === "compaction_end") compactionRefreshPending = true;
    for (const fn of this.listeners) fn(event);
  }
  async compact(): Promise<{ aborted: boolean }> {
    this.compactCalls += 1;
    this.emit({ type: "agent_start" });
    this.emit({ type: "compaction_start", reason: "manual" });
    if (this.holdCompact) {
      await new Promise<void>((resolve) => { this.pendingCompactResolve = resolve; });
    }
    this.emit({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false });
    this.emit({ type: "agent_end" });
    return { aborted: false };
  }
  resolvePendingCompact(): void {
    this.pendingCompactResolve?.();
    this.pendingCompactResolve = null;
  }
}

vi.mock("../../src/kernel/logger.js", () => ({
  logger: { error: loggerError, warn: loggerWarn, info: loggerInfo },
}));

vi.mock("../../src/app/server/ws.js", () => ({
  broadcastToRoom: vi.fn(),
  broadcastToAgentSubscribers: vi.fn(),
}));

vi.mock("../../src/config/models.js", () => ({
  normalizeModelRef: (model: string) => model,
  listAvailableModels: vi.fn(() => [{ ref: "anthropic/claude-a" }]),
  assertModelAvailable: vi.fn(),
  getModelCredentialProfile: vi.fn(() => ({ id: "cred-a", name: "pi-cli", enabled: true, providerSlug: "anthropic" })),
}));

vi.mock("../../src/config/pi-adapt/credentials.js", () => ({



  exportPiConfigForMember: vi.fn(() => ({ agentDir: "/tmp/agent", extensionPaths: [], profile: { id: "cred-a", name: "test" } })),
}));

const runtime = {
  name: "pi-cli",
  async createAgent(opts: any) {
    const handle = new TestHandle(opts.member.model);
    handles.push(handle);
    return handle;
  },
  async shutdownAll() {},
};

const registry = {
  get: vi.fn(() => runtime),
  getAll: vi.fn(() => [runtime]),
};

/** settleMemberShellWaits comes from the real shell-manager — no shells here,
 * so it is a no-op through the real module (no live PTYs in this suite). */

beforeEach(async () => {
  compactionRefreshPending = false;
  fixture = coreFixture();
  (await import("../../src/config/settings.js")).writeConfig({ auth: { username: "test", passwordHash: "fixture" }, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 }, runtime: { sessionResume: false } });
  const members = fixture.db;
  const conversations = fixture.db;
  for (const name of ["pm", "qa"]) {
    const id = `mem_${name}`;
    insertMemberIdentity({ id, name, agentTemplate: name, global: { model: "anthropic/claude-a", credentialId: "cred-a" },
      unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}, createdAt: 1, updatedAt: 1 }, members);
    ensureDmScope(id, conversations);
    const memberPath = join(fixture.root, "members", id);
    mkdirSync(memberPath, { recursive: true });
    writeFileSync(join(memberPath, "persona.md"), `You are ${name}.`);
  }
  for (const id of ["room", "room2", "room3"]) {
    storeRoom({ id, name: id, cwd: fixture.root, members: ["pm", "qa"], globalMemberIds: ["mem_pm", "mem_qa"], createdAt: 1 }, conversations);
  }
  bus.postMessage("room", "user", "@pm hi", ["pm"]);
  vi.mocked(bus.postMessage).mockClear();
});
afterEach(async () => {
  for (const handle of handles) { handle.holdPrompt = false; handle.resolvePendingPrompt(); handle.resolvePendingCompact(); }
  await (await import("../../src/agent/orchestrator/agent-manager.js")).shutdownAll();
  // The real event consumer schedules post-compaction refreshes up to 1500ms.
  if (compactionRefreshPending) await new Promise((resolve) => setTimeout(resolve, 1600));
  fixture.close();
});

describe("manual compaction conversation action", () => {
  beforeEach(async () => {
    handles.splice(0);
    vi.clearAllMocks();
    const manager = await import("../../src/agent/orchestrator/agent-manager.js");
    await manager.shutdownAll();
    manager.initAgentManager(registry as any, loadMemberPromptSource);
  });

  it("compacts an idle instance via its real scopeId and settles the lifecycle", async () => {
    const manager = await import("../../src/agent/orchestrator/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    const result = await manager.compactMember("room:room", "mem_pm");

    expect(result).toEqual({ ok: true, action: "compacted" });
    expect(first.compactCalls).toBe(1);
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");
  });

  it("no live instance → builds the session for a configured member; unresolvable member fails honestly", async () => {
    const manager = await import("../../src/agent/orchestrator/agent-manager.js");

    // The room /compact command can precede activation — the session is built
    // (never prompted), then compacted.
    const result = await manager.compactMember("room:room2", "mem_pm");
    expect(result).toEqual({ ok: true, action: "compacted" });
    expect(handles).toHaveLength(1);
    expect(handles[0].promptCalls).toEqual([]); // build only, no prompt

    // No resolvable SQL member → honest error, not a fabricated session.
    await expect(manager.compactMember("room:room", "ghost")).rejects.toThrow(/No active session/);
  });

  it("busy is marked BEFORE the first await: a message during a held compact queues and never cancels", async () => {
    const manager = await import("../../src/agent/orchestrator/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.holdCompact = true;

    const inFlight = manager.compactMember("room:room", "mem_pm");
    await new Promise((r) => setTimeout(r, 20)); // compaction_start has fired
    expect(first.compactCalls).toBe(1);
    expect(manager.getAgentStatus("room", "pm")).toBe("working");

    // An ordinary message while compacting: queued by the real activation
    // path, does not cancel the operation, does not prompt mid-compaction.
    bus.postMessage("room", "user", "@pm held message during compact", ["pm"]);
    await manager.activateAgent("room", "pm");
    const firstPromptBaseline = first.promptCalls.length;

    first.resolvePendingCompact();
    await inFlight;
    await new Promise((r) => setTimeout(r, 20));

    // Queued input resumed as the next prompt after compaction settled.
    expect(first.promptCalls.length).toBeGreaterThan(firstPromptBaseline);
    expect(first.promptCalls.some((c) => c.includes("held message during compact"))).toBe(true);
  });

  it("working turn settles first: abort + waitForIdle happen BEFORE compact starts", async () => {
    const manager = await import("../../src/agent/orchestrator/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.holdPrompt = true;

    bus.postMessage("room", "user", "@pm next turn", ["pm"]);
    const pending = manager.activateAgent("room", "pm");
    await new Promise((r) => setTimeout(r, 20));
    expect(manager.getMemberBusyState("room", "pm")).toMatchObject({ busy: true });

    const order: string[] = [];
    const origAbort = first.abort.bind(first);
    first.abort = () => { order.push("abort"); origAbort(); };
    const origWaitForIdle = first.waitForIdle.bind(first);
    first.waitForIdle = async () => { order.push("waitForIdle"); await origWaitForIdle(); };
    const origCompact = first.compact.bind(first);
    (first as any).compact = async () => {
      order.push("compact");
      first.holdPrompt = false;
      first.resolvePendingPrompt();
      await origCompact();
    };

    const result = await manager.compactMember("room:room", "mem_pm");
    await pending;

    expect(result).toEqual({ ok: true, action: "compacted" });
    expect(order).toEqual(["abort", "waitForIdle", "compact"]); // old turn settled before compact
  });

  it("Stop in the gap (old prompt settled, compact not started) cancels the request — no compact after Stop", async () => {
    const manager = await import("../../src/agent/orchestrator/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.holdPrompt = true;

    bus.postMessage("room", "user", "@pm next turn", ["pm"]);
    const pending = manager.activateAgent("room", "pm");
    await new Promise((r) => setTimeout(r, 20));

    // compactMember holds between abort and compact start on waitForIdle.
    let releaseIdle!: () => void;
    first.waitForIdle = () => new Promise<void>((resolve) => { releaseIdle = resolve; });

    const inFlight = manager.compactMember("room:room", "mem_pm");
    await new Promise((r) => setTimeout(r, 20));

    // Stop lands in the gap: abortAgent marks dispatchState "aborting".
    manager.abortAgent("room", "pm");
    first.holdPrompt = false;
    first.resolvePendingPrompt();
    releaseIdle();
    const result = await inFlight;
    await pending;

    expect(result).toEqual({ ok: false, action: "stopped" });
    expect(first.compactCalls).toBe(0); // Stop terminated the request before start
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");
  });

  it("the member's single runtime serves the DM compaction too (① B1)", async () => {
    const manager = await import("../../src/agent/orchestrator/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const handle = handles[0];

    // The DM build reuses the member's single live runtime (built for the room).
    const dmBuilt = await manager.buildMemberAgentSession("mem_pm", "dm:mem_pm");
    expect(dmBuilt?.scopeId).toBe("room:room");
    expect(handles).toHaveLength(1);

    const dmResult = await manager.compactMember("dm:mem_pm", "mem_pm");
    expect(dmResult).toEqual({ ok: true, action: "compacted" });
    expect(handle.compactCalls).toBe(1); // the live instance is the one compacted
  });
});
