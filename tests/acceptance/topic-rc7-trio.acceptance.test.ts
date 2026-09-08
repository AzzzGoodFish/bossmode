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
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resetMocks, setMockPromptFn } from "../helpers/mock-runtime.js";



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
  let memberId: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
    const created = await jsonRequest(ts.port, "POST", "/api/members", { token, body: { name: "pm", agentTemplate: "pm", model: MOCK_MEMBER_MODEL, credentialId: MOCK_MEMBER_CREDENTIAL_ID } });
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

    const { mainSessionDirectory } = await import("../../src/workspace/member-session-paths.js");
    const { saveCurrentSession, getCurrentSession, clearCurrentSession } = await import("../../src/workspace/session-store.js");
    const archiveDir = mainSessionDirectory(memberId, `topic:${topic.id}`, new Date("2026-09-08T00:00:00Z"));
    mkdirSync(archiveDir, { recursive: true });
    const archiveFile = join(archiveDir, "preserved.jsonl");
    writeFileSync(archiveFile, '{"type":"session","id":"topic-old","timestamp":"2026-09-08T00:00:00Z"}\n');
    saveCurrentSession(memberId, `topic:${topic.id}`, { runtime: "pi-sdk", sessionId: "topic-old", sessionFile: archiveFile });
    const roomArchiveDir = mainSessionDirectory(memberId, `room:${room.id}`, new Date("2026-09-08T00:00:00Z"));
    mkdirSync(roomArchiveDir, { recursive: true });
    const roomArchiveFile = join(roomArchiveDir, "room.jsonl");
    writeFileSync(roomArchiveFile, '{"type":"session","id":"room-current","timestamp":"2026-09-08T00:00:00Z"}\n');
    saveCurrentSession(memberId, `room:${room.id}`, { runtime: "pi-sdk", sessionId: "room-current", sessionFile: roomArchiveFile });
    const siblingId = "topic-sibling";
    const siblingDir = mainSessionDirectory(memberId, `topic:${siblingId}`, new Date("2026-09-08T00:00:00Z"));
    mkdirSync(siblingDir, { recursive: true });
    const siblingFile = join(siblingDir, "sibling.jsonl");
    writeFileSync(siblingFile, '{"type":"session","id":"sibling-current","timestamp":"2026-09-08T00:00:00Z"}\n');
    saveCurrentSession(memberId, `topic:${siblingId}`, { runtime: "pi-sdk", sessionId: "sibling-current", sessionFile: siblingFile });
    const backgroundFile = join(archiveDir, "..", "..", "..", "..", "background-tasks", "2026-09-08", "task", "session.jsonl");
    mkdirSync(join(backgroundFile, ".."), { recursive: true });
    writeFileSync(backgroundFile, "background unchanged\n");

    const closed = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/close`, { token });
    expect(closed.status).toBe(200);
    expect(getCurrentSession(memberId, `topic:${topic.id}`)).toBeUndefined();
    expect(getCurrentSession(memberId, `room:${room.id}`)?.sessionId).toBe("room-current");
    expect(getCurrentSession(memberId, `topic:${siblingId}`)?.sessionId).toBe("sibling-current");
    expect(existsSync(archiveFile)).toBe(true);
    expect(existsSync(backgroundFile)).toBe(true);

    const roomMsgs = JSON.parse((await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages`, { token })).body);
    const card = roomMsgs.find((m: any) => m.type === "topic_event" && m.topic_event_meta?.action === "closed");
    expect(card).toBeTruthy();
    const fyi = roomMsgs.find((m: any) => typeof m.content === "string" && /is closed/.test(m.content) && m.mentions?.includes("pm"));
    expect(fyi).toBeTruthy();
    expect(fyi.needResponse).toEqual([]);
    expect(fyi.replyTo).toEqual({ seq: card.seq, messageId: card.id });

    clearCurrentSession(memberId, `topic:${siblingId}`);
    const departedAnchor = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "departed member topic" } })).body);
    const departedTopicResult = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics`, { token, body: { anchorMessageId: departedAnchor.id, title: "Departed" } });
    expect(departedTopicResult.status).toBe(201);
    const departedTopicId = JSON.parse(departedTopicResult.body).topic.id;
    const departedDir = mainSessionDirectory(memberId, `topic:${departedTopicId}`, new Date("2026-09-08T00:00:00Z"));
    mkdirSync(departedDir, { recursive: true });
    const departedFile = join(departedDir, "departed.jsonl");
    writeFileSync(departedFile, '{"type":"session","id":"departed-current","timestamp":"2026-09-08T00:00:00Z"}\n');
    saveCurrentSession(memberId, `topic:${departedTopicId}`, { runtime: "pi-sdk", sessionId: "departed-current", sessionFile: departedFile });

    const removed = await jsonRequest(ts.port, "DELETE", `/api/rooms/${room.id}/members/${memberId}`, { token });
    expect(removed.status).toBe(200);
    expect(getCurrentSession(memberId, `room:${room.id}`)).toBeUndefined();
    expect(getCurrentSession(memberId, `topic:${departedTopicId}`)).toBeUndefined();
    expect(existsSync(roomArchiveFile)).toBe(true);
    expect(existsSync(siblingFile)).toBe(true);
    expect(existsSync(departedFile)).toBe(true);
    expect(existsSync(backgroundFile)).toBe(true);
  });

  it("returns an explicit failure when a member current reference cannot be cleaned", async () => {
    const room = await makeRoom("close-cleanup-error");
    const anchor = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, { token, body: { content: "anchor" } })).body);
    const { topic } = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics`, { token, body: { anchorMessageId: anchor.id } })).body);
    const { mainSessionDirectory } = await import("../../src/workspace/member-session-paths.js");
    const sessionDir = mainSessionDirectory(memberId, `topic:${topic.id}`, new Date("2026-09-08T00:00:00Z"));
    mkdirSync(sessionDir, { recursive: true });
    const currentPath = join(sessionDir, "..", "..", "..", "current.json");
    writeFileSync(currentPath, "not-json\n");
    const closed = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/close`, { token });
    expect(closed.status).toBe(500);
    expect(JSON.parse(closed.body)).toMatchObject({ error: "Topic closed but current-session cleanup was incomplete" });
    expect(JSON.parse(closed.body).cleanupFailures).toEqual(expect.arrayContaining([expect.objectContaining({ target: memberId })]));
    writeFileSync(currentPath, "{}\n");
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
