import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";

const identity = vi.hoisted(() => ({ name: "before", id: "mem_one" }));
vi.mock("../../src/api/auth.js", () => ({ validateToken: (token: string) => token === "valid" }));
vi.mock("../../src/workspace/member-registry.js", () => ({
  findMemberByName: vi.fn((name: string) => name === identity.name ? { ...identity } : null),
}));
import { findMemberByName } from "../../src/workspace/member-registry.js";
import {
  broadcastMemberProfileChanged, broadcastToAgentSubscribers, createWebSocketServer,
  getConnectedClientCount, shutdownWebSocket,
} from "../../src/communication/ws.js";

let server: Server;
let url: string;
const sockets: WebSocket[] = [];
async function connect(token = "valid") {
  const ws = new WebSocket(`${url}?token=${token}`);
  sockets.push(ws);
  await once(ws, "open");
  return ws;
}
async function command(ws: WebSocket, data: unknown) {
  ws.send(JSON.stringify(data));
  // Ordered ping/pong is an acknowledgement that preceding commands were read.
  const ack = once(ws, "pong");
  ws.ping();
  await ack;
}
function message(ws: WebSocket) {
  return once(ws, "message").then(([data]) => JSON.parse(data.toString()));
}
const profile = () => ({ memberId: identity.id, name: identity.name, title: null });

beforeEach(async () => {
  identity.name = "before";
  vi.mocked(findMemberByName).mockClear();
  server = createServer();
  createWebSocketServer(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  shutdownWebSocket();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("global profile broadcasts and stable member subscriptions", () => {
  it("reaches all authenticated clients without any room subscription and rejects unauthorized clients", async () => {
    const first = await connect();
    const second = await connect();
    const unauthorized = await connect("invalid");
    const rejectedMessages: unknown[] = [];
    unauthorized.on("message", (data) => rejectedMessages.push(data));
    const [code] = await once(unauthorized, "close");
    expect(code).toBe(4001);
    expect(getConnectedClientCount()).toBe(2);
    const received = [message(first), message(second)];
    broadcastMemberProfileChanged(profile());
    expect(await Promise.all(received)).toEqual([
      { type: "member:profile", ...profile() }, { type: "member:profile", ...profile() },
    ]);
    expect(rejectedMessages).toEqual([]);
  });

  it.each(["room-one", "dm:mem_one", "topic:topic-one"])("binds legacy names once and routes renamed events by ID in %s", async (roomId) => {
    const ws = await connect();
    await command(ws, { type: "subscribe:agent", roomId, agent: "before" });
    expect(findMemberByName).toHaveBeenCalledTimes(1);
    identity.name = "after";
    const event = { type: "agent:event" as const, roomId, memberId: identity.id, agent: "before", event: { type: "message_end" } };
    const received = message(ws);
    broadcastToAgentSubscribers(roomId, "before", event);
    expect(await received).toEqual(event);
    expect(findMemberByName).toHaveBeenCalledTimes(1);
    // Unsubscribe using the stable ID, not the obsolete label.
    await command(ws, { type: "unsubscribe:agent", roomId, agent: "after", memberId: identity.id });
    const sentinel = message(ws);
    broadcastToAgentSubscribers(roomId, "before", event);
    broadcastMemberProfileChanged(profile());
    expect((await sentinel).type).toBe("member:profile");
  });

  it("honors explicit member IDs, isolates scopes and members, and keeps no old-name alias", async () => {
    const ws = await connect();
    await command(ws, { type: "subscribe:agent", roomId: "r", agent: "irrelevant", memberId: "mem_two" });
    identity.name = "after";
    await command(ws, { type: "subscribe:agent", roomId: "r", agent: "before" });
    const event = { type: "agent:event" as const, roomId: "r", memberId: "mem_one", agent: "after", event: {} };
    const sentinel = message(ws);
    broadcastToAgentSubscribers("r", "after", event);
    broadcastToAgentSubscribers("other-room", "after", { ...event, memberId: "mem_two" });
    broadcastMemberProfileChanged(profile());
    expect((await sentinel).type).toBe("member:profile");
    const received = message(ws);
    broadcastToAgentSubscribers("r", "unrelated-label", { ...event, memberId: "mem_two" });
    expect((await received).memberId).toBe("mem_two");
  });

  it("resolves current names for older event producers and current-name unsubscribe", async () => {
    const ws = await connect();
    await command(ws, { type: "subscribe:agent", roomId: "r", agent: "before" });
    identity.name = "after";
    const received = message(ws);
    broadcastToAgentSubscribers("r", "after", { type: "agent:event", roomId: "r", agent: "after", event: {} });
    expect((await received).agent).toBe("after");
    await command(ws, { type: "unsubscribe:agent", roomId: "r", agent: "after" });
    const sentinel = message(ws);
    broadcastToAgentSubscribers("r", "after", { type: "agent:event", roomId: "r", agent: "after", event: {} });
    broadcastMemberProfileChanged(profile());
    expect((await sentinel).type).toBe("member:profile");
  });
});
