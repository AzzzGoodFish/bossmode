/**
 * Manual compaction as ONE conversation action (steer-removal §2/§3):
 * - busy before the first await → ordinary messages queue, never cancel
 * - working turn settles first (shell waits + abort + waitForIdle)
 * - Stop in the gap (old prompt finished, compact not started) cancels the request
 * - Stop after start aborts the operation; lifecycle resets; queue resumes
 * - room / DM / topic instances all key by their real scopeId
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHandle, AgentStreamEvent } from "../../src/engine/runtime/types.js";

let member: any;
let messages: any[];
const handles: TestHandle[] = [];
const loggerError = vi.fn();
const loggerWarn = vi.fn();
const loggerInfo = vi.fn();

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

  async prompt(message = ""): Promise<void> {
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
  waitForIdle(): Promise<void> {
    if (this.idleResolver) return new Promise<void>((resolve) => { this.idleResolver = resolve; });
    return Promise.resolve();
  }
  subscribe(fn: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(event: AgentStreamEvent): void {
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

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { error: loggerError, warn: loggerWarn, info: loggerInfo },
}));

vi.mock("../../src/workforce/member-store.js", () => ({
  getMemberByName: vi.fn(() => member),
  saveMember: vi.fn((next: any) => { member = next; return next; }),
}));

vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: vi.fn((name: string) => ({ name, model: "anthropic/claude-a", description: name, systemPrompt: "test", skills: [], tags: [] })),
}));

vi.mock("../../src/workspace/room-store.js", () => ({
  getRoom: vi.fn(() => ({ id: "room", name: "Room", cwd: "/tmp", members: ["pm"], ruleDocs: [] })),
  getRoomByScope: vi.fn(() => ({ id: "room", name: "Room", cwd: "/tmp", members: ["pm"], ruleDocs: [] })),
  listRooms: vi.fn(() => [{ id: "room", name: "Room", cwd: "/tmp", members: ["pm"] }]),
  roomDir: vi.fn(() => "/tmp/bm-room"),
  getRoomMemberOverride: vi.fn(() => undefined),
  updateRoomMemberOverride: vi.fn(),
  hasRoomMemberModelOverride: vi.fn(() => false),
  getCursors: vi.fn(() => ({})),
  setCursor: vi.fn(),
}));

vi.mock("../../src/workspace/member-registry.js", () => ({
  getMember: vi.fn(() => ({ id: "pm", name: "pm", agentTemplate: "pm", global: { model: "anthropic/claude-a", credentialId: "cred-a" } })),
  updateMember: vi.fn(),
  getEffectiveConfig: vi.fn(() => ({ model: "anthropic/claude-a", credentialId: "cred-a", thinkingLevel: "off", skills: [], mcpServers: [] })),
}));

vi.mock("../../src/workspace/topic-store.js", () => ({
  getTopic: vi.fn(() => null),
  saveTopic: vi.fn(),
  buildTopicGuideText: vi.fn(() => ""),
  resolveOwningRoomId: vi.fn(() => "room"),
}));

vi.mock("../../src/engine/topic-session-fork.js", () => ({
  forkRoomSessionPrefix: vi.fn(() => ({ mode: "fresh" })),
  getTopicSession: vi.fn(() => null),
  saveTopicSession: vi.fn(),
}));

vi.mock("../../src/workspace/session-store.js", () => ({
  getSessions: vi.fn(() => ({ pm: { runtime: "test", sessionId: "s1", sessionFile: "/tmp/session.jsonl" } })),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
}));

vi.mock("../../src/knowledge/store.js", () => ({
  listEntries: vi.fn(() => []),
  getDocumentTree: vi.fn(() => ""),
  getEntry: vi.fn(() => null),
}));

vi.mock("../../src/communication/message-bus.js", () => ({
  postMessage: vi.fn(),
  getMessagesSince: vi.fn(() => messages),
  getLatestMessageId: vi.fn(() => "m1"),
}));

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToRoom: vi.fn(),
  broadcastToAgentSubscribers: vi.fn(),
}));

vi.mock("../../src/engine/event-handler.js", () => ({
  handleAgentEvent: vi.fn((_roomId: string, _memberName: string, _key: string, event: AgentStreamEvent) => {
    if (event.type === "agent_start") return "working";
    if (event.type === "agent_end") return "idle";
    return undefined;
  }),
  loadEventsFromDisk: vi.fn(() => []),
  appendEventToDisk: vi.fn(),
}));

vi.mock("../../src/engine/model-credentials.js", () => ({
  normalizeModelRef: (model: string) => model,
  listAvailableModels: vi.fn(() => [{ ref: "anthropic/claude-a" }]),
  assertModelAvailable: vi.fn(),
  exportPiConfigForMember: vi.fn(() => ({ agentDir: "/tmp/agent", extensionPaths: [], profile: { id: "cred-a", name: "test" } })),
  getModelCredentialProfile: vi.fn(() => ({ id: "cred-a", name: "test", enabled: true, providerSlug: "anthropic" })),
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: vi.fn(() => "/tmp/bossmode-test"),
  ensureBossmodeDir: vi.fn(),
  readConfig: vi.fn(() => ({ runtime: { sessionResume: true } })),
}));

vi.mock("../../src/workforce/skill-store.js", () => ({
  resolveGlobalSkillPaths: (skillNames: string[]) => skillNames.map((s: string) => "/tmp/skills/" + s),
}));

const runtime = {
  name: "test",
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

describe("manual compaction conversation action", () => {
  beforeEach(async () => {
    member = { id: "pm", name: "pm", type: "agent", agent: "pm", runtime: "test", model: "anthropic/claude-a", credentialId: "cred-a", skills: [], thinkingLevel: "off" };
    messages = [{ id: "m1", type: "chat", sender: "user", content: "@pm hi", mentions: ["pm"], createdAt: Date.now() }];
    handles.splice(0);
    vi.clearAllMocks();
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.shutdownAll();
    manager.initAgentManager(registry as any);
  });

  it("compacts an idle instance via its real scopeId and settles the lifecycle", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    const result = await manager.compactMember("room:room", "pm");

    expect(result).toEqual({ ok: true, action: "compacted" });
    expect(first.compactCalls).toBe(1);
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");
  });

  it("no live instance → builds the session for a configured member; unresolvable member fails honestly", async () => {
    const manager = await import("../../src/engine/agent-manager.js");

    // The room /compact command can precede activation — the session is built
    // (never prompted), then compacted.
    const result = await manager.compactMember("room:room2", "pm");
    expect(result).toEqual({ ok: true, action: "compacted" });
    expect(handles).toHaveLength(1);
    expect(handles[0].promptCalls).toEqual([]); // build only, no prompt

    // No resolvable member → honest error (the name-based member store is the
    // only resolver in this harness).
    member = null;
    await expect(manager.compactMember("room:room", "ghost")).rejects.toThrow(/No active session/);
  });

  it("busy is marked BEFORE the first await: a message during a held compact queues and never cancels", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.holdCompact = true;

    const inFlight = manager.compactMember("room:room", "pm");
    await new Promise((r) => setTimeout(r, 20)); // compaction_start has fired
    expect(first.compactCalls).toBe(1);
    expect(manager.getAgentStatus("room", "pm")).toBe("working");

    // An ordinary message while compacting: queued by the real activation
    // path, does not cancel the operation, does not prompt mid-compaction.
    messages.push({ id: "m2", type: "chat", sender: "user", content: "@pm held message during compact", mentions: ["pm"], createdAt: Date.now() });
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
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.holdPrompt = true;

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

    const result = await manager.compactMember("room:room", "pm");
    await pending;

    expect(result).toEqual({ ok: true, action: "compacted" });
    expect(order).toEqual(["abort", "waitForIdle", "compact"]); // old turn settled before compact
  });

  it("Stop in the gap (old prompt settled, compact not started) cancels the request — no compact after Stop", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.holdPrompt = true;

    const pending = manager.activateAgent("room", "pm");
    await new Promise((r) => setTimeout(r, 20));

    // compactMember holds between abort and compact start on waitForIdle.
    let releaseIdle!: () => void;
    first.waitForIdle = () => new Promise<void>((resolve) => { releaseIdle = resolve; });

    const inFlight = manager.compactMember("room:room", "pm");
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

  it("DM and topic instances are addressed by their real scopeIds", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const roomHandle = handles[0];

    const dmBuilt = await manager.buildMemberAgentSession("pm", "dm:mem-dm");
    const topicBuilt = await manager.buildMemberAgentSession("pm", "topic:mem-topic");
    expect(dmBuilt?.scopeId).toBe("dm:mem-dm");
    expect(topicBuilt?.scopeId).toBe("topic:mem-topic");

    const dmResult = await manager.compactMember("dm:mem-dm", "pm");
    const topicResult = await manager.compactMember("topic:mem-topic", "pm");
    expect(dmResult).toEqual({ ok: true, action: "compacted" });
    expect(topicResult).toEqual({ ok: true, action: "compacted" });
    expect(roomHandle.compactCalls).toBe(0); // scope-exact, no room-path spillover
  });
});
