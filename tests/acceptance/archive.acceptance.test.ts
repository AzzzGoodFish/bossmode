/**
 * Acceptance Tests: Summarize & Message Range
 *
 * Coverage:
 * - Summarize status endpoint
 * - Summarize trigger (async 202)
 * - Message range endpoint for expanding summaries
 * - Edge cases: nonexistent room, no messages to summarize
 *
 * Replaces old Archive tests (archive endpoints removed per Smart Summary PRD)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupConfigMock, createTestServer, closeTestServer, jsonRequest, loginAndGetToken } from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";
import type { Room, RoomMessage } from "../../src/shared/types.js";

// Mock pi-mono (not needed for summarize tests, but required by imports)
vi.mock("@mariozechner/pi-agent-core", () => ({
  Agent: vi.fn().mockImplementation(() => ({
    prompt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn(),
    abort: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    state: { isStreaming: false },
  })),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: vi.fn().mockReturnValue({ id: "mock-model" }),
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createCodingTools: vi.fn().mockReturnValue([]),
}));

vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: vi.fn().mockImplementation((name: string) => ({
    name,
    model: "claude-sonnet-4-20250514",
    description: `Test agent ${name}`,
    systemPrompt: `You are ${name}.`,
  })),
  loadAgentDefinitions: vi.fn().mockReturnValue([
    { name: "pm", model: "claude-sonnet-4-20250514", description: "PM" },
    { name: "architect", model: "claude-sonnet-4-20250514", description: "Architect" },
  ]),
}));

setupConfigMock();

describe("Acceptance: Summarize & Message Range", () => {
  let ts: TestServer;
  let token: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
  });

  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });

  async function createRoom(name: string, members: string[]): Promise<Room> {
    const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token,
      body: { name, cwd: "/tmp", members, promptLeaderMemberName: members[0] },
    });
    expect(res.status).toBe(200);
    return JSON.parse(res.body);
  }

  async function sendMessage(roomId: string, content: string): Promise<RoomMessage> {
    const res = await jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/messages`, {
      token,
      body: { content },
    });
    expect(res.status).toBe(200);
    return JSON.parse(res.body);
  }

  async function sendMessages(roomId: string, count: number, prefix = "msg"): Promise<RoomMessage[]> {
    const msgs: RoomMessage[] = [];
    for (let i = 0; i < count; i++) {
      msgs.push(await sendMessage(roomId, `${prefix} ${i}`));
    }
    return msgs;
  }

  // ── Summarize Status ──

  describe("Summarize status", () => {
    it("returns status with available=false when no messages to summarize", async () => {
      const room = await createRoom("status-empty", ["pm"]);
      await sendMessages(room.id, 10);

      // With keepCount=50, 10 messages < 50, nothing to summarize
      const res = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/summarize/status?keepCount=50`, { token });
      expect(res.status).toBe(200);

      const data = JSON.parse(res.body);
      expect(data.available).toBe(false);
      expect(data.toSummarize).toBe(0);
      expect(data.isSummarizing).toBe(false);
    });

    it("returns status with available=true when messages exceed keepCount", async () => {
      const room = await createRoom("status-available", ["pm"]);
      await sendMessages(room.id, 20);

      // keepCount=5, so 15 messages can be summarized
      const res = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/summarize/status?keepCount=5`, { token });
      expect(res.status).toBe(200);

      const data = JSON.parse(res.body);
      expect(data.available).toBe(true);
      expect(data.toSummarize).toBe(15);
      expect(data.toKeep).toBe(5);
    });

    it("returns 404 for nonexistent room", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/rooms/fake-id/summarize/status", { token });
      expect(res.status).toBe(404);
    });
  });

  // ── Message Range ──

  describe("Message range (for expanding summaries)", () => {
    it("returns messages in range", async () => {
      const room = await createRoom("range-test", ["pm"]);
      const msgs = await sendMessages(room.id, 10, "range");

      const from = msgs[2].id;
      const to = msgs[7].id;
      const res = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages/range?from=${from}&to=${to}`, { token });
      expect(res.status).toBe(200);

      const data: RoomMessage[] = JSON.parse(res.body);
      expect(data.length).toBe(6); // msgs 2-7 inclusive
      expect(data[0].content).toBe("range 2");
      expect(data[5].content).toBe("range 7");
    });

    it("returns 400 when from/to missing", async () => {
      const room = await createRoom("range-bad", ["pm"]);
      const res = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages/range?from=x`, { token });
      expect(res.status).toBe(400);
    });

    it("returns empty array for nonexistent message IDs", async () => {
      const room = await createRoom("range-empty", ["pm"]);
      await sendMessages(room.id, 5);

      const res = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages/range?from=msg-nonexist&to=msg-other`, { token });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });

    it("returns 404 for nonexistent room", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/rooms/fake-id/messages/range?from=a&to=b", { token });
      expect(res.status).toBe(404);
    });
  });

  // ── Summarize Trigger ──

  describe("Summarize trigger", () => {
    it("returns 404 for nonexistent room", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/rooms/fake-id/summarize", { token, body: {} });
      expect(res.status).toBe(404);
    });

    // Note: Full summarize flow requires a working runtime (agent process).
    // Integration testing of the actual summarization is done in unit tests.
  });
});
