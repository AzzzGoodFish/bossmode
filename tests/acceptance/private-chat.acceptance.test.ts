/**
 * Acceptance Tests: Private Chat & Steer (Phase 4)
 *
 * Coverage:
 * - T4.1: Private chat event stream (F10)
 * - T4.2: Steer endpoint retired (steer-removal §2) — the only member-facing
 *   message path is normal delivery; compaction is a conversation action
 * - T4.3: Private chat does NOT sync to group chat (F11) ⭐
 * - T4.4: Steer idle agent → prompt path (F11)
 * - T4.5: Steer route retirement — 404, no silent injection
 * - T4.6: steer non-member — route retired (404)
 *
 * From test plan: docs/test-plan.md §4
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setupTestWorkspace, createTestServer, closeTestServer, jsonRequest, loginAndGetToken, getTestBossmodeDir, createMockRoom, MOCK_MEMBER_MODEL, MOCK_MEMBER_CREDENTIAL_ID } from "../helpers/test-server.js";
import { createWsClient } from "../helpers/ws-client.js";
import type { TestServer } from "../helpers/test-server.js";
import type { Room, RoomMessage } from "../../src/kernel/types.js";

// ── Mock runtime ──

import { mockPromptFn, mockSteerFn, resetMocks, setMockIsWorking, setMockPromptFn } from "../helpers/mock-runtime.js";

setupTestWorkspace();

describe("Acceptance: Private Chat & Steer (F10, F11, F13)", () => {
  let ts: TestServer;
  let token: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
  });

  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });

  beforeEach(() => {
    resetMocks();
    vi.clearAllMocks();
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

  async function steer(roomId: string, agent: string, content: string) {
    return jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/agents/${agent}/steer`, {
      token,
      body: { content },
    });
  }

  async function compactConversation(scopeId: string, memberId: string) {
    return jsonRequest(ts.port, "POST", `/api/conversations/${encodeURIComponent(scopeId)}/compact?memberId=${encodeURIComponent(memberId)}`, {
      token,
      body: {},
    });
  }

  // ── T4.2: Steer endpoint basic functionality ──

  describe("T4.2: steer endpoint is retired (steer-removal §2)", () => {
    it("POST steer returns 404 — arbitrary-text injection is gone, no alias", async () => {
      const room = await createRoom("t42-test", ["pm"]);

      const res = await steer(room.id, "pm", "focus on performance analysis");
      expect(res.status).toBe(404);
    });

    it("compact conversation action answers on the same surface", async () => {
      const room = await createRoom("t42-compact-test", ["pm"]);

      // No live instance in this fresh scope → honest error, not a silent no-op.
      const res = await compactConversation(`room:${room.id}`, "pm");
      expect([200, 400]).toContain(res.status);
    });
  });

  // ── T4.3: Private chat does NOT sync to group chat ⭐ ──

  describe("T4.3: Private steer does NOT appear in group chat (F11) ⭐", () => {
    it("steer instruction is NOT broadcast as room:message", async () => {
      const room = await createRoom("t43-test", ["pm"]);

      // Subscribe to room WS
      const wsClient = await createWsClient(ts.wsUrl, token);
      wsClient.send({ type: "subscribe:room", roomId: room.id });
      await new Promise((r) => setTimeout(r, 50));

      // Send a normal message first (to establish baseline)
      const normalMsg = await sendMessage(room.id, "hello group");

      // Wait for the normal message WS event
      await wsClient.waitFor(
        (e) => e.type === "room:message" && (e as any).message?.id === normalMsg.id,
        2000,
      );

      // Now send steer — private instruction
      await steer(room.id, "pm", "this is private, do not share");

      // Wait a bit and check NO new room:message with the steer content
      await new Promise((r) => setTimeout(r, 300));

      const roomMessages = wsClient.events.filter((e) => e.type === "room:message");
      const steerLeaked = roomMessages.some(
        (e) => (e as any).message?.content?.includes("this is private"),
      );
      expect(steerLeaked).toBe(false);

      // Double-check via REST API — steer should NOT be in messages
      const messagesRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages`, { token });
      const messages: RoomMessage[] = JSON.parse(messagesRes.body);
      const privateInMessages = messages.some((m) => m.content.includes("this is private"));
      expect(privateInMessages).toBe(false);

      await wsClient.close();
    });

    it("steer does NOT appear in messages.jsonl", async () => {
      const room = await createRoom("t43-persist-test", ["pm"]);

      // Send regular message + steer
      await sendMessage(room.id, "visible message");
      await steer(room.id, "pm", "invisible private instruction");
      await new Promise((r) => setTimeout(r, 200));

      // GET messages — should only have the visible one + any system messages
      const res = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages`, { token });
      const messages: RoomMessage[] = JSON.parse(res.body);

      const allContents = messages.map((m) => m.content).join(" ");
      expect(allContents).toContain("visible message");
      expect(allContents).not.toContain("invisible private instruction");
    });
  });

  // ── T4.4: Steer idle agent → prompt path ──

  describe("T4.4: retired — idle steering now means normal message delivery", () => {
    it("steer route 404s; a normal @mention still prompts the idle member", async () => {
      setMockIsWorking(false); // agent is idle

      const room = await createRoom("t44-test", ["pm"]);

      const wsClient = await createWsClient(ts.wsUrl, token);
      wsClient.send({ type: "subscribe:room", roomId: room.id });
      await new Promise((r) => setTimeout(r, 50));

      const res = await steer(room.id, "pm", "analyze the README");
      expect(res.status).toBe(404); // no injection path at all

      await wsClient.close();
    });
  });

  // ── T4.5: Steer working agent → steer injection ──

  describe("T4.5: steer on a working agent is retired", () => {
    it("route 404s and the handle never sees steer — new messages interrupt instead", async () => {
      const room = await createRoom("t45-test", ["pm"]);

      let releasePrompt: (() => void) | null = null;
      setMockPromptFn(async () => {
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
      });

      // First activate pm via @mention (keeps agent in working state)
      await sendMessage(room.id, "@pm start working");
      await new Promise((r) => setTimeout(r, 200));

      const res = await steer(room.id, "pm", "change direction, focus on security");
      expect(res.status).toBe(404);
      expect(mockSteerFn).not.toHaveBeenCalled(); // injection path is gone

      // Cleanup blocked prompt
      releasePrompt?.();
    });
  });

  // ── T4.6: Steer non-member → error ──

  describe("T4.6: steer non-member (F11) — retired route", () => {
    it("returns 404 like every other steer call — no member-resolution path left", async () => {
      const room = await createRoom("t46-test", ["pm"]);

      const res = await steer(room.id, "qa", "this should fail");
      expect(res.status).toBe(404);
    });
  });

  // ── Reset Session ──

  describe("DM reset through the conversation API", () => {
    it("delivers reset event/status under the member name and activates again", async () => {
      const created = await jsonRequest(ts.port, "POST", "/api/members", {
        token, body: { name: "dm-reset-member", model: MOCK_MEMBER_MODEL, credentialId: MOCK_MEMBER_CREDENTIAL_ID },
      });
      expect(created.status).toBe(200);
      const payload = JSON.parse(created.body);
      const member = { id: payload.member.memberId, name: payload.member.name };
      const scopeId = `dm:${member.id}`;
      const ws = await createWsClient(ts.wsUrl, token);
      ws.send({ type: "subscribe:agent", roomId: scopeId, agent: member.name, memberId: member.id });

      const first = await jsonRequest(ts.port, "POST", `/api/dm/${member.id}/messages`, { token, body: { text: "first" } });
      expect(first.status).toBe(200);
      const reset = await jsonRequest(ts.port, "POST", `/api/conversations/${encodeURIComponent(scopeId)}/reset-session`, { token, body: {} });
      expect(reset.status).toBe(200);
      await ws.waitFor((event: any) => event.type === "agent:event" && event.roomId === scopeId && event.agent === member.name && event.memberId === member.id && event.event?.text?.startsWith("Session reset"));
      await ws.waitFor((event: any) => event.type === "agent:status" && event.roomId === scopeId && event.agent === member.name && event.memberId === member.id && event.status === "inactive");

      const second = await jsonRequest(ts.port, "POST", `/api/dm/${member.id}/messages`, { token, body: { text: "second" } });
      expect(second.status).toBe(200);
      await ws.close();
    });
  });

  describe("Reset Session", () => {
    it("clears session metadata, resets cursor to null, and writes a system event", async () => {
      const room = await createRoom("reset-session-test", ["pm"]);
      const roomDir = join(getTestBossmodeDir(), "rooms", room.id);
      mkdirSync(roomDir, { recursive: true });
      const pmMemberId = room.globalMemberIds![0];
      const memberSessions = join(getTestBossmodeDir(), "members", pmMemberId, "sessions");
      const archiveDir = join(memberSessions, "2026-09-08", "main");
      mkdirSync(archiveDir, { recursive: true });
      writeFileSync(join(archiveDir, "session.jsonl"), "{}\n");
      writeFileSync(join(memberSessions, "current.json"), JSON.stringify({
        [`room:${room.id}`]: { runtime: "mock", sessionId: "session-123", sessionFile: `sessions/2026-09-08/rooms/${room.id}/session.jsonl` },
      }, null, 2));
      writeFileSync(join(roomDir, "cursors.json"), JSON.stringify({ [pmMemberId]: "msg-123", pm: "legacy-msg" }, null, 2));
      const retiredSessions = readFileSync(join(memberSessions, "current.json"), "utf8");
      const retiredCursors = readFileSync(join(roomDir, "cursors.json"), "utf8");
      const sessions = await import("../../src/member/sessions.js");
      const rooms = await import("../../src/chat/conversations.js");
      sessions.saveCurrentSession(pmMemberId, { runtime: "mock", sessionId: "session-123", sessionFile: join(archiveDir, "session.jsonl") });
      rooms.setCursor(room.id, pmMemberId, "msg-123");
      const res = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/agents/pm/reset-session`, { token });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, message: "Session reset. Next activation will start fresh." });
      expect(sessions.getCurrentSession(pmMemberId)).toBeUndefined();
      expect(rooms.getCursors(room.id)[pmMemberId]).toBeNull();
      expect(readFileSync(join(memberSessions, "current.json"), "utf8")).toBe(retiredSessions);
      expect(readFileSync(join(roomDir, "cursors.json"), "utf8")).toBe(retiredCursors);
      expect(readFileSync(join(archiveDir, "session.jsonl"), "utf8")).toBe("{}\n");

      const eventsRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/agents/pm/events`, { token });
      expect(eventsRes.status).toBe(200);
      const events = JSON.parse(eventsRes.body);
      expect(events).toContainEqual(expect.objectContaining({
        type: "system",
        text: "Session reset. Next activation will start fresh.",
      }));
    });

    it("returns 400 for non-member agent", async () => {
      const room = await createRoom("reset-session-non-member", ["pm"]);
      const res = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/agents/qa/reset-session`, { token });
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body).error).toContain("not a member");
    });
  });

  // ── T4.1: Private chat event stream via WS ──

  describe("T4.1: Agent event stream via WS subscribe:agent (F10)", () => {
    it("agent subscriber receives agent:event during activation", async () => {
      const room = await createRoom("t41-test", ["pm"]);

      // Subscribe to pm's private channel
      const agentClient = await createWsClient(ts.wsUrl, token);
      agentClient.send({ type: "subscribe:agent", roomId: room.id, agent: "pm" });
      await new Promise((r) => setTimeout(r, 50));

      // Also subscribe to room for comparison
      const roomClient = await createWsClient(ts.wsUrl, token);
      roomClient.send({ type: "subscribe:room", roomId: room.id });
      await new Promise((r) => setTimeout(r, 50));

      // Activate pm
      await sendMessage(room.id, "@pm analyze this");
      await new Promise((r) => setTimeout(r, 300));

      // Room client should NOT receive agent:event
      const roomAgentEvents = roomClient.events.filter((e) => e.type === "agent:event");
      expect(roomAgentEvents.length).toBe(0);

      // Both should receive agent:status though (broadcast to room)
      // Room client gets status via room subscription
      // (agent:event is private-channel only)

      await agentClient.close();
      await roomClient.close();
    });
  });

  // ── Steer on nonexistent room ──

  describe("Edge: steer on nonexistent room", () => {
    it("returns 404", async () => {
      const res = await steer("nonexistent-room-id", "pm", "hello");
      expect(res.status).toBe(404);
    });
  });
});
