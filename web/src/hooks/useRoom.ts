import { useMemberProfileRevision, currentMemberName, getMemberProfileRevision } from "./useMemberProfileRevision";
import { useState, useEffect, useCallback, useRef } from "react";
import type { Room, RoomMessage, ContextUsageData } from "../api/client";
import {
  getMessages,
  sendMessage as apiSendMessage,
  getRoom,
  getAgentContextUsage,
  postConversationRead,
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
  const [inHistoryView, setInHistoryView] = useState(false);

  // Track agents known to not support context usage
  const unsupportedAgents = useRef(new Set<string>());

  // Fetch context usage cache once (on room load / reload)
  const fetchContextUsageCache = useCallback(async () => {
    if (!roomId || !room) return;

    const results = await Promise.allSettled(
      room.memberIds
        .map((memberId, index) => ({ memberId, name: room.members[index] || memberId }))
        .filter(({ memberId }) => !unsupportedAgents.current.has(memberId))
        .map(async ({ memberId, name }) => {
          const data = await getAgentContextUsage(roomId, memberId);
          if (!data.supported) unsupportedAgents.current.add(memberId);
          return { name, data };
        }),
    );

    const updates: Record<string, ContextUsageData> = {};
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      const { name, data } = result.value;
      if (data.unavailable) continue;
      updates[name] = data;
    }

    if (Object.keys(updates).length > 0) {
      setContextUsage((prev) => ({ ...prev, ...updates }));
    }
  }, [roomId, room]);

  // Load room details and initial messages (newest N)
  useEffect(() => {
    // Reset all state on EVERY roomId change (including null)
    // to prevent cross-room state leakage (e.g. context usage from previous room)
    setRoom(null);
    setMessages([]);
    setAgentStatus({});
    setHasMore(true);
    setContextUsage({});
    unsupportedAgents.current.clear();

    if (!roomId) return;

    setLoading(true);

    const revisionAtLoad = getMemberProfileRevision();
    let active = true;
    Promise.all([getRoom(roomId), getMessages(roomId, { limit: PAGE_SIZE })])
      .then(([r, msgs]) => {
        if (!active) return;
        if (revisionAtLoad === getMemberProfileRevision()) {
          setRoom(r);
          const status: AgentStatusMap = {};
          for (const m of r.members) status[m] = (r.agentStatuses?.[m] as AgentStatusMap[string]) || "inactive";
          setAgentStatus(status);
        }
        setMessages(msgs);
        setHasMore(msgs.length >= PAGE_SIZE);
      })
      .catch(console.error)
      .finally(() => { if (active) setLoading(false); });

    // Report read position — clears the user-cursor unread badge (contract v1.3).
    postConversationRead(`room:${roomId}`).catch(() => {});
    return () => { active = false; };
  }, [roomId]);

  const profileRevision = useMemberProfileRevision();
  useEffect(() => {
    if (!roomId || !profileRevision) return;
    let active = true;
    // Identity refresh must not reload the message window or leave history view.
    getRoom(roomId).then((r) => {
      if (!active) return;
      setRoom(r);
      const status: AgentStatusMap = {};
      for (const name of r.members) status[name] = (r.agentStatuses?.[name] as AgentStatusMap[string]) || "inactive";
      setAgentStatus(status);
      setContextUsage({});
      unsupportedAgents.current.clear();
    }).catch(console.error);
    return () => { active = false; };
  }, [roomId, profileRevision]);

  // Follow the read cursor while viewing: realtime appends (not history browsing)
  // re-report (debounced) so the chats-list unread badge stays in sync —
  // Feishu semantics: watching a conversation means reading it.
  useEffect(() => {
    if (!roomId || inHistoryView || messages.length === 0) return;
    const t = setTimeout(() => {
      postConversationRead(`room:${roomId}`).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [roomId, messages, inHistoryView]);

  // Window regaining focus also counts as looking at the conversation.
  useEffect(() => {
    if (!roomId) return;
    const onFocus = () => {
      if (inHistoryView) return;
      postConversationRead(`room:${roomId}`).catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [roomId, inHistoryView]);

  // Fetch context usage cache once after room is loaded
  useEffect(() => {
    fetchContextUsageCache().catch(console.error);
  }, [fetchContextUsageCache]);

  // Context-usage refresh cadence (fish 2026-08-21: the number returns to the
  // roster strips): it only moves at turn boundaries, so refetch when the
  // room flips working→quiet, plus a 60s floor while anyone is working.
  const anyWorking = Object.values(agentStatus).some((s) => s === "working");
  const wasWorkingRef = useRef(false);
  useEffect(() => {
    if (wasWorkingRef.current && !anyWorking) fetchContextUsageCache().catch(console.error);
    wasWorkingRef.current = anyWorking;
  }, [anyWorking, fetchContextUsageCache]);
  useEffect(() => {
    if (!anyWorking) return;
    const t = window.setInterval(() => { fetchContextUsageCache().catch(console.error); }, 60_000);
    return () => window.clearInterval(t);
  }, [anyWorking, fetchContextUsageCache]);

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
      for (const m of r.members) status[m] = (r.agentStatuses?.[m] as AgentStatusMap[string]) || "inactive";
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
        // In history view, don't append new messages (user is reading old context)
        if (inHistoryView) return;
        setMessages((prev) => {
          const i = prev.findIndex((m) => m.id === event.message.id);
          if (i >= 0) {
            const next = prev.slice();
            next[i] = event.message;
            return next;
          }
          return [...prev, event.message];
        });
      }

      if (event.type === "agent:status" && event.roomId === roomId) {
        const newStatus = event.status as "inactive" | "idle" | "working";
        setAgentStatus((prev) => ({
          ...prev,
          [currentMemberName(event.memberId, event.agent)]: newStatus,
        }));
      }

      if (event.type === "agent:context_usage" && event.roomId === roomId) {
        if (!event.usage) return;
        setContextUsage((prev) => ({
          ...prev,
          [currentMemberName(event.memberId, event.agent)]: { supported: true, ...event.usage },
        }));
      }
    },
    [roomId, reloadRoom, inHistoryView],
  );

  const sendMessage = useCallback(
    async (content: string, attachments?: Array<{ storedFilename: string; originalFilename: string; size?: number }>, replyTo?: { seq: number }) => {
      if (!roomId) return;
      const msg = await apiSendMessage(roomId, content, attachments, replyTo);
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    },
    [roomId],
  );

  // Jump to a specific message by ID — fetches around window if not in DOM,
  // then scrolls it into view with the same pulse highlight the search jump
  // uses. Shared by ChatArea's search pipeline and the panel's mainline msg
  // refs (体验批②).
  const jumpToMessage = useCallback(async (messageId: string): Promise<void> => {
    if (!roomId) return;
    // Check if already loaded
    const alreadyLoaded = messages.some((m) => m.id === messageId);
    if (!alreadyLoaded) {
      // Fetch around window
      const window = await getMessages(roomId, { around: messageId, limit: PAGE_SIZE });
      if (window.length === 0) return; // message not found
      setMessages(window);
      setHasMore(true);
      setInHistoryView(true);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    const el = document.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("message-pulse");
      setTimeout(() => el.classList.remove("message-pulse"), 1600);
    }
  }, [roomId, messages]);

  // Return to latest messages from history view
  const returnToLatest = useCallback(async (): Promise<void> => {
    if (!roomId) return;
    const msgs = await getMessages(roomId, { limit: PAGE_SIZE });
    setMessages(msgs);
    setHasMore(msgs.length >= PAGE_SIZE);
    setInHistoryView(false);
  }, [roomId]);

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
    jumpToMessage,
    returnToLatest,
    inHistoryView,
  };
}
