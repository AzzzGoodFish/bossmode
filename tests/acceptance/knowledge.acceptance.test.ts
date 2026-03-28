/**
 * Acceptance Tests: Knowledge Base CRUD + Room Integration (v2 Phase 3)
 *
 * Coverage:
 * - T4.1: KB create
 * - T4.2: KB entry CRUD
 * - T4.3: Room associate KB
 * - T4.4: KB cross-room sharing
 * - T4.9: KB delete
 * - T4.10: Empty KB + room
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupConfigMock, createTestServer, closeTestServer, jsonRequest, loginAndGetToken } from "../helpers/test-server.js";
import type { TestServer } from "../helpers/test-server.js";

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
vi.mock("@mariozechner/pi-ai", () => ({ getModel: vi.fn().mockReturnValue({ id: "mock" }) }));
vi.mock("@mariozechner/pi-coding-agent", () => ({ createCodingTools: vi.fn().mockReturnValue([]) }));

setupConfigMock();

let _c = 0;
function uid(prefix: string): string { return `${prefix}-${Date.now()}-${_c++}`; }

describe("Acceptance: Knowledge Base (v2 Phase 3)", () => {
  let ts: TestServer;
  let token: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
  });

  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });

  // ── KB CRUD ──

  describe("T4.1: KB create", () => {
    it("POST /api/knowledge creates knowledge base", async () => {
      const name = uid("kb");
      const res = await jsonRequest(ts.port, "POST", "/api/knowledge", {
        token,
        body: { name, description: `KB ${name}` },
      });
      expect(res.status).toBe(200);
      const kb = JSON.parse(res.body);
      expect(kb.id).toBeTruthy();
      expect(kb.name).toBe(name);
    });

    it("GET /api/knowledge lists all KBs", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/knowledge", { token });
      expect(res.status).toBe(200);
      const kbs = JSON.parse(res.body);
      expect(Array.isArray(kbs)).toBe(true);
      expect(kbs.length).toBeGreaterThan(0);
    });
  });

  describe("T4.2: KB entry CRUD", () => {
    let kbId: string;

    it("create KB + add entry", async () => {
      // Create KB
      const kbRes = await jsonRequest(ts.port, "POST", "/api/knowledge", {
        token,
        body: { name: uid("entry-kb"), description: "For entry tests" },
      });
      kbId = JSON.parse(kbRes.body).id;

      // Add entry
      const entryRes = await jsonRequest(ts.port, "POST", `/api/knowledge/${kbId}/entries`, {
        token,
        body: { title: "Architecture", content: "Layered architecture with 5 modules.", source: "architect" },
      });
      expect(entryRes.status).toBe(200);
      const entry = JSON.parse(entryRes.body);
      expect(entry.id).toBeTruthy();
      expect(entry.title).toBe("Architecture");
      expect(entry.content).toContain("5 modules");
    });

    it("list entries", async () => {
      const res = await jsonRequest(ts.port, "GET", `/api/knowledge/${kbId}/entries`, { token });
      expect(res.status).toBe(200);
      const entries = JSON.parse(res.body);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0].title).toBe("Architecture");
    });

    it("update entry", async () => {
      // Get entry ID
      const listRes = await jsonRequest(ts.port, "GET", `/api/knowledge/${kbId}/entries`, { token });
      const entryId = JSON.parse(listRes.body)[0].id;

      const updateRes = await jsonRequest(ts.port, "PUT", `/api/knowledge/${kbId}/entries/${entryId}`, {
        token,
        body: { title: "Architecture v2", content: "Updated architecture.", source: "architect" },
      });
      expect(updateRes.status).toBe(200);

      // Verify
      const getRes = await jsonRequest(ts.port, "GET", `/api/knowledge/${kbId}/entries`, { token });
      const entries = JSON.parse(getRes.body);
      expect(entries[0].title).toBe("Architecture v2");
      expect(entries[0].content).toContain("Updated architecture");
    });

    it("delete entry", async () => {
      const listRes = await jsonRequest(ts.port, "GET", `/api/knowledge/${kbId}/entries`, { token });
      const entryId = JSON.parse(listRes.body)[0].id;

      const delRes = await jsonRequest(ts.port, "DELETE", `/api/knowledge/${kbId}/entries/${entryId}`, { token });
      expect(delRes.status).toBe(200);

      // Verify empty
      const afterRes = await jsonRequest(ts.port, "GET", `/api/knowledge/${kbId}/entries`, { token });
      expect(JSON.parse(afterRes.body).length).toBe(0);
    });
  });

  // ── Room + KB Integration ──

  describe("T4.3: Room associate KB", () => {
    it("POST /api/rooms with knowledgeBaseId associates KB", async () => {
      const kbRes = await jsonRequest(ts.port, "POST", "/api/knowledge", {
        token,
        body: { name: uid("room-kb"), description: "For room test" },
      });
      const kbId = JSON.parse(kbRes.body).id;

      const roomRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: uid("kb-room"), cwd: "/tmp", members: ["pm"], knowledgeBaseId: kbId },
      });
      expect(roomRes.status).toBe(200);
      const room = JSON.parse(roomRes.body);
      expect(room.knowledgeBaseId).toBe(kbId);
    });
  });

  describe("T4.4: KB cross-room sharing", () => {
    it("same KB linked to two rooms", async () => {
      const kbRes = await jsonRequest(ts.port, "POST", "/api/knowledge", {
        token,
        body: { name: uid("shared-kb"), description: "Shared" },
      });
      const kbId = JSON.parse(kbRes.body).id;

      // Add an entry
      await jsonRequest(ts.port, "POST", `/api/knowledge/${kbId}/entries`, {
        token,
        body: { title: "Shared fact", content: "This is shared.", source: "user" },
      });

      // Create two rooms with same KB
      const room1Res = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: uid("share-room-1"), cwd: "/tmp", members: ["pm"], knowledgeBaseId: kbId },
      });
      const room2Res = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: uid("share-room-2"), cwd: "/tmp", members: ["architect"], knowledgeBaseId: kbId },
      });

      expect(JSON.parse(room1Res.body).knowledgeBaseId).toBe(kbId);
      expect(JSON.parse(room2Res.body).knowledgeBaseId).toBe(kbId);

      // Both rooms access same entries
      const entries = JSON.parse(
        (await jsonRequest(ts.port, "GET", `/api/knowledge/${kbId}/entries`, { token })).body,
      );
      expect(entries.length).toBe(1);
      expect(entries[0].title).toBe("Shared fact");
    });
  });

  describe("T4.10: Empty KB + room", () => {
    it("room with empty KB works normally", async () => {
      const kbRes = await jsonRequest(ts.port, "POST", "/api/knowledge", {
        token,
        body: { name: uid("empty-kb"), description: "Empty" },
      });
      const kbId = JSON.parse(kbRes.body).id;

      const roomRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: uid("empty-kb-room"), cwd: "/tmp", members: ["pm"], knowledgeBaseId: kbId },
      });
      expect(roomRes.status).toBe(200);

      // Entries should be empty but no error
      const entriesRes = await jsonRequest(ts.port, "GET", `/api/knowledge/${kbId}/entries`, { token });
      expect(entriesRes.status).toBe(200);
      expect(JSON.parse(entriesRes.body).length).toBe(0);
    });
  });

  describe("T4.9: KB delete", () => {
    it("DELETE /api/knowledge/:id removes KB", async () => {
      const kbRes = await jsonRequest(ts.port, "POST", "/api/knowledge", {
        token,
        body: { name: uid("del-kb"), description: "To delete" },
      });
      const kbId = JSON.parse(kbRes.body).id;

      const delRes = await jsonRequest(ts.port, "DELETE", `/api/knowledge/${kbId}`, { token });
      expect(delRes.status).toBe(200);

      const getRes = await jsonRequest(ts.port, "GET", `/api/knowledge/${kbId}`, { token });
      expect(getRes.status).toBe(404);
    });
  });

  // ── Edge cases ──

  describe("Edge cases", () => {
    it("GET /api/knowledge/nonexistent returns 404", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/knowledge/no-such-kb", { token });
      expect(res.status).toBe(404);
    });

    it("POST entry to nonexistent KB returns 404", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/knowledge/no-such-kb/entries", {
        token,
        body: { title: "X", content: "Y", source: "user" },
      });
      expect(res.status).toBe(404);
    });
  });
});
