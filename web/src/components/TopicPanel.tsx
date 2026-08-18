/**
 * Topic UI (plan-topic-threads-v1 batch 3, prototype topic-threads-v1 approved by fish).
 *
 * Three pieces, all in the established families — no new chrome invented:
 *   CreateTopicSheet — Sheet dialog: title + "Start members fresh" seed switch
 *   TopicPanel       — tier-1 side panel (TaskPreviewPanel slot: drag-resize, station wall yields)
 *   TopicSurface     — tier-2 fullscreen (SurfaceShell), deep workspace with right rail
 *
 * Live data: own WS subscription to `topic:<id>` (DmPage pattern); messages never
 * touch the parent room stream (batch-1 routing isolation).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2, MessagesSquare, X } from "lucide-react";
import { closeTopic, createTopic, getTopic, getTopicMessages, sendTopicMessage, getUsername, type MemberInfo, type RoomMessage, type TopicRecord } from "../api/client";
import { useWebSocket, type WsEvent } from "../hooks/useWebSocket";
import { MessageBubble } from "./MessageBubble";
import { MessageInput } from "./MessageInput";
import { Sheet } from "./Sheet";
import { SurfaceShell } from "./SurfaceShell";

// ── Create ────────────────────────────────────────────────────────────────────

export function CreateTopicSheet({
  anchor,
  roomId,
  onCancel,
  onCreated,
}: {
  anchor: RoomMessage;
  roomId: string;
  onCancel: () => void;
  onCreated: (topicId: string) => void;
}) {
  const firstLine = (anchor.content || "").replace(/^@\S+\s*/, "").split("\n").find((l) => l.trim()) ?? "";
  const [title, setTitle] = useState(firstLine.slice(0, 40));
  const [fresh, setFresh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.select(), 60);
    return () => clearTimeout(t);
  }, []);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createTopic(roomId, {
        title: title.trim() || undefined,
        anchorMessageId: anchor.id,
        anchorSeq: anchor.seq,
        seedMode: fresh ? "fresh" : "fork",
      });
      onCreated(res.topic.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create topic");
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={onCancel} size="sm">
      <div className="p-5">
        <h3 className="text-base font-semibold text-ink-1">New topic</h3>
        <p className="text-xs text-ink-3 mt-0.5">Start a focused sub-discussion anchored to this message. The room stream keeps only a topic card.</p>

        <div className="mt-3 border border-line-soft bg-inset rounded-lg px-2.5 py-2 text-xs text-ink-3">
          <span className="font-medium text-ink-2">{anchor.sender === "user" ? "you" : anchor.sender}</span>
          {anchor.seq !== undefined && <span className="font-mono text-[10px] text-ink-4 ml-1.5">#{anchor.seq}</span>}
          <div className="truncate mt-0.5">{firstLine.slice(0, 80) || "(no text)"}</div>
        </div>

        <label className="block mt-3">
          <span className="block text-xs text-ink-3 mb-1">Topic title</span>
          <input
            ref={inputRef}
            className="w-full bg-inset border border-line-soft rounded-lg px-2.5 py-2 text-[13px] text-ink-1 focus:outline-none focus:border-accent/50"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
            placeholder="What is this topic about?"
          />
        </label>

        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-ink-3">
            Start members fresh
            <span className="block text-[11px] text-ink-4 mt-0.5 leading-relaxed">
              Off: members fork the room session at the anchor (full history + guide summary). On: fresh session with the guide summary only.
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={fresh}
            aria-label="Start members fresh"
            onClick={() => setFresh((v) => !v)}
            className={`relative w-10 h-5 rounded-full transition-colors shrink-0 cursor-pointer ${fresh ? "bg-accent" : "bg-surface-3"}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${fresh ? "translate-x-5" : "translate-x-0"}`} />
          </button>
        </div>

        <p className="mt-3 text-[11px] text-ink-4 leading-relaxed">
          Any room member can be @-mentioned into the topic (no roster in v1). Closing the topic generates a summary card in the room stream.
        </p>

        {error && <div className="mt-2 text-xs text-blocked">{error}</div>}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="px-4 py-2 text-sm text-ink-3 cursor-pointer">Cancel</button>
          <button type="button" onClick={() => void submit()} disabled={busy} className="px-4 py-2 bg-accent hover:opacity-90 disabled:opacity-40 text-accent-contrast text-sm font-medium rounded-lg cursor-pointer">
            {busy ? "Creating…" : "Create topic"}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// ── Shared stream ─────────────────────────────────────────────────────────────

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
    return () => { cancelled = true; };
  }, [roomId, topicId]);

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

  const send = useCallback(
    async (content: string, replyTo?: { seq: number }) => {
      const msg = await sendTopicMessage(roomId, topicId, content, replyTo);
      setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
    },
    [roomId, topicId],
  );

  const endTopic = useCallback(async () => {
    const res = await closeTopic(roomId, topicId);
    setTopic(res.topic);
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

function TopicStream({
  roomId,
  topicId,
  topic,
  messages,
  notFound,
  send,
  members,
  compact,
}: {
  roomId: string;
  topicId: string;
  topic: TopicRecord | null;
  messages: RoomMessage[];
  notFound: boolean;
  send: (content: string, replyTo?: { seq: number }) => Promise<void>;
  members: string[];
  compact?: boolean;
}) {
  const [quote, setQuote] = useState<{ seq: number; messageId: string; sender: string; excerpt: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const closed = topic?.status === "closed";

  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [topicId, messages.length]);

  if (notFound) {
    return <div className="flex-1 flex items-center justify-center text-xs text-ink-4">Topic not found.</div>;
  }

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
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
      </div>
      {closed ? (
        <div className="shrink-0 border-t border-line-soft px-3 py-2.5 text-[11.5px] text-think">
          Topic closed — read-only. The summary card is in the room stream.
        </div>
      ) : (
        <MessageInput
          onSend={(content) => { const q = quote; setQuote(null); return send(content, q ? { seq: q.seq } : undefined); }}
          members={members}
          roomId={roomId}
          draftKey={`topic:${topicId}`}
          placeholder="Message topic… (@ to mention)"
          hideAttachments={compact}
          quote={quote}
          onClearQuote={() => setQuote(null)}
        />
      )}
    </>
  );
}

function ParticipantChips({ topic, memberInfos, statusByName }: { topic: TopicRecord | null; memberInfos: Array<Pick<MemberInfo, "id" | "name">>; statusByName: Record<string, string> }) {
  if (!topic || topic.participants.length === 0) return null;
  const nameOf = (id: string) => memberInfos.find((m) => m.id === id)?.name ?? id;
  return (
    <>
      {topic.participants.map((pid) => {
        const name = nameOf(pid);
        const working = statusByName[name] === "working";
        return (
          <span key={pid} className={`inline-flex items-center gap-1.5 text-[10.5px] rounded-full px-2 py-0.5 border ${working ? "text-ink-2 border-onair/30 bg-surface-2" : "text-ink-3 border-line-soft bg-surface-2"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${working ? "bg-onair animate-pulse" : "bg-ink-4"}`} />
            {name}{working ? " working" : ""}
          </span>
        );
      })}
    </>
  );
}

// ── Tier 1: side panel ────────────────────────────────────────────────────────

export function TopicPanel({
  roomId,
  topicId,
  members,
  memberInfos,
  agentStatus,
  onExpand,
  onClose,
}: {
  roomId: string;
  topicId: string;
  members: string[];
  memberInfos: Array<Pick<MemberInfo, "id" | "name">>;
  agentStatus: Record<string, string>;
  onExpand: () => void;
  onClose: () => void;
}) {
  const { topic, messages, notFound, send, endTopic, statusByName } = useTopicStream(roomId, topicId);
  const [ending, setEnding] = useState(false);

  return (
    <div className="h-full min-h-0 flex flex-col bg-surface-1 border-l border-line" data-testid="topic-panel">
      <div className="shrink-0 border-b border-line-soft px-3 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <MessagesSquare size={14} className="text-accent-ink shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-ink-1 truncate" title={topic?.title}>{topic?.title ?? "Topic"}</div>
            <div className="font-mono text-[10px] text-ink-4 truncate">
              {topic?.anchorSeq !== undefined ? `anchored #${topic.anchorSeq}` : "…"}
            </div>
          </div>
          {topic?.status === "active" && (
            <button
              type="button"
              disabled={ending}
              onClick={() => { setEnding(true); void endTopic().finally(() => setEnding(false)); }}
              className="shrink-0 px-2 py-1 rounded text-[11px] font-semibold text-ink-2 border border-line-soft hover:bg-surface-2 cursor-pointer disabled:opacity-40"
            >
              {ending ? "Ending…" : "End topic"}
            </button>
          )}
          <button onClick={onExpand} title="Expand to surface" aria-label="Expand to surface" className="w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer">
            <Maximize2 size={13} />
          </button>
          <button onClick={onClose} title="Close panel" aria-label="Close panel" className="w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer">
            <X size={14} />
          </button>
        </div>
        {(topic?.participants.length ?? 0) > 0 && (
          <div className="flex items-center gap-1.5 mt-2 flex-wrap">
            <ParticipantChips topic={topic} memberInfos={memberInfos} statusByName={statusByName} />
          </div>
        )}
      </div>
      <TopicStream roomId={roomId} topicId={topicId} topic={topic} messages={messages} notFound={notFound} send={send} members={members} compact />
    </div>
  );
}

// ── Tier 2: fullscreen Surface ────────────────────────────────────────────────

export function TopicSurface({
  roomId,
  topicId,
  members,
  memberInfos,
  agentStatus,
  onCollapse,
  onClose,
}: {
  roomId: string;
  topicId: string;
  members: string[];
  memberInfos: Array<Pick<MemberInfo, "id" | "name">>;
  agentStatus: Record<string, string>;
  onCollapse: () => void;
  onClose: () => void;
}) {
  const { topic, messages, notFound, send, endTopic, statusByName } = useTopicStream(roomId, topicId);
  const [ending, setEnding] = useState(false);

  return (
    <SurfaceShell
      testid="topic-surface"
      icon={<MessagesSquare size={15} className="text-accent-ink shrink-0" />}
      title={topic?.title ?? "Topic"}
      meta={topic?.anchorSeq !== undefined ? <span className="hidden sm:block font-mono text-[10px] text-ink-4">anchored #{topic.anchorSeq}</span> : undefined}
      actions={
        <>
          {topic?.status === "active" && (
            <button
              type="button"
              disabled={ending}
              onClick={() => { setEnding(true); void endTopic().finally(() => setEnding(false)); }}
              className="shrink-0 px-2 py-1 rounded text-[11px] font-semibold text-ink-2 border border-line-soft hover:bg-surface-2 cursor-pointer disabled:opacity-40"
            >
              {ending ? "Ending…" : "End topic"}
            </button>
          )}
          <button onClick={onCollapse} title="Collapse to panel" aria-label="Collapse to panel" className="w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-surface-2 cursor-pointer">
            <Minimize2 size={13} />
          </button>
        </>
      }
      onClose={onClose}
    >
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
            <div className="flex-1 min-h-0 flex flex-col max-w-3xl w-full mx-auto">
              <TopicStream roomId={roomId} topicId={topicId} topic={topic} messages={messages} notFound={notFound} send={send} members={members} />
            </div>
          </div>
        </div>
        <div className="w-[264px] border-l border-line shrink-0 px-3.5 py-4 hidden md:block">
          <h5 className="text-[10px] font-bold tracking-[0.08em] uppercase text-ink-4 mb-2">Topic</h5>
          <div className="text-xs text-ink-2 space-y-1">
            <div><span className="text-ink-4">Anchor</span> · {topic?.anchorSeq !== undefined ? `#${topic.anchorSeq}` : "—"}</div>
            <div><span className="text-ink-4">Created by</span> · {topic?.createdBy === "user" ? "you" : (topic?.createdBy ?? "—")}</div>
            <div><span className="text-ink-4">Seed</span> · {topic?.seedMode ?? "—"}</div>
            <div><span className="text-ink-4">Status</span> · {topic?.status ?? "—"}</div>
          </div>
          <h5 className="text-[10px] font-bold tracking-[0.08em] uppercase text-ink-4 mt-4 mb-2">Participants</h5>
          {topic && topic.participants.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              <ParticipantChips topic={topic} memberInfos={memberInfos} statusByName={statusByName} />
            </div>
          ) : (
            <div className="text-[11px] text-ink-4">No members yet — @ one in the stream.</div>
          )}
        </div>
      </div>
    </SurfaceShell>
  );
}
