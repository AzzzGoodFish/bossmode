/**
 * Topic activity is scoped to the topic instance — room history must not leak in.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  setupConfigMock,
  createTestServer,
  closeTestServer,
  jsonRequest,
  loginAndGetToken,
  configureMockMembersForRoom,
  MOCK_MEMBER_MODEL,
  MOCK_MEMBER_CREDENTIAL_ID,
} from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";
import { resetMocks } from "../helpers/mock-runtime.js";

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
  ]),
}));

setupConfigMock();

describe("Acceptance: topic activity scope", () => {
  let ts: TestServer;
  let token: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
    await jsonRequest(ts.port, "POST", "/api/members", {
      token, body: { name: "pm", agentTemplate: "pm", model: MOCK_MEMBER_MODEL, credentialId: MOCK_MEMBER_CREDENTIAL_ID },
    });
  });
  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });
  beforeEach(() => {
    resetMocks();
    vi.clearAllMocks();
  });

  it("unactivated topic events are empty; after @ only topic events appear; room history stays in the room", async () => {
    const roomRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token,
      body: { name: "act-scope", cwd: "/tmp", members: [{ agent: "pm", name: "pm" }], promptLeaderMemberName: "pm" },
    });
    expect(roomRes.status).toBe(200);
    const room = JSON.parse(roomRes.body);
    await configureMockMembersForRoom(room.id, ["pm"]);

    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
      token, body: { content: "@pm room only work" },
    });
    await new Promise((r) => setTimeout(r, 80));

    const roomEvents = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/members/pm/events?limit=50`, { token });
    expect(roomEvents.status).toBe(200);
    const roomEv = JSON.parse(roomEvents.body);
    expect((roomEv.events || []).length).toBeGreaterThan(0);

    const anchor = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
      token, body: { content: "anchor for activity" },
    })).body);
    const created = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics`, {
      token, body: { anchorMessageId: anchor.id },
    });
    expect(created.status).toBe(201);
    const { topic, scopeId } = JSON.parse(created.body);

    // Same route the topic rail RECENT ACTIVITY mini-feed uses (getConversationEvents).
    const empty = await jsonRequest(ts.port, "GET", `/api/conversations/${encodeURIComponent(scopeId)}/events?member=pm&limit=50`, { token });
    expect(empty.status).toBe(200);
    expect(JSON.parse(empty.body).events || []).toEqual([]);

    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/messages`, {
      token, body: { content: "@pm topic only" },
    });
    let tEv: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 40));
      const topicEvents = await jsonRequest(ts.port, "GET", `/api/conversations/${encodeURIComponent(scopeId)}/events?member=pm&limit=50`, { token });
      expect(topicEvents.status).toBe(200);
      tEv = JSON.parse(topicEvents.body).events || [];
      if (tEv.length) break;
    }
    expect(tEv.length).toBeGreaterThan(0);
    const blob = JSON.stringify(tEv);
    expect(blob).not.toMatch(/room only work/);

    const roomAfter = JSON.parse((await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/members/pm/events?limit=80`, { token })).body);
    const roomBlob = JSON.stringify(roomAfter.events || []);
    expect(roomBlob).not.toMatch(/topic only/);
  });
});
