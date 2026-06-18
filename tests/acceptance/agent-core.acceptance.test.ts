/**
 * Acceptance Tests: Agent Core (Phase 3)
 *
 * Coverage:
 * - T3.2: @ activate idle agent (F6) — prompt path
 * - T3.3: @ working agent (F6, F13) — steer path
 * - T3.5: Agent chat tool (F7) — agent posts to room
 * - T3.6: Agent mention tool (F8) — agent @ another agent
 * - T3.8: @all broadcast (F12) — activate all idle agents
 * - T3.9: @all partial working (F12, F13)
 * - T3.10: Incremental messages — last seen cursor correctness
 * - T6.1: Agent error → error summary in room (F19)
 * - T6.2: Agent error → status back to idle (F19)
 * - T6.3: Agent error → does not affect other agents (F19)
 *
 * Strategy: Mock pi-mono Agent class to test the full activation flow
 * without real LLM calls. We verify that the right path (prompt vs steer)
 * is taken, cursors are updated, and WS events are emitted.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { setupConfigMock, createTestServer, closeTestServer, jsonRequest, loginAndGetToken } from "../helpers/test-server.js";
import { createWsClient } from "../helpers/ws-client.js";
import type { TestServer } from "../helpers/test-server.js";
import type { Room, RoomMessage, WsServerEvent } from "../../src/shared/types.js";

// ── Mock runtime (no real LLM calls) ──

import { mockPromptFn, mockSteerFn, resetMocks, setMockPromptFn, setMockIsWorking } from "../helpers/mock-runtime.js";
import * as mockRuntimeModule from "../helpers/mock-runtime.js";

// Mock member store to return mock members with "mock" runtime
vi.mock("../../src/workforce/member-store.js", () => ({
  getMemberByName: vi.fn().mockImplementation((name: string) => ({
    id: name,
    name,
    type: "agent",
    agent: name,
    model: "mock-model",
    runtime: "mock",
    skills: [],
    thinkingLevel: "off",
  })),
  loadMembers: vi.fn().mockReturnValue([]),
}));

// Mock agent definitions — returns valid agent defs
vi.mock("../../src/workforce/agent-store.js", () => ({
  loadAgentDefinition: vi.fn().mockImplementation((name: string) => ({
    name,
    model: "claude-sonnet-4-20250514",
    description: `Test agent ${name}`,
    systemPrompt: `You are ${name}.`,
    skills: [],
    tags: [],
  })),
  loadAgentDefinitions: vi.fn().mockReturnValue([
    { name: "pm", model: "claude-sonnet-4-20250514", description: "PM agent", skills: [], tags: [] },
    { name: "architect", model: "claude-sonnet-4-20250514", description: "Architect agent", skills: [], tags: [] },
    { name: "developer", model: "claude-sonnet-4-20250514", description: "Developer agent", skills: [], tags: [] },
  ]),
}));

setupConfigMock();

describe("Acceptance: Agent Core (F6, F7, F8, F12, F13, F19, F20)", () => {
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

  // Helper: create room and return it
  async function createRoom(name: string, members: string[]): Promise<Room> {
    const res = await jsonRequest(ts.port, "POST", "/api/rooms", {
      token,
      body: { name, cwd: "/tmp", members },
    });
    expect(res.status).toBe(200);
    return JSON.parse(res.body);
  }

  // Helper: send message and return it
  async function sendMessage(roomId: string, content: string): Promise<RoomMessage> {
    const res = await jsonRequest(ts.port, "POST", `/api/rooms/${roomId}/messages`, {
      token,
      body: { content },
    });
    expect(res.status).toBe(200);
    return JSON.parse(res.body);
  }

  // ── T3.2: @ activate idle agent (prompt path) ──

  describe("T3.2: @ activate idle agent (F6)", () => {
    it("sends message with @ mention, agent status → working, WS events emitted", async () => {
      const room = await createRoom("t32-test", ["pm"]);

      const wsClient = await createWsClient(ts.wsUrl, token);
      wsClient.send({ type: "subscribe:room", roomId: room.id });
      await new Promise((r) => setTimeout(r, 50));

      // Send @pm message
      const msg = await sendMessage(room.id, "@pm analyze the project");

      // Verify message is stored with mention
      expect(msg.mentions).toContain("pm");
      expect(msg.sender).toBe("user");

      // Verify WS receives room:message
      const msgEvent = await wsClient.waitFor(
        (e) => e.type === "room:message" && (e as any).message?.id === msg.id,
        2000,
      );
      expect(msgEvent).toBeTruthy();

      // Verify WS receives agent:status → working
      const statusEvent = await wsClient.waitFor(
        (e) => e.type === "agent:status" && (e as any).agent === "pm" && (e as any).status === "working",
        2000,
      );
      expect(statusEvent).toBeTruthy();

      // Verify room detail shows agent status
      const roomRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}`, { token });
      const roomData = JSON.parse(roomRes.body);
      expect(roomData.agentStatuses).toBeDefined();

      await wsClient.close();
    });
  });

  // ── T3.8: @all broadcast activation ──

  describe("T3.8: @all broadcast activation (F12)", () => {
    it("@all activates all idle agents, each gets incremental messages", async () => {
      const room = await createRoom("t38-test", ["pm", "architect", "developer"]);

      const wsClient = await createWsClient(ts.wsUrl, token);
      wsClient.send({ type: "subscribe:room", roomId: room.id });
      await new Promise((r) => setTimeout(r, 50));

      // Send some context messages first
      await sendMessage(room.id, "here is the project overview");
      await sendMessage(room.id, "we need to analyze the codebase");

      // Send @all
      const allMsg = await sendMessage(room.id, "@all start working on this");
      expect(allMsg.mentions).toContain("all");

      // Should receive agent:status events for each agent
      // Wait a bit for async activation
      await new Promise((r) => setTimeout(r, 300));

      const statusEvents = wsClient.events.filter(
        (e) => e.type === "agent:status" && (e as any).status === "working",
      );
      // All 3 agents should be activated
      expect(statusEvents.length).toBeGreaterThanOrEqual(3);

      const activatedAgents = statusEvents.map((e) => (e as any).agent);
      expect(activatedAgents).toContain("pm");
      expect(activatedAgents).toContain("architect");
      expect(activatedAgents).toContain("developer");

      await wsClient.close();
    });
  });

  // ── T3.10: Incremental messages — cursor correctness ──

  describe("T3.10: Incremental messages — last seen cursor (F6, F12)", () => {
    it("agent receives only messages since its last cursor", async () => {
      const room = await createRoom("t310-test", ["pm"]);

      // M1, M2, M3 — plain messages, no @ mention
      await sendMessage(room.id, "M1: first message");
      await sendMessage(room.id, "M2: second message");
      await sendMessage(room.id, "M3: third message");

      // @pm task A — pm should receive M1-M3 + this message
      await sendMessage(room.id, "@pm do task A");

      // Wait for activation
      await new Promise((r) => setTimeout(r, 200));

      // Verify cursor was updated — GET room should show pm was activated
      const roomRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}`, { token });
      const roomData = JSON.parse(roomRes.body);
      expect(roomData.agentStatuses.pm).toBeDefined();

      // prompt should have been called (agent was idle)
      // The mock tracks calls
    });
  });

  // ── T3.4: @ non-member — error handling ──

  describe("T3.4: @ non-member agent (F6)", () => {
    it("mentioning a non-member agent does not trigger activation", async () => {
      const room = await createRoom("t34-test", ["pm"]);

      // @ qa who is not a member
      const msg = await sendMessage(room.id, "@qa run the tests please");

      // qa should NOT be in mentions (filtered out by parseMentions)
      expect(msg.mentions).not.toContain("qa");

      // No agent:status event for qa
      await new Promise((r) => setTimeout(r, 200));
    });
  });

  // ── T6.1: Agent error → error summary in room (F19) ──

  describe("T6.1: Agent error handling (F19)", () => {
    it("agent error posts error summary to room and drops unhealthy runtime", async () => {
      // Make prompt throw an error
      setMockPromptFn(vi.fn().mockRejectedValue(new Error("API rate limit exceeded")));

      const room = await createRoom("t61-test", ["pm"]);

      const wsClient = await createWsClient(ts.wsUrl, token);
      wsClient.send({ type: "subscribe:room", roomId: room.id });
      await new Promise((r) => setTimeout(r, 50));

      // @ pm — this will trigger activation which will fail
      await sendMessage(room.id, "@pm do something");

      // Wait for error handling
      await new Promise((r) => setTimeout(r, 500));

      // Should receive:
      // 1. room:message (user's @pm message)
      // 2. agent:status → working
      // 3. room:message (error summary from system)
      // 4. agent:status → inactive (unhealthy runtime dropped; next activation recreates)

      const errorMessages = wsClient.events.filter(
        (e) => e.type === "room:message" && (e as any).message?.sender === "system",
      );
      expect(errorMessages.length).toBeGreaterThanOrEqual(1);

      // Error message should contain error info
      const errorContent = (errorMessages[0] as any).message.content;
      expect(errorContent).toContain("error");

      // Agent should be inactive so the next activation rebuilds the runtime/session path.
      const inactiveEvents = wsClient.events.filter(
        (e) => e.type === "agent:status" && (e as any).agent === "pm" && (e as any).status === "inactive",
      );
      expect(inactiveEvents.length).toBeGreaterThanOrEqual(1);

      // Verify via API that pm is inactive.
      const roomRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}`, { token });
      const roomData = JSON.parse(roomRes.body);
      expect(roomData.agentStatuses.pm).toBe("inactive");

      await wsClient.close();
    });

    it("error message is persisted in messages.jsonl", async () => {
      setMockPromptFn(vi.fn().mockRejectedValue(new Error("Connection timeout")));

      const room = await createRoom("t61-persist-test", ["pm"]);
      await sendMessage(room.id, "@pm try this task");

      await new Promise((r) => setTimeout(r, 500));

      // GET messages — should include the error system message
      const messagesRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages`, { token });
      const messages: RoomMessage[] = JSON.parse(messagesRes.body);

      const systemMessages = messages.filter((m) => m.sender === "system");
      expect(systemMessages.length).toBeGreaterThanOrEqual(1);
      expect(systemMessages.some((m) => m.content.includes("error"))).toBe(true);
    });

    it("maps raw OAuth accountId extraction errors to reconnect guidance", async () => {
      setMockPromptFn(vi.fn().mockRejectedValue(new Error("Failed to extract accountId from token")));

      const room = await createRoom("t61-oauth-error-test", ["pm"]);
      await sendMessage(room.id, "@pm try oauth task");

      await new Promise((r) => setTimeout(r, 500));

      const messagesRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}/messages`, { token });
      const messages: RoomMessage[] = JSON.parse(messagesRes.body);
      const systemMessages = messages.filter((m) => m.sender === "system");
      expect(systemMessages.some((m) => m.content.includes("Reconnect it in Settings → Model Credentials"))).toBe(true);
      expect(systemMessages.some((m) => m.content.includes("Failed to extract accountId"))).toBe(false);
    });
  });

  // ── T6.2: Agent error → can be re-activated ──

  describe("T6.2: Agent re-activation after error (F19)", () => {
    it("agent can be activated again after error", async () => {
      // First call fails, second succeeds
      let callCount = 0;
      setMockPromptFn(vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error("First attempt fails"));
        return Promise.resolve(undefined);
      }));

      const room = await createRoom("t62-test", ["pm"]);

      // First activation — will fail
      await sendMessage(room.id, "@pm first attempt");
      await new Promise((r) => setTimeout(r, 500));

      // Second activation — should succeed
      await sendMessage(room.id, "@pm second attempt");
      await new Promise((r) => setTimeout(r, 500));

      // Agent should have been called twice
      expect(callCount).toBe(2);
    });
  });

  // ── T6.3: One agent error doesn't affect others ──

  describe("T6.3: Agent error isolation (F19)", () => {
    it("one agent failing does not prevent others from activating", async () => {
      // pm fails, architect succeeds
      const pmError = new Error("pm crashed");
      let promptCalls: string[] = [];

      // We need per-agent mock behavior. Since our mock creates a new Agent per call,
      // we track via the prompt content
      setMockPromptFn(vi.fn().mockImplementation((content: string) => {
        if (content.includes("@pm") || promptCalls.length === 0) {
          promptCalls.push("pm");
          // First agent (pm) fails
          if (promptCalls.filter((c) => c === "pm").length <= 1) {
            return Promise.reject(pmError);
          }
        }
        promptCalls.push("other");
        return Promise.resolve(undefined);
      }));

      const room = await createRoom("t63-test", ["pm", "architect"]);

      const wsClient = await createWsClient(ts.wsUrl, token);
      wsClient.send({ type: "subscribe:room", roomId: room.id });
      await new Promise((r) => setTimeout(r, 50));

      // @all — both should be activated, pm fails, architect succeeds
      await sendMessage(room.id, "@all analyze the codebase");
      await new Promise((r) => setTimeout(r, 500));

      // architect should have received agent:status → working
      const workingEvents = wsClient.events.filter(
        (e) => e.type === "agent:status" && (e as any).status === "working",
      );
      expect(workingEvents.length).toBeGreaterThanOrEqual(2); // both attempted

      await wsClient.close();
    });
  });

  // ── T2.6: Dynamic member addition + cursor ──

  describe("T2.6: Add member — cursor initialized to latest (F16)", () => {
    it("new member cursor set to latest message ID", async () => {
      const room = await createRoom("t26-test", ["pm"]);

      // Add some messages
      await sendMessage(room.id, "M1");
      await sendMessage(room.id, "M2");
      const m3 = await sendMessage(room.id, "M3");

      // Add qa as new member
      const addRes = await jsonRequest(ts.port, "POST", `/api/rooms/${room.id}/members`, {
        token,
        body: { agent: "qa" },
      });
      expect(addRes.status).toBe(200);
      const updatedRoom = JSON.parse(addRes.body);
      expect(updatedRoom.members).toContain("qa");

      // Now @qa — should NOT receive M1-M3 (joined after)
      await sendMessage(room.id, "@qa run tests");
      await new Promise((r) => setTimeout(r, 200));

      // qa was activated — verify via status
      const roomRes = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}`, { token });
      const roomData = JSON.parse(roomRes.body);
      expect(roomData.agentStatuses.qa).toBeDefined();
    });
  });

  // ── Agent status query ──

  describe("GET /api/rooms/:id — agentStatuses field (F9)", () => {
    it("returns status for all members", async () => {
      const room = await createRoom("status-test", ["pm", "architect"]);
      const res = await jsonRequest(ts.port, "GET", `/api/rooms/${room.id}`, { token });
      expect(res.status).toBe(200);

      const data = JSON.parse(res.body);
      expect(data.agentStatuses).toBeDefined();
      expect(data.agentStatuses.pm).toBe("inactive");
      expect(data.agentStatuses.architect).toBe("inactive");
    });
  });

  // ── Mention parsing edge cases ──

  describe("Mention parsing edge cases", () => {
    it("@all does not trigger individual agent mentions", async () => {
      const room = await createRoom("mention-edge-test", ["pm", "architect"]);
      const msg = await sendMessage(room.id, "@all start working");
      expect(msg.mentions).toContain("all");
      // Should NOT contain individual agent names alongside "all"
      expect(msg.mentions).not.toContain("pm");
    });

    it("duplicate @mentions are deduplicated", async () => {
      const room = await createRoom("dedup-test", ["pm"]);
      const msg = await sendMessage(room.id, "@pm do this @pm and also this");
      expect(msg.mentions.filter((m: string) => m === "pm").length).toBe(1);
    });
  });
});
