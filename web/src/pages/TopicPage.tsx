/**
 * Topic workspace (topic-threads v3, fish 2026-08-19 feedback on rc.5):
 *
 * - Real topic: room-form page (top bar back/title/anchored #seq/End topic…,
 *   anchor context block → jump to room message, composer, native member rail).
 * - Draft topic (Feishu semantics): opened from a message's topic button —
 *   nothing persists until the first message sends; the anchor is the subject.
 *
 * Right rail is the room's NATIVE member view (StationPanel): member info,
 * tool terminal-state bars, model/thinking switching — same component as the
 * room, operating on the parent room's member records.
 *
 * Data: WS subscriptions on both topic:<id> (messages + in-topic status) and
 * the parent room scope (member status/context parity with the room view).
 * Read cursor reported like the room does (watching = reading).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, MessagesSquare } from "lucide-react";
import {
  closeTopic, getRoom, getRoomMembers, getTopic, getTopicMessages, sendTopicMessage,
  postConversationRead, getAgentContextUsage, getUsername,
  type ContextUsageData, type MemberInfo, type RoomMessage, type TopicRecord,
} from "../api/client";
import { useWebSocket, type WsEvent } from "../hooks/useWebSocket";
import type { AgentStatusMap } from "../hooks/useRoom";
import { MessageBubble } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";
import { StationPanel } from "../components/StationPanel";
import { TopicRail, TopicRailToggle, useRoomTopics, useTopicRailOpen } from "../components/TopicRail";

export interface TopicDraftAnchor {
  anchorMessageId: string;
  anchorSeq?: number;
  title: string;
  excerpt: string;
}

function useTopicStream(roomId: string, topicId: string | null) {
  const [topic, setTopic] = useState<TopicRecord | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [notFound, setNotFound] = useState(false);
  /** Topic-scoped member status (agent:status broadcasts on topic:<id>). */
  const [topicStatusByName, setTopicStatusByName] = useState<AgentStatusMap>({});
  /** Room-scoped member status — the native rail's parity source. */
  const [roomStatusByName, setRoomStatusByName] = useState<AgentStatusMap>({});
  const [contextUsage, setContextUsage] = useState<Record<string, ContextUsageData>>({});
  const scopeId = topicId ? `topic:${topicId}` : null;
  const roomScope = `room:${roomId}`;

  useEffect(() => {
    if (!topicId) return;
    let cancelled = false;
    setNotFound(false);
    Promise.all([getTopic(roomId, topicId), getTopicMessages(roomId, topicId, 500)])
      .then(([t, m]) => {
        if (cancelled) return;
        setTopic(t.topic);
        setMessages(m.messages);
      })
      .catch(() => { if (!cancelled) setNotFound(true); });
    // Viewing = reading (room semantics): report the cursor on open.
    postConversationRead(`topic:${topicId}`).catch(() => {});
    return () => { cancelled = true; };
  }, [roomId, topicId]);

  const handleWsEvent = useCallback(
    (event: WsEvent) => {
      if (scopeId && event.type === "room:message" && event.roomId === scopeId) {
        const msg = event.message as RoomMessage;
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        // A fresh message can mean a new participant joined — refetch the record lazily.
        getTopic(roomId, topicId!).then((t) => setTopic(t.topic)).catch(() => {});
      }
      if (event.type === "agent:status") {
        const status = event.status as AgentStatusMap[string];
        if (scopeId && event.roomId === scopeId) {
          setTopicStatusByName((prev) => ({ ...prev, [event.agent]: status }));
        }
        if (event.roomId === roomScope) {
          setRoomStatusByName((prev) => ({ ...prev, [event.agent]: status }));
        }
      }
      if (event.type === "agent:context_usage" && (event.roomId === roomScope || (scopeId && event.roomId === scopeId))) {
        const name = (event as any).agent as string;
        const usage = (event as any).usage as ContextUsageData | undefined;
        if (name && usage) setContextUsage((prev) => ({ ...prev, [name]: usage }));
      }
    },
    [scopeId, roomScope, roomId, topicId],
  );
  const { subscribeRoom, unsubscribeRoom } = useWebSocket({ onEvent: handleWsEvent });
  useEffect(() => {
    subscribeRoom(roomScope);
    if (scopeId) subscribeRoom(scopeId);
    return () => {
      unsubscribeRoom(roomScope);
      if (scopeId) unsubscribeRoom(scopeId);
    };
  }, [scopeId, roomScope, subscribeRoom, unsubscribeRoom]);

  // Follow the read cursor while viewing (debounced, like useRoom).
  useEffect(() => {
    if (!scopeId || messages.length === 0) return;
    const t = setTimeout(() => { postConversationRead(scopeId).catch(() => {}); }, 800);
    return () => clearTimeout(t);
  }, [scopeId, messages]);

  const send = useCallback(
    async (content: string, replyTo?: { seq: number }) => {
      if (!topicId) return;
      const msg = await sendTopicMessage(roomId, topicId, content, replyTo);
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    },
    [roomId, topicId],
  );

  const endTopic = useCallback(async () => {
    if (!topicId) return;
    const res = await closeTopic(roomId, topicId);
    if (res?.topic) setTopic(res.topic);
  }, [roomId, topicId]);

  return { topic, messages, notFound, send, endTopic, topicStatusByName, roomStatusByName, contextUsage, setContextUsage };
}

function resolveTopicQuote(messages: RoomMessage[], msg: RoomMessage): { seq: number; messageId: string; sender?: string; excerpt?: string } | undefined {
  if (!msg.replyTo) return undefined;
  const target = messages.find((m) => m.id === msg.replyTo!.messageId) ?? messages.find((m) => m.seq === msg.replyTo!.seq);
  if (!target) return { seq: msg.replyTo.seq, messageId: msg.replyTo.messageId };
  const firstLine = String(target.content || "").split("\n").find((l) => l.trim()) ?? "";
  return { seq: msg.replyTo.seq, messageId: msg.replyTo.messageId, sender: target.sender === "user" ? "you" : target.sender, excerpt: firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine };
}

export function TopicPage({
  roomId,
  topicId,
  draft,
  onCreateDraft,
  onBack,
  onOpenTopic,
  onJumpToRoomMessage,
  onOpenMcpSettings,
  onOpenExtensionsSettings,
}: {
  roomId: string;
  /** Real topic id; null in draft mode. */
  topicId: string | null;
  /** Draft anchor (v3): when set, the page is an unsent draft workspace. */
  draft?: TopicDraftAnchor;
  /** First-message send in draft mode: parent creates the topic and navigates. */
  onCreateDraft?: (content: string) => Promise<void>;
  onBack: () => void;
  /** Direct topic⇄topic switch from the embedded rail (fish pick: direction A). */
  onOpenTopic?: (topicId: string) => void;
  onJumpToRoomMessage?: (messageId: string) => void;
  onOpenMcpSettings?: () => void;
  onOpenExtensionsSettings?: () => void;
}) {
  const isDraft = !topicId;
  const { topic, messages, notFound, send, endTopic, topicStatusByName, roomStatusByName, contextUsage, setContextUsage } = useTopicStream(roomId, topicId);
  const [topicRailOpen, toggleTopicRail] = useTopicRailOpen(roomId);
  const { topics: roomTopics, activeCount: topicActiveCount } = useRoomTopics(roomId);
  const [quote, setQuote] = useState<{ seq: number; messageId: string; sender: string; excerpt: string } | null>(null);
  const [ending, setEnding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [roomName, setRoomName] = useState("room");
  const [memberInfos, setMemberInfos] = useState<MemberInfo[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const closed = topic?.status === "closed";

  useEffect(() => {
    let cancelled = false;
    Promise.all([getRoom(roomId), getRoomMembers(roomId)])
      .then(([r, ms]) => {
        if (cancelled) return;
        setRoomName(r.name);
        setMemberInfos(ms);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [roomId]);

  const members = useMemo(() => memberInfos.map((m) => m.name), [memberInfos]);

  // Native rail parity: seed context usage per member (room scope), like useRoom.
  useEffect(() => {
    if (members.length === 0) return;
    let cancelled = false;
    Promise.allSettled(members.map((name) => getAgentContextUsage(roomId, name))).then((results) => {
      if (cancelled) return;
      // Rebuild by call order — results align with the members array.
      const byName: Record<string, ContextUsageData> = {};
      results.forEach((r, i) => {
        if (r.status !== "fulfilled") return;
        const data = r.value as any;
        if (data && !data.unavailable && data.supported !== false) byName[members[i]] = data;
      });
      if (Object.keys(byName).length > 0) setContextUsage((prev) => ({ ...prev, ...byName }));
    });
    return () => { cancelled = true; };
  }, [members, roomId, setContextUsage]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [topicId, messages.length]);

  // Topic-scoped status wins (in-topic work), room scope fills the rest.
  const agentStatus = useMemo(() => ({ ...roomStatusByName, ...topicStatusByName }), [roomStatusByName, topicStatusByName]);

  const anchorSeq = isDraft ? draft?.anchorSeq : topic?.anchorSeq;
  const anchorExcerpt = isDraft ? draft?.excerpt : topic?.anchorExcerpt;
  const anchorMessageId = isDraft ? draft?.anchorMessageId : topic?.anchorMessageId;
  const title = isDraft ? (draft?.title ?? "New topic") : (topic?.title ?? "Topic");

  const handleSend = async (content: string) => {
    if (isDraft) {
      if (!onCreateDraft) return;
      setCreating(true);
      try {
        await onCreateDraft(content);
      } finally {
        setCreating(false);
      }
      return;
    }
    const q = quote;
    setQuote(null);
    return send(content, q ? { seq: q.seq } : undefined);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-surface-1" data-testid="topic-page" data-draft={isDraft ? "true" : "false"}>
      {/* Top bar — room-page language */}
      <div className="h-12 border-b border-line flex items-center gap-3 px-4 shrink-0 bg-surface-1">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded-lg px-2 py-1 -ml-2 text-ink-3 hover:text-ink-1 hover:bg-surface-2 transition-colors cursor-pointer" title={isDraft ? "Discard draft and go back" : `Back to ${roomName}`}>
          <ArrowLeft size={14} />
          <span className="text-xs">{roomName}</span>
        </button>
        <MessagesSquare size={14} className="text-accent-ink shrink-0" />
        <h2 className="text-sm font-semibold tracking-tight text-ink-1 truncate">{title}</h2>
        <span className="font-mono text-[11px] text-ink-4 truncate hidden sm:block">
          {isDraft
            ? "draft · created on first send"
            : `topic · ${anchorSeq !== undefined ? `anchored #${anchorSeq}` : "composer-created"}`}
        </span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <TopicRailToggle open={topicRailOpen} activeCount={topicActiveCount} onToggle={toggleTopicRail} />
          {!isDraft && !closed && (
            <button
              onClick={() => { setEnding(true); void endTopic().finally(() => setEnding(false)); }}
              disabled={ending}
              className="px-2 py-1 text-[11px] text-ink-4 hover:text-blocked hover:bg-blocked/10 rounded cursor-pointer disabled:opacity-50"
            >
              {ending ? "Ending…" : "End topic…"}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* embedded topic rail — same instance state as the room view, one-click direct switch */}
        {topicRailOpen && (
          <TopicRail
            topics={roomTopics}
            currentTopicId={topicId}
            onSelectRoom={onBack}
            onSelectTopic={(id) => onOpenTopic?.(id)}
          />
        )}
        {/* stream column */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
            {!isDraft && notFound ? (
              <div className="h-full flex items-center justify-center text-xs text-ink-4">Topic not found.</div>
            ) : (
              <>
                {/* Anchor context block — pinned on top, click jumps back to the room message */}
                {anchorExcerpt && (
                  <button
                    type="button"
                    onClick={() => anchorMessageId && onJumpToRoomMessage?.(anchorMessageId)}
                    className={`w-full text-left border-l-2 border-accent bg-accent-dim/40 rounded-r-lg px-3 py-2 mb-3 ${onJumpToRoomMessage ? "cursor-pointer hover:bg-accent-dim/70" : "cursor-default"}`}
                    title={onJumpToRoomMessage ? "Jump to anchor in room" : undefined}
                  >
                    <span className="block text-[9.5px] font-extrabold tracking-[0.08em] uppercase text-accent-ink mb-1">Topic anchor</span>
                    <span className="text-xs text-ink-3">
                      {anchorSeq !== undefined && <span className="font-mono text-[10px] text-ink-4 mr-1.5">#{anchorSeq}</span>}
                      {anchorExcerpt}
                    </span>
                  </button>
                )}
                {isDraft ? (
                  <div className="text-xs text-ink-4 px-1 py-2 leading-relaxed">
                    This topic doesn't exist yet — your first message creates it, with the anchor above as its subject. @ members to bring them in.
                  </div>
                ) : (
                  messages.length === 0 && (
                    <div className="text-xs text-ink-4 px-1 py-2">Beginning of topic. @ a member to bring them in.</div>
                  )
                )}
                {!isDraft && messages.map((m) => {
                  const d = new Date(m.ts);
                  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                  return (
                    <MessageBubble
                      key={m.id}
                      sender={m.sender}
                      content={m.content}
                      time={time}
                      fullTime={d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      isMarkdown={m.sender !== "user" && m.sender !== "system"}
                      mentions={m.mentions}
                      urgentMentions={m.urgentMentions}
                      members={members}
                      loginName={getUsername()}
                      roomId={roomId}
                      messageId={m.id}
                      quote={resolveTopicQuote(messages, m)}
                      onReply={!closed && m.sender !== "system" ? () => setQuote({
                        seq: m.seq ?? 0,
                        messageId: m.id,
                        sender: m.sender === "user" ? "you" : m.sender,
                        excerpt: (m.content || "").split("\n").find((l) => l.trim())?.slice(0, 60) ?? "",
                      }) : undefined}
                    />
                  );
                })}
                <div ref={bottomRef} />
              </>
            )}
          </div>
          {!isDraft && closed ? (
            <div className="shrink-0 border-t border-line-soft px-4 py-2.5 text-[11.5px] text-think">
              Topic closed — read-only. The summary card is in the room stream.
            </div>
          ) : (
            <MessageInput
              onSend={(content) => handleSend(content)}
              members={members}
              roomId={roomId}
              draftKey={isDraft ? `topic-draft:${draft?.anchorMessageId}` : `topic:${topicId}`}
              placeholder={isDraft ? "Send the first message to create this topic… (@ to mention)" : "Message topic… (@ to mention)"}
              quote={quote}
              onClearQuote={() => setQuote(null)}
              disabled={creating}
            />
          )}
        </div>

        {/* right rail — the room's NATIVE member view (fish v3 ③) */}
        <div className="w-[280px] border-l border-line shrink-0 hidden md:block overflow-y-auto">
          <StationPanel
            members={members}
            agentStatus={agentStatus}
            contextUsage={contextUsage}
            roomId={roomId}
            onOpenMcpSettings={onOpenMcpSettings}
            onOpenExtensionsSettings={onOpenExtensionsSettings}
          />
        </div>
      </div>
    </div>
  );
}
