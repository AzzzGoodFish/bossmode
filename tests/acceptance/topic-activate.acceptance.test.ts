/**
 * P0 topic activation (QA 0.21.0-rc.1 FAIL):
 * fork topic + @alice inside topic must create a topic instance (not room-not-found).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  setupConfigMock,
  createTestServer,
  closeTestServer,
  jsonRequest,
  loginAndGetToken,
  configureMockMembersForRoom,
} from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";
import { resetMocks, mockPromptFn } from "../helpers/mock-runtime.js";

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
    { name: "pm", model: "mock-model", description: "PM", skills: [], tags: [] },
    { name: "developer", model: "mock-model", description: "Dev", skills: [], tags: [] },
  ]),
}));

setupConfigMock();

describe("Acceptance: topic @ activates topic instance (P0)", () => {
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

  it("QA four-step: room @ works, fork topic @alice creates topic instance, no room-not-found", async () => {
    const roomRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token,
      body: {
        name: "p0-topic-activate",
        cwd: "/tmp",
        members: [{ agent: "pm", name: "pm" }, { agent: "developer", name: "developer" }],
        promptLeaderMemberName: "pm",
      },
    });
    expect(roomRes.status).toBe(200);
    const room = JSON.parse(roomRes.body);
    await configureMockMembersForRoom(room.id, ["pm", "developer"]);

    const roomMention = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
      token, body: { content: "@pm room check" },
    });
    expect(roomMention.status).toBe(200);
    await new Promise((r) => setTimeout(r, 80));
    const roomCalls = mockPromptFn.mock.calls.length;
    expect(roomCalls).toBeGreaterThan(0);

    const anchor = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
      token, body: { content: "anchor for fork" },
    })).body);
    const created = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics`, {
      token, body: { title: "fork-topic", anchorMessageId: anchor.id, seedMode: "fork" },
    });
    expect(created.status).toBe(201);
    const { topic } = JSON.parse(created.body);

    const beforeTopic = mockPromptFn.mock.calls.length;
    const topicPost = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/messages`, {
      token, body: { content: "@pm CF:CHAT:x" },
    });
    expect(topicPost.status).toBe(200);
    await new Promise((r) => setTimeout(r, 120));

    const topicMsgs = JSON.parse((await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/topics/${topic.id}/messages?limit=50`, { token })).body);
    const contents = (topicMsgs.messages || topicMsgs).map((m: { content: string; sender: string }) => `${m.sender}:${m.content}`);
    expect(contents.join("\n")).not.toMatch(/room not found/i);
    expect(contents.join("\n")).not.toMatch(/no API key/i);
    expect(contents.join("\n")).not.toMatch(/Failed to create member/i);

    const topicDetail = JSON.parse((await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/topics/${topic.id}`, { token })).body);
    expect(topicDetail.topic.participants.length).toBeGreaterThan(0);

    expect(mockPromptFn.mock.calls.length).toBeGreaterThan(beforeTopic);
    const lastPrompt = String(mockPromptFn.mock.calls.at(-1)?.[0] ?? "");
    expect(lastPrompt).toMatch(/topic|REPLY EXPECTED/i);

    const roomMsgs = JSON.parse((await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages`, { token })).body);
    const leaked = roomMsgs.filter((m: { content: string }) => /CF:CHAT/.test(m.content));
    expect(leaked).toHaveLength(0);
  });
});
