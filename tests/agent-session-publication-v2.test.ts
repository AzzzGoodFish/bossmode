import { afterEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "./helpers/core-fixture.js";
import { buildMemberAgentSession, configureAssembly } from "../src/agent/assembly.js";
import {
  closeRuntimeAdmission, instances, openRuntimeAdmission, pendingCreations,
  sessionPublishOwners,
} from "../src/agent/instance.js";
import { RuntimeRegistry, type AgentHandle, type AgentMemberSnapshot, type AgentRuntime, type CreateAgentOpts } from "../src/agent/types.js";

const fixtures: ReturnType<typeof coreFixture>[] = [];
afterEach(() => {
  instances.clear(); pendingCreations.clear(); sessionPublishOwners.clear(); openRuntimeAdmission();
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function setup() {
  const fixture = coreFixture(); fixtures.push(fixture);
  fixture.db.run(
    "INSERT INTO members(id,name,name_key,agent_template,global_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    "mem_build", "Builder", "builder", "general", "{}", 1, 1,
  );
  const snapshot: AgentMemberSnapshot = {
    config: { id: "mem_build", name: "Builder", agent: "general", runtime: "controlled", model: "fake:model", credentialId: "cred" },
    prompt: { agentPrompt: "role", envPrompt: "env", appendSystemPrompt: [], contractFingerprint: "fp" },
    resources: { skillNames: [], skillPaths: [], extensionPaths: [], mcp: { adapterPath: "", runtimeDir: "/tmp", config: {}, serverNames: [] } },
    workspaceRoot: "/tmp",
  };
  return { fixture, snapshot };
}

function handle() {
  const destroyAndWait = vi.fn(async () => {});
  const value: AgentHandle = {
    isWorking: false, prompt: async () => {}, compact: async () => ({ aborted: false }),
    abort() {}, destroy() {}, destroyAndWait, waitForIdle: async () => {}, subscribe: () => () => {},
  };
  return { value, destroyAndWait };
}

function controlledRuntime(createAgent: (opts: CreateAgentOpts) => Promise<AgentHandle>): AgentRuntime {
  return {
    name: "controlled",
    capabilities: { streaming: true, toolEvents: true, thinking: false, usage: false, dynamicModel: false, dynamicThinking: false, permissionControl: false, sessionResume: true, contextUsage: false },
    detect: async () => ({ available: true }), createAgent,
    shutdownMember: async () => {}, shutdownAll: async () => {},
  };
}

describe("session publication gates v2", () => {
  it("saves a first materialized session during shutdown but rejects and awaits the new handle", async () => {
    const { snapshot } = setup();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runtimeHandle = handle();
    const runtime = controlledRuntime(async opts => {
      started(); await gate;
      opts.onSessionChanged?.({ sessionId: "sid", sessionFile: "/tmp/final-session.jsonl" });
      return runtimeHandle.value;
    });
    const registry = new RuntimeRegistry(); registry.register(runtime);
    const saveSession = vi.fn();
    configureAssembly(registry, () => snapshot, { saveSession });

    const building = buildMemberAgentSession("mem_build");
    await entered;
    closeRuntimeAdmission();
    release();

    await expect(building).resolves.toBeNull();
    expect(saveSession).toHaveBeenCalledWith("mem_build", "controlled", { sessionId: "sid", sessionFile: "/tmp/final-session.jsonl" });
    expect(runtimeHandle.destroyAndWait).toHaveBeenCalledOnce();
    expect(instances.has("mem_build")).toBe(false);
  });

  it("an owner replacement suppresses stale callbacks and destroys the rejected builder", async () => {
    const { snapshot } = setup();
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runtimeHandle = handle();
    const runtime = controlledRuntime(async opts => {
      started(); await gate;
      opts.onSessionChanged?.({ sessionFile: "/tmp/stale.jsonl" });
      return runtimeHandle.value;
    });
    const registry = new RuntimeRegistry(); registry.register(runtime);
    const saveSession = vi.fn();
    configureAssembly(registry, () => snapshot, { saveSession });

    const building = buildMemberAgentSession("mem_build");
    await entered;
    sessionPublishOwners.set("mem_build", {});
    release();

    await expect(building).resolves.toBeNull();
    expect(saveSession).not.toHaveBeenCalled();
    expect(runtimeHandle.destroyAndWait).toHaveBeenCalledOnce();
    expect(instances.has("mem_build")).toBe(false);
  });
});
