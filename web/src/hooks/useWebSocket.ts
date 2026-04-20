import { useEffect, useRef, useCallback, useState } from "react";
import { getToken } from "../api/client";

export type WsEvent =
  | { type: "room:message"; roomId: string; message: any }
  | { type: "agent:status"; roomId: string; agent: string; status: string }
  | { type: "agent:event"; roomId: string; agent: string; event: unknown }
  | {
      type: "agent:context_usage";
      roomId: string;
      agent: string;
      usage: { totalTokens: number; rawMaxTokens: number; percentage: number; model: string } | null;
    };

interface UseWebSocketOptions {
  onEvent?: (event: WsEvent) => void;
}

const MAX_RETRIES = 5;
const RETRY_DELAY_MS = 3000;

export function useWebSocket({ onEvent }: UseWebSocketOptions = {}) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  // Track subscriptions so we can re-subscribe on reconnect
  const roomSubs = useRef(new Set<string>());
  const retryCount = useRef(0);
  const destroyed = useRef(false);

  const connect = useCallback(() => {
    const token = getToken();
    if (!token || destroyed.current) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}?token=${token}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setReconnecting(false);
      retryCount.current = 0;
      // Re-subscribe to all tracked rooms
      for (const roomId of roomSubs.current) {
        ws.send(JSON.stringify({ type: "subscribe:room", roomId }));
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      // Auto-reconnect
      if (!destroyed.current && retryCount.current < MAX_RETRIES) {
        retryCount.current++;
        setReconnecting(true);
        setTimeout(() => {
          if (!destroyed.current) connect();
        }, RETRY_DELAY_MS);
      } else if (retryCount.current >= MAX_RETRIES) {
        setReconnecting(false);
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror, which handles reconnect
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WsEvent;
        onEventRef.current?.(data);
      } catch {
        // ignore
      }
    };
  }, []);

  useEffect(() => {
    destroyed.current = false;
    connect();
    return () => {
      destroyed.current = true;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const subscribeRoom = useCallback(
    (roomId: string) => {
      roomSubs.current.add(roomId);
      send({ type: "subscribe:room", roomId });
    },
    [send],
  );

  const unsubscribeRoom = useCallback(
    (roomId: string) => {
      roomSubs.current.delete(roomId);
      send({ type: "unsubscribe:room", roomId });
    },
    [send],
  );

  const subscribeAgent = useCallback(
    (roomId: string, agent: string) =>
      send({ type: "subscribe:agent", roomId, agent }),
    [send],
  );

  const unsubscribeAgent = useCallback(
    (roomId: string, agent: string) =>
      send({ type: "unsubscribe:agent", roomId, agent }),
    [send],
  );

  return {
    connected,
    reconnecting,
    subscribeRoom,
    unsubscribeRoom,
    subscribeAgent,
    unsubscribeAgent,
  };
}
