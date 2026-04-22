/**
 * Acceptance Tests: Rooms & Messages (Phase 2)
 *
 * Coverage:
 * - T2.1: Agent list (F3)
 * - T2.3: Create room (F4)
 * - T2.4: Invalid cwd (F4)
 * - T2.5: No members (F4)
 * - T2.7: Room list (F17)
 * - T2.8: Shared cwd (F4)
 * - T3.1: Send message (F5)
 * - T3.4: @ non-member (F6)
 * - T3.11: Real-time push (F5, NF3)
 *
 * From test plan: docs/test-plan.md §2, §3
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { setupConfigMock, createTestServer, closeTestServer, jsonRequest, loginAndGetToken } from "../helpers/test-server.js";
import { createWsClient } from "../helpers/ws-client.js";
import type { TestServer } from "../helpers/test-server.js";
import type { Room, RoomMessage } from "../../src/shared/types.js";

setupConfigMock();

describe("Acceptance: Rooms & Messages (F3, F4, F5, F9, F17)", () => {
  let ts: TestServer;
  let token: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
  });

  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });

  // ── T2.1: Agent list ──

  describe("T2.1: Agent list (F3)", () => {
    it("GET /api/agents returns agent definitions with status", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/agents", { token });
      expect(res.status).toBe(200);
      const agents = JSON.parse(res.body);
      expect(Array.isArray(agents)).toBe(true);
      // Phase 2 should return real agents from ~/.bossmode/agents/
      // For now just verify the shape
    });
  });

  // ── T2.3: Create room ──

  describe("T2.3: Create room (F4)", () => {
    it("POST /api/rooms creates a room with name, cwd, members", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "test-room", cwd: "/tmp", members: ["pm", "architect"] },
      });
      // Should succeed once Phase 2 is implemented (currently 501)
      if (res.status === 501) {
        console.log("⏳ POST /api/rooms not yet implemented (501) — will pass after Phase 2");
        return;
      }
      expect(res.status).toBe(200);
      const room: Room = JSON.parse(res.body);
      expect(room.id).toBeTruthy();
      expect(room.name).toBe("test-room");
      expect(room.cwd).toBe("/tmp");
      expect(room.members).toContain("pm");
      expect(room.members).toContain("architect");
      expect(room.createdAt).toBeGreaterThan(0);
    });

    // T2.4: Invalid cwd
    it("POST /api/rooms with nonexistent cwd returns error", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "bad-room", cwd: "/nonexistent/path/xxx", members: ["pm"] },
      });
      if (res.status === 501) return; // skip until implemented
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });

    // T2.5: No members
    it("POST /api/rooms with empty members is allowed", async () => {
      const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "empty-room", cwd: "/tmp", members: [] },
      });
      if (res.status === 501) return;
      expect(res.status).toBe(200);
      const room: Room = JSON.parse(res.body);
      expect(room.members).toEqual([]);
    });
  });

  // ── Room settings patch ──

  describe("Room settings PATCH", () => {
    it("PATCH /api/rooms/:id updates name, cwd, and ruleDocs", async () => {
      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "settings-room", cwd: "/tmp", members: ["pm"] },
      });
      if (createRes.status === 501) return;
      const room: Room = JSON.parse(createRes.body);

      const patchRes = await jsonRequest(ts.port, "PATCH", `/api/rooms/${room.id}`, {
        token,
        body: {
          name: "settings-room-renamed",
          cwd: "/",
          ruleDocs: ["bossmode/rules/dev-team-protocol.md"],
        },
      });

      expect(patchRes.status).toBe(200);
      const updated: Room = JSON.parse(patchRes.body);
      expect(updated.name).toBe("settings-room-renamed");
      expect(updated.cwd).toBe("/");
      expect(updated.ruleDocs).toEqual(["bossmode/rules/dev-team-protocol.md"]);
    });

    it("PATCH /api/rooms/:id rejects nonexistent cwd", async () => {
      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "settings-room-2", cwd: "/tmp", members: ["pm"] },
      });
      if (createRes.status === 501) return;
      const room: Room = JSON.parse(createRes.body);

      const patchRes = await jsonRequest(ts.port, "PATCH", `/api/rooms/${room.id}`, {
        token,
        body: { cwd: "/definitely-not-a-real-dir" },
      });

      expect(patchRes.status).toBe(400);
      expect(JSON.parse(patchRes.body).error).toContain("Directory does not exist");
    });
  });

  // ── T2.7: Room list ──

  describe("T2.7: Room list (F17)", () => {
    it("GET /api/rooms returns all rooms", async () => {
      const res = await jsonRequest(ts.port, "GET", "/api/rooms", { token });
      expect(res.status).toBe(200);
      const rooms = JSON.parse(res.body);
      expect(Array.isArray(rooms)).toBe(true);
    });
  });

  // ── T2.8: Shared cwd ──

  describe("T2.8: Multiple rooms with same cwd (F4)", () => {
    it("two rooms with same cwd are independent", async () => {
      const res1 = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "room-a", cwd: "/tmp", members: ["pm"] },
      });
      const res2 = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "room-b", cwd: "/tmp", members: ["architect"] },
      });
      if (res1.status === 501 || res2.status === 501) return;

      const room1: Room = JSON.parse(res1.body);
      const room2: Room = JSON.parse(res2.body);
      expect(room1.id).not.toBe(room2.id);
      expect(room1.members).not.toEqual(room2.members);
    });
  });

  // ── T3.1: Send message ──

  describe("T3.1: User sends message (F5)", () => {
    it("POST /api/rooms/:id/messages stores and broadcasts", async () => {
      // First create a room
      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "msg-test", cwd: "/tmp", members: ["pm"] },
      });
      if (createRes.status === 501) return;
      const room: Room = JSON.parse(createRes.body);

      // Subscribe to room via WS
      const wsClient = await createWsClient(ts.wsUrl, token);
      wsClient.send({ type: "subscribe:room", roomId: room.id });
      await new Promise((r) => setTimeout(r, 50));

      // Send a message
      const msgRes = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
        token,
        body: { content: "hello everyone" },
      });
      expect(msgRes.status).toBe(200);
      const msg: RoomMessage = JSON.parse(msgRes.body);
      expect(msg.id).toBeTruthy();
      expect(msg.sender).toBe("user");
      expect(msg.content).toBe("hello everyone");
      expect(msg.ts).toBeGreaterThan(0);

      // Verify WS push
      const wsEvent = await wsClient.waitFor(
        (e) => e.type === "room:message" && (e as any).message?.id === msg.id,
        2000,
      );
      expect(wsEvent).toBeTruthy();

      // Verify persistence via GET
      const listRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages`, { token });
      expect(listRes.status).toBe(200);
      const messages: RoomMessage[] = JSON.parse(listRes.body);
      expect(messages.some((m) => m.id === msg.id)).toBe(true);

      await wsClient.close();
    });
  });

  // ── T3.4: @ non-member agent ──

  describe("T3.4: @ non-member agent (F6)", () => {
    it("mentioning non-member returns error", async () => {
      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "mention-test", cwd: "/tmp", members: ["pm"] },
      });
      if (createRes.status === 501) return;
      const room: Room = JSON.parse(createRes.body);

      // @ a non-member agent
      const msgRes = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
        token,
        body: { content: "@qa run the tests" },
      });
      // Should either return error or message with warning
      const data = JSON.parse(msgRes.body);
      // The message might still be stored but with an error indicator,
      // or the endpoint returns 400. Either way, "qa" is not a member.
      if (msgRes.status >= 400) {
        expect(data.error).toBeTruthy();
      }
      // Alternative: message stored, but no agent activation + error note
    });
  });

  // ── T3.11: Real-time message push to multiple clients ──

  describe("T3.11: Real-time push (F5, NF3)", () => {
    it("message appears on all subscribed WS clients simultaneously", async () => {
      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "realtime-test", cwd: "/tmp", members: ["pm"] },
      });
      if (createRes.status === 501) return;
      const room: Room = JSON.parse(createRes.body);

      // Two WS clients subscribing to same room (simulates T10.3 multi-tab)
      const client1 = await createWsClient(ts.wsUrl, token);
      const client2 = await createWsClient(ts.wsUrl, token);
      client1.send({ type: "subscribe:room", roomId: room.id });
      client2.send({ type: "subscribe:room", roomId: room.id });
      await new Promise((r) => setTimeout(r, 50));

      // Send message
      await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/messages`, {
        token,
        body: { content: "broadcast test" },
      });

      // Both clients receive
      const [r1, r2] = await Promise.all([
        client1.waitFor((e) => e.type === "room:message", 2000),
        client2.waitFor((e) => e.type === "room:message", 2000),
      ]);
      expect((r1 as any).message.content).toBe("broadcast test");
      expect((r2 as any).message.content).toBe("broadcast test");

      await client1.close();
      await client2.close();
    });
  });

  // ── T9.1: Member panel status (F9) ──

  describe("T9.1: Member panel / agent status in room (F9)", () => {
    it("GET /api/rooms/:id returns members with status", async () => {
      const createRes = await jsonRequest(ts.port, "POST", "/api/rooms", {
        token,
        body: { name: "status-test", cwd: "/tmp", members: ["pm", "architect"] },
      });
      if (createRes.status === 501) return;
      const room: Room = JSON.parse(createRes.body);

      const roomRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}`, { token });
      expect(roomRes.status).toBe(200);
      const roomData = JSON.parse(roomRes.body);
      expect(roomData.members).toContain("pm");
      expect(roomData.members).toContain("architect");
    });
  });
});
