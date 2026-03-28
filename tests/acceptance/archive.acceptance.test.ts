/**
 * Acceptance Tests: Archive & History (Phase 5 — Final)
 *
 * Coverage:
 * - T7.1: Manual archive trigger (F14) — keeps 50, archives rest
 * - T7.2: History query after archive (F15) — list + detail
 * - T7.3: Archive with ≤50 messages — nothing to archive
 * - T7.4: Archive summary quality (F14) — contains participant names
 * - T7.5: Multiple archives (F15) — newest first
 * - T7.6: Archive preserves messages for GET after archive
 *
 * From test plan: docs/test-plan.md §7
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupConfigMock, createTestServer, closeTestServer, jsonRequest, loginAndGetToken } from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";
import type { Room, RoomMessage } from "../../src/shared/types.js";

// Mock pi-mono (not needed for archive tests, but required by imports)
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

describe("Acceptance: Archive & History (F14, F15) — Final Phase", () => {
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
      body: { name, cwd: "/tmp", members },
    });
    expect(res.status).toBe(200);
    return JSON.parse(res.body);
  }

  async function sendMessage(roomId: string, content: string, sender = "user"): Promise<RoomMessage> {
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

  // ── T7.1: Manual archive trigger ──

  describe("T7.1: Manual archive (F14)", () => {
    it("POST archive keeps 50, archives the rest", async () => {
      const room = await createRoom("t71-test", ["pm", "architect"]);

      // Send 60 messages
      await sendMessages(room.id, 60);

      // Trigger archive
      const archiveRes = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/archive`, { token });
      expect(archiveRes.status).toBe(200);

      const archiveData = JSON.parse(archiveRes.body);
      expect(archiveData.archivedCount).toBe(10); // 60 - 50 = 10 archived
      expect(archiveData.keptCount).toBe(50);
      expect(archiveData.summary).toBeTruthy();

      // Verify remaining messages — only 50 left
      const messagesRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages?limit=200`, { token });
      const messages: RoomMessage[] = JSON.parse(messagesRes.body);
      expect(messages.length).toBe(50);

      // First remaining should be msg 10 (0-9 archived)
      expect(messages[0].content).toBe("msg 10");
      expect(messages[49].content).toBe("msg 59");
    });
  });

  // ── T7.3: Nothing to archive ──

  describe("T7.3: Archive with ≤50 messages", () => {
    it("returns nothing-to-archive when messages ≤ 50", async () => {
      const room = await createRoom("t73-test", ["pm"]);
      await sendMessages(room.id, 30);

      const res = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/archive`, { token });
      expect(res.status).toBe(200);

      const data = JSON.parse(res.body);
      expect(data.archivedCount).toBe(0);
      expect(data.message).toContain("Nothing to archive");

      // Messages unchanged
      const messagesRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages?limit=200`, { token });
      expect(JSON.parse(messagesRes.body).length).toBe(30);
    });
  });

  // ── T7.2: History query — list archives + detail ──

  describe("T7.2: History query after archive (F15)", () => {
    it("GET archives lists archive entries", async () => {
      const room = await createRoom("t72-test", ["pm"]);
      await sendMessages(room.id, 60);
      await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/archive`, { token });

      const listRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/archives`, { token });
      expect(listRes.status).toBe(200);

      const archives = JSON.parse(listRes.body);
      expect(archives.length).toBeGreaterThanOrEqual(1);
      expect(archives[0].timestamp).toBeGreaterThan(0);
      expect(archives[0].summary).toBeTruthy();
      expect(archives[0].archivedCount).toBe(10);
    });

    it("GET archives/:timestamp returns archived messages + summary", async () => {
      const room = await createRoom("t72-detail-test", ["pm"]);
      await sendMessages(room.id, 60, "history");
      await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/archive`, { token });

      // Get archive list — BUG-001 fixed: one entry per archive operation
      const listRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/archives`, { token });
      const archives = JSON.parse(listRes.body);
      expect(archives.length).toBe(1);

      const timestamp = archives[0].timestamp;

      // Get archive detail — messages + summary in same entry
      const detailRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/archives/${timestamp}`, { token });
      expect(detailRes.status).toBe(200);

      const detail = JSON.parse(detailRes.body);
      expect(detail.messages).toBeDefined();
      expect(detail.messages.length).toBe(10);
      expect(detail.messages[0].content).toBe("history 0");
      expect(detail.messages[9].content).toBe("history 9");
      expect(detail.summary).toBeDefined();
      expect(detail.summary.summary).toBeTruthy();
    });
  });

  // ── T7.4: Summary quality — contains participant names ──

  describe("T7.4: Archive summary quality (F14)", () => {
    it("summary mentions participants", async () => {
      const room = await createRoom("t74-test", ["pm", "architect"]);

      // Send 60 messages (all from "user" sender via API)
      await sendMessages(room.id, 60);

      const archiveRes = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/archive`, { token });
      const data = JSON.parse(archiveRes.body);

      // Summary should mention the sender(s)
      expect(data.summary).toBeTruthy();
      expect(data.summary.toLowerCase()).toContain("user");
      // Should contain count info
      expect(data.summary).toContain("10"); // archived count
    });
  });

  // ── T7.5: Multiple archives — newest first ──

  describe("T7.5: Multiple archives (F15)", () => {
    it("archives are listed newest first", async () => {
      const room = await createRoom("t75-test", ["pm"]);

      // First batch: 60 messages → archive
      await sendMessages(room.id, 60, "batch1");
      await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/archive`, { token });

      // Small delay to ensure different timestamps
      await new Promise((r) => setTimeout(r, 10));

      // Second batch: 60 more → archive again
      await sendMessages(room.id, 60, "batch2");
      await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/archive`, { token });

      const listRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/archives`, { token });
      const archives = JSON.parse(listRes.body);

      // BUG-001 fixed: each archive = 1 entry
      expect(archives.length).toBe(2);
      // Newest first
      expect(archives[0].timestamp).toBeGreaterThan(archives[1].timestamp);
    });
  });

  // ── Edge: archive nonexistent room ──

  describe("Edge cases", () => {
    it("POST archive on nonexistent room returns 404", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/rooms/fake-id/archive", { token });
      expect(res.status).toBe(404);
    });

    it("GET archives on nonexistent room returns 404", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/rooms/fake-id/archives", { token });
      expect(res.status).toBe(404);
    });

    it("GET archive detail with invalid timestamp returns 400", async () => {
      const room = await createRoom("edge-ts-test", ["pm"]);
      const res = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/archives/notanumber`, { token });
      expect(res.status).toBe(400);
    });
  });
});
