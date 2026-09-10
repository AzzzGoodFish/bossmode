import { coreFixture } from "../helpers/core-fixture.js";
import { getDatabase } from "../../src/storage/database.js";
import { MembersRepository } from "../../src/storage/repositories/members.js";
import { ConversationsRepository } from "../../src/storage/repositories/conversations.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as bus from "../../src/communication/message-bus.js";

type PromptOptions = { beforeDispatch?: (event: { attemptId: string; dispatchIndex: number; message: string }) => void };
function dispatch(message: string, options?: PromptOptions) {
  getDatabase().transaction(() => options?.beforeDispatch?.({ attemptId: `mock-${randomUUID()}`, dispatchIndex: 0, message }));
}
let fixture: ReturnType<typeof coreFixture>;
vi.mock("../../src/communication/message-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/communication/message-bus.js")>();
  return { ...actual, postMessage: vi.fn(actual.postMessage) };
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  broadcastToRoom: vi.fn(),
}));

let contextUsageCallCount = 0;

const mockHandle = {
  prompt: vi.fn(async (message: string, options?: PromptOptions) => { dispatch(message, options); }),
  steer: vi.fn(),
  abort: vi.fn(),
  destroy: vi.fn(),
  async destroyAndWait() { this.abort(); await this.waitForIdle(); this.destroy(); },
  waitForIdle: vi.fn(async () => {}),
  subscribe: vi.fn(() => () => {}),
  getContextUsage: vi.fn(async () => {
    contextUsageCallCount += 1;
    return { totalTokens: 1234, rawMaxTokens: 200000, percentage: 0.617, model: "sonnet" };
  }),
  isWorking: false,
  runtimeName: "pi-cli",
};

vi.mock("../../src/foundation/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToRoom: mocks.broadcastToRoom,
  broadcastToAgentSubscribers: vi.fn(),
}));

import { RuntimeRegistry } from "../../src/engine/runtime/registry.js";
import {
  activateAgent,
  destroyInstance,
  getAgentContextUsage,
  initAgentManager,
  refreshContextUsage,
  shutdownAll,
} from "../../src/engine/agent-manager.js";

beforeEach(async () => {
  fixture = coreFixture();
  (await import("../../src/shared/config.js")).writeConfig({ auth: { username: "test", passwordHash: "fixture" }, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 }, runtime: { sessionResume: false, topicSeedMode: "fresh" } });
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
  await (await import("../../src/engine/agent-manager.js")).shutdownAll();
  fixture.close();
});

describe("agent-manager context usage cache", () => {
  beforeEach(async () => {
    contextUsageCallCount = 0;
    mockHandle.prompt.mockClear();
    mockHandle.getContextUsage.mockClear();
    mockHandle.subscribe.mockReturnValue(() => {});
    mocks.broadcastToRoom.mockReset();

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
      createAgent: vi.fn(async () => mockHandle),
      shutdownAll: vi.fn(async () => {}),
    };

    const reg = new RuntimeRegistry();
    reg.register(runtime as any);
    await shutdownAll();
    initAgentManager(reg);
    await activateAgent("room1", "developer");
  });

  it("refreshes cache from runtime on idle and broadcasts agent:context_usage", async () => {
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(contextUsageCallCount).toBe(1);
    expect(mocks.broadcastToRoom).toHaveBeenCalledWith("room1", {
      type: "agent:context_usage",
      roomId: "room1",
      agent: "developer",
      memberId: "mem_developer",
      usage: { totalTokens: 1234, rawMaxTokens: 200000, percentage: 0.617, model: "sonnet" },
    });
  });

  it("reads cached context usage without calling runtime again", async () => {
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));
    contextUsageCallCount = 0;

    const usage = getAgentContextUsage("room1", "developer");

    expect(usage).toEqual({ totalTokens: 1234, rawMaxTokens: 200000, percentage: 0.617, model: "sonnet" });
    expect(contextUsageCallCount).toBe(0);
  });

  it("preserves previous usage and marks compacted when SDK reports null tokens", async () => {
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));
    mocks.broadcastToRoom.mockReset();
    mockHandle.getContextUsage.mockResolvedValueOnce({ totalTokens: 0, rawMaxTokens: 200000, percentage: 0, model: "sonnet", compacted: true });

    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getAgentContextUsage("room1", "developer")).toEqual({ totalTokens: 1234, rawMaxTokens: 200000, percentage: 0.617, model: "sonnet", compacted: true });
    expect(mocks.broadcastToRoom).toHaveBeenCalledWith("room1", expect.objectContaining({
      type: "agent:context_usage",
      usage: { totalTokens: 1234, rawMaxTokens: 200000, percentage: 0.617, model: "sonnet", compacted: true },
    }));
  });

  it("accepts compacted snapshots for explicit post-compaction refresh instead of showing stale pre-compact usage", async () => {
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));
    mocks.broadcastToRoom.mockReset();
    mockHandle.getContextUsage.mockResolvedValueOnce({ totalTokens: 0, rawMaxTokens: 200000, percentage: 0, model: "sonnet", compacted: true });

    refreshContextUsage("room1", "developer", { acceptCompactedSnapshot: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getAgentContextUsage("room1", "developer")).toEqual({ totalTokens: 0, rawMaxTokens: 200000, percentage: 0, model: "sonnet", compacted: true });
    expect(mocks.broadcastToRoom).toHaveBeenCalledWith("room1", expect.objectContaining({
      type: "agent:context_usage",
      usage: { totalTokens: 0, rawMaxTokens: 200000, percentage: 0, model: "sonnet", compacted: true },
    }));
  });

  it("marks compacted on a same-session significant context drop and keeps the marker across immediate fallback refresh", async () => {
    mockHandle.getContextUsage.mockResolvedValueOnce({ totalTokens: 18017, rawMaxTokens: 1200, percentage: 1501.4, model: "sonnet" });
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));
    mocks.broadcastToRoom.mockReset();

    mockHandle.getContextUsage.mockResolvedValueOnce({ totalTokens: 82, rawMaxTokens: 1200, percentage: 6.83, model: "sonnet" });
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getAgentContextUsage("room1", "developer")).toEqual({ totalTokens: 82, rawMaxTokens: 1200, percentage: 6.83, model: "sonnet", compacted: true });

    mockHandle.getContextUsage.mockResolvedValueOnce({ totalTokens: 82, rawMaxTokens: 1200, percentage: 6.83, model: "sonnet" });
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getAgentContextUsage("room1", "developer")?.compacted).toBe(true);
  });

  it("does not mark compacted after restart/reset clears the active instance usage history", async () => {
    mockHandle.getContextUsage.mockResolvedValueOnce({ totalTokens: 18017, rawMaxTokens: 1200, percentage: 1501.4, model: "sonnet" });
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));

    destroyInstance("room1", "developer");
    await activateAgent("room1", "developer");
    mockHandle.getContextUsage.mockResolvedValueOnce({ totalTokens: 82, rawMaxTokens: 1200, percentage: 6.83, model: "sonnet" });
    refreshContextUsage("room1", "developer");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getAgentContextUsage("room1", "developer")).toEqual({ totalTokens: 82, rawMaxTokens: 1200, percentage: 6.83, model: "sonnet" });
  });
});
