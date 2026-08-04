/**
 * DmPage — direct-message conversation with a member (scope = dm).
 * The chat surface is the room chat language instantiated for one member:
 * MessageBubble + date separators + 5-min grouping + MessageInput (Chat &
 * List Unification v1). Member panel on the right is DM-specific and kept.
 * Data: /api/members/:id, /api/dm/:memberId/{messages,session}; realtime via
 * WS room:message on dm:<memberId>.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { PanelRight, Info, Settings2 } from "lucide-react";
import { StaffBadge, statusFromAgent } from "../components/StaffBadge";
import { MessageBubble } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";
import { DateSeparator, isGroupedWithPrev, shouldShowDateSeparator, MessageArtifactChips } from "../components/ChatArea";
import {
  getMemberDetail, getDmMessages, getDmSession, sendDmMessage, postConversationRead,
  type MemberDetail, type DmMessage, type DmSession,
} from "../api/client";
import { useWebSocket, type WsEvent } from "../hooks/useWebSocket";

const PAGE_SIZE = 50;
const toolBtn = "w-7 h-7 flex items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink-2 transition-colors cursor-pointer";

export function DmPage({ memberId, onBack, onOpenSettings }: { memberId: string; onBack: () => void; onOpenSettings?: (memberId: string) => void }) {
  const [member, setMember] = useState<MemberDetail | null>(null);
  const [session, setSession] = useState<DmSession | null>(null);
  const [messages, setMessages] = useState<DmMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);

  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);

  const load = useCallback(async () => {
    try {
      const [m, msgs, sess] = await Promise.all([
        getMemberDetail(memberId),
        getDmMessages(memberId, { limit: PAGE_SIZE }),
        getDmSession(memberId).catch(() => null),
      ]);
      setMember(m);
      setMessages(msgs.messages);
      setHasMore(msgs.messages.length >= PAGE_SIZE);
      setSession(sess);
      setError(null);
    } catch (err) {
      setError(String((err as Error)?.message || err));
    }
  }, [memberId]);

  useEffect(() => { void load(); }, [load]);

  // Realtime: member replies arrive as room:message on the synthetic dm:<id> room.
  const dmRoomId = `dm:${memberId}`;
  const handleWsEvent = useCallback(
    (event: WsEvent) => {
      if (event.type === "room:message" && event.roomId === dmRoomId) {
        const msg = event.message as DmMessage;
        setMessages((prev) => {
          if (prev?.some((m) => m.id === msg.id)) return prev;
          return [...(prev ?? []), msg];
        });
      }
    },
    [dmRoomId],
  );
  const { subscribeRoom, unsubscribeRoom } = useWebSocket({ onEvent: handleWsEvent });
  useEffect(() => {
    subscribeRoom(dmRoomId);
    return () => unsubscribeRoom(dmRoomId);
  }, [dmRoomId, subscribeRoom, unsubscribeRoom]);

  // Report read position — clears the user-cursor unread badge (contract v1.3).
  useEffect(() => {
    if (!messages) return;
    postConversationRead(`dm:${memberId}`).catch(() => {});
  }, [memberId, messages]);

  // Stick to bottom on new messages while the user is near the bottom.
  useEffect(() => {
    if (nearBottom.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const send = useCallback(
    async (text: string, attachments?: Array<{ storedFilename: string; originalFilename: string; size?: number }>) => {
      const msg = await sendDmMessage(memberId, text, attachments);
      setMessages((prev) => {
        if (prev?.some((m) => m.id === msg.id)) return prev;
        return [...(prev ?? []), msg];
      });
      nearBottom.current = true;
    },
    [memberId],
  );

  if (error && !member) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-3">
        <div className="text-center">
          <div className="text-sm font-medium text-ink-2 mb-1">Couldn’t load this member</div>
          <div className="text-xs text-blocked mb-2">{error}</div>
          <button type="button" onClick={onBack} className="text-xs text-accent-ink hover:underline cursor-pointer">Back to contacts</button>
        </div>
      </div>
    );
  }
  if (!member) return <div className="flex-1 flex items-center justify-center text-sm text-ink-3">Loading…</div>;

  const status = session?.status ?? "idle";
  const contextPct = session?.contextPct ?? null;

  return (
    <div className="flex-1 flex min-h-0 bg-surface-1">
      {/* conversation column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* header — room chat header language */}
        <div className="h-12 border-b border-line flex items-center gap-3 px-4 shrink-0 bg-surface-1">
          <div className="flex items-center gap-2.5 min-w-0">
            <StaffBadge name={member.name} status={statusFromAgent(status)} size="sm" />
            <h2 className="text-sm font-semibold tracking-tight text-ink-1 whitespace-nowrap">{member.name}</h2>
            <span className="text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded-full bg-accent-dim text-accent-ink">{member.agentTemplate}</span>
            <span className="text-[11px] text-ink-4">
              {status === "working" ? <span className="text-onair font-medium">● Working</span> : "Idle"}
            </span>
          </div>
          <div className="ml-auto flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setPanelOpen((v) => !v)}
              title="Member panel"
              className={`${toolBtn} ${panelOpen ? "bg-accent-dim text-accent-ink hover:bg-accent-dim hover:text-accent-ink" : ""}`}
            >
              <PanelRight size={13} />
            </button>
          </div>
        </div>

        {/* messages — room chat message language */}
        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto min-w-0 px-4 py-3">
          {!hasMore && messages && messages.length > 0 && (
            <div className="text-center text-xs text-ink-4 py-4">Beginning of conversation</div>
          )}
          {error && <div role="alert" className="text-[12px] text-blocked mb-2">{error}</div>}
          {!messages ? (
            <div className="text-sm text-ink-3 py-8 text-center">Loading…</div>
          ) : messages.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <p className="text-ink-3 text-lg">{member.name}</p>
                <p className="text-ink-4 text-sm mt-1">Say something — everything here activates {member.name} directly</p>
              </div>
            </div>
          ) : (
            <div>
              {messages.map((msg, i) => {
                const prev = i > 0 ? messages[i - 1] : null;
                const showDateSep = shouldShowDateSeparator(prev, msg);
                const grouped = isGroupedWithPrev(prev, msg);
                const time = new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
                const fullTime = new Date(msg.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
                return (
                  <div key={msg.id} data-message-id={msg.id}>
                    {showDateSep && <DateSeparator ts={msg.ts} />}
                    <MessageBubble
                      sender={msg.sender}
                      content={msg.content}
                      time={time}
                      fullTime={fullTime}
                      grouped={grouped}
                      isMarkdown={msg.sender !== "user" && msg.sender !== "system"}
                      mentions={msg.mentions}
                      roomId={`dm:${memberId}`}
                      messageId={msg.id}
                      attachments={msg.attachments}
                    />
                    {msg.artifacts?.length ? (
                      <MessageArtifactChips messageId={msg.id} artifacts={msg.artifacts} />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* composer — room MessageInput; no @ in DM (everything activates the member) */}
        <MessageInput
          onSend={send}
          members={[]}
          draftKey={`dm:${memberId}`}
          hideMentions
          uploadScope={`dm:${memberId}`}
          placeholder={`Message ${member.name}… (no @ needed in DM)`}
          onError={(m) => setError(`Couldn't send. ${m}`)}
        />
      </div>

      {/* member panel */}
      {panelOpen && (
        <aside className="w-[320px] shrink-0 border-l border-line-soft overflow-y-auto">
          <div className="p-4 space-y-4">
            {/* public zone */}
            <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
              <div className="flex items-center gap-3">
                <StaffBadge name={member.name} status={statusFromAgent(status)} size="lg" />
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] font-bold text-ink-1">{member.name}</div>
                  <div className="text-[11.5px] text-ink-3 mt-0.5">{member.agentTemplate} member</div>
                </div>
                {onOpenSettings && (
                  <button
                    type="button"
                    title="Member settings"
                    onClick={() => onOpenSettings(member.memberId)}
                    className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-ink-4 hover:text-ink-1 hover:bg-surface-2 cursor-pointer"
                  >
                    <Settings2 size={15} />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11.5px]">
                <Zone label="Template" value={member.agentTemplate} />
                <Zone label="Model" value={member.global?.model ?? "—"} mono />
                <Zone label="Unified" value={member.unifiedModel && member.unifiedExtensions ? "on" : "custom"} />
                <Zone label="Scopes" value="—" />
              </div>
              <div className="text-[11px] text-ink-4 leading-relaxed border-t border-line-soft pt-2.5">
                {member.unifiedModel ? "All scopes share the global model config." : "This member overrides model per scope."}
              </div>
            </section>

            {/* scope zone (this DM) */}
            <section className="rounded-xl border border-line bg-inset/50 p-4 space-y-3">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-ink-4 font-semibold">
                <Info size={12} /> This conversation (dm)
              </div>
              {contextPct != null ? (
                <div>
                  <div className="flex items-center justify-between text-xs text-ink-4 mb-1.5">
                    <span>Context used</span><span>{contextPct}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-surface-3 overflow-hidden">
                    <div className={`h-full rounded-full ${contextPct >= 80 ? "bg-blocked" : "bg-accent"}`} style={{ width: `${contextPct}%` }} />
                  </div>
                </div>
              ) : (
                <div className="text-[11.5px] text-ink-4">Context usage unavailable until the first turn runs.</div>
              )}
              <div className="text-[11.5px] text-ink-3 leading-relaxed">
                Memory layers active here: persona (global) → scope principles (dm) → mainline (dm) → chat history.
              </div>
            </section>
          </div>
        </aside>
      )}
    </div>
  );
}

function Zone({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-line-soft bg-surface-1 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-ink-4">{label}</div>
      <div className={`text-[12px] mt-0.5 truncate ${mono ? "tabular-nums" : ""} text-ink-2 font-medium`} title={value}>{value}</div>
    </div>
  );
}
