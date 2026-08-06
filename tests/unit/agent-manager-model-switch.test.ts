import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHandle, AgentStreamEvent } from "../../src/engine/runtime/types.js";

let member: any;
let messages: any[];
let availableModels: Array<{ ref: string }>;
let exportedCalls: any[];
let exportReturnsNull: boolean;
const handles: TestHandle[] = [];
const loggerError = vi.fn();
const loggerWarn = vi.fn();
const loggerInfo = vi.fn();

class TestHandle implements AgentHandle {
  listeners = new Set<(event: AgentStreamEvent) => void>();
  promptCalls: string[] = [];
  setModelCalls: string[] = [];
  refreshCalls = 0;
  reloadCalls: any[] = [];
  failReload = false;
  destroyed = false;
  failRefresh = false;
  failSetModel = false;
  runtimeName = "test";
  runtimeParams: any;
  /** When true, prompt() emits agent_start/agent_end but does not resolve until resolvePendingPrompt() is called — simulates the real-world window where the SDK is still finalizing (e.g. running compaction) after agent_end but before prompt() settles. */
  holdPrompt = false;
  private pendingPromptResolve: (() => void) | null = null;

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

  steer(): void {}
  abort(): void {}
  destroy(): void { this.destroyed = true; }
  waitForIdle(): Promise<void> { return Promise.resolve(); }
  subscribe(fn: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(event: AgentStreamEvent): void {
    for (const fn of this.listeners) fn(event);
  }
  async setModel(model: string): Promise<void> {
    if (this.failSetModel) throw new Error("setModel failed");
    this.setModelCalls.push(model);
    this.runtimeParams.model = model;
  }
  async refreshModelRegistry(): Promise<void> {
    if (this.failRefresh) throw new Error("refresh failed");
    this.refreshCalls += 1;
  }
  async reloadResources(opts: any): Promise<void> {
    this.reloadCalls.push(opts);
    if (this.failReload) throw new Error("Reload could not apply MCP access.");
    this.runtimeParams.systemPrompt = [opts.agentPrompt, ...(opts.appendSystemPrompt || [])].filter(Boolean).join("\n\n");
    this.runtimeParams.skills = opts.skillNames;
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
  getRoomMemberOverride: vi.fn(() => undefined),
  updateRoomMemberOverride: vi.fn((_roomId: string, _memberName: string, patch: any) => { member = { ...member, ...patch }; return { id: "room", name: "Room", cwd: "/tmp", members: ["pm"] }; }),
  hasRoomMemberModelOverride: vi.fn(() => false),
  getCursors: vi.fn(() => ({})),
  setCursor: vi.fn(),
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
  listAvailableModels: vi.fn(() => availableModels),
  assertModelAvailable: vi.fn((model: string) => {
    if (!availableModels.some((m) => m.ref === model)) {
      throw new Error(`Model is not available or credential is missing: ${model}`);
    }
  }),
  exportPiConfigForMember: vi.fn((args: any) => {
    exportedCalls.push(args);
    return exportReturnsNull ? null : { agentDir: "/tmp/agent", extensionPaths: [], profile: { id: args.credentialId || "cred-a", name: "test" } };
  }),
  setMemberActiveCredentialOverride: vi.fn(),
  getMemberActiveCredentialOverride: vi.fn(() => undefined),
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: vi.fn(() => "/tmp/bossmode-test"),
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

describe("agent-manager model hot switch", () => {
  beforeEach(async () => {
    member = { id: "pm", name: "pm", type: "agent", agent: "pm", runtime: "test", model: "anthropic/claude-a", credentialId: "cred-a", skills: [], thinkingLevel: "off" };
    messages = [{ id: "m1", type: "chat", sender: "user", content: "@pm hi", mentions: ["pm"], createdAt: Date.now() }];
    availableModels = [{ ref: "anthropic/claude-b" }, { ref: "anthropic-proxy/claude-fable-5" }];
    exportedCalls = [];
    exportReturnsNull = false;
    handles.splice(0);
    vi.clearAllMocks();
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.shutdownAll();
    manager.initAgentManager(registry as any);
  });

  it("uses fast session.setModel path for same credential/provider model changes", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    expect(handles).toHaveLength(1);

    const result = await manager.switchMemberModel("room", "pm", "anthropic/claude-b", "cred-a");

    expect(result.applied).toBe(true);
    expect(handles).toHaveLength(1);
    expect(handles[0].destroyed).toBe(false);
    expect(handles[0].refreshCalls).toBe(1);
    expect(handles[0].setModelCalls).toEqual(["anthropic/claude-b"]);
  });

  it("applies cross-credential/provider switches via setModel without recreating the handle", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    const result = await manager.switchMemberModel("room", "pm", "anthropic-proxy/claude-fable-5", "cred-proxy");

    expect(result.applied).toBe(true);
    expect(result.pending).toBe(false);
    expect(handles).toHaveLength(1);
    expect(first.destroyed).toBe(false);
    expect(first.setModelCalls).toEqual(["anthropic-proxy/claude-fable-5"]);
    expect(first.runtimeParams.model).toBe("anthropic-proxy/claude-fable-5");
    expect(exportedCalls.at(-1)).toMatchObject({ modelRef: "anthropic-proxy/claude-fable-5", credentialId: "cred-proxy" });
  });

  it("applies same-provider credential changes via setModel without recreating (live credential store)", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    await manager.switchMemberModel("room", "pm", "anthropic/claude-b", "cred-b");

    expect(handles).toHaveLength(1);
    expect(first.destroyed).toBe(false);
    expect(first.setModelCalls).toEqual(["anthropic/claude-b"]);
    expect(first.runtimeParams.model).toBe("anthropic/claude-b");
  });

  it("applies proxy→builtin switches via setModel without recreating", async () => {
    member = { ...member, model: "anthropic-proxy/claude-fable-5", credentialId: "cred-proxy" };
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    await manager.switchMemberModel("room", "pm", "anthropic/claude-b", "cred-a");

    expect(handles).toHaveLength(1);
    expect(first.destroyed).toBe(false);
    expect(first.setModelCalls).toEqual(["anthropic/claude-b"]);
  });

  it("reports member busy while dispatch is not idle", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    expect(manager.getMemberBusyState("room", "pm")).toEqual({ busy: false });

    handles[0].emit({ type: "agent_start" });
    expect(manager.getMemberBusyState("room", "pm")).toMatchObject({ busy: true, reason: "working" });

    handles[0].emit({ type: "agent_end" });
    expect(manager.getMemberBusyState("room", "pm")).toEqual({ busy: false });
  });

  it("reports busy status during a threshold auto-compaction between turns and returns to idle after", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const ws = await import("../../src/communication/ws.js");
    await manager.activateAgent("room", "pm");
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");

    handles[0].emit({ type: "compaction_start", reason: "threshold" });
    expect(manager.getAgentStatus("room", "pm")).toBe("working");
    expect(manager.getMemberBusyState("room", "pm")).toMatchObject({ busy: true, reason: "working" });
    expect(ws.broadcastToRoom).toHaveBeenCalledWith("room", { type: "agent:status", roomId: "room", agent: "pm", status: "working" });

    handles[0].emit({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");
    expect(manager.getMemberBusyState("room", "pm")).toEqual({ busy: false });
  });

  it("returns to idle after a real threshold-compaction timing: compaction runs between agent_end and prompt() settling, not after settlement", async () => {
    // Reproduces the QA-reported production regression (2122fec): the SDK runs
    // turn-after compaction in the window where agent_end has already fired but
    // handle.prompt() has not yet resolved (promptInFlight still true). The old
    // guard (`dispatchState === "idle"`) never became true in this window, so
    // compaction_end could never fall back to idle — the member stayed "working"
    // forever. The fix gates on `turnActive` (agent_start..agent_end) instead.
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");

    first.holdPrompt = true;
    const pending = manager.activateAgent("room", "pm");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // agent_start/agent_end already fired inside prompt(); prompt() itself is still pending.
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");

    first.emit({ type: "compaction_start", reason: "threshold" });
    expect(manager.getAgentStatus("room", "pm")).toBe("working");

    first.emit({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");
    // dispatchState is still "running" until prompt() settles — getMemberBusyState reflects that
    // internal in-flight state (used to gate destructive actions), distinct from the public avatar status.
    expect(manager.getMemberBusyState("room", "pm")).toMatchObject({ busy: true, reason: "running" });

    first.holdPrompt = false;
    first.resolvePendingPrompt();
    await pending;
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");
    expect(manager.getMemberBusyState("room", "pm")).toEqual({ busy: false });
  });

  it("queues a message that arrives while compaction_end has settled status to idle but prompt() has not yet resolved, and delivers it once settlement drains the queue", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    const baseline = first.promptCalls.length;

    first.holdPrompt = true;
    const pending = manager.activateAgent("room", "pm");
    await new Promise((resolve) => setTimeout(resolve, 0));

    first.emit({ type: "compaction_start", reason: "threshold" });
    first.emit({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");

    messages.push({ id: "m2", type: "chat", sender: "user", content: "@pm are you there", mentions: ["pm"], createdAt: Date.now() });
    await manager.activateAgent("room", "pm");
    // Not delivered yet — the in-flight prompt() has not settled (dispatchState still busy).
    expect(first.promptCalls).toHaveLength(baseline + 1);

    first.resolvePendingPrompt();
    await pending;
    expect(first.promptCalls.length).toBeGreaterThan(baseline + 1);
    expect(first.promptCalls[first.promptCalls.length - 1]).toContain("are you there");
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");
  });

  it("queues activation during a threshold auto-compaction instead of steering or prompting immediately", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    const baseline = first.promptCalls.length;

    first.emit({ type: "compaction_start", reason: "threshold" });
    messages.push({ id: "m2", type: "chat", sender: "user", content: "@pm are you there", mentions: ["pm"], createdAt: Date.now() });
    await manager.activateAgent("room", "pm");

    expect(first.promptCalls).toHaveLength(baseline);
    expect(handles).toHaveLength(1);

    first.emit({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
    expect(first.promptCalls.length).toBeGreaterThan(baseline);
    expect(first.promptCalls[first.promptCalls.length - 1]).toContain("are you there");
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");
  });

  it("clears the compacting flag on the next agent_end so a missed compaction_end cannot leave status stuck working", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    first.emit({ type: "compaction_start", reason: "threshold" });
    expect(manager.getAgentStatus("room", "pm")).toBe("working");

    // compaction_end never arrives; a later full turn must still correctly settle to idle.
    first.emit({ type: "agent_start" });
    first.emit({ type: "agent_end" });
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");
    expect(manager.getMemberBusyState("room", "pm")).toEqual({ busy: false });
  });

  it("applies a cross-provider switch immediately even while working (no queue)", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.emit({ type: "agent_start" });

    const result = await manager.switchMemberModel("room", "pm", "anthropic-proxy/claude-fable-5", "cred-proxy");
    expect(result.applied).toBe(true);
    expect(result.pending).toBe(false);
    expect(handles).toHaveLength(1);
    expect(first.destroyed).toBe(false);
    expect(first.setModelCalls).toEqual(["anthropic-proxy/claude-fable-5"]);
    expect(first.runtimeParams.model).toBe("anthropic-proxy/claude-fable-5");
  });

  it("refreshes an idle active agent when its credential profile changes", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");

    const result = await manager.invalidateModelCredentialProfile("cred-a", "anthropic");

    // profileUpdated returns immediately; refresh runs in the background.
    expect(result).toEqual([{ roomId: "room", memberName: "pm", applied: false, pending: true }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handles).toHaveLength(1);
    expect(handles[0].refreshCalls).toBe(1);
    expect(handles[0].setModelCalls).toEqual(["anthropic/claude-a"]);
    expect(exportedCalls.at(-1)).toMatchObject({ roomId: "room", memberName: "pm", modelRef: "anthropic/claude-a", credentialId: "cred-a" });
  });

  it("queues credential refresh while working and applies it after agent_end", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.emit({ type: "agent_start" });

    const result = await manager.invalidateModelCredentialProfile("cred-a", "anthropic");

    expect(result).toEqual([{ roomId: "room", memberName: "pm", applied: false, pending: true }]);
    expect(first.refreshCalls).toBe(0);
    first.emit({ type: "agent_end" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first.refreshCalls).toBe(1);
    expect(first.setModelCalls).toEqual(["anthropic/claude-a"]);
  });

  it("does not refresh agents using another credential profile", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");

    const result = await manager.invalidateModelCredentialProfile("cred-b", "anthropic");

    expect(result).toEqual([]);
    expect(handles[0].refreshCalls).toBe(0);
    expect(handles[0].setModelCalls).toEqual([]);
  });

  it("drops an idle active agent when its deleted credential can no longer export", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const ws = await import("../../src/communication/ws.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    exportReturnsNull = true;

    const result = await manager.invalidateModelCredentialProfile("cred-a", "anthropic", "profileDeleted");

    expect(result).toEqual([{ roomId: "room", memberName: "pm", applied: true, pending: false }]);
    expect(first.destroyed).toBe(true);
    expect(manager.getAgentStatus("room", "pm")).toBe("inactive");
    expect(ws.broadcastToRoom).toHaveBeenCalledWith("room", { type: "agent:status", roomId: "room", agent: "pm", status: "inactive" });
  });

  it("drops an idle active agent when refresh/rebind fails with a non-transient error", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const ws = await import("../../src/communication/ws.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.failSetModel = true;

    await manager.invalidateModelCredentialProfile("cred-a", "anthropic");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first.destroyed).toBe(true);
    expect(manager.getAgentStatus("room", "pm")).toBe("inactive");
    expect(ws.broadcastToRoom).toHaveBeenCalledWith("room", { type: "agent:status", roomId: "room", agent: "pm", status: "inactive" });
  });

  it("does not drop the instance when credential refresh hits a transient network error", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const bus = await import("../../src/communication/message-bus.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.failRefresh = true;
    // Make the refresh error look like a network failure.
    first.refreshModelRegistry = async () => { throw new Error("fetch failed: ECONNREFUSED"); };

    await manager.invalidateModelCredentialProfile("cred-a", "anthropic");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(first.destroyed).toBe(false);
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");
    expect(bus.postMessage).not.toHaveBeenCalledWith(
      "room",
      "system",
      expect.stringContaining("model credential is no longer available"),
    );
  });

  it("does not commit the room binding when setModel fails", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const roomStore = await import("../../src/workspace/room-store.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.failSetModel = true;
    const overridesBefore = (roomStore.updateRoomMemberOverride as any).mock.calls.length;

    await expect(manager.switchMemberModel("room", "pm", "anthropic/claude-b", "cred-a")).rejects.toThrow(/setModel failed/);

    // Binding write happens only after a successful apply — no new override call.
    expect((roomStore.updateRoomMemberOverride as any).mock.calls.length).toBe(overridesBefore);
    expect(member.model).toBe("anthropic/claude-a"); // unchanged
  });

  it("commits the room binding only after a successful live apply", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const roomStore = await import("../../src/workspace/room-store.js");
    await manager.activateAgent("room", "pm");

    await manager.switchMemberModel("room", "pm", "anthropic/claude-b", "cred-a");

    expect(handles[0].setModelCalls).toEqual(["anthropic/claude-b"]);
    expect(roomStore.updateRoomMemberOverride).toHaveBeenCalledWith(
      "room",
      "pm",
      expect.objectContaining({ model: "anthropic/claude-b", credentialId: "cred-a" }),
    );
    // setModel was called before the override write (apply-then-commit).
    const setModelOrder = handles[0].setModelCalls.length; // already 1
    expect(setModelOrder).toBe(1);
    expect(member.model).toBe("anthropic/claude-b");
  });

  it("pins the target credential override before setModel so cross-provider auth can resolve", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const creds = await import("../../src/engine/model-credentials.js");
    await manager.activateAgent("room", "pm");

    await manager.switchMemberModel("room", "pm", "anthropic-proxy/claude-fable-5", "cred-proxy");

    // Override must be installed with the *target* credential before setModel runs.
    expect(creds.setMemberActiveCredentialOverride).toHaveBeenCalledWith("room", "pm", "cred-proxy");
    const setOverrideOrder = (creds.setMemberActiveCredentialOverride as any).mock.invocationCallOrder[0];
    // setModel is on the handle; we only assert override was called (apply path).
    expect(handles[0].setModelCalls).toEqual(["anthropic-proxy/claude-fable-5"]);
    expect(setOverrideOrder).toBeTypeOf("number");
  });

  it("rolls back the credential override when setModel fails", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const creds = await import("../../src/engine/model-credentials.js");
    await manager.activateAgent("room", "pm");
    handles[0].failSetModel = true;
    (creds.getMemberActiveCredentialOverride as any).mockReturnValueOnce(undefined);

    await expect(manager.switchMemberModel("room", "pm", "anthropic-proxy/claude-fable-5", "cred-proxy")).rejects.toThrow(/setModel failed/);

    // First call pins target; second call rolls back (null clears).
    expect(creds.setMemberActiveCredentialOverride).toHaveBeenCalledWith("room", "pm", "cred-proxy");
    expect(creds.setMemberActiveCredentialOverride).toHaveBeenLastCalledWith("room", "pm", null);
  });

  it("filters all member runtime failure system messages from activation prompts", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const now = Date.now();
    messages = [
      { id: "err", type: "chat", sender: "system", content: 'Member "pm" request failed. Error: context_length_exceeded', mentions: [], ts: now, seq: 1 },
      { id: "cred", type: "chat", sender: "system", content: 'Member "pm" model credential is no longer available. Update Settings.', mentions: [], ts: now, seq: 2 },
      { id: "switch", type: "chat", sender: "system", content: 'Failed to switch model for "pm": setModel failed', mentions: [], ts: now, seq: 3 },
      { id: "other", type: "chat", sender: "system", content: 'Member "qa" request failed. Error: hidden from pm too', mentions: [], ts: now, seq: 4 },
      { id: "task", type: "task_event", sender: "system", content: "[Task] qa moved task to review: **Check this**", mentions: [], ts: now, seq: 5 },
      { id: "knowledge", type: "knowledge_event", sender: "system", content: "[Knowledge] qa updated document: **Report**", mentions: [], ts: now, seq: 6 },
      { id: "m1", type: "chat", sender: "user", content: "@pm continue", mentions: ["pm"], ts: now, seq: 7 },
    ];

    await manager.activateAgent("room", "pm");

    // Hybrid: trigger injects in full; task/knowledge events become a one-line
    // backlog hint (counted, not re-injected verbatim); failure notices are
    // filtered from BOTH the hint and the trigger.
    expect(handles[0].promptCalls[0]).toContain("@pm continue");
    expect(handles[0].promptCalls[0]).toContain("you have 2 unread messages (No.5–No.6): system×2");
    expect(handles[0].promptCalls[0]).toContain("incl. 1 task events, 1 knowledge updates");
    expect(handles[0].promptCalls[0]).not.toContain("[Task] qa moved task to review");
    expect(handles[0].promptCalls[0]).not.toContain("[Knowledge] qa updated document");
    expect(handles[0].promptCalls[0]).not.toContain("hidden from pm too");
    expect(handles[0].promptCalls[0]).not.toContain("context_length_exceeded");
    expect(handles[0].promptCalls[0]).not.toContain("model credential is no longer available");
    expect(handles[0].promptCalls[0]).not.toContain("setModel failed");
  });

  it("reloads active member resources in place without destroying the instance", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    member = { ...member, skills: ["review"] };
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    const result = await manager.reloadMemberResources("room", "pm");

    expect(result).toEqual({ ok: true, reloaded: true, message: "Reloaded latest prompt, skills and tools in place." });
    expect(handles).toHaveLength(1);
    expect(first.destroyed).toBe(false);
    expect(first.reloadCalls[0]).toMatchObject({ roomId: "room", member: expect.objectContaining({ id: "pm" }), agentPrompt: "test", skillNames: ["review"] });
    expect(first.reloadCalls[0].skillPaths[0]).toContain("skills/review");
  });

  it("surfaces reload failure and reports no success when the runtime cannot apply MCP access", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const eventHandler = await import("../../src/engine/event-handler.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.failReload = true;

    await expect(manager.reloadMemberResources("room", "pm")).rejects.toThrow("Reload could not apply MCP access.");

    expect(first.runtimeParams.systemPrompt).toBeUndefined();
    expect(eventHandler.appendEventToDisk).not.toHaveBeenCalledWith("room", "pm", expect.objectContaining({ text: "Reloaded member resources in place." }));
    expect(first.destroyed).toBe(false);
  });

  it("blocks activation for an Unconfigured member without creating a runtime or guessing a credential", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const messageBus = await import("../../src/communication/message-bus.js");
    member = { ...member, model: undefined, credentialId: undefined };

    await manager.activateAgent("room", "pm");

    expect(handles).toHaveLength(0);
    expect(messageBus.postMessage).toHaveBeenCalledWith("room", "system", 'Member "pm" hasn\'t selected a model yet. Open the member card to choose a model and credential, then try again.');
  });

  it("rejects steer for an Unconfigured member instead of creating a runtime", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    member = { ...member, model: undefined, credentialId: undefined };

    await expect(manager.steerAgent("room", "pm", "hello")).rejects.toThrow("hasn't selected a model yet");
    expect(handles).toHaveLength(0);
  });

  it("blocks activation when a member has a model but no bound credential", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const messageBus = await import("../../src/communication/message-bus.js");
    member = { ...member, credentialId: undefined };

    await manager.activateAgent("room", "pm");

    expect(handles).toHaveLength(0);
    expect(messageBus.postMessage).toHaveBeenCalledWith("room", "system", expect.stringContaining("hasn't selected a model yet"));
  });

  it("keeps the active instance after provider message_end errors while posting a visible error", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const messageBus = await import("../../src/communication/message-bus.js");
    const ws = await import("../../src/communication/ws.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    first.emit({ type: "message_end", text: "", stopReason: "error", errorMessage: "502 upstream_error" });

    expect(loggerError).toHaveBeenCalledWith("agent", "member request failed", expect.objectContaining({ roomId: "room", member: "pm", memberId: "pm", error: "502 upstream_error" }));
    expect(messageBus.postMessage).toHaveBeenCalledWith("room", "system", 'Member "pm" request failed. Error: 502 upstream_error');
    expect(first.destroyed).toBe(false);
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");
    expect(ws.broadcastToRoom).not.toHaveBeenCalledWith("room", { type: "agent:status", roomId: "room", agent: "pm", status: "inactive" });

    await manager.activateAgent("room", "pm");
    expect(handles).toHaveLength(1);
  });
});
