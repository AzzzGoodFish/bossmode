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
import { setupTestWorkspace, createTestServer, closeTestServer, jsonRequest, loginAndGetToken, createMockRoom } from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";
import type { Room, RoomMessage } from "../../src/kernel/types.js";

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

setupTestWorkspace();

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
    return createMockRoom(ts.port, token, name, members);
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

  // ── Summarize removed in 0.19.0 ──

  describe("Summarize endpoints removed", () => {
    it("status route is gone", async () => {
      const room = await createRoom("status-empty", ["pm"]);
      const res = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/summarize/status?keepCount=50`, { token });
      expect(res.status).toBe(404);
    });

    it("trigger route is gone", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/rooms/fake-id/summarize", { token, body: {} });
      expect(res.status).toBe(404);
    });
  });

  // ── Message Range (removed with the summary feature) ──

  describe("Message range endpoints removed", () => {
    it("range route is gone (sole consumer was SummaryCard)", async () => {
      const room = await createRoom("range-gone", ["pm"]);
      await sendMessages(room.id, 3, "range");
      const res = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages/range?from=a&to=b`, { token });
      expect(res.status).toBe(404);
    });
  });

});

