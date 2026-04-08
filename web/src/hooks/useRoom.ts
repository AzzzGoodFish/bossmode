import { useState, useEffect, useCallback, useRef } from "react";
import type { Room, RoomMessage, ContextUsageData } from "../api/client";
import {
  getMessages,
  sendMessage as apiSendMessage,
  getRoom,
  getAgentContextUsage,
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
  const [contextUsage, setContextUsage] = useState<Record<string, ContextUsageData>>({});

  // Track agents known to not support context usage (pi-cli, etc.)
  const unsupportedAgents = useRef(new Set<string>());

  // Fetch context usage for one or all members
  const fetchContextUsage = useCallback(async (agentName?: string) => {
    if (!roomId) return;
    const r = room;
    if (!r) return;

    const targets = agentName ? [agentName] : r.members;
    const results = await Promise.allSettled(
      targets
        .filter((name) => !unsupportedAgents.current.has(name))
        .map(async (name) => {
          const data = await getAgentContextUsage(roomId, name);
          if (!data.supported) unsupportedAgents.current.add(name);
          return { name, data };
        })
    );

    const updates: Record<string, ContextUsageData> = {};
    for (const result of results) {
      if (result.status === "fulfilled") {
        updates[result.value.name] = result.value.data;
      }
    }
    if (Object.keys(updates).length > 0) {
      setContextUsage((prev) => ({ ...prev, ...updates }));
    }
  }, [roomId, room]);

  // Load room details and initial messages (newest N)
  useEffect(() => {
    if (!roomId) {
      setRoom(null);
      setMessages([]);
      setAgentStatus({});
      setHasMore(true);
      setContextUsage({});
      unsupportedAgents.current.clear();
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

  // Fetch context usage when room loads + periodic polling (30s)
  useEffect(() => {
    if (room && roomId) {
      fetchContextUsage();
      const interval = setInterval(() => fetchContextUsage(), 30_000);
      return () => clearInterval(interval);
    }
  }, [room, roomId, fetchContextUsage]);

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

  // Handle incoming WS events
  const handleWsEvent = useCallback(
    (event: WsEvent) => {
      if (!roomId) return;

      if (event.type === "room:message" && event.roomId === roomId) {
        // Summary messages trigger full reload (merged view changes)
        if (event.message.type === "summary") {
          reloadRoom();
          return;
        }
        setMessages((prev) => {
          if (prev.some((m) => m.id === event.message.id)) return prev;
          return [...prev, event.message];
        });
      }

      if (event.type === "agent:status" && event.roomId === roomId) {
        const newStatus = event.status as "inactive" | "idle" | "working";
        setAgentStatus((prev) => ({
          ...prev,
          [event.agent]: newStatus,
        }));

        // Refresh context usage when agent starts work (show previous data) or finishes
        if (newStatus === "working") {
          fetchContextUsage(event.agent);
        } else if (newStatus === "idle") {
          setTimeout(() => fetchContextUsage(event.agent), 500);
        }
      }
    },
    [roomId, fetchContextUsage, reloadRoom],
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

  return {
    room,
    messages,
    agentStatus,
    contextUsage,
    loading,
    hasMore,
    loadingOlder,
    loadOlder,
    sendMessage,
    handleWsEvent,
    reloadRoom,
  };
}
