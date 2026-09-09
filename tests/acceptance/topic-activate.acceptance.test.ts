/**
 * P0 topic activation (QA 0.21.0-rc.1 FAIL):
 * fork topic + @alice inside topic must create a topic instance (not room-not-found).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import {
  setupTestWorkspace,
  createTestServer,
  closeTestServer,
  jsonRequest,
  loginAndGetToken,
  createMockRoom,
} from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";
import { resetMocks, mockPromptFn } from "../helpers/mock-runtime.js";

setupTestWorkspace();

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
    const room = await createMockRoom(ts.port, token, "p0-topic-activate", ["pm", "developer"]);

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

  it("resets and reactivates a topic through the scope conversation API", async () => {
    const room = await createMockRoom(ts.port, token, "topic-reset", ["pm"]);
    const memberId = room.globalMemberIds![0];
    const anchor = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "topic reset anchor" } })).body);
    const { topic } = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics`, {
      token, body: { title: "reset-topic", anchorMessageId: anchor.id, seedMode: "fresh" },
    })).body);
    const scopeId = `topic:${topic.id}`;
    expect((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/messages`, { token, body: { content: "@pm first" } })).status).toBe(200);
    const reset = await jsonRequest(ts.port, "POST", `/api/conversations/${encodeURIComponent(scopeId)}/reset-session?memberId=${encodeURIComponent(memberId)}`, { token, body: {} });
    expect(reset.status).toBe(200);
    expect(JSON.parse(reset.body).scopeId).toBe(scopeId);
    expect((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/messages`, { token, body: { content: "@pm second" } })).status).toBe(200);
  });

  it("topic activate prompt includes trigger body and reply quote", async () => {
    const room = await createMockRoom(ts.port, token, "p1-topic-envelope", ["pm", "developer"]);

    const anchor = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
      token, body: { content: "anchor" },
    })).body);
    const { topic } = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics`, {
      token, body: { title: "env", anchorMessageId: anchor.id, seedMode: "fresh" },
    })).body);

    const first = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/messages`, {
      token, body: { content: "original body here" },
    })).body);
    mockPromptFn.mockClear();
    const quoted = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/messages`, {
      token, body: { content: "@pm look at this quote", replyTo: { seq: first.seq } },
    });
    expect(quoted.status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));

    const prompt = String(mockPromptFn.mock.calls.at(-1)?.[0] ?? "");
    expect(prompt).toContain("look at this quote");
    expect(prompt).toMatch(/In reply to msg:#/i);
    expect(prompt).toContain("original body here");
  });
});
