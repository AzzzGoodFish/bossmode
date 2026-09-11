import {
  useMemberProfileRevision,
  getMemberProfileRevision,
} from "../hooks/useMemberProfileRevision";
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
import { Search, SlidersHorizontal, X, Menu } from "lucide-react";
import { ChatAvatar, memberStateLabel } from "../components/ChatAvatar";
import { ChatMemberPeek } from "../components/ChatMemberPeek";
import { MessageBubble } from "../components/MessageBubble";
import { MessageInput } from "../components/MessageInput";
import { ModelPicker, type ModelPickerValue } from "../components/ModelPicker";
import {
  DateSeparator,
  isGroupedWithPrev,
  shouldShowDateSeparator,
  MessageArtifactChips,
} from "../components/ChatArea";
import { useDialog } from "../components/dialogs";
import {
  getMemberDetail,
  getDmMessages,
  getDmSession,
  sendDmMessage,
  postConversationRead,
  getConfiguredModels,
  patchGlobalMember,
  type MemberDetail,
  type MemberInfo,
  type DmMessage,
  type DmSession,
  type AvailableModelOption,
} from "../api/client";
import { useWebSocket, type WsEvent } from "../hooks/useWebSocket";
import { getUsername } from "../api/client";

const PAGE_SIZE = 50;
const toolBtn =
  "w-7 h-7 flex items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink-2 transition-colors cursor-pointer";

export function DmPage({
  memberId,
  onBack,
  onOpenMobileSidebar,
  onLiveStatus,
}: {
  memberId: string;
  onBack: () => void;
  onOpenMobileSidebar?: () => void;
  onLiveStatus?: (scope: string, memberId: string, status: string) => void;
}) {
  const [peekOpen, setPeekOpen] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<string | null>(null);
  const onLiveStatusRef = useRef(onLiveStatus);
  onLiveStatusRef.current = onLiveStatus;
  const [member, setMember] = useState<MemberDetail | null>(null);
  const [memberInfo, setMemberInfo] = useState<MemberInfo | null>(null);
  const [session, setSession] = useState<DmSession | null>(null);
  const [messages, setMessages] = useState<DmMessage[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replyQuote, setReplyQuote] = useState<{
    seq: number;
    messageId: string;
    sender: string;
    senderMemberId?: string;
    excerpt: string;
  } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [models, setModels] = useState<AvailableModelOption[]>([]);
  const { toast, confirm } = useDialog();

  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const viewportSize = useRef({ width: 0, height: 0 });
  const dmScopeId = `dm:${memberId}`;

  // MemberInfo the shared panel expects = member identity + global config
  // (batch 5b: config is globally unified, no scope resolution anymore).
  const refreshMemberInfo = useCallback(async (detail: MemberDetail) => {
    setMemberInfo({
      id: detail.memberId,
      name: detail.name,
      agent: detail.agentTemplate,
      title: detail.title ?? null,
      model: detail.global?.model ?? null,
      credentialId: detail.global?.credentialId ?? null,
      thinkingLevel: detail.global?.thinkingLevel ?? "",
      mcpServers: detail.global?.mcpServers ?? [],
      createdAt: detail.createdAt,
    });
  }, []);

  const load = useCallback(async () => {
    const revisionAtLoad = getMemberProfileRevision(memberId);
    try {
      const [m, msgs, sess] = await Promise.all([
        getMemberDetail(memberId),
        getDmMessages(memberId, { limit: PAGE_SIZE }),
        getDmSession(memberId).catch(() => null),
      ]);
      if (revisionAtLoad === getMemberProfileRevision(memberId)) {
        setMember(m);
        void refreshMemberInfo(m);
      }
      setMessages(msgs.messages);
      setHasMore(msgs.messages.length >= PAGE_SIZE);
      setSession(sess);
      setError(null);
    } catch (err) {
      setError(String((err as Error)?.message || err));
    }
  }, [memberId, refreshMemberInfo]);

  useEffect(() => {
    void load();
  }, [load]);

  const profileRevision = useMemberProfileRevision(memberId);
  useEffect(() => {
    if (!profileRevision) return;
    let active = true;
    getMemberDetail(memberId)
      .then((detail) => {
        if (!active) return;
        setMember(detail);
        void refreshMemberInfo(detail);
      })
      .catch(console.error);
    return () => {
      active = false;
    };
  }, [memberId, profileRevision, refreshMemberInfo]);

  // The no-model guidance card needs the model list without waiting for the panel.
  const noModel = !!memberInfo && !memberInfo.model;
  useEffect(() => {
    if (noModel)
      void getConfiguredModels()
        .then(setModels)
        .catch(() => {});
  }, [noModel]);

  // Realtime: member replies arrive as room:message on the synthetic dm:<id> room.
  const dmRoomId = `dm:${memberId}`;
  const handleWsEvent = useCallback(
    (event: WsEvent) => {
      if (event.type === "agent:status" && event.roomId === dmRoomId) {
        setRuntimeStatus(event.status);
        onLiveStatusRef.current?.(dmRoomId, memberId, event.status);
      }
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
  const { subscribeRoom, unsubscribeRoom, connected, reconnecting } =
    useWebSocket({ onEvent: handleWsEvent });
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
    if (nearBottom.current)
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const layoutChanged =
      el.clientWidth !== viewportSize.current.width ||
      el.clientHeight !== viewportSize.current.height;
    viewportSize.current = { width: el.clientWidth, height: el.clientHeight };
    if (layoutChanged && nearBottom.current) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (nearBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    const content = el.querySelector(".bm-message-flow");
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [!!member, !!messages]);

  const send = useCallback(
    async (
      text: string,
      attachments?: Array<{
        storedFilename: string;
        originalFilename: string;
        size?: number;
      }>,
      replyTo?: { seq: number },
    ) => {
      const msg = await sendDmMessage(memberId, text, attachments, replyTo);
      setMessages((prev) => {
        if (prev?.some((m) => m.id === msg.id)) return prev;
        return [...(prev ?? []), msg];
      });
      nearBottom.current = true;
      window.dispatchEvent(new Event("bossmode:conversations-changed"));
    },
    [memberId],
  );

  // Jump to a specific message (mainline msg refs): scroll + pulse highlight
  // in DOM, or fetch an around-window from the server when not loaded.
  // Narrow screens: the docked Sheet covers the chat — close it first so the
  // jump target is visible (designer alignment 2026-08-05). Desktop keeps it
  // open, matching the room search-jump behavior.
  const jumpToMessage = useCallback(
    async (messageId: string): Promise<void> => {
      const alreadyLoaded = messages?.some((m) => m.id === messageId);
      if (!alreadyLoaded) {
        const window = await getDmMessages(memberId, {
          around: messageId,
          limit: PAGE_SIZE,
        }).catch(() => null);
        if (!window || window.messages.length === 0) return;
        setMessages(window.messages);
        setHasMore(true);
      }
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)),
      );
      const el = scrollRef.current?.querySelector(
        `[data-message-id="${messageId}"]`,
      ) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        // Same pulse as the room search jump — one "jumped to a message" look.
        el.classList.add("message-pulse");
        setTimeout(() => el.classList.remove("message-pulse"), 1600);
      }
    },
    [memberId, messages],
  );

  const handlePickModel = useCallback(
    async (v: ModelPickerValue) => {
      if (!member) return;
      try {
        const res = await patchGlobalMember(member.memberId, {
          model: v.model,
          credentialId: v.credentialId,
        });
        setMember(res.member);
        await refreshMemberInfo(res.member);
        toast(
          `${member.name} model updated. It applies on the next turn.`,
          "success",
        );
      } catch (err) {
        console.error("Failed to save model", err);
        toast("Couldn’t update the model. Try again.", "error");
      }
    },
    [member, refreshMemberInfo, toast],
  );

  if (error && !member) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-3">
        <div className="text-center">
          <div className="text-sm font-medium text-ink-2 mb-1">
            暂时无法加载这位成员
          </div>
          <div className="text-xs text-blocked mb-2">{error}</div>
          <button
            type="button"
            onClick={onBack}
            className="text-xs text-accent-ink hover:underline cursor-pointer"
          >
            返回会话
          </button>
        </div>
      </div>
    );
  }
  if (!member)
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-ink-3">
        正在加载…
      </div>
    );

  const status = runtimeStatus ?? session?.status;

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-surface-0">
      <header className="bm-chat-header">
        <button
          className="bm-icon-btn bm-mobile-nav"
          onClick={onOpenMobileSidebar}
          aria-label="打开会话导航"
        >
          <Menu size={20} />
        </button>
        <button
          className="bm-chat-title"
          onClick={() => setPeekOpen((v) => !v)}
          title="查看成员详情"
        >
          <ChatAvatar name={member.name} identity={memberId} status={status} />
          <span>
            <h1>{member.name}</h1>
            <span className="bm-chat-subtitle">
              私聊 · {memberStateLabel(status)}
            </span>
          </span>
        </button>
        <div className="bm-header-right">
          {!connected && (
            <span
              className="bm-header-connection text-[10px] text-blocked"
              role="status"
            >
              {reconnecting ? "正在重连" : "连接已断开"}
            </span>
          )}
          <button
            className="bm-icon-btn"
            onClick={() => {
              setSearchOpen((v) => !v);
              setSearchQuery("");
            }}
            aria-label="搜索本会话"
          >
            <Search size={18} />
          </button>
          <button
            className="bm-icon-btn"
            onClick={() => setPeekOpen((v) => !v)}
            aria-label="查看成员详情"
          >
            <SlidersHorizontal size={18} />
          </button>
        </div>
      </header>
      <div className="bm-chat-content">
        <div className="bm-conversation-column">
          {/* DM search bar — client-side filter (DM conversations are small enough) */}
          {searchOpen && (
            <div className="border-b border-line px-4 py-2 flex items-center gap-2 bg-surface-1 shrink-0">
              <Search size={13} className="text-ink-4 shrink-0" />
              <input
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索当前已加载的消息"
                className="flex-1 bg-transparent text-[13px] text-ink-1 placeholder:text-ink-4 outline-none"
              />
              {searchQuery && (
                <span className="text-[10px] text-ink-4 shrink-0">
                  {messages
                    ? messages.filter((m) =>
                        (m.content || "")
                          .toLowerCase()
                          .includes(searchQuery.toLowerCase()),
                      ).length
                    : 0}{" "}
                  matches
                </span>
              )}
              <button
                onClick={() => {
                  setSearchOpen(false);
                  setSearchQuery("");
                }}
                className={toolBtn}
                title="Close search"
              >
                <X size={13} />
              </button>
            </div>
          )}

          {/* messages — room chat message language */}
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="bm-scroll-messages"
          >
            {!hasMore && messages && messages.length > 0 && (
              <div className="text-center text-xs text-ink-4 py-4">
                会话从这里开始
              </div>
            )}
            {error && (
              <div role="alert" className="text-[12px] text-blocked mb-2">
                {error}
              </div>
            )}
            {!messages ? (
              <div className="text-sm text-ink-3 py-8 text-center">
                正在加载…
              </div>
            ) : messages.length === 0 ? (
              <div className="h-full flex items-center justify-center">
                <div className="text-center">
                  <p className="text-ink-3 text-lg">{member.name}</p>
                  {noModel ? (
                    <NoModelCard
                      name={member.name}
                      models={models}
                      onPick={(v) => void handlePickModel(v)}
                    />
                  ) : (
                    <p className="text-ink-4 text-sm mt-1">
                      发一句开始聊吧，私聊会直接叫到 {member.name}。
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="bm-message-flow">
                {(searchOpen && searchQuery.trim()
                  ? messages.filter((m) =>
                      (m.content || "")
                        .toLowerCase()
                        .includes(searchQuery.toLowerCase()),
                    )
                  : messages
                ).map((msg, i, arr) => {
                  const list =
                    searchOpen && searchQuery.trim() ? arr : messages;
                  const prev = i > 0 ? list[i - 1] : null;
                  const showDateSep = shouldShowDateSeparator(prev, msg);
                  const grouped = isGroupedWithPrev(prev, msg);
                  const time = new Date(msg.ts).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  });
                  const fullTime = new Date(msg.ts).toLocaleTimeString(
                    "zh-CN",
                    { hour: "2-digit", minute: "2-digit", second: "2-digit" },
                  );
                  return (
                    <div key={msg.id} data-message-id={msg.id}>
                      {showDateSep && <DateSeparator ts={msg.ts} />}
                      <MessageBubble
                        sender={msg.sender}
                        senderMemberId={msg.senderMemberId}
                        onAuthorClick={
                          msg.sender !== "user" && msg.sender !== "system"
                            ? () => setPeekOpen(true)
                            : undefined
                        }
                        content={msg.content}
                        time={time}
                        fullTime={fullTime}
                        grouped={grouped}
                        isMarkdown={
                          msg.sender !== "user" && msg.sender !== "system"
                        }
                        mentions={msg.mentions}
                        members={[member.name]}
                        loginName={getUsername()}
                        roomId={`dm:${memberId}`}
                        messageId={msg.id}
                        attachments={msg.attachments}
                        quote={resolveDmQuote(messages ?? [], msg)}
                        onJumpToMessage={(targetId) =>
                          void jumpToMessage(targetId)
                        }
                        onReply={
                          msg.sender !== "system"
                            ? () =>
                                setReplyQuote({
                                  seq: msg.seq ?? 0,
                                  messageId: msg.id,
                                  sender:
                                    msg.sender === "user" ? "you" : msg.sender,
                                  senderMemberId: msg.senderMemberId,
                                  excerpt:
                                    (msg.content || "")
                                      .split("\n")
                                      .find((l) => l.trim())
                                      ?.slice(0, 60) ?? "",
                                })
                            : undefined
                        }
                      />
                      {msg.artifacts?.length ? (
                        <MessageArtifactChips
                          messageId={msg.id}
                          artifacts={msg.artifacts}
                        />
                      ) : null}
                    </div>
                  );
                })}
                {noModel && (
                  <NoModelCard
                    name={member.name}
                    models={models}
                    onPick={(v) => void handlePickModel(v)}
                  />
                )}
              </div>
            )}
          </div>

          {/* composer — room MessageInput; no @ in DM (everything activates the member) */}
          {status === "working" && (
            <div className="bm-work-note" role="status">
              {member.name} 正在工作
            </div>
          )}
          <MessageInput
            scopeLabel={member.name}
            onSend={async (text, atts) => {
              const q = replyQuote;
              await send(text, atts, q ? { seq: q.seq } : undefined);
              setReplyQuote(null);
            }}
            members={[]}
            draftKey={`dm:${memberId}`}
            hideMentions
            uploadScope={`dm:${memberId}`}
            placeholder={`给 ${member.name} 发消息`}
            onError={(m) => setError(`Couldn't send. ${m}`)}
            quote={replyQuote}
            onClearQuote={() => setReplyQuote(null)}
          />
        </div>
        {peekOpen && (
          <ChatMemberPeek
            memberId={memberId}
            scopeId={dmScopeId}
            status={status}
            onClose={() => setPeekOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

/** Resolve a quote target against loaded DM messages (plan-reply-to-v1). */
function resolveDmQuote(
  messages: DmMessage[],
  msg: DmMessage,
):
  | {
      seq: number;
      messageId: string;
      sender?: string;
      senderMemberId?: string;
      excerpt?: string;
    }
  | undefined {
  if (!msg.replyTo) return undefined;
  const target =
    messages.find((m) => m.id === msg.replyTo!.messageId) ??
    messages.find((m) => m.seq === msg.replyTo!.seq);
  if (!target)
    return { seq: msg.replyTo.seq, messageId: msg.replyTo.messageId };
  const firstLine =
    String(target.content || "")
      .split("\n")
      .find((l) => l.trim()) ?? "";
  return {
    seq: msg.replyTo.seq,
    messageId: msg.replyTo.messageId,
    sender: target.sender === "user" ? "you" : target.sender,
    senderMemberId: target.senderMemberId,
    excerpt: firstLine.length > 80 ? firstLine.slice(0, 80) + "…" : firstLine,
  };
}

/** No-model guidance as a STREAM card, not page chrome (fish 2026-08-25: "pick
 * 模型做成一条聊天消息的形式"). System voice, never the member's — a model-less
 * member cannot speak yet, so a fake first-person message would be a lie; the
 * member's real first message is the icebreak that follows model setup. The
 * card disappears the moment a model saves. */
function NoModelCard({
  name,
  models,
  onPick,
}: {
  name: string;
  models: AvailableModelOption[];
  onPick: (v: ModelPickerValue) => void;
}) {
  return (
    <div
      className="mx-auto my-3 max-w-[380px] rounded-xl border border-accent/30 bg-accent-dim/15 px-4 py-3.5 text-left"
      role="status"
    >
      <div className="text-[9.5px] font-extrabold tracking-[0.08em] uppercase text-ink-4 mb-1.5">
        System
      </div>
      <p className="text-[12.5px] text-ink-2 leading-relaxed">
        <span className="font-semibold text-ink-1">{name}</span> has no model
        yet — it can't think or reply until you pick one.
      </p>
      <div className="mt-2.5">
        <ModelPicker
          value={{ model: null, credentialId: null }}
          models={models}
          emptyLabel="Pick a model…"
          onChange={(v) => {
            if (v.model) onPick(v);
          }}
        />
      </div>
    </div>
  );
}
