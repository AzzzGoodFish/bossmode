import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, BookOpen, FileText, ShieldCheck, Plus, Pencil, ArrowRight, Trash2, Eye } from "lucide-react";
import type { RoomMessage, TaskEventMeta, KnowledgeEventMeta, GateEventMeta, RoomMessageAttachment } from "../api/client";
import { decideGate } from "../api/client";
import { Markdown } from "./Markdown";
import { useDialog } from "./dialogs";
import { MessageBubble } from "./MessageBubble";
import { SummaryCard } from "./SummaryCard";
import { MessageSearchBar } from "./MessageSearchBar";
import type { GateArtifactPreviewState, ChatAttachmentPreviewState } from "./ArtifactPreviewPanel";

interface ChatAreaProps {
  messages: RoomMessage[];
  roomName: string;
  roomId?: string;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => Promise<void>;
  searchOpen?: boolean;
  onCloseSearch?: () => void;
  members?: string[];
  onNavigateToTask?: (taskId: string) => void;
  onNavigateToKnowledge?: (path: string) => void;
  onPreviewArtifact?: (preview: GateArtifactPreviewState) => void;
  onPreviewAttachment?: (preview: ChatAttachmentPreviewState) => void;
  activeArtifactPreview?: { gateId: string; selectedIndex: number } | null;
  activeAttachmentPreview?: { messageId: string; storedFilename: string } | null;
  onJumpToMessage?: (messageId: string) => Promise<void>;
  onReturnToLatest?: () => void;
  inHistoryView?: boolean;
}

const GROUP_INTERVAL_MS = 5 * 60 * 1000;

export function ChatArea({ messages, roomName, roomId, hasMore, loadingOlder, onLoadOlder, searchOpen, onCloseSearch, members, onNavigateToTask, onNavigateToKnowledge, onPreviewArtifact, onPreviewAttachment, activeArtifactPreview, activeAttachmentPreview, onJumpToMessage, onReturnToLatest, inHistoryView }: ChatAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevMsgCount = useRef(messages.length);
  const isNearBottom = useRef(true);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);

  // Gates already decided — derived from later gate_event messages in the stream,
  // so old "requested" cards render read-only without polling.
  const decidedGateIds = new Set<string>();
  for (const m of messages) {
    if (m.type === "gate_event" && m.gate_event_meta && m.gate_event_meta.action !== "requested") {
      decidedGateIds.add(m.gate_event_meta.gateId);
    }
  }

  const scrollToMessage = useCallback(async (messageId: string) => {
    let el = containerRef.current?.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
    if (!el && onJumpToMessage) {
      // Message not in DOM — fetch around window from server
      await onJumpToMessage(messageId);
      // Wait for React to render the new messages
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      el = containerRef.current?.querySelector(`[data-message-id="${messageId}"]`) as HTMLElement | null;
    }
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      setHighlightedId(messageId);
      setTimeout(() => setHighlightedId(null), 1500);
    }
    // Search bar stays open — user closes via X / Esc
  }, [onJumpToMessage]);

  // Auto-scroll to bottom on new messages (only if user was near bottom)
  useEffect(() => {
    const added = messages.length - prevMsgCount.current;
    if (added > 0 && added < 5 && isNearBottom.current) {
      // New message appended — scroll to bottom
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevMsgCount.current = messages.length;
  }, [messages.length]);

  // Initial scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView();
  }, [roomName]);

  // Track newly prepended messages for slide-in animation
  const [newPrependCount, setNewPrependCount] = useState(0);
  const prevMsgIds = useRef<Set<string>>(new Set());

  // Scroll position preservation when older messages are prepended
  const prevScrollHeight = useRef(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !loadingOlder) return;
    prevScrollHeight.current = el.scrollHeight;
  }, [loadingOlder]);

  useEffect(() => {
    if (loadingOlder === false && prevScrollHeight.current > 0) {
      const el = containerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight - prevScrollHeight.current;
        prevScrollHeight.current = 0;
      }
      // Detect prepended messages
      const currentIds = new Set(messages.map((m) => m.id));
      let prepended = 0;
      for (const msg of messages) {
        if (!prevMsgIds.current.has(msg.id)) prepended++;
        else break; // first known message = end of prepended block
      }
      if (prepended > 0) {
        setNewPrependCount(prepended);
        setTimeout(() => setNewPrependCount(0), 600); // clear after animation (250ms anim + 300ms max stagger)
      }
      prevMsgIds.current = currentIds;
    }
  }, [messages, loadingOlder]);

  // Keep prevMsgIds in sync on normal appends
  useEffect(() => {
    prevMsgIds.current = new Set(messages.map((m) => m.id));
  }, [messages]);

  // Scroll handler — detect near-top for loading older (debounced), track near-bottom
  const loadOlderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;

    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;

    // Load older when at top — debounced 300ms buffer
    if (el.scrollTop === 0 && hasMore && !loadingOlder && onLoadOlder) {
      if (!loadOlderTimer.current) {
        loadOlderTimer.current = setTimeout(() => {
          loadOlderTimer.current = null;
          if (containerRef.current && containerRef.current.scrollTop === 0) onLoadOlder();
        }, 300);
      }
    } else if (loadOlderTimer.current) {
      clearTimeout(loadOlderTimer.current);
      loadOlderTimer.current = null;
    }
  }, [hasMore, loadingOlder, onLoadOlder]);

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const stickToBottomIfNeeded = () => {
      if (isNearBottom.current) {
        container.scrollTop = container.scrollHeight;
      }
    };

    const contentRO = new ResizeObserver(stickToBottomIfNeeded);
    contentRO.observe(content);

    const containerRO = new ResizeObserver(stickToBottomIfNeeded);
    containerRO.observe(container);

    return () => {
      contentRO.disconnect();
      containerRO.disconnect();
    };
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0">
      {searchOpen && roomId && (
        <MessageSearchBar
          roomId={roomId}
          members={members ?? []}
          onJumpToMessage={scrollToMessage}
          onClose={() => onCloseSearch?.()}
        />
      )}
      <div ref={containerRef} className="flex-1 overflow-y-auto min-w-0 px-4 py-3" onScroll={handleScroll}>
      <div ref={contentRef}>
        {/* Top indicator */}
        {hasMore === false && messages.length > 0 && (
          <div className="text-center text-xs text-ink-4 py-4">Beginning of conversation</div>
        )}
        {loadingOlder && (
          <div className="flex items-center justify-center gap-1.5 py-3">
            <Loader2 size={14} className="animate-spin text-ink-4" />
            <span className="text-[11px] text-ink-4">Loading earlier messages</span>
          </div>
        )}

        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <p className="text-ink-3 text-lg"># {roomName}</p>
              <p className="text-ink-4 text-sm mt-1">
                Start a conversation by sending a message
              </p>
            </div>
          </div>
        ) : (
          <div>
            {messages.map((msg, i) => {
              const prev = i > 0 ? messages[i - 1] : null;
              const showDateSep = shouldShowDateSeparator(prev, msg);
              const grouped = isGroupedWithPrev(prev, msg);

              const time = new Date(msg.ts).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              });
              const fullTime = new Date(msg.ts).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              });

              const isNewPrepend = i < newPrependCount;
              const animDelay = isNewPrepend ? `${Math.min(i, 10) * 30}ms` : undefined;

              return (
                <div key={msg.id} data-message-id={msg.id} className={`${isNewPrepend ? "msg-enter" : ""} ${highlightedId === msg.id ? "message-pulse" : ""}`} style={animDelay ? { animationDelay: animDelay } : undefined}>
                  {showDateSep && <DateSeparator ts={msg.ts} />}
                  {msg.type === "task_event" && msg.task_event_meta ? (
                    <TaskEventCard meta={msg.task_event_meta} content={msg.content} mentions={msg.mentions} onJump={onNavigateToTask ? () => onNavigateToTask(msg.task_event_meta!.taskId) : undefined} />
                  ) : msg.type === "knowledge_event" && msg.knowledge_event_meta ? (
                    <KnowledgeEventCard meta={msg.knowledge_event_meta} onJump={onNavigateToKnowledge ? () => onNavigateToKnowledge(msg.knowledge_event_meta!.path) : undefined} />
                  ) : msg.type === "gate_event" && msg.gate_event_meta ? (
                    <GateEventCard meta={msg.gate_event_meta} roomId={roomId} decided={msg.gate_event_meta.action === "requested" ? decidedGateIds.has(msg.gate_event_meta.gateId) : true} onNavigateToKnowledge={onNavigateToKnowledge} onPreviewArtifact={onPreviewArtifact} activeArtifactPreview={activeArtifactPreview} />
                  ) : msg.type === "summary" ? (
                    <SummaryCard message={msg} roomId={roomId || ""} />
                  ) : (
                    <MessageBubble
                      sender={msg.sender}
                      content={msg.content}
                      time={time}
                      fullTime={fullTime}
                      grouped={grouped}
                      isMarkdown={msg.sender !== "user" && msg.sender !== "system"}
                      roomId={roomId}
                      messageId={msg.id}
                      attachments={msg.attachments}
                      activeAttachmentPreview={activeAttachmentPreview}
                      onPreviewAttachment={roomId && onPreviewAttachment ? (messageId: string, attachments: RoomMessageAttachment[], selectedIndex: number) => onPreviewAttachment({ kind: "attachment", messageId, title: "Attachment preview", attachments, selectedIndex }) : undefined}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      {inHistoryView && onReturnToLatest && (
        <div className="absolute bottom-4 right-4 z-10">
          <button
            onClick={onReturnToLatest}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-accent text-accent-contrast rounded-full shadow-lg hover:opacity-90 transition-opacity"
          >
            ↓ Jump to latest
          </button>
        </div>
      )}
    </div>
    </div>
  );
}

function TaskEventCard({ meta, content, mentions, onJump }: { meta: TaskEventMeta; content: string; mentions?: string[]; onJump?: () => void }) {
  const Icon = meta.action === "created" ? Plus : meta.action === "deleted" ? Trash2 : meta.action === "status_changed" ? ArrowRight : Pencil;
  const activatedAgent = mentions?.length ? mentions[0] : null;
  return (
    <div className="border border-line rounded-lg px-3 py-2 mt-3 bg-surface-0/40">
      <div className="flex items-center gap-2 text-xs text-ink-3">
        <Icon size={13} className="text-ink-4 shrink-0" />
        <span className="flex-1">
          {onJump && meta.action !== "deleted" ? (
            <button onClick={onJump} className="text-accent-ink hover:opacity-80 cursor-pointer underline-offset-2 hover:underline">
              {content}
            </button>
          ) : (
            content
          )}
        </span>
        {meta.newStatus && (
          <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-surface-2 text-ink-3">
            {meta.newStatus}
          </span>
        )}
      </div>
      {meta.snippet && (
        <div className="mt-1.5 pl-6 text-xs text-ink-4 border-l-2 border-line ml-1 leading-relaxed">{meta.snippet}</div>
      )}
      {activatedAgent && (
        <div className="mt-1 text-[10px] text-ink-4">→ assigned to @{activatedAgent}</div>
      )}
    </div>
  );
}

/** 📚 agent 写了知识库文档 — 记录自动成为沟通 */
function KnowledgeEventCard({ meta, onJump }: { meta: KnowledgeEventMeta; onJump?: () => void }) {
  const verb = meta.tool === "write" ? "更新了文档" : "修改了文档";
  return (
    <div className="border border-line rounded-lg px-3 py-2 mt-3 bg-surface-0/40">
      <div className="flex items-center gap-2 text-xs text-ink-3">
        <BookOpen size={13} className="text-accent-ink shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="font-medium text-ink-2">{meta.actor}</span> {verb}{" "}
          {onJump ? (
            <button onClick={onJump} className="text-accent-ink hover:opacity-80 cursor-pointer underline-offset-2 hover:underline">
              {meta.title}
            </button>
          ) : (
            <span className="text-ink-2">{meta.title}</span>
          )}
        </span>
        <span className="font-mono text-[10px] text-ink-4 truncate max-w-[200px]" title={meta.path}>{meta.path}</span>
      </div>
    </div>
  );
}

/** 🛡 阶段交付验收卡 — 批准即移交，打回即反馈 */
function GateEventCard({ meta, roomId, decided, onNavigateToKnowledge, onPreviewArtifact, activeArtifactPreview }: { meta: GateEventMeta; roomId?: string; decided: boolean; onNavigateToKnowledge?: (path: string) => void; onPreviewArtifact?: (preview: GateArtifactPreviewState) => void; activeArtifactPreview?: { gateId: string; selectedIndex: number } | null }) {
  const { toast, prompt } = useDialog();
  const [busy, setBusy] = useState(false);
  const [localDecision, setLocalDecision] = useState<"approved" | "rejected" | null>(null);

  // 决断后的审计卡（approved / rejected 事件）：一行状态
  if (meta.action !== "requested") {
    const ok = meta.action === "approved";
    return (
      <div className="border border-line rounded-lg px-3 py-2 mt-3 bg-surface-0/40">
        <div className="flex items-center gap-2 text-xs">
          <ShieldCheck size={13} className={ok ? "text-onair" : "text-blocked"} />
          <span className="flex-1 text-ink-3">
            <span className={`font-semibold ${ok ? "text-onair" : "text-blocked"}`}>{ok ? "已批准" : "已打回"}</span>
            {" · "}{meta.gateTitle}
            {meta.handoffTo && ok && <span className="text-ink-4"> → 移交 @{meta.handoffTo}</span>}
          </span>
        </div>
        {meta.decisionNote && <div className="mt-1 pl-6 text-[11px] text-ink-4">{meta.decisionNote}</div>}
      </div>
    );
  }

  const settled = decided || localDecision !== null;

  const decide = async (action: "approve" | "reject") => {
    if (!roomId || busy) return;
    let note: string | undefined;
    if (action === "reject") {
      const input = await prompt("打回意见（将反馈给提交人）:");
      if (input === null) return;
      note = input || undefined;
    }
    setBusy(true);
    try {
      await decideGate(roomId, meta.gateId, action, note);
      setLocalDecision(action === "approve" ? "approved" : "rejected");
    } catch (err: any) {
      toast(`操作失败: ${err.message}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${settled ? "border border-line bg-surface-0/40" : "border border-accent/30 bg-accent-dim/30"} rounded-lg mt-3 overflow-hidden`}>
      <div className="px-3.5 py-2.5 flex items-center gap-2 border-b border-line-soft">
        <ShieldCheck size={14} className="text-accent-ink shrink-0" />
        <span className="text-[10px] font-semibold tracking-[0.06em] text-accent-ink">STAGE GATE</span>
        <span className="text-xs font-semibold text-ink-1 flex-1 truncate">{meta.gateTitle}</span>
        <span className="text-[10px] text-ink-4">由 {meta.requestedBy} 提交</span>
      </div>
      {meta.summary && (
        <div className="px-3.5 py-2.5 text-xs text-ink-2 leading-relaxed [&_p]:my-1">
          <Markdown content={meta.summary} />
        </div>
      )}
      {(meta.artifacts?.length ?? 0) > 0 && (
        <div className="px-3.5 pb-2 flex flex-col gap-1.5">
          {meta.artifacts!.map((a, i) => {
            const kind = /\.html?$/i.test(a) ? "html" : /\.md$/i.test(a) ? "md" : "file";
            const active = activeArtifactPreview?.gateId === meta.gateId && activeArtifactPreview.selectedIndex === i;
            return (
              <div
                key={i}
                className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-[11px] ${active ? "border-accent/40 bg-accent-dim/50" : "border-line-soft bg-surface-0/30"}`}
              >
                <FileText size={11} className="shrink-0 text-ink-4" />
                <span className="uppercase font-bold text-[8px] text-ink-4 shrink-0">{kind}</span>
                <span className="font-mono truncate text-ink-3 flex-1 min-w-0" title={a}>{a}</span>
                {onPreviewArtifact && (
                  <button
                    onClick={() => onPreviewArtifact({ gateId: meta.gateId, gateTitle: meta.gateTitle, artifacts: meta.artifacts || [], selectedIndex: i })}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-accent-ink hover:bg-accent-dim cursor-pointer shrink-0"
                  >
                    <Eye size={11} />
                    Preview
                  </button>
                )}
                {!onPreviewArtifact && /\.md$/i.test(a) && onNavigateToKnowledge && (
                  <button
                    onClick={() => onNavigateToKnowledge(a)}
                    className="rounded px-2 py-1 text-[10px] font-medium text-accent-ink hover:bg-accent-dim cursor-pointer shrink-0"
                  >
                    Open
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div className="px-3.5 py-2 border-t border-line-soft flex items-center gap-2">
        {meta.handoffTo && (
          <span className="text-[10px] text-ink-4">批准后移交 → <span className="text-ink-2 font-medium">@{meta.handoffTo}</span></span>
        )}
        <div className="flex-1" />
        {settled ? (
          <span className={`text-[11px] font-semibold ${localDecision === "rejected" ? "text-blocked" : "text-onair"}`}>
            {localDecision === "rejected" ? "已打回" : localDecision === "approved" ? "已批准" : "已处理"}
          </span>
        ) : (
          <>
            <button
              onClick={() => decide("reject")}
              disabled={busy}
              className="px-3 py-1.5 min-h-[32px] text-[11px] font-medium border border-line rounded-md text-ink-2 hover:text-blocked hover:border-blocked/40 cursor-pointer disabled:opacity-40 transition-colors"
            >
              打回
            </button>
            <button
              onClick={() => decide("approve")}
              disabled={busy}
              className="px-3 py-1.5 min-h-[32px] text-[11px] font-semibold bg-accent text-accent-contrast rounded-md cursor-pointer hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              {busy ? "…" : "批准"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function shouldShowDateSeparator(prev: RoomMessage | null, current: RoomMessage): boolean {
  if (!prev) return true;
  return new Date(prev.ts).toDateString() !== new Date(current.ts).toDateString();
}

function isGroupedWithPrev(prev: RoomMessage | null, current: RoomMessage): boolean {
  if (!prev) return false;
  if (prev.sender !== current.sender) return false;
  if (current.ts - prev.ts > GROUP_INTERVAL_MS) return false;
  if (new Date(prev.ts).toDateString() !== new Date(current.ts).toDateString()) return false;
  return true;
}

function DateSeparator({ ts }: { ts: number }) {
  const date = new Date(ts);
  const formatted = date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 border-t border-line-soft" />
      <span className="text-xs text-ink-4">{formatted}</span>
      <div className="flex-1 border-t border-line-soft" />
    </div>
  );
}
