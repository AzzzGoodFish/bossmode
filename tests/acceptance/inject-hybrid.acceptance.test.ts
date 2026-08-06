/**
 * 注入混合制 acceptance — 两轮激活链路:
 * 激活带背 log 提示 → member 用 query_room_messages 读到即清 → 下轮激活提示消失。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupConfigMock, createTestServer, closeTestServer, jsonRequest, loginAndGetToken, MOCK_MEMBER_MODEL, MOCK_MEMBER_CREDENTIAL_ID } from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";
import { mockPromptFn, resetMocks, setMockPromptFn } from "../helpers/mock-runtime.js";

vi.mock("../../src/workforce/member-store.js", () => ({
  getMemberByName: vi.fn().mockImplementation((name: string) => ({
    id: name, name, type: "agent", agent: name,
    model: "mock-model", runtime: "mock", skills: [], thinkingLevel: "off",
  })),
  loadMembers: vi.fn().mockReturnValue([]),
}));

vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: vi.fn().mockImplementation((name: string) => ({
    name, model: "mock-model", description: `Test agent ${name}`,
    systemPrompt: `You are ${name}.`, skills: [], tags: [],
  })),
  loadAgentDefinitions: vi.fn().mockReturnValue([
    { name: "pm", model: "mock-model", description: "PM agent", skills: [], tags: [] },
  ]),
}));

setupConfigMock();

describe("Acceptance: inject hybrid (two-activation chain)", () => {
  let ts: TestServer;
  let token: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
  });
  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });
  beforeEach(() => {
    resetMocks();
    vi.clearAllMocks();
  });

  it("hint on first activation → read-to-clear → no hint on second activation", async () => {
    const created = await jsonRequest(ts.port, "POST", "/api/members", { token, body: { name: "pm", agentTemplate: "pm", model: MOCK_MEMBER_MODEL, credentialId: MOCK_MEMBER_CREDENTIAL_ID } });
    const memberId = JSON.parse(created.body).member.memberId;
    const roomRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token,
      body: { name: "hybrid-room", cwd: "/tmp", members: [{ agent: "pm", name: "pm" }], promptLeaderMemberName: "pm" },
    });
    const room = JSON.parse(roomRes.body);

    // Two backlog messages, then an @pm trigger (each POST activates pm)
    const prompts: string[] = [];
    setMockPromptFn(async (msg: string) => { prompts.push(msg); });

    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "backlog one" } });
    // No @ → pm not activated by this message; second backlog
    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "backlog two" } });
    // Now the trigger
    const trig = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "@pm status?" } });
    const triggerMsg = JSON.parse(trig.body);

    // Activation is async — poll until the prompt arrives
    const waitForPrompt = async (n: number) => {
      for (let i = 0; i < 40; i++) {
        if (prompts.length >= n) return;
        await new Promise((r) => setTimeout(r, 250));
      }
    };
    await waitForPrompt(1);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("you have 2 unread messages");
    expect(prompts[0]).toContain("from_seq");
    expect(prompts[0]).toContain("@pm status?");

    // Read-to-clear: member queries the backlog (as its tool would)
    const { handleToolCallback } = await import("../../src/engine/tools.js");
    const res = await handleToolCallback("query_room_messages", room.id, "pm", { from_seq: 0, limit: 50 });
    expect(Array.isArray(res)).toBe(true);
    const roomStore = await import("../../src/workspace/room-store.js");
    const cursors = roomStore.getCursors(room.id);
    const pmMemberId = (await import("../../src/workspace/member-registry.js")).findMemberByName("pm")!.id;
    expect(cursors[pmMemberId]).toBe(triggerMsg.id); // cursor advanced past the trigger

    // Second activation: new @pm message, no backlog → NO hint
    prompts.length = 0;
    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "@pm again?" } });
    await waitForPrompt(1);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).not.toContain("unread messages");
    expect(prompts[0]).toContain("@pm again?");
  });
});
