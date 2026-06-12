import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentHandle, AgentStreamEvent } from "../../src/engine/runtime/types.js";

let member: any;
let messages: any[];
let availableModels: Array<{ ref: string }>;
let exportedCalls: any[];
const handles: TestHandle[] = [];

class TestHandle implements AgentHandle {
  listeners = new Set<(event: AgentStreamEvent) => void>();
  setModelCalls: string[] = [];
  refreshCalls = 0;
  destroyed = false;
  runtimeName = "test";
  runtimeParams: any;

  constructor(model: string) {
    this.runtimeParams = { model };
  }

  async prompt(): Promise<void> {
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
    this.setModelCalls.push(model);
    this.runtimeParams.model = model;
  }
  async refreshModelRegistry(): Promise<void> {
    this.refreshCalls += 1;
  }
}

vi.mock("../../src/workforce/member-store.js", () => ({
  getMemberByName: vi.fn(() => member),
  saveMember: vi.fn((next: any) => { member = next; return next; }),
}));

vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: vi.fn((name: string) => ({ name, model: "anthropic/claude-a", description: name, systemPrompt: "test", skills: [], tags: [] })),
}));

vi.mock("../../src/workspace/room-store.js", () => ({
  getRoom: vi.fn(() => ({ id: "room", name: "Room", cwd: "/tmp", members: ["pm"], ruleDocs: [] })),
  getCursors: vi.fn(() => ({})),
  setCursor: vi.fn(),
}));

vi.mock("../../src/workspace/session-store.js", () => ({
  getSessions: vi.fn(() => ({ pm: { runtime: "test", sessionId: "s1", sessionFile: "/tmp/session.jsonl" } })),
  saveSession: vi.fn(),
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
  exportPiConfigForMember: vi.fn((args: any) => { exportedCalls.push(args); return { agentDir: "/tmp/agent", extensionPaths: [] }; }),
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
});
