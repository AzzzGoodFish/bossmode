import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coreFixture } from "../helpers/core-fixture.js";
import { MockRuntime, resetMocks, setMockPromptFn, mockPromptFn } from "../helpers/mock-runtime.js";
import { MembersRepository } from "../../src/data/repositories/members.js";
import { ConversationsRepository } from "../../src/data/repositories/conversations.js";
import { RuntimeRegistry } from "../../src/agent/runtime/registry.js";
import { activateAgent, initAgentManager, shutdownAll } from "../../src/agent/orchestrator/agent-manager.js";
import { postMessage } from "../../src/communication/message-bus.js";
import { loadEventsFromDisk } from "../../src/agent/events/event-handler.js";
import { broadcastToAgentSubscribers } from "../../src/communication/ws.js";
import { writeConfig } from "../../src/config/config.js";
import { formatToolArgsFull, getSanitizedArgs } from "../../web/src/components/agent-event-utils.js";

vi.mock("../../src/communication/ws.js", () => ({
  broadcastToRoom: vi.fn(), broadcastToAgentSubscribers: vi.fn(),
}));

let fixture: ReturnType<typeof coreFixture>;
describe("user_prompt activity event", () => {
  beforeEach(() => {
    fixture = coreFixture();
    resetMocks();
    vi.mocked(broadcastToAgentSubscribers).mockClear();
    writeConfig({ auth: { username: "test", passwordHash: "fixture" }, apiKeys: {}, defaults: { host: "127.0.0.1", port: 8080 }, runtime: { sessionResume: false } });
    new MembersRepository(fixture.db).insert({ id: "mem_dev", name: "developer", agentTemplate: "developer",
      global: { model: "anthropic/claude-sonnet-4-6", credentialId: "cred-a" }, unifiedModel: true,
      unifiedExtensions: true, scopeOverrides: {}, createdAt: 1, updatedAt: 1 });
    new ConversationsRepository(fixture.db).upsertRoom({ id: "room1", name: "Room", members: ["developer"], globalMemberIds: ["mem_dev"], createdAt: 1 });
    postMessage("room1", "user", "@developer hi", ["developer"]);
    const registry = new RuntimeRegistry();
    registry.register(new MockRuntime("pi-cli"));
    initAgentManager(registry);
    setMockPromptFn(vi.fn(async () => {}));
  });
  afterEach(async () => { await shutdownAll(); fixture.close(); });

  it("emits user_prompt with the full composed payload on activate", async () => {
    await activateAgent("room1", "mem_dev");
    const promptEvents = loadEventsFromDisk("room1", "mem_dev").filter(e => e.type === "user_prompt");
    expect(promptEvents).toHaveLength(1);
    expect(promptEvents[0]).toMatchObject({ trigger: "activate", text: expect.stringContaining("@developer hi") });
    expect(promptEvents[0]).toMatchObject({ text: mockPromptFn.mock.calls[0][0] });
    await vi.waitFor(() => {
      const wsEvents = vi.mocked(broadcastToAgentSubscribers).mock.calls.map(c => c[2]?.event).filter(e => e?.type === "user_prompt");
      expect(wsEvents).toHaveLength(1);
      expect(wsEvents[0]).toEqual(promptEvents[0]);
    });
  });
});

describe("tool args full sanitize", () => {
  it("redacts sensitive keys without truncating long content", () => {
    const long = "x".repeat(500);
    const out = getSanitizedArgs({
      content: long,
      api_key: "secret-value",
      nested: { password: "p", body: "ok" },
    }) as any;
    expect(out.content).toBe(long);
    expect(out.api_key).toBe("[redacted]");
    expect(out.nested.password).toBe("[redacted]");
    expect(out.nested.body).toBe("ok");
    const json = formatToolArgsFull({ content: long, token: "t" });
    expect(json).toContain(long);
    expect(json).toContain("[redacted]");
    expect(json).not.toContain("\"t\"");
  });
});
