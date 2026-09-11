import { coreFixture } from "../helpers/core-fixture.js";
import { getDatabase } from "../../src/storage/database.js";
import { MembersRepository } from "../../src/storage/repositories/members.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as bus from "../../src/communication/message-bus.js";
import { loadEventsFromDisk } from "../../src/engine/event-handler.js";
import { getMember, updateMember } from "../../src/workspace/member-registry.js";

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
import type { AgentHandle, AgentStreamEvent } from "../../src/engine/runtime/types.js";

let availableModels: Array<{ ref: string }>;
let exportedCalls: any[];
let exportReturnsNull: boolean;
const handles: TestHandle[] = [];
const { loggerError, loggerWarn, loggerInfo } = vi.hoisted(() => ({ loggerError: vi.fn(), loggerWarn: vi.fn(), loggerInfo: vi.fn() }));

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
  holdAgentEnd = false;
  private pendingPromptResolve: (() => void) | null = null;

  constructor(model: string) {
    this.runtimeParams = { model };
  }

  async prompt(message = "", options?: PromptOptions): Promise<void> {
    dispatch(message, options);
    this.promptCalls.push(message);
    const deferEnd=this.holdAgentEnd;
    this.emit({ type: "agent_start" });
    if(!deferEnd)this.emit({ type: "agent_end" });
    if (this.holdPrompt) {
      await new Promise<void>((resolve) => { this.pendingPromptResolve = resolve; });
    }
    if(deferEnd)this.emit({ type: "agent_end" });
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
  async destroyAndWait(): Promise<void> { this.abort(); await this.waitForIdle(); this.destroy(); }
  waitForIdle(): Promise<void> { return Promise.resolve(); }
  subscribe(fn: (event: AgentStreamEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(event: AgentStreamEvent): void {
    if (event.type === "compaction_end") compactionRefreshPending = true;
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

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToRoom: vi.fn(),
  broadcastToAgentSubscribers: vi.fn(),
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

vi.mock("../../src/workforce/skill-store.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/workforce/skill-store.js")>(),
  resolveGlobalSkillPaths: (skillNames: string[]) => skillNames.map((s: string) => "/tmp/skills/" + s),
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

beforeEach(async () => {
  compactionRefreshPending = false;
  fixture = coreFixture();
  (await import("../../src/shared/config.js")).writeConfig({ auth: { username: "test", passwordHash: "fixture" }, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 }, runtime: { sessionResume: false } });
  const members = new MembersRepository(fixture.db);
  const conversations = new ConversationsRepository(fixture.db);
  for (const name of ["pm", "qa"]) {
    const id = `mem_${name}`;
    members.insert({ id, name, agentTemplate: name, global: { model: "anthropic/claude-a", credentialId: "cred-a" },
      unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}, createdAt: 1, updatedAt: 1 });
    conversations.ensureDmScope(id);
    const memberPath = join(fixture.root, "members", id);
    mkdirSync(memberPath, { recursive: true });
    writeFileSync(join(memberPath, "persona.md"), `You are ${name}.`);
  }
  for (const id of ["room", "room2", "room3"]) {
    conversations.upsertRoom({ id, name: id, cwd: fixture.root, members: ["pm", "qa"], globalMemberIds: ["mem_pm", "mem_qa"], createdAt: 1 });
  }
  bus.postMessage("room", "user", "@pm hi", ["pm"]);
  vi.mocked(bus.postMessage).mockClear();
});
afterEach(async () => {
  for (const handle of handles) { handle.holdPrompt = false; handle.resolvePendingPrompt(); }
  await (await import("../../src/engine/agent-manager.js")).shutdownAll();
  // The real event consumer schedules post-compaction refreshes up to 1500ms.
  if (compactionRefreshPending) await new Promise((resolve) => setTimeout(resolve, 1600));
  fixture.close();
});

describe("agent-manager model hot switch", () => {
  beforeEach(async () => {
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

    const result = await manager.switchMemberModel("mem_pm", { model: "anthropic/claude-b", credentialId: "cred-a" });

    expect(result.model).toBe("anthropic/claude-b");
    expect(result.instances).toEqual([{ scopeId: "room:room", applied: true }]);
    expect(handles).toHaveLength(1);
    expect(handles[0].destroyed).toBe(false);
    expect(handles[0].setModelCalls).toEqual(["anthropic/claude-b"]);
    expect(getMember("mem_pm")!.global).toEqual({ model: "anthropic/claude-b", credentialId: "cred-a" });
  });

  it("applies cross-credential/provider switches via setModel without recreating the handle", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    const result = await manager.switchMemberModel("mem_pm", { model: "anthropic-proxy/claude-fable-5", credentialId: "cred-proxy" });

    expect(result.model).toBe("anthropic-proxy/claude-fable-5");
    expect(result.instances).toEqual([{ scopeId: "room:room", applied: true }]);
    expect(handles).toHaveLength(1);
    expect(first.destroyed).toBe(false);
    expect(first.setModelCalls).toEqual(["anthropic-proxy/claude-fable-5"]);
    expect(first.runtimeParams.model).toBe("anthropic-proxy/claude-fable-5");
    expect(getMember("mem_pm")!.global).toEqual({ model: "anthropic-proxy/claude-fable-5", credentialId: "cred-proxy" });
  });

  it("applies same-provider credential changes via setModel without recreating (live credential store)", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    await manager.switchMemberModel("mem_pm", { model: "anthropic/claude-b", credentialId: "cred-b" });

    expect(handles).toHaveLength(1);
    expect(first.destroyed).toBe(false);
    expect(first.setModelCalls).toEqual(["anthropic/claude-b"]);
    expect(first.runtimeParams.model).toBe("anthropic/claude-b");
  });

  it("applies proxy→builtin switches via setModel without recreating", async () => {
    updateMember("mem_pm", { global: { model: "anthropic-proxy/claude-fable-5", credentialId: "cred-proxy" } });
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    await manager.switchMemberModel("mem_pm", { model: "anthropic/claude-b", credentialId: "cred-a" });

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
    expect(ws.broadcastToRoom).toHaveBeenCalledWith("room", { type: "agent:status", roomId: "room", agent: "pm", memberId: "mem_pm", status: "working" });

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
    bus.postMessage("room", "user", "@pm next turn", ["pm"]);
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
    bus.postMessage("room", "user", "@pm next turn", ["pm"]);
    const pending = manager.activateAgent("room", "pm");
    await new Promise((resolve) => setTimeout(resolve, 0));

    first.emit({ type: "compaction_start", reason: "threshold" });
    first.emit({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");

    bus.postMessage("room", "user", "@pm are you there", ["pm"]);
    await manager.activateAgent("room", "pm");
    // Not delivered yet — the in-flight prompt() has not settled (dispatchState still busy).
    expect(first.promptCalls).toHaveLength(baseline + 1);

    // The queued turn must actually remain active; emitting agent_end before
    // the assertion would model completed SDK work, not a working avatar.
    first.holdAgentEnd=true;
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
    bus.postMessage("room", "user", "@pm are you there", ["pm"]);
    await manager.activateAgent("room", "pm");

    expect(first.promptCalls).toHaveLength(baseline);
    expect(handles).toHaveLength(1);

    first.emit({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
    await vi.waitFor(()=>expect(first.promptCalls.length).toBeGreaterThan(baseline));
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

    const result = await manager.switchMemberModel("mem_pm", { model: "anthropic-proxy/claude-fable-5", credentialId: "cred-proxy" });
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
    expect(exportedCalls.at(-1)).toMatchObject({ roomId: "room", memberName: "mem_pm", modelRef: "anthropic/claude-a", credentialId: "cred-a" });
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
    expect(ws.broadcastToRoom).toHaveBeenCalledWith("room", { type: "agent:status", roomId: "room", agent: "pm", memberId: "mem_pm", status: "inactive" });
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
    expect(ws.broadcastToRoom).toHaveBeenCalledWith("room", { type: "agent:status", roomId: "room", agent: "pm", memberId: "mem_pm", status: "inactive" });
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
    vi.spyOn(registry, "updateMember");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    // §10 shape: the SDK assigned state.model and THEN setModel threw — the
    // rollback must put the original binding back on this same handle.
    first.failSetModelOnce = true;

    await expect(manager.switchMemberModel("mem_pm", { model: "anthropic/claude-b", credentialId: "cred-a" }))
      .rejects.toThrow(/restored to its previous model/);

    // Commit happens only after a successful apply — the registry was never written.
    expect(registry.updateMember).not.toHaveBeenCalled();
    expect(getMember("mem_pm")!.global).toEqual({ model: "anthropic/claude-a", credentialId: "cred-a" });
    expect(first.setModelCalls).toEqual(["anthropic/claude-b", "anthropic/claude-a"]); // applied then rolled back
    expect(first.runtimeParams.model).toBe("anthropic/claude-a");
    expect(first.destroyed).toBe(false);
  });

  it("commits the global config exactly once, only after a successful live apply", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const registry = await import("../../src/workspace/member-registry.js");
    vi.spyOn(registry, "updateMember");
    await manager.activateAgent("room", "pm");

    await manager.switchMemberModel("mem_pm", { model: "anthropic/claude-b", credentialId: "cred-a" });

    expect(handles[0].setModelCalls).toEqual(["anthropic/claude-b"]);
    expect(registry.updateMember).toHaveBeenCalledTimes(1);
    expect(registry.updateMember).toHaveBeenCalledWith("mem_pm", { global: { model: "anthropic/claude-b", credentialId: "cred-a" } });
    expect(getMember("mem_pm")!.global).toEqual({ model: "anthropic/claude-b", credentialId: "cred-a" });
  });

  it("applies the switch to EVERY live instance of the member across scopes", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const registry = await import("../../src/workspace/member-registry.js");
    vi.spyOn(registry, "updateMember");
    await manager.activateAgent("room", "pm");
    await manager.activateAgent("room2", "pm");
    expect(handles).toHaveLength(2);

    const result = await manager.switchMemberModel("mem_pm", { model: "anthropic-proxy/claude-fable-5", credentialId: "cred-proxy" });

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
    vi.spyOn(registry, "updateMember");
    await manager.activateAgent("room", "pm");
    await manager.activateAgent("room2", "pm");
    // §10: room2's setModel fails AFTER assigning SDK state (once), so its
    // rollback must put the original model back rather than skip it.
    handles[1].failSetModelOnce = true;

    await expect(manager.switchMemberModel("mem_pm", { model: "anthropic/claude-b", credentialId: "cred-a" }))
      .rejects.toThrow(/failed at room:room2.*restored to its previous model/s);

    // No commit, both handles back on the original binding, both alive.
    expect(registry.updateMember).not.toHaveBeenCalled();
    expect(getMember("mem_pm")!.global).toEqual({ model: "anthropic/claude-a", credentialId: "cred-a" });
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
    vi.spyOn(registry, "updateMember");
    await manager.activateAgent("room", "pm");
    await manager.activateAgent("room2", "pm");
    handles[1].failSetModel = true; // fails the switch AND its rollback

    await expect(manager.switchMemberModel("mem_pm", { model: "anthropic/claude-b", credentialId: "cred-a" }))
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
    const inFlight = manager.switchMemberModel("mem_pm", { model: "anthropic/claude-b", credentialId: "cred-a" });
    await expect(manager.switchMemberModel("mem_pm", { model: "anthropic-proxy/claude-fable-5", credentialId: "cred-proxy" }))
      .rejects.toMatchObject({ name: "MemberModelSwitchConflictError" });
    await inFlight;
    expect(first.setModelCalls).toEqual(["anthropic/claude-b"]);
  });

  it("thinking level applies member-globally: every idle instance of the member", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    await manager.activateAgent("room2", "pm");
    handles[1].emit({ type: "agent_start" }); // second instance busy

    const result = await manager.switchMemberThinkingLevel("mem_pm", "high");

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
    const inFlight = manager.switchMemberModel("mem_pm", { model: "anthropic/claude-b", credentialId: "cred-a" });
    await new Promise((resolve) => setTimeout(resolve, 20)); // switch is now held in setModel

    const creating = manager.buildMemberAgentSession("mem_pm", "room:room3");
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
    expect(built!.handle.runtimeParams.model).toBe("anthropic/claude-b"); // SQL binding committed before creation resumes
  }, 15000);

  it("§10: the switch WAITS for an in-flight creation — its snapshot includes it (no timeout path)", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm"); // fast runtime: 1 handle

    // Slow runtime for the second scope: its creation registers and hangs in
    // createAgent behind a latch.
    let releaseCreate!: () => void;
    const slowRuntime = {
      name: "pi-cli",
      async createAgent(opts: any) {
        await new Promise<void>((resolve) => { releaseCreate = resolve; });
        const handle = new TestHandle(opts.member.model);
        handles.push(handle);
        return handle;
      },
      async shutdownAll() {},
    };
    registry.get.mockReturnValue(slowRuntime as any);

    const creating = manager.buildMemberAgentSession("mem_pm", "room:room3");
    await new Promise((resolve) => setTimeout(resolve, 20)); // creation now pending, latched

    const switching = manager.switchMemberModel("mem_pm", { model: "anthropic/claude-b", credentialId: "cred-a" });
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
    await expect(manager.switchMemberModel("mem_pm", { model: "anthropic/claude-b", credentialId: "cred-proxy" }))
      .rejects.toThrow(/does not serve model/);
    expect(exportedCalls.length).toBe(before);

    // A valid switch DOES export at apply time — a newly created provider
    // must reach the old session's dir so runtime.refresh can find it.
    await manager.switchMemberModel("mem_pm", { model: "anthropic/claude-b", credentialId: "cred-a" });
    expect(exportedCalls.length).toBeGreaterThan(before);
    expect(exportedCalls.at(-1)).toMatchObject({ modelRef: "anthropic/claude-b", credentialId: "cred-a" });
  });

  it("validates the credential before touching any instance", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const creds = await import("../../src/engine/model-credentials.js");
    await manager.activateAgent("room", "pm");

    // Unknown profile → fail upfront, no setModel, no commit.
    (creds.getModelCredentialProfile as any).mockReturnValueOnce(undefined);
    await expect(manager.switchMemberModel("mem_pm", { model: "anthropic/claude-b", credentialId: "cred-missing" })).rejects.toThrow(/Credential profile not found/);
    expect(handles[0].setModelCalls).toEqual([]);

    // Model not in the catalog → fail upfront.
    await expect(manager.switchMemberModel("mem_pm", { model: "anthropic/claude-z", credentialId: "cred-a" })).rejects.toThrow(/not available/);
    expect(handles[0].setModelCalls).toEqual([]);
  });

  it("filters all member runtime failure system messages from activation prompts", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const now = Date.now();
    const messages = [
      { id: "err", type: "chat", sender: "system", content: 'Member "pm" request failed. Error: context_length_exceeded', mentions: [], ts: now, seq: 1 },
      { id: "cred", type: "chat", sender: "system", content: 'Member "pm" model credential is no longer available. Update Settings.', mentions: [], ts: now, seq: 2 },
      { id: "switch", type: "chat", sender: "system", content: 'Failed to switch model for "pm": setModel failed', mentions: [], ts: now, seq: 3 },
      { id: "other", type: "chat", sender: "system", content: 'Member "qa" request failed. Error: hidden from pm too', mentions: [], ts: now, seq: 4 },
      { id: "task", type: "task_event", sender: "system", content: "[Task] qa moved task to review: **Check this**", mentions: [], ts: now, seq: 5 },
      { id: "knowledge", type: "knowledge_event", sender: "system", content: "[Knowledge] qa updated document: **Report**", mentions: [], ts: now, seq: 6 },
      { id: "m1", type: "chat", sender: "user", content: "@pm continue", mentions: ["pm"], ts: now, seq: 7 },
    ];
    (await import("../../src/workspace/room-store.js")).setCursor("room", "mem_pm", bus.getLatestMessageId("room"));
    for (const message of messages) bus.postMessage("room", message.sender, message.content, message.mentions, message.type === "chat" ? undefined : { type: message.type as any });

    await manager.activateAgent("room", "pm");

    // Hybrid: trigger injects in full; task/knowledge events become a one-line
    // backlog hint (counted, not re-injected verbatim); failure notices are
    // filtered from BOTH the hint and the trigger.
    expect(handles[0].promptCalls[0]).toContain("@pm continue");
    expect(handles[0].promptCalls[0]).toContain("you have 2 unread messages (No.6–No.7): system×2");
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
    updateMember("mem_pm", { global: { skills: ["review"] } });
    await manager.activateAgent("room", "pm");
    const first = handles[0];

    const result = await manager.reloadMemberResources("room", "pm");

    expect(result).toEqual({ ok: true, reloaded: true, message: "Reloaded latest prompt, skills and tools in place." });
    expect(handles).toHaveLength(1);
    expect(first.destroyed).toBe(false);
    expect(first.reloadCalls[0]).toMatchObject({ roomId: "room", member: expect.objectContaining({ id: "mem_pm" }), skillNames: ["review"] });
    expect(first.reloadCalls[0].agentPrompt).toContain("I am pm.");
    expect(first.reloadCalls[0].skillPaths[0]).toContain("skills/review");
  });

  it("surfaces reload failure and reports no success when the runtime cannot apply MCP access", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    await manager.activateAgent("room", "pm");
    const first = handles[0];
    first.failReload = true;

    await expect(manager.reloadMemberResources("room", "pm")).rejects.toThrow("Reload could not apply MCP access.");

    expect(first.runtimeParams.systemPrompt).toBeUndefined();
    expect(loadEventsFromDisk("room", "mem_pm")).not.toContainEqual(expect.objectContaining({ text: "Reloaded member resources in place." }));
    expect(first.destroyed).toBe(false);
  });

  it("blocks activation for an Unconfigured member without creating a runtime or guessing a credential", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const messageBus = await import("../../src/communication/message-bus.js");
    updateMember("mem_pm", { global: { model: null, credentialId: null } });

    await manager.activateAgent("room", "pm");

    expect(handles).toHaveLength(0);
    expect(messageBus.postMessage).toHaveBeenCalledWith("room", "system", 'Member "pm" hasn\'t selected a model yet. Open the member card to choose a model and credential, then try again.');
  });

  it("compact with no live instance builds for a configured member; an unresolvable one fails honestly", async () => {
    const manager = await import("../../src/engine/agent-manager.js");

    const result = await manager.compactMember("room:room2", "mem_pm");
    expect(result).toEqual({ ok: true, action: "compacted" }); // built, never prompted
    expect(handles[0].promptCalls).toEqual([]);

    await expect(manager.compactMember("room:room", "ghost")).rejects.toThrow(/No active session/);
  });

  it("blocks activation when a member has a model but no bound credential", async () => {
    const manager = await import("../../src/engine/agent-manager.js");
    const messageBus = await import("../../src/communication/message-bus.js");
    updateMember("mem_pm", { global: { credentialId: null } });

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

    expect(loggerError).toHaveBeenCalledWith("agent", "member request failed", expect.objectContaining({ roomId: "room", member: "pm", memberId: "mem_pm", error: "502 upstream_error" }));
    expect(messageBus.postMessage).toHaveBeenCalledWith("room", "system", 'Member "pm" request failed. Error: 502 upstream_error');
    expect(first.destroyed).toBe(false);
    expect(manager.getAgentStatus("room", "pm")).toBe("idle");
    expect(ws.broadcastToRoom).not.toHaveBeenCalledWith("room", { type: "agent:status", roomId: "room", agent: "pm", memberId: "mem_pm", status: "inactive" });

    await manager.activateAgent("room", "pm");
    expect(handles).toHaveLength(1);
  });
});
