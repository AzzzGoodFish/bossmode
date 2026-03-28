import { useState, useEffect, useCallback, useRef } from "react";
import type { Room, RoomMessage } from "../api/client";
import {
  getMessages,
  sendMessage as apiSendMessage,
  getRoom,
} from "../api/client";
import type { WsEvent } from "./useWebSocket";

const PAGE_SIZE = 30;

export interface AgentStatusMap {
  [agentName: string]: "inactive" | "idle" | "working";
}

export function useRoom(roomId: string | null) {
  const [room, setRoom] = useState<Room | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [agentStatus, setAgentStatus] = useState<AgentStatusMap>({});
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);

  // Load room details and initial messages (newest N)
  useEffect(() => {
    if (!roomId) {
      setRoom(null);
      setMessages([]);
      setAgentStatus({});
      setHasMore(true);
      return;
    }

    setLoading(true);

    Promise.all([getRoom(roomId), getMessages(roomId, { limit: PAGE_SIZE })])
      .then(([r, msgs]) => {
        setRoom(r);
        setMessages(msgs);
        setHasMore(msgs.length >= PAGE_SIZE);
        const status: AgentStatusMap = {};
        for (const m of r.members) status[m] = (r.agentStatuses?.[m] as AgentStatusMap[string]) || "inactive";
        setAgentStatus(status);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [roomId]);

  // Load older messages (prepend)
  const loadOlder = useCallback(async (): Promise<void> => {
    if (!roomId || loadingOlder || !hasMore || messages.length === 0) return;
    setLoadingOlder(true);
    try {
      const oldest = messages[0];
      const older = await getMessages(roomId, { limit: PAGE_SIZE, before: oldest.id });
      if (older.length < PAGE_SIZE) setHasMore(false);
      if (older.length > 0) {
        setMessages((prev) => [...older, ...prev]);
      }
    } catch (err) {
      console.error("Failed to load older messages:", err);
    } finally {
      setLoadingOlder(false);
    }
  }, [roomId, loadingOlder, hasMore, messages]);

  // Handle incoming WS events
  const handleWsEvent = useCallback(
    (event: WsEvent) => {
      if (!roomId) return;

      if (event.type === "room:message" && event.roomId === roomId) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === event.message.id)) return prev;
          return [...prev, event.message];
        });
      }

      if (event.type === "agent:status" && event.roomId === roomId) {
        setAgentStatus((prev) => ({
          ...prev,
          [event.agent]: event.status as "inactive" | "idle" | "working",
        }));
      }
    },
    [roomId],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (!roomId) return;
      const msg = await apiSendMessage(roomId, content);
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    },
    [roomId],
  );

  const reloadRoom = useCallback(async () => {
    if (!roomId) return;
    try {
      const [r, msgs] = await Promise.all([getRoom(roomId), getMessages(roomId, { limit: PAGE_SIZE })]);
      setRoom(r);
      setMessages(msgs);
      setHasMore(msgs.length >= PAGE_SIZE);
      const status: AgentStatusMap = {};
      for (const m of r.members) status[m] = "idle";
      setAgentStatus(status);
    } catch (err) {
      console.error("Failed to reload room:", err);
    }
  }, [roomId]);

  return {
    room,
    messages,
    agentStatus,
    loading,
    hasMore,
    loadingOlder,
    loadOlder,
    sendMessage,
    handleWsEvent,
    reloadRoom,
  };
}
