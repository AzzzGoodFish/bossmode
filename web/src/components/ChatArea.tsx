import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, BookOpen, FileText, Plus, Pencil, ArrowRight, Trash2, Eye } from "lucide-react";
import type { RoomMessage, TaskEventMeta, KnowledgeEventMeta, RoomMessageAttachment } from "../api/client";
import { MessageBubble } from "./MessageBubble";
import { MessageSearchBar } from "./MessageSearchBar";
import type { MessageArtifactPreviewState, ChatAttachmentPreviewState } from "./ArtifactPreviewPanel";
import { formatMessageDateSeparator, isSameLocalDate } from "../utils/message-date";
import { getUsername } from "../api/client";

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
  onPreviewArtifact?: (preview: MessageArtifactPreviewState) => void;
  onPreviewAttachment?: (preview: ChatAttachmentPreviewState) => void;
  activeArtifactPreview?: { messageId: string; selectedIndex: number } | null;
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
                    <KnowledgeEventCard
                      messageId={msg.id}
                      meta={msg.knowledge_event_meta}
                      onPreview={onPreviewArtifact ? () => onPreviewArtifact({ kind: "message", messageId: msg.id, title: msg.knowledge_event_meta!.title, artifacts: [msg.knowledge_event_meta!.path], selectedIndex: 0 }) : undefined}
                      onOpenInLibrary={onNavigateToKnowledge ? () => onNavigateToKnowledge(msg.knowledge_event_meta!.path) : undefined}
                    />
                  ) : (
                    <MessageBubble
                      sender={msg.sender}
                      content={msg.content}
                      time={time}
                      fullTime={fullTime}
                      grouped={grouped}
                      isMarkdown={msg.sender !== "user" && msg.sender !== "system"}
                      mentions={msg.mentions}
                      urgentMentions={msg.urgentMentions}
                      members={members}
                      loginName={getUsername()}
                      roomId={roomId}
                      messageId={msg.id}
                      attachments={msg.attachments}
                      activeAttachmentPreview={activeAttachmentPreview}
                      onPreviewAttachment={roomId && onPreviewAttachment ? (messageId: string, attachments: RoomMessageAttachment[], selectedIndex: number) => onPreviewAttachment({ kind: "attachment", messageId, title: "Attachment preview", attachments, selectedIndex }) : undefined}
                    />
                  )}
                  {msg.artifacts?.length ? (
                    <MessageArtifactChips
                      messageId={msg.id}
                      artifacts={msg.artifacts}
                      activeArtifactPreview={activeArtifactPreview}
                      onPreviewArtifact={onPreviewArtifact}
                    />
                  ) : null}
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
function KnowledgeEventCard({
  messageId,
  meta,
  onPreview,
  onOpenInLibrary,
}: {
  messageId: string;
  meta: KnowledgeEventMeta;
  onPreview?: () => void;
  onOpenInLibrary?: () => void;
}) {
  const verb = meta.tool === "write" ? "updated the document" : "edited the document";
  return (
    <div className="border border-line rounded-lg px-3 py-2 mt-3 bg-surface-0/40">
      <div className="flex items-center gap-2 text-xs text-ink-3">
        <BookOpen size={13} className="text-accent-ink shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="font-medium text-ink-2">{meta.actor}</span> {verb}{" "}
          {onPreview ? (
            <button onClick={onPreview} className="text-accent-ink hover:opacity-80 cursor-pointer underline-offset-2 hover:underline">
              {meta.title}
            </button>
          ) : (
            <span className="text-ink-2">{meta.title}</span>
          )}
        </span>
        {meta.outsideRoomDocsPath && (
          <span className="shrink-0 rounded border border-think/30 bg-think-dim/30 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-think">
            outside room space
          </span>
        )}
        <span className="font-mono text-[10px] text-ink-4 truncate max-w-[200px]" title={meta.path}>{meta.path}</span>
        {onOpenInLibrary && (
          <button onClick={onOpenInLibrary} className="shrink-0 text-[10px] text-ink-4 hover:text-accent-ink cursor-pointer underline-offset-2 hover:underline">
            Open in Library
          </button>
        )}
      </div>
    </div>
  );
}

function artifactKind(path: string): "md" | "html" | "file" {
  if (/\.html?$/i.test(path)) return "html";
  if (/\.md$/i.test(path)) return "md";
  return "file";
}

export function MessageArtifactChips({
  messageId,
  artifacts,
  activeArtifactPreview,
  onPreviewArtifact,
  compact = false,
}: {
  messageId: string;
  artifacts: string[];
  activeArtifactPreview?: { messageId: string; selectedIndex: number } | null;
  onPreviewArtifact?: (preview: MessageArtifactPreviewState) => void;
  compact?: boolean;
}) {
  if (!artifacts.length) return null;
  return (
    <div className={`${compact ? "mt-2" : "ml-11 mt-1.5"} flex flex-col gap-1.5 max-w-2xl`}>
      {artifacts.map((artifact, index) => {
        const active = activeArtifactPreview?.messageId === messageId && activeArtifactPreview.selectedIndex === index;
        const kind = artifactKind(artifact);
        return (
          <div
            key={`${artifact}:${index}`}
            className={`flex items-center gap-2 rounded-md border px-2 py-1.5 text-[11px] ${active ? "border-accent/40 bg-accent-dim/50" : "border-line-soft bg-surface-0/30"}`}
          >
            <FileText size={11} className="shrink-0 text-ink-4" />
            <span className="uppercase font-bold text-[8px] text-ink-4 shrink-0">{kind}</span>
            <span className="font-mono truncate text-ink-3 flex-1 min-w-0" title={artifact}>{artifact}</span>
            {onPreviewArtifact && (
              <button
                onClick={() => onPreviewArtifact({ kind: "message", messageId: messageId, title: "Artifacts", artifacts, selectedIndex: index })}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium text-accent-ink hover:bg-accent-dim cursor-pointer shrink-0"
              >
                <Eye size={11} />
                Preview
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function shouldShowDateSeparator(prev: RoomMessage | null, current: RoomMessage): boolean {
  if (!prev) return true;
  return !isSameLocalDate(prev.ts, current.ts);
}

export function isGroupedWithPrev(prev: RoomMessage | null, current: RoomMessage): boolean {
  if (!prev) return false;
  if (prev.sender !== current.sender) return false;
  if (current.ts - prev.ts > GROUP_INTERVAL_MS) return false;
  if (!isSameLocalDate(prev.ts, current.ts)) return false;
  return true;
}

export function DateSeparator({ ts }: { ts: number }) {
  const formatted = formatMessageDateSeparator(ts);
  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 border-t border-line-soft" />
      <span className="text-xs text-ink-4">{formatted}</span>
      <div className="flex-1 border-t border-line-soft" />
    </div>
  );
}
