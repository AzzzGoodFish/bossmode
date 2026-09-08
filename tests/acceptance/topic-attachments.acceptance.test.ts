/**
 * Topic attachments: persist on POST messages + first-message create, never land in the room stream.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupConfigMock, createTestServer, closeTestServer, jsonRequest, httpRequest, loginAndGetToken, MOCK_MEMBER_MODEL, MOCK_MEMBER_CREDENTIAL_ID } from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";
import { resetMocks } from "../helpers/mock-runtime.js";



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

describe("Acceptance: topic attachments", () => {
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
    return JSON.parse(res.body);
  }

  async function uploadPng(roomId: string, filename: string) {
    const res = await httpRequest({
      hostname: "127.0.0.1",
      port: ts.port,
      method: "POST",
      path: `/api/rooms/${roomId}/upload?filename=${encodeURIComponent(filename)}`,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: "fake-png-bytes",
    });
    expect(res.status).toBe(200);
    return JSON.parse(res.body) as { filename: string; originalFilename: string; size: number };
  }

  it("POST topic message persists attachments and stays out of the room stream", async () => {
    const room = await makeRoom("topic-attach-room");
    const { topic } = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics`, {
      token, body: { content: "open" },
    })).body);
    const uploaded = await uploadPng(room.id, "shot.png");

    const posted = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/messages`, {
      token,
      body: {
        content: "see pic",
        attachments: [{ storedFilename: uploaded.filename, originalFilename: uploaded.originalFilename, size: uploaded.size }],
      },
    });
    expect(posted.status).toBe(200);
    const message = JSON.parse(posted.body);
    expect(message.content).toBe("see pic");
    expect(message.attachments).toEqual([
      expect.objectContaining({
        storedFilename: uploaded.filename,
        originalFilename: "shot.png",
        previewType: "image",
      }),
    ]);

    const listed = JSON.parse((await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/topics/${topic.id}/messages?limit=20`, { token })).body);
    const hit = listed.messages.find((m: any) => m.content === "see pic");
    expect(hit?.attachments?.[0]?.originalFilename).toBe("shot.png");

    const roomMsgs = JSON.parse((await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages`, { token })).body);
    expect(roomMsgs.some((m: any) => m.content === "see pic")).toBe(false);
  });

  it("draft first message with image creates the topic and persists the attachment", async () => {
    const room = await makeRoom("topic-draft-attach");
    const uploaded = await uploadPng(room.id, "first.png");
    const res = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics`, {
      token,
      body: {
        content: "first with pic",
        attachments: [{ storedFilename: uploaded.filename, originalFilename: uploaded.originalFilename, size: uploaded.size }],
      },
    });
    expect(res.status).toBe(201);
    const { topic } = JSON.parse(res.body);
    const listed = JSON.parse((await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/topics/${topic.id}/messages?limit=20`, { token })).body);
    const first = listed.messages.find((m: any) => m.content === "first with pic");
    expect(first?.attachments?.[0]?.originalFilename).toBe("first.png");
  });

  it("missing attachment filename is 400", async () => {
    const room = await makeRoom("topic-attach-miss");
    const { topic } = JSON.parse((await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics`, {
      token, body: { content: "open" },
    })).body);
    const bad = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/topics/${topic.id}/messages`, {
      token,
      body: { content: "x", attachments: [{ storedFilename: "nope.png", originalFilename: "nope.png" }] },
    });
    expect(bad.status).toBe(400);
  });
});
