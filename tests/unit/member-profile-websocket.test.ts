import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";

vi.mock("../../src/api/auth.js", () => ({ validateToken: (token: string) => token === "valid" }));
import {
  broadcastMemberProfileChanged, broadcastToAgentSubscribers, createWebSocketServer,
  shutdownWebSocket,
} from "../../src/app/ws.js";

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
  const ack = once(ws, "pong");
  ws.ping();
  await ack;
}
function message(ws: WebSocket) {
  return once(ws, "message").then(([data]) => JSON.parse(data.toString()));
}
const profile = () => ({ memberId: "mem_one", name: "current", title: null });

beforeEach(async () => {
  server = createServer();
  createWebSocketServer(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await shutdownWebSocket();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("global profile broadcasts and stable member subscriptions", () => {
  it("reaches every authenticated client without a room subscription and rejects unauthorized clients", async () => {
    const first = await connect();
    const second = await connect();
    const unauthorized = await connect("invalid");
    const rejectedMessages: unknown[] = [];
    unauthorized.on("message", (data) => rejectedMessages.push(data));
    const [code] = await once(unauthorized, "close");
    expect(code).toBe(4001);

    const received = [message(first), message(second)];
    broadcastMemberProfileChanged(profile());
    expect(await Promise.all(received)).toEqual([
      { type: "member:profile", ...profile() }, { type: "member:profile", ...profile() },
    ]);
    expect(rejectedMessages).toEqual([]);
  });

  it.each(["room:rm_one", "dm:mem_one", "mm:mem_one-mem_two"])("routes agent events by stable member ID in %s", async (roomId) => {
    const ws = await connect();
    await command(ws, { type: "subscribe:agent", roomId, memberId: "mem_one" });
    const event = { type: "agent:event" as const, roomId, memberId: "mem_one", agent: "renamed", event: { type: "message_end" } };
    const received = message(ws);
    broadcastToAgentSubscribers(roomId, event);
    expect(await received).toEqual(event);

    await command(ws, { type: "unsubscribe:agent", roomId, memberId: "mem_one" });
    const sentinel = message(ws);
    broadcastToAgentSubscribers(roomId, event);
    broadcastMemberProfileChanged(profile());
    expect((await sentinel).type).toBe("member:profile");
  });

  it("isolates source/member subscription pairs and ignores commands without a member ID", async () => {
    const ws = await connect();
    await command(ws, { type: "subscribe:agent", roomId: "room:r", memberId: "mem_two" });
    await command(ws, { type: "subscribe:agent", roomId: "room:r", agent: "obsolete-name" });

    const sentinel = message(ws);
    broadcastToAgentSubscribers("room:r", { type: "agent:event", roomId: "room:r", memberId: "mem_one", agent: "one", event: {} });
    broadcastToAgentSubscribers("room:other", { type: "agent:event", roomId: "room:other", memberId: "mem_two", agent: "two", event: {} });
    broadcastMemberProfileChanged(profile());
    expect((await sentinel).type).toBe("member:profile");

    const received = message(ws);
    broadcastToAgentSubscribers("room:r", { type: "agent:event", roomId: "room:r", memberId: "mem_two", agent: "renamed", event: {} });
    expect((await received).memberId).toBe("mem_two");
  });
});
