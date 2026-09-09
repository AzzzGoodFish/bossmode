/**
 * Acceptance Tests: Knowledge (0.8.0 — single namespace)
 *
 * Coverage:
 *   - Document CRUD via the unified /api/knowledge/* endpoints
 *   - Room creation with ruleDocs
 *   - Tree + search endpoints
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupTestWorkspace, createTestServer, closeTestServer, jsonRequest, loginAndGetToken } from "../helpers/test-server.js";
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

setupTestWorkspace();

let _c = 0;
function uid(prefix: string): string { return `${prefix}-${Date.now()}-${_c++}`; }

describe("Acceptance: Knowledge (0.8.0 single-namespace)", () => {
  let ts: TestServer;
  let token: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
  });

  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });

  describe("Document CRUD", () => {
    const docPath = `test-${Date.now()}/architecture.md`;

    it("POST /api/knowledge/entries creates a doc", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/knowledge/entries", {
        token,
        body: {
          title: "Architecture",
          content: "Layered architecture with 5 modules.",
          path: docPath,
          source: "architect",
        },
      });
      expect(res.status).toBe(200);
      const entry = JSON.parse(res.body);
      expect(entry.id).toBe(docPath);
      expect(entry.title).toBe("architecture");
      expect(entry.content).toContain("5 modules");
    });

    it("GET /api/knowledge/entries lists docs (no content)", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/knowledge/entries", { token });
      expect(res.status).toBe(200);
      const entries = JSON.parse(res.body) as Array<{ id: string; title: string }>;
      expect(entries.some((e) => e.id === docPath)).toBe(true);
    });

    it("GET /api/knowledge/entry?path=... reads full doc", async () => {
      const res = await jsonRequest(ts.port, "GET",
        `/api/knowledge/entry?path=${encodeURIComponent(docPath)}`, { token });
      expect(res.status).toBe(200);
      const entry = JSON.parse(res.body);
      expect(entry.title).toBe("architecture");
      expect(entry.content).toContain("5 modules");
    });

    it("PUT /api/knowledge/entry?path=... updates doc", async () => {
      const res = await jsonRequest(ts.port, "PUT",
        `/api/knowledge/entry?path=${encodeURIComponent(docPath)}`, {
          token,
          body: { title: "Architecture v2", content: "Updated architecture." },
        });
      expect(res.status).toBe(200);

      const getRes = await jsonRequest(ts.port, "GET",
        `/api/knowledge/entry?path=${encodeURIComponent(docPath)}`, { token });
      const entry = JSON.parse(getRes.body);
      expect(entry.title).toBe("architecture");
      expect(entry.content).toContain("Updated architecture");
    });

    it("GET /api/knowledge/tree returns the hierarchy", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/knowledge/tree", { token });
      expect(res.status).toBe(200);
      const tree = JSON.parse(res.body);
      expect(tree.kind).toBe("folder");
      expect(Array.isArray(tree.children)).toBe(true);
    });

    it("POST /api/knowledge/upload stores png and raw returns image bytes", async () => {
      const pngPath = `test-${Date.now()}/swatch.png`;
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
      const res = await jsonRequest(ts.port, "POST", "/api/knowledge/upload", {
        token,
        body: { path: pngPath, contentType: "image/png", dataBase64: png.toString("base64") },
      });
      expect(res.status).toBe(200);
      const entry = JSON.parse(res.body);
      expect(entry.id).toBe(pngPath);

      const rawRes = await fetch(`http://127.0.0.1:${ts.port}/api/knowledge/raw?path=${encodeURIComponent(pngPath)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(rawRes.status).toBe(200);
      expect(rawRes.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await rawRes.arrayBuffer()).equals(png)).toBe(true);
    });

    it("DELETE /api/knowledge/entry?path=... deletes doc", async () => {
      const res = await jsonRequest(ts.port, "DELETE",
        `/api/knowledge/entry?path=${encodeURIComponent(docPath)}`, { token });
      expect(res.status).toBe(200);

      const getRes = await jsonRequest(ts.port, "GET",
        `/api/knowledge/entry?path=${encodeURIComponent(docPath)}`, { token });
      expect(getRes.status).toBe(404);
    });
  });

  describe("Path safety", () => {
    it("rejects path traversal attempts", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/knowledge/entries", {
        token,
        body: { title: "Bad", content: "x", path: "../escape.md" },
      });
      expect(res.status).toBe(400);
    });

    it("requires path query parameter on entry endpoints", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/knowledge/entry", { token });
      expect(res.status).toBe(400);
    });
  });

  describe("Room with ruleDocs", () => {
    it("POST /api/rooms accepts ruleDocs (no knowledgeBaseId)", async () => {
      // Create a rule doc
      const rulePath = `rules-${Date.now()}.md`;
      await jsonRequest(ts.port, "POST", "/api/knowledge/entries", {
        token,
        body: { title: "Room rule", content: "Be nice.", path: rulePath, source: "user" },
      });

      const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: uid("rulesroom"), cwd: "/tmp", members: [{ agent: "pm", name: "pm" }], promptLeaderMemberName: "pm", ruleDocs: [rulePath] },
      });
      expect(res.status).toBe(200);
      const room = JSON.parse(res.body);
      expect(room.ruleDocs).toEqual([rulePath]);
      expect(room.knowledgeBaseId).toBeUndefined();
    });

    it("POST /api/rooms without ruleDocs creates a plain room", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: uid("plainroom"), cwd: "/tmp", members: [{ agent: "pm", name: "pm" }], promptLeaderMemberName: "pm" },
      });
      expect(res.status).toBe(200);
      const room = JSON.parse(res.body);
      expect(room.ruleDocs).toBeUndefined();
    });

    it("POST /api/knowledge/move cascades room.ruleDocs path updates", async () => {
      const oldPath = `rules/move-${Date.now()}.md`;
      const newPath = `rules/move-${Date.now()}-renamed.md`;

      await jsonRequest(ts.port, "POST", "/api/knowledge/entries", {
        token,
        body: { title: "Movable rule", content: "v1", path: oldPath, source: "user" },
      });

      const roomRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: uid("room-move"), cwd: "/tmp", members: [{ agent: "pm", name: "pm" }], promptLeaderMemberName: "pm", ruleDocs: [oldPath] },
      });
      expect(roomRes.status).toBe(200);
      const room = JSON.parse(roomRes.body) as { id: string; ruleDocs?: string[] };

      const moveRes = await jsonRequest(ts.port, "POST", "/api/knowledge/move", {
        token,
        body: { from: oldPath, to: newPath },
      });
      expect(moveRes.status).toBe(200);

      const updatedRoomRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}`, { token });
      expect(updatedRoomRes.status).toBe(200);
      const updatedRoom = JSON.parse(updatedRoomRes.body) as { ruleDocs?: string[] };
      expect(updatedRoom.ruleDocs).toEqual([newPath]);
    });

    it("DELETE /api/knowledge/entry cascades room.ruleDocs removal", async () => {
      const rulePath = `rules/delete-${Date.now()}.md`;

      await jsonRequest(ts.port, "POST", "/api/knowledge/entries", {
        token,
        body: { title: "Delete rule", content: "v1", path: rulePath, source: "user" },
      });

      const roomRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: uid("room-delete"), cwd: "/tmp", members: [{ agent: "pm", name: "pm" }], promptLeaderMemberName: "pm", ruleDocs: [rulePath] },
      });
      expect(roomRes.status).toBe(200);
      const room = JSON.parse(roomRes.body) as { id: string };

      const delRes = await jsonRequest(ts.port, "DELETE", `/api/knowledge/entry?path=${encodeURIComponent(rulePath)}`, { token });
      expect(delRes.status).toBe(200);

      const updatedRoomRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}`, { token });
      expect(updatedRoomRes.status).toBe(200);
      const updatedRoom = JSON.parse(updatedRoomRes.body) as { ruleDocs?: string[] };
      expect(updatedRoom.ruleDocs).toBeUndefined();
    });
  });
});
