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

  compactCalls = 0;
  async compact(): Promise<{ aborted: boolean }> {
    this.compactCalls += 1;
    this.emit({ type: "agent_start" });
    this.emit({ type: "compaction_start", reason: "manual" });
    this.emit({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false });
    this.emit({ type: "agent_end" });
    return { aborted: false };
  }
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
    if (this.failSetModelOnce) {
      this.failSetModelOnce = false;
      this.setModelCalls.push(model); // SDK assigned state.model before failing
      this.runtimeParams.model = model;
      throw new Error("setModel failed");
    }
    this.setModelCalls.push(model);
    this.runtimeParams.model = model;
  }
  /** Fail setModel once (the call still "changed SDK state" per §10), then succeed. */
  failSetModelOnce = false;
  thinkingCalls: string[] = [];
  async setThinkingLevel(level: string): Promise<void> {
    this.thinkingCalls.push(level);
    this.runtimeParams.thinkingLevel = level;
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
  getModelCredentialProfile: vi.fn((id: string) => ({
    id,
    name: `profile ${id}`,
    enabled: true,
    // Provider-per-credential so the explicit providerSlug match has real
    // cases on both sides (same-provider key switch AND cross-provider).
    providerSlug: id === "cred-proxy" ? "anthropic-proxy" : "anthropic",
  })),
}));

// Member registry (single-path commit target): switchMemberModel commits the
// global binding here, once, after every live instance accepted.
let registryRecord: any;
vi.mock("../../src/workspace/member-registry.js", () => ({
  getMember: vi.fn(() => registryRecord),
  updateMember: vi.fn((id: string, patch: any) => {
    registryRecord = { ...registryRecord, id, global: { ...(registryRecord?.global || {}), ...patch.global } };
    return registryRecord;
  }),
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

describe("agent-manager model hot switch", () => {
  beforeEach(async () => {
    member = { id: "pm", name: "pm", type: "agent", agent: "pm", runtime: "test", model: "anthropic/claude-a", credentialId: "cred-a", skills: [], thinkingLevel: "off" };
    registryRecord = { id: "pm", name: "pm", agentTemplate: "pm", global: { model: "anthropic/claude-a", credentialId: "cred-a" } };
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

    const result = await manager.switchMemberModel("pm", { model: "anthropic/claude-b", credentialId: "cred-a" });

    expect(result.model).toBe("anthropic/claude-b");
    expect(result.instances).toEqual([{ scopeId: "room:room", applied: true }]);
    expect(handles).toHaveLength(1);
    expect(handles[0].destroyed).toBe(false);
    expect(handles[0].setModelCalls).toEqual(["anthropic/claude-b"]);
    expect(registryRecord.global).toEqual({ model: "anthropic/claude-b", credentialId: "cred-a" });
  });

  it("applies cross-credential/provider switches via setModel without recreating the handle", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    const result = await manager.switchMemberModel("pm", { model: "anthropic-proxy/claude-fable-5", credentialId: "cred-proxy" });

    expect(result.model).toBe("anthropic-proxy/claude-fable-5");
    expect(result.instances).toEqual([{ scopeId: "room:room", applied: true }]);
    expect(handles).toHaveLength(1);
    expect(first.destroyed).toBe(false);
    expect(first.setModelCalls).toEqual(["anthropic-proxy/claude-fable-5"]);
    expect(first.runtimeParams.model).toBe("anthropic-proxy/claude-fable-5");
    expect(registryRecord.global).toEqual({ model: "anthropic-proxy/claude-fable-5", credentialId: "cred-proxy" });
  });

  it("applies same-provider credential changes via setModel without recreating (live credential store)", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    await manager.switchMemberModel("pm", { model: "anthropic/claude-b", credentialId: "cred-b" });

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

    await manager.switchMemberModel("pm", { model: "anthropic/claude-b", credentialId: "cred-a" });

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
    // Queue drained into a live prompt → the pipeline continues publicly as working
    // (no idle flash when work continues — fish 2026-08-09 idle rule).
    expect(manager.getAgentStatus("room", "pm")).toBe("working");
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

    const result = await manager.switchMemberModel("pm", { model: "anthropic-proxy/claude-fable-5", credentialId: "cred-proxy" });
    expect(result.instances).toEqual([{ scopeId: "room:room", applied: true }]);
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

  it("does not commit the global config when setModel fails — instance is restored", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const registry = await import("../../src/workspace/member-registry.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    // §10 shape: the SDK assigned state.model and THEN setModel threw — the
    // rollback must put the original binding back on this same handle.
    first.failSetModelOnce = true;

    await expect(manager.switchMemberModel("pm", { model: "anthropic/claude-b", credentialId: "cred-a" }))
      .rejects.toThrow(/restored to its previous model/);

    // Commit happens only after a successful apply — the registry was never written.
    expect(registry.updateMember).not.toHaveBeenCalled();
    expect(registryRecord.global).toEqual({ model: "anthropic/claude-a", credentialId: "cred-a" });
    expect(first.setModelCalls).toEqual(["anthropic/claude-b", "anthropic/claude-a"]); // applied then rolled back
    expect(first.runtimeParams.model).toBe("anthropic/claude-a");
    expect(first.destroyed).toBe(false);
  });

  it("commits the global config exactly once, only after a successful live apply", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const registry = await import("../../src/workspace/member-registry.js");
    await manager.activateAgent("room", "pm");

    await manager.switchMemberModel("pm", { model: "anthropic/claude-b", credentialId: "cred-a" });

    expect(handles[0].setModelCalls).toEqual(["anthropic/claude-b"]);
    expect(registry.updateMember).toHaveBeenCalledTimes(1);
    expect(registry.updateMember).toHaveBeenCalledWith("pm", { global: { model: "anthropic/claude-b", credentialId: "cred-a" } });
    expect(registryRecord.global).toEqual({ model: "anthropic/claude-b", credentialId: "cred-a" });
  });

  it("applies the switch to EVERY live instance of the member across scopes", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const registry = await import("../../src/workspace/member-registry.js");
    await manager.activateAgent("room", "pm");
    await manager.activateAgent("room2", "pm");
    expect(handles).toHaveLength(2);

    const result = await manager.switchMemberModel("pm", { model: "anthropic-proxy/claude-fable-5", credentialId: "cred-proxy" });

    // Instances keyed by scope, both applied, one commit.
    const scopes = result.instances.map((r: any) => r.scopeId).sort();
    expect(scopes).toEqual(["room:room", "room:room2"]);
    for (const h of handles) {
      expect(h.setModelCalls).toEqual(["anthropic-proxy/claude-fable-5"]);
      expect(h.destroyed).toBe(false);
    }
    expect(registry.updateMember).toHaveBeenCalledTimes(1);
  });

  it("multi-instance partial failure rolls back EVERY attempted instance (incl. the thrower) and commits nothing", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const registry = await import("../../src/workspace/member-registry.js");
    await manager.activateAgent("room", "pm");
    await manager.activateAgent("room2", "pm");
    // §10: room2's setModel fails AFTER assigning SDK state (once), so its
    // rollback must put the original model back rather than skip it.
    handles[1].failSetModelOnce = true;

    await expect(manager.switchMemberModel("pm", { model: "anthropic/claude-b", credentialId: "cred-a" }))
      .rejects.toThrow(/failed at room:room2.*restored to its previous model/s);

    // No commit, both handles back on the original binding, both alive.
    expect(registry.updateMember).not.toHaveBeenCalled();
    expect(registryRecord.global).toEqual({ model: "anthropic/claude-a", credentialId: "cred-a" });
    for (const h of handles) {
      expect(h.setModelCalls[h.setModelCalls.length - 1]).toBe("anthropic/claude-a");
      expect(h.runtimeParams.model).toBe("anthropic/claude-a");
      expect(h.destroyed).toBe(false);
    }
    const failedHandle = handles.find((h) => h.setModelCalls.includes("anthropic/claude-b"))!;
    expect(failedHandle.setModelCalls).toEqual(["anthropic/claude-b", "anthropic/claude-a"]); // applied then rolled back
  });

  it("rollback that fails again stops that exact scope's instance and names it in the error", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const registry = await import("../../src/workspace/member-registry.js");
    await manager.activateAgent("room", "pm");
    await manager.activateAgent("room2", "pm");
    handles[1].failSetModel = true; // fails the switch AND its rollback

    await expect(manager.switchMemberModel("pm", { model: "anthropic/claude-b", credentialId: "cred-a" }))
      .rejects.toThrow(/failed at room:room2.*could not restore room:room2.*stopped/s);

    expect(registry.updateMember).not.toHaveBeenCalled();
    const healthy = handles.find((h) => !h.failSetModel)!;
    expect(healthy.runtimeParams.model).toBe("anthropic/claude-a"); // restored
    expect(healthy.destroyed).toBe(false);
    const broken = handles.find((h) => h.failSetModel)!;
    expect(broken.destroyed).toBe(true); // stopped at that exact scope
  });

  it("rejects a second concurrent switch for the same member", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.failSetModel = true;
    // Hold setModel so the switch stays in flight.
    first.setModel = async (model: string) => { await new Promise((r) => setTimeout(r, 50)); first.setModelCalls.push(model); first.runtimeParams.model = model; };

    // §10: the lock is acquired synchronously at entry — the second call gets
    // the conflict error immediately, even while the first is still validating.
    const inFlight = manager.switchMemberModel("pm", { model: "anthropic/claude-b", credentialId: "cred-a" });
    await expect(manager.switchMemberModel("pm", { model: "anthropic-proxy/claude-fable-5", credentialId: "cred-proxy" }))
      .rejects.toMatchObject({ name: "MemberModelSwitchConflictError" });
    await inFlight;
    expect(first.setModelCalls).toEqual(["anthropic/claude-b"]);
  });

  it("thinking level applies member-globally: every idle instance of the member", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    await manager.activateAgent("room2", "pm");
    handles[1].emit({ type: "agent_start" }); // second instance busy

    const result = await manager.switchMemberThinkingLevel("pm", "high");

    expect(result.applied.sort()).toEqual(["room:room"]);
    expect(result.pending.sort()).toEqual(["room:room2"]);
    expect(handles[0].thinkingCalls).toEqual(["high"]);
    expect(handles[1].thinkingCalls).toEqual([]); // queued, applied on settlement
    expect(handles[0].runtimeParams.thinkingLevel).toBe("high");
  });

  it("a creation during a switch waits for the switch to end before building (no latecomer)", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    // Hold the switch in setModel so the gate stays closed.
    let releaseSetModel!: () => void;
    first.setModel = async (model: string) => {
      await new Promise<void>((resolve) => { releaseSetModel = resolve; });
      first.setModelCalls.push(model);
      first.runtimeParams.model = model;
    };
    const inFlight = manager.switchMemberModel("pm", { model: "anthropic/claude-b", credentialId: "cred-a" });
    await new Promise((resolve) => setTimeout(resolve, 20)); // switch is now held in setModel

    const creating = manager.buildMemberAgentSession("pm", "room:room3");
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Gated: nothing built while the switch is in flight, and the switch did
    // not wait on it either (it never registered as a pending creation).
    expect(handles).toHaveLength(1);

    releaseSetModel();
    await inFlight;
    const built = await creating;
    expect(built).toBeTruthy();
    expect(handles).toHaveLength(2);
    // The new instance is NOT part of the switch result (it built after, from
    // the committed binding) — no latecomer sweep exists to include it.
    expect(built!.handle.runtimeParams.model).toBe("anthropic/claude-a"); // member mock still points at claude-a
  }, 15000);

  it("§10: the switch WAITS for an in-flight creation — its snapshot includes it (no timeout path)", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm"); // fast runtime: 1 handle

    // Slow runtime for the second scope: its creation registers and hangs in
    // createAgent behind a latch.
    let releaseCreate!: () => void;
    const slowRuntime = {
      name: "test",
      async createAgent(opts: any) {
        await new Promise<void>((resolve) => { releaseCreate = resolve; });
        const handle = new TestHandle(opts.member.model);
        handles.push(handle);
        return handle;
      },
      async shutdownAll() {},
    };
    registry.get.mockReturnValue(slowRuntime as any);

    const creating = manager.buildMemberAgentSession("pm", "room:room3");
    await new Promise((resolve) => setTimeout(resolve, 20)); // creation now pending, latched

    const switching = manager.switchMemberModel("pm", { model: "anthropic/claude-b", credentialId: "cred-a" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The switch must NOT have snapshotted yet — it is waiting for the pending
    // creation (no setModel on the live instance in the meantime).
    expect(handles[0].setModelCalls).toEqual([]);

    releaseCreate();
    const built = await creating;
    expect(built).toBeTruthy();
    const result = await switching;
    // The waited-for creation is in the snapshot and got the switch applied.
    const scopes = result.instances.map((r: any) => r.scopeId).sort();
    expect(scopes).toEqual(["room:room", "room:room3"]);
    for (const h of handles) expect(h.setModelCalls).toEqual(["anthropic/claude-b"]);
    // Restore the fast runtime for the rest of the file (clearAllMocks does
    // not undo mockReturnValue).
    registry.get.mockImplementation(() => runtime);
  }, 15000);

  it("§10: invalid requests export nothing; a valid switch refreshes the instance catalog", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");

    // Entry validation is read-only — a rejected switch never writes models.json.
    const before = exportedCalls.length;
    await expect(manager.switchMemberModel("pm", { model: "anthropic/claude-b", credentialId: "cred-proxy" }))
      .rejects.toThrow(/does not serve model/);
    expect(exportedCalls.length).toBe(before);

    // A valid switch DOES export at apply time — a newly created provider
    // must reach the old session's dir so runtime.refresh can find it.
    await manager.switchMemberModel("pm", { model: "anthropic/claude-b", credentialId: "cred-a" });
    expect(exportedCalls.length).toBeGreaterThan(before);
    expect(exportedCalls.at(-1)).toMatchObject({ modelRef: "anthropic/claude-b", credentialId: "cred-a" });
  });

  it("validates the credential before touching any instance", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const creds = await import("../../src/engine/model-credentials.js");
    await manager.activateAgent("room", "pm");

    // Unknown profile → fail upfront, no setModel, no commit.
    (creds.getModelCredentialProfile as any).mockReturnValueOnce(undefined);
    await expect(manager.switchMemberModel("pm", { model: "anthropic/claude-b", credentialId: "cred-missing" })).rejects.toThrow(/Credential profile not found/);
    expect(handles[0].setModelCalls).toEqual([]);

    // Model not in the catalog → fail upfront.
    await expect(manager.switchMemberModel("pm", { model: "anthropic/claude-z", credentialId: "cred-a" })).rejects.toThrow(/not available/);
    expect(handles[0].setModelCalls).toEqual([]);
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
    expect(first.reloadCalls[0]).toMatchObject({ roomId: "room", member: expect.objectContaining({ id: "pm" }), skillNames: ["review"] });
    expect(first.reloadCalls[0].agentPrompt).toContain("I am pm.");
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

  it("compact with no live instance builds for a configured member; an unresolvable one fails honestly", async () => {
    const manager = await import("../../src/engine/agent-manager.js");

    const result = await manager.compactMember("room:room2", "pm");
    expect(result).toEqual({ ok: true, action: "compacted" }); // built, never prompted
    expect(handles[0].promptCalls).toEqual([]);

    member = null;
    await expect(manager.compactMember("room:room", "ghost")).rejects.toThrow(/No active session/);
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
    // pi always follows a failed message_end with agent_end (retry budget exhausted
    // here: no willRetry) — the system notice is deferred to that final agent_end
    // so retry storms post one notice, not one per attempt (fish 2026-08-09).
    first.emit({ type: "agent_end" });

    expect(loggerError).toHaveBeenCalledWith("agent", "member request failed", expect.objectContaining({ roomId: "room", member: "pm", memberId: "pm", error: "502 upstream_error" }));
    expect(messageBus.postMessage).toHaveBeenCalledWith("room", "system", 'Member "pm" request failed. Error: 502 upstream_error');
    expect(first.destroyed).toBe(false);
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");
    expect(ws.broadcastToRoom).not.toHaveBeenCalledWith("room", { type: "agent:status", roomId: "room", agent: "pm", status: "inactive" });

    await manager.activateAgent("room", "pm");
    expect(handles).toHaveLength(1);
  });
});
