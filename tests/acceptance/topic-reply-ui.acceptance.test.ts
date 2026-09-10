/**
 * Topic batch-3 backend surface + user replyTo routes acceptance (designer, 2026-08-18):
 * ① user POST /rooms/:id/messages replyTo {seq} → persisted {seq,messageId}; unknown seq 404; non-number 400
 * ② topic creation posts a structured topic_event opening card (title/anchor/excerpt) to the room stream
 * ③ topic message with replyTo persists + never lands in the room stream
 * ④ DM POST replyTo same contract
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupTestWorkspace, createTestServer, closeTestServer, jsonRequest, loginAndGetToken, MOCK_MEMBER_MODEL, MOCK_MEMBER_CREDENTIAL_ID } from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";
import { resetMocks } from "../helpers/mock-runtime.js";

setupTestWorkspace();

describe("Acceptance: topic batch-3 routes + user replyTo", () => {
  let ts: TestServer;
  let token: string;
  let memberId: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
    const created = await jsonRequest(ts.port, "POST", "/api/members", { token, body: { name: "pm", model: MOCK_MEMBER_MODEL, credentialId: MOCK_MEMBER_CREDENTIAL_ID } });
    expect(created.status, created.body).toBe(200);
    memberId = JSON.parse(created.body).member.memberId;
  });
  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });
  beforeEach(() => {
    resetMocks();
    vi.clearAllMocks();
  });

  async function makeRoom(name: string) {
    const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token,
      body: { name, memberIds: [memberId], leaderMemberId: memberId },
    });
    expect(res.status).toBe(200);
    return JSON.parse(res.body);
  }
  async function postRoom(roomId: string, body: Record<string, unknown>) {
    return jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/messages`, { token, body });
  }
  async function roomMessages(roomId: string) {
    const res = await jsonRequest(ts.port, "GET", `/api/rooms/${roomId}/messages`, { token });
    return JSON.parse(res.body);
  }

  it("① user replyTo resolves seq → messageId; unknown/non-number rejected", async () => {
    const room = await makeRoom("reply-room");
    const m1 = JSON.parse((await postRoom(room.id, { content: "anchor message" })).body);
    expect(m1.seq).toBe(1);

    const ok = await postRoom(room.id, { content: "quoted reply", replyTo: { seq: 1 } });
    expect(ok.status).toBe(200);
    const okMsg = JSON.parse(ok.body);
    expect(okMsg.replyTo).toEqual({ seq: 1, messageId: m1.id });

    const missing = await postRoom(room.id, { content: "x", replyTo: { seq: 999 } });
    expect(missing.status).toBe(404);

    const bad = await postRoom(room.id, { content: "x", replyTo: { seq: "abc" } });
    expect(bad.status).toBe(400);
  });

  it("② topic creation posts a structured topic_event opening card", async () => {
    const room = await makeRoom("topic-room");
    const anchor = JSON.parse((await postRoom(room.id, { content: "the anchor message" })).body);

    const res = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics`, {
      token,
      body: { title: "card probe", anchorMessageId: anchor.id, seedMode: "fresh" },
    });
    expect(res.status).toBe(201);
    const { topic } = JSON.parse(res.body);

    const msgs = await roomMessages(room.id);
    const card = msgs.find((m: any) => m.type === "topic_event");
    expect(card).toBeTruthy();
    expect(card.topic_event_meta.action).toBe("opened");
    expect(card.topic_event_meta.topicId).toBe(topic.id);
    expect(card.topic_event_meta.title).toBe("card probe");
    expect(card.topic_event_meta.anchorSeq).toBe(anchor.seq);
    expect(card.topic_event_meta.anchorExcerpt).toContain("anchor message");
  });

  it("③ topic message with replyTo persists; never lands in room stream", async () => {
    const room = await makeRoom("topic-iso-room");
    const anchor = JSON.parse((await postRoom(room.id, { content: "anchor" })).body);
    const { topic } = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics`, {
      token, body: { title: "iso", anchorMessageId: anchor.id, seedMode: "fresh" },
    })).body);

    const first = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/messages`, {
      token, body: { content: "first inside" },
    })).body);
    const second = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/messages`, {
      token, body: { content: "second inside", replyTo: { seq: first.seq } },
    });
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body).replyTo).toEqual({ seq: first.seq, messageId: first.id });

    const roomMsgs = await roomMessages(room.id);
    expect(roomMsgs.some((m: any) => m.content === "first inside" || m.content === "second inside")).toBe(false);
  });

  it("④ DM POST replyTo same contract", async () => {
    const members = await jsonRequest(ts.port, "GET", "/api/members", { token });
    const pm = JSON.parse(members.body).members.find((m: any) => m.name === "pm");
    const first = JSON.parse((await jsonRequest(ts.port, "POST", `/api/dm/${pm.id}/messages`, { token, body: { text: "dm anchor" } })).body).message;
    const res = await jsonRequest(ts.port, "POST", `/api/dm/${pm.id}/messages`, { token, body: { text: "dm quoted", replyTo: { seq: first.seq } } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).message.replyTo).toEqual({ seq: first.seq, messageId: first.id });

    const missing = await jsonRequest(ts.port, "POST", `/api/dm/${pm.id}/messages`, { token, body: { text: "x", replyTo: { seq: 999 } } });
    expect(missing.status).toBe(404);
  });

  it("⑤ composer create: no title, content is first topic message, seedMode fork", async () => {
    const room = await makeRoom("composer-room");
    const res = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics`, {
      token,
      body: { content: "@pm please own this thread" },
    });
    expect(res.status).toBe(201);
    const { topic } = JSON.parse(res.body);
    expect(topic.title).toBe("please own this thread");
    expect(topic.seedMode).toBe("fork");
    expect(topic.anchorMessageId).toBeTruthy();

    const tmsgs = JSON.parse((await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/topics/${topic.id}/messages?limit=20`, { token })).body);
    expect(tmsgs.messages.some((m: any) => m.content === "@pm please own this thread")).toBe(true);
    expect(tmsgs.messages.find((m: any) => m.content === "@pm please own this thread").mentions).toContain("pm");

    const roomMsgs = await roomMessages(room.id);
    expect(roomMsgs.some((m: any) => m.content === "@pm please own this thread")).toBe(false);
    expect(roomMsgs.some((m: any) => m.type === "topic_event")).toBe(true);
  });
});
