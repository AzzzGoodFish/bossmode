/**
 * Topic workspace (topic-threads v2, fish-approved prototype topic-threads-v2).
 *
 * A topic IS a workspace, not a panel attachment: same anatomy as the room page —
 * top bar (back + title + anchored #seq + End topic…), stream with the anchor
 * context block pinned on top, composer, right rail with in-topic participants.
 * Panel⇄Surface tiers from v1 are retired.
 *
 * Data: own WS subscription on topic:<id> (messages + agent:status share the
 * scope); messages never touch the parent room stream. Read cursor reported
 * like the room does (watching = reading, Feishu semantics).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, MessagesSquare } from "lucide-react";
import { closeTopic, getRoom, getRoomMembers, getTopic, getTopicMessages, sendTopicMessage, postConversationRead, getUsername, type MemberInfo, type RoomMessage, type TopicRecord } from "../api/client";
import { useWebSocket, type WsEvent } from "../hooks/useWebSocket";
import { MessageBubble } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";

function useTopicStream(roomId: string, topicId: string) {
  const [topic, setTopic] = useState<TopicRecord | null>(null);
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [notFound, setNotFound] = useState(false);
  /** Topic-scoped member status (agent:status broadcasts on topic:<id>, same scope as messages). */
  const [statusByName, setStatusByName] = useState<Record<string, string>>({});
  const scopeId = `topic:${topicId}`;

  useEffect(() => {
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
    postConversationRead(scopeId).catch(() => {});
    return () => { cancelled = true; };
  }, [roomId, topicId, scopeId]);

  const handleWsEvent = useCallback(
    (event: WsEvent) => {
      if (event.type === "room:message" && event.roomId === scopeId) {
        const msg = event.message as RoomMessage;
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        // A fresh message can mean a new participant joined — refetch the record lazily.
        getTopic(roomId, topicId).then((t) => setTopic(t.topic)).catch(() => {});
      }
      if (event.type === "agent:status" && event.roomId === scopeId) {
        setStatusByName((prev) => ({ ...prev, [event.agent]: event.status }));
      }
    },
    [scopeId, roomId, topicId],
  );
  const { subscribeRoom, unsubscribeRoom } = useWebSocket({ onEvent: handleWsEvent });
  useEffect(() => {
    subscribeRoom(scopeId);
    return () => unsubscribeRoom(scopeId);
  }, [scopeId, subscribeRoom, unsubscribeRoom]);

  // Follow the read cursor while viewing (debounced, like useRoom).
  useEffect(() => {
    if (messages.length === 0) return;
    const t = setTimeout(() => { postConversationRead(scopeId).catch(() => {}); }, 800);
    return () => clearTimeout(t);
  }, [scopeId, messages]);

  const send = useCallback(
    async (content: string, replyTo?: { seq: number }) => {
      const msg = await sendTopicMessage(roomId, topicId, content, replyTo);
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    },
    [roomId, topicId],
  );

  const endTopic = useCallback(async () => {
    const res = await closeTopic(roomId, topicId);
    if (res?.topic) setTopic(res.topic);
  }, [roomId, topicId]);

  return { topic, messages, notFound, send, endTopic, statusByName };
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
  onBack,
  onJumpToRoomMessage,
}: {
  roomId: string;
  topicId: string;
  onBack: () => void;
  onJumpToRoomMessage?: (messageId: string) => void;
}) {
  const { topic, messages, notFound, send, endTopic, statusByName } = useTopicStream(roomId, topicId);
  const [quote, setQuote] = useState<{ seq: number; messageId: string; sender: string; excerpt: string } | null>(null);
  const [ending, setEnding] = useState(false);
  const [roomName, setRoomName] = useState("room");
  const [memberInfos, setMemberInfos] = useState<Array<Pick<MemberInfo, "id" | "name">>>([]);
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

  const members = memberInfos.map((m) => m.name);

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [topicId, messages.length]);

  const nameOf = (id: string) => memberInfos.find((m) => m.id === id)?.name ?? id;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-surface-1" data-testid="topic-page">
      {/* Top bar — room-page language */}
      <div className="h-12 border-b border-line flex items-center gap-3 px-4 shrink-0 bg-surface-1">
        <button onClick={onBack} className="flex items-center gap-1.5 rounded-lg px-2 py-1 -ml-2 text-ink-3 hover:text-ink-1 hover:bg-surface-2 transition-colors cursor-pointer" title={`Back to ${roomName}`}>
          <ArrowLeft size={14} />
          <span className="text-xs">{roomName}</span>
        </button>
        <MessagesSquare size={14} className="text-accent-ink shrink-0" />
        <h2 className="text-sm font-semibold tracking-tight text-ink-1 truncate">{topic?.title ?? "Topic"}</h2>
        <span className="font-mono text-[11px] text-ink-4 truncate hidden sm:block">
          topic · {topic?.anchorSeq !== undefined ? `anchored #${topic.anchorSeq}` : "composer-created"}
        </span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {!closed && (
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
        {/* stream column */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
            {notFound ? (
              <div className="h-full flex items-center justify-center text-xs text-ink-4">Topic not found.</div>
            ) : (
              <>
                {/* Anchor context block — pinned on top, click jumps back to the room message */}
                {topic && topic.anchorExcerpt && (
                  <button
                    type="button"
                    onClick={() => topic.anchorMessageId && onJumpToRoomMessage?.(topic.anchorMessageId)}
                    className={`w-full text-left border-l-2 border-accent bg-accent-dim/40 rounded-r-lg px-3 py-2 mb-3 ${onJumpToRoomMessage ? "cursor-pointer hover:bg-accent-dim/70" : "cursor-default"}`}
                    title={onJumpToRoomMessage ? "Jump to anchor in room" : undefined}
                  >
                    <span className="block text-[9.5px] font-extrabold tracking-[0.08em] uppercase text-accent-ink mb-1">Topic anchor</span>
                    <span className="text-xs text-ink-3">
                      {topic.anchorSeq !== undefined && <span className="font-mono text-[10px] text-ink-4 mr-1.5">#{topic.anchorSeq}</span>}
                      {topic.anchorExcerpt}
                    </span>
                  </button>
                )}
                {messages.length === 0 && (
                  <div className="text-xs text-ink-4 px-1 py-2">Beginning of topic. @ a member to bring them in.</div>
                )}
                {messages.map((m) => {
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
          {closed ? (
            <div className="shrink-0 border-t border-line-soft px-4 py-2.5 text-[11.5px] text-think">
              Topic closed — read-only. The summary card is in the room stream.
            </div>
          ) : (
            <MessageInput
              onSend={(content) => { const q = quote; setQuote(null); return send(content, q ? { seq: q.seq } : undefined); }}
              members={members}
              roomId={roomId}
              draftKey={`topic:${topicId}`}
              placeholder="Message topic… (@ to mention)"
              quote={quote}
              onClearQuote={() => setQuote(null)}
            />
          )}
        </div>

        {/* right rail — in-topic participants (station-wall row language) */}
        <div className="w-[240px] border-l border-line shrink-0 px-3 py-3 hidden md:block">
          <h4 className="text-[10px] font-bold tracking-[0.08em] uppercase text-ink-4 mb-2">In this topic</h4>
          {topic && topic.participants.length > 0 ? (
            <div className="space-y-0.5">
              {topic.participants.map((pid) => {
                const name = nameOf(pid);
                const working = statusByName[name] === "working";
                return (
                  <div key={pid} className="flex items-center gap-2 px-1 py-1.5 text-[12.5px] text-ink-2">
                    <span className="w-[22px] h-[22px] rounded-full bg-surface-3 border border-line flex items-center justify-center text-[10px] font-semibold shrink-0">
                      {name.charAt(0).toUpperCase()}
                    </span>
                    <span className="truncate">{name}</span>
                    {working
                      ? <span className="ml-auto w-1.5 h-1.5 rounded-full bg-onair animate-pulse shrink-0" title="working" />
                      : <span className="ml-auto w-1.5 h-1.5 rounded-full bg-ink-4 shrink-0" title="idle" />}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-[11px] text-ink-4 leading-relaxed">No members yet — @ one in the stream.</div>
          )}
          <p className="mt-3 text-[10.5px] text-ink-4 leading-relaxed">
            @ any room member to bring them in. Members enter with an English guide (title / anchor / progress summary / how to query the main stream).
          </p>
        </div>
      </div>
    </div>
  );
}
