/**
 * Topic-threads v2 sidebar acceptance (designer, 2026-08-19):
 * GET /api/chats room rows carry the topic sub-list for the sidebar:
 * - topics[] with title/status/lastMessage
 * - per-topic unreadCount/mentioned from the topic's own read cursor
 *   (member-authored topic messages badge; own messages never do;
 *   POST /api/conversations/topic:<id>/read clears it — room semantics)
 * - closed topics report status "closed"
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestWorkspace, createTestServer, closeTestServer, jsonRequest, loginAndGetToken, createMockRoom, configureMockMembersForRoom, MOCK_MEMBER_MODEL, MOCK_MEMBER_CREDENTIAL_ID } from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";
import { resetMocks, setMockPromptFn } from "../helpers/mock-runtime.js";

setupTestWorkspace();

describe("Acceptance: chats topics sub-list (sidebar v2)", () => {
  let ts: TestServer;
  let token: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
    await jsonRequest(ts.port, "POST", "/api/members", { token, body: { name: "pm", agentTemplate: "pm", model: MOCK_MEMBER_MODEL, credentialId: MOCK_MEMBER_CREDENTIAL_ID } });
  });
  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });
  beforeEach(() => {
    resetMocks();
    vi.clearAllMocks();
  });

  async function makeRoom(name: string) {
    return (await createMockRoom(ts.port, token, name, ["pm"])).id;
  }

  it("room row carries topics with unread from the topic cursor; read clears it; close flips status", async () => {
    const roomId = await makeRoom("sidebar-topics");

    // Anchor message, then a topic on it.
    const msgRes = await jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/messages`, { token, body: { content: "anchor for sidebar topic" } });
    expect(msgRes.status).toBe(200);
    const anchorId = (JSON.parse(msgRes.body) as any).id as string;
    const createRes = await jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/topics`, { token, body: { anchorMessageId: anchorId } });
    expect(createRes.status).toBe(201);
    const topic = (JSON.parse(createRes.body) as any).topic;

    // Room row carries the topic sub-list.
    let chatsRes = await jsonRequest(ts.port, "GET", "/api/chats", { token });
    expect(chatsRes.status).toBe(200);
    let roomEntry = (JSON.parse(chatsRes.body) as any).chats.find((c: any) => c.kind === "room" && c.scopeId === `room:${roomId}`);
    expect(roomEntry).toBeTruthy();
    expect(Array.isArray(roomEntry.topics)).toBe(true);
    expect(roomEntry.topics).toHaveLength(1);
    expect(roomEntry.topics[0].topicId).toBe(topic.id);
    expect(roomEntry.topics[0].status).toBe("active");
    expect(roomEntry.topics[0].unreadCount).toBe(0);

    // A member-authored topic message badges the topic (own user message must not).
    const { postMessage } = await import("../../src/communication/message-bus.js");
    postMessage(`topic:${topic.id}`, "user", "user-side note never badges", []);
    postMessage(`topic:${topic.id}`, "pm", "member reply in topic", []);
    chatsRes = await jsonRequest(ts.port, "GET", "/api/chats", { token });
    roomEntry = (JSON.parse(chatsRes.body) as any).chats.find((c: any) => c.kind === "room" && c.scopeId === `room:${roomId}`);
    expect(roomEntry.topics[0].unreadCount).toBe(1);
    expect(roomEntry.topics[0].lastMessage?.text).toContain("member reply in topic");

    // Viewing = reading: reporting the cursor clears the badge.
    const readRes = await jsonRequest(ts.port, "POST", `/api/conversations/${encodeURIComponent(`topic:${topic.id}`)}/read`, { token });
    expect(readRes.status).toBe(200);
    chatsRes = await jsonRequest(ts.port, "GET", "/api/chats", { token });
    roomEntry = (JSON.parse(chatsRes.body) as any).chats.find((c: any) => c.kind === "room" && c.scopeId === `room:${roomId}`);
    expect(roomEntry.topics[0].unreadCount).toBe(0);

    // Closing flips the sub-list status.
    const closeRes = await jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/topics/${topic.id}/close`, { token });
    expect(closeRes.status).toBe(200);
    chatsRes = await jsonRequest(ts.port, "GET", "/api/chats", { token });
    roomEntry = (JSON.parse(chatsRes.body) as any).chats.find((c: any) => c.kind === "room" && c.scopeId === `room:${roomId}`);
    expect(roomEntry.topics[0].status).toBe("closed");
  });

  it("anyWorking is true while a topic instance is working", async () => {
    const roomId = await makeRoom("sidebar-working");
    await configureMockMembersForRoom(roomId, ["pm"]);

    const msgRes = await jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/messages`, { token, body: { content: "anchor working" } });
    const anchorId = (JSON.parse(msgRes.body) as any).id as string;
    const createRes = await jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/topics`, { token, body: { anchorMessageId: anchorId } });
    const topic = (JSON.parse(createRes.body) as any).topic;

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    setMockPromptFn(() => gate);

    const mention = await jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/topics/${topic.id}/messages`, {
      token, body: { content: "@pm please work" },
    });
    expect(mention.status).toBe(200);

    let anyWorking = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 40));
      const chatsRes = await jsonRequest(ts.port, "GET", "/api/chats", { token });
      const roomEntry = (JSON.parse(chatsRes.body) as any).chats.find((c: any) => c.kind === "room" && c.scopeId === `room:${roomId}`);
      const row = roomEntry?.topics?.find((t: any) => t.topicId === topic.id);
      if (row?.anyWorking) { anyWorking = true; break; }
    }
    release();
    expect(anyWorking).toBe(true);
  });
});
