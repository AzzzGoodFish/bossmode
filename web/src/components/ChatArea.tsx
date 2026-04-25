import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2 } from "lucide-react";
import type { RoomMessage } from "../api/client";
import { MessageBubble } from "./MessageBubble";
import { SummaryCard } from "./SummaryCard";

interface ChatAreaProps {
  messages: RoomMessage[];
  roomName: string;
  roomId?: string;
  hasMore?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => Promise<void>;
}

const GROUP_INTERVAL_MS = 5 * 60 * 1000;

export function ChatArea({ messages, roomName, roomId, hasMore, loadingOlder, onLoadOlder }: ChatAreaProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevMsgCount = useRef(messages.length);
  const isNearBottom = useRef(true);

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
    <div ref={containerRef} className="flex-1 overflow-y-auto min-w-0 px-4 py-3" onScroll={handleScroll}>
      <div ref={contentRef}>
        {/* Top indicator */}
        {hasMore === false && messages.length > 0 && (
          <div className="text-center text-xs text-zinc-400 dark:text-zinc-600 py-4">Beginning of conversation</div>
        )}
        {loadingOlder && (
          <div className="flex items-center justify-center gap-1.5 py-3">
            <Loader2 size={14} className="animate-spin text-zinc-400" />
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">Loading earlier messages</span>
          </div>
        )}

        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <div className="text-center">
              <p className="text-zinc-400 dark:text-zinc-500 text-lg"># {roomName}</p>
              <p className="text-zinc-400 dark:text-zinc-600 text-sm mt-1">
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
                <div key={msg.id} className={isNewPrepend ? "msg-enter" : undefined} style={animDelay ? { animationDelay: animDelay } : undefined}>
                  {showDateSep && <DateSeparator ts={msg.ts} />}
                  {msg.type === "summary" ? (
                    <SummaryCard message={msg} roomId={roomId || ""} />
                  ) : (
                    <MessageBubble
                      sender={msg.sender}
                      content={msg.content}
                      time={time}
                      fullTime={fullTime}
                      grouped={grouped}
                      isMarkdown={msg.sender !== "user" && msg.sender !== "system"}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div ref={bottomRef} />
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
      <div className="flex-1 border-t border-zinc-200 dark:border-zinc-800" />
      <span className="text-xs text-zinc-400 dark:text-zinc-600">{formatted}</span>
      <div className="flex-1 border-t border-zinc-200 dark:border-zinc-800" />
    </div>
  );
}
