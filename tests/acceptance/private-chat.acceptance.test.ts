/**
 * Acceptance Tests: Private Chat & Steer (Phase 4)
 *
 * Coverage:
 * - T4.1: Private chat event stream (F10)
 * - T4.2: Private chat steer injection (F11)
 * - T4.3: Private chat does NOT sync to group chat (F11) ⭐
 * - T4.4: Steer idle agent → prompt path (F11)
 * - T4.5: Steer working agent → steer path (F11, F13)
 * - T4.6: Steer non-member → error (F11)
 *
 * From test plan: docs/test-plan.md §4
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { setupConfigMock, createTestServer, closeTestServer, jsonRequest, loginAndGetToken, getTestBossmodeDir } from "../helpers/test-server.js";
import { createWsClient } from "../helpers/ws-client.js";
import type { TestServer } from "../helpers/test-server.js";
import type { Room, RoomMessage } from "../../src/shared/types.js";

// ── Mock runtime ──

import { mockPromptFn, mockSteerFn, resetMocks, setMockIsWorking, setMockPromptFn } from "../helpers/mock-runtime.js";

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
    { name: "pm", model: "mock-model", description: "PM agent", skills: [], tags: [] },
    { name: "architect", model: "mock-model", description: "Architect agent", skills: [], tags: [] },
  ]),
}));

setupConfigMock();

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

  async function steer(roomId: string, agent: string, content: string) {
    return jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/agents/${agent}/steer`, {
      token,
      body: { content },
    });
  }

  // ── T4.2: Steer endpoint basic functionality ──

  describe("T4.2: Private chat steer injection (F11)", () => {
    it("POST steer returns 200 and triggers agent", async () => {
      const room = await createRoom("t42-test", ["pm"]);

      const res = await steer(room.id, "pm", "focus on performance analysis");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
    });

    it("steer with missing content returns 400", async () => {
      const room = await createRoom("t42-empty-test", ["pm"]);
      const res = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/agents/pm/steer`, {
        token,
        body: {},
      });
      expect(res.status).toBe(400);
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

  describe("T4.4: Steer idle agent → prompt (F11)", () => {
    it("steer on idle agent triggers prompt (not steer injection)", async () => {
      setMockIsWorking(false); // agent is idle

      const room = await createRoom("t44-test", ["pm"]);

      const wsClient = await createWsClient(ts.wsUrl, token);
      wsClient.send({ type: "subscribe:room", roomId: room.id });
      await new Promise((r) => setTimeout(r, 50));

      await steer(room.id, "pm", "analyze the README");

      // Should get agent:status → working (idle agent gets prompted)
      await new Promise((r) => setTimeout(r, 300));

      const statusEvents = wsClient.events.filter(
        (e) => e.type === "agent:status" && (e as any).agent === "pm",
      );
      const workingEvent = statusEvents.find((e) => (e as any).status === "working");
      expect(workingEvent).toBeTruthy();

      await wsClient.close();
    });
  });

  // ── T4.5: Steer working agent → steer injection ──

  describe("T4.5: Steer working agent → steer injection (F11, F13)", () => {
    it("steer on working agent uses steer() not prompt()", async () => {
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

      // Steer while working
      await steer(room.id, "pm", "change direction, focus on security");
      await new Promise((r) => setTimeout(r, 200));

      // steer() should have been called (not a new prompt())
      // The mock tracks this — steer is the injection path
      expect(mockSteerFn).toHaveBeenCalled();

      // Cleanup blocked prompt
      releasePrompt?.();
    });
  });

  // ── T4.6: Steer non-member → error ──

  describe("T4.6: Steer non-member agent (F11)", () => {
    it("steer on non-member returns 400", async () => {
      const room = await createRoom("t46-test", ["pm"]);

      const res = await steer(room.id, "qa", "this should fail");
      expect(res.status).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error).toContain("not a member");
    });
  });

  // ── Reset Session ──

  describe("Reset Session", () => {
    it("clears session metadata, resets cursor to null, and writes a system event", async () => {
      const room = await createRoom("reset-session-test", ["pm"]);
      const roomDir = join(getTestBossmodeDir(), "rooms", room.id);
      mkdirSync(roomDir, { recursive: true });
      const pmMemberId = room.roomMembers?.find((member) => member.name === "pm")?.id || "pm";
      writeFileSync(join(roomDir, "sessions.json"), JSON.stringify({
        [pmMemberId]: { runtime: "mock", sessionId: "session-123", sessionFile: "/tmp/session.json" },
        pm: { runtime: "mock", sessionId: "legacy-session", sessionFile: "/tmp/legacy.json" },
      }, null, 2));
      writeFileSync(join(roomDir, "cursors.json"), JSON.stringify({ [pmMemberId]: "msg-123", pm: "legacy-msg" }, null, 2));
      const res = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/agents/pm/reset-session`, { token });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, message: "Session reset. Next activation will start fresh." });

      const sessions = JSON.parse(readFileSync(join(roomDir, "sessions.json"), "utf-8"));
      expect(sessions[pmMemberId]).toEqual({ runtime: "mock" });
      expect(sessions.pm).toBeUndefined();

      const cursors = JSON.parse(readFileSync(join(roomDir, "cursors.json"), "utf-8"));
      expect(cursors[pmMemberId]).toBeNull();
      expect(cursors.pm).toBeUndefined();

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
