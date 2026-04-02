import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { WsClientCommand, WsServerEvent } from "../shared/types.js";
import { validateToken } from "../api/auth.js";

interface ClientState {
  ws: WebSocket;
  roomSubscriptions: Set<string>;
  agentSubscriptions: Set<string>; // "roomId:agentName"
}

const clients = new Map<WebSocket, ClientState>();

let wss: WebSocketServer | null = null;

export function createWebSocketServer(server: import("node:http").Server): WebSocketServer {
  wss = new WebSocketServer({ server });

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
      client.agentSubscriptions.add(`${cmd.roomId}:${cmd.agent}`);
      break;
    case "unsubscribe:agent":
      client.agentSubscriptions.delete(`${cmd.roomId}:${cmd.agent}`);
      break;
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
  const key = `${roomId}:${agent}`;
  const payload = JSON.stringify(event);
  for (const [, state] of clients) {
    if (state.agentSubscriptions.has(key) && state.ws.readyState === 1) {
      try { state.ws.send(payload); } catch { clients.delete(state.ws); }
    }
  }
}

export function getConnectedClientCount(): number {
  return clients.size;
}

export function shutdownWebSocket(): void {
  if (wss) {
    for (const [ws] of clients) {
      ws.close(1001, "Server shutting down");
    }
    clients.clear();
    wss.close();
    wss = null;
  }
}
