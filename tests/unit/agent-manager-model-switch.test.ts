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

  constructor(model: string) {
    this.runtimeParams = { model };
  }

  async prompt(message = ""): Promise<void> {
    this.promptCalls.push(message);
    this.emit({ type: "agent_start" });
    this.emit({ type: "agent_end" });
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
  exportPiConfigForMember: vi.fn((args: any) => { exportedCalls.push(args); return exportReturnsNull ? null : { agentDir: "/tmp/agent", extensionPaths: [] }; }),
}));

vi.mock("../../src/shared/config.js", () => ({
  getBossmodeDir: vi.fn(() => "/tmp/bossmode-test"),
  readConfig: vi.fn(() => ({ runtime: { sessionResume: true } })),
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

  it("recreates the handle for cross-credential/provider switches so auth and extensions reload", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    const result = await manager.switchMemberModel("room", "pm", "anthropic-proxy/claude-fable-5", "cred-proxy");

    expect(result.applied).toBe(true);
    expect(handles).toHaveLength(2);
    expect(first.destroyed).toBe(true);
    expect(first.setModelCalls).toEqual([]);
    expect(handles[1].runtimeParams.model).toBe("anthropic-proxy/claude-fable-5");
    expect(exportedCalls.at(-1)).toMatchObject({ modelRef: "anthropic-proxy/claude-fable-5", credentialId: "cred-proxy" });
  });

  it("recreates for same-provider credential changes so AuthStorage is fresh", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    await manager.switchMemberModel("room", "pm", "anthropic/claude-b", "cred-b");

    expect(handles).toHaveLength(2);
    expect(first.destroyed).toBe(true);
    expect(first.setModelCalls).toEqual([]);
    expect(handles[1].runtimeParams.model).toBe("anthropic/claude-b");
  });

  it("recreates when switching from proxy back to builtin provider", async () => {
    member = { ...member, model: "anthropic-proxy/claude-fable-5", credentialId: "cred-proxy" };
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    await manager.switchMemberModel("room", "pm", "anthropic/claude-b", "cred-a");

    expect(handles).toHaveLength(2);
    expect(first.destroyed).toBe(true);
    expect(handles[1].runtimeParams.model).toBe("anthropic/claude-b");
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

  it("queues a cross-provider switch while working and recreates after agent_end", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.emit({ type: "agent_start" });

    const result = await manager.switchMemberModel("room", "pm", "anthropic-proxy/claude-fable-5", "cred-proxy");
    expect(result.pending).toBe(true);
    expect(handles).toHaveLength(1);

    first.emit({ type: "agent_end" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handles).toHaveLength(2);
    expect(first.destroyed).toBe(true);
    expect(handles[1].runtimeParams.model).toBe("anthropic-proxy/claude-fable-5");
  });

  it("refreshes an idle active agent when its credential profile changes", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");

    const result = await manager.invalidateModelCredentialProfile("cred-a", "anthropic");

    expect(result).toEqual([{ roomId: "room", memberName: "pm", applied: true, pending: false }]);
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

  it("drops an idle active agent when refresh/rebind fails", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const ws = await import("../../src/communication/ws.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.failSetModel = true;

    await manager.invalidateModelCredentialProfile("cred-a", "anthropic");

    expect(first.destroyed).toBe(true);
    expect(manager.getAgentStatus("room", "pm")).toBe("inactive");
    expect(ws.broadcastToRoom).toHaveBeenCalledWith("room", { type: "agent:status", roomId: "room", agent: "pm", status: "inactive" });
  });

  it("filters all member runtime failure system messages from activation prompts", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    messages = [
      { id: "err", type: "chat", sender: "system", content: 'Member "pm" request failed. Error: context_length_exceeded', mentions: [], ts: Date.now() },
      { id: "cred", type: "chat", sender: "system", content: 'Member "pm" model credential is no longer available. Update Settings.', mentions: [], ts: Date.now() },
      { id: "switch", type: "chat", sender: "system", content: 'Failed to switch model for "pm": setModel failed', mentions: [], ts: Date.now() },
      { id: "other", type: "chat", sender: "system", content: 'Member "qa" request failed. Error: hidden from pm too', mentions: [], ts: Date.now() },
      { id: "task", type: "system", sender: "system", content: "[Task] qa moved task to review: **Check this**", mentions: [], ts: Date.now() },
      { id: "knowledge", type: "system", sender: "system", content: "[Knowledge] qa updated document: **Report**", mentions: [], ts: Date.now() },
      { id: "m1", type: "chat", sender: "user", content: "@pm continue", mentions: ["pm"], ts: Date.now() },
    ];

    await manager.activateAgent("room", "pm");

    expect(handles[0].promptCalls[0]).toContain("@pm continue");
    expect(handles[0].promptCalls[0]).toContain("[Task] qa moved task to review");
    expect(handles[0].promptCalls[0]).toContain("[Knowledge] qa updated document");
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
    expect(first.reloadCalls[0].skillPaths[0]).toContain("/tmp/bossmode-test/skills/review");
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
