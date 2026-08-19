/**
 * rc.7 trio: close FYI @ participants, member_status topic breakdown, ! stays in topic.
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
import { resetMocks, setMockPromptFn } from "../helpers/mock-runtime.js";

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

describe("Acceptance: topic rc.7 trio", () => {
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
    const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token,
      body: { name, cwd: "/tmp", members: [{ agent: "pm", name: "pm" }], promptLeaderMemberName: "pm" },
    });
    expect(res.status).toBe(200);
    const room = JSON.parse(res.body);
    await configureMockMembersForRoom(room.id, ["pm"]);
    return room;
  }

  it("close FYIs participants with reply_to on the summary card and empty needResponse", async () => {
    const room = await makeRoom("close-fyi");
    const anchor = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
      token, body: { content: "anchor" },
    })).body);
    const { topic } = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics`, {
      token, body: { anchorMessageId: anchor.id },
    })).body);
    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/messages`, {
      token, body: { content: "@pm please join" },
    });
    let participants: string[] = [];
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 40));
      const t = JSON.parse((await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/topics/${topic.id}`, { token })).body).topic;
      participants = t.participants || [];
      if (participants.length) break;
    }
    expect(participants.length).toBeGreaterThan(0);

    const closed = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/close`, { token });
    expect(closed.status).toBe(200);

    const roomMsgs = JSON.parse((await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages`, { token })).body);
    const card = roomMsgs.find((m: any) => m.type === "topic_event" && m.topic_event_meta?.action === "closed");
    expect(card).toBeTruthy();
    const fyi = roomMsgs.find((m: any) => typeof m.content === "string" && /is closed/.test(m.content) && m.mentions?.includes("pm"));
    expect(fyi).toBeTruthy();
    expect(fyi.needResponse).toEqual([]);
    expect(fyi.replyTo).toEqual({ seq: card.seq, messageId: card.id });
  });

  it("member_status shows a working topic slice", async () => {
    const room = await makeRoom("status-topics");
    const anchor = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
      token, body: { content: "anchor" },
    })).body);
    const { topic } = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics`, {
      token, body: { anchorMessageId: anchor.id },
    })).body);

    let release = () => {};
    setMockPromptFn(() => new Promise<void>((r) => { release = r; }));
    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/messages`, {
      token, body: { content: "@pm work please" },
    });
    const { getRoomMemberStatusReport } = await import("../../src/engine/agent-manager.js");
    let saw = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 40));
      const preview = getRoomMemberStatusReport(room.id, "pm");
      if (preview?.some((m) => m.topics.some((t) => t.status === "working"))) { saw = true; break; }
    }
    expect(saw).toBe(true);
    const report = getRoomMemberStatusReport(room.id, "pm");
    release();
    expect(report).toBeTruthy();
    const row = report!.find((m) => m.name === "pm");
    expect(row?.topics.some((t) => t.topicId === topic.id && t.status === "working")).toBe(true);
  });

  it("! of a member not in the topic does not abort their room instance", async () => {
    const room = await makeRoom("bang-scope");
    let releaseRoom = () => {};
    setMockPromptFn(() => new Promise<void>((r) => { releaseRoom = r; }));
    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
      token, body: { content: "@pm room work" },
    });
    const { getAgentStatus } = await import("../../src/engine/agent-manager.js");
    let roomWorking = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 40));
      if (getAgentStatus(room.id, "pm") === "working") { roomWorking = true; break; }
    }
    expect(roomWorking).toBe(true);

    const anchor = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
      token, body: { content: "anchor-bang" },
    })).body);
    const { topic } = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics`, {
      token, body: { anchorMessageId: anchor.id },
    })).body);

    await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/messages`, {
      token, body: { content: "!pm stop" },
    });
    await new Promise((r) => setTimeout(r, 60));

    expect(getAgentStatus(room.id, "pm")).toBe("working");
    const tmsgs = JSON.parse((await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/topics/${topic.id}/messages?limit=50`, { token })).body);
    const notice = (tmsgs.messages || []).some((m: any) => /not in this topic/i.test(m.content || ""));
    expect(notice).toBe(true);
    releaseRoom();
  });
});
