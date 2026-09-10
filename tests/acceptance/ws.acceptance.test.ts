/**
 * Acceptance Tests: WebSocket Connection & Subscription (Phase 1)
 *
 * Coverage: T3.11 (real-time push infra), NF3 (real-time)
 * From test plan: docs/test-plan.md §3
 *
 * Phase 1 only has WS infrastructure — subscribe/broadcast.
 * Full message flow tests will be added after Phase 2 (room + message endpoints).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import WebSocket from "ws";
import { setupTestWorkspace, createTestServer, closeTestServer, loginAndGetToken } from "../helpers/test-server.js";
import { createWsClient } from "../helpers/ws-client.js";
import type { TestServer } from "../helpers/test-server.js";
import type { WsServerEvent } from "../../src/shared/types.js";

setupTestWorkspace();

describe("Acceptance: WebSocket Infrastructure", () => {
  let ts: TestServer;
  let token: string;

  beforeAll(async () => {
    ts = await createTestServer();
    token = await loginAndGetToken(ts.port);
  });

  afterAll(async () => {
    if (ts) await closeTestServer(ts);
  });

  async function createAgentScope(name: string) {
    const registry = await import("../../src/workspace/member-registry.js");
    const rooms = await import("../../src/workspace/room-store.js");
    const member = registry.createMember({ name });
    const room = rooms.createRoom(name, undefined, [member.id], undefined, { promptLeaderMemberId: member.id });
    return { member, room };
  }

  it("connects with valid token", async () => {
    const client = await createWsClient(ts.wsUrl, token);
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    await client.close();
  });

  it("rejects connection without token", async () => {
    const ws = new WebSocket(ts.wsUrl);
    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
    });
    expect(closeCode).toBe(4001);
  });

  it("rejects connection with invalid token", async () => {
    const ws = new WebSocket(`${ts.wsUrl}?token=bad-token`);
    const closeCode = await new Promise<number>((resolve) => {
      ws.on("close", (code) => resolve(code));
    });
    expect(closeCode).toBe(4001);
  });

  it("subscribes to room channel", async () => {
    const client = await createWsClient(ts.wsUrl, token);
    // Should not throw — subscribe is accepted silently
    client.send({ type: "subscribe:room", roomId: "test-room-1" });

    // Small delay to let the server process the command
    await new Promise((r) => setTimeout(r, 50));

    // Verify by checking server state via broadcast
    // (We'll test actual broadcast delivery in Phase 2 when messages exist)
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    await client.close();
  });

  it("subscribes to agent private channel", async () => {
    const { member, room } = await createAgentScope("ws-private-member");
    const client = await createWsClient(ts.wsUrl, token);
    client.send({ type: "subscribe:agent", roomId: room.id, agent: member.name, memberId: member.id });

    await new Promise((r) => setTimeout(r, 50));
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    await client.close();
  });

  it("broadcast reaches subscribed client", async () => {
    const client = await createWsClient(ts.wsUrl, token);
    client.send({ type: "subscribe:room", roomId: "broadcast-test" });
    await new Promise((r) => setTimeout(r, 50));

    // Manually trigger a broadcast (testing the infrastructure)
    const { broadcastToRoom } = await import("../../src/communication/ws.js");
    const testEvent: WsServerEvent = {
      type: "room:message",
      roomId: "broadcast-test",
      message: { id: "msg-1", sender: "user", content: "hello", mentions: [], ts: Date.now() },
    };
    broadcastToRoom("broadcast-test", testEvent);

    const received = await client.waitFor(
      (e) => e.type === "room:message" && (e as any).message?.id === "msg-1",
      2000,
    );
    expect(received.type).toBe("room:message");
    expect((received as any).message.content).toBe("hello");
    await client.close();
  });

  it("broadcast does NOT reach unsubscribed client", async () => {
    const subscribedClient = await createWsClient(ts.wsUrl, token);
    const unsubscribedClient = await createWsClient(ts.wsUrl, token);

    subscribedClient.send({ type: "subscribe:room", roomId: "isolation-test" });
    // unsubscribedClient does NOT subscribe
    await new Promise((r) => setTimeout(r, 50));

    const { broadcastToRoom } = await import("../../src/communication/ws.js");
    broadcastToRoom("isolation-test", {
      type: "room:message",
      roomId: "isolation-test",
      message: { id: "msg-iso", sender: "user", content: "secret", mentions: [], ts: Date.now() },
    });

    // Subscribed client should receive
    const received = await subscribedClient.waitFor(
      (e) => e.type === "room:message" && (e as any).message?.id === "msg-iso",
      2000,
    );
    expect(received).toBeTruthy();

    // Unsubscribed client should NOT receive — wait briefly and check
    await new Promise((r) => setTimeout(r, 200));
    expect(unsubscribedClient.events.length).toBe(0);

    await subscribedClient.close();
    await unsubscribedClient.close();
  });

  it("agent:event reaches agent subscriber only", async () => {
    const { member, room } = await createAgentScope("ws-event-member");
    const agentClient = await createWsClient(ts.wsUrl, token);
    const roomOnlyClient = await createWsClient(ts.wsUrl, token);

    agentClient.send({ type: "subscribe:agent", roomId: room.id, agent: member.name, memberId: member.id });
    roomOnlyClient.send({ type: "subscribe:room", roomId: room.id });
    await new Promise((r) => setTimeout(r, 50));

    const { broadcastToAgentSubscribers } = await import("../../src/communication/ws.js");
    broadcastToAgentSubscribers(room.id, member.name, {
      type: "agent:event",
      roomId: room.id,
      agent: member.name,
      memberId: member.id,
      event: { text: "thinking..." },
    });

    // Agent subscriber should receive
    const received = await agentClient.waitFor(
      (e) => e.type === "agent:event",
      2000,
    );
    expect(received).toMatchObject({
      type: "agent:event", roomId: room.id, agent: member.name, memberId: member.id,
      event: { text: "thinking..." },
    });

    // Room-only subscriber should NOT receive agent:event
    await new Promise((r) => setTimeout(r, 200));
    const agentEvents = roomOnlyClient.events.filter((e) => e.type === "agent:event");
    expect(agentEvents.length).toBe(0);

    await agentClient.close();
    await roomOnlyClient.close();
  });

  it("multiple clients can connect simultaneously (T10.3 prerequisite)", async () => {
    const client1 = await createWsClient(ts.wsUrl, token);
    const client2 = await createWsClient(ts.wsUrl, token);
    const client3 = await createWsClient(ts.wsUrl, token);

    expect(client1.ws.readyState).toBe(WebSocket.OPEN);
    expect(client2.ws.readyState).toBe(WebSocket.OPEN);
    expect(client3.ws.readyState).toBe(WebSocket.OPEN);

    // All receive same broadcast
    client1.send({ type: "subscribe:room", roomId: "multi-test" });
    client2.send({ type: "subscribe:room", roomId: "multi-test" });
    client3.send({ type: "subscribe:room", roomId: "multi-test" });
    await new Promise((r) => setTimeout(r, 50));

    const { broadcastToRoom } = await import("../../src/communication/ws.js");
    broadcastToRoom("multi-test", {
      type: "room:message",
      roomId: "multi-test",
      message: { id: "msg-multi", sender: "user", content: "all", mentions: [], ts: Date.now() },
    });

    const [r1, r2, r3] = await Promise.all([
      client1.waitFor((e) => e.type === "room:message", 2000),
      client2.waitFor((e) => e.type === "room:message", 2000),
      client3.waitFor((e) => e.type === "room:message", 2000),
    ]);

    expect(r1).toBeTruthy();
    expect(r2).toBeTruthy();
    expect(r3).toBeTruthy();

    await client1.close();
    await client2.close();
    await client3.close();
  });
});
