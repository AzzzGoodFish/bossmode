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
vi.mock("../../src/chat/message-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/chat/message-bus.js")>();
  return { ...actual, postMessage: vi.fn(actual.postMessage) };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  prompt: vi.fn(async (_message: string) => {}),
  steer: vi.fn(),
  abort: vi.fn(),
  destroy: vi.fn(),
  subscribeCb: undefined as any,
  broadcastToRoom: vi.fn(),
}));

vi.mock("../../src/kernel/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/app/server/ws.js", () => ({
  broadcastToRoom: mocks.broadcastToRoom,
  broadcastToAgentSubscribers: vi.fn(),
}));

import { RuntimeRegistry } from "../../src/agent/runtime/registry.js";
import { setStatusSink } from "../../src/agent/instance.js";
import { activateAgent, buildMemberAgentSession, initAgentManager, shutdownAll } from "../../src/agent/orchestrator/agent-manager.js";

beforeEach(async () => {
  fixture = coreFixture();
  (await import("../../src/config/settings.js")).writeConfig({ auth: { username: "test", passwordHash: "fixture" }, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 }, runtime: { sessionResume: false } });
  const members = fixture.db;
  const conversations = fixture.db;
  for (const name of ["developer", "qa"]) {
    const id = `mem_${name}`;
    insertMemberIdentity({ id, name, agentTemplate: name, global: { model: "anthropic/claude-a", credentialId: "cred-a" },
      unifiedModel: true, unifiedExtensions: true, scopeOverrides: {}, createdAt: 1, updatedAt: 1 }, members);
    ensureDmScope(id, conversations);
    const memberPath = join(fixture.root, "members", id);
    mkdirSync(memberPath, { recursive: true });
    writeFileSync(join(memberPath, "persona.md"), `You are ${name}.`);
  }
  for (const id of ["room1", "room2", "room3"]) {
    storeRoom({ id, name: id, cwd: fixture.root, members: ["developer", "qa"], globalMemberIds: ["mem_developer", "mem_qa"], createdAt: 1 }, conversations);
  }
  bus.postMessage("room1", "user", "@developer hi", ["developer"]);
  vi.mocked(bus.postMessage).mockClear();
});
afterEach(async () => {
  await (await import("../../src/agent/orchestrator/agent-manager.js")).shutdownAll();
  fixture.close();
});

describe("agent-manager pending creation dedup", () => {
  beforeEach(async () => {
    mocks.createAgent.mockReset();
    mocks.prompt.mockReset();
    mocks.steer.mockReset();
    mocks.abort.mockReset();
    mocks.destroy.mockReset();
    mocks.subscribeCb = undefined;
    mocks.broadcastToRoom.mockReset();
    setStatusSink((target, payload) => mocks.broadcastToRoom(target, payload));

    const handle = {
      prompt: (message: string, options?: PromptOptions) => { dispatch(message, options); return mocks.prompt(message); },
      steer: mocks.steer,
      abort: mocks.abort,
      destroy: mocks.destroy,
      destroyAndWait: async () => { mocks.abort(); mocks.destroy(); },
      waitForIdle: vi.fn(async () => {}),
      subscribe: vi.fn((fn) => { mocks.subscribeCb = fn; return () => {}; }),
      getContextUsage: vi.fn(async () => null),
      isWorking: false,
      runtimeName: "pi-cli",
    };

    mocks.createAgent.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return handle;
    });

    const runtime = {
      name: "pi-cli",
      capabilities: {
        streaming: true,
        toolEvents: true,
        thinking: true,
        usage: true,
        dynamicModel: true,
        dynamicThinking: true,
        permissionControl: true,
        sessionResume: true,
        contextUsage: true,
      },
      detect: vi.fn(async () => ({ available: true })),
      createAgent: mocks.createAgent,
      shutdownAll: vi.fn(async () => {}),
    };

    const reg = new RuntimeRegistry();
    reg.register(runtime as any);
    await shutdownAll();
    initAgentManager(reg, loadMemberPromptSource);
  });

  it.each(["room:room1", "dm:mem_developer", "mm:mem_developer-mem_qa"])("assembles the same global member assets from %s", async scope => {
    const { updateMember } = await import("../../src/member/identity.js");
    const { resolveGlobalSkillPaths } = await import("../../src/member/skills.js");
    const { mainSessionDirectory } = await import("../../src/files/layout.js");
    updateMember("mem_developer", { global: { skills: ["assembly-fixture"], mcpServers: ["fixture"], thinkingLevel: "high" } });
    const instance = await buildMemberAgentSession("mem_developer", scope);
    expect(instance).not.toBeNull();
    const opts = mocks.createAgent.mock.calls[0][0];
    expect(opts.member).toMatchObject({ id: "mem_developer", model: "anthropic/claude-a", credentialId: "cred-a", thinkingLevel: "high", skills: ["assembly-fixture"], mcpServers: ["fixture"] });
    expect(opts.skillPaths).toEqual(resolveGlobalSkillPaths(["assembly-fixture"]));
    expect(opts.sessionDir).toBe(mainSessionDirectory("mem_developer"));
    expect(opts.cwd).toBe(join(fixture.root, "members", "mem_developer"));
  });

  it("deduplicates concurrent activateAgent calls for same room/member", async () => {
    await Promise.all([
      activateAgent("room1", "developer"),
      activateAgent("room1", "developer"),
    ]);

    expect(mocks.createAgent).toHaveBeenCalledTimes(1);
  });

  it("does not broadcast working until runtime agent_start", async () => {
    let resolvePrompt!: () => void;
    mocks.prompt.mockReturnValue(new Promise<void>((resolve) => { resolvePrompt = resolve; }));

    const activation = activateAgent("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastToRoom).not.toHaveBeenCalledWith("room1", expect.objectContaining({ type: "agent:status", status: "working" }));

    mocks.subscribeCb?.({ type: "agent_start" });
    expect(mocks.broadcastToRoom).toHaveBeenCalledWith("room1", expect.objectContaining({ type: "agent:status", status: "working" }));

    resolvePrompt();
    await activation;
  });

  it("queues activation during promptSubmitted; the queued message runs as a prompt after settlement (no steer flush)", async () => {
    let resolvePrompt!: () => void;
    mocks.prompt.mockReturnValue(new Promise<void>((resolve) => { resolvePrompt = resolve; }));

    const first = activateAgent("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 20));
    bus.postMessage("room1", "user", "@developer second message", ["developer"]);
    const second = activateAgent("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.steer).not.toHaveBeenCalled();

    // agent_start no longer flushes queued inputs via steer (steer-removal §1).
    mocks.subscribeCb?.({ type: "agent_start" });
    expect(mocks.steer).not.toHaveBeenCalled();

    // The turn settles → the queued activation drains as the next prompt.
    mocks.subscribeCb?.({ type: "agent_end" });
    resolvePrompt();
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.prompt.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not prompt again between agent_end and prompt promise settlement; queued input prompts after settle", async () => {
    let resolveFirst!: () => void;
    mocks.prompt
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveFirst = resolve; }))
      .mockImplementationOnce(async () => {
        mocks.subscribeCb?.({ type: "message_end", text: "Queued reply", stopReason: "stop" });
        mocks.subscribeCb?.({ type: "agent_end" });
      });

    const first = activateAgent("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.prompt).toHaveBeenCalledTimes(1);

    mocks.subscribeCb?.({ type: "agent_start" });
    mocks.subscribeCb?.({ type: "agent_end" });

    bus.postMessage("room1", "user", "@developer second message", ["developer"]);
    const second = activateAgent("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.steer).not.toHaveBeenCalled();

    resolveFirst();
    await Promise.all([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mocks.prompt).toHaveBeenCalledTimes(2);
  });

  it.each(["destroy", "reset"])("cancels a pending creation on %s and destroys its late handle without prompting", async (action) => {
    const manager = await import("../../src/agent/orchestrator/agent-manager.js");
    const create = mocks.createAgent.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mocks.createAgent.mockImplementationOnce(async (...args) => { await gate; return create(...args); });
    const activation = activateAgent("room1", "developer");
    await vi.waitFor(() => expect(mocks.createAgent).toHaveBeenCalledTimes(1));
    try {
      if (action === "reset") manager.resetAgentSession("room1", "mem_developer");
      else manager.destroyInstance("room1", "mem_developer");
    } finally { release(); }
    await activation;
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(manager.getAgentStatus("room1", "mem_developer")).toBe("inactive");

    bus.postMessage("room1", "user", "@developer try again", ["developer"]);
    await activateAgent("room1", "developer");
    expect(mocks.createAgent).toHaveBeenCalledTimes(2);
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.prompt.mock.calls[0][0]).toContain("try again");
  });

});
