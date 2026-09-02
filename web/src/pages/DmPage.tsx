/**
 * DmPage — direct-message conversation with a member (scope = dm).
 * The chat surface is the room chat language instantiated for one member:
 * MessageBubble + date separators + 5-min grouping + MessageInput (Chat &
 * List Unification v1). The member panel is the SAME Sheet component the room
 * Header gear opens the member page scoped to this DM (member-page merge v1
 * — the room-side Sheet is retired; one member, one home).
 * Data: /api/members/:id, /api/dm/:memberId/{messages,session}; realtime via
 * WS room:message on dm:<memberId>.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { StaffBadge, statusFromAgent } from "../components/StaffBadge";
import { MessageBubble } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";
import { ModelPicker, type ModelPickerValue } from "../components/ModelPicker";
import { DateSeparator, isGroupedWithPrev, shouldShowDateSeparator, MessageArtifactChips } from "../components/ChatArea";
import { useDialog } from "../components/dialogs";
import { useMemberFloat } from "../components/member-float";
import {
  getMemberDetail, getDmMessages, getDmSession, sendDmMessage, postConversationRead,
  getMemberEffectiveConfig, getConfiguredModels, patchGlobalMember, patchMemberScopeConfig,
  type MemberDetail, type MemberInfo, type DmMessage, type DmSession,
  type AvailableModelOption,
} from "../api/client";
import { useWebSocket, type WsEvent } from "../hooks/useWebSocket";
import { getUsername } from "../api/client";

const PAGE_SIZE = 50;
const toolBtn = "w-7 h-7 flex items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink-2 transition-colors cursor-pointer";

export function DmPage({ memberId, onBack, onOpenMcpSettings, onOpenExtensionsSettings }: {
  memberId: string;
  onBack: () => void;
  onOpenMcpSettings?: () => void;
  onOpenExtensionsSettings?: () => void;
}) {
  const memberFloat = useMemberFloat();
  const [member, setMember] = useState<MemberDetail | null>(null);
  const [memberInfo, setMemberInfo] = useState<MemberInfo | null>(null);
  const [session, setSession] = useState<DmSession | null>(null);
  const [messages, setMessages] = useState<DmMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyQuote, setReplyQuote] = useState<{ seq: number; messageId: string; sender: string; excerpt: string } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [models, setModels] = useState<AvailableModelOption[]>([]);
  const { toast, confirm } = useDialog();

  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const dmScopeId = `dm:${memberId}`;

  // MemberInfo the shared panel expects = member identity + effective config
  // in this DM scope (model/thinking/mcp/extensions all scope-resolved).
  const refreshMemberInfo = useCallback(async (detail: MemberDetail) => {
    const eff = await getMemberEffectiveConfig(detail.memberId, dmScopeId).catch(() => null);
    setMemberInfo({
      id: detail.memberId,
      name: detail.name,
      agent: detail.agentTemplate,
      title: detail.title ?? null,
      model: eff?.model ?? detail.global?.model ?? null,
      credentialId: eff?.credentialId ?? detail.global?.credentialId ?? null,
      thinkingLevel: eff?.thinkingLevel ?? detail.global?.thinkingLevel ?? "",
      mcpServers: eff?.mcpServers ?? detail.global?.mcpServers ?? [],
      extensions: eff?.extensions ?? detail.global?.extensions ?? [],
      createdAt: detail.createdAt,
    });
  }, [dmScopeId]);

  const load = useCallback(async () => {
    try {
      const [m, msgs, sess] = await Promise.all([
        getMemberDetail(memberId),
        getDmMessages(memberId, { limit: PAGE_SIZE }),
        getDmSession(memberId).catch(() => null),
      ]);
      setMember(m);
      void refreshMemberInfo(m);
      setMessages(msgs.messages);
      setHasMore(msgs.messages.length >= PAGE_SIZE);
      setSession(sess);
      setError(null);
    } catch (err) {
      setError(String((err as Error)?.message || err));
    }
  }, [memberId, refreshMemberInfo]);

  useEffect(() => { void load(); }, [load]);

  // The no-model guidance card needs the model list without waiting for the panel.
  const noModel = !!memberInfo && !memberInfo.model;
  useEffect(() => {
    if (noModel) void getConfiguredModels().then(setModels).catch(() => {});
  }, [noModel]);


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
  const { subscribeRoom, unsubscribeRoom, connected, reconnecting } = useWebSocket({ onEvent: handleWsEvent });
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
    async (text: string, attachments?: Array<{ storedFilename: string; originalFilename: string; size?: number }>, replyTo?: { seq: number }) => {
      const msg = await sendDmMessage(memberId, text, attachments, replyTo);
      setMessages((prev) => {
        if (prev?.some((m) => m.id === msg.id)) return prev;
        return [...(prev ?? []), msg];
      });
      nearBottom.current = true;
    },
    [memberId],
  );

  // Jump to a specific message (mainline msg refs): scroll + pulse highlight
  // in DOM, or fetch an around-window from the server when not loaded.
  // Narrow screens: the docked Sheet covers the chat — close it first so the
  // jump target is visible (designer alignment 2026-08-05). Desktop keeps it
  // open, matching the room search-jump behavior.
  const jumpToMessage = useCallback(async (messageId: string): Promise<void> => {
    const alreadyLoaded = messages?.some((m) => m.id === messageId);
    if (!alreadyLoaded) {
      const window = await getDmMessages(memberId, { around: messageId, limit: PAGE_SIZE }).catch(() => null);
      if (!window || window.messages.length === 0) return;
      setMessages(window.messages);
      setHasMore(true);
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const el = scrollRef.current?.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      // Same pulse as the room search jump — one "jumped to a message" look.
      el.classList.add("message-pulse");
      setTimeout(() => el.classList.remove("message-pulse"), 1600);
    }
  }, [memberId, messages]);

  const handlePickModel = useCallback(async (v: ModelPickerValue) => {
    if (!member) return;
    try {
      const res = await patchMemberScopeConfig(member.memberId, dmScopeId, { model: v.model, credentialId: v.credentialId });
      setMember(res.member);
      await refreshMemberInfo(res.member);
      toast(`${member.name} model updated. It applies on the next turn.`, "success");
    } catch (err) {
      console.error("Failed to save model", err);
      toast("Couldn’t update the model. Try again.", "error");
    }
  }, [member, dmScopeId, refreshMemberInfo, toast]);

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

  return (
    <div className="flex-1 flex min-h-0 bg-surface-1">
      {/* conversation column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* header — room chat header language; member identity area opens the
            member page (member-page merge v1: one member, one home) */}
        <div className="h-12 border-b border-line flex items-center gap-3 px-4 shrink-0 bg-surface-1">
          <button
            type="button"
            onClick={() => memberFloat.open(member.memberId, dmScopeId)}
            title={`Open ${member.name}'s details`}
            className="flex items-center gap-2.5 min-w-0 rounded-lg px-2 py-1 -ml-2 hover:bg-surface-2 transition-colors cursor-pointer"
          >
            <StaffBadge name={member.name} status={statusFromAgent(status)} size="sm" />
            <h2 className="text-sm font-semibold tracking-tight text-ink-1 whitespace-nowrap">{member.name}</h2>
            {member.title ? <span className="text-[10px] font-semibold tracking-wide px-1.5 py-0.5 rounded-full bg-accent-dim text-accent-ink">{member.title}</span> : null}
            <span className="text-[11px] text-ink-4">
              {status === "working" ? <span className="text-onair font-medium">● Working</span> : "Idle"}
            </span>
          </button>
          <div className="ml-auto flex items-center gap-1 shrink-0">
            <span className="flex items-center gap-1.5 mr-1.5" title={connected ? "Connected" : reconnecting ? "Reconnecting" : "Disconnected"}>
              {reconnecting && <span className="text-[10px] text-think animate-pulse hidden sm:block">reconnecting</span>}
              {!connected && !reconnecting && <span className="text-[10px] text-blocked hidden sm:block">offline</span>}
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${connected ? "bg-onair" : reconnecting ? "bg-think animate-pulse" : "bg-blocked"}`} />
              {connected && <span className="text-[10px] text-ink-4 hidden sm:block">live</span>}
            </span>
            <button onClick={() => { setSearchOpen(v => !v); setSearchQuery(""); }} className={toolBtn} title="Search messages">
              <Search size={13} />
            </button>
            {/* Header gear opens the member detail float scoped to this DM
             * (member-page merge v2, fish 2026-09-02: float, not full page). */}
            <button
              type="button"
              onClick={() => memberFloat.open(member.memberId, dmScopeId)}
              title="Member details — identity, activity, settings"
              className={toolBtn}
            >
              <SlidersHorizontal size={13} />
            </button>
          </div>
        </div>

        {/* DM search bar — client-side filter (DM conversations are small enough) */}
        {searchOpen && (
          <div className="border-b border-line px-4 py-2 flex items-center gap-2 bg-surface-1 shrink-0">
            <Search size={13} className="text-ink-4 shrink-0" />
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter messages…"
              className="flex-1 bg-transparent text-[13px] text-ink-1 placeholder:text-ink-4 outline-none"
            />
            {searchQuery && <span className="text-[10px] text-ink-4 shrink-0">{messages ? messages.filter(m => (m.content || "").toLowerCase().includes(searchQuery.toLowerCase())).length : 0} matches</span>}
            <button onClick={() => { setSearchOpen(false); setSearchQuery(""); }} className={toolBtn} title="Close search">
              <X size={13} />
            </button>
          </div>
        )}

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
                {noModel ? (
                  <NoModelCard name={member.name} models={models} onPick={(v) => void handlePickModel(v)} />
                ) : (
                  <p className="text-ink-4 text-sm mt-1">Say something — everything here activates {member.name} directly</p>
                )}
              </div>
            </div>
          ) : (
            <div>
              {(searchOpen && searchQuery.trim() ? messages.filter(m => (m.content || "").toLowerCase().includes(searchQuery.toLowerCase())) : messages).map((msg, i, arr) => {
                const list = searchOpen && searchQuery.trim() ? arr : messages;
                const prev = i > 0 ? list[i - 1] : null;
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
                        members={[member.name]}
                        loginName={getUsername()}
                      roomId={`dm:${memberId}`}
                      messageId={msg.id}
                      attachments={msg.attachments}
                      quote={resolveDmQuote(messages ?? [], msg)}
                      onJumpToMessage={(targetId) => void jumpToMessage(targetId)}
                      onReply={msg.sender !== "system" ? () => setReplyQuote({
                        seq: msg.seq ?? 0,
                        messageId: msg.id,
                        sender: msg.sender === "user" ? "you" : msg.sender,
                        excerpt: (msg.content || "").split("\n").find((l) => l.trim())?.slice(0, 60) ?? "",
                      }) : undefined}
                    />
                    {msg.artifacts?.length ? (
                      <MessageArtifactChips messageId={msg.id} artifacts={msg.artifacts} />
                    ) : null}
                  </div>
                );
              })}
              {noModel && <NoModelCard name={member.name} models={models} onPick={(v) => void handlePickModel(v)} />}
            </div>
          )}
        </div>

        {/* composer — room MessageInput; no @ in DM (everything activates the member) */}
        <MessageInput
          onSend={(text, atts) => { const q = replyQuote; setReplyQuote(null); return send(text, atts, q ? { seq: q.seq } : undefined); }}
          members={[]}
          draftKey={`dm:${memberId}`}
          hideMentions
          uploadScope={`dm:${memberId}`}
          placeholder={`Message ${member.name}… (no @ needed in DM)`}
          onError={(m) => setError(`Couldn't send. ${m}`)}
          quote={replyQuote}
          onClearQuote={() => setReplyQuote(null)}
        />
      </div>

    </div>
  );
}

/** Resolve a quote target against loaded DM messages (plan-reply-to-v1). */
function resolveDmQuote(messages: DmMessage[], msg: DmMessage): { seq: number; messageId: string; sender?: string; excerpt?: string } | undefined {
  if (!msg.replyTo) return undefined;
  const target = messages.find((m) => m.id === msg.replyTo!.messageId) ?? messages.find((m) => m.seq === msg.replyTo!.seq);
  if (!target) return { seq: msg.replyTo.seq, messageId: msg.replyTo.messageId };
  const firstLine = String(target.content || "").split("\n").find((l) => l.trim()) ?? "";
  return { seq: msg.replyTo.seq, messageId: msg.replyTo.messageId, sender: target.sender === "user" ? "you" : target.sender, excerpt: firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine };
}

/** No-model guidance as a STREAM card, not page chrome (fish 2026-08-25: "pick
 * 模型做成一条聊天消息的形式"). System voice, never the member's — a model-less
 * member cannot speak yet, so a fake first-person message would be a lie; the
 * member's real first message is the icebreak that follows model setup. The
 * card disappears the moment a model saves. */
function NoModelCard({ name, models, onPick }: {
  name: string;
  models: AvailableModelOption[];
  onPick: (v: ModelPickerValue) => void;
}) {
  return (
    <div className="mx-auto my-3 max-w-[380px] rounded-xl border border-accent/30 bg-accent-dim/15 px-4 py-3.5 text-left" role="status">
      <div className="text-[9.5px] font-extrabold tracking-[0.08em] uppercase text-ink-4 mb-1.5">System</div>
      <p className="text-[12.5px] text-ink-2 leading-relaxed">
        <span className="font-semibold text-ink-1">{name}</span> has no model yet — it can't think or reply until you pick one.
      </p>
      <div className="mt-2.5">
        <ModelPicker
          value={{ model: null, credentialId: null }}
          models={models}
          emptyLabel="Pick a model…"
          onChange={(v) => { if (v.model) onPick(v); }}
        />
      </div>
    </div>
  );
}
