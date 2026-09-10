import {logger} from "../foundation/logger.js";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { WsClientCommand, WsServerEvent } from "../shared/types.js";
import { validateToken } from "../api/auth.js";
import { findMemberByName } from "../workspace/member-registry.js";

interface ClientState {
  ws: WebSocket;
  roomSubscriptions: Set<string>;
  agentSubscriptions: Set<string>; // "scopeId:memberId"; names resolve only at command time
}

const clients = new Map<WebSocket, ClientState>();

let wss: WebSocketServer | null = null;

export function createWebSocketServer(server: import("node:http").Server): WebSocketServer {
  wss = new WebSocketServer({ server });
  // ws forwards HTTP listen errors. The startup listener owns rejection/cleanup.
  wss.on("error", error => logger.error("ws","server error",{error:String(error)}));

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || "", "http://localhost");
    const token = url.searchParams.get("token");
    if (!token || !validateToken(token)) {
      ws.close(4001, "Unauthorized");
      return;
    }

    const state: ClientState = {
      ws,
      roomSubscriptions: new Set(),
      agentSubscriptions: new Set(),
    };
    clients.set(ws, state);

    ws.on("message", (data: Buffer) => {
      try {
        const cmd = JSON.parse(data.toString()) as WsClientCommand;
        handleCommand(state, cmd);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", (err) => {
      // Prevent unhandled errors from crashing the server
      clients.delete(ws);
      try { ws.terminate(); } catch {}
    });
  });

  return wss;
}

function handleCommand(client: ClientState, cmd: WsClientCommand): void {
  switch (cmd.type) {
    case "subscribe:room":
      client.roomSubscriptions.add(cmd.roomId);
      break;
    case "unsubscribe:room":
      client.roomSubscriptions.delete(cmd.roomId);
      break;
    case "subscribe:agent":
    case "unsubscribe:agent": {
      const memberId = cmd.memberId || findMemberByName(cmd.agent)?.id;
      if (!memberId) break;
      const key = `${cmd.roomId}:${memberId}`;
      if (cmd.type === "subscribe:agent") client.agentSubscriptions.add(key);
      else client.agentSubscriptions.delete(key);
      break;
    }
  }
}

export function broadcastToRoom(roomId: string, event: WsServerEvent): void {
  const payload = JSON.stringify(event);
  for (const [, state] of clients) {
    if (state.roomSubscriptions.has(roomId) && state.ws.readyState === 1) {
      try { state.ws.send(payload); } catch { clients.delete(state.ws); }
    }
  }
}

export function broadcastToAgentSubscribers(roomId: string, agent: string, event: WsServerEvent): void {
  const memberId = "memberId" in event && event.memberId
    ? event.memberId : findMemberByName(agent)?.id;
  if (!memberId) return;
  const key = `${roomId}:${memberId}`;
  const payload = JSON.stringify(event);
  for (const [, state] of clients) {
    if (state.agentSubscriptions.has(key) && state.ws.readyState === 1) {
      try { state.ws.send(payload); } catch { clients.delete(state.ws); }
    }
  }
}

/** Current identity is global, including clients without any scope subscriptions. */
export function broadcastMemberProfileChanged(profile: { memberId: string; name: string; title: string | null }): void {
  const event: WsServerEvent = { type: "member:profile", ...profile };
  const payload = JSON.stringify(event);
  for (const [, state] of clients) {
    if (state.ws.readyState === 1) {
      try { state.ws.send(payload); } catch { clients.delete(state.ws); }
    }
  }
}

export function getConnectedClientCount(): number {
  return clients.size;
}

export async function shutdownWebSocket(): Promise<void> {
  const server = wss;
  if (!server) return;
  wss = null;
  clients.clear();
  for (const ws of server.clients) ws.terminate();
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}
